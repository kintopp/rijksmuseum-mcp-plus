#!/usr/bin/env python3
"""Narrow-scope recovery: re-create the 4 subject mappings from the v0.26
orphan CSV whose vocab targets are now live in `vocabulary` (recovered
by `recover_245_dropouts.py`).

For each of the 4 (vocab_id, notation) pairs:
  1. Find priref(s) in `lido_subjects` whose notation matches.
  2. Resolve priref -> lido_records.work_id -> artworks.object_number -> art_id.
  3. INSERT OR IGNORE into `mappings` (artwork_id, vocab_rowid, field_id)
     where field_id = subject.

Idempotent. Reports what it would do under --dry-run.

Run after `extract-lido-subjects.py` has populated `lido_subjects`.
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
VOCAB_DB = REPO_ROOT / "data" / "vocabulary.db"
LIDO_DB = REPO_ROOT / "data" / "lido-events-snapshot.db"

# (vocab_id, notation) — the 4 dump_dir=classification subject orphans
# verified present in vocabulary post-side-pass.
TARGETS = [
    ("22114059", "11Q712(CHOIR)"),
    ("22117097", "41D265(VOLANT)"),
    ("22121689", "41C635(PEAR)"),
    ("2214577",  "41D312"),
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--vocab-db", type=Path, default=VOCAB_DB)
    ap.add_argument("--lido-db", type=Path, default=LIDO_DB)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not args.vocab_db.exists() or not args.lido_db.exists():
        print(f"ERROR: missing DB", file=sys.stderr)
        return 1

    conn = sqlite3.connect(args.vocab_db)
    conn.execute(f"ATTACH DATABASE ? AS lido", (str(args.lido_db),))

    field_id_subject = conn.execute(
        "SELECT id FROM field_lookup WHERE name='subject'"
    ).fetchone()
    if not field_id_subject:
        print("ERROR: 'subject' not in field_lookup", file=sys.stderr)
        return 1
    field_id_subject = field_id_subject[0]
    print(f"field_lookup.id for 'subject' = {field_id_subject}")

    total_inserted = 0
    for vocab_id, notation in TARGETS:
        # Confirm vocab row + vocab_int_id exist
        vocab_row = conn.execute(
            "SELECT vocab_int_id, label_en, label_nl FROM vocabulary WHERE id = ?",
            (vocab_id,),
        ).fetchone()
        if not vocab_row:
            print(f"  SKIP {vocab_id} — not in vocabulary")
            continue
        vocab_int_id, label_en, label_nl = vocab_row

        # Find LIDO prirefs whose subject notation matches exactly
        prirefs = [r[0] for r in conn.execute(
            "SELECT DISTINCT priref FROM lido.lido_subjects WHERE notation = ?",
            (notation,),
        ).fetchall()]

        # Resolve priref → object_number → art_id
        if not prirefs:
            print(f"  {vocab_id} ({notation!r}, {label_en!r}): "
                  f"no LIDO matches")
            continue

        placeholders = ",".join(["?"] * len(prirefs))
        rows = conn.execute(
            f"SELECT lr.priref, lr.work_id, a.art_id "
            f"FROM lido.lido_records lr "
            f"JOIN artworks a ON a.object_number = lr.work_id "
            f"WHERE lr.priref IN ({placeholders})",
            prirefs,
        ).fetchall()

        already_mapped = 0
        inserted = 0
        for priref, work_id, art_id in rows:
            existing = conn.execute(
                "SELECT 1 FROM mappings "
                "WHERE artwork_id = ? AND vocab_rowid = ? AND field_id = ?",
                (art_id, vocab_int_id, field_id_subject),
            ).fetchone()
            if existing:
                already_mapped += 1
                continue
            if not args.dry_run:
                conn.execute(
                    "INSERT OR IGNORE INTO mappings (artwork_id, vocab_rowid, field_id) "
                    "VALUES (?, ?, ?)",
                    (art_id, vocab_int_id, field_id_subject),
                )
            inserted += 1

        print(f"  {vocab_id} ({notation!r}, {label_en!r}): "
              f"LIDO prirefs={len(prirefs)} matched_artworks={len(rows)} "
              f"already={already_mapped} new_mappings={inserted}")
        total_inserted += inserted

    if args.dry_run:
        print(f"\n[DRY-RUN] would insert {total_inserted} mappings")
        conn.rollback()
    else:
        conn.commit()
        print(f"\nInserted {total_inserted} mappings.")
    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
