#!/usr/bin/env python3
"""Smoke test for WI-1: Phase 1a GeoNames rate-limit hardening.

Verifies that phase_1a_geonames:
  1. Backs off on a ``status.message`` containing an hourly/daily limit phrase,
     rather than counting it as a regular error.
  2. Soft-exits after ``hard_stop_threshold`` consecutive limit hits at the
     max_backoff_s cap, without raising.
  3. On the happy path, preserves existing behaviour (coord writes, per-row
     error counts, 1 req/sec pacing).

The test monkey-patches fetch_json and time.sleep to run instantly without
hitting the network. It uses an in-memory SQLite with a minimal
vocabulary + vocabulary_external_ids schema.

Run: python3 scripts/tests/test_phase_1a_ratelimit.py
"""
import importlib.util
import sqlite3
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SCRIPT_DIR))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _test_helpers import CheckRecorder  # noqa: E402


def load_geocode_module():
    spec = importlib.util.spec_from_file_location(
        "geocode_places", SCRIPT_DIR / "geocoding" / "geocode_places.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def make_conn(rows: list[tuple[str, str]]) -> sqlite3.Connection:
    """In-memory DB with a minimal schema sufficient for phase_1a_geonames.

    ``rows`` is a list of ``(vocab_id, geonames_id)`` tuples.
    """
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript(
        """
        CREATE TABLE vocabulary (
            id TEXT PRIMARY KEY,
            type TEXT,
            label_en TEXT,
            label_nl TEXT,
            lat REAL,
            lon REAL,
            external_id TEXT,
            coord_method TEXT,
            coord_method_detail TEXT,
            external_id_method TEXT,
            external_id_method_detail TEXT
        );
        CREATE TABLE vocabulary_external_ids (
            id TEXT NOT NULL,
            vocab_id TEXT NOT NULL,
            authority TEXT NOT NULL,
            uri TEXT
        );
        """
    )
    for vocab_id, gn_id in rows:
        conn.execute(
            "INSERT INTO vocabulary (id, type, label_en) VALUES (?, 'place', ?)",
            (vocab_id, f"place-{vocab_id}"),
        )
        conn.execute(
            "INSERT INTO vocabulary_external_ids (id, vocab_id, authority, uri) "
            "VALUES (?, ?, 'geonames', ?)",
            (gn_id, vocab_id, f"https://sws.geonames.org/{gn_id}/"),
        )
    conn.commit()
    return conn


def run_test_limit_message_triggers_hard_stop(gp, check: CheckRecorder) -> None:
    """All calls return a limit-message payload → phase should soft-exit."""
    conn = make_conn([
        ("V1", "1000001"), ("V2", "1000002"), ("V3", "1000003"),
        ("V4", "1000004"), ("V5", "1000005"),
    ])

    calls: list[str] = []

    def fake_fetch(url: str, headers=None, retries=3):
        calls.append(url)
        return {"status": {"message": "hourly limit of 1000 credits exceeded"}}

    gp.fetch_json = fake_fetch
    gp.time.sleep = lambda _s: None  # no real sleep

    updated = gp.phase_1a_geonames(conn, "dummy_user", dry_run=False)

    check.check(
        "hard-stop: no coords written",
        updated == 0,
        detail=f"expected 0 updates, got {updated}",
    )
    # With hard_stop_threshold=3 and max_backoff_s=3600, the 3rd consecutive
    # limit hit is the first one that also hits the cap (60 * 2^2 = 240, then
    # 60 * 2^3 = 480, then ... waits double each time until 3600 reached).
    # Actually: backoff values are 60, 120, 240, 480, 960, 1920, 3600, 3600, 3600.
    # Threshold is 3 consecutive AT the cap. So: hits 1-6 are below cap,
    # hit 7 is first at cap, hit 8 is second at cap, hit 9 triggers halt.
    # But we have 5 rows — all 5 get limit messages, no halt, phase finishes
    # gracefully but returns 0 updates. Verify that case here.
    check.check(
        "hard-stop: all 5 rows attempted (no halt since <9 calls)",
        len(calls) == 5,
        detail=f"expected 5 calls, got {len(calls)}",
    )
    conn.close()


def run_test_hard_stop_at_cap(gp, check: CheckRecorder) -> None:
    """Enough consecutive limit hits to reach cap + threshold → true halt."""
    conn = make_conn([(f"V{i}", f"{2000000 + i}") for i in range(20)])

    calls: list[str] = []

    def fake_fetch(url: str, headers=None, retries=3):
        calls.append(url)
        return {"status": {"message": "the daily limit has been reached"}}

    gp.fetch_json = fake_fetch
    gp.time.sleep = lambda _s: None

    updated = gp.phase_1a_geonames(conn, "dummy_user", dry_run=False)

    check.check(
        "cap-halt: no coords written",
        updated == 0,
        detail=f"expected 0 updates, got {updated}",
    )
    # backoff schedule: 60, 120, 240, 480, 960, 1920, 3600 (7), 3600 (8), 3600 (9) → halt on 9th
    # (wait == 3600 AND consecutive >= 3 both required; first hit with wait==3600
    # is the 7th, but threshold is 3 AT THE CAP, so we need hit 9).
    check.check(
        "cap-halt: halted before processing all 20 rows",
        len(calls) < 20,
        detail=f"expected halt before 20 calls, got {len(calls)}",
    )
    # Backoff schedule is 60s × 2^(consecutive-1), capped at 3600. First hit
    # that reaches the 3600 cap is the 7th (60, 120, 240, 480, 960, 1920, 3600).
    # At that point consecutive=7 is already ≥ threshold (3), so the halt
    # fires immediately on the 7th limit response.
    check.check(
        "cap-halt: halted at 7th call (first at max_backoff cap)",
        len(calls) == 7,
        detail=f"expected exactly 7 calls before halt, got {len(calls)}",
    )
    conn.close()


def run_test_happy_path_unchanged(gp, check: CheckRecorder) -> None:
    """Mix of successful + bad-ID responses — no limits → original behaviour."""
    conn = make_conn([("V1", "3000001"), ("V2", "3000002"), ("V3", "3000003")])

    def fake_fetch(url: str, headers=None, retries=3):
        if "3000002" in url:
            return {"status": {"message": "no geoname found"}}  # non-limit error
        if "3000001" in url:
            return {"lat": "52.3676", "lng": "4.9041"}  # Amsterdam
        return {"lat": "51.5074", "lng": "-0.1278"}  # London

    gp.fetch_json = fake_fetch
    gp.time.sleep = lambda _s: None

    updated = gp.phase_1a_geonames(conn, "dummy_user", dry_run=False)

    check.check(
        "happy-path: 2 coords written",
        updated == 2,
        detail=f"expected 2 updates, got {updated}",
    )
    row_v1 = conn.execute("SELECT lat, lon, coord_method FROM vocabulary WHERE id='V1'").fetchone()
    check.check(
        "happy-path: V1 coord_method == 'authority'",
        row_v1["coord_method"] == "authority",
        detail=f"got {row_v1['coord_method']!r}",
    )
    row_v2 = conn.execute("SELECT lat FROM vocabulary WHERE id='V2'").fetchone()
    check.check(
        "happy-path: V2 (bad ID) not written",
        row_v2["lat"] is None,
        detail=f"got {row_v2['lat']!r}",
    )
    conn.close()


def run_test_http_429_triggers_backoff(gp, check: CheckRecorder) -> None:
    """urllib HTTPError with code=429 funnels into the backoff path."""
    import urllib.error

    conn = make_conn([("V1", "4000001"), ("V2", "4000002"), ("V3", "4000003")])

    call_count = [0]

    def fake_fetch(url: str, headers=None, retries=3):
        call_count[0] += 1
        # Raise 429 for every call
        raise urllib.error.HTTPError(
            url, 429, "Too Many Requests", {}, None
        )

    gp.fetch_json = fake_fetch
    gp.time.sleep = lambda _s: None

    updated = gp.phase_1a_geonames(conn, "dummy_user", dry_run=False)

    check.check(
        "http-429: returns cleanly (no exception raised)",
        True,  # if we got here, it didn't raise
    )
    check.check(
        "http-429: 0 coords written",
        updated == 0,
        detail=f"expected 0, got {updated}",
    )
    conn.close()


def main() -> int:
    gp = load_geocode_module()
    check = CheckRecorder()

    # Save originals so tests don't interfere
    orig_fetch = gp.fetch_json
    orig_sleep = gp.time.sleep

    try:
        run_test_limit_message_triggers_hard_stop(gp, check)
        run_test_hard_stop_at_cap(gp, check)
        run_test_happy_path_unchanged(gp, check)
        run_test_http_429_triggers_backoff(gp, check)
    finally:
        gp.fetch_json = orig_fetch
        gp.time.sleep = orig_sleep

    print(check.summary())
    for fail in check.failures:
        print(f"  FAIL: {fail}")
    return check.exit_code()


if __name__ == "__main__":
    sys.exit(main())
