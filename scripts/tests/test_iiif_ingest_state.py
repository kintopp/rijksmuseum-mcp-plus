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


def test_record_success_moves_from_pending_and_retryable():
    s = ShardState(shard_id=1, total_shards=10, iiif_size="1568,")
    s.expected["A"] = {"art_id": 1, "object_number": "A"}
    s.failed_retryable["A"] = {"attempts": 2, "last_error": "timeout", "last_status": -1}

    s.record_success("A", nbytes=100, sha256="abc", size_used="1568,")

    assert "A" in s.downloaded
    assert s.downloaded["A"]["bytes"] == 100
    assert s.downloaded["A"]["sha256"] == "abc"
    assert s.downloaded["A"]["size_used"] == "1568,"
    assert "A" not in s.failed_retryable


def test_record_failure_increments_attempts():
    s = ShardState(shard_id=1, total_shards=10, iiif_size="1568,")
    s.expected["A"] = {"art_id": 1, "object_number": "A"}

    s.record_failure("A", error="timeout", status=-1, max_attempts=3)
    assert s.failed_retryable["A"]["attempts"] == 1

    s.record_failure("A", error="500", status=500, max_attempts=3)
    assert s.failed_retryable["A"]["attempts"] == 2

    s.record_failure("A", error="timeout", status=-1, max_attempts=3)
    assert "A" not in s.failed_retryable
    assert "A" in s.failed_dead
    assert "exhausted" in s.failed_dead["A"]["reason"].lower()


def test_mark_dead_directly():
    s = ShardState(shard_id=1, total_shards=10, iiif_size="1568,")
    s.expected["A"] = {"art_id": 1, "object_number": "A"}

    s.mark_dead("A", reason="HTTP 404 at both sizes", last_status=404)

    assert "A" not in s.failed_retryable
    assert s.failed_dead["A"]["reason"] == "HTTP 404 at both sizes"
    assert s.failed_dead["A"]["last_status"] == 404


def test_pending_excludes_done_and_dead():
    s = ShardState(shard_id=1, total_shards=10, iiif_size="1568,")
    for iid in ["A", "B", "C", "D"]:
        s.expected[iid] = {"art_id": hash(iid) % 1000, "object_number": iid}
    s.downloaded["A"] = {"bytes": 1, "sha256": "x", "size_used": "1568,", "saved_at": "t"}
    s.failed_dead["B"] = {"reason": "dead", "last_status": 404}
    s.failed_retryable["C"] = {"attempts": 1, "last_error": "x", "last_status": 500}

    pending = s.pending_or_retryable()
    assert pending == {"C", "D"}


if __name__ == "__main__":
    test_shardstate_construct_defaults()
    test_save_load_roundtrip()
    test_load_nonexistent_returns_none()
    test_load_corrupt_returns_none()
    test_reconcile_adds_new_and_preserves_existing()
    test_reconcile_drops_removed_ids()
    test_record_success_moves_from_pending_and_retryable()
    test_record_failure_increments_attempts()
    test_mark_dead_directly()
    test_pending_excludes_done_and_dead()
    print("ok")
