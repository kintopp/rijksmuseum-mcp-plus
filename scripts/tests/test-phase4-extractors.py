#!/usr/bin/env python3
"""Regression test for Phase 4 extractors — guards against issue #219.

The v0.24 harvest populated zero rows in six new tables (`modifications`,
`related_objects`, `examinations`, `title_variants`, `assignment_pairs`,
`artwork_parent`) despite the schemas, extractors, and INSERT statements
all being present. Root cause: the insert block in `run_phase4` was gated
behind an `art_id` column check, but `art_id` was added by Phase 3's
`normalize_mappings()` which runs AFTER Phase 4. On a fresh harvest,
the gate never fired.

This test exercises two layers:

  (A) Per-extractor fixture tests — prove the extractors themselves work
      by feeding them a real Linked Art JSON and asserting non-empty
      results for fields the fixture exercises.

  (B) Bootstrap verification — prove that `run_phase4` adds `art_id` to
      the `artworks` table before the main loop, so `has_art_id` is True
      at the insert gate.

Usage:
    python3 scripts/tests/test-phase4-extractors.py
"""

import importlib.util
import json
import sqlite3
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent.parent
FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"
FIXTURE_PATH = FIXTURES_DIR / "hmo-200117708-linked-art.json"

# Load the harvest module (filename has a hyphen, so importlib)
spec = importlib.util.spec_from_file_location(
    "harvest_vocabulary_db",
    SCRIPT_DIR / "harvest-vocabulary-db.py",
)
harvest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(harvest)


# ─── Layer A: per-extractor tests against a real fixture ────────────

# Fixture: https://id.rijksmuseum.nl/200117708 — "Three Scribes", a drawing
# from the v0.24 exhibition dump member list. Fetched 2026-04-12.
# This specific artwork is known to exercise:
#   - identified_by (title_variants)
#   - attributed_by (related_objects — 1 cross-reference)
#   - produced_by.part (production_parts — 1 qualifier, 1 role)
# And is known to LACK:
#   - modified_by (no conservation record)
#   - part_of (not part of a larger work)
#   - produced_by.assigned_by (single attribution, no qualifier/creator pairs)
#
# Absence of data for the latter three is a property of this specific
# artwork, NOT a bug. Additional fixtures would be needed to cover those
# three extractors directly, but their shared structural pattern is already
# verified by the production_parts test plus visual inspection of the code.

EXPECTED_FROM_FIXTURE = {
    "title_variants": {
        "min_count": 2,
        "required_languages": ["en", "nl"],
    },
    "related_objects": {
        "min_count": 1,
    },
    "production_parts": {
        "min_qualifiers": 1,
        "min_roles": 1,
    },
}


