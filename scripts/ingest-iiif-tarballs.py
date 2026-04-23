"""IIIF tarball ingest pipeline — downloads a shard of the Rijksmuseum corpus and
uploads it as a single tarball to a Tigris-backed Railway bucket.

Run per-shard (resume-safe):
    uv run --with requests --with boto3 python scripts/ingest-iiif-tarballs.py \\
        --creds /tmp/src-creds.json --shard-id 17

Run a range overnight:
    uv run --with requests --with boto3 python scripts/ingest-iiif-tarballs.py \\
        --creds /tmp/src-creds.json --shard-range 0-99

Audit:
    uv run --with requests --with boto3 python scripts/ingest-iiif-tarballs.py \\
        --creds /tmp/src-creds.json --audit --shard-range 0-199
"""
from __future__ import annotations
import concurrent.futures as cf
import hashlib
import io
import json
import signal
import sqlite3
import tarfile
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

IIIF_BASE = "https://iiif.micr.io"
USER_AGENT = "rijksmuseum-mcp-ingest-iiif/0.24"
IIIF_SIZES = ["1568,", "max"]
MAX_ATTEMPTS_PER_SIZE = 3
BACKOFF_BASE = 0.5  # seconds; doubled per retry
TAR_PREFIX = "tarballs/"


def pick_artworks_for_shard(
    db_path: Path, *, shard_id: int, total_shards: int
) -> dict[str, dict]:
    """Return `{iiif_id: {art_id, object_number}}` for this shard.

    Shard assignment is deterministic: `art_id % total_shards == shard_id`.
    Filters to `has_image = 1 AND iiif_id IS NOT NULL`.
    """
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    try:
        cur = con.execute(
            """
            SELECT art_id, object_number, iiif_id
              FROM artworks
             WHERE has_image = 1
               AND iiif_id IS NOT NULL
               AND (art_id % ?) = ?
            """,
            (total_shards, shard_id),
        )
        return {
            r["iiif_id"]: {"art_id": r["art_id"], "object_number": r["object_number"]}
            for r in cur
        }
    finally:
        con.close()


def iiif_url(iiif_id: str, size: str) -> str:
    return f"{IIIF_BASE}/{iiif_id}/full/{size}/0/default.jpg"


@dataclass
class FetchResult:
    ok: bool
    body: bytes = b""
    size_used: str = ""
    last_status: int = 0
    last_error: str = ""


def fetch_one(
    session,
    iiif_id: str,
    *,
    sizes: list[str] = IIIF_SIZES,
    max_attempts_per_size: int = MAX_ATTEMPTS_PER_SIZE,
    backoff_base: float = BACKOFF_BASE,
    timeout_s: int = 60,
) -> FetchResult:
    """Try each size in order; retry on 429/5xx/timeout within a size; break on 400/404."""
    last_status = 0
    last_error = ""
    for size in sizes:
        for attempt in range(max_attempts_per_size):
            try:
                r = session.get(iiif_url(iiif_id, size), timeout=timeout_s)
                last_status = r.status_code
                if r.status_code == 200:
                    return FetchResult(
                        ok=True, body=r.content, size_used=size, last_status=200
                    )
                if r.status_code in (400, 404):
                    last_error = f"HTTP {r.status_code}"
                    break  # try next size
                if r.status_code == 429 or 500 <= r.status_code < 600:
                    last_error = f"HTTP {r.status_code}"
                    if attempt + 1 < max_attempts_per_size:
                        time.sleep(backoff_base * (2 ** attempt))
                    continue
                last_error = f"HTTP {r.status_code}"
                break
            except Exception as e:
                last_status = -1
                last_error = f"{type(e).__name__}: {e}"
                if attempt + 1 < max_attempts_per_size:
                    time.sleep(backoff_base * (2 ** attempt))
    return FetchResult(ok=False, last_status=last_status, last_error=last_error)


def pack_tarball(download_dir: Path, iiif_ids: list[str]) -> tuple[bytes, str]:
    """Pack `{iiif_id}.jpg` files from `download_dir` into an uncompressed tar.

    JPEGs are already compressed; gzip would not help. Returns (tar_bytes, sha256).
    Files inside the tar have flat names `{iiif_id}.jpg` with no directory prefix.
    """
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tf:
        for iid in sorted(iiif_ids):
            p = download_dir / f"{iid}.jpg"
            tf.add(p, arcname=f"{iid}.jpg")
    body = buf.getvalue()
    return body, hashlib.sha256(body).hexdigest()


