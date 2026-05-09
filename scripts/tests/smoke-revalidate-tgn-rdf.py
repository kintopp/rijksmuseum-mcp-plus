#!/usr/bin/env python3
"""End-to-end smoke for batch_geocode.revalidate_tgn_rdf().

Patches `_load_tgn_revalidation_set` to return a 30-row subset stratified
across (a) places already with coords, (b) places missing coords. Runs
the orchestrator in dry-run mode so no DB changes land. Exercises the
full plan-builder pipeline + branching logic, just on a small N.
"""
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import batch_geocode

DB = Path(__file__).resolve().parent.parent.parent / "data" / "vocabulary.db"


def _subset_loader(conn: sqlite3.Connection) -> list[dict]:
    """Stratified 30-row sample: 15 with coords, 15 without."""
    rows = []
    for where_clause in ("v.lat IS NOT NULL", "v.lat IS NULL"):
        rows += list(conn.execute(f"""
            SELECT v.id, vei.uri AS external_id, v.label_en,
                   v.lat, v.lon,
                   v.coord_method, v.coord_method_detail,
                   v.placetype, v.placetype_source
            FROM vocabulary_external_ids vei
            JOIN vocabulary v ON v.id = vei.vocab_id
            WHERE vei.authority='tgn' AND v.type='place'
              AND {where_clause}
            ORDER BY random()
            LIMIT 15
        """).fetchall())
    return [dict(r) for r in rows]


def main():
    # Monkey-patch the loader.
    batch_geocode._load_tgn_revalidation_set = _subset_loader
    print(f"Smoke: running revalidate_tgn_rdf in dry-run mode against 30 rows", flush=True)
    batch_geocode.revalidate_tgn_rdf(DB, max_workers=6, dry_run=True)


if __name__ == "__main__":
    main()
