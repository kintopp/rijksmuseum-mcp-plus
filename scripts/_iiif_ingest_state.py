"""Per-shard state machine for the IIIF tarball ingest pipeline."""
from __future__ import annotations
import json
import os
import tempfile
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from enum import Enum
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

    def reconcile(self, expected_ids: dict[str, dict]) -> None:
        """Update `expected` to match a fresh DB query.

        Adds new IDs, preserves existing download/failure progress for retained IDs,
        and drops progress entries for IDs no longer present (rare — only if the DB
        is re-harvested with different row counts).
        """
        self.expected = dict(expected_ids)
        kept = set(expected_ids.keys())
        self.downloaded = {k: v for k, v in self.downloaded.items() if k in kept}
        self.failed_retryable = {k: v for k, v in self.failed_retryable.items() if k in kept}
        self.failed_dead = {k: v for k, v in self.failed_dead.items() if k in kept}

    def record_success(self, iiif_id: str, *, nbytes: int, sha256: str, size_used: str) -> None:
        self.downloaded[iiif_id] = {
            "bytes": nbytes,
            "sha256": sha256,
            "size_used": size_used,
            "saved_at": _utc_now_iso(),
        }
        self.failed_retryable.pop(iiif_id, None)

    def record_failure(self, iiif_id: str, *, error: str, status: int, max_attempts: int) -> None:
        entry = self.failed_retryable.get(iiif_id, {"attempts": 0})
        entry["attempts"] = entry.get("attempts", 0) + 1
        entry["last_error"] = error
        entry["last_status"] = status
        if entry["attempts"] >= max_attempts:
            self.failed_retryable.pop(iiif_id, None)
            self.failed_dead[iiif_id] = {
                "reason": f"retries exhausted ({entry['attempts']} attempts); last: {error}",
                "last_status": status,
            }
        else:
            self.failed_retryable[iiif_id] = entry

    def mark_dead(self, iiif_id: str, *, reason: str, last_status: int) -> None:
        self.failed_retryable.pop(iiif_id, None)
        self.failed_dead[iiif_id] = {"reason": reason, "last_status": last_status}

    def pending_or_retryable(self) -> set[str]:
        return set(self.expected) - set(self.downloaded) - set(self.failed_dead)


class ShardStatus(str, Enum):
    NOT_STARTED = "not_started"
    PARTIAL = "partial"
    RETRY_PENDING = "retry_pending"
    REPACK_NEEDED = "repack_needed"
    COMPLETE = "complete"
    DONE_WITH_DEATHS = "done_with_deaths"


def classify_action(
    state: ShardState,
    *,
    bucket_tar_present: bool,
    bucket_manifest: dict | None,
) -> ShardStatus:
    expected = set(state.expected)
    downloaded = set(state.downloaded)
    dead = set(state.failed_dead)
    retryable = set(state.failed_retryable)

    if not expected and not bucket_tar_present:
        return ShardStatus.NOT_STARTED
    if not downloaded and not dead and not retryable and not bucket_tar_present:
        return ShardStatus.NOT_STARTED

    if retryable:
        return ShardStatus.RETRY_PENDING

    # Terminal coverage: every expected ID is either downloaded or dead.
    terminal = downloaded | dead
    if expected and expected == terminal and bucket_tar_present and bucket_manifest is not None:
        manifest_members = set(bucket_manifest.get("members", {}).keys())
        if manifest_members == downloaded:
            return ShardStatus.DONE_WITH_DEATHS if dead else ShardStatus.COMPLETE
        return ShardStatus.REPACK_NEEDED

    if bucket_tar_present and bucket_manifest is not None:
        manifest_members = set(bucket_manifest.get("members", {}).keys())
        if downloaded - manifest_members:
            return ShardStatus.REPACK_NEEDED

    return ShardStatus.PARTIAL
