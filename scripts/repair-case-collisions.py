"""Repair v0.24 IIIF tarballs whose member content was corrupted by case-collisions.

Background: the v0.24 ingest run wrote per-shard JPEGs to a case-insensitive APFS
volume. For 126 iiif_id pairs that case-fold equal AND happen to land in the
same shard (`art_id % 200`), only one of the two bytestreams survived on disk
(whichever finished writing last). `pack_tarball()` then read that single file
under both arcnames, producing tar entries whose bytes don't match the
manifest's recorded sha256 for the loser of each pair. The bucket-level damage
is exactly 126 entries across 92 of the 200 tarballs; the local state files
are internally consistent and fully enumerate the affected pairs.

This script repairs each affected tarball in-place by:
  1. Reading every non-collision iid's JPEG from the SSD's loose-file cache and
     verifying its bytes against state's recorded sha256.
  2. For each case-collision pair, hashing the surviving on-disk file to
     identify which iid's bytes are actually present, then re-fetching the
     other iid from `iiif.micr.io` and verifying its bytes against state.
  3. Packing a fresh tar in memory keyed by exact-cased iiif_id (no FS round
     trip — sidesteps the case-insensitivity issue entirely).
  4. Uploading the new tar + a refreshed manifest with `repaired_at` and
     `repair_reason` fields.

Bucket downloads are NOT performed. The bucket is read-only at the manifest
level; only writes are the new tar + manifest objects (which overwrite the
existing bucket entries with the same keys).

Usage:
    uv run --with requests --with boto3 python scripts/repair-case-collisions.py --plan
    uv run --with requests --with boto3 python scripts/repair-case-collisions.py --shard-id 0
    uv run --with requests --with boto3 python scripts/repair-case-collisions.py --shard-ids 0,86
    uv run --with requests --with boto3 python scripts/repair-case-collisions.py --all
"""
from __future__ import annotations
import argparse
import hashlib
import importlib.util
import io
import json
import sys
import tarfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))
_spec = importlib.util.spec_from_file_location(
    "ingest_iiif_tarballs", SCRIPT_DIR / "ingest-iiif-tarballs.py"
)
assert _spec and _spec.loader
ingest = importlib.util.module_from_spec(_spec)
sys.modules["ingest_iiif_tarballs"] = ingest
_spec.loader.exec_module(ingest)

DEFAULT_CACHE_ROOT = Path("/Volumes/sand/rijksmuseum-bucket")


@dataclass
class RepairReport:
    shard_id: int
    members: int
    survivors_from_ssd: int
    victims_refetched: int
    tar_bytes: int
    tar_sha256: str
    upload_ok: bool
    error: str = ""


def find_affected_shards(cache_root: Path) -> list[tuple[int, int]]:
    """Return [(shard_id, num_collision_groups)] for shards with case-collisions."""
    out: list[tuple[int, int]] = []
    for sp in sorted((cache_root / "state").glob("shard-*.state.json")):
        d = json.loads(sp.read_text())
        if d["shard_id"] >= d["total_shards"]:
            continue
        groups: dict[str, list[str]] = {}
        for iid in d["downloaded"]:
            groups.setdefault(iid.lower(), []).append(iid)
        ncoll = sum(1 for v in groups.values() if len(v) > 1)
        if ncoll:
            out.append((d["shard_id"], ncoll))
    return out


