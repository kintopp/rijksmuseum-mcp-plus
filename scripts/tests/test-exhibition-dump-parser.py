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

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _test_helpers import load_harvest_module, create_exhibition_schema

harvest = load_harvest_module()


# Exhibition 2411023 — known ground truth from the 2026-04 dump.
# Counted via: grep -c 'linked.art/ns/terms/has_member' /tmp/exhibition-probe/2411023
#
# Covers issues #220 (has_member via P16 → Set → has_member chain),
# #236 (title via P1_is_identified_by chain), and #236 (date via P4_has_time-span chain).
EXPECTED_FIXTURES = {
    "2411023": {
        "members": 28,
        "title": (
            "Rembrandt 400. Alle tekeningen van Rembrandt in het Rijksmuseum. "
            "Deel 1: De verteller"
        ),
        "date_start": "2006-08-11",
        "date_end": "2006-10-11",
    },
}


def run_fixture_test(dump_dir: Path, exhibition_id: str, expected: dict) -> None:
    """Parse a single-file dump directory containing one exhibition and assert."""
    conn = sqlite3.connect(":memory:")
    create_exhibition_schema(conn)

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

    errors = []
    if exh_count != 1:
        errors.append(f"parser reported {exh_count} exhibitions, expected 1")
    if db_exh_count != 1:
        errors.append(f"DB has {db_exh_count} exhibitions, expected 1")
    if member_count != expected["members"]:
        errors.append(
            f"parser reported {member_count} members, expected {expected['members']}"
        )
    if db_member_count != expected["members"]:
        errors.append(
            f"DB has {db_member_count} members, expected {expected['members']}"
        )
    if row is None:
        errors.append("exhibition row not found in DB")
    else:
        title_en, title_nl, date_start, date_end = row
        if title_en != expected["title"]:
            errors.append(
                f"title_en mismatch\n      expected: {expected['title']!r}\n      got:      {title_en!r}"
            )
        if title_nl != expected["title"]:
            errors.append(
                f"title_nl mismatch (expected same as title_en)\n      expected: {expected['title']!r}\n      got:      {title_nl!r}"
            )
        if date_start != expected["date_start"]:
            errors.append(f"date_start = {date_start!r}, expected {expected['date_start']!r}")
        if date_end != expected["date_end"]:
            errors.append(f"date_end = {date_end!r}, expected {expected['date_end']!r}")

    if errors:
        print(f"FAIL: exhibition {exhibition_id}", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        conn.close()
        sys.exit(1)

    print(
        f"PASS: exhibition {exhibition_id} — "
        f"{db_member_count} members, dates {date_start}..{date_end}"
    )
    print(f"       title: {title_en!r}")
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
        run_fixture_test(dump_dir=dump_dir, exhibition_id=exh_id, expected=expected)

    print()
    print("All fixtures passed.")


if __name__ == "__main__":
    main()
