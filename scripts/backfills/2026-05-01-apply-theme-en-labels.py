#!/usr/bin/env python3
"""Apply curated English labels to top-N theme vocabulary rows (#300).

Background: only 552 of 4,026 theme vocabulary terms (14%) carry an English
label after harvest. The most-frequent themes — "overzeese geschiedenis",
"politieke geschiedenis", "economische geschiedenis", … — have NL only,
which leaves the new `themes[]` field on `get_artwork_details` rendering in
Dutch by default for ~80% of mappings.

This script reads a hand-curated TSV (vocab_int_id, label_nl, label_en, df)
and applies `label_en` only where the DB row currently has `label_en IS NULL`.

Idempotent: re-running with the same TSV updates 0 rows. Empty `label_en`
cells are skipped (user has not yet curated that row).

Pattern matches `scripts/backfill_coord_method_authority.py`.

Usage:
  python3 scripts/backfills/2026-05-01-apply-theme-en-labels.py             # dry-run
  python3 scripts/backfills/2026-05-01-apply-theme-en-labels.py --apply     # execute
  python3 scripts/backfills/2026-05-01-apply-theme-en-labels.py \\
      --tsv path/to/labels.tsv --apply                                      # custom TSV
"""
from __future__ import annotations

import argparse
import csv
import sqlite3
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent


def load_tsv(tsv_path: Path) -> list[tuple[int, str, str]]:
    """Load (vocab_int_id, label_nl, label_en) triples; skip rows with empty label_en."""
    rows: list[tuple[int, str, str]] = []
    with tsv_path.open(newline="") as f:
        reader = csv.DictReader(f, delimiter="\t")
        required = {"vocab_int_id", "label_nl", "label_en"}
        if not required.issubset(reader.fieldnames or []):
            raise SystemExit(
                f"TSV missing required columns. Expected {sorted(required)}, "
                f"got {reader.fieldnames}"
            )
        for r in reader:
            label_en = (r.get("label_en") or "").strip()
            if not label_en:
                continue
            vocab_int_id = int(r["vocab_int_id"])
            rows.append((vocab_int_id, (r.get("label_nl") or "").strip(), label_en))
    return rows


def precount(conn: sqlite3.Connection, ids: list[int]) -> dict:
    """Count how many target rows currently have label_en IS NULL."""
    if not ids:
        return {"total_in_tsv": 0, "would_update": 0, "already_set": 0, "missing": 0}
    placeholders = ",".join("?" * len(ids))
    rows = conn.execute(
        f"SELECT vocab_int_id, label_en FROM vocabulary WHERE vocab_int_id IN ({placeholders})",
        ids,
    ).fetchall()
    found_ids = {r[0] for r in rows}
    already_set = sum(1 for r in rows if r[1] is not None and r[1] != "")
    return {
        "total_in_tsv": len(ids),
        "would_update": len(ids) - already_set - (len(ids) - len(found_ids)),
        "already_set": already_set,
        "missing": len(ids) - len(found_ids),
    }


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--db", type=Path, default=REPO_ROOT / "data/vocabulary.db")
    ap.add_argument(
        "--tsv",
        type=Path,
        default=REPO_ROOT / "scripts/backfills/theme-en-labels-top-100.tsv",
    )
    ap.add_argument("--apply", action="store_true", help="Execute (default: dry-run)")
    args = ap.parse_args()

    if not args.db.exists():
        print(f"DB not found: {args.db}", file=sys.stderr)
        return 1
    if not args.tsv.exists():
        print(f"TSV not found: {args.tsv}", file=sys.stderr)
        return 1

    triples = load_tsv(args.tsv)
    ids = [t[0] for t in triples]

    conn = sqlite3.connect(args.db)
    b = precount(conn, ids)
    print(f"TSV: {args.tsv}")
    print(f"  rows with non-empty label_en : {b['total_in_tsv']:>4,}")
    print(f"  would update (label_en NULL) : {b['would_update']:>4,}")
    print(f"  already set (skipped)        : {b['already_set']:>4,}")
    print(f"  missing in DB                : {b['missing']:>4,}")

    if not args.apply:
        print("\n(dry-run — pass --apply to execute the UPDATEs)")
        return 0

    print("\nApplying...")
    cur = conn.cursor()
    n_updated = 0
    for vocab_int_id, _label_nl, label_en in triples:
        c = cur.execute(
            "UPDATE vocabulary SET label_en = ? WHERE vocab_int_id = ? AND label_en IS NULL",
            (label_en, vocab_int_id),
        )
        n_updated += c.rowcount
    conn.commit()
    print(f"  rows updated: {n_updated:,}")

    remaining = conn.execute(
        f"SELECT COUNT(*) FROM vocabulary WHERE vocab_int_id IN ({','.join('?'*len(ids))}) "
        "AND label_en IS NULL",
        ids,
    ).fetchone()[0]
    print(f"After: target rows still with NULL label_en = {remaining:,}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
