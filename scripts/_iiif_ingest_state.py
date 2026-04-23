"""Per-shard state machine for the IIIF tarball ingest pipeline."""
from __future__ import annotations
from dataclasses import dataclass, field


@dataclass
class ShardState:
    shard_id: int
    total_shards: int
    iiif_size: str
    expected: dict[str, dict] = field(default_factory=dict)
    downloaded: dict[str, dict] = field(default_factory=dict)
    failed_retryable: dict[str, dict] = field(default_factory=dict)
    failed_dead: dict[str, dict] = field(default_factory=dict)
    last_updated: str = ""
    last_uploaded_count: int = 0
