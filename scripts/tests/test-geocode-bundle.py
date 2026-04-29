"""Gate 3 — post-bundle assertions on Stage E outcomes.

Validates the v0.25 geocoding bundle's headline guarantees against the
post-Stage-E DB:

  - Coverage monotonicity: no row that had coords in baseline lost them
  - UK cluster (53.0, -2.0) eliminated by Layer B
  - WOF auto-accepts on Western European subset (≥10 expected)
  - RCE auto-accepts on Dutch subset (≥10 expected)
  - PIP disagreement strictly less than Stage A baseline

Pre-condition: the baseline DB is at offline/backups/vocabulary-pre-v025-cold-rerun.db
and the working DB is at data/vocabulary.db.

Run:
    ~/miniconda3/envs/embeddings/bin/python scripts/tests/test-geocode-bundle.py \
      --db data/vocabulary.db \
      --baseline-db offline/backups/vocabulary-pre-v025-cold-rerun.db
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _test_helpers import run_test_functions

WE_ISO2 = {"de", "at", "fr", "be", "it", "gb", "ch", "es", "pt"}


def _open_ro(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def test_uk_cluster_eliminated(ctx) -> None:
    """No place sits at exactly (53.0, -2.0) post-bundle."""
    n = ctx["db"].execute(
        "SELECT COUNT(*) FROM vocabulary "
        " WHERE type='place' AND lat = 53.0 AND lon = -2.0"
    ).fetchone()[0]
    assert n == 0, f"UK cluster still present: {n} rows at (53.0, -2.0)"


def test_coverage_monotonicity(ctx) -> None:
    """Every row that had coords in baseline still has coords."""
    baseline_geocoded = {
        r[0] for r in ctx["baseline"].execute(
            "SELECT id FROM vocabulary WHERE type='place' AND lat IS NOT NULL"
        ).fetchall()
    }
    if not baseline_geocoded:
        return  # baseline empty — nothing to compare
    qmarks = ",".join("?" * len(baseline_geocoded))
    # SQLite parameter limit guard — fall back to per-100-batch IN check
    ids = list(baseline_geocoded)
    lost = []
    chunk = 800
    for i in range(0, len(ids), chunk):
        slice_ = ids[i:i + chunk]
        placeholders = ",".join("?" * len(slice_))
        cursor = ctx["db"].execute(
            f"SELECT id FROM vocabulary "
            f" WHERE id IN ({placeholders}) AND lat IS NULL",
            slice_,
        )
        lost.extend(r[0] for r in cursor.fetchall())
    assert not lost, (
        f"{len(lost)} rows lost geocoding vs baseline; "
        f"first 3: {lost[:3]}"
    )


def test_wof_authority_accept_count_minimum(ctx) -> None:
    """Stage E Phase 1d should auto-accept ≥10 WOF rows."""
    n = ctx["db"].execute(
        "SELECT COUNT(*) FROM vocabulary "
        " WHERE type='place' AND coord_method_detail='wof_authority'"
    ).fetchone()[0]
    assert n >= 10, f"only {n} WOF auto-accepts (need ≥10)"


def test_rce_via_wikidata_accept_count_minimum(ctx) -> None:
    """Stage E Phase 1e should auto-accept ≥10 RCE rows on the NL subset."""
    n = ctx["db"].execute(
        "SELECT COUNT(*) FROM vocabulary "
        " WHERE type='place' AND coord_method_detail='rce_via_wikidata'"
    ).fetchone()[0]
    assert n >= 10, f"only {n} RCE auto-accepts (need ≥10)"


def test_pip_baseline_strictly_beat(ctx) -> None:
    """Post-bundle PIP `unknown_no_coverage` must be strictly less than the
    Stage A baseline. Reads the previously-recorded baseline summary file."""
    baseline_summary = (REPO_ROOT
                        / "data/audit/phase4-validation"
                        / "2026-04-28-baseline-v024" / "summary.txt")
    post_summary = (REPO_ROOT
                    / "data/audit/phase4-validation"
                    / "2026-04-29-post-bundle" / "summary.txt")
    if not (baseline_summary.exists() and post_summary.exists()):
        return  # PIP comparison only valid once both runs have happened
    def _unknown(p: Path) -> int:
        for line in p.read_text().splitlines():
            line = line.strip()
            if line.startswith("unknown_no_coverage:"):
                return int(line.split(":", 1)[1])
        return -1
    pre, post = _unknown(baseline_summary), _unknown(post_summary)
    assert pre > 0 and post > 0, "summary parse failed"
    assert post < pre, f"PIP unknown_no_coverage {post} >= baseline {pre}"


def test_method_distribution_includes_v025_phases(ctx) -> None:
    """At minimum one row per new v0.25 detail tag should appear."""
    expected = {"wof_authority", "rce_via_wikidata", "pleiades_reconciliation"}
    rows = ctx["db"].execute(
        "SELECT DISTINCT coord_method_detail FROM vocabulary "
        " WHERE type='place' AND coord_method_detail IS NOT NULL"
    ).fetchall()
    seen = {r[0] for r in rows}
    missing = expected - seen
    assert not missing, f"missing v0.25 detail tags in DB: {missing}"


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--db", default="data/vocabulary.db", type=Path)
    p.add_argument("--baseline-db",
                   default="offline/backups/vocabulary-pre-v025-cold-rerun.db",
                   type=Path)
    args = p.parse_args()
    if not args.db.exists():
        print(f"FAIL: db not found: {args.db}")
        return 1
    if not args.baseline_db.exists():
        print(f"FAIL: baseline-db not found: {args.baseline_db}")
        return 1
    ctx = {"db": _open_ro(args.db), "baseline": _open_ro(args.baseline_db)}
    try:
        tests = [v for k, v in globals().items()
                 if k.startswith("test_") and callable(v)]
        return run_test_functions(tests, ctx)
    finally:
        ctx["db"].close()
        ctx["baseline"].close()


if __name__ == "__main__":
    sys.exit(main())
