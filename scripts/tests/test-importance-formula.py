#!/usr/bin/env python3
"""Unit test for compute_importance_scores formula.

Validates:
    importance = 3*has_image + 3*has_narrative
               + min(mapping_count, 100)
               + min(set_count, 20)

set_count counts collection_set mappings, which are also included in
mapping_count (so collection_set mappings effectively carry 2× weight).
"""
import pathlib
import sqlite3
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
from compute_importance import compute_importance_scores  # noqa: E402


SET_FIELD_ID = 3
SUBJECT_FIELD_ID = 12


def make_db():
    """Build the minimal schema compute_importance_scores depends on."""
    conn = sqlite3.connect(":memory:")
    conn.execute("""
        CREATE TABLE artworks (
            object_number TEXT PRIMARY KEY,
            art_id INTEGER UNIQUE,
            has_image INTEGER DEFAULT 0,
            narrative_text TEXT,
            importance INTEGER DEFAULT 0
        )
    """)
    conn.execute("""
        CREATE TABLE mappings (
            artwork_id INTEGER NOT NULL,
            vocab_rowid INTEGER NOT NULL,
            field_id INTEGER NOT NULL,
            PRIMARY KEY (artwork_id, vocab_rowid, field_id)
        ) WITHOUT ROWID
    """)
    conn.execute("CREATE TABLE field_lookup (id INTEGER PRIMARY KEY, name TEXT UNIQUE)")
    conn.executemany(
        "INSERT INTO field_lookup (id, name) VALUES (?, ?)",
        [(SET_FIELD_ID, "collection_set"), (SUBJECT_FIELD_ID, "subject")],
    )
    return conn


def insert_artwork(conn, art_id, has_image=0, narrative=None,
                   non_set_mappings=0, set_mappings=0):
    """Insert an artwork plus its mappings.

    non_set_mappings + set_mappings = total mapping_count for this artwork.
    """
    conn.execute(
        "INSERT INTO artworks (object_number, art_id, has_image, narrative_text) "
        "VALUES (?, ?, ?, ?)",
        (f"OBJ-{art_id}", art_id, has_image, narrative),
    )
    rows = (
        [(art_id, 1000 + v, SUBJECT_FIELD_ID) for v in range(non_set_mappings)]
        + [(art_id, 2000 + v, SET_FIELD_ID) for v in range(set_mappings)]
    )
    if rows:
        conn.executemany(
            "INSERT INTO mappings (artwork_id, vocab_rowid, field_id) VALUES (?, ?, ?)",
            rows,
        )


def importance_of(conn, art_id):
    return conn.execute(
        "SELECT importance FROM artworks WHERE art_id = ?", (art_id,)
    ).fetchone()[0]


CASES = [
    # (label, kwargs, expected importance, why)
    (
        "empty (no image, no narrative, 0 mappings)",
        dict(has_image=0, narrative=None, non_set_mappings=0, set_mappings=0),
        0,
        "0 + 0 + min(0, 100) + min(0, 20)",
    ),
    (
        "image only, no mappings",
        dict(has_image=1, narrative=None, non_set_mappings=0, set_mappings=0),
        3,
        "3 + 0 + 0 + 0",
    ),
    (
        "typical mid-collection: image, 14 subjects, 3 sets",
        dict(has_image=1, narrative=None, non_set_mappings=14, set_mappings=3),
        3 + 17 + 3,  # mapping_count = 14 + 3 = 17
        "3 + 0 + min(17, 100) + min(3, 20) — sets counted in BOTH mc and sc",
    ),
    (
        "curated with narrative: image + narrative, 22 subjects, 3 sets",
        dict(has_image=1, narrative="Wall text", non_set_mappings=22, set_mappings=3),
        3 + 3 + 25 + 3,
        "3 + 3 + min(25, 100) + min(3, 20)",
    ),
    (
        "no image (e.g. archival): 0 image, no narrative, 8 subjects, 2 sets",
        dict(has_image=0, narrative=None, non_set_mappings=8, set_mappings=2),
        0 + 0 + 10 + 2,
        "0 + 0 + min(10, 100) + min(2, 20)",
    ),
    (
        "mapping clip: 150 subjects, 25 sets — both clipped",
        dict(has_image=1, narrative=None, non_set_mappings=150, set_mappings=25),
        3 + 100 + 20,  # mapping_count=175 → clipped to 100; set_count=25 → clipped to 20
        "3 + 0 + min(175, 100) + min(25, 20) — both terms hit their caps",
    ),
    (
        "narrative present but empty string ⇒ no bonus",
        dict(has_image=1, narrative="", non_set_mappings=5, set_mappings=1),
        3 + 0 + 6 + 1,
        "empty narrative_text is NOT a narrative bonus",
    ),
    (
        "all set mappings (rare edge): no subjects, 4 sets",
        dict(has_image=1, narrative=None, non_set_mappings=0, set_mappings=4),
        3 + 4 + 4,
        "mc=4 (all from sets), sc=4 — sets land in both terms",
    ),
]


def main():
    failures = 0
    for label, kwargs, expected, why in CASES:
        conn = make_db()
        insert_artwork(conn, art_id=1, **kwargs)
        compute_importance_scores(conn, conn.cursor())
        actual = importance_of(conn, 1)
        ok = actual == expected
        marker = "PASS" if ok else "FAIL"
        print(f"  [{marker}] {label}")
        print(f"         expected={expected}  actual={actual}  ({why})")
        if not ok:
            failures += 1
        conn.close()
    print()
    if failures:
        print(f"FAILED: {failures}/{len(CASES)} cases")
        sys.exit(1)
    print(f"OK: {len(CASES)}/{len(CASES)} cases")


if __name__ == "__main__":
    main()
