"""Phase 3e (Pleiades) unit tests — index loading, slash-alias splitting,
accept/review classification.

Run: ~/miniconda3/envs/embeddings/bin/python scripts/tests/test-3e-pleiades.py
"""
from __future__ import annotations

import gzip
import importlib.util
import json
import sqlite3
import sys
import tempfile
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


def _write_pleiades_fixture(items: list[dict], path: Path) -> None:
    payload = {"@context": {}, "@graph": items}
    with gzip.open(path, "wt", encoding="utf-8") as f:
        json.dump(payload, f)


def test_index_indexes_title_and_romanized() -> None:
    items = [
        {"id": 1, "uri": "https://pleiades.stoa.org/places/1",
         "title": "Roma", "reprPoint": [12.5, 41.9],
         "names": [{"romanized": "Roma"}, {"romanized": "Urbs"}]},
    ]
    with tempfile.NamedTemporaryFile(suffix=".json.gz", delete=False) as t:
        path = Path(t.name)
    try:
        _write_pleiades_fixture(items, path)
        idx, n = gp._pleiades_load_index(path)
    finally:
        path.unlink()
    assert n == 1
    assert "roma" in idx
    assert "urbs" in idx


def test_index_splits_slash_titles() -> None:
    items = [
        {"id": 2, "uri": "https://pleiades.stoa.org/places/2",
         "title": "Consabura/Consabrum", "reprPoint": [-3.6, 39.46],
         "names": []},
    ]
    with tempfile.NamedTemporaryFile(suffix=".json.gz", delete=False) as t:
        path = Path(t.name)
    try:
        _write_pleiades_fixture(items, path)
        idx, _ = gp._pleiades_load_index(path)
    finally:
        path.unlink()
    assert "consabura" in idx
    assert "consabrum" in idx
    assert "consabura/consabrum" in idx


def test_index_skips_items_without_repr_point() -> None:
    items = [
        {"id": 3, "uri": "x", "title": "Ghost",
         "reprPoint": None, "names": []},
        {"id": 4, "uri": "y", "title": "Real",
         "reprPoint": [10, 20], "names": []},
    ]
    with tempfile.NamedTemporaryFile(suffix=".json.gz", delete=False) as t:
        path = Path(t.name)
    try:
        _write_pleiades_fixture(items, path)
        idx, n = gp._pleiades_load_index(path)
    finally:
        path.unlink()
    assert n == 1
    assert "ghost" not in idx
    assert "real" in idx


def test_phase_3e_classifies_buckets() -> None:
    """End-to-end mock: single hit accepts, multi-hit goes to review CSV."""
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
        INSERT INTO vocabulary (id, type, label_en, vocab_int_id) VALUES
            ('p_roma', 'place', 'Roma',     1),
            ('p_split','place', 'Alexandria', 2);
        INSERT INTO mappings (vocab_rowid) VALUES (1), (2);
    """)

    fake_index = {
        "roma": [{"id": 100, "uri": "https://pleiades.stoa.org/places/100",
                  "title": "Roma", "lat": 41.9, "lon": 12.5}],
        "alexandria": [
            {"id": 200, "uri": "https://pleiades.stoa.org/places/200",
             "title": "Alexandria (Egypt)", "lat": 31.2, "lon": 29.9},
            {"id": 201, "uri": "https://pleiades.stoa.org/places/201",
             "title": "Alexandria Eschate", "lat": 40.3, "lon": 69.6},
        ],
    }
    with patch.object(gp, "_pleiades_load_index",
                      return_value=(fake_index, 2)):
        with tempfile.TemporaryDirectory() as tmp:
            n = gp.phase_3e_pleiades(conn, Path("ignored"),
                                      dry_run=False, output_dir=tmp)
            review = (Path(tmp) / "pleiades_review.csv").read_text()

    assert n == 1
    row = conn.execute(
        "SELECT lat, lon, external_id, coord_method, coord_method_detail "
        "FROM vocabulary WHERE id='p_roma'"
    ).fetchone()
    assert row[0] == 41.9
    assert "pleiades.stoa.org" in row[2]
    assert row[3] == "derived"
    assert row[4] == "pleiades_reconciliation"
    # Multi-hit row went to review, not DB
    assert conn.execute(
        "SELECT lat FROM vocabulary WHERE id='p_split'"
    ).fetchone()[0] is None
    assert "p_split,Alexandria" in review
    assert "Alexandria (Egypt)" in review
    assert "Alexandria Eschate" in review


def main() -> int:
    tests = [v for k, v in globals().items() if k.startswith("test_") and callable(v)]
    return run_test_functions(tests)


if __name__ == "__main__":
    sys.exit(main())
