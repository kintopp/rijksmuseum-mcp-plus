#!/usr/bin/env python3
"""Unit test for parse_exhibition_dump — regression test for issue #220.

Parses a single exhibition entry from the Rijksmuseum exhibition dump and
asserts that the expected `has_member` count is recovered. This catches the
class of regression where the parser silently extracts zero members because
of a predicate-namespace or blank-node-structure mismatch (the original
v0.24 symptom).

Usage:
    python3 scripts/tests/test-exhibition-dump-parser.py [--dump-dir PATH]

Default dump-dir: /tmp/exhibition-probe (populated by:
    tar -xzf ~/Downloads/rijksmuseum-data-dumps/exhibition.tar.gz \\
        -C /tmp/exhibition-probe)
"""

import argparse
import sqlite3
import sys
from pathlib import Path

# Make scripts/ importable so we can load the parser
SCRIPT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SCRIPT_DIR))

# The harvest script is at scripts/harvest-vocabulary-db.py — has a hyphen,
# so it's not directly importable as a module. Load it via importlib.
import importlib.util

spec = importlib.util.spec_from_file_location(
    "harvest_vocabulary_db",
    SCRIPT_DIR / "harvest-vocabulary-db.py",
)
harvest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(harvest)


# ─── Fixtures ────────────────────────────────────────────────────────

# Exhibition 2411023 — known ground truth from the 2026-04 dump.
# Counted via: grep -c 'linked.art/ns/terms/has_member' /tmp/exhibition-probe/2411023
#
# This test is scoped to issue #220 (has_member extraction). Title and date
# extraction are known to be broken with the same structural root cause
# (parser doesn't follow P1_is_identified_by and P4_has_time-span blank-node
# chains), but those are pre-existing bugs tracked separately.
EXPECTED_FIXTURES = {
    "2411023": {
        "expected_members": 28,
    },
}


def create_minimal_schema(conn: sqlite3.Connection) -> None:
    """Create just the exhibitions + exhibition_members tables the parser writes to."""
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS exhibitions (
            exhibition_id INTEGER PRIMARY KEY,
            title_en TEXT,
            title_nl TEXT,
            date_start TEXT,
            date_end TEXT
        );
        CREATE TABLE IF NOT EXISTS exhibition_members (
            exhibition_id INTEGER NOT NULL,
            hmo_id TEXT NOT NULL,
            PRIMARY KEY (exhibition_id, hmo_id)
        );
    """)


def run_fixture_test(dump_dir: Path, exhibition_id: str, expected_members: int) -> None:
    """Parse a single-file dump directory containing one exhibition and assert."""
    # Build an in-memory DB with the minimal schema
    conn = sqlite3.connect(":memory:")
    create_minimal_schema(conn)

    # Create a scratch dir with only the target exhibition file, so the parser
    # iterates just that one entry. Symlink is fine and avoids copying.
    scratch = Path(f"/tmp/test-exhibition-{exhibition_id}")
    if scratch.exists():
        for f in scratch.iterdir():
            f.unlink()
        scratch.rmdir()
    scratch.mkdir()
    source = dump_dir / exhibition_id
    if not source.exists():
        print(f"FAIL: fixture {exhibition_id} not found at {source}", file=sys.stderr)
        sys.exit(1)
    (scratch / exhibition_id).symlink_to(source.resolve())

    try:
        exh_count, member_count = harvest.parse_exhibition_dump(scratch, conn)
    finally:
        (scratch / exhibition_id).unlink()
        scratch.rmdir()

    # Query the DB to cross-check the parser's self-reported counts
    db_exh_count = conn.execute("SELECT COUNT(*) FROM exhibitions").fetchone()[0]
    db_member_count = conn.execute(
        "SELECT COUNT(*) FROM exhibition_members WHERE exhibition_id = ?",
        (int(exhibition_id),),
    ).fetchone()[0]

    row = conn.execute(
        "SELECT title_en, title_nl, date_start, date_end FROM exhibitions WHERE exhibition_id = ?",
        (int(exhibition_id),),
    ).fetchone()

    # Assertions — scoped to #220 (has_member extraction)
    errors = []
    if exh_count != 1:
        errors.append(f"parser reported {exh_count} exhibitions, expected 1")
    if db_exh_count != 1:
        errors.append(f"DB has {db_exh_count} exhibitions, expected 1")
    if member_count != expected_members:
        errors.append(
            f"parser reported {member_count} members, expected {expected_members}"
        )
    if db_member_count != expected_members:
        errors.append(
            f"DB has {db_member_count} members, expected {expected_members}"
        )
    if row is None:
        errors.append("exhibition row not found in DB")

    if errors:
        print(f"FAIL: exhibition {exhibition_id}", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        conn.close()
        sys.exit(1)

    print(f"PASS: exhibition {exhibition_id} — "
          f"{db_member_count} members recovered via P16_used_specific_object → Set → has_member chain")
    conn.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dump-dir", default="/tmp/exhibition-probe",
                        help="Directory containing unpacked exhibition dump files")
    args = parser.parse_args()

    dump_dir = Path(args.dump_dir)
    if not dump_dir.exists():
        print(f"ERROR: dump dir not found: {dump_dir}", file=sys.stderr)
        print("Run: mkdir -p /tmp/exhibition-probe && "
              "tar -xzf ~/Downloads/rijksmuseum-data-dumps/exhibition.tar.gz "
              "-C /tmp/exhibition-probe", file=sys.stderr)
        sys.exit(1)

    print(f"Testing parse_exhibition_dump against {dump_dir}")
    print()
    for exh_id, expected in EXPECTED_FIXTURES.items():
        run_fixture_test(
            dump_dir=dump_dir,
            exhibition_id=exh_id,
            expected_members=expected["expected_members"],
        )

    print()
    print("All fixtures passed.")


if __name__ == "__main__":
    main()
