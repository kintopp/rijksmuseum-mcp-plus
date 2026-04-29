"""#276: resolve_uri must capture all equivalent[] authority IDs into the
returned dict's `_external_ids`, not just the Wikidata-preferred one.

Run: ~/miniconda3/envs/embeddings/bin/python scripts/tests/test-276-equivalent-multi-authority.py
"""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _test_helpers import load_harvest_module, run_test_functions

m = load_harvest_module()


def _mock_la_response(equivalent: list[dict], la_type: str = "Person",
                     identified_by: list[dict] | None = None) -> MagicMock:
    resp = MagicMock()
    resp.status_code = 200
    resp.ok = True
    resp.json.return_value = {
        "type": la_type,
        "equivalent": equivalent,
        "identified_by": identified_by or [
            {"content": "Test", "type": "Name", "language": []}
        ],
    }
    return resp


def _resolve_with(equivalent):
    session = MagicMock()
    session.get.return_value = _mock_la_response(equivalent)
    with patch.object(m, "get_http_session", return_value=session):
        return m.resolve_uri("test-id")


def test_rembrandt_four_authorities() -> None:
    result, reason = _resolve_with([
        {"id": "http://vocab.getty.edu/ulan/500011051"},
        {"id": "http://viaf.org/viaf/64013650"},
        {"id": "http://www.wikidata.org/entity/Q5598"},
        {"id": "https://rkd.nl/artists/66219"},
    ])
    assert reason is None
    assert result is not None
    ext_ids = result["_external_ids"]
    authorities = {a for a, _, _ in ext_ids}
    assert authorities == {"ulan", "viaf", "wikidata", "rkd"}, ext_ids
    assert result["external_id"] == "http://www.wikidata.org/entity/Q5598"


def test_no_wikidata_falls_back_to_first() -> None:
    result, _ = _resolve_with([
        {"id": "http://vocab.getty.edu/tgn/7008691"},
        {"id": "http://www.geonames.org/2759794"},
    ])
    assert result["external_id"] == "http://vocab.getty.edu/tgn/7008691"
    assert {a for a, _, _ in result["_external_ids"]} == {"tgn", "geonames"}


def test_empty_equivalent_yields_empty_list() -> None:
    result, _ = _resolve_with([])
    assert result["external_id"] is None
    assert result["_external_ids"] == []


def test_dedupes_identical_uris() -> None:
    result, _ = _resolve_with([
        {"id": "http://www.wikidata.org/entity/Q5598"},
        {"id": "http://www.wikidata.org/entity/Q5598"},
    ])
    assert len(result["_external_ids"]) == 1


def test_skips_blank_ids() -> None:
    result, _ = _resolve_with([
        {"id": ""},
        {"id": "http://www.wikidata.org/entity/Q5598"},
        {},
    ])
    assert len(result["_external_ids"]) == 1
    assert result["external_id"] == "http://www.wikidata.org/entity/Q5598"


def test_local_id_extraction() -> None:
    result, _ = _resolve_with([
        {"id": "http://vocab.getty.edu/ulan/500011051"},
    ])
    a, local_id, uri = result["_external_ids"][0]
    assert a == "ulan"
    assert local_id == "500011051"
    assert uri == "http://vocab.getty.edu/ulan/500011051"


def main() -> int:
    tests = [v for k, v in globals().items() if k.startswith("test_") and callable(v)]
    return run_test_functions(tests)


if __name__ == "__main__":
    sys.exit(main())
