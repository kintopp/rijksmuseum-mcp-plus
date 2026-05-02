"""Apply human-reviewed alt-name candidates to entity_alt_names with full provenance.

One-shot for v0.26 dress-rehearsal DB. Companion to scripts/probe_group_altname_fuzzy_matches.py
(which generates candidates) and scripts/backfill_group_altnames_from_edm.py (which did the
initial tier-0-only auto-insert).

Steps:
 1. Extend entity_alt_names with 7 provenance columns (idempotent).
 2. Retroactively backfill provenance for the 30,871 existing rows based on their classification.
 3. Read accepted-candidates CSV (semicolon-delimited, format from probe TSV).
 4. UPDATE pre-existing rows (already_in_db=TRUE) to record human review.
 5. INSERT new rows with full provenance (already_in_db=FALSE).
 6. Refresh entity_alt_names_fts.
 7. Record batch metadata in version_info.

Usage:
    ~/miniconda3/envs/embeddings/bin/python scripts/apply_reviewed_altname_candidates.py \
        --csv ~/Desktop/accepted-candidates.csv
    ~/miniconda3/envs/embeddings/bin/python scripts/apply_reviewed_altname_candidates.py \
        --csv ~/Desktop/accepted-candidates.csv --dry-run
"""

from __future__ import annotations

import argparse
import csv
import shutil
import sqlite3
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parents[1]
DB_PATH = PROJECT_DIR / "data" / "vocabulary.db"

# Provenance source tags
SOURCE_ORG_DUMP = "rijks_org_dump_2025-02"
SOURCE_VERSION_ORG_DUMP = "organisation.tar.gz"
SOURCE_EDM_ACTORS = "rijks_edm_actors_2019"
SOURCE_VERSION_EDM_ACTORS = "201911-rma-edm-actors.zip"

# Tier → match_method mapping for EDM-derived rows
TIER_TO_METHOD = {
    0: "exact_label",
    1: "case_insensitive",
    2: "diacritic_strip",
    3: "punctuation_strip",
    4: "token_set_jaccard",
    5: "rapidfuzz_token_set_ratio",
}

PROVENANCE_COLUMNS = [
    ("source", "TEXT"),
    ("source_version", "TEXT"),
    ("match_method", "TEXT"),
    ("match_tier", "INTEGER"),
    ("match_score", "REAL"),
    ("reviewed_by", "TEXT"),
    ("reviewed_at", "TEXT"),
    ("added_at", "TEXT"),
]


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def existing_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}


def add_columns(conn: sqlite3.Connection, dry_run: bool) -> int:
    have = existing_columns(conn, "entity_alt_names")
    added = 0
    for col, typ in PROVENANCE_COLUMNS:
        if col in have:
            continue
        sql = f"ALTER TABLE entity_alt_names ADD COLUMN {col} {typ}"
        log(f"  + {sql}")
        if not dry_run:
            conn.execute(sql)
        added += 1
    if not dry_run and added:
        conn.commit()
    return added


def parse_score(raw: str) -> float | None:
    """Defensive parse — the CSV round-trip in some spreadsheets strips the 0. prefix
    so '0.857' becomes '857'. Normalise back to the [0, 1] range."""
    if raw is None or raw == "":
        return None
    try:
        v = float(raw)
    except ValueError:
        return None
    if v > 1.0:
        # Either the leading 0. was stripped, or it's a percentage.
        # The probe writes scores as f"{x:.3f}" so the leading 0. drop is the
        # most likely culprit — divide by 10^digits to bring back into range.
        # Examples: 857 -> 0.857, 962 -> 0.962, 1000 -> 1.000.
        digits = len(raw.split(".")[0])
        v = v / (10 ** digits)
    return max(0.0, min(1.0, v))


def backfill_existing_provenance(conn: sqlite3.Connection, dry_run: bool) -> dict:
    """Set source/method/added_at on the 30,871 pre-existing rows based on classification.

    In dry-run mode the new columns don't exist yet (step 1 is skipped), so we just
    count rows by classification — those counts equal what would be updated in a real
    run, since the WHERE filter `source IS NULL` matches every row before any backfill.
    """
    updates = {}
    has_provenance_col = "source" in existing_columns(conn, "entity_alt_names")

    plan = (
        ("schema_name", "dump_schema_name", SOURCE_ORG_DUMP, SOURCE_VERSION_ORG_DUMP,
         None, None, "2026-04-29T00:00:00Z"),
        ("schema_alt_name", "dump_schema_alternateName", SOURCE_ORG_DUMP, SOURCE_VERSION_ORG_DUMP,
         None, None, "2026-04-29T00:00:00Z"),
        ("edm_altlabel", "exact_label", SOURCE_EDM_ACTORS, SOURCE_VERSION_EDM_ACTORS,
         0, 1.0, "2026-05-02T07:18:20Z"),
    )

    for cls, method, source, source_ver, tier, score, added_at in plan:
        if dry_run or not has_provenance_col:
            n = conn.execute(
                "SELECT COUNT(*) FROM entity_alt_names WHERE classification = ?", (cls,)
            ).fetchone()[0]
            verb = "would update"
        else:
            cur = conn.execute(
                "UPDATE entity_alt_names SET "
                "  source = ?, source_version = ?, match_method = ?, "
                "  match_tier = ?, match_score = ?, "
                "  added_at = COALESCE(added_at, ?) "
                "WHERE classification = ? AND source IS NULL",
                (source, source_ver, method, tier, score, added_at, cls),
            )
            n = cur.rowcount
            verb = "updated"
        updates[cls] = n
        score_str = f", tier={tier}, score={score}" if tier is not None else ""
        log(f"  classification='{cls}': {verb} {n:,} rows → method='{method}'{score_str}")

    if not dry_run and has_provenance_col:
        conn.commit()
    return updates


