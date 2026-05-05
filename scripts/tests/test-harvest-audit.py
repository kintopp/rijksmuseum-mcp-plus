#!/usr/bin/env python3
"""Unit tests for the post-phase harvest audit module (#222).

Exercises ``scripts/lib/harvest_audit.py`` against in-memory SQLite DBs that
seed each target table to a known count, then asserts the audit produces the
expected status (PASS / WARN / FAIL / SKIP) and that the JSON artifact / strict
mode behave correctly.

These tests deliberately bypass ``EXPECTATIONS`` and synthesize their own
``AuditTarget`` instances. The point is to validate the audit *logic*, not to
calibrate the EXPECTATIONS table — that calibration is done by running the
audit against the real v0.24 DB (see plan §Verification).

Usage:
    python3 scripts/tests/test-harvest-audit.py
"""

import json
import sqlite3
import sys
import tempfile
from pathlib import Path

# Make scripts/ importable so `lib.harvest_audit` resolves as a namespace package.
SCRIPT_DIR = Path(__file__).resolve().parent.parent  # scripts/
sys.path.insert(0, str(SCRIPT_DIR))

from lib.harvest_audit import (  # noqa: E402
    AuditResult,
    AuditTarget,
    classify,
    count_target,
    final_summary,
    run_phase_audit,
    write_audit_json,
)


# ─── Fixtures ───────────────────────────────────────────────────────


def make_db_with_counts(table_counts: dict[str, int]) -> sqlite3.Connection:
    """Build an in-memory DB with `table_counts` rows in each named table.

    Tables get a single INTEGER column called `n`. Counts are seeded by
    bulk-inserting `range(n)` — fast and deterministic.
    """
    conn = sqlite3.connect(":memory:")
    for table, n in table_counts.items():
        conn.execute(f"CREATE TABLE {table} (n INTEGER)")
        if n > 0:
            conn.executemany(f"INSERT INTO {table} VALUES (?)", [(i,) for i in range(n)])
    conn.commit()
    return conn


def t(name: str, table: str, min_rows: int, max_rows: int, **kwargs) -> AuditTarget:
    return AuditTarget(
        name=name,
        phase=kwargs.pop("phase", "test"),
        kind=kwargs.pop("kind", "table_count"),
        table=table,
        column=kwargs.pop("column", None),
        min_rows=min_rows,
        max_rows=max_rows,
        rationale=kwargs.pop("rationale", "test fixture"),
        required=kwargs.pop("required", True),
    )


# ─── Tests ──────────────────────────────────────────────────────────


def test_all_pass():
    """Mid-range counts on every target → all PASS."""
    conn = make_db_with_counts({"foo": 500, "bar": 1500})
    targets = [t("test.foo", "foo", 100, 1000), t("test.bar", "bar", 1000, 2000)]
    for target in targets:
        actual, note = count_target(conn, target)
        result = classify(target, actual, note)
        assert result.status == "PASS", (
            f"{target.name}: expected PASS, got {result.status} ({result.note})"
        )
    print("  test_all_pass: OK")


def test_warn_undershoot():
    """actual > 0 but below min_rows → WARN (not FAIL)."""
    conn = make_db_with_counts({"sparse": 50})
    target = t("test.sparse", "sparse", 100, 1000)
    actual, note = count_target(conn, target)
    result = classify(target, actual, note)
    assert result.status == "WARN", f"expected WARN, got {result.status}"
    assert "50" in result.note and "100" in result.note, (
        f"WARN note should mention actual + min, got: {result.note}"
    )
    print("  test_warn_undershoot: OK")


def test_warn_overshoot():
    """actual above max_rows → WARN."""
    conn = make_db_with_counts({"flood": 5000})
    target = t("test.flood", "flood", 100, 1000)
    actual, note = count_target(conn, target)
    result = classify(target, actual, note)
    assert result.status == "WARN", f"expected WARN, got {result.status}"
    assert "overshoot" in result.note.lower()
    print("  test_warn_overshoot: OK")


def test_fail_zero_rows_required():
    """Empty required table → FAIL (the #219 / #220 case)."""
    conn = make_db_with_counts({"empty": 0})
    target = t("test.empty", "empty", 100, 1000, required=True)
    actual, note = count_target(conn, target)
    result = classify(target, actual, note)
    assert result.status == "FAIL", f"expected FAIL, got {result.status}"
    print("  test_fail_zero_rows_required: OK")


def test_skip_zero_rows_optional():
    """Empty non-required table → SKIP. Covers any optional seed-backed table whose seed file is missing at harvest time."""
    conn = make_db_with_counts({"optional": 0})
    target = t("test.optional", "optional", 60, 100, required=False)
    actual, note = count_target(conn, target)
    result = classify(target, actual, note)
    assert result.status == "SKIP", f"expected SKIP, got {result.status}"
    print("  test_skip_zero_rows_optional: OK")


def test_fail_missing_table():
    """Target references a table that doesn't exist → FAIL with note."""
    conn = make_db_with_counts({"present": 500})
    target = t("test.absent", "absent", 100, 1000)
    actual, note = count_target(conn, target)
    result = classify(target, actual, note)
    assert result.status == "FAIL", f"expected FAIL, got {result.status}"
    assert "does not exist" in result.note, f"expected 'does not exist' in note, got: {result.note}"
    print("  test_fail_missing_table: OK")