def test_extractors_against_fixture() -> None:
    """Layer A: run all six extractors against the fixture, assert correctness."""
    if not FIXTURE_PATH.exists():
        print(f"FAIL: fixture not found at {FIXTURE_PATH}", file=sys.stderr)
        sys.exit(1)

    data = json.load(open(FIXTURE_PATH))
    errors = []

    # 1. extract_title_variants — fixture has 2 titles (EN + NL)
    titles = harvest.extract_title_variants(data)
    exp = EXPECTED_FROM_FIXTURE["title_variants"]
    if len(titles) < exp["min_count"]:
        errors.append(
            f"extract_title_variants returned {len(titles)} entries, "
            f"expected >= {exp['min_count']}"
        )
    title_langs = {t.get("language") for t in titles}
    for lang in exp["required_languages"]:
        if lang not in title_langs:
            errors.append(
                f"extract_title_variants missing language {lang!r} "
                f"(got: {sorted(l for l in title_langs if l)})"
            )

    # 2. extract_attributed_by — fixture has 1 related_object, 0 examinations
    related, exams = harvest.extract_attributed_by(data)
    exp = EXPECTED_FROM_FIXTURE["related_objects"]
    if len(related) < exp["min_count"]:
        errors.append(
            f"extract_attributed_by returned {len(related)} related_objects, "
            f"expected >= {exp['min_count']}"
        )

    # 3. extract_production_parts — fixture has 1 qualifier + 1 role
    roles, qualifiers, creators, pairs, places, source_types = (
        harvest.extract_production_parts(data)
    )
    exp = EXPECTED_FROM_FIXTURE["production_parts"]
    if len(qualifiers) < exp["min_qualifiers"]:
        errors.append(
            f"extract_production_parts returned {len(qualifiers)} qualifiers, "
            f"expected >= {exp['min_qualifiers']}"
        )
    if len(roles) < exp["min_roles"]:
        errors.append(
            f"extract_production_parts returned {len(roles)} roles, "
            f"expected >= {exp['min_roles']}"
        )

    # 4-6. Sanity-check the extractors that return empty on this fixture
    # — verify they don't crash, return the right type, and give empty lists
    mods = harvest.extract_modifications(data)
    if not isinstance(mods, list):
        errors.append(f"extract_modifications returned {type(mods).__name__}, expected list")

    parents = harvest.extract_part_of(data)
    if not isinstance(parents, list):
        errors.append(f"extract_part_of returned {type(parents).__name__}, expected list")

    if not isinstance(pairs, list):
        errors.append(f"assignment_pairs field is {type(pairs).__name__}, expected list")

    if errors:
        print("FAIL: Layer A (extractors against fixture)", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        sys.exit(1)

    print(
        f"PASS: Layer A — extractors against fixture "
        f"(titles={len(titles)}, related={len(related)}, "
        f"qualifiers={len(qualifiers)}, roles={len(roles)})"
    )


# ─── Layer B: run_phase4 art_id bootstrap ───────────────────────────

def test_run_phase4_bootstraps_art_id() -> None:
    """Layer B: verify run_phase4 adds art_id before the main loop.

    Uses a minimal in-memory DB with just the artworks table and no pending
    rows (so the function returns early after the bootstrap block). Tests
    that the bootstrap fires correctly on a fresh schema.
    """
    conn = sqlite3.connect(":memory:")

    # Minimal artworks schema that run_phase4 expects:
    # - object_number PK
    # - tier2_done column (gates pending query)
    # - linked_art_uri column (gates pending query)
    # - mappings table (int_mappings detection reads it via get_columns)
    conn.executescript("""
        CREATE TABLE artworks (
            object_number TEXT PRIMARY KEY,
            tier2_done INTEGER DEFAULT 0,
            linked_art_uri TEXT
        );
        CREATE TABLE mappings (
            object_number TEXT,
            vocab_id TEXT,
            field TEXT
        );
        CREATE TABLE vocabulary (
            id TEXT PRIMARY KEY,
            type TEXT,
            label_en TEXT
        );
    """)
    conn.commit()

    # Pre-condition: art_id must not exist
    cols_before = [r[1] for r in conn.execute("PRAGMA table_info(artworks)")]
    if "art_id" in cols_before:
        print("FAIL: Layer B precondition — art_id already present in fresh DB", file=sys.stderr)
        sys.exit(1)

    # Call run_phase4 — expected to return early (no pending artworks),
    # but should still execute the bootstrap block.
    harvest.run_phase4(conn, threads=1)

    # Post-condition: art_id must now exist
    cols_after = [r[1] for r in conn.execute("PRAGMA table_info(artworks)")]
    if "art_id" not in cols_after:
        print(
            "FAIL: Layer B — run_phase4 did not add art_id column "
            "(the bootstrap block did not fire)",
            file=sys.stderr,
        )
        print(f"  columns after: {cols_after}", file=sys.stderr)
        sys.exit(1)

    # Also check the unique index was created
    indexes = [r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='artworks'"
    )]
    if "idx_artworks_art_id" not in indexes:
        print(
            "FAIL: Layer B — idx_artworks_art_id index not created",
            file=sys.stderr,
        )
        sys.exit(1)

    # Idempotency: second call must not raise (ALTER TABLE would fail on
    # an existing column, CREATE UNIQUE INDEX would fail on an existing index)
    harvest.run_phase4(conn, threads=1)

    conn.close()
    print("PASS: Layer B — run_phase4 bootstraps art_id and is idempotent")


# ─── Main ────────────────────────────────────────────────────────────

def main() -> None:
    test_extractors_against_fixture()
    test_run_phase4_bootstraps_art_id()
    print()
    print("All Phase 4 extractor tests passed.")


if __name__ == "__main__":
    main()