def process_csv(
    conn: sqlite3.Connection,
    csv_path: Path,
    reviewed_by: str,
    dry_run: bool,
) -> dict:
    """Apply CSV rows: UPDATE rows already in DB, INSERT new rows.

    Dry-run skips the per-row state probe (which would need new columns that
    haven't been added yet) and reports raw CSV-side counts.
    """
    has_provenance_col = "reviewed_at" in existing_columns(conn, "entity_alt_names")
    ts = now_iso()
    n_rows = 0
    n_skipped_already_provenanced = 0
    n_updated_existing = 0
    n_inserted_new = 0
    by_tier_inserted: dict[int, int] = {}
    by_tier_updated: dict[int, int] = {}

    with csv_path.open(newline="") as f:
        reader = csv.DictReader(f, delimiter=";")
        for row in reader:
            n_rows += 1
            tier = int(row["tier"])
            score = parse_score(row["score"])
            vocab_id = row["vocab_id"]
            entity_type = row["vocab_type"]
            alt_label = row["edm_alt_label"]
            already = row["already_in_db"].strip().lower() in ("true", "1", "yes")
            method = TIER_TO_METHOD.get(tier, "manual_override")

            if already:
                if not has_provenance_col:
                    # Dry-run before columns exist — count optimistically
                    n_updated_existing += 1
                    by_tier_updated[tier] = by_tier_updated.get(tier, 0) + 1
                    continue
                # Tier-0 row already inserted by the one-shot. Just stamp the human review.
                # Don't re-stamp if reviewed_at already set (idempotency on re-run).
                row_check = conn.execute(
                    "SELECT reviewed_at FROM entity_alt_names "
                    "WHERE entity_id = ? AND name = ?",
                    (vocab_id, alt_label),
                ).fetchone()
                if row_check is None:
                    log(f"  WARNING: row marked already_in_db=TRUE but not found: {vocab_id} / {alt_label!r}")
                    continue
                if row_check[0] is not None:
                    n_skipped_already_provenanced += 1
                    continue
                if not dry_run:
                    conn.execute(
                        "UPDATE entity_alt_names SET "
                        "  reviewed_by = ?, reviewed_at = ? "
                        "WHERE entity_id = ? AND name = ? AND reviewed_at IS NULL",
                        (reviewed_by, ts, vocab_id, alt_label),
                    )
                n_updated_existing += 1
                by_tier_updated[tier] = by_tier_updated.get(tier, 0) + 1
            else:
                # New row — INSERT with full provenance
                if not dry_run and has_provenance_col:
                    conn.execute(
                        "INSERT OR IGNORE INTO entity_alt_names "
                        "  (entity_id, entity_type, name, lang, classification, "
                        "   source, source_version, match_method, match_tier, match_score, "
                        "   reviewed_by, reviewed_at, added_at) "
                        "VALUES (?, ?, ?, NULL, 'edm_altlabel', "
                        "        ?, ?, ?, ?, ?, ?, ?, ?)",
                        (
                            vocab_id, entity_type, alt_label,
                            SOURCE_EDM_ACTORS, SOURCE_VERSION_EDM_ACTORS, method,
                            tier, score,
                            reviewed_by, ts, ts,
                        ),
                    )
                n_inserted_new += 1
                by_tier_inserted[tier] = by_tier_inserted.get(tier, 0) + 1

    if not dry_run and has_provenance_col:
        conn.commit()

    return {
        "n_csv_rows": n_rows,
        "n_skipped_already_provenanced": n_skipped_already_provenanced,
        "n_updated_existing": n_updated_existing,
        "n_inserted_new": n_inserted_new,
        "by_tier_inserted": by_tier_inserted,
        "by_tier_updated": by_tier_updated,
        "timestamp": ts,
    }