def make_bucket_client(creds: dict):
    import boto3  # local import so users without boto3 can still run --audit offline
    from botocore.config import Config
    return boto3.client(
        "s3",
        endpoint_url=creds["endpoint"],
        aws_access_key_id=creds["accessKeyId"],
        aws_secret_access_key=creds["secretAccessKey"],
        region_name=creds["region"],
        config=Config(s3={"addressing_style": "virtual"}, retries={"max_attempts": 5}),
    )


def tar_key(shard_id: int) -> str:
    return f"{TAR_PREFIX}shard-{shard_id:03d}.tar"


def manifest_key(shard_id: int) -> str:
    return f"{TAR_PREFIX}shard-{shard_id:03d}.manifest.json"


def bucket_head(s3, bucket: str, key: str) -> dict | None:
    try:
        return s3.head_object(Bucket=bucket, Key=key)
    except Exception as e:  # noqa: BLE001 — boto surface varies
        if "404" in str(e) or "NoSuchKey" in str(e) or "NotFound" in str(e):
            return None
        raise


def bucket_get_manifest(s3, bucket: str, shard_id: int) -> dict | None:
    try:
        body = s3.get_object(Bucket=bucket, Key=manifest_key(shard_id))["Body"].read()
        return json.loads(body)
    except Exception:
        return None


def bucket_put_bytes(s3, bucket: str, key: str, body: bytes, content_type: str) -> None:
    s3.put_object(Bucket=bucket, Key=key, Body=body, ContentType=content_type)


def _make_session(pool_size: int):
    import requests
    import requests.adapters
    s = requests.Session()
    s.headers.update({"User-Agent": USER_AGENT})
    adapter = requests.adapters.HTTPAdapter(
        pool_connections=pool_size,
        pool_maxsize=pool_size,
        max_retries=0,  # retries are handled inside fetch_one
    )
    s.mount("https://", adapter)
    s.mount("http://", adapter)
    return s


def download_phase(
    state,
    *,
    download_dir: Path,
    state_path: Path,
    concurrency: int,
    save_every_s: float = 30.0,
    max_attempts_per_size: int = MAX_ATTEMPTS_PER_SIZE,
) -> None:
    """Download everything in `state.pending_or_retryable()` in parallel.

    Writes each JPEG to `<download_dir>/<iiif_id>.jpg`, updates state per result,
    saves state atomically every `save_every_s` seconds, and on completion.
    Survives Ctrl-C by catching SIGINT and saving before re-raising.
    """
    pending = sorted(state.pending_or_retryable())
    if not pending:
        return

    download_dir.mkdir(parents=True, exist_ok=True)
    session = _make_session(concurrency)
    last_save = time.monotonic()

    def save_now() -> None:
        nonlocal last_save
        state.save_atomically(state_path)
        last_save = time.monotonic()

    original_sigint = signal.getsignal(signal.SIGINT)

    def sigint_handler(signum, frame):
        save_now()
        signal.signal(signal.SIGINT, original_sigint)
        raise KeyboardInterrupt()

    signal.signal(signal.SIGINT, sigint_handler)
    try:
        with cf.ThreadPoolExecutor(max_workers=concurrency) as pool:
            futs = {pool.submit(fetch_one, session, iid): iid for iid in pending}
            completed = 0
            for fut in cf.as_completed(futs):
                iid = futs[fut]
                result = fut.result()
                if result.ok:
                    (download_dir / f"{iid}.jpg").write_bytes(result.body)
                    state.record_success(
                        iid,
                        nbytes=len(result.body),
                        sha256=hashlib.sha256(result.body).hexdigest(),
                        size_used=result.size_used,
                    )
                elif result.last_status == 404:
                    state.mark_dead(iid, reason="HTTP 404 at both sizes", last_status=404)
                else:
                    state.record_failure(
                        iid,
                        error=result.last_error or f"HTTP {result.last_status}",
                        status=result.last_status,
                        max_attempts=max_attempts_per_size,
                    )
                completed += 1
                if time.monotonic() - last_save >= save_every_s:
                    save_now()
                if completed % 100 == 0:
                    pct = completed / len(pending) * 100
                    print(f"  [{completed:>4}/{len(pending)}] {pct:5.1f}% — "
                          f"done={len(state.downloaded)} retry={len(state.failed_retryable)} "
                          f"dead={len(state.failed_dead)}", flush=True)
    finally:
        save_now()
        signal.signal(signal.SIGINT, original_sigint)


