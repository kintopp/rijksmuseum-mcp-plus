"""Per-shard state machine for the IIIF tarball ingest pipeline."""
from __future__ import annotations
import json
import os
import tempfile
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path


def _utc_now_iso() -> str:
    return datetime.now(tz=timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


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

    def save_atomically(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self.last_updated = _utc_now_iso()
        fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(asdict(self), f, ensure_ascii=False, indent=2)
            os.replace(tmp, path)
        except Exception:
            try:
                os.unlink(tmp)
            finally:
                raise

    @classmethod
    def load(cls, path: Path) -> "ShardState | None":
        if not path.exists():
            return None
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return None
        return cls(**payload)
