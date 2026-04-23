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
