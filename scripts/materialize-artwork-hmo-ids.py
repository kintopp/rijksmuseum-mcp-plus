#!/usr/bin/env python3
"""
Materialize `artwork_hmo_ids` into a vocabulary DB that still has `linked_art_uri`.

One-shot recovery tool for DBs captured BEFORE Phase 3's column-drops (i.e. before
#253's permanent lookup was part of the harvest script). Operates in-place on the
target DB: creates the table if missing, INSERTs one row per artwork where
`tier2_done = 1 AND linked_art_uri IS NOT NULL AND art_id IS NOT NULL`.

Idempotent — re-running is a no-op thanks to INSERT OR IGNORE.

Typical use:
    python scripts/materialize-artwork-hmo-ids.py \\
        --db ~/Downloads/~vocabulary.db

Pre-conditions checked at startup:
    - `artworks` must still have `linked_art_uri` and `tier2_done` columns
    - `art_id` must be present (i.e. mappings have been integer-encoded)

If any precondition fails, the script prints a clear error and exits non-zero
without modifying the DB.

Output:
    artwork_hmo_ids table with (art_id INTEGER PRIMARY KEY, hmo_id TEXT NOT NULL).
    ~833K rows on a full v0.24 harvest. Storage cost <10 MB.

See #253 for the rationale and the companion harvest-script patch.
"""
import argparse
import sqlite3
import sys
import time
from pathlib import Path

sys.stdout.reconfigure(line_buffering=True)
sys.stderr.reconfigure(line_buffering=True)


def get_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--db", required=True, help="Path to vocabulary DB")
    parser.add_argument("--dry-run", action="store_true",
                        help="Report what would be done without writing")
    args = parser.parse_args()

    db_path = Path(args.db).expanduser()
    if not db_path.exists():
        print(f"ERROR: DB not found: {db_path}", file=sys.stderr)
        return 1

    print(f"Target DB: {db_path}")
    conn = sqlite3.connect(str(db_path))

    # Preflight checks
    artworks_cols = get_columns(conn, "artworks")
    missing = [c for c in ("linked_art_uri", "tier2_done", "art_id") if c not in artworks_cols]
    if missing:
        print(
            f"ERROR: artworks table is missing required column(s): {missing}\n"
            "  This script needs the pre-Phase-3-drop schema. If the DB has already\n"
            "  had linked_art_uri/tier2_done dropped, you can't recover the lookup\n"
            "  from this DB — use a backup taken before the drops.",
            file=sys.stderr,
        )
        conn.close()
        return 2

    # Source count
    src_count = conn.execute("""
        SELECT COUNT(*) FROM artworks
        WHERE tier2_done = 1
          AND linked_art_uri IS NOT NULL AND linked_art_uri != ''
          AND art_id IS NOT NULL
    """).fetchone()[0]
    print(f"Source candidates (tier2_done=1 AND linked_art_uri present): {src_count:,}")

    # Existing count
    existing = conn.execute(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='artwork_hmo_ids'"
    ).fetchone()[0]
    pre_count = (
        conn.execute("SELECT COUNT(*) FROM artwork_hmo_ids").fetchone()[0]
        if existing else 0
    )
    print(f"Existing artwork_hmo_ids rows: {pre_count:,}")

    if args.dry_run:
        print("Dry run — no writes performed.")
        conn.close()
        return 0

    t0 = time.time()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS artwork_hmo_ids (
            art_id INTEGER PRIMARY KEY,
            hmo_id TEXT NOT NULL
        )
    """)
    cur = conn.execute("""
        INSERT OR IGNORE INTO artwork_hmo_ids (art_id, hmo_id)
        SELECT art_id,
               SUBSTR(linked_art_uri, INSTR(linked_art_uri, '.nl/') + 4)
        FROM artworks
        WHERE tier2_done = 1
          AND linked_art_uri IS NOT NULL AND linked_art_uri != ''
          AND art_id IS NOT NULL
    """)
    inserted = cur.rowcount
    conn.commit()

    print(f"artwork_hmo_ids now has: {pre_count + inserted:,} rows")
    print(f"  inserted this run: {inserted:,}")
    print(f"  elapsed: {time.time() - t0:.1f}s")

    # Sanity check — pick 3 random rows and confirm URI reconstruction
    print("\nSanity check — reconstruct URIs for 3 random rows:")
    samples = conn.execute("""
        SELECT h.art_id, h.hmo_id, a.linked_art_uri
        FROM artwork_hmo_ids h
        JOIN artworks a ON a.art_id = h.art_id
        ORDER BY RANDOM() LIMIT 3
    """).fetchall()
    for art_id, hmo_id, original in samples:
        reconstructed = f"https://id.rijksmuseum.nl/{hmo_id}"
        match = "✓" if reconstructed == original else "✗ MISMATCH"
        print(f"  art_id={art_id}  {reconstructed}  {match}")

    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
