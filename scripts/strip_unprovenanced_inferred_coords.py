"""Strip lat/lon AND coord_method from places that are still
coord_method='inferred' AND coord_method_detail IS NULL after the
promotion chain has had its chance.

Policy rationale: a row in this state has no provenance breadcrumb
(NULL detail) and either (a) no Rijks-supplied authority in VEI at all,
or (b) an authority that returned no usable coord. Under the strict
'lat/long only from place IDs supplied by the Rijksmuseum' policy, the
existing coord is unverifiable and shouldn't be presented as if it were
geocoded. Setting it to NULL is the honest representation: 'we have
no coordinate for this place'.

What this script writes:
  lat                 = NULL
  lon                 = NULL
  coord_method        = NULL
  coord_method_detail = NULL  (already NULL, but enforced for clarity)

What this script does NOT touch:
  - external_id, vocabulary_external_ids — authority IDs Rijksmuseum
    supplied are preserved. If a future authority publishes a coord for
    one of these places, the next backfill run will pick it up cleanly.
  - placetype / placetype_source — independent of coord provenance.
  - is_areal — independent.

Defensive guards:
  - vocab_ids in data/curated-place-overrides.csv are excluded
  - rows where coord_method != 'inferred' are excluded (no chance of
    accidentally stripping a manually-set or authority-derived coord
    that happens to also have NULL detail through an upstream bug)

Idempotent — re-running on already-stripped rows is a no-op.

Usage:
    python3 scripts/strip_unprovenanced_inferred_coords.py --dry-run
    python3 scripts/strip_unprovenanced_inferred_coords.py
"""
import argparse
import csv
import sqlite3
import sys
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parent.parent
DB_PATH = PROJECT_DIR / "data" / "vocabulary.db"
OVERRIDES_CSV = PROJECT_DIR / "data" / "curated-place-overrides.csv"


def parse_args():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--db", type=Path, default=DB_PATH)
    return p.parse_args()


def load_excluded() -> set[str]:
    if not OVERRIDES_CSV.exists():
        return set()
    with OVERRIDES_CSV.open(newline="") as f:
        return {r["vocab_id"] for r in csv.DictReader(f)}


def main() -> int:
    args = parse_args()
    excluded = load_excluded()
    print(f"Excluded vocab_ids (from {OVERRIDES_CSV.name}): {len(excluded)}")

    conn = sqlite3.connect(str(args.db))

    # Eligibility
    eligible = conn.execute("""
        SELECT id, COALESCE(label_en, label_nl, '∅') AS label,
               lat, lon
        FROM vocabulary
        WHERE type = 'place'
          AND coord_method = 'inferred'
          AND coord_method_detail IS NULL
          AND lat IS NOT NULL
          AND lon IS NOT NULL
        ORDER BY id
    """).fetchall()

    targets = [(vid, label, lat, lon) for vid, label, lat, lon in eligible
               if vid not in excluded]
    n_excluded_count = len(eligible) - len(targets)

    print(f"Eligible (NULL-detail inferred with coords): {len(eligible)}")
    print(f"  excluded by curated-place-overrides:        {n_excluded_count}")
    print(f"  to strip:                                   {len(targets)}\n")

    # Authority sanity check: how many of the strip targets have at least
    # one authority in VEI? They're being stripped because the authority
    # couldn't verify their coord; this is informational, not a guard.
    has_authority = 0
    for vid, *_ in targets:
        r = conn.execute(
            "SELECT 1 FROM vocabulary_external_ids "
            "WHERE vocab_id = ? AND authority IN ('wikidata','tgn','geonames') "
            "LIMIT 1", (vid,)).fetchone()
        if r:
            has_authority += 1
    print(f"  ↳ of which have an authority in VEI:        {has_authority} "
          "(authority couldn't supply a coord)")
    print(f"  ↳ no authority at all in VEI:               "
          f"{len(targets) - has_authority}")

    if args.dry_run:
        print(f"\n[dry-run] would strip {len(targets)} row(s).")
        # Show a couple of samples per category
        print("\n  Samples (first 5):")
        for vid, label, lat, lon in targets[:5]:
            print(f"    {vid} ({label}): coord ({lat}, {lon}) -> NULL")
        conn.close()
        return 0

    if not targets:
        print("Nothing to strip.")
        conn.close()
        return 0

    print(f"\nStripping {len(targets)} row(s)...")
    # Per-row UPDATE with the same eligibility WHERE clause acts as a
    # belt-and-suspenders guard against any concurrent DB change between
    # the eligibility query above and the write below.
    with conn:
        for vid, *_ in targets:
            conn.execute("""
                UPDATE vocabulary
                SET lat = NULL, lon = NULL,
                    coord_method = NULL, coord_method_detail = NULL
                WHERE id = ?
                  AND coord_method = 'inferred'
                  AND coord_method_detail IS NULL
            """, (vid,))

    print("Verifying...")
    bad = 0
    for vid, *_ in targets:
        r = conn.execute(
            "SELECT lat, lon, coord_method FROM vocabulary WHERE id = ?",
            (vid,)).fetchone()
        if r is None or r[0] is not None or r[1] is not None or r[2] is not None:
            print(f"  [FAIL] {vid}: got {r}", file=sys.stderr); bad += 1
    print(f"  Verification: {len(targets) - bad} OK, {bad} FAIL")
    conn.close()
    return 0 if bad == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
