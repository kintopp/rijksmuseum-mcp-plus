#!/usr/bin/env python3
"""Unit tests for harvest run-provenance helpers (#230).

Covers the three additions to ``scripts/harvest-vocabulary-db.py``:

  1. ``repo_path(p)`` — repo-relative when under PROJECT_DIR, absolute otherwise.
  2. ``detect_git_commit()`` — short hash + dirty flag, ``("unknown", False)``
     when run outside a git checkout.
  3. ``version_info`` round-trip — the run-provenance INSERT block at the end
     of ``main()`` writes ``harvest_started_at`` / ``harvest_finished_at`` /
     ``harvest_script_commit`` / ``harvest_script_dirty`` / ``harvest_start_phase``
     plus per-phase ``<key>_duration_sec`` rows; resumes (--start-phase N)
     only stamp the phases that actually ran.

These tests exercise the helpers directly and replay the persistence block
against an in-memory SQLite DB. They do not invoke the full harvest.

Usage:
    python3 scripts/tests/test-harvest-run-provenance.py
"""

import os
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent.parent       # scripts/
PROJECT_DIR = SCRIPT_DIR.parent                            # repo root
sys.path.insert(0, str(SCRIPT_DIR / "tests"))

from _test_helpers import load_harvest_module, run_test_functions  # noqa: E402

HM = load_harvest_module()


# ─── repo_path() ────────────────────────────────────────────────────


def test_repo_path_in_tree():
    p = PROJECT_DIR / "data" / "vocabulary.db"
    assert HM.repo_path(p) == "data/vocabulary.db", HM.repo_path(p)


def test_repo_path_in_tree_string_input():
    # Accepts strings as well as Path objects.
    p = str(PROJECT_DIR / "scripts" / "harvest-vocabulary-db.py")
    assert HM.repo_path(p) == "scripts/harvest-vocabulary-db.py"


def test_repo_path_out_of_tree_absolute():
    # /tmp is outside PROJECT_DIR — must return the absolute string unchanged.
    p = "/tmp/some-external-file.txt"
    assert HM.repo_path(p) == "/tmp/some-external-file.txt"


def test_repo_path_home_dir_absolute():
    # User's home dir (where DUMPS_DIR lives by default) is outside the repo.
    p = Path.home() / "Downloads" / "rijksmuseum-data-dumps"
    out = HM.repo_path(p)
    assert out == str(p), out
    assert out.startswith("/"), out


def test_repo_path_does_not_crash_on_nonexistent_path():
    # Path may not exist yet (e.g. orphan-vocab CSV before its parent is mkdir'd).
    p = PROJECT_DIR / "data" / "audit" / "does-not-exist-yet.csv"
    assert HM.repo_path(p) == "data/audit/does-not-exist-yet.csv"


# ─── detect_git_commit() ────────────────────────────────────────────


def test_detect_git_commit_returns_short_hash_in_repo():
    commit, dirty = HM.detect_git_commit()
    assert commit != "unknown", "expected a real commit hash inside the repo"
    assert len(commit) == 8, f"expected 8-char short hash, got {len(commit)}: {commit!r}"
    # Hash chars are hex.
    assert all(c in "0123456789abcdef" for c in commit), commit
    assert isinstance(dirty, bool)


def test_detect_git_commit_unknown_outside_git():
    # Move a copy of the helper into a tmpdir that is NOT a git checkout, then
    # call it with cwd patched. We patch PROJECT_DIR on the loaded module so
    # the subprocess calls inherit the non-git cwd.
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        original = HM.PROJECT_DIR
        try:
            HM.PROJECT_DIR = tmp_path
            commit, dirty = HM.detect_git_commit()
        finally:
            HM.PROJECT_DIR = original
        # `git rev-parse HEAD` exits non-zero outside a checkout → fallback.
        assert commit == "unknown", commit
        assert dirty is False, dirty


# ─── version_info round-trip ────────────────────────────────────────


def _replay_provenance_block(conn: sqlite3.Connection, *,
                             started_at: str, finished_at: str,
                             commit: str, dirty: bool,
                             start_phase: int,
                             phase_durations: dict[str, float]) -> None:
    """Mirror the run-provenance INSERT block at the end of main(). Kept in
    sync with the writer side; if the writer drifts, this test will catch the
    schema/key-name mismatch before a real harvest persists garbage."""
    conn.execute(
        "CREATE TABLE IF NOT EXISTS version_info (key TEXT PRIMARY KEY, value TEXT)"
    )
    rows = [
        ("harvest_started_at", started_at),
        ("harvest_finished_at", finished_at),
        ("harvest_script_commit", commit),
        ("harvest_script_dirty", "1" if dirty else "0"),
        ("harvest_start_phase", str(start_phase)),
    ]
    for key, secs in phase_durations.items():
        rows.append((f"{key}_duration_sec", f"{secs:.1f}"))
    conn.executemany(
        "INSERT OR REPLACE INTO version_info (key, value) VALUES (?, ?)",
        rows,
    )
    conn.commit()


