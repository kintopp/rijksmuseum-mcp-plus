"""Unit tests for resolve_uri reason classification and the phase2_failures table."""

from __future__ import annotations

import json
import socket
import sqlite3
import sys
import urllib.error
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _test_helpers import load_harvest_module  # noqa: E402

hv = load_harvest_module()


def _http_error(code: int) -> urllib.error.HTTPError:
    return urllib.error.HTTPError(
        url="http://example/", code=code, msg="x", hdrs=None, fp=None  # type: ignore[arg-type]
    )


def _fake_response(raw: bytes) -> object:
    class _Resp:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return raw

    return _Resp()


def _json_response(payload: dict) -> object:
    return _fake_response(json.dumps(payload).encode("utf-8"))


# ── resolve_uri reason classification ───────────────────────────────────────

REASON_CASES = [
    (_http_error(404),                                    "http_404"),
    (_http_error(500),                                    "http_5xx"),
    (_http_error(503),                                    "http_5xx"),
    (_http_error(429),                                    "http_429"),
    (socket.timeout(),                                    "timeout"),
    (urllib.error.URLError("dns"),                        "timeout"),
    (RuntimeError("totally unexpected"),                  "unknown"),
]


def test_resolve_uri_failure_reasons():
    for side_effect, expected in REASON_CASES:
        with patch.object(hv.urllib.request, "urlopen", side_effect=side_effect):
            result, reason = hv.resolve_uri("eid")
        assert result is None and reason == expected, (side_effect, expected, reason)


def test_invalid_json_returns_parse_error():
    with patch.object(hv.urllib.request, "urlopen", return_value=_fake_response(b"<html>oops</html>")):
        result, reason = hv.resolve_uri("html_error_page")
    assert result is None and reason == "parse_error", (result, reason)


def test_unsupported_type_returns_unsupported_reason():
    payload = {"type": "WeirdNewType", "id": "https://x/123"}
    with patch.object(hv.urllib.request, "urlopen", return_value=_json_response(payload)):
        result, reason = hv.resolve_uri("weird")
    assert result is None and reason == "unsupported_type:WeirdNewType", (result, reason)


def test_missing_type_returns_missing_marker():
    payload = {"id": "https://x/123", "identified_by": []}
    with patch.object(hv.urllib.request, "urlopen", return_value=_json_response(payload)):
        result, reason = hv.resolve_uri("typeless")
    assert result is None and reason == "unsupported_type:missing", (result, reason)


def test_successful_classification_returns_dict_and_none_reason():
    payload = {
        "type": "Place",
        "id": "https://x/456",
        "identified_by": [{"content": "Amsterdam", "language": []}],
    }
    with patch.object(hv.urllib.request, "urlopen", return_value=_json_response(payload)):
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
    conn.executemany("INSERT INTO phase2_failures (uri, reason) VALUES (?, ?)", rows)
    conn.commit()

    fetched = conn.execute("SELECT uri, reason FROM phase2_failures ORDER BY uri").fetchall()
    assert fetched == sorted(rows), fetched

    timestamps = conn.execute("SELECT created_at FROM phase2_failures").fetchall()
    assert all(t[0] and t[0].endswith("Z") for t in timestamps), timestamps


def test_phase2_failures_replace_on_rerun():
    """Re-runs across harvests must update the existing reason, not duplicate.

    The table is not cleared between harvests, so a URI that failed with
    ``timeout`` last week and ``http_404`` this week should reflect the
    latest verdict.
    """

    conn = sqlite3.connect(":memory:")
    conn.executescript(hv.SCHEMA_SQL)

    conn.execute("INSERT INTO phase2_failures (uri, reason) VALUES (?, ?)", ("uri_x", "timeout"))
    conn.commit()

    conn.execute(
        "INSERT OR REPLACE INTO phase2_failures (uri, reason) VALUES (?, ?)",
        ("uri_x", "http_404"),
    )
    conn.commit()

    rows = conn.execute("SELECT uri, reason FROM phase2_failures").fetchall()
    assert rows == [("uri_x", "http_404")], rows


def test_phase2_failures_reason_index_exists():
    conn = sqlite3.connect(":memory:")
    conn.executescript(hv.SCHEMA_SQL)
    indexes = {
        row[0]
        for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='phase2_failures'"
        )
    }
    assert "idx_phase2_failures_reason" in indexes, indexes


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
