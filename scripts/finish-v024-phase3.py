#!/usr/bin/env python3
"""
Finish v0.24 Phase 3 on the current vocabulary.db after the 2026-04-17 crash.

Context: the initial `--phase 5` re-run got stuck in an O(N×M) correlated UPDATE
at `run_phase3()` lines 3942-3982 (related_objects/artwork_parent art_id
resolution), because the JOIN predicate is a computed SUBSTR that no index can
cover. This script replicates the remaining Phase-3 work — but rewrites the two
pathological UPDATEs as temp-table JOINs (same pattern the earlier
artwork_exhibitions step already uses at line 3889-3905).

What's ALREADY committed (from the earlier --phase 5 attempt, do not re-do):
  - Museum rooms, sync state, dim cleanup, mappings/rights normalization
  - Vocab enrichment (all 5 sub-steps + indexes)
  - version_info: enriched_at + enrichment_sources rows
  - artwork_exhibitions join + CSV export

What THIS script does (remaining Phase-3 tail):
  1. Resolve related_objects.related_art_id       (fast, temp-table JOIN)
  2. Resolve artwork_parent.parent_art_id         (fast, temp-table JOIN)
  3. Drop harvest-only indexes + columns
  4. Build vocab_term_counts
  5. Build vocabulary_fts (FTS5)
  6. Build person_names_fts (FTS5, if non-empty)
  7. Populate label_en_norm / label_nl_norm
  8. Build artwork_texts_fts (FTS5, if Tier 2 data present)
  9. Create conditional indexes (dimension, date_range, geo)
 10. Add + populate importance column (delegates to compute_importance)
 11. Write version_info built_at / artwork_count / vocab_count / mapping_count
 12. VACUUM

Safe to re-run: every step is idempotent (IF NOT EXISTS / IS NULL guards / DROP+CREATE).

Usage:
    python -u scripts/finish-v024-phase3.py
"""
import argparse
import sqlite3
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

# Force line-buffered stdout so progress prints appear in `tee` output
# immediately, regardless of whether the interpreter is invoked with `-u`.
sys.stdout.reconfigure(line_buffering=True)
sys.stderr.reconfigure(line_buffering=True)

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent
sys.path.insert(0, str(SCRIPT_DIR))

from compute_importance import compute_importance_scores  # noqa: E402

DEFAULT_DB_PATH = PROJECT_DIR / "data" / "vocabulary.db"


def get_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}


def step(name: str) -> float:
    print(f"\n--- {name} ---", flush=True)
    return time.time()


def done(t0: float) -> None:
    print(f"  ({time.time() - t0:.1f}s)", flush=True)


def resolve_art_ids_via_temp_join(conn: sqlite3.Connection) -> None:
    """Replaces the O(N×M) correlated UPDATE at harvest lines 3942-3982.

    Builds an indexed temp table of (art_id, hmo_id) from artworks, then drives
    both related_objects.related_art_id and artwork_parent.parent_art_id updates
    as index-seek-backed JOINs.
    """
    cur = conn.cursor()

    t0 = step("Building hmo_id temp table from artworks")
    cur.execute("""
        CREATE TEMP TABLE _tmp_hmo_art AS
        SELECT art_id,
               SUBSTR(linked_art_uri, INSTR(linked_art_uri, '.nl/') + 4) AS hmo_id
        FROM artworks
        WHERE linked_art_uri IS NOT NULL
          AND linked_art_uri != ''
          AND art_id IS NOT NULL
    """)
    cur.execute("CREATE INDEX _tmp_hmo_art_idx ON _tmp_hmo_art(hmo_id)")
    tmp_count = cur.execute("SELECT COUNT(*) FROM _tmp_hmo_art").fetchone()[0]
    print(f"  {tmp_count:,} (art_id, hmo_id) rows indexed", flush=True)
    done(t0)

    t0 = step("Resolving related_objects.related_art_id")
    ro_total = cur.execute("SELECT COUNT(*) FROM related_objects").fetchone()[0]
    cur.execute("""
        UPDATE related_objects
        SET related_art_id = (
            SELECT hmo.art_id
            FROM _tmp_hmo_art hmo
            WHERE hmo.hmo_id =
                SUBSTR(related_objects.related_la_uri,
                       INSTR(related_objects.related_la_uri, '.nl/') + 4)
        )
        WHERE related_art_id IS NULL
    """)
    conn.commit()
    ro_resolved = cur.execute(
        "SELECT COUNT(*) FROM related_objects WHERE related_art_id IS NOT NULL"
    ).fetchone()[0]
    print(f"  {ro_resolved:,}/{ro_total:,} resolved", flush=True)
    done(t0)

    t0 = step("Resolving artwork_parent.parent_art_id")
    ap_total = cur.execute("SELECT COUNT(*) FROM artwork_parent").fetchone()[0]
    cur.execute("""
        UPDATE artwork_parent
        SET parent_art_id = (
            SELECT hmo.art_id
            FROM _tmp_hmo_art hmo
            WHERE hmo.hmo_id =
                SUBSTR(artwork_parent.parent_la_uri,
                       INSTR(artwork_parent.parent_la_uri, '.nl/') + 4)
        )
        WHERE parent_art_id IS NULL
    """)
    conn.commit()
    ap_resolved = cur.execute(
        "SELECT COUNT(*) FROM artwork_parent WHERE parent_art_id IS NOT NULL"
    ).fetchone()[0]
    print(f"  {ap_resolved:,}/{ap_total:,} resolved", flush=True)
    done(t0)

    cur.execute("DROP TABLE _tmp_hmo_art")