def repair_shard(
    sid: int,
    *,
    state: dict,
    cache_root: Path,
    s3,
    bucket: str,
    session,
) -> RepairReport:
    dl_dir = cache_root / "downloads" / f"shard-{sid:03d}"
    if not dl_dir.exists():
        return RepairReport(sid, 0, 0, 0, 0, "", False,
                            f"download dir {dl_dir} missing")

    # 1. Identify case-collision groups within this shard's downloaded set.
    groups: dict[str, list[str]] = {}
    for iid in state["downloaded"]:
        groups.setdefault(iid.lower(), []).append(iid)
    collisions = {k: v for k, v in groups.items() if len(v) > 1}
    print(f"  case-collision groups: {len(collisions)}", flush=True)

    # 2. For each collision pair, hash the on-disk survivor and decide who
    #    needs IIIF re-fetching.
    survivors: dict[str, bytes] = {}
    victims: dict[str, str] = {}  # iid -> expected sha256
    for lower, group in collisions.items():
        if len(group) != 2:
            return RepairReport(sid, 0, 0, 0, 0, "", False,
                                f"unexpected group size {len(group)} for {lower!r}")
        a, b = group
        # Case-insensitive lookup: open by either name; both resolve to same file.
        probe = dl_dir / f"{a}.jpg"
        if not probe.exists():
            probe = dl_dir / f"{b}.jpg"
        if not probe.exists():
            return RepairReport(sid, 0, 0, 0, 0, "", False,
                                f"neither {a}.jpg nor {b}.jpg on disk")
        body = probe.read_bytes()
        sha = hashlib.sha256(body).hexdigest()
        sha_a = state["downloaded"][a]["sha256"]
        sha_b = state["downloaded"][b]["sha256"]
        if sha == sha_a:
            survivors[a] = body
            victims[b] = sha_b
        elif sha == sha_b:
            survivors[b] = body
            victims[a] = sha_a
        else:
            return RepairReport(sid, 0, 0, 0, 0, "", False,
                                f"on-disk bytes for pair {a}/{b} match neither recorded sha")

    # 3. Re-fetch victims from IIIF.
    fetched: dict[str, bytes] = {}
    for iid, expected_sha in victims.items():
        size_hint = state["downloaded"][iid]["size_used"]
        sizes = [size_hint] + [s for s in ingest.IIIF_SIZES if s != size_hint]
        r = ingest.fetch_one(session, iid, sizes=sizes)
        if not r.ok:
            return RepairReport(sid, 0, 0, 0, 0, "", False,
                                f"IIIF fetch failed for {iid}: {r.last_error}")
        actual_sha = hashlib.sha256(r.body).hexdigest()
        if actual_sha != expected_sha:
            return RepairReport(sid, 0, 0, 0, 0, "", False,
                                f"IIIF returned drifted bytes for {iid}: "
                                f"expected {expected_sha[:12]}… got {actual_sha[:12]}…")
        fetched[iid] = r.body

    # 4. Read all non-collision members from SSD; verify hash.
    in_collision: set[str] = set()
    for group in collisions.values():
        in_collision.update(group)

    members: dict[str, bytes] = {}
    members.update(survivors)
    members.update(fetched)
    n_verified = 0
    for iid, meta in state["downloaded"].items():
        if iid in members:
            continue
        if iid in in_collision:
            continue  # already handled
        p = dl_dir / f"{iid}.jpg"
        if not p.exists():
            return RepairReport(sid, 0, 0, 0, 0, "", False,
                                f"non-collision iid {iid} missing from SSD")
        body = p.read_bytes()
        h = hashlib.sha256(body).hexdigest()
        if h != meta["sha256"]:
            return RepairReport(sid, 0, 0, 0, 0, "", False,
                                f"hash mismatch on SSD for {iid}: expected {meta['sha256'][:12]}…")
        members[iid] = body
        n_verified += 1
    print(f"  verified {n_verified} non-collision SSD members + {len(survivors)} survivors + {len(fetched)} fetched", flush=True)

    # 5. Pack tar in memory (sorted by iid, matching original layout).
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tf:
        for iid in sorted(members.keys()):
            data = members[iid]
            ti = tarfile.TarInfo(name=f"{iid}.jpg")
            ti.size = len(data)
            ti.mtime = 0  # reproducible
            ti.mode = 0o644
            ti.type = tarfile.REGTYPE
            tf.addfile(ti, io.BytesIO(data))
    tar_bytes = buf.getvalue()
    tar_sha = hashlib.sha256(tar_bytes).hexdigest()

    # 6. Build refreshed manifest. Reuse build_manifest then layer in repair markers.
    # Construct a synthetic ShardState shim so we can call build_manifest.
    state_shim = type("S", (), {})()
    state_shim.shard_id = sid
    state_shim.total_shards = state["total_shards"]
    state_shim.iiif_size = state["iiif_size"]
    state_shim.expected = state["expected"]
    state_shim.downloaded = state["downloaded"]
    state_shim.failed_dead = state["failed_dead"]
    manifest_obj = ingest.build_manifest(
        state_shim, tar_bytes_len=len(tar_bytes), tar_sha256=tar_sha
    )
    now = datetime.now(tz=timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    manifest_obj["repaired_at"] = now
    manifest_obj["repair_reason"] = "case-collision-fix"
    manifest_obj["repair_victims_refetched"] = sorted(victims.keys())

    # 7. Upload tar then manifest.
    print(f"  uploading tar ({len(tar_bytes)/1e6:.1f} MB) + manifest…", flush=True)
    s3.put_object(Bucket=bucket, Key=ingest.tar_key(sid),
                  Body=tar_bytes, ContentType="application/x-tar")
    s3.put_object(Bucket=bucket, Key=ingest.manifest_key(sid),
                  Body=json.dumps(manifest_obj, ensure_ascii=False, indent=2).encode("utf-8"),
                  ContentType="application/json")

    return RepairReport(
        sid, len(members), len(survivors), len(fetched),
        len(tar_bytes), tar_sha, True,
    )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--creds", type=Path, default=Path("/tmp/src-creds.json"))
    ap.add_argument("--cache-root", type=Path, default=DEFAULT_CACHE_ROOT)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--plan", action="store_true",
                   help="List affected shards and exit (no fetches, no uploads)")
    g.add_argument("--shard-id", type=int)
    g.add_argument("--shard-ids", help="Comma-separated list, e.g. 0,86")
    g.add_argument("--all", action="store_true")
    ap.add_argument("--concurrency", type=int, default=8)
    args = ap.parse_args()

    if not args.cache_root.exists():
        raise SystemExit(f"cache-root {args.cache_root} not mounted")

    affected = find_affected_shards(args.cache_root)
    print(f"affected shards: {len(affected)} (total {sum(n for _, n in affected)} collision groups)")

    if args.plan:
        for sid, n in affected:
            print(f"  shard {sid:>3}  collisions={n}")
        return 0

    if args.shard_id is not None:
        targets = [args.shard_id]
    elif args.shard_ids:
        targets = [int(x) for x in args.shard_ids.split(",")]
    else:  # --all
        targets = [sid for sid, _ in affected]

    affected_ids = {sid for sid, _ in affected}
    unknown = [t for t in targets if t not in affected_ids]
    if unknown:
        print(f"WARNING: shard(s) {unknown} are not in the affected list. "
              f"Skipping (no repair needed).")
        targets = [t for t in targets if t in affected_ids]
    if not targets:
        return 0

    creds = json.loads(args.creds.read_text())
    s3 = ingest.make_bucket_client(creds)
    bucket = creds["bucketName"]
    session = ingest._make_session(args.concurrency)

    reports: list[RepairReport] = []
    for sid in targets:
        print(f"\n=== shard {sid:03d} ===", flush=True)
        sp = args.cache_root / "state" / f"shard-{sid:03d}.state.json"
        state = json.loads(sp.read_text())
        try:
            rep = repair_shard(sid, state=state, cache_root=args.cache_root,
                               s3=s3, bucket=bucket, session=session)
        except Exception as e:  # noqa: BLE001
            rep = RepairReport(sid, 0, 0, 0, 0, "", False, f"{type(e).__name__}: {e}")
        reports.append(rep)
        if rep.upload_ok:
            print(f"  OK  members={rep.members} survivors={rep.survivors_from_ssd} "
                  f"fetched={rep.victims_refetched} tar_sha={rep.tar_sha256[:12]}…")
        else:
            print(f"  FAIL  {rep.error}")

    print("\n=== summary ===")
    ok = sum(1 for r in reports if r.upload_ok)
    print(f"  shards repaired: {ok}/{len(reports)}")
    if any(not r.upload_ok for r in reports):
        for r in reports:
            if not r.upload_ok:
                print(f"  shard {r.shard_id}: {r.error}")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
