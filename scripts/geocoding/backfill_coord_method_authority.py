#!/usr/bin/env python3
"""Tag pre-existing geocoded place rows with `coord_method` provenance.

Background: 1,888 place rows in `vocabulary.db` already carry `lat`/`lon`
populated at harvest time from upstream `P168_place_is_defined_by` POINT(...)
literals (Rijksmuseum's CHO records cite a TGN/GeoNames/Wikidata authority
and serialise the resulting coord). Their `coord_method` / `coord_method_detail`
columns are NULL because those audit-trail columns were added later (v0.24)
and the harvester's place-row insert pre-dates them.

This script tags every such row as `authority`-tier and assigns a
`coord_method_detail` based on the `external_id` URI pattern. Rows with no
`external_id` (56 in the v0.26 build) are tagged `authority` with NULL detail
("authority-sourced, unknown source") AND exported to CSV with their
associated artworks for manual verification.

Mapping (all values are constants in `enrichment_methods.py`):

  external_id pattern             | coord_method | coord_method_detail
  ────────────────────────────────|──────────────|────────────────────
  vocab.getty.edu/tgn/...         | authority    | tgn_direct
  sws.geonames.org/...            | authority    | geonames_api
  wikidata.org/...                | authority    | wikidata_p625
  id.rijksmuseum.nl/...           | authority    | rijksmuseum_lod
  NULL / empty                    | authority    | NULL  (+ CSV export)

Idempotent: only writes to rows where `coord_method IS NULL OR ''`.

Usage:
  python3 scripts/backfill_coord_method_authority.py                    # dry-run
  python3 scripts/backfill_coord_method_authority.py --apply            # execute
  python3 scripts/backfill_coord_method_authority.py --apply \\
      --csv data/backfills/2026-05-01-coord-no-external-id.csv          # custom CSV path
"""
from __future__ import annotations

import argparse
import csv
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "scripts"))
from lib import enrichment_methods as em  # noqa: E402

# external_id pattern -> coord_method_detail
PATTERNS = [
    ("vocab.getty.edu/tgn/", em.TGN_DIRECT),
    ("sws.geonames.org/",    em.GEONAMES_API),
    ("wikidata.org/",        em.WIKIDATA_P625),
    ("id.rijksmuseum.nl/",   em.RIJKSMUSEUM_LOD),
]


def classify(external_id: str | None) -> str | None:
    """Return the coord_method_detail tag for an external_id, or None if unknown."""
    if not external_id:
        return None
    for needle, tag in PATTERNS:
        if needle in external_id:
            return tag
    return None


def precount(conn: sqlite3.Connection) -> dict:
    """Bucket pre-existing geocoded rows whose coord_method is NULL/empty."""
    rows = conn.execute("""
        SELECT external_id
        FROM vocabulary
        WHERE type='place' AND lat IS NOT NULL
          AND (coord_method IS NULL OR coord_method = '')
    """).fetchall()
    buckets = {tag: 0 for _, tag in PATTERNS}
    buckets["__other_with_id__"] = 0   # external_id present but not matching any pattern
    buckets["__no_external_id__"] = 0  # NULL or empty external_id
    for (eid,) in rows:
        if not eid:
            buckets["__no_external_id__"] += 1
            continue
        tag = classify(eid)
        if tag:
            buckets[tag] += 1
        else:
            buckets["__other_with_id__"] += 1
    buckets["__total__"] = len(rows)
    return buckets


