"""Apply manually curated additions to vocabulary_external_ids from
``data/backfills/curated-vei-additions.csv``.

Purpose: capture authority-ID concordances we discovered out-of-band
(e.g. via online research) but that the harvest pipeline didn't surface.
The CSV is the system of record so the additions survive future
re-harvests; this script is the apply layer.

Idempotent — re-applying against the current DB is a no-op (uses
INSERT OR IGNORE).

Usage:
    python3 scripts/apply_curated_vei_additions.py             # apply
    python3 scripts/apply_curated_vei_additions.py --dry-run   # report only
"""
import argparse
import csv
import sqlite3
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent.parent
CSV_PATH = PROJECT_DIR / "data" / "backfills" / "curated-vei-additions.csv"
DB_PATH = PROJECT_DIR / "data" / "vocabulary.db"

REQUIRED_COLS = ("vocab_id", "authority", "id", "uri",
                 "reviewed_by", "reviewed_at", "evidence")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--csv", type=Path, default=CSV_PATH)
    p.add_argument("--db", type=Path, default=DB_PATH)
    return p.parse_args()


def main() -> int:
    args = parse_args()
    if not args.csv.exists():
        sys.exit(f"missing {args.csv}")

    with args.csv.open(newline="") as f:
        rows = list(csv.DictReader(f))
    if not rows:
        sys.exit(f"{args.csv}: no rows")
    missing = [c for c in REQUIRED_COLS if c not in rows[0]]
    if missing:
        sys.exit(f"{args.csv}: missing columns: {missing}")

    print(f"Loaded {len(rows)} VEI addition(s) from {args.csv.name}\n")
    conn = sqlite3.connect(str(args.db))

    plans: list[tuple[dict, str]] = []  # (row, status: 'NEW' | 'EXISTS')
    errors: list[str] = []
    for r in rows:
        vid = r["vocab_id"]
        # vocab_id must exist
        if not conn.execute("SELECT 1 FROM vocabulary WHERE id = ?",
                            (vid,)).fetchone():
            errors.append(f"vocab_id {vid}: not in vocabulary")
            continue
        # Check if already present (INSERT OR IGNORE makes this idempotent
        # but pre-checking lets us print 'EXISTS' vs 'NEW' for clarity).
        present = conn.execute(
            "SELECT 1 FROM vocabulary_external_ids "
            "WHERE vocab_id = ? AND authority = ? AND id = ?",
            (vid, r["authority"], r["id"])).fetchone() is not None
        plans.append((r, "EXISTS" if present else "NEW"))

    for r, status in plans:
        marker = "✓" if status == "EXISTS" else " "
        print(f"  [{marker} {status:<6}] {r['vocab_id']}  "
              f"[{r['authority']}] {r['id']}  ({r['reviewed_by']} "
              f"{r['reviewed_at']})")

    if errors:
        print("\n=== Errors ===", file=sys.stderr)
        for e in errors:
            print(f"  {e}", file=sys.stderr)
        return 1

    new_count = sum(1 for _, s in plans if s == "NEW")
    if args.dry_run:
        print(f"\n[dry-run] {new_count} new row(s) would be inserted, "
              f"{len(plans) - new_count} already present. Re-run without "
              "--dry-run to commit.")
        conn.close()
        return 0

    if new_count == 0:
        print("\nNothing to do — all rows already present.")
        conn.close()
        return 0

    print(f"\nInserting {new_count} new row(s)...")
    with conn:
        for r, status in plans:
            if status == "NEW":
                conn.execute(
                    "INSERT OR IGNORE INTO vocabulary_external_ids "
                    "(vocab_id, authority, id, uri) VALUES (?, ?, ?, ?)",
                    (r["vocab_id"], r["authority"], r["id"], r["uri"]),
                )

    print("Verifying...")
    bad = 0
    for r, _ in plans:
        present = conn.execute(
            "SELECT 1 FROM vocabulary_external_ids "
            "WHERE vocab_id = ? AND authority = ? AND id = ?",
            (r["vocab_id"], r["authority"], r["id"])).fetchone() is not None
        if not present:
            print(f"  [FAIL] {r['vocab_id']}/{r['authority']}/{r['id']}",
                  file=sys.stderr)
            bad += 1
    print(f"  Verification: {len(plans) - bad} OK, {bad} FAIL")
    conn.close()
    return 0 if bad == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
