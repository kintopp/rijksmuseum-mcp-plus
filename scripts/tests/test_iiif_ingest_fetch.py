"""Unit tests for shard selection and IIIF fetch logic.

Run with: python3 scripts/tests/test_iiif_ingest_fetch.py
"""
from __future__ import annotations
import importlib.util
import sqlite3
import sys
import tempfile
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SCRIPTS_DIR))  # so `import _iiif_ingest_state` works inside the main module

# Load scripts/ingest-iiif-tarballs.py under a stable module name; the hyphen in
# the filename blocks plain `import`.
_spec = importlib.util.spec_from_file_location(
    "ingest_iiif_tarballs", SCRIPTS_DIR / "ingest-iiif-tarballs.py"
)
assert _spec and _spec.loader
ingest = importlib.util.module_from_spec(_spec)
sys.modules["ingest_iiif_tarballs"] = ingest
_spec.loader.exec_module(ingest)


def _seed_test_db(db_path: Path):
    con = sqlite3.connect(str(db_path))
    con.executescript(
        """
        CREATE TABLE artworks (
          art_id INTEGER PRIMARY KEY,
          object_number TEXT,
          has_image INTEGER,
          iiif_id TEXT
        );
        INSERT INTO artworks (art_id, object_number, has_image, iiif_id) VALUES
          (0,  'SK-A-0',  1, 'AAA00'),
          (1,  'SK-A-1',  1, 'BBB01'),
          (2,  'SK-A-2',  0, NULL),
          (3,  'SK-A-3',  1, NULL),
          (10, 'SK-A-10', 1, 'CCC10'),
          (11, 'SK-A-11', 1, 'DDD11'),
          (20, 'SK-A-20', 1, 'EEE20');
        """
    )
    con.commit()
    con.close()


def test_pick_artworks_for_shard_mod_arithmetic():
    with tempfile.TemporaryDirectory() as td:
        db = Path(td) / "vocabulary.db"
        _seed_test_db(db)

        # total_shards=10, shard_id=0 → art_id % 10 == 0 → art_ids 0, 10, 20
        # of these, has_image=1 AND iiif_id IS NOT NULL: all three.
        got = ingest.pick_artworks_for_shard(db, shard_id=0, total_shards=10)
        assert set(got.keys()) == {"AAA00", "CCC10", "EEE20"}
        assert got["AAA00"]["art_id"] == 0
        assert got["AAA00"]["object_number"] == "SK-A-0"

        # shard_id=1 → art_ids 1, 11 (skip art_id=3: no iiif_id).
        got = ingest.pick_artworks_for_shard(db, shard_id=1, total_shards=10)
        assert set(got.keys()) == {"BBB01", "DDD11"}


def test_pick_artworks_empty_shard_returns_empty_dict():
    with tempfile.TemporaryDirectory() as td:
        db = Path(td) / "vocabulary.db"
        _seed_test_db(db)
        got = ingest.pick_artworks_for_shard(db, shard_id=7, total_shards=10)
        assert got == {}


if __name__ == "__main__":
    test_pick_artworks_for_shard_mod_arithmetic()
    test_pick_artworks_empty_shard_returns_empty_dict()
    print("ok")
