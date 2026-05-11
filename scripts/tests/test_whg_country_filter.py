#!/usr/bin/env python3
"""Smoke test for WI-3 helpers: _derive_country_qid + country_re parsing.

Does not exercise the live WHG endpoint — that's integration territory,
and phase_3b_whg is too large to mock cleanly. This test verifies the
two new self-contained building blocks:

  1. _derive_country_qid: walks broader_id chain, hits COUNTRY_QID_TO_ISO2
     (populated from the committed TSV), returns QID or None.
  2. The "Country: XX" regex used in phase_3b_whg's layer-B extraction.

Run: python3 scripts/tests/test_whg_country_filter.py
"""
from __future__ import annotations

import importlib.util
import re
import sqlite3
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SCRIPT_DIR))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _test_helpers import CheckRecorder  # noqa: E402


def load_geocode_module():
    spec = importlib.util.spec_from_file_location(
        "geocode_places", SCRIPT_DIR / "geocoding" / "geocode_places.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def make_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript(
        """
        CREATE TABLE vocabulary (
            id TEXT PRIMARY KEY,
            type TEXT,
            label_en TEXT,
            label_nl TEXT,
            lat REAL,
            lon REAL,
            external_id TEXT,
            broader_id TEXT,
            coord_method TEXT
        );
        CREATE TABLE vocabulary_external_ids (
            id TEXT NOT NULL,
            vocab_id TEXT NOT NULL,
            authority TEXT NOT NULL,
            uri TEXT
        );
        """
    )
    return conn


def run_test_derive_via_external_ids(gp, check: CheckRecorder) -> None:
    """Amsterdam → Noord-Holland → Netherlands (Q55) → layer B maps to NL."""
    conn = make_conn()
    # Amsterdam (no ext-id) → Noord-Holland (no ext-id) → Netherlands (Q55)
    conn.execute(
        "INSERT INTO vocabulary (id, type, label_en, broader_id) VALUES "
        "('AMS', 'place', 'Amsterdam', 'NH'), "
        "('NH', 'place', 'Noord-Holland', 'NL_q55'), "
        "('NL_q55', 'place', 'Netherlands', NULL)"
    )
    conn.execute(
        "INSERT INTO vocabulary_external_ids (id, vocab_id, authority) "
        "VALUES ('Q55', 'NL_q55', 'wikidata')"
    )
    conn.commit()

    broader, wd = gp._build_country_derivation_maps(conn)
    qid = gp._derive_country_qid("AMS", broader, wd)
    check.check(
        "derive: Amsterdam → Q55",
        qid == "Q55",
        detail=f"got {qid!r}",
    )
    check.check(
        "derive: Q55 maps to NL via COUNTRY_QID_TO_ISO2",
        gp.COUNTRY_QID_TO_ISO2.get("Q55") == "NL",
        detail=f"got {gp.COUNTRY_QID_TO_ISO2.get('Q55')!r}",
    )
    conn.close()


def run_test_derive_via_legacy_external_id(gp, check: CheckRecorder) -> None:
    """Places with Wikidata URI only in legacy external_id column also resolve."""
    conn = make_conn()
    conn.execute(
        "INSERT INTO vocabulary (id, type, label_en, external_id, broader_id) VALUES "
        "('CHILD', 'place', 'Somewhere', NULL, 'PARENT'), "
        "('PARENT', 'place', 'France', "
        "'http://www.wikidata.org/entity/Q142', NULL)"
    )
    conn.commit()

    broader, wd = gp._build_country_derivation_maps(conn)
    qid = gp._derive_country_qid("CHILD", broader, wd)
    check.check(
        "derive: legacy external_id → Q142 (France)",
        qid == "Q142",
        detail=f"got {qid!r}",
    )
    conn.close()


def run_test_derive_returns_none_when_chain_ends_without_country(
    gp, check: CheckRecorder
) -> None:
    """Chain with no country ancestor returns None (no layer-A hint, no layer-B filter)."""
    conn = make_conn()
    conn.execute(
        "INSERT INTO vocabulary (id, type, label_en, broader_id) VALUES "
        "('A', 'place', 'A', 'B'), "
        "('B', 'place', 'B', NULL)"
    )
    conn.commit()

    broader, wd = gp._build_country_derivation_maps(conn)
    qid = gp._derive_country_qid("A", broader, wd)
    check.check(
        "derive: no country in chain → None",
        qid is None,
        detail=f"got {qid!r}",
    )
    conn.close()


def run_test_derive_handles_self_referencing_broader(gp, check: CheckRecorder) -> None:
    """Cycle (broader_id = id) must not loop forever."""
    conn = make_conn()
    conn.execute(
        "INSERT INTO vocabulary (id, type, label_en, broader_id) VALUES "
        "('SELF', 'place', 'Self', 'SELF')"
    )
    conn.commit()

    broader, wd = gp._build_country_derivation_maps(conn)
    qid = gp._derive_country_qid("SELF", broader, wd, max_depth=3)
    check.check(
        "derive: self-ref chain → None (no infinite loop)",
        qid is None,
        detail=f"got {qid!r}",
    )
    conn.close()


def run_test_country_regex(check: CheckRecorder) -> None:
    """Verify the 'Country: XX' extraction regex used in layer B."""
    country_re = re.compile(r"Country:\s*([A-Z]{2})")

    cases = [
        ("Country: NL", "NL"),
        ("Country:  GB, modern name: England", "GB"),
        ("A place. Country: US. Population: 1000.", "US"),
        ("No country field here", None),
        ("Country: xx (lowercase ignored)", None),
        ("Country: ZA", "ZA"),
    ]
    for desc, expected in cases:
        m = country_re.search(desc)
        got = m.group(1) if m else None
        check.check(
            f"regex {desc!r} → {expected!r}",
            got == expected,
            detail=f"got {got!r}",
        )


def run_test_country_tsv_loaded(gp, check: CheckRecorder) -> None:
    """Sanity-check that the committed TSV loaded and has the expected size."""
    check.check(
        "TSV loaded: ≥200 entries",
        len(gp.COUNTRY_QID_TO_ISO2) >= 200,
        detail=f"loaded {len(gp.COUNTRY_QID_TO_ISO2)} entries",
    )
    key_entries = {
        "Q55": "NL", "Q29999": "NL", "Q142": "FR", "Q183": "DE",
        "Q30": "US", "Q145": "GB", "Q21": "GB", "Q25": "GB",
    }
    for qid, iso in key_entries.items():
        check.check(
            f"TSV: {qid} → {iso}",
            gp.COUNTRY_QID_TO_ISO2.get(qid) == iso,
            detail=f"got {gp.COUNTRY_QID_TO_ISO2.get(qid)!r}",
        )


def main() -> int:
    gp = load_geocode_module()
    check = CheckRecorder()
    run_test_country_tsv_loaded(gp, check)
    run_test_derive_via_external_ids(gp, check)
    run_test_derive_via_legacy_external_id(gp, check)
    run_test_derive_returns_none_when_chain_ends_without_country(gp, check)
    run_test_derive_handles_self_referencing_broader(gp, check)
    run_test_country_regex(check)
    print(check.summary())
    for fail in check.failures:
        print(f"  FAIL: {fail}")
    return check.exit_code()


if __name__ == "__main__":
    sys.exit(main())
