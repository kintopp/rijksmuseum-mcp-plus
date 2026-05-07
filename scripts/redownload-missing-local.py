"""Restore JPEGs that vanished from the SSD `downloads/shard-NNN/` cache.

After the IIIF tarball ingest finishes, the bucket holds the authoritative copy
of every JPEG (packed inside the per-shard tarballs). The SSD's loose-file
`downloads/` cache, however, can erode over time on macOS — Spotlight, Time
Machine, brief unmounts, etc. can drop individual files. The bucket is fine
either way; the loose cache only matters for "cheap repack" (rebuilding a tar
without re-fetching from `iiif.micr.io`).

This script finds JPEGs the per-shard state file says were downloaded but that
are no longer on the SSD, re-fetches them from `iiif.micr.io` at the same size
that worked last time, and verifies the sha256 against the ledger entry.

Bucket and state files are NOT modified.

Usage:
    uv run --with requests python scripts/redownload-missing-local.py
    uv run --with requests python scripts/redownload-missing-local.py --dry-run
    uv run --with requests python scripts/redownload-missing-local.py --shard-id 29
"""
from __future__ import annotations
import argparse
import concurrent.futures as cf
import hashlib
import importlib.util
import json
import sys
from dataclasses import dataclass
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
INGEST_PATH = SCRIPT_DIR / "ingest-iiif-tarballs.py"

# `ingest-iiif-tarballs.py` has a hyphen so it is not importable by name; load it
# explicitly so we can reuse fetch_one / _make_session and stay byte-for-byte
# compatible with the original run's network behaviour.
spec = importlib.util.spec_from_file_location("ingest_iiif_tarballs", INGEST_PATH)
assert spec and spec.loader
ingest = importlib.util.module_from_spec(spec)
sys.modules["ingest_iiif_tarballs"] = ingest
spec.loader.exec_module(ingest)

DEFAULT_CACHE_ROOT = Path("/Volumes/sand/rijksmuseum-bucket")


@dataclass
class MissingItem:
    shard_id: int
    iiif_id: str
    expected_sha256: str
    expected_bytes: int
    size_used: str  # e.g. "1568," or "max"


def find_missing(cache_root: Path, only_shard: int | None) -> list[MissingItem]:
    items: list[MissingItem] = []
    for state_path in sorted((cache_root / "state").glob("shard-*.state.json")):
        d = json.loads(state_path.read_text())
        sid = d["shard_id"]
        if sid >= d["total_shards"]:
            continue  # off-by-one stub
        if only_shard is not None and sid != only_shard:
            continue
        dl_dir = cache_root / "downloads" / f"shard-{sid:03d}"
        if not dl_dir.exists():
            # Whole shard's loose cache is gone; fetch all of state.downloaded.
            on_disk = set()
        else:
            on_disk = {p.stem for p in dl_dir.glob("*.jpg")}
        for iid, meta in d["downloaded"].items():
            if iid in on_disk:
                continue
            items.append(
                MissingItem(
                    shard_id=sid,
                    iiif_id=iid,
                    expected_sha256=meta["sha256"],
                    expected_bytes=int(meta["bytes"]),
                    size_used=meta["size_used"],
                )
            )
    return items


@dataclass
class FetchOutcome:
    item: MissingItem
    status: str  # "restored", "hash_mismatch", "fetch_failed"
    actual_bytes: int = 0
    actual_sha256: str = ""
    error: str = ""


def restore_one(session, cache_root: Path, item: MissingItem) -> FetchOutcome:
    # Use the same size that succeeded during the original run; fall back through
    # the same size list afterwards in case the upstream behaviour has shifted.
    sizes = [item.size_used]
    for s in ingest.IIIF_SIZES:
        if s != item.size_used:
            sizes.append(s)
    result = ingest.fetch_one(session, item.iiif_id, sizes=sizes)
    if not result.ok:
        return FetchOutcome(
            item=item,
            status="fetch_failed",
            error=result.last_error or f"HTTP {result.last_status}",
        )
    actual_sha = hashlib.sha256(result.body).hexdigest()
    if actual_sha != item.expected_sha256:
        # Don't overwrite; surface the drift so the operator can decide.
        return FetchOutcome(
            item=item,
            status="hash_mismatch",
            actual_bytes=len(result.body),
            actual_sha256=actual_sha,
        )
    dl_dir = cache_root / "downloads" / f"shard-{item.shard_id:03d}"
    dl_dir.mkdir(parents=True, exist_ok=True)
    out = dl_dir / f"{item.iiif_id}.jpg"
    tmp = out.with_suffix(".jpg.part")
    tmp.write_bytes(result.body)
    tmp.replace(out)
    return FetchOutcome(
        item=item,
        status="restored",
        actual_bytes=len(result.body),
        actual_sha256=actual_sha,
    )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--cache-root", type=Path, default=DEFAULT_CACHE_ROOT)
    ap.add_argument("--shard-id", type=int, default=None,
                    help="Restrict to one shard (default: scan all 0..total-1)")
    ap.add_argument("--concurrency", type=int, default=8,
                    help="IIIF parallel streams (default 8 — same sweet spot as ingest)")
    ap.add_argument("--dry-run", action="store_true",
                    help="List missing items without fetching")
    args = ap.parse_args()

    if not args.cache_root.exists():
        raise SystemExit(f"cache-root {args.cache_root} not mounted")

    missing = find_missing(args.cache_root, args.shard_id)
    print(f"missing JPEGs: {len(missing)}", flush=True)
    if not missing:
        return 0
    by_shard: dict[int, int] = {}
    for m in missing:
        by_shard[m.shard_id] = by_shard.get(m.shard_id, 0) + 1
    print(f"affected shards: {len(by_shard)}", flush=True)
    if args.dry_run:
        for m in missing:
            print(f"  shard {m.shard_id:>3}  {m.iiif_id}  size={m.size_used}  "
                  f"sha={m.expected_sha256[:12]}  bytes={m.expected_bytes}")
        return 0

    session = ingest._make_session(args.concurrency)
    outcomes: list[FetchOutcome] = []
    with cf.ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        futs = {pool.submit(restore_one, session, args.cache_root, m): m for m in missing}
        for i, fut in enumerate(cf.as_completed(futs), 1):
            outcomes.append(fut.result())
            if i % 25 == 0 or i == len(missing):
                print(f"  [{i:>4}/{len(missing)}] processed", flush=True)

    counts: dict[str, int] = {}
    for o in outcomes:
        counts[o.status] = counts.get(o.status, 0) + 1
    print("\n=== summary ===")
    for k in ("restored", "hash_mismatch", "fetch_failed"):
        print(f"  {k:<14} {counts.get(k, 0)}")
    failures = [o for o in outcomes if o.status != "restored"]
    if failures:
        print("\nfailures:")
        for o in failures:
            print(f"  shard {o.item.shard_id:>3}  {o.item.iiif_id}  {o.status}  "
                  f"{o.error or (o.actual_sha256[:12] + ' vs ' + o.item.expected_sha256[:12])}")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
