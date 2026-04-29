"""Phase 1d (WOF) unit tests — placetype consistency, name normalisation,
accept/review/no-match classification.

Run: ~/miniconda3/envs/embeddings/bin/python scripts/tests/test-1d-wof.py
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from unittest.mock import patch

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from _test_helpers import run_test_functions

spec = importlib.util.spec_from_file_location(
    "geocode_places", REPO_ROOT / "scripts" / "geocode_places.py"
)
gp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gp)


def test_name_normalisation() -> None:
    assert gp._normalize_place_name("  Amsterdam  ") == "amsterdam"
    assert gp._normalize_place_name("'s-Hertogenbosch") == "'s-hertogenbosch"
    assert gp._normalize_place_name("") == ""
    assert gp._normalize_place_name(None) == ""


def test_placetype_consistency_settlement_to_locality() -> None:
    aat_inhabited = "http://vocab.getty.edu/aat/300008347"
    assert gp._wof_placetype_consistent(aat_inhabited, "locality") is True
    assert gp._wof_placetype_consistent(aat_inhabited, "localadmin") is True
    assert gp._wof_placetype_consistent(aat_inhabited, "borough") is True


def test_placetype_consistency_settlement_to_country_rejected() -> None:
    aat_inhabited = "http://vocab.getty.edu/aat/300008347"
    assert gp._wof_placetype_consistent(aat_inhabited, "country") is False
    assert gp._wof_placetype_consistent(aat_inhabited, "region") is False


def test_placetype_consistency_unknown_vocab_pt_passes() -> None:
    """Fail-open for unknown vocab placetypes — name match alone is signal."""
    assert gp._wof_placetype_consistent(None, "locality") is True
    assert gp._wof_placetype_consistent(
        "http://vocab.getty.edu/aat/300008761", "country"
    ) is True  # not in settlement set → no constraint


def test_review_csv_writer_handles_short_match_list() -> None:
    """Three columns × 6 fields per match; rows with fewer matches pad blanks."""
    import tempfile
    rows = [
        ("v1", "Amsterdam",
         [{"id": 1, "name": "Amsterdam", "placetype": "locality",
           "wof_iso2": "nl", "lat": 52.37, "lon": 4.89}]),
        ("v2", "Springfield",
         [
             {"id": 2, "name": "Springfield", "placetype": "locality",
              "wof_iso2": "us", "lat": 39.78, "lon": -89.65},
             {"id": 3, "name": "Springfield", "placetype": "locality",
              "wof_iso2": "us", "lat": 42.10, "lon": -72.59},
             {"id": 4, "name": "Springfield", "placetype": "locality",
              "wof_iso2": "us", "lat": 37.21, "lon": -93.30},
         ]),
    ]
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "wof_review.csv"
        gp._wof_write_review_csv(rows, path)
        text = path.read_text()
    assert "v1,Amsterdam" in text
    assert "v2,Springfield" in text
    # Header has 21 fields (vocab_id, name, decision + 6×3)
    header = text.splitlines()[0].split(",")
    assert len(header) == 21
    # v1 row should have first slot filled, rest blank
    v1_row = [r for r in text.splitlines() if r.startswith("v1,")][0]
    assert v1_row.count(",,,,") >= 1


def test_phase_1d_classifies_match_buckets() -> None:
    """End-to-end: wire phase_1d_wof against a mocked name index +
    in-memory sqlite. Asserts accept/review/no-match buckets."""
    import sqlite3
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript("""
        CREATE TABLE vocabulary (
            id TEXT PRIMARY KEY, type TEXT, label_en TEXT, label_nl TEXT,
            external_id TEXT, lat REAL, lon REAL, placetype TEXT,
            coord_method TEXT, coord_method_detail TEXT,
            external_id_method TEXT, external_id_method_detail TEXT,
            broader_method TEXT, broader_method_detail TEXT,
            vocab_int_id INTEGER, broader_id TEXT, is_areal INTEGER
        );
        CREATE TABLE vocabulary_external_ids (
            vocab_id TEXT, authority TEXT, id TEXT, uri TEXT
        );
        CREATE TABLE mappings (vocab_rowid INTEGER);
        INSERT INTO vocabulary (id, type, label_en, lat, vocab_int_id) VALUES
            ('p_amst',  'place', 'Amsterdam', NULL, 1),
            ('p_split', 'place', 'Springfield', NULL, 2),
            ('p_nope',  'place', 'NotInWOF', NULL, 3);
        INSERT INTO mappings (vocab_rowid) VALUES (1), (2), (3);
    """)

    fake_index = {
        "amsterdam": [{"id": 101, "name": "Amsterdam", "placetype": "locality",
                       "wof_iso2": "nl", "lat": 52.37, "lon": 4.89,
                       "wd_id": "Q727", "gn_id": "2759794"}],
        "springfield": [
            {"id": 201, "name": "Springfield", "placetype": "locality",
             "wof_iso2": "us", "lat": 39.78, "lon": -89.65,
             "wd_id": "", "gn_id": ""},
            {"id": 202, "name": "Springfield", "placetype": "locality",
             "wof_iso2": "us", "lat": 42.10, "lon": -72.59,
             "wd_id": "", "gn_id": ""},
        ],
    }
    with patch.object(gp, "_wof_load_admin_index",
                      return_value=(fake_index, [])):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            n = gp.phase_1d_wof(conn, "ignored", dry_run=False, output_dir=tmp)

    assert n == 1, f"expected 1 accepted, got {n}"
    row = conn.execute(
        "SELECT lat, lon, external_id, coord_method, coord_method_detail "
        "FROM vocabulary WHERE id='p_amst'"
    ).fetchone()
    assert row[0] == 52.37
    assert row[1] == 4.89
    assert "spelunker" in row[2]
    assert row[3] == "authority"
    assert row[4] == "wof_authority"
    # Springfield went to review, no DB write
    assert conn.execute(
        "SELECT lat FROM vocabulary WHERE id='p_split'"
    ).fetchone()[0] is None
    # Concordance harvested: wd + gn for Amsterdam
    auths = {r[0] for r in conn.execute(
        "SELECT authority FROM vocabulary_external_ids WHERE vocab_id='p_amst'"
    ).fetchall()}
    assert auths == {"wof", "wikidata", "geonames"}, auths


def main() -> int:
    tests = [v for k, v in globals().items() if k.startswith("test_") and callable(v)]
    return run_test_functions(tests)


if __name__ == "__main__":
    sys.exit(main())
