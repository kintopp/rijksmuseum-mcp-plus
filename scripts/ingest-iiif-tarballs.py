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
import sqlite3
from pathlib import Path


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
