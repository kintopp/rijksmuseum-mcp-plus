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
import hashlib
import io
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
