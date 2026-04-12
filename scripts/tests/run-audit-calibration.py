#!/usr/bin/env python3
"""Calibration dry-run for the harvest audit (#222).

Runs every EXPECTATIONS target against the current data/vocabulary.db without
mutating the database. The expected output for the v0.24 DB is:

  - Several FAILs matching the known #218 / #219 / #220 / #236 regressions
  - SKIP on phase3.museum_rooms (museum-rooms.json not committed yet, #229)
  - Everything else PASS

If a target we believe to be good (e.g. attribution_qualifier mappings) comes
back FAIL or WARN, the calibration range is wrong and should be tuned in
scripts/lib/harvest_audit.py before the next harvest.

Usage:
    python3 scripts/tests/run-audit-calibration.py [path/to/vocabulary.db]
"""

import sqlite3
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent.parent  # scripts/
sys.path.insert(0, str(SCRIPT_DIR))

from lib.harvest_audit import (  # noqa: E402
    EXPECTATIONS,
    final_summary,
    format_stdout_table,
    run_phase_audit,
)

PHASES = ["phase0", "phase2", "phase3.geocoding", "phase3", "phase4"]


def main():
    db_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("data/vocabulary.db")
    if not db_path.exists():
        sys.exit(f"DB not found: {db_path}")

    print(f"Calibrating audit against {db_path}")
    print(f"Total expectations: {len(EXPECTATIONS)}")

    conn = sqlite3.connect(str(db_path))
    all_results: dict = {}

    for phase in PHASES:
        results = run_phase_audit(conn, phase)
        if results:
            all_results[phase] = results
            format_stdout_table(results, phase)

    # Write calibration JSON to a separate path so it doesn't clobber a real run
    calibration_path = Path("data/audit") / "harvest-audit-v0.24-calibration.json"
    final_summary(
        all_results,
        strict_mode=False,
        version="v0.24-calibration",
        json_path=calibration_path,
    )
    conn.close()


if __name__ == "__main__":
    main()
