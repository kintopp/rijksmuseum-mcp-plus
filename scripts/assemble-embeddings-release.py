#!/usr/bin/env python3
"""
Assemble a deployable embeddings DB from a freshly-regenerated MAIN artwork index
plus the carried-over DESCRIPTION index.

generate-vocabulary-embeddings-modal.py produces a main-only DB (artwork_embeddings
+ vec_artworks). The deployed embeddings.db also carries desc_embeddings +
vec_desc_artworks (find_similar's Description channel), built separately by
generate-description-embeddings-modal.py from description text. When a main regen
does NOT touch the description embeddings (e.g. #383's inscription strip), the desc
index must be carried over verbatim — otherwise find_similar's Description channel
breaks.

This script starts from the new MAIN DB (keeping its validated vec_artworks index
untouched), copies desc_embeddings from the source DB, rebuilds vec_desc_artworks
from those blobs, and merges the desc_* version_info keys.

Usage:
  ~/miniconda3/envs/embeddings/bin/python scripts/assemble-embeddings-release.py \
    --main data/embeddings-no-subjects.db \
    --desc-source data/embeddings.db \
    --out data/embeddings-v0.70.db
"""

import argparse
import os
import shutil
import sqlite3

import sqlite_vec

DESC_VERSION_KEYS = [
    "desc_artwork_count", "desc_built_at", "desc_dimensions",
    "desc_model", "desc_quantization", "desc_vocab_db_built_at",
]


def open_vec(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.enable_load_extension(True)
    sqlite_vec.load(conn)
    conn.enable_load_extension(False)
    return conn


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--main", required=True, help="new main-only DB (artwork_embeddings + vec_artworks)")
    ap.add_argument("--desc-source", required=True, help="DB to carry desc_embeddings + version_info from")
    ap.add_argument("--out", required=True, help="output deployable DB")
    args = ap.parse_args()

    if os.path.exists(args.out):
        raise SystemExit(f"refusing to overwrite existing {args.out} — remove it first")

    print(f"Start from MAIN (validated, untouched): {args.main}")
    shutil.copyfile(args.main, args.out)

    dst = open_vec(args.out)
    desc = open_vec(args.desc_source)

    # Sanity: out must have main, must NOT already have desc
    main_n = dst.execute("SELECT COUNT(*) FROM artwork_embeddings").fetchone()[0]
    vec_main_n = dst.execute("SELECT COUNT(*) FROM vec_artworks").fetchone()[0]
    assert main_n == vec_main_n, f"main mismatch {main_n} != {vec_main_n}"
    has_desc = dst.execute(
        "SELECT COUNT(*) FROM sqlite_master WHERE name='desc_embeddings'"
    ).fetchone()[0]
    assert has_desc == 0, "out already has desc_embeddings — unexpected"
    src_desc_n = desc.execute("SELECT COUNT(*) FROM desc_embeddings").fetchone()[0]
    print(f"  MAIN: {main_n:,} artwork vectors")
    print(f"  DESC to carry over: {src_desc_n:,} description vectors")

    # 1. Copy desc_embeddings (regular table)
    print("Copying desc_embeddings ...")
    dst.execute("""
        CREATE TABLE desc_embeddings (
            art_id        INTEGER PRIMARY KEY,
            object_number TEXT UNIQUE NOT NULL,
            embedding     BLOB NOT NULL
        )
    """)
    rows = desc.execute("SELECT art_id, object_number, embedding FROM desc_embeddings").fetchall()
    dst.executemany(
        "INSERT INTO desc_embeddings (art_id, object_number, embedding) VALUES (?, ?, ?)", rows
    )
    dst.commit()

    # 2. Rebuild vec_desc_artworks (vec0) from the copied blobs
    print("Rebuilding vec_desc_artworks (vec0) ...")
    dst.execute("""
        CREATE VIRTUAL TABLE vec_desc_artworks USING vec0(
            artwork_id INTEGER PRIMARY KEY,
            embedding int8[384] distance_metric=cosine
        )
    """)
    vrows = dst.execute("SELECT art_id, embedding FROM desc_embeddings").fetchall()
    BATCH = 10000
    for i in range(0, len(vrows), BATCH):
        dst.executemany(
            "INSERT INTO vec_desc_artworks (artwork_id, embedding) VALUES (?, vec_int8(?))",
            vrows[i:i + BATCH],
        )
    dst.commit()

    # 3. Merge desc_* version_info keys
    print("Merging desc_* version_info ...")
    for k in DESC_VERSION_KEYS:
        r = desc.execute("SELECT value FROM version_info WHERE key=?", (k,)).fetchone()
        if r:
            dst.execute("INSERT OR REPLACE INTO version_info (key, value) VALUES (?, ?)", (k, r[0]))
    dst.commit()
    desc.close()

    print("VACUUM ...")
    dst.execute("VACUUM")

    # 4. Verify
    a = dst.execute("SELECT COUNT(*) FROM artwork_embeddings").fetchone()[0]
    va = dst.execute("SELECT COUNT(*) FROM vec_artworks").fetchone()[0]
    d = dst.execute("SELECT COUNT(*) FROM desc_embeddings").fetchone()[0]
    vd = dst.execute("SELECT COUNT(*) FROM vec_desc_artworks").fetchone()[0]
    vi = dict(dst.execute("SELECT key, value FROM version_info"))
    dst.close()

    size_mb = os.path.getsize(args.out) / (1024 * 1024)
    print(f"\n=== {args.out} ({size_mb:.1f} MB) ===")
    print(f"  artwork_embeddings: {a:,}   vec_artworks: {va:,}")
    print(f"  desc_embeddings:    {d:,}   vec_desc_artworks: {vd:,}")
    print(f"  version_info keys:  {len(vi)}")
    assert a == va, "main table/index mismatch"
    assert d == vd == src_desc_n, "desc table/index mismatch"
    assert all(k in vi for k in DESC_VERSION_KEYS), "desc_* version_info missing"
    print("  ✓ all consistency checks passed")
    print(f"  artwork_count={vi.get('artwork_count')}  built_at={vi.get('built_at')}")
    print(f"  vocab_db_built_at={vi.get('vocab_db_built_at')}  desc_model={vi.get('desc_model')}")


if __name__ == "__main__":
    main()
