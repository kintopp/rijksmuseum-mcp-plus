"""Find every row in vocabulary where coord_method disagrees with what
enrichment_methods.tier_for(coord_method_detail) would resolve. This
surfaces tier-bookkeeping inconsistencies introduced by older backfill
paths that wrote coord_method independently of the canonical tier
mapping.

Reports:
  1. Per (coord_method, coord_method_detail) pair: total + 'should be' tier
  2. Cumulative count of rows that would change under a strict realign
"""
import sqlite3
import sys
from collections import Counter
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent
sys.path.insert(0, str(SCRIPT_DIR))
import enrichment_methods as em  # noqa: E402

DB = PROJECT_DIR / "data" / "vocabulary.db"


def main() -> int:
    conn = sqlite3.connect(str(DB))
    rows = conn.execute(
        "SELECT coord_method, coord_method_detail, COUNT(*) "
        "FROM vocabulary "
        "WHERE type='place' "
        "  AND coord_method_detail IS NOT NULL "
        "GROUP BY coord_method, coord_method_detail "
        "ORDER BY COUNT(*) DESC"
    ).fetchall()
    conn.close()

    print(f"{'method':<16}  {'detail':<55}  {'rows':>6}  {'expected_tier':<14}  status")
    inconsistent_total = 0
    inconsistencies: list[tuple[str, str, int, str]] = []
    unknown_details: Counter[str] = Counter()

    for actual_method, detail, n in rows:
        try:
            expected = em.tier_for(detail)
        except KeyError:
            # Detail string is not in DETAIL_TO_TIER — typically the
            # 'v0.25-snapshot-backfill:*' prefixed values, plus any other
            # non-canonical strings.
            unknown_details[detail] = n
            continue
        status = "OK" if expected == actual_method else "MISMATCH"
        marker = "" if status == "OK" else "  ←"
        print(f"{actual_method or '∅':<16}  {detail[:55]:<55}  {n:>6}  "
              f"{expected:<14}  {status}{marker}")
        if status == "MISMATCH":
            inconsistent_total += n
            inconsistencies.append((actual_method, detail, n, expected))

    print()
    print("=== Mismatches summary ===")
    print(f"Total mismatched rows: {inconsistent_total}")
    if inconsistencies:
        print()
        print(f"  {'detail':<35}  {'actual':<14} -> {'expected':<14}  rows")
        for actual, detail, n, expected in inconsistencies:
            print(f"  {detail:<35}  {actual or '∅':<14} -> {expected:<14}  {n}")

    if unknown_details:
        print()
        print("=== Detail values not in enrichment_methods.DETAIL_TO_TIER "
              "(can't tier-check) ===")
        for d, n in unknown_details.most_common():
            print(f"  {n:>6}  {d}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
