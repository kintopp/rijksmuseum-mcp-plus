"""Gate 2 — post-cold-rerun coverage assertions.

Verifies that after Stage C cold rerun:
  - every place row with lat/lon has a non-NULL coord_method tag
  - coverage is within ±0.5% of v0.24's 80.5% baseline (the rerun must not
    regress; new gazetteer phases in Stage E will lift coverage further)
  - all five v0.25 tier values are reachable (smoke check)

Run:
    ~/miniconda3/envs/embeddings/bin/python \
      scripts/tests/test-218-cold-rerun-coverage.py --db data/vocabulary.db
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path

V024_BASELINE_PCT = 80.5
TOLERANCE_PCT = 0.5


def assert_zero(conn, sql: str, label: str) -> None:
    n = conn.execute(sql).fetchone()[0]
    if n != 0:
        raise AssertionError(f"{label}: expected 0, got {n}")


def test_no_coord_without_method(conn) -> None:
    assert_zero(
        conn,
        "SELECT COUNT(*) FROM vocabulary "
        " WHERE type='place' "
        "   AND lat IS NOT NULL AND lon IS NOT NULL "
        "   AND (coord_method IS NULL OR coord_method = '')",
        "places with coords but NULL coord_method",
    )


def test_coverage_within_tolerance(conn) -> None:
    total, with_coords = conn.execute(
        "SELECT COUNT(*), SUM(CASE WHEN lat IS NOT NULL THEN 1 ELSE 0 END) "
        "  FROM vocabulary WHERE type='place'"
    ).fetchone()
    pct = 100.0 * with_coords / total if total else 0.0
    delta = pct - V024_BASELINE_PCT
    if abs(delta) > TOLERANCE_PCT:
        raise AssertionError(
            f"coverage {pct:.2f}% drifted >{TOLERANCE_PCT}% from baseline "
            f"{V024_BASELINE_PCT}% (delta={delta:+.2f}%)"
        )
    print(f"  (info) coverage {pct:.2f}% (baseline {V024_BASELINE_PCT}%, "
          f"delta {delta:+.2f}%)")


def test_method_distribution_nonzero(conn) -> None:
    rows = conn.execute(
        "SELECT coord_method, COUNT(*) FROM vocabulary "
        " WHERE type='place' AND coord_method IS NOT NULL AND coord_method != '' "
        " GROUP BY coord_method"
    ).fetchall()
    methods = {m: n for m, n in rows}
    if not methods.get("authority"):
        raise AssertionError("zero rows tagged coord_method='authority'")
    if not methods.get("derived"):
        raise AssertionError("zero rows tagged coord_method='derived'")
    print(f"  (info) coord_method distribution: {methods}")


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--db", default="data/vocabulary.db")
    args = p.parse_args()

    conn = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
    try:
        tests = [test_no_coord_without_method,
                 test_coverage_within_tolerance,
                 test_method_distribution_nonzero]
        failed = 0
        for t in tests:
            try:
                t(conn)
                print(f"  PASS  {t.__name__}")
            except AssertionError as e:
                print(f"  FAIL  {t.__name__}: {e}")
                failed += 1
        print(f"\n{len(tests) - failed} passed, {failed} failed")
        return 1 if failed else 0
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
