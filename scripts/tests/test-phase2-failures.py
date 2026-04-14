"""Unit tests for #239: Phase 2 URI resolution failure capture.

Tests two pieces in isolation, without hitting the live API or running a full
harvest:

1. ``resolve_uri`` returns the right ``reason`` string for each failure mode
   (timeout, http_404, http_5xx, http_<other>, parse_error, unsupported_type).
2. The ``phase2_failures`` table created by SCHEMA_SQL accepts the rows that
   ``run_phase2`` writes, with the right primary-key + replace semantics for
   re-runs.

Run with: ``python3 scripts/tests/test-phase2-failures.py``
"""

from __future__ import annotations

import io
import json
import socket
import sqlite3
import sys
import urllib.error
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

# Importing the harvest script by filename — it has a hyphenated name, so we
# load it via importlib rather than `import harvest-vocabulary-db`.
import importlib.util  # noqa: E402

spec = importlib.util.spec_from_file_location(
    "harvest_vocabulary_db", ROOT / "scripts" / "harvest-vocabulary-db.py"
)
hv = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
spec.loader.exec_module(hv)  # type: ignore[union-attr]


# ── resolve_uri reason classification ───────────────────────────────────────


def _http_error(code: int) -> urllib.error.HTTPError:
    return urllib.error.HTTPError(
        url="http://example/", code=code, msg="x", hdrs=None, fp=None  # type: ignore[arg-type]
    )


def _fake_response(payload: dict) -> object:
    """Minimal stand-in for urlopen's context manager return."""

    class _Resp:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return json.dumps(payload).encode("utf-8")

    return _Resp()


def _fake_response_raw(raw: bytes) -> object:
    class _Resp:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return raw

    return _Resp()


def test_http_404_returns_permanent_reason():
    with patch.object(hv.urllib.request, "urlopen", side_effect=_http_error(404)):
        result, reason = hv.resolve_uri("doesnotexist")
    assert result is None and reason == "http_404", (result, reason)


def test_http_500_returns_transient_reason():
    with patch.object(hv.urllib.request, "urlopen", side_effect=_http_error(500)):
        result, reason = hv.resolve_uri("flaky")
    assert result is None and reason == "http_5xx", (result, reason)


def test_http_503_returns_transient_reason():
    with patch.object(hv.urllib.request, "urlopen", side_effect=_http_error(503)):
        result, reason = hv.resolve_uri("flaky")
    assert result is None and reason == "http_5xx", (result, reason)


def test_http_429_returns_specific_code():
    with patch.object(hv.urllib.request, "urlopen", side_effect=_http_error(429)):
        result, reason = hv.resolve_uri("ratelimited")
    assert result is None and reason == "http_429", (result, reason)


def test_socket_timeout_returns_timeout_reason():
    with patch.object(hv.urllib.request, "urlopen", side_effect=socket.timeout()):
        result, reason = hv.resolve_uri("slow")
    assert result is None and reason == "timeout", (result, reason)


def test_url_error_returns_timeout_reason():
    with patch.object(
        hv.urllib.request, "urlopen", side_effect=urllib.error.URLError("dns")
    ):
        result, reason = hv.resolve_uri("dns_failure")
    assert result is None and reason == "timeout", (result, reason)


def test_invalid_json_returns_parse_error():
    with patch.object(
        hv.urllib.request, "urlopen", return_value=_fake_response_raw(b"<html>oops</html>")
    ):
        result, reason = hv.resolve_uri("html_error_page")
    assert result is None and reason == "parse_error", (result, reason)


def test_unsupported_type_returns_unsupported_reason():
    payload = {"type": "WeirdNewType", "id": "https://x/123"}
    with patch.object(hv.urllib.request, "urlopen", return_value=_fake_response(payload)):
        result, reason = hv.resolve_uri("weird")
    assert result is None and reason == "unsupported_type:WeirdNewType", (result, reason)


def test_missing_type_returns_missing_marker():
    payload = {"id": "https://x/123", "identified_by": []}
    with patch.object(hv.urllib.request, "urlopen", return_value=_fake_response(payload)):
        result, reason = hv.resolve_uri("typeless")
    assert result is None and reason == "unsupported_type:missing", (result, reason)


def test_successful_classification_returns_dict_and_none_reason():
    # Place type — minimal valid payload that LA_TYPE_MAP recognises.
    payload = {
        "type": "Place",
        "id": "https://x/456",
        "identified_by": [{"content": "Amsterdam", "language": []}],
    }
    with patch.object(hv.urllib.request, "urlopen", return_value=_fake_response(payload)):
        result, reason = hv.resolve_uri("place_456")
    assert reason is None, reason
    assert result is not None and result["type"] == "place", result
    assert result["label_en"] == "Amsterdam", result


# ── phase2_failures table behaviour ─────────────────────────────────────────


def test_phase2_failures_schema_round_trips():
    conn = sqlite3.connect(":memory:")
    conn.executescript(hv.SCHEMA_SQL)

    rows = [
        ("uri_a", "http_404"),
        ("uri_b", "timeout"),
        ("uri_c", "http_5xx"),
        ("uri_d", "unsupported_type:WeirdNewType"),
    ]
    conn.executemany(
        "INSERT INTO phase2_failures (uri, reason) VALUES (?, ?)", rows
    )
    conn.commit()

    fetched = conn.execute(
        "SELECT uri, reason FROM phase2_failures ORDER BY uri"
    ).fetchall()
    assert fetched == sorted(rows), fetched

    # created_at should be auto-populated as ISO-8601 UTC
    timestamps = conn.execute("SELECT created_at FROM phase2_failures").fetchall()
    assert all(t[0] and t[0].endswith("Z") for t in timestamps), timestamps


def test_phase2_failures_replace_on_rerun():
    """A re-run should update an existing failure's reason, not insert a duplicate.

    Mirrors how run_phase2 uses INSERT OR REPLACE so the latest run's verdict
    wins when the same URI fails differently in a later attempt.
    """

    conn = sqlite3.connect(":memory:")
    conn.executescript(hv.SCHEMA_SQL)

    conn.execute(
        "INSERT INTO phase2_failures (uri, reason) VALUES (?, ?)", ("uri_x", "timeout")
    )
    conn.commit()

    conn.execute(
        "INSERT OR REPLACE INTO phase2_failures (uri, reason) VALUES (?, ?)",
        ("uri_x", "http_404"),
    )
    conn.commit()

    rows = conn.execute("SELECT uri, reason FROM phase2_failures").fetchall()
    assert rows == [("uri_x", "http_404")], rows


# ── runner ──────────────────────────────────────────────────────────────────


def main() -> int:
    tests = [v for k, v in globals().items() if k.startswith("test_") and callable(v)]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"  PASS  {t.__name__}")
        except AssertionError as e:
            print(f"  FAIL  {t.__name__}: {e}")
            failed += 1
        except Exception as e:
            print(f"  ERROR {t.__name__}: {type(e).__name__}: {e}")
            failed += 1
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
