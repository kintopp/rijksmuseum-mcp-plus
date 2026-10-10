#!/usr/bin/env python3
"""
Make the deployable embeddings DB: drop the plain artwork_embeddings and
desc_embeddings tables, which duplicate every vector already stored in the vec0
indexes, and keep only an art_id -> object_number table. The vec0 tables are
copied unchanged. Run after assemble-embeddings-release.py; the runtime
(EmbeddingsDb.ts) serves both layouts.

Usage:
  ~/miniconda3/envs/embeddings/bin/python scripts/slim-embeddings-db.py \
    --in data/embeddings-v0.70.db --out data/embeddings-v0.70-slim.db
"""

import argparse
import os
import sqlite3

import sqlite_vec


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="src", required=True, help="full embeddings DB")
    ap.add_argument("--out", required=True, help="slim output DB")
    args = ap.parse_args()

    if os.path.exists(args.out):
        raise SystemExit(f"refusing to overwrite existing {args.out} — remove it first")

    src = sqlite3.connect(f"file:{args.src}?mode=ro", uri=True)
    print(f"Copying {args.src} -> {args.out} ...")
    src.execute("VACUUM INTO ?", (args.out,))
    src.close()

    db = sqlite3.connect(args.out)
    db.enable_load_extension(True)
    sqlite_vec.load(db)
    db.enable_load_extension(False)

    counts_before = {
        t: db.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
        for t in ("artwork_embeddings", "vec_artworks", "desc_embeddings", "vec_desc_artworks")
    }
    assert counts_before["artwork_embeddings"] == counts_before["vec_artworks"], counts_before
    assert counts_before["desc_embeddings"] == counts_before["vec_desc_artworks"], counts_before

    print("Building artwork_object_numbers ...")
    db.execute("""
        CREATE TABLE artwork_object_numbers (
            art_id        INTEGER PRIMARY KEY,
            object_number TEXT NOT NULL
        )
    """)
    db.execute("""
        INSERT INTO artwork_object_numbers (art_id, object_number)
        SELECT art_id, object_number FROM artwork_embeddings
        UNION
        SELECT art_id, object_number FROM desc_embeddings
    """)

    # Every vector must keep an object number; the desc vectors must survive
    # byte-identical in vec0, since they are now the only copy.
    missing = db.execute("""
        SELECT (SELECT COUNT(*) FROM vec_artworks WHERE artwork_id NOT IN (SELECT art_id FROM artwork_object_numbers))
             + (SELECT COUNT(*) FROM vec_desc_artworks WHERE artwork_id NOT IN (SELECT art_id FROM artwork_object_numbers))
    """).fetchone()[0]
    assert missing == 0, f"{missing} vectors without an object number"
    mismatched = db.execute("""
        SELECT COUNT(*) FROM desc_embeddings d
        JOIN vec_desc_artworks v ON v.artwork_id = d.art_id
        WHERE v.embedding != d.embedding
    """).fetchone()[0]
    assert mismatched == 0, f"{mismatched} desc vectors differ between table and vec0"

    print("Dropping artwork_embeddings, desc_embeddings ...")
    db.execute("DROP TABLE artwork_embeddings")
    db.execute("DROP TABLE desc_embeddings")
    db.execute("INSERT OR REPLACE INTO version_info (key, value) VALUES ('layout', 'slim')")
    db.commit()
    print("VACUUM ...")
    db.execute("VACUUM")

    n_obj = db.execute("SELECT COUNT(*) FROM artwork_object_numbers").fetchone()[0]
    va = db.execute("SELECT COUNT(*) FROM vec_artworks").fetchone()[0]
    vd = db.execute("SELECT COUNT(*) FROM vec_desc_artworks").fetchone()[0]
    db.close()
    assert va == counts_before["vec_artworks"] and vd == counts_before["vec_desc_artworks"]

    mb = lambda p: os.path.getsize(p) / (1024 * 1024)
    print(f"\n=== {args.out} ({mb(args.out):.1f} MB, was {mb(args.src):.1f} MB) ===")
    print(f"  vec_artworks: {va:,}   vec_desc_artworks: {vd:,}   artwork_object_numbers: {n_obj:,}")
    print("  ✓ all consistency checks passed")


if __name__ == "__main__":
    main()
