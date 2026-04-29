"""Layer B (#262) fail-closed inheritance — propagate_place_coordinates
must refuse inheritance from parents whose placetype isn't on the
INHERITANCE_ALLOWED_PLACETYPES allow-list, eliminating the (53.0, -2.0)
UK-cluster false-positive class.

Run: ~/miniconda3/envs/embeddings/bin/python scripts/tests/test-262-layer-b.py
"""
from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from _test_helpers import (create_minimal_vocab_schema, load_harvest_module,
                             run_test_functions)

h = load_harvest_module()


def _seed_db() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    create_minimal_vocab_schema(conn, include_mappings=False)
    return conn


def _insert(conn, vid, label, lat=None, lon=None,
            broader_id=None, placetype=None, is_areal=0):
    conn.execute(
        "INSERT INTO vocabulary (id, type, label_en, lat, lon, broader_id, "
        "                        placetype, is_areal) "
        "VALUES (?, 'place', ?, ?, ?, ?, ?, ?)",
        (vid, label, lat, lon, broader_id, placetype, is_areal),
    )


def test_country_parent_refused() -> None:
    """A country-class parent (not on the allow-list) should NOT propagate
    coords to its children. This is the UK-cluster (53.0, -2.0) regression
    — England has lat=53.0,lon=-2.0 in the v0.24 DB."""
    conn = _seed_db()
    _insert(conn, "england", "England", lat=53.0, lon=-2.0,
            placetype="http://www.wikidata.org/entity/Q6256")  # country
    _insert(conn, "richmond", "Richmond upon Thames", broader_id="england",
            placetype="http://www.wikidata.org/entity/Q188509")  # suburb
    h.propagate_place_coordinates(conn)
    row = conn.execute(
        "SELECT lat, lon FROM vocabulary WHERE id='richmond'"
    ).fetchone()
    assert row[0] is None and row[1] is None, (
        "child with country parent must stay NULL")


def test_city_parent_inherits_with_city_fallback_tag() -> None:
    """A city-class parent (Q515) propagates and tags coord_method_detail
    as 'city_fallback'."""
    conn = _seed_db()
    _insert(conn, "amsterdam", "Amsterdam", lat=52.37, lon=4.89,
            placetype="http://www.wikidata.org/entity/Q515")  # city
    _insert(conn, "amst_district", "Some Amsterdam district",
            broader_id="amsterdam",
            placetype="http://www.wikidata.org/entity/Q123705")  # neighborhood
    h.propagate_place_coordinates(conn)
    row = conn.execute(
        "SELECT lat, lon, coord_method, coord_method_detail "
        "FROM vocabulary WHERE id='amst_district'"
    ).fetchone()
    assert row[0] == 52.37
    assert row[2] == "derived"
    assert row[3] == "city_fallback"


def test_generic_inhabited_parent_yields_parent_fallback_tag() -> None:
    """An allow-listed but non-city placetype (e.g. AAT inhabited-places
    umbrella 300008347) tags as 'parent_fallback'."""
    conn = _seed_db()
    _insert(conn, "village", "Some Village", lat=52.0, lon=5.0,
            placetype="http://vocab.getty.edu/aat/300008347")  # umbrella
    _insert(conn, "child", "Sub", broader_id="village")
    h.propagate_place_coordinates(conn)
    row = conn.execute(
        "SELECT coord_method_detail FROM vocabulary WHERE id='child'"
    ).fetchone()
    assert row[0] == "parent_fallback"


def test_null_placetype_parent_refused() -> None:
    """Fail-closed on NULL placetype — no inheritance."""
    conn = _seed_db()
    _insert(conn, "mystery", "Mystery", lat=10.0, lon=20.0, placetype=None)
    _insert(conn, "child2", "Child2", broader_id="mystery")
    h.propagate_place_coordinates(conn)
    row = conn.execute(
        "SELECT lat FROM vocabulary WHERE id='child2'"
    ).fetchone()
    assert row[0] is None


def test_areal_flagged_parent_still_refused_even_if_allowlisted() -> None:
    """A settlement-class parent flagged is_areal=1 stays blocked by the
    areal-parent filter. Allow-list and is_areal are AND-ed with the
    existing logic — both must pass."""
    conn = _seed_db()
    _insert(conn, "town", "Town", lat=52.0, lon=5.0,
            placetype="http://www.wikidata.org/entity/Q3957",  # town (allowed)
            is_areal=1)
    _insert(conn, "subtown", "Sub", broader_id="town",
            placetype="http://www.wikidata.org/entity/Q123705")
    h.propagate_place_coordinates(conn)
    row = conn.execute(
        "SELECT lat FROM vocabulary WHERE id='subtown'"
    ).fetchone()
    assert row[0] is None


def main() -> int:
    tests = [v for k, v in globals().items() if k.startswith("test_") and callable(v)]
    return run_test_functions(tests)


if __name__ == "__main__":
    sys.exit(main())
