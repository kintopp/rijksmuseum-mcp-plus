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


if __name__ == "__main__":
    test_shardstate_construct_defaults()
    print("ok")
