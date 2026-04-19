#!/usr/bin/env python3
"""Smoke test for WI-5 — apply_areal_overrides idempotence & tier-respect."""
from __future__ import annotations

import importlib.util
import sqlite3
import sys
import tempfile
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SCRIPT_DIR))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _test_helpers import CheckRecorder  # noqa: E402


def load_apply():
    spec = importlib.util.spec_from_file_location(
        "apply_areal_overrides", SCRIPT_DIR / "apply_areal_overrides.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def make_conn_with_rows(rows: list[tuple]) -> sqlite3.Connection:
    """rows: list of (id, type, label_en, placetype_source, is_areal)."""
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript("""
        CREATE TABLE vocabulary (
            id TEXT PRIMARY KEY,
            type TEXT,
            label_en TEXT,
            placetype TEXT,
            placetype_source TEXT,
            is_areal INTEGER
        );
    """)
    for r in rows:
        conn.execute(
            "INSERT INTO vocabulary (id, type, label_en, placetype_source, is_areal) "
            "VALUES (?, ?, ?, ?, ?)",
            r,
        )
    conn.commit()
    return conn


def run_test_happy_path(ap, check: CheckRecorder) -> None:
    conn = make_conn_with_rows([
        ("A", "place", "Atlantic Ocean", None, None),
        ("B", "place", "Pacific Ocean",  None, None),
    ])
    overrides = [
        {"vocab_id": "A", "label": "Atlantic Ocean",
         "category": "ocean", "reason": "seed"},
        {"vocab_id": "B", "label": "Pacific Ocean",
         "category": "ocean", "reason": "seed"},
    ]
    stats = ap.apply(conn, overrides)
    check.check("happy-path: updated 2", stats["updated"] == 2,
                detail=str(stats))
    check.check("happy-path: no conflicts", len(stats["conflicts"]) == 0)
    for vid in ("A", "B"):
        r = conn.execute("SELECT placetype_source, is_areal FROM vocabulary WHERE id = ?",
                         (vid,)).fetchone()
        check.check(f"happy-path: {vid} is_areal=1",
                    r["is_areal"] == 1, detail=str(dict(r)))
        check.check(f"happy-path: {vid} source=manual",
                    r["placetype_source"] == "manual")
    conn.close()


def run_test_authority_held(ap, check: CheckRecorder) -> None:
    """TGN/Wikidata-sourced rows must not be overwritten."""
    conn = make_conn_with_rows([
        ("A", "place", "Amsterdam",  "tgn",      0),   # TGN says point
        ("B", "place", "Vatican",    "wikidata", 0),   # WD says point
    ])
    overrides = [
        {"vocab_id": "A", "label": "Amsterdam",
         "category": "other", "reason": "accidental override"},
        {"vocab_id": "B", "label": "Vatican",
         "category": "other", "reason": "accidental override"},
    ]
    stats = ap.apply(conn, overrides)
    check.check("authority-held: 0 updates",
                stats["updated"] == 0, detail=str(stats))
    check.check("authority-held: 2 conflicts logged",
                len(stats["conflicts"]) == 2)
    # Values unchanged
    for vid in ("A", "B"):
        r = conn.execute("SELECT placetype_source, is_areal FROM vocabulary WHERE id = ?",
                         (vid,)).fetchone()
        check.check(f"authority-held: {vid} is_areal unchanged (still 0)",
                    r["is_areal"] == 0)
    conn.close()


def run_test_idempotent(ap, check: CheckRecorder) -> None:
    """Running twice produces the same state; second pass reports already_manual."""
    conn = make_conn_with_rows([("A", "place", "Atlantic Ocean", None, None)])
    overrides = [{"vocab_id": "A", "label": "Atlantic Ocean",
                  "category": "ocean", "reason": "seed"}]

    first = ap.apply(conn, overrides)
    second = ap.apply(conn, overrides)
    check.check("idempotent: first updates 1",
                first["updated"] == 1)
    check.check("idempotent: second updates 0",
                second["updated"] == 0, detail=str(second))
    check.check("idempotent: second reports already_manual=1",
                second["already_manual"] == 1)
    conn.close()


def run_test_missing_row(ap, check: CheckRecorder) -> None:
    """TSV row pointing to a non-existent vocab_id should be counted not raise."""
    conn = make_conn_with_rows([])
    overrides = [{"vocab_id": "NONEXISTENT", "label": "whatever",
                  "category": "other", "reason": "test"}]
    stats = ap.apply(conn, overrides)
    check.check("missing: counted", stats["missing"] == 1, detail=str(stats))
    conn.close()


def run_test_tsv_parsing(ap, check: CheckRecorder) -> None:
    """Parser handles comments, blank lines, malformed rows."""
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".tsv", delete=False
    ) as tmp:
        tmp.write("# comment header\n")
        tmp.write("\n")
        tmp.write("A\tAtlantic Ocean\tocean\tseed\n")
        tmp.write("   # indented comment\n")
        tmp.write("B\tPacific Ocean\tocean\tseed\n")
        tmp.write("onetoken\n")  # malformed
        tmp.write("C\tIndian Ocean\tocean\tseed\n")
        tsv_path = Path(tmp.name)

    try:
        rows = ap.load_overrides(tsv_path)
        check.check("tsv: 3 valid rows parsed",
                    len(rows) == 3, detail=f"got {len(rows)}")
        check.check("tsv: vocab_id stripped",
                    rows[0]["vocab_id"] == "A")
    finally:
        tsv_path.unlink()


def main() -> int:
    ap = load_apply()
    check = CheckRecorder()
    run_test_happy_path(ap, check)
    run_test_authority_held(ap, check)
    run_test_idempotent(ap, check)
    run_test_missing_row(ap, check)
    run_test_tsv_parsing(ap, check)
    print(check.summary())
    for fail in check.failures:
        print(f"  FAIL: {fail}")
    return check.exit_code()


if __name__ == "__main__":
    sys.exit(main())