def preserve_artwork_hmo_ids(conn: sqlite3.Connection) -> None:
    """Fix #253: copy (art_id, hmo_id) into a permanent lookup table BEFORE the
    linked_art_uri column is dropped, so decoupled post-harvest backfills (e.g.
    VI-iconclass #203) can still derive per-artwork HMO URIs.
    """
    t0 = step("Preserving art_id → hmo_id lookup")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS artwork_hmo_ids (
            art_id INTEGER PRIMARY KEY,
            hmo_id TEXT NOT NULL
        )
    """)
    if "linked_art_uri" in get_columns(conn, "artworks"):
        conn.execute("""
            INSERT OR IGNORE INTO artwork_hmo_ids (art_id, hmo_id)
            SELECT art_id,
                   SUBSTR(linked_art_uri, INSTR(linked_art_uri, '.nl/') + 4)
            FROM artworks
            WHERE tier2_done = 1
              AND linked_art_uri IS NOT NULL AND linked_art_uri != ''
              AND art_id IS NOT NULL
        """)
    count = conn.execute("SELECT COUNT(*) FROM artwork_hmo_ids").fetchone()[0]
    print(f"  {count:,} rows", flush=True)
    conn.commit()
    done(t0)


def drop_harvest_only_indexes_and_columns(conn: sqlite3.Connection) -> None:
    t0 = step("Dropping harvest-only indexes")
    for idx in ("idx_artworks_tier2", "idx_mappings_field_artwork", "idx_mappings_vocab"):
        conn.execute(f"DROP INDEX IF EXISTS {idx}")
    conn.commit()
    done(t0)

    t0 = step("Dropping linked_art_uri and tier2_done columns")
    cols = get_columns(conn, "artworks")
    for col in ("linked_art_uri", "tier2_done"):
        if col in cols:
            try:
                conn.execute(f"ALTER TABLE artworks DROP COLUMN {col}")
                print(f"  Dropped {col}", flush=True)
            except Exception as e:
                print(f"  FAILED to drop {col}: {e}", flush=True)
        else:
            print(f"  {col} already absent", flush=True)
    conn.commit()
    done(t0)


def build_vocab_term_counts(conn: sqlite3.Connection) -> None:
    t0 = step("Building vocab_term_counts")
    conn.execute("DROP TABLE IF EXISTS vocab_term_counts")
    conn.execute("""
        CREATE TABLE vocab_term_counts AS
        SELECT v.id AS vocab_id, COUNT(*) AS cnt
        FROM mappings m
        JOIN vocabulary v ON m.vocab_rowid = v.vocab_int_id
        GROUP BY m.vocab_rowid
    """)
    conn.execute("CREATE INDEX idx_vtc_cnt ON vocab_term_counts(cnt DESC)")
    conn.commit()
    count = conn.execute("SELECT COUNT(*) FROM vocab_term_counts").fetchone()[0]
    print(f"  {count:,} rows", flush=True)
    done(t0)


def build_vocabulary_fts(conn: sqlite3.Connection) -> None:
    t0 = step("Building vocabulary_fts (FTS5)")
    conn.execute("DROP TABLE IF EXISTS vocabulary_fts")
    conn.execute("""
        CREATE VIRTUAL TABLE vocabulary_fts USING fts5(
            label_en, label_nl,
            content='vocabulary', content_rowid='rowid',
            tokenize='unicode61 remove_diacritics 2'
        )
    """)
    conn.execute("INSERT INTO vocabulary_fts(vocabulary_fts) VALUES('rebuild')")
    conn.commit()
    count = conn.execute("SELECT COUNT(*) FROM vocabulary_fts").fetchone()[0]
    print(f"  {count:,} rows", flush=True)
    done(t0)


def build_person_names_fts(conn: sqlite3.Connection) -> None:
    pn_count = conn.execute("SELECT COUNT(*) FROM person_names").fetchone()[0]
    if pn_count == 0:
        print("\n--- person_names_fts: skipped (no person name data) ---", flush=True)
        return
    t0 = step("Building person_names_fts (FTS5)")
    conn.execute("DROP TABLE IF EXISTS person_names_fts")
    conn.execute("""
        CREATE VIRTUAL TABLE person_names_fts USING fts5(
            name,
            content='person_names', content_rowid='rowid',
            tokenize='unicode61 remove_diacritics 2'
        )
    """)
    conn.execute("INSERT INTO person_names_fts(person_names_fts) VALUES('rebuild')")
    conn.commit()
    count = conn.execute("SELECT COUNT(*) FROM person_names_fts").fetchone()[0]
    print(f"  {count:,} rows", flush=True)
    done(t0)


def populate_label_norms(conn: sqlite3.Connection) -> None:
    t0 = step("Populating label_en_norm / label_nl_norm")
    conn.execute("""
        UPDATE vocabulary SET
            label_en_norm = REPLACE(LOWER(label_en), ' ', ''),
            label_nl_norm = REPLACE(LOWER(label_nl), ' ', '')
        WHERE label_en IS NOT NULL OR label_nl IS NOT NULL
    """)
    conn.commit()
    count = conn.execute(
        "SELECT COUNT(*) FROM vocabulary "
        "WHERE label_en_norm IS NOT NULL OR label_nl_norm IS NOT NULL"
    ).fetchone()[0]
    print(f"  {count:,} rows normalized", flush=True)
    done(t0)


def build_artwork_texts_fts(conn: sqlite3.Connection) -> None:
    has_tier2 = conn.execute(
        "SELECT COUNT(*) FROM artworks "
        "WHERE inscription_text IS NOT NULL OR description_text IS NOT NULL "
        "OR narrative_text IS NOT NULL"
    ).fetchone()[0]
    if has_tier2 == 0:
        print("\n--- artwork_texts_fts: skipped (no Tier 2 data) ---", flush=True)
        return
    t0 = step(f"Building artwork_texts_fts (FTS5) — {has_tier2:,} artworks with text")
    conn.execute("DROP TABLE IF EXISTS artwork_texts_fts")
    conn.execute("""
        CREATE VIRTUAL TABLE artwork_texts_fts USING fts5(
            inscription_text, provenance_text, credit_line, description_text, narrative_text,
            title_all_text,
            content='artworks', content_rowid='rowid',
            tokenize='unicode61 remove_diacritics 2'
        )
    """)
    conn.execute("INSERT INTO artwork_texts_fts(artwork_texts_fts) VALUES('rebuild')")
    conn.commit()
    count = conn.execute("SELECT COUNT(*) FROM artwork_texts_fts").fetchone()[0]
    print(f"  {count:,} rows", flush=True)
    done(t0)


def create_conditional_indexes(conn: sqlite3.Connection) -> None:
    t0 = step("Creating conditional indexes")
    conditional_indexes = [
        (
            "SELECT COUNT(*) FROM artworks WHERE height_cm IS NOT NULL OR width_cm IS NOT NULL",
            "dimension",
            [
                "CREATE INDEX IF NOT EXISTS idx_artworks_height ON artworks(height_cm) WHERE height_cm IS NOT NULL",
                "CREATE INDEX IF NOT EXISTS idx_artworks_width ON artworks(width_cm) WHERE width_cm IS NOT NULL",
            ],
        ),
        (
            "SELECT COUNT(*) FROM artworks WHERE date_earliest IS NOT NULL",
            "date_range",
            [
                "CREATE INDEX IF NOT EXISTS idx_artworks_date_range ON artworks(date_earliest, date_latest) WHERE date_earliest IS NOT NULL",
            ],
        ),
        (
            "SELECT COUNT(*) FROM vocabulary WHERE lat IS NOT NULL",
            "geo",
            [
                "CREATE INDEX IF NOT EXISTS idx_vocab_lat_lon ON vocabulary(lat, lon) WHERE lat IS NOT NULL",
            ],
        ),
    ]
    for count_sql, label, index_sqls in conditional_indexes:
        count = conn.execute(count_sql).fetchone()[0]
        if count > 0:
            for sql in index_sqls:
                conn.execute(sql)
            print(f"  {label}: {count:,} qualifying rows", flush=True)
        else:
            print(f"  {label}: skipped (no qualifying rows)", flush=True)
    conn.commit()
    done(t0)


def compute_importance(conn: sqlite3.Connection) -> None:
    t0 = step("Computing importance scores")
    cur = conn.cursor()
    artworks_cols = get_columns(conn, "artworks")
    if "importance" not in artworks_cols:
        conn.execute("ALTER TABLE artworks ADD COLUMN importance INTEGER DEFAULT 0")
        conn.commit()
    result = compute_importance_scores(conn, cur)
    for score, cnt in result["distribution"]:
        pct = cnt / result["total"] * 100
        print(f"  {score:3d}: {cnt:8,} ({pct:5.1f}%)", flush=True)
    print(f"  computed in {result['elapsed']:.1f}s", flush=True)
    done(t0)


def write_version_info_build_rows(conn: sqlite3.Connection) -> None:
    t0 = step("Writing version_info build rows")
    cur = conn.cursor()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS version_info (
            key TEXT PRIMARY KEY,
            value TEXT
        )
    """)
    built_at = datetime.now(timezone.utc).isoformat()
    artwork_count = cur.execute("SELECT COUNT(*) FROM artworks").fetchone()[0]
    vocab_count = cur.execute("SELECT COUNT(*) FROM vocabulary").fetchone()[0]
    mapping_count = cur.execute("SELECT COUNT(*) FROM mappings").fetchone()[0]
    rows = [
        ("built_at", built_at),
        ("artwork_count", str(artwork_count)),
        ("vocab_count", str(vocab_count)),
        ("mapping_count", str(mapping_count)),
    ]
    conn.executemany(
        "INSERT OR REPLACE INTO version_info (key, value) VALUES (?, ?)", rows
    )
    conn.commit()
    for k, v in rows:
        print(f"  {k}: {v}", flush=True)
    done(t0)