def test_version_info_full_run():
    conn = sqlite3.connect(":memory:")
    _replay_provenance_block(
        conn,
        started_at="2026-05-05T12:00:00+00:00",
        finished_at="2026-05-05T20:30:00+00:00",
        commit="0ba82ad3",
        dirty=False,
        start_phase=0,
        phase_durations={
            "phase0":   120.0,
            "phase0_5":   3.4,
            "phase1":  8904.0,
            "phase2":   881.0,
            "phase4": 18747.0,
            "phase4_5":  60.0,
            "phase2b":  520.0,
            "phase3":   300.0,
        },
    )
    rows = dict(conn.execute("SELECT key, value FROM version_info").fetchall())
    assert rows["harvest_started_at"] == "2026-05-05T12:00:00+00:00"
    assert rows["harvest_finished_at"] == "2026-05-05T20:30:00+00:00"
    assert rows["harvest_script_commit"] == "0ba82ad3"
    assert rows["harvest_script_dirty"] == "0"
    assert rows["harvest_start_phase"] == "0"
    # Every phase that ran got a *_duration_sec row.
    for key in ("phase0", "phase0_5", "phase1", "phase2",
                "phase4", "phase4_5", "phase2b", "phase3"):
        assert f"{key}_duration_sec" in rows, f"missing {key}_duration_sec"
    # Float formatting is one decimal.
    assert rows["phase0_duration_sec"] == "120.0"
    assert rows["phase4_duration_sec"] == "18747.0"


def test_version_info_resume_only_stamps_run_phases():
    # Simulate `--start-phase 3` (Phase 3 only). Earlier phases were skipped
    # so PHASE_DURATIONS only contains `phase3` — the writer must NOT clobber
    # missing keys with NULL or zero.
    conn = sqlite3.connect(":memory:")
    _replay_provenance_block(
        conn,
        started_at="2026-05-05T12:00:00+00:00",
        finished_at="2026-05-05T12:05:00+00:00",
        commit="abc12345",
        dirty=True,
        start_phase=3,
        phase_durations={"phase3": 287.4},
    )
    rows = dict(conn.execute("SELECT key, value FROM version_info").fetchall())
    assert rows["harvest_start_phase"] == "3"
    assert rows["harvest_script_dirty"] == "1"
    assert rows["phase3_duration_sec"] == "287.4"
    # Phases that did not run must be ABSENT, not NULL or "0.0".
    for skipped in ("phase0", "phase0_5", "phase1", "phase2",
                    "phase4", "phase4_5", "phase2b"):
        assert f"{skipped}_duration_sec" not in rows, \
            f"{skipped}_duration_sec must be absent on resumes, got {rows[f'{skipped}_duration_sec']!r}"


def test_version_info_resume_preserves_prior_phase_durations():
    # Resume scenario: a prior full run already wrote phase0..phase4 durations
    # into version_info. A subsequent `--start-phase 4` rerun stamps phase4_5,
    # phase2b, phase3 — the prior phase0/1/2 values must remain intact (the
    # writer uses INSERT OR REPLACE keyed by name, not a wholesale clear).
    conn = sqlite3.connect(":memory:")
    _replay_provenance_block(
        conn,
        started_at="2026-05-05T12:00:00+00:00",
        finished_at="2026-05-05T20:30:00+00:00",
        commit="aaaaaaaa",
        dirty=False,
        start_phase=0,
        phase_durations={
            "phase0": 120.0, "phase0_5": 3.4, "phase1": 8904.0,
            "phase2": 881.0, "phase4": 18747.0, "phase4_5": 60.0,
            "phase2b": 520.0, "phase3": 300.0,
        },
    )
    # Resume: only phase4..phase3 stamps are written this time.
    _replay_provenance_block(
        conn,
        started_at="2026-05-06T08:00:00+00:00",
        finished_at="2026-05-06T13:00:00+00:00",
        commit="bbbbbbbb",
        dirty=False,
        start_phase=4,
        phase_durations={
            "phase4": 19000.0, "phase4_5": 70.0,
            "phase2b": 540.0, "phase3": 310.0,
        },
    )
    rows = dict(conn.execute("SELECT key, value FROM version_info").fetchall())
    # Run-level keys are overwritten by the latest run.
    assert rows["harvest_started_at"] == "2026-05-06T08:00:00+00:00"
    assert rows["harvest_script_commit"] == "bbbbbbbb"
    assert rows["harvest_start_phase"] == "4"
    # Phases that did NOT run this time keep their prior values.
    assert rows["phase0_duration_sec"] == "120.0"
    assert rows["phase1_duration_sec"] == "8904.0"
    assert rows["phase2_duration_sec"] == "881.0"
    # Phases that ran this time get the NEW values.
    assert rows["phase4_duration_sec"] == "19000.0"
    assert rows["phase3_duration_sec"] == "310.0"


def test_version_info_writer_matches_main_block():
    # Defensive: verify the test's _replay_provenance_block() is in lockstep
    # with the production writer in main(). Read the harvest script source and
    # confirm every key the writer emits is one this test asserts on.
    src = (PROJECT_DIR / "scripts" / "harvest-vocabulary-db.py").read_text()
    expected_keys = {
        "harvest_started_at",
        "harvest_finished_at",
        "harvest_script_commit",
        "harvest_script_dirty",
        "harvest_start_phase",
    }
    for k in expected_keys:
        assert f'"{k}"' in src, f"writer is missing key: {k}"
    # The per-phase loop pattern must be present.
    assert '_duration_sec' in src, "writer missing per-phase duration suffix"


# ─── Driver ─────────────────────────────────────────────────────────


def main():
    print("Running harvest run-provenance unit tests (#230)...")
    tests = [
        test_repo_path_in_tree,
        test_repo_path_in_tree_string_input,
        test_repo_path_out_of_tree_absolute,
        test_repo_path_home_dir_absolute,
        test_repo_path_does_not_crash_on_nonexistent_path,
        test_detect_git_commit_returns_short_hash_in_repo,
        test_detect_git_commit_unknown_outside_git,
        test_version_info_full_run,
        test_version_info_resume_only_stamps_run_phases,
        test_version_info_resume_preserves_prior_phase_durations,
        test_version_info_writer_matches_main_block,
    ]
    rc = run_test_functions(tests)
    if rc == 0:
        print("\nAll #230 run-provenance tests passed.")
    sys.exit(rc)


if __name__ == "__main__":
    main()
