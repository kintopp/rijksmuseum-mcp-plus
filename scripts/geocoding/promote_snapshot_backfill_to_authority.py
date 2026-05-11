"""Tier-correction: promote 1,999 places from coord_method='inferred' to
coord_method='deterministic' where:

  1. coord_method_detail starts with 'v0.25-snapshot-backfill:' AND
  2. the suffix after the prefix is an AUTHORITY-tier base name in
     enrichment_methods.DETAIL_TO_TIER, AND
  3. the corresponding authority ID is actually present in
     vocabulary_external_ids for that vocab_id (defensive guard).

The 'inferred' tag on these rows was an artifact of the v0.25 snapshot
backfill, which copied authority-derived coords from a snapshot DB but
labelled the operation (snapshot copy) rather than the underlying source
(authority lookup). The strict per-row VEI check ensures we only promote
rows whose authority backing is verifiable in the current DB.

coord_method_detail is INTENTIONALLY left unchanged. The
'v0.25-snapshot-backfill:' prefix remains as an honest provenance
breadcrumb: these coords came via snapshot copy, not a fresh authority
call. Only the tier label changes.

Usage:
    python3 scripts/promote_snapshot_backfill_to_authority.py --dry-run
    python3 scripts/promote_snapshot_backfill_to_authority.py
"""
import argparse
import sqlite3
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent.parent
sys.path.insert(0, str(SCRIPT_DIR.parent))
from lib import enrichment_methods as em  # noqa: E402

DB_PATH = PROJECT_DIR / "data" / "vocabulary.db"

# Each entry: (snapshot-prefixed detail, VEI authority that must be present).
# All 9 details whose base name resolves to AUTHORITY in DETAIL_TO_TIER —
# kept exhaustive even though some currently have 0 inferred rows, so the
# script remains correct against any future DB state where they reappear.
DETAIL_TO_AUTHORITY = (
    ("v0.25-snapshot-backfill:wikidata_p131",         "wikidata"),
    ("v0.25-snapshot-backfill:wikidata_p276",         "wikidata"),
    ("v0.25-snapshot-backfill:wikidata_p159",         "wikidata"),
    ("v0.25-snapshot-backfill:wof_authority",         "wof"),
    ("v0.25-snapshot-backfill:tgn_via_replacement",   "tgn"),
    ("v0.25-snapshot-backfill:tgn_via_wikidata_p1667", "wikidata"),
    ("v0.25-snapshot-backfill:rijksmuseum_lod",       "rijks_internal"),
    ("v0.25-snapshot-backfill:geonames_api",          "geonames"),
    ("v0.25-snapshot-backfill:rce_via_wikidata",      "wikidata"),
)

ELIGIBLE_SQL = """
    SELECT v.id, v.label_en, v.label_nl
    FROM vocabulary v
    WHERE v.type = 'place'
      AND v.coord_method = 'inferred'
      AND v.coord_method_detail = ?
      AND EXISTS (
          SELECT 1 FROM vocabulary_external_ids vei
          WHERE vei.vocab_id = v.id AND vei.authority = ?
      )
"""

UPDATE_SQL = """
    UPDATE vocabulary
    SET coord_method = ?
    WHERE id IN (
        SELECT v.id FROM vocabulary v
        WHERE v.type = 'place'
          AND v.coord_method = 'inferred'
          AND v.coord_method_detail = ?
          AND EXISTS (
              SELECT 1 FROM vocabulary_external_ids vei
              WHERE vei.vocab_id = v.id AND vei.authority = ?
          )
    )
"""


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--dry-run", action="store_true",
                   help="Plan and report; do not write to DB.")
    p.add_argument("--db", type=Path, default=DB_PATH)
    return p.parse_args()


def main() -> int:
    args = parse_args()
    conn = sqlite3.connect(str(args.db))

    print(f"Targeting promotions: inferred -> {em.AUTHORITY!r} ({em.DETERMINISTIC})")
    print(f"{'detail':<55}  {'auth':<14}  {'rows':>5}")

    plans: list[tuple[str, str, int]] = []
    grand_total = 0
    for detail, expected_auth in DETAIL_TO_AUTHORITY:
        eligible = conn.execute(ELIGIBLE_SQL, (detail, expected_auth)).fetchall()
        n = len(eligible)
        if n == 0:
            continue
        print(f"  {detail:<53}  {expected_auth:<14}  {n:>5}")
        plans.append((detail, expected_auth, n))
        grand_total += n

    print(f"\nTotal rows to promote: {grand_total}")

    if grand_total == 0:
        print("Nothing to do.")
        conn.close()
        return 0

    if args.dry_run:
        print("\n[dry-run] no writes. Re-run without --dry-run to commit.")
        conn.close()
        return 0

    # Defensive: snapshot the affected vocab_ids BEFORE the write, so
    # post-write verification can confirm 'all targeted rows now in
    # deterministic, none missed, none over-promoted'.
    targeted_ids: set[str] = set()
    for detail, expected_auth, _ in plans:
        for vid, *_ in conn.execute(ELIGIBLE_SQL, (detail, expected_auth)):
            targeted_ids.add(vid)
    expected_after = len(targeted_ids)
    print(f"\nApplying promotions ({expected_after} distinct vocab_ids)...")

    with conn:
        total_written = 0
        for detail, expected_auth, _ in plans:
            cur = conn.execute(UPDATE_SQL,
                               (em.DETERMINISTIC, detail, expected_auth))
            total_written += cur.rowcount
        print(f"  UPDATE rowcount sum: {total_written}")

    print("\nVerifying...")
    # Every targeted vocab_id should now be coord_method='deterministic'
    # with its detail unchanged.
    placeholders = ",".join("?" * len(targeted_ids))
    actual = conn.execute(
        f"SELECT COUNT(*) FROM vocabulary "
        f"WHERE id IN ({placeholders}) AND coord_method = ?",
        list(targeted_ids) + [em.DETERMINISTIC],
    ).fetchone()[0]
    leftover_inferred = conn.execute(
        f"SELECT COUNT(*) FROM vocabulary "
        f"WHERE id IN ({placeholders}) AND coord_method = 'inferred'",
        list(targeted_ids),
    ).fetchone()[0]
    print(f"  targeted rows now deterministic: {actual} / {expected_after}")
    print(f"  targeted rows still inferred:    {leftover_inferred}")

    # Safety check: detail values should be unchanged.
    detail_drift = conn.execute(
        f"SELECT COUNT(*) FROM vocabulary "
        f"WHERE id IN ({placeholders}) "
        "  AND coord_method_detail NOT LIKE 'v0.25-snapshot-backfill:%'",
        list(targeted_ids),
    ).fetchone()[0]
    print(f"  details that lost their snapshot prefix (should be 0): "
          f"{detail_drift}")

    conn.close()
    ok = (actual == expected_after and leftover_inferred == 0
          and detail_drift == 0)
    print(f"\nResult: {'OK' if ok else 'FAIL'}")
    return 0 if ok else 2


if __name__ == "__main__":
    sys.exit(main())