def export_unknown_source_csv(conn: sqlite3.Connection, csv_path: Path) -> int:
    """Emit one row per (place, artwork) pair for places with NULL external_id.

    Each place may appear in multiple artworks across multiple field types
    (production_place, spatial, birth_place, death_place, subject); each
    (place, artwork, field) tuple gets its own CSV row so the manual reviewer
    can see exactly which artworks reference the place and in what role.
    """
    csv_path.parent.mkdir(parents=True, exist_ok=True)

    rows = conn.execute("""
        SELECT
          v.id              AS place_id,
          v.label_en        AS place_label_en,
          v.label_nl        AS place_label_nl,
          v.lat             AS lat,
          v.lon             AS lon,
          v.notation        AS notation,
          v.broader_id      AS broader_id,
          a.object_number   AS object_number,
          a.title           AS artwork_title,
          a.creator_label   AS creator_label,
          a.date_display    AS date_display,
          fl.name           AS field_role
        FROM vocabulary v
        LEFT JOIN mappings m   ON m.vocab_rowid = v.vocab_int_id
        LEFT JOIN artworks a   ON a.art_id      = m.artwork_id
        LEFT JOIN field_lookup fl ON fl.id      = m.field_id
        WHERE v.type='place' AND v.lat IS NOT NULL
          AND (v.external_id IS NULL OR v.external_id = '')
          AND (v.coord_method IS NULL OR v.coord_method = '')
        ORDER BY v.id, fl.name, a.object_number
    """).fetchall()

    cols = ["place_id", "place_label_en", "place_label_nl",
            "lat", "lon", "notation", "broader_id",
            "object_number", "artwork_title", "creator_label",
            "date_display", "field_role"]

    with csv_path.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(cols)
        for r in rows:
            w.writerow(r)
    return len(rows)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", type=Path, default=REPO_ROOT / "data/vocabulary.db")
    ap.add_argument("--apply", action="store_true",
                    help="Execute (default: dry-run)")
    ap.add_argument("--csv", type=Path,
                    default=REPO_ROOT / f"data/backfills/{datetime.now().strftime('%Y-%m-%d')}-coord-no-external-id.csv",
                    help="CSV output path for the unknown-source rows + associated artworks")
    args = ap.parse_args()

    if not args.db.exists():
        print(f"DB not found: {args.db}", file=sys.stderr)
        return 1

    conn = sqlite3.connect(args.db)

    # ── Pre-count ───────────────────────────────────────────────────
    b = precount(conn)
    print(f"Pre-existing geocoded place rows with NULL coord_method: {b['__total__']:,}")
    print(f"  tgn_direct       : {b[em.TGN_DIRECT]:>5,}")
    print(f"  geonames_api     : {b[em.GEONAMES_API]:>5,}")
    print(f"  wikidata_p625    : {b[em.WIKIDATA_P625]:>5,}")
    print(f"  rijksmuseum_lod  : {b[em.RIJKSMUSEUM_LOD]:>5,}")
    print(f"  other_with_id    : {b['__other_with_id__']:>5,}  (will be tagged authority / NULL detail)")
    print(f"  no_external_id   : {b['__no_external_id__']:>5,}  (will be tagged authority / NULL detail + CSV)")

    # ── CSV export (always — useful for both dry-run and apply) ─────
    n_csv = export_unknown_source_csv(conn, args.csv)
    print(f"\nCSV: {args.csv}")
    print(f"  {n_csv:,} (place, artwork, role) rows written for manual verification")

    if not args.apply:
        print("\n(dry-run — pass --apply to execute the UPDATEs)")
        return 0

    # ── Apply ───────────────────────────────────────────────────────
    print("\nApplying...")
    cur = conn.cursor()
    totals = {}

    for needle, tag in PATTERNS:
        c = cur.execute(
            f"""UPDATE vocabulary
                  SET coord_method = ?, coord_method_detail = ?
                WHERE type='place' AND lat IS NOT NULL
                  AND (coord_method IS NULL OR coord_method = '')
                  AND external_id LIKE ?""",
            (em.AUTHORITY, tag, f"%{needle}%"),
        )
        totals[tag] = c.rowcount

    # Anything still untagged: external_id present-but-unrecognised, OR NULL.
    # Both buckets get authority tier, NULL detail.
    c = cur.execute(
        """UPDATE vocabulary
              SET coord_method = ?, coord_method_detail = NULL
            WHERE type='place' AND lat IS NOT NULL
              AND (coord_method IS NULL OR coord_method = '')""",
        (em.AUTHORITY,),
    )
    totals["__authority_null_detail__"] = c.rowcount
    conn.commit()

    print(f"  tgn_direct        : {totals[em.TGN_DIRECT]:>5,}")
    print(f"  geonames_api      : {totals[em.GEONAMES_API]:>5,}")
    print(f"  wikidata_p625     : {totals[em.WIKIDATA_P625]:>5,}")
    print(f"  rijksmuseum_lod   : {totals[em.RIJKSMUSEUM_LOD]:>5,}")
    print(f"  authority/NULL    : {totals['__authority_null_detail__']:>5,}")
    print(f"  TOTAL updated     : {sum(totals.values()):>5,}")

    # ── Post-verify ─────────────────────────────────────────────────
    remaining = conn.execute("""
        SELECT COUNT(*) FROM vocabulary
        WHERE type='place' AND lat IS NOT NULL
          AND (coord_method IS NULL OR coord_method = '')
    """).fetchone()[0]
    print(f"\nAfter: rows still with NULL coord_method = {remaining:,}")
    if remaining != 0:
        print("FAIL — some rows escaped tagging.", file=sys.stderr)
        return 1
    print("SUCCESS — every pre-existing geocoded place row now has audit-trail provenance.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
