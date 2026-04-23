"""Unit tests for scripts/_iiif_ingest_state.py. Run with: python3 scripts/tests/test_iiif_ingest_state.py"""
from __future__ import annotations
import sys
from pathlib import Path

# Make the scripts/ directory importable without touching PYTHONPATH.
SCRIPTS_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SCRIPTS_DIR))

from _iiif_ingest_state import ShardState  # noqa: E402


def test_shardstate_construct_defaults():
    s = ShardState(shard_id=5, total_shards=200, iiif_size="1568,")
    assert s.shard_id == 5
    assert s.total_shards == 200
    assert s.iiif_size == "1568,"
    assert s.expected == {}
    assert s.downloaded == {}
    assert s.failed_retryable == {}
    assert s.failed_dead == {}
    assert s.last_uploaded_count == 0


import json
import tempfile

def test_save_load_roundtrip():
    with tempfile.TemporaryDirectory() as td:
        path = Path(td) / "shard-017.state.json"
        original = ShardState(shard_id=17, total_shards=200, iiif_size="1568,")
        original.expected["ABCDE"] = {"art_id": 42, "object_number": "SK-A-1"}
        original.downloaded["ABCDE"] = {
            "bytes": 100, "sha256": "x", "size_used": "1568,", "saved_at": "2026-01-01T00:00:00Z",
        }
        original.last_uploaded_count = 1
        original.save_atomically(path)

        assert path.exists()
        payload = json.loads(path.read_text())
        assert payload["shard_id"] == 17
        assert payload["expected"]["ABCDE"]["art_id"] == 42

        reloaded = ShardState.load(path)
        assert reloaded.shard_id == 17
        assert reloaded.expected == original.expected
        assert reloaded.downloaded == original.downloaded
        assert reloaded.last_uploaded_count == 1


def test_load_nonexistent_returns_none():
    with tempfile.TemporaryDirectory() as td:
        assert ShardState.load(Path(td) / "does-not-exist.json") is None


def test_load_corrupt_returns_none():
    with tempfile.TemporaryDirectory() as td:
        path = Path(td) / "corrupt.json"
        path.write_text("{not valid json")
        assert ShardState.load(path) is None


def test_reconcile_adds_new_and_preserves_existing():
    s = ShardState(shard_id=1, total_shards=10, iiif_size="1568,")
    s.expected["OLD1"] = {"art_id": 1, "object_number": "A"}
    s.downloaded["OLD1"] = {"bytes": 100, "sha256": "x", "size_used": "1568,", "saved_at": "t"}

    new_ids = {
        "OLD1": {"art_id": 1, "object_number": "A"},
        "NEW1": {"art_id": 11, "object_number": "B"},
    }
    s.reconcile(new_ids)

    assert "OLD1" in s.expected and "NEW1" in s.expected
    assert "OLD1" in s.downloaded  # preserved


def test_reconcile_drops_removed_ids():
    s = ShardState(shard_id=1, total_shards=10, iiif_size="1568,")
    s.expected["GONE"] = {"art_id": 1, "object_number": "A"}
    s.downloaded["GONE"] = {"bytes": 100, "sha256": "x", "size_used": "1568,", "saved_at": "t"}
    s.failed_retryable["ALSO_GONE"] = {"attempts": 1, "last_error": "x", "last_status": 500}

    s.reconcile({"KEEP": {"art_id": 2, "object_number": "B"}})

    assert s.expected == {"KEEP": {"art_id": 2, "object_number": "B"}}
    assert "GONE" not in s.downloaded
    assert "ALSO_GONE" not in s.failed_retryable


if __name__ == "__main__":
    test_shardstate_construct_defaults()
    test_save_load_roundtrip()
    test_load_nonexistent_returns_none()
    test_load_corrupt_returns_none()
    test_reconcile_adds_new_and_preserves_existing()
    test_reconcile_drops_removed_ids()
    print("ok")
