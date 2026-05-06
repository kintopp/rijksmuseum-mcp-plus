#!/usr/bin/env python3
"""Compute the importance column on an existing vocabulary DB.

One-off script to add importance scores without a full re-harvest.
Can also be used to recompute scores after tweaking the formula.

Usage:
    python scripts/compute-importance.py [--db data/vocabulary.db] [--recompute]
"""
import argparse
import sqlite3
import time
import sys
from pathlib import Path

# Caps on the count-based terms. Both are no-ops on current data
# (max mapping_count ≈ 93, max set_count = 13) but bound future drift
# from new LDES channels so a single outlier can't dominate the top
# of the ranking.
MAPPING_COUNT_CAP = 100
SET_COUNT_CAP = 20

# field_id for collection_set in field_lookup. Held constant across
# integer-encoded harvests since v0.21.
COLLECTION_SET_FIELD_ID = 3

DEFAULT_DB = Path(__file__).resolve().parent.parent / "data" / "vocabulary.db"


def compute_importance_scores(conn: sqlite3.Connection, cur: sqlite3.Cursor) -> dict:
    """Core importance scoring algorithm. Shared by standalone script and harvest Phase 3.

    Expects the 'importance' column and 'art_id' column to already exist.
    Returns a dict with timing and distribution info.

    v0.27 formula (kintopp/rijksmuseum-mcp-plus-offline#321):
        importance = 3*has_image
                   + 3*has_narrative
                   + min(mapping_count, MAPPING_COUNT_CAP)
                   + min(set_count,     SET_COUNT_CAP)

    set_count = mappings with field_id = COLLECTION_SET_FIELD_ID. These are
    *also* counted in mapping_count, so collection_set mappings effectively
    carry 2× weight — intentional, as set membership is a stronger
    curatorial-effort signal than other mapping types.

    Replaces the v0.21 formula `floor(log2(1+mapping_count))`, which collapsed
    65.9% of the corpus into a single integer score. The raw-with-cap design
    yields ~75 distinct scores with the largest bucket at ~8.6%.
    """
    total = cur.execute("SELECT COUNT(*) FROM artworks").fetchone()[0]
    t0 = time.time()

    # Step 1: base score from direct columns (image + narrative)
    conn.execute("""
        UPDATE artworks SET importance =
            (CASE WHEN has_image = 1 THEN 3 ELSE 0 END) +
            (CASE WHEN length(narrative_text) > 0 THEN 3 ELSE 0 END)
    """)
    conn.commit()

    # Step 2: mapping_count + set_count bonuses — computed in Python to avoid
    # slow correlated UPDATEs. Two GROUP BY scans, one merged update pass.
    total_counts = dict(cur.execute(
        "SELECT artwork_id, COUNT(*) FROM mappings GROUP BY artwork_id"
    ).fetchall())
    set_counts = dict(cur.execute(
        "SELECT artwork_id, COUNT(*) FROM mappings WHERE field_id = ? GROUP BY artwork_id",
        (COLLECTION_SET_FIELD_ID,),
    ).fetchall())
    aids = set(total_counts) | set(set_counts)
    items = [
        (
            min(total_counts.get(aid, 0), MAPPING_COUNT_CAP)
            + min(set_counts.get(aid, 0), SET_COUNT_CAP),
            aid,
        )
        for aid in aids
    ]
    CHUNK = 5000
    for i in range(0, len(items), CHUNK):
        conn.executemany(
            "UPDATE artworks SET importance = importance + ? WHERE art_id = ?",
            items[i:i + CHUNK],
        )
    conn.commit()

    # Step 3: index
    conn.execute("CREATE INDEX IF NOT EXISTS idx_artworks_importance ON artworks(importance DESC)")
    conn.commit()

    elapsed = time.time() - t0

    # Collect distribution
    dist = cur.execute(
        "SELECT importance, COUNT(*) as cnt FROM artworks GROUP BY importance ORDER BY importance DESC"
    ).fetchall()

    return {"total": total, "elapsed": elapsed, "distribution": dist}


def compute_importance(db_path: str, recompute: bool = False) -> None:
    conn = sqlite3.connect(db_path)
    cur = conn.cursor()

    # Check if column exists
    cols = {row[1] for row in cur.execute("PRAGMA table_info(artworks)")}
    has_col = "importance" in cols

    if has_col and not recompute:
        # Verify it's not all zeros
        nonzero = cur.execute("SELECT COUNT(*) FROM artworks WHERE importance != 0").fetchone()[0]
        if nonzero > 0:
            print(f"importance column already exists with {nonzero:,} non-zero values. Use --recompute to overwrite.")
            conn.close()
            return

    if not has_col:
        print("Adding importance column...")
        conn.execute("ALTER TABLE artworks ADD COLUMN importance INTEGER DEFAULT 0")
        conn.commit()

    # Check for integer-encoded schema
    has_int = "art_id" in cols
    if not has_int:
        print("ERROR: DB lacks integer-encoded schema (art_id column). Cannot compute importance.")
        conn.close()
        sys.exit(1)

    print(f"Computing importance scores...")
    result = compute_importance_scores(conn, cur)
    print(f"  Computed {result['total']:,} artworks in {result['elapsed']:.1f}s")

    # Report distribution
    print("\n--- Importance Distribution ---")
    for score, cnt in result["distribution"]:
        pct = cnt / result["total"] * 100
        bar = "█" * int(pct / 2)
        print(f"  {score:3d}: {cnt:8,} ({pct:5.1f}%) {bar}")

    # Spot check: top 10 artworks
    print("\n--- Top 10 by Importance ---")
    rows = cur.execute("""
        SELECT object_number, title, creator_label, importance
        FROM artworks ORDER BY importance DESC LIMIT 10
    """).fetchall()
    for obj, title, creator, imp in rows:
        print(f"  [{imp}] {obj} — {(title or '?')[:50]} — {creator or '?'}")

    # VACUUM to reclaim any space
    print("\nVACUUM...")
    conn.execute("VACUUM")

    conn.close()
    print("Done.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Compute importance scores on vocabulary DB")
    parser.add_argument("--db", default=str(DEFAULT_DB), help="Path to vocabulary.db")
    parser.add_argument("--recompute", action="store_true", help="Recompute even if column already exists")
    args = parser.parse_args()

    compute_importance(args.db, args.recompute)
