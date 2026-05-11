"""Strip lat/lon AND coord_method from every place coordinate that is NOT
authority-traceable, and clean up orphan coord_method_detail strings.
Two-tier geo policy:

  deterministic  — coord traced to a Rijks-supplied authority lookup. KEPT.
  (everything else: inferred, manual, ...) — UNENRICHED. lat/lon set to NULL.

Rationale: a manual review of the 'inferred' tier (WHG / Wikidata / Pleiades
reconciliations, parent fallbacks, country centroids, curated centroids)
found too many confidently-wrong coordinates — homonym collisions resolving
to the wrong country, areal entities reduced to a misleading point, POIs
slapped with a city centroid. The conservative call: trust only coordinates
that come straight from an authority ID the Rijksmuseum itself supplied.
Anything else is more honestly represented as 'we have no coordinate'.

What this script writes:
  (a) for every place with coord_method NOT IN (NULL, 'deterministic'):
        lat = lon = coord_method = coord_method_detail = NULL
  (b) for every place with coord_method IS NULL that still carries an
      orphan coord_method_detail string (no coord, no method — left behind
      by backfill_place_geo_from_v025.py):
        coord_method_detail = NULL

What it does NOT touch:
  - external_id, vocabulary_external_ids — authority IDs Rijksmuseum
    supplied are preserved. If a future authority publishes a coord for
    one of these places, the next backfill run will pick it up and tag it
    'deterministic' cleanly.
  - placetype / placetype_source — independent of coord provenance.
  - is_areal — independent.
  - coord_method = 'deterministic' rows — never touched.

Idempotent — re-running on an already-clean DB updates 0 rows.

Usage:
    python3 scripts/strip_non_authority_coords.py --dry-run
    python3 scripts/strip_non_authority_coords.py
"""
import argparse
import sqlite3
import sys
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parent.parent
DB_PATH = PROJECT_DIR / "data" / "vocabulary.db"


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--db", type=Path, default=DB_PATH)
    return p.parse_args()


def dist(conn) -> list[tuple[str, int]]:
    return conn.execute("""
        SELECT COALESCE(coord_method, 'NULL') AS m, COUNT(*) AS n
        FROM vocabulary WHERE type = 'place'
        GROUP BY coord_method ORDER BY n DESC
    """).fetchall()


def count_orphan_detail(conn) -> int:
    return conn.execute("""
        SELECT COUNT(*) FROM vocabulary
        WHERE type = 'place' AND coord_method IS NULL
          AND coord_method_detail IS NOT NULL
    """).fetchone()[0]


def main() -> int:
    args = parse_args()
    conn = sqlite3.connect(str(args.db))

    print("Current coord_method distribution (places):")
    for m, n in dist(conn):
        print(f"  {m:<16} {n}")

    targets = conn.execute("""
        SELECT id, COALESCE(label_en, label_nl, '∅') AS label,
               coord_method, coord_method_detail
        FROM vocabulary
        WHERE type = 'place'
          AND coord_method IS NOT NULL
          AND coord_method != 'deterministic'
        ORDER BY coord_method, id
    """).fetchall()
    orphan_detail = count_orphan_detail(conn)

    print(f"\nTo strip (coord_method not in (NULL, 'deterministic')): {len(targets)}")
    print(f"Orphan coord_method_detail to clear (NULL-method rows):  {orphan_detail}")

    if args.dry_run:
        tally: dict[str, int] = {}
        for _id, _label, cm, _cmd in targets:
            tally[cm] = tally.get(cm, 0) + 1
        for cm, n in sorted(tally.items(), key=lambda kv: -kv[1]):
            print(f"  {cm:<16} {n}")
        if targets:
            print("\n  Samples (first 8):")
            for _id, label, cm, cmd in targets[:8]:
                print(f"    {_id} ({label}): [{cm}/{cmd}] -> NULL")
        print(f"\n[dry-run] would strip {len(targets)} coord row(s) and clear "
              f"{orphan_detail} orphan detail string(s).")
        conn.close()
        return 0

    if not targets and not orphan_detail:
        print("Nothing to do — DB is already in the clean two-state form.")
        conn.close()
        return 0

    with conn:
        if targets:
            print(f"\nStripping {len(targets)} non-authority coord row(s)...")
            conn.execute("""
                UPDATE vocabulary
                SET lat = NULL, lon = NULL,
                    coord_method = NULL, coord_method_detail = NULL
                WHERE type = 'place'
                  AND coord_method IS NOT NULL
                  AND coord_method != 'deterministic'
            """)
        if orphan_detail:
            print(f"Clearing {orphan_detail} orphan coord_method_detail string(s)...")
            conn.execute("""
                UPDATE vocabulary
                SET coord_method_detail = NULL
                WHERE type = 'place' AND coord_method IS NULL
                  AND coord_method_detail IS NOT NULL
            """)

    print("Verifying...")
    leftover = conn.execute("""
        SELECT COUNT(*) FROM vocabulary
        WHERE type = 'place'
          AND coord_method IS NOT NULL
          AND coord_method != 'deterministic'
    """).fetchone()[0]
    stray_coord = conn.execute("""
        SELECT COUNT(*) FROM vocabulary
        WHERE type = 'place' AND coord_method IS NULL
          AND (lat IS NOT NULL OR lon IS NOT NULL)
    """).fetchone()[0]
    leftover_detail = count_orphan_detail(conn)
    print(f"  Non-authority rows remaining: {leftover} (want 0)")
    print(f"  NULL-method rows with stray lat/lon: {stray_coord} (want 0)")
    print(f"  NULL-method rows with orphan detail: {leftover_detail} (want 0)")
    print("  New distribution (places):")
    for m, n in dist(conn):
        print(f"    {m:<16} {n}")
    conn.close()
    return 0 if (leftover == 0 and stray_coord == 0 and leftover_detail == 0) else 2


if __name__ == "__main__":
    sys.exit(main())
