"""Phase 1e (RCE Rijksmonumenten) unit tests — pre-flight gate, two-leg
SPARQL bridge (Wikidata P2168 → RCE coords), end-to-end accept path.

All HTTP is mocked; no live SPARQL endpoint calls.

Run: ~/miniconda3/envs/embeddings/bin/python scripts/tests/test-1e-rce.py
"""
from __future__ import annotations

import importlib.util
import io
import json
import sqlite3
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from _test_helpers import create_minimal_vocab_schema, run_test_functions

spec = importlib.util.spec_from_file_location(
    "geocode_places", REPO_ROOT / "scripts" / "geocode_places.py"
)
gp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gp)


def _make_conn(wikidata_place_count: int) -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    create_minimal_vocab_schema(conn, include_mappings=False)
    # Synthesize wikidata-place rows to satisfy pre-flight
    for i in range(wikidata_place_count):
        vid = f"p_{i}"
        conn.execute("INSERT INTO vocabulary (id, type, label_en, lat) "
                     "VALUES (?, 'place', ?, NULL)", (vid, f"Place {i}"))
        conn.execute("INSERT INTO vocabulary_external_ids "
                     "(vocab_id, authority, id, uri) VALUES (?, 'wikidata', ?, ?)",
                     (vid, f"Q{i}", f"http://www.wikidata.org/entity/Q{i}"))
    conn.commit()
    return conn


def _mock_sparql(payload: dict) -> MagicMock:
    """Mock urllib.request.urlopen returning a SPARQL JSON payload."""
    resp = MagicMock()
    resp.read.return_value = json.dumps(payload).encode()
    resp.__enter__ = MagicMock(return_value=resp)
    resp.__exit__ = MagicMock(return_value=False)
    return resp


def test_pre_flight_below_threshold_aborts() -> None:
    conn = _make_conn(8000)
    try:
        gp._rce_pre_flight(conn, threshold=9000)
    except SystemExit as e:
        assert "8000" in str(e)
        return
    raise AssertionError("expected SystemExit on count below threshold")


def test_pre_flight_above_threshold_passes() -> None:
    conn = _make_conn(9500)
    n = gp._rce_pre_flight(conn, threshold=9000)
    assert n == 9500


def test_wikidata_response_parser_extracts_qid_and_rmid() -> None:
    """SPARQL JSON shape: {results:{bindings:[{qid:{value}, rmid:{value}}]}}"""
    payload = {
        "results": {
            "bindings": [
                {"qid": {"value": "http://www.wikidata.org/entity/Q1"},
                 "rmid": {"value": "12345"}},
                {"qid": {"value": "http://www.wikidata.org/entity/Q2"},
                 "rmid": {"value": "67890"}},
            ]
        }
    }
    with patch.object(gp.urllib.request, "urlopen",
                      return_value=_mock_sparql(payload)):
        result = gp._wikidata_qids_to_rijksmonument_ids(["Q1", "Q2"])
    assert result == {"Q1": ["12345"], "Q2": ["67890"]}


def test_rce_response_parser_extracts_coords() -> None:
    """RCE returns coords as a WKT `Point (lon lat)` literal under ?wkt."""
    payload = {
        "results": {
            "bindings": [
                {"rmid": {"value": "12345"},
                 "monument": {"value":
                              "https://linkeddata.cultureelerfgoed.nl/cho-kennis/id/rijksmonument/12345"},
                 "wkt": {"value": "Point (4.89 52.37)"}},
            ]
        }
    }
    with patch.object(gp.urllib.request, "urlopen",
                      return_value=_mock_sparql(payload)):
        result = gp._rce_lookup_monuments(["12345"])
    assert "12345" in result
    assert result["12345"]["lat"] == 52.37
    assert result["12345"]["lon"] == 4.89


def test_rce_skips_multipolygon_response() -> None:
    """MultiPolygon WKTs are parcel outlines; phase 1e skips them in favour
    of the Point centroid that's also returned for each monument."""
    payload = {
        "results": {
            "bindings": [
                {"rmid": {"value": "12345"},
                 "monument": {"value": "https://rce.nl/m/12345"},
                 "wkt": {"value": "MultiPolygon (((4.89 52.37, 4.90 52.38)))"}},
            ]
        }
    }
    with patch.object(gp.urllib.request, "urlopen",
                      return_value=_mock_sparql(payload)):
        result = gp._rce_lookup_monuments(["12345"])
    assert result == {}, "MultiPolygon WKT must be filtered out"


def test_phase_1e_end_to_end_accepts_match() -> None:
    """Full path: pre-flight passes, Wikidata returns P2168, RCE returns
    coords, and the place row is updated with em.RCE_VIA_WIKIDATA."""
    conn = _make_conn(9500)

    def _mock_urlopen(req, timeout=None):
        body = req.data.decode() if req.data else ""
        if "wikidata" in req.full_url.lower() and "P359" in body:
            return _mock_sparql({
                "results": {"bindings": [
                    {"qid": {"value": "http://www.wikidata.org/entity/Q5"},
                     "rmid": {"value": "999"}},
                ]}
            })
        if "cultureelerfgoed" in req.full_url.lower():
            return _mock_sparql({
                "results": {"bindings": [
                    {"rmid": {"value": "999"},
                     "monument": {"value": "https://rce.nl/m/999"},
                     "wkt": {"value": "Point (5.0 52.0)"}},
                ]}
            })
        return _mock_sparql({"results": {"bindings": []}})

    with patch.object(gp.urllib.request, "urlopen", side_effect=_mock_urlopen):
        with patch.object(gp.time, "sleep"):
            n = gp.phase_1e_rce(conn, dry_run=False, batch_size=100)

    assert n == 1
    row = conn.execute(
        "SELECT lat, lon, external_id, coord_method, coord_method_detail "
        "FROM vocabulary WHERE id='p_5'"
    ).fetchone()
    assert row is not None
    assert row[0] == 52.0
    assert row[1] == 5.0
    assert row[2] == "https://rce.nl/m/999"
    assert row[3] == "authority"
    assert row[4] == "rce_via_wikidata"


def main() -> int:
    tests = [v for k, v in globals().items() if k.startswith("test_") and callable(v)]
    return run_test_functions(tests)


if __name__ == "__main__":
    sys.exit(main())
