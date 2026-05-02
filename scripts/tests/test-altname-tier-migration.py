#!/usr/bin/env python3
"""Dry-run regression test for the entity_alt_names tier migration (M3 / #268).

Builds an in-memory SQLite copy of the legacy entity_alt_names schema +
representative rows, applies the M3 migration SQL, and asserts:

* Conservation: total row count is preserved.
* Tier-0 edm_altlabel rows become 'deterministic' even when reviewed_at is set
  (the locked semantic correction — exact matches stay deterministic).
* Tier-1+ edm_altlabel rows become 'manual' (fuzzy + reviewed).
* schema_name / schema_alt_name rows become 'deterministic'.

Hand-written reference distribution mirrors the local v0.26 dress-rehearsal DB.

See kintopp/rijksmuseum-mcp-plus-offline#268."""

from __future__ import annotations

import sqlite3
import sys

LEGACY_DDL = """
CREATE TABLE entity_alt_names (
    entity_id      TEXT NOT NULL,
    entity_type    TEXT NOT NULL,
    name           TEXT NOT NULL,
    lang           TEXT,
    classification TEXT,
    source TEXT,
    source_version TEXT,
    match_method TEXT,
    match_tier INTEGER,
    match_score REAL,
    reviewed_by TEXT,
    reviewed_at TEXT,
    added_at TEXT,
    UNIQUE(entity_id, name)
);
"""

# Mirrors the recon distribution from the local v0.26 DB (counts scaled down
# for test runtime — proportions preserved).
SEED = (
    # (classification, match_tier, n_rows, reviewed_count)
    ("edm_altlabel",    0, 558, 558),
    ("edm_altlabel",    1, 15,  15),
    ("edm_altlabel",    2, 2,   2),
    ("edm_altlabel",    3, 20,  20),
    ("edm_altlabel",    4, 273, 273),
    ("edm_altlabel",    5, 203, 203),
    ("schema_alt_name", None, 2243, 8),
    ("schema_name",     None, 28070, 8),
)


M3 = """
ALTER TABLE entity_alt_names ADD COLUMN tier TEXT NOT NULL DEFAULT 'deterministic'
  CHECK (tier IN ('deterministic','inferred','manual'));

UPDATE entity_alt_names SET tier = 'manual'
  WHERE classification = 'edm_altlabel' AND match_tier > 0;

ALTER TABLE entity_alt_names DROP COLUMN match_method;
ALTER TABLE entity_alt_names DROP COLUMN match_tier;
ALTER TABLE entity_alt_names DROP COLUMN match_score;
"""


def seed_db() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.executescript(LEGACY_DDL)
    n = 0
    for cls, tier, rows, reviewed in SEED:
        for i in range(rows):
            n += 1
            entity_id = f"{cls}-{tier}-{i}"
            name = f"name-{n}"
            reviewed_at = "2026-05-02T07:18:20Z" if i < reviewed else None
            conn.execute(
                "INSERT INTO entity_alt_names "
                "(entity_id, entity_type, name, classification, match_tier, reviewed_at) "
                "VALUES (?, 'group', ?, ?, ?, ?)",
                (entity_id, name, cls, tier, reviewed_at),
            )
    conn.commit()
    return conn


def test_migration() -> None:
    conn = seed_db()
    pre_count = conn.execute("SELECT COUNT(*) FROM entity_alt_names").fetchone()[0]
    expected_total = sum(s[2] for s in SEED)
    assert pre_count == expected_total, f"seed mismatch: {pre_count} != {expected_total}"

    conn.executescript(M3)

    # Conservation
    post_count = conn.execute("SELECT COUNT(*) FROM entity_alt_names").fetchone()[0]
    assert post_count == pre_count, f"row count drift: {post_count} != {pre_count}"

    # Distribution
    by_tier = dict(conn.execute(
        "SELECT tier, COUNT(*) FROM entity_alt_names GROUP BY tier"
    ).fetchall())

    # Expected:
    #   manual     = sum of edm_altlabel rows with match_tier > 0
    #              = 15 + 2 + 20 + 273 + 203 = 513
    #   det        = everything else (558 edm tier-0 + 2243 schema_alt + 28070 schema_name)
    expected_manual = 15 + 2 + 20 + 273 + 203
    expected_det = 558 + 2243 + 28070
    assert by_tier.get("manual", 0) == expected_manual, (
        f"manual count: {by_tier} (expected {expected_manual})"
    )
    assert by_tier.get("deterministic", 0) == expected_det, (
        f"deterministic count: {by_tier} (expected {expected_det})"
    )
    assert by_tier.get("inferred", 0) == 0, (
        f"inferred should be empty in this DB (all fuzzy rows are reviewed): {by_tier}"
    )

    # Schema
    cols = {r[1] for r in conn.execute("PRAGMA table_info(entity_alt_names)")}
    assert "tier" in cols
    assert "match_method" not in cols, "match_method should be dropped"
    assert "match_tier" not in cols, "match_tier should be dropped"
    assert "match_score" not in cols, "match_score should be dropped"

    # CHECK constraint enforcement
    try:
        conn.execute(
            "INSERT INTO entity_alt_names (entity_id, entity_type, name, tier) "
            "VALUES ('x', 'group', 'bad', 'fuzzy')"
        )
    except sqlite3.IntegrityError:
        pass
    else:
        raise AssertionError("CHECK constraint should reject 'fuzzy'")


def main() -> int:
    try:
        test_migration()
    except AssertionError as e:
        print(f"FAIL  test_migration: {e}")
        return 1
    print("PASS  test_migration")
    return 0


if __name__ == "__main__":
    sys.exit(main())