def test_column_not_null():
    """column_not_null kind counts non-null rows in the named column."""
    conn = sqlite3.connect(":memory:")
    conn.execute("CREATE TABLE t (val TEXT)")
    conn.executemany("INSERT INTO t VALUES (?)", [("x",), ("y",), (None,), ("z",)])
    conn.commit()
    target = t("test.col", "t", 1, 10, kind="column_not_null", column="val")
    actual, note = count_target(conn, target)
    assert actual == 3, f"expected 3 non-null, got {actual}"
    result = classify(target, actual, note)
    assert result.status == "PASS"

    # Missing column → FAIL
    target_missing = t("test.col_missing", "t", 1, 10, kind="column_not_null", column="ghost")
    actual, note = count_target(conn, target_missing)
    result = classify(target_missing, actual, note)
    assert result.status == "FAIL"
    assert "missing" in result.note
    print("  test_column_not_null: OK")


def test_mappings_field_routes_by_schema():
    """mappings_field kind: integer schema joins field_lookup; text schema filters directly."""
    # Integer schema
    conn = sqlite3.connect(":memory:")
    conn.execute("CREATE TABLE field_lookup (id INTEGER PRIMARY KEY, name TEXT)")
    conn.execute("CREATE TABLE mappings (artwork_id INTEGER, vocab_rowid INTEGER, field_id INTEGER)")
    conn.execute("INSERT INTO field_lookup VALUES (1, 'subject'), (2, 'creator')")
    conn.executemany(
        "INSERT INTO mappings VALUES (?, ?, ?)",
        [(i, i, 1) for i in range(500)] + [(i, i, 2) for i in range(200)],
    )
    conn.commit()
    target = t("test.subj", "mappings", 100, 1000, kind="mappings_field", column="subject")
    actual, _ = count_target(conn, target)
    assert actual == 500, f"integer schema: expected 500, got {actual}"

    # Text schema
    conn2 = sqlite3.connect(":memory:")
    conn2.execute("CREATE TABLE mappings (object_number TEXT, vocab_id TEXT, field TEXT)")
    conn2.executemany(
        "INSERT INTO mappings VALUES (?, ?, ?)",
        [(f"BK-{i}", "v", "subject") for i in range(300)],
    )
    conn2.commit()
    actual2, _ = count_target(conn2, target)
    assert actual2 == 300, f"text schema: expected 300, got {actual2}"
    print("  test_mappings_field_routes_by_schema: OK")


def test_run_phase_audit_filters_by_phase():
    """run_phase_audit only runs targets matching the phase parameter — uses
    the real EXPECTATIONS list, so this also smoke-tests that the module loads.
    """
    conn = sqlite3.connect(":memory:")
    # No tables — every target should FAIL with 'does not exist'
    results = run_phase_audit(conn, "phase0")
    assert len(results) > 0, "phase0 should have at least one expectation"
    assert all(r.target.phase == "phase0" for r in results)
    assert all(r.status == "FAIL" for r in results), "all should FAIL on empty DB"
    print("  test_run_phase_audit_filters_by_phase: OK")


def test_json_artifact_round_trip():
    """write_audit_json produces a parseable file with the documented shape."""
    target = t("test.foo", "foo", 100, 1000)
    results = {"phase0": [AuditResult(target=target, actual=500, status="PASS", note="")]}
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "audit.json"
        meta = write_audit_json(path, results, strict_mode=False, version="v0.test")
        assert meta["pass"] == 1
        assert meta["total_targets"] == 1
        loaded = json.loads(path.read_text())
        assert "meta" in loaded and "results_by_phase" in loaded
        assert loaded["meta"]["harvest_version"] == "v0.test"
        assert loaded["results_by_phase"]["phase0"][0]["target"] == "test.foo"
        assert loaded["results_by_phase"]["phase0"][0]["status"] == "PASS"
    print("  test_json_artifact_round_trip: OK")


def test_strict_mode_exits_nonzero_on_fail():
    """final_summary(strict_mode=True) raises SystemExit when there are FAILs."""
    target = t("test.empty", "empty", 100, 1000)
    results = {"phase0": [AuditResult(target=target, actual=0, status="FAIL", note="zero")]}
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "audit.json"
        try:
            final_summary(results, strict_mode=True, version="v0.test", json_path=path)
        except SystemExit as e:
            assert e.code == 1, f"expected exit code 1, got {e.code}"
            assert path.exists(), "JSON artifact must be written before exit"
            print("  test_strict_mode_exits_nonzero_on_fail: OK")
            return
        raise AssertionError("expected SystemExit but final_summary returned normally")


def test_strict_mode_no_exit_when_clean():
    """final_summary(strict_mode=True) returns normally when no FAILs."""
    target = t("test.foo", "foo", 100, 1000)
    results = {"phase0": [AuditResult(target=target, actual=500, status="PASS", note="")]}
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "audit.json"
        rc = final_summary(results, strict_mode=True, version="v0.test", json_path=path)
        assert rc == 0
    print("  test_strict_mode_no_exit_when_clean: OK")


# ─── Driver ─────────────────────────────────────────────────────────


def main():
    print("Running harvest audit unit tests...")
    test_all_pass()
    test_warn_undershoot()
    test_warn_overshoot()
    test_fail_zero_rows_required()
    test_skip_zero_rows_optional()
    test_fail_missing_table()
    test_column_not_null()
    test_mappings_field_routes_by_schema()
    test_run_phase_audit_filters_by_phase()
    test_json_artifact_round_trip()
    test_strict_mode_exits_nonzero_on_fail()
    test_strict_mode_no_exit_when_clean()
    print("\nAll harvest audit tests passed.")


if __name__ == "__main__":
    main()