def build_manifest(state, *, tar_bytes_len: int, tar_sha256: str) -> dict:
    return {
        "shard_id": state.shard_id,
        "total_shards": state.total_shards,
        "iiif_size": state.iiif_size,
        "created_at": datetime.now(tz=timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "expected_count": len(state.expected),
        "downloaded_count": len(state.downloaded),
        "dead_count": len(state.failed_dead),
        "tar_bytes": tar_bytes_len,
        "tar_sha256": tar_sha256,
        "members": {iid: dict(v) for iid, v in state.downloaded.items()},
        "dead": {iid: dict(v) for iid, v in state.failed_dead.items()},
    }


DEFAULT_CACHE_ROOT = Path("/Volumes/sand/rijksmuseum-bucket")


def _default_cache_root() -> Path:
    return DEFAULT_CACHE_ROOT


def _require_cache_root(cache_root: Path) -> Path:
    """Fail fast if the default SSD isn't mounted and the user didn't override."""
    if cache_root == DEFAULT_CACHE_ROOT and not cache_root.exists():
        raise SystemExit(
            f"default cache-root {cache_root} does not exist (SSD not mounted?). "
            f"Either mount the SSD or pass --cache-root PATH explicitly."
        )
    cache_root.mkdir(parents=True, exist_ok=True)
    return cache_root


def _state_path(cache_root: Path, shard_id: int) -> Path:
    return cache_root / "state" / f"shard-{shard_id:03d}.state.json"


def _download_dir(cache_root: Path, shard_id: int) -> Path:
    return cache_root / "downloads" / f"shard-{shard_id:03d}"


def _purge_download_dir(download_dir: Path) -> int:
    """Delete everything under `download_dir` and return bytes freed."""
    import shutil
    if not download_dir.exists():
        return 0
    total = sum(p.stat().st_size for p in download_dir.iterdir() if p.is_file())
    shutil.rmtree(download_dir)
    return total


# Import state types here so the script can still be loaded without the sidecar
# being on sys.path (the test harness pre-inserts it; the CLI's main() runs with
# the script's own dir on sys.path per the argparse flow).
import sys as _sys
_sys.path.insert(0, str(Path(__file__).resolve().parent))
from _iiif_ingest_state import ShardState, ShardStatus, classify_action  # noqa: E402


@dataclass
class ShardReport:
    shard_id: int
    status: str
    expected: int
    downloaded: int
    retryable: int
    dead: int
    tar_present: bool
    action_taken: str


def process_shard(
    *,
    shard_id: int,
    total_shards: int,
    db_path: Path,
    creds: dict,
    cache_root: Path,
    concurrency: int,
    iiif_size: str = "1568,",
    purge_after_upload: bool = False,
) -> ShardReport:
    state_path = _state_path(cache_root, shard_id)
    dl_dir = _download_dir(cache_root, shard_id)

    # Load or init state, reconcile against DB.
    state = ShardState.load(state_path) or ShardState(
        shard_id=shard_id, total_shards=total_shards, iiif_size=iiif_size
    )
    expected = pick_artworks_for_shard(db_path, shard_id=shard_id, total_shards=total_shards)
    state.reconcile(expected)
    state.save_atomically(state_path)

    # Peek at bucket.
    s3 = make_bucket_client(creds)
    bucket = creds["bucketName"]
    tar_info = bucket_head(s3, bucket, tar_key(shard_id))
    manifest = bucket_get_manifest(s3, bucket, shard_id) if tar_info else None
    initial_status = classify_action(
        state, bucket_tar_present=tar_info is not None, bucket_manifest=manifest
    )

    print(f"shard {shard_id:03d}: expected={len(state.expected)} "
          f"downloaded={len(state.downloaded)} retry={len(state.failed_retryable)} "
          f"dead={len(state.failed_dead)} bucket_tar={'yes' if tar_info else 'no'} "
          f"initial_status={initial_status.value}", flush=True)

    if initial_status in (ShardStatus.COMPLETE, ShardStatus.DONE_WITH_DEATHS):
        return ShardReport(
            shard_id=shard_id, status=initial_status.value,
            expected=len(state.expected), downloaded=len(state.downloaded),
            retryable=len(state.failed_retryable), dead=len(state.failed_dead),
            tar_present=True, action_taken="skipped (already complete)",
        )

    # Download phase.
    if state.pending_or_retryable():
        print(f"  downloading {len(state.pending_or_retryable())} pending/retryable…", flush=True)
        download_phase(
            state, download_dir=dl_dir, state_path=state_path, concurrency=concurrency
        )

    # Decide whether to pack+upload.
    downloaded_count_now = len(state.downloaded)
    needs_upload = (
        tar_info is None
        or downloaded_count_now != state.last_uploaded_count
    )
    action_taken = "no-op (no new downloads)"

    if needs_upload and state.downloaded:
        ordered = sorted(state.downloaded.keys())
        print(f"  packing {len(ordered)} files…", flush=True)
        tar_bytes, tar_sha = pack_tarball(dl_dir, ordered)
        manifest_obj = build_manifest(state, tar_bytes_len=len(tar_bytes), tar_sha256=tar_sha)
        print(f"  uploading tar ({len(tar_bytes)/1e6:.1f} MB) + manifest…", flush=True)
        bucket_put_bytes(s3, bucket, tar_key(shard_id), tar_bytes, "application/x-tar")
        bucket_put_bytes(
            s3, bucket, manifest_key(shard_id),
            json.dumps(manifest_obj, ensure_ascii=False, indent=2).encode("utf-8"),
            "application/json",
        )
        state.last_uploaded_count = downloaded_count_now
        state.save_atomically(state_path)
        action_taken = f"packed+uploaded tar ({len(tar_bytes)/1e6:.1f} MB, {len(ordered)} files)"

        if purge_after_upload:
            freed = _purge_download_dir(dl_dir)
            print(f"  purged local downloads ({freed/1e6:.0f} MB freed)", flush=True)
            action_taken += " [purged local]"

    # Final classification.
    tar_info = bucket_head(s3, bucket, tar_key(shard_id))
    manifest = bucket_get_manifest(s3, bucket, shard_id) if tar_info else None
    final = classify_action(
        state, bucket_tar_present=tar_info is not None, bucket_manifest=manifest
    )
    return ShardReport(
        shard_id=shard_id, status=final.value,
        expected=len(state.expected), downloaded=len(state.downloaded),
        retryable=len(state.failed_retryable), dead=len(state.failed_dead),
        tar_present=tar_info is not None, action_taken=action_taken,
    )


def run_shards(
    *,
    shard_ids: list[int],
    total_shards: int,
    db_path: Path,
    creds: dict,
    cache_root: Path,
    concurrency: int,
    purge_after_upload: bool = False,
) -> list[ShardReport]:
    reports: list[ShardReport] = []
    for sid in shard_ids:
        print(f"\n===== shard {sid}/{total_shards - 1} =====", flush=True)
        rep = process_shard(
            shard_id=sid, total_shards=total_shards,
            db_path=db_path, creds=creds, cache_root=cache_root, concurrency=concurrency,
            purge_after_upload=purge_after_upload,
        )
        reports.append(rep)
    return reports


def audit_shards(
    *,
    shard_ids: list[int],
    total_shards: int,
    db_path: Path,
    creds: dict,
    cache_root: Path,
) -> list[ShardReport]:
    s3 = make_bucket_client(creds)
    bucket = creds["bucketName"]
    reports: list[ShardReport] = []
    for sid in shard_ids:
        state_path = _state_path(cache_root, sid)
        state = ShardState.load(state_path)
        if state is None:
            # Build a ShardState on-the-fly from the DB so "expected" is populated.
            expected = pick_artworks_for_shard(db_path, shard_id=sid, total_shards=total_shards)
            state = ShardState(shard_id=sid, total_shards=total_shards, iiif_size="1568,")
            state.reconcile(expected)
        tar_info = bucket_head(s3, bucket, tar_key(sid))
        manifest = bucket_get_manifest(s3, bucket, sid) if tar_info else None
        status = classify_action(
            state, bucket_tar_present=tar_info is not None, bucket_manifest=manifest
        )
        reports.append(ShardReport(
            shard_id=sid, status=status.value,
            expected=len(state.expected), downloaded=len(state.downloaded),
            retryable=len(state.failed_retryable), dead=len(state.failed_dead),
            tar_present=tar_info is not None, action_taken="audit-only",
        ))
    return reports


def print_report_table(reports: list[ShardReport]) -> None:
    print(f"{'shard':>5}  {'status':<18}  {'exp':>5}  {'dl':>5}  {'rtr':>4}  {'dead':>4}  {'tar':<5}  action")
    print("-" * 100)
    for r in reports:
        print(f"{r.shard_id:>5}  {r.status:<18}  {r.expected:>5}  {r.downloaded:>5}  "
              f"{r.retryable:>4}  {r.dead:>4}  {'yes' if r.tar_present else 'no':<5}  {r.action_taken}")


import argparse


def _find_project_root() -> Path:
    here = Path(__file__).resolve().parent
    for candidate in [here, *here.parents]:
        if (candidate / "package.json").exists():
            return candidate
    raise RuntimeError("could not locate project root (package.json)")


def _parse_shard_spec(shard_id: int | None, shard_range: str | None) -> list[int]:
    if shard_id is not None and shard_range is not None:
        raise SystemExit("specify --shard-id or --shard-range, not both")
    if shard_id is not None:
        return [shard_id]
    if shard_range is not None:
        a, _, b = shard_range.partition("-")
        if not b:
            raise SystemExit("--shard-range must be A-B (inclusive)")
        return list(range(int(a), int(b) + 1))
    raise SystemExit("specify --shard-id or --shard-range")


def main() -> None:
    project_root = _find_project_root()
    default_db = project_root / "data" / "vocabulary.db"

    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--creds", type=Path, required=True,
                    help="JSON file from `railway bucket credentials --json`")
    ap.add_argument("--total-shards", type=int, default=200)
    ap.add_argument("--shard-id", type=int, default=None)
    ap.add_argument("--shard-range", default=None, help="e.g. 0-99")
    ap.add_argument("--audit", action="store_true",
                    help="Report current status without downloading or uploading")
    ap.add_argument("--concurrency", type=int, default=8,
                    help="IIIF parallel download streams (default 8; sweet spot per bench)")
    ap.add_argument("--size", default="1568,", help="IIIF size parameter (default 1568,)")
    ap.add_argument("--db-path", type=Path, default=default_db)
    ap.add_argument("--cache-root", type=Path, default=_default_cache_root(),
                    help=f"default: {_default_cache_root()} (external SSD)")
    ap.add_argument("--purge-after-upload", action="store_true",
                    help="Delete per-shard downloads after successful upload "
                         "(saves disk but forces re-download on future repack).")
    args = ap.parse_args()

    shard_ids = _parse_shard_spec(args.shard_id, args.shard_range)
    creds = json.loads(args.creds.read_text())
    cache_root = _require_cache_root(args.cache_root)

    if args.audit:
        reports = audit_shards(
            shard_ids=shard_ids, total_shards=args.total_shards,
            db_path=args.db_path, creds=creds, cache_root=cache_root,
        )
    else:
        reports = run_shards(
            shard_ids=shard_ids, total_shards=args.total_shards,
            db_path=args.db_path, creds=creds, cache_root=cache_root,
            concurrency=args.concurrency, purge_after_upload=args.purge_after_upload,
        )
    print("\n=== summary ===")
    print_report_table(reports)

    # Non-zero exit if any shard is not terminally OK (helps nightly cron).
    non_terminal = [r for r in reports if r.status not in ("complete", "done_with_deaths")]
    if non_terminal:
        _sys.exit(2)


if __name__ == "__main__":
    main()