def write_version_info(
    conn: sqlite3.Connection,
    n_inserted: int,
    n_reviewed: int,
    csv_archive_path: str,
    dry_run: bool,
) -> None:
    ts = now_iso()
    rows = [
        ("entity_alt_names_provenance_at", ts),
        ("entity_alt_names_human_reviewed_at", ts),
        ("entity_alt_names_human_reviewed_count", str(n_reviewed)),
        ("entity_alt_names_human_inserted_count", str(n_inserted)),
        ("entity_alt_names_review_csv", csv_archive_path),
    ]
    for k, v in rows:
        log(f"  version_info[{k!r}] = {v!r}")
        if not dry_run:
            conn.execute(
                "INSERT INTO version_info (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (k, v),
            )
    if not dry_run:
        conn.commit()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", required=True, type=Path,
                    help="path to accepted-candidates CSV (semicolon-delimited)")
    ap.add_argument("--reviewed-by", default="human",
                    help="reviewer label (default: 'human')")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not DB_PATH.exists():
        log(f"ERROR: DB not found at {DB_PATH}")
        return 1
    if not args.csv.exists():
        log(f"ERROR: CSV not found at {args.csv}")
        return 1

    log(f"DB: {DB_PATH}")
    log(f"CSV: {args.csv}")
    log(f"Reviewed by: {args.reviewed_by}")
    log(f"Mode: {'DRY RUN' if args.dry_run else 'WRITE'}")

    # Archive the CSV into the project tree
    archive_dir = PROJECT_DIR / "data" / "audit"
    archive_dir.mkdir(parents=True, exist_ok=True)
    archive_path = archive_dir / "accepted-altname-candidates.csv"
    if not args.dry_run:
        shutil.copy2(args.csv, archive_path)
        log(f"Archived CSV → {archive_path.relative_to(PROJECT_DIR)}")

    conn = sqlite3.connect(str(DB_PATH))

    log("Step 1: Add provenance columns to entity_alt_names...")
    n_added = add_columns(conn, args.dry_run)
    log(f"  Added {n_added} columns ({'dry-run' if args.dry_run else 'committed'})")

    log("Step 2: Backfill provenance for existing rows by classification...")
    backfill_existing_provenance(conn, args.dry_run)

    log(f"Step 3: Apply reviewed candidates from {args.csv.name}...")
    result = process_csv(conn, args.csv, args.reviewed_by, args.dry_run)
    log(f"  CSV rows: {result['n_csv_rows']:,}")
    log(f"  Updated (human review on existing tier-0 rows): {result['n_updated_existing']:,}")
    log(f"  Updated rows by tier: {result['by_tier_updated']}")
    log(f"  Skipped (already provenanced from prior run): {result['n_skipped_already_provenanced']:,}")
    log(f"  Inserted new rows: {result['n_inserted_new']:,}")
    log(f"  New rows by tier: {result['by_tier_inserted']}")

    if not args.dry_run and result["n_inserted_new"] > 0:
        log("Step 4: Refresh entity_alt_names_fts...")
        conn.execute("INSERT INTO entity_alt_names_fts(entity_alt_names_fts) VALUES('rebuild')")
        fts_count = conn.execute("SELECT COUNT(*) FROM entity_alt_names_fts").fetchone()[0]
        conn.commit()
        log(f"  entity_alt_names_fts: {fts_count:,} rows")

    log("Step 5: Record batch metadata in version_info...")
    n_total_reviewed = result["n_updated_existing"] + result["n_inserted_new"]
    write_version_info(
        conn,
        n_inserted=result["n_inserted_new"],
        n_reviewed=n_total_reviewed,
        csv_archive_path=str(archive_path.relative_to(PROJECT_DIR)),
        dry_run=args.dry_run,
    )

    # Final state report
    log("")
    log("Final state:")
    final_total = conn.execute("SELECT COUNT(*) FROM entity_alt_names").fetchone()[0]
    final_by_class = dict(conn.execute(
        "SELECT classification, COUNT(*) FROM entity_alt_names GROUP BY classification"
    ).fetchall())
    final_by_type = dict(conn.execute(
        "SELECT entity_type, COUNT(*) FROM entity_alt_names GROUP BY entity_type"
    ).fetchall())
    log(f"  entity_alt_names total rows: {final_total:,}")
    log(f"  by classification: {final_by_class}")
    log(f"  by entity_type: {final_by_type}")

    if "reviewed_by" in existing_columns(conn, "entity_alt_names"):
        final_reviewed = conn.execute(
            "SELECT COUNT(*) FROM entity_alt_names WHERE reviewed_by IS NOT NULL"
        ).fetchone()[0]
        final_by_tier = dict(conn.execute(
            "SELECT match_tier, COUNT(*) FROM entity_alt_names "
            "WHERE match_tier IS NOT NULL GROUP BY match_tier"
        ).fetchall())
        log(f"  by match_tier (non-NULL): {final_by_tier}")
        log(f"  reviewed_by IS NOT NULL: {final_reviewed:,}")

        log("Smoke test (3 random reviewed group altnames):")
        for r in conn.execute(
            "SELECT entity_id, name, match_tier, match_score, match_method, reviewed_by "
            "FROM entity_alt_names "
            "WHERE entity_type='group' AND reviewed_by IS NOT NULL "
            "ORDER BY RANDOM() LIMIT 3"
        ):
            log(f"  {r}")
    else:
        log("  (provenance columns not yet present — dry-run before schema migration)")

    conn.close()
    log("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
