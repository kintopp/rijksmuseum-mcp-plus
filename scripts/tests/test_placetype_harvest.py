#!/usr/bin/env python3
"""Smoke test for WI-4 — placetype schema + classification logic.

Does not hit SPARQL endpoints. Verifies:
  1. ensure_placetype_schema adds the three columns idempotently.
  2. classify_aat / classify_qid return correct values for key codes.
  3. _classify_qids applies "point specificity wins" when multiple P31s.
  4. reclassify_from_placetype re-derives is_areal from stored placetype.

Run: python3 scripts/tests/test_placetype_harvest.py
"""
from __future__ import annotations

import importlib.util
import sqlite3
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SCRIPT_DIR))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _test_helpers import CheckRecorder  # noqa: E402


def load_harvest_placetypes():
    spec = importlib.util.spec_from_file_location(
        "harvest_placetypes", SCRIPT_DIR / "harvest-placetypes.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def make_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript("""
        CREATE TABLE vocabulary (
            id TEXT PRIMARY KEY,
            type TEXT,
            label_en TEXT,
            placetype TEXT,
            placetype_source TEXT,
            is_areal INTEGER
        );
    """)
    return conn


def run_test_schema_migration_idempotent(hp, check: CheckRecorder) -> None:
    """ensure_placetype_schema adds columns, no-ops on second call."""
    conn = sqlite3.connect(":memory:")
    conn.execute("CREATE TABLE vocabulary (id TEXT PRIMARY KEY, type TEXT)")

    hp.ensure_placetype_schema(conn)
    cols = {r[1] for r in conn.execute("PRAGMA table_info(vocabulary)").fetchall()}
    check.check("schema: placetype column added",
                "placetype" in cols, detail=str(cols))
    check.check("schema: placetype_source column added",
                "placetype_source" in cols)
    check.check("schema: is_areal column added",
                "is_areal" in cols)

    # Second call should not raise (idempotent).
    try:
        hp.ensure_placetype_schema(conn)
        check.check("schema: second call is no-op", True)
    except sqlite3.OperationalError as e:
        check.check("schema: second call is no-op", False, detail=str(e))
    conn.close()


def run_test_classify_functions(hp, check: CheckRecorder) -> None:
    """Direct classify_aat / classify_qid calls via placetype_map."""
    from lib import placetype_map as pm  # noqa: E402
    cases_aat = [
        ("300008376", True),   # continents
        ("300128176", True),   # continents (TGN variant)
        ("300008569", False),  # inhabited places
        ("300006053", False),  # buildings
        ("300000771", True),   # counties (extended)
        ("300008850", False),  # capes (extended)
        ("http://vocab.getty.edu/aat/300008791", True),  # nations, normalised
        ("300999999", None),   # unmapped
    ]
    for code, expected in cases_aat:
        got = pm.classify_aat(code)
        check.check(f"classify_aat({code}) → {expected}",
                    got == expected, detail=f"got {got!r}")

    cases_qid = [
        ("Q5107", True),       # continent
        ("Q165", True),        # sea
        ("Q515", False),       # city
        ("Q41176", False),     # building
        ("Q6256", True),       # country
        ("http://www.wikidata.org/entity/Q5107", True),  # normalised
        ("Q99999999", None),   # unmapped
    ]
    for code, expected in cases_qid:
        got = pm.classify_qid(code)
        check.check(f"classify_qid({code}) → {expected}",
                    got == expected, detail=f"got {got!r}")


def run_test_classify_qids_point_specificity_wins(hp, check: CheckRecorder) -> None:
    """Vatican-like case: classify_qids(city + country) → False (point wins)."""
    # Vatican: city (Q515) + sovereign state (Q3624078)
    got = hp._classify_qids(["Q515", "Q3624078"])
    check.check("point-wins: [city, sovereign state] → False",
                got is False, detail=f"got {got!r}")

    # Pure areal: continent + region
    got = hp._classify_qids(["Q5107", "Q82794"])
    check.check("areal-only: [continent, region] → True",
                got is True, detail=f"got {got!r}")

    # All unmapped
    got = hp._classify_qids(["Q99999", "Q88888"])
    check.check("all-unmapped: → None",
                got is None, detail=f"got {got!r}")

    # Mixed with None
    got = hp._classify_qids(["Q515", "Q99999"])  # city + unmapped
    check.check("mixed: [city, unmapped] → False",
                got is False, detail=f"got {got!r}")


def run_test_reclassify_from_placetype(hp, check: CheckRecorder) -> None:
    """reclassify re-derives is_areal from stored placetype."""
    conn = make_conn()
    # Seed rows with correct + stale is_areal values.
    conn.executemany(
        "INSERT INTO vocabulary (id, type, placetype, placetype_source, is_areal) "
        "VALUES (?, 'place', ?, ?, ?)",
        [
            ("A", "http://vocab.getty.edu/aat/300008376", "tgn", None),  # should become 1
            ("B", "http://vocab.getty.edu/aat/300008569", "tgn", 1),     # should become 0
            ("C", "http://vocab.getty.edu/aat/300999999", "tgn", 1),     # should become NULL
            ("D", "http://www.wikidata.org/entity/Q5107", "wikidata", None),  # should become 1
            ("E", "http://www.wikidata.org/entity/Q515", "wikidata", None),   # should become 0
        ],
    )
    conn.commit()

    stats = hp.reclassify_from_placetype(conn)
    check.check("reclassify: scanned 5 rows",
                stats["scanned"] == 5, detail=str(stats))
    # 5 seeded rows: A=continent(1), B=inhabited(0), C=unmapped(None),
    # D=Q5107 continent(1), E=Q515 city(0). So 2 areal + 2 point + 1 null.
    check.check("reclassify: 2 areal (A continents + D Q5107)",
                stats["now_areal"] == 2, detail=str(stats))
    check.check("reclassify: 2 point (B inhabited + E Q515)",
                stats["now_point"] == 2, detail=str(stats))
    check.check("reclassify: 1 null (unmapped)",
                stats["now_null"] == 1, detail=str(stats))

    a = conn.execute("SELECT is_areal FROM vocabulary WHERE id='A'").fetchone()["is_areal"]
    check.check("reclassify: A (continent, was NULL) → 1", a == 1)
    b = conn.execute("SELECT is_areal FROM vocabulary WHERE id='B'").fetchone()["is_areal"]
    check.check("reclassify: B (inhabited place, was 1) → 0", b == 0)
    c = conn.execute("SELECT is_areal FROM vocabulary WHERE id='C'").fetchone()["is_areal"]
    check.check("reclassify: C (unmapped, was 1) → NULL", c is None)
    conn.close()


def main() -> int:
    hp = load_harvest_placetypes()
    check = CheckRecorder()
    run_test_schema_migration_idempotent(hp, check)
    run_test_classify_functions(hp, check)
    run_test_classify_qids_point_specificity_wins(hp, check)
    run_test_reclassify_from_placetype(hp, check)
    print(check.summary())
    for fail in check.failures:
        print(f"  FAIL: {fail}")
    return check.exit_code()


if __name__ == "__main__":
    sys.exit(main())
