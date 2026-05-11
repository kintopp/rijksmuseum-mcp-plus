"""#218 invariant: every coarse method tag has a non-NULL detail tag, and
every detail value resolves to its declared coarse tier.

Run after the cold rerun (Stage C of the v0.25 geocoding bundle).

    ~/miniconda3/envs/embeddings/bin/python scripts/tests/test-218-tier-mapping.py \
      --db data/vocabulary.db
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "scripts"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib import enrichment_methods as em
from _test_helpers import run_test_functions


def assert_eq(actual, expected, label: str) -> None:
    if actual != expected:
        raise AssertionError(f"{label}: expected {expected}, got {actual}")


def test_no_coarse_without_detail(conn: sqlite3.Connection) -> None:
    for coarse_col, detail_col in (
        ("coord_method", "coord_method_detail"),
        ("external_id_method", "external_id_method_detail"),
        ("broader_method", "broader_method_detail"),
    ):
        n = conn.execute(
            f"SELECT COUNT(*) FROM vocabulary "
            f" WHERE type='place' "
            f"   AND {coarse_col} IS NOT NULL AND {coarse_col} != '' "
            f"   AND ({detail_col} IS NULL OR {detail_col} = '')"
        ).fetchone()[0]
        assert_eq(n, 0, f"rows with non-NULL {coarse_col} but NULL {detail_col}")


def test_every_detail_resolves(conn: sqlite3.Connection) -> None:
    for detail_col in ("coord_method_detail", "external_id_method_detail",
                       "broader_method_detail"):
        rows = conn.execute(
            f"SELECT DISTINCT {detail_col} FROM vocabulary "
            f" WHERE {detail_col} IS NOT NULL AND {detail_col} != ''"
        ).fetchall()
        for (detail,) in rows:
            try:
                em.tier_for(detail)
            except KeyError:
                raise AssertionError(
                    f"{detail_col} contains unknown detail value: {detail!r}"
                )


def test_coarse_matches_detail_tier(conn: sqlite3.Connection) -> None:
    for coarse_col, detail_col in (
        ("coord_method", "coord_method_detail"),
        ("external_id_method", "external_id_method_detail"),
        ("broader_method", "broader_method_detail"),
    ):
        rows = conn.execute(
            f"SELECT {coarse_col}, {detail_col}, COUNT(*) FROM vocabulary "
            f" WHERE {coarse_col} IS NOT NULL AND {coarse_col} != '' "
            f"   AND {detail_col} IS NOT NULL AND {detail_col} != '' "
            f" GROUP BY {coarse_col}, {detail_col}"
        ).fetchall()
        for coarse, detail, n in rows:
            expected = em.tier_for(detail)
            if coarse != expected:
                raise AssertionError(
                    f"{coarse_col}={coarse!r} but {detail_col}={detail!r} "
                    f"resolves to tier={expected!r} ({n} rows)"
                )


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--db", default="data/vocabulary.db")
    args = p.parse_args()

    conn = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
    try:
        return run_test_functions(
            [test_no_coarse_without_detail,
             test_every_detail_resolves,
             test_coarse_matches_detail_tier],
            conn,
        )
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