def vacuum(conn: sqlite3.Connection) -> None:
    t0 = step("VACUUM")
    conn.execute("VACUUM")
    done(t0)


def final_summary(conn: sqlite3.Connection) -> None:
    print("\n=== Final DB state ===", flush=True)
    for k, v in conn.execute("SELECT key, value FROM version_info ORDER BY key"):
        print(f"  {k}: {v}", flush=True)
    print("\nTables:", flush=True)
    for (name,) in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ):
        count = conn.execute(f"SELECT COUNT(*) FROM {name}").fetchone()[0]
        print(f"  {name:<30s} {count:>12,}", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--db", default=str(DEFAULT_DB_PATH))
    args = parser.parse_args()

    print(f"Database: {args.db}", flush=True)
    t_start = time.time()

    conn = sqlite3.connect(args.db)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA foreign_keys = OFF")

    try:
        resolve_art_ids_via_temp_join(conn)
        preserve_artwork_hmo_ids(conn)
        drop_harvest_only_indexes_and_columns(conn)
        build_vocab_term_counts(conn)
        build_vocabulary_fts(conn)
        build_person_names_fts(conn)
        populate_label_norms(conn)
        build_artwork_texts_fts(conn)
        create_conditional_indexes(conn)
        compute_importance(conn)
        write_version_info_build_rows(conn)
        vacuum(conn)
        final_summary(conn)
    finally:
        conn.close()

    print(f"\nTotal elapsed: {(time.time() - t_start)/60:.1f}min", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
