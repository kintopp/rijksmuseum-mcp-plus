"""Apply curated label corrections from data/backfills/curated-label-corrections.csv.

Use case: spelling errors / typos in vocabulary.label_en or label_nl that
originate in Rijksmuseum's source data and survive harvests because the
harvest is a faithful copy of upstream. This script overrides them with
verified labels from authority records (Wikidata / Getty TGN / etc.).

Safety: the CSV records the expected old_label. If the DB's current label
doesn't match (e.g. because Rijks fixed it upstream), the script refuses
to write that row and reports it as a no-op. Idempotent — once corrected,
the new_label matches and the row is also reported as a no-op.

Usage:
    python3 scripts/apply_curated_label_corrections.py --dry-run
    python3 scripts/apply_curated_label_corrections.py
"""
import argparse
import csv
import sqlite3
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent
CSV_PATH = PROJECT_DIR / "data" / "backfills" / "curated-label-corrections.csv"
DB_PATH = PROJECT_DIR / "data" / "vocabulary.db"

REQUIRED_COLS = ("vocab_id", "field", "old_label", "new_label",
                 "reviewed_by", "reviewed_at", "evidence")
ALLOWED_FIELDS = ("label_en", "label_nl")


def parse_args():
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

    print(f"Loaded {len(rows)} label correction(s) from {args.csv.name}\n")
    conn = sqlite3.connect(str(args.db))

    plans: list[dict] = []
    skips: list[str] = []
    errors: list[str] = []
    for r in rows:
        vid = r["vocab_id"]
        field = r["field"]
        if field not in ALLOWED_FIELDS:
            errors.append(f"{vid}: field {field!r} not allowed (must be one "
                          f"of {ALLOWED_FIELDS})")
            continue
        cur = conn.execute(
            f"SELECT {field} FROM vocabulary WHERE id = ?", (vid,)).fetchone()
        if cur is None:
            errors.append(f"{vid}: not in vocabulary"); continue
        cur_val = cur[0]
        old, new = r["old_label"], r["new_label"]
        if cur_val == new:
            skips.append(f"{vid}.{field}: already corrected ({new!r})")
            continue
        if cur_val != old:
            skips.append(f"{vid}.{field}: db has {cur_val!r}, "
                         f"expected {old!r} — refusing to overwrite "
                         "(may have been fixed upstream)")
            continue
        plans.append({"vocab_id": vid, "field": field,
                      "old": old, "new": new,
                      "reviewer": r["reviewed_by"]})

    if errors:
        for e in errors:
            print(f"  ERROR {e}", file=sys.stderr)
        return 1

    print(f"  {len(plans)} write(s) planned, {len(skips)} skip(s):")
    for p in plans:
        print(f"    [WRITE] {p['vocab_id']}.{p['field']}: "
              f"{p['old']!r} -> {p['new']!r}  ({p['reviewer']})")
    for s in skips:
        print(f"    [SKIP]  {s}")

    if args.dry_run:
        print(f"\n[dry-run] {len(plans)} write(s). "
              "Re-run without --dry-run to commit.")
        conn.close()
        return 0

    if not plans:
        print("\nNothing to apply.")
        conn.close()
        return 0

    print(f"\nApplying {len(plans)} label correction(s)...")
    with conn:
        for p in plans:
            # field is validated against ALLOWED_FIELDS above, so f-string
            # interpolation here is safe (no SQL injection surface).
            field = p["field"]
            conn.execute(
                f"UPDATE vocabulary SET {field} = ? "
                f"WHERE id = ? AND {field} = ?",
                (p["new"], p["vocab_id"], p["old"]),
            )

    print("Verifying...")
    bad = 0
    for p in plans:
        cur = conn.execute(
            f"SELECT {p['field']} FROM vocabulary WHERE id = ?",
            (p["vocab_id"],)).fetchone()
        if cur is None or cur[0] != p["new"]:
            print(f"  [FAIL] {p['vocab_id']}.{p['field']}: got {cur[0]!r}",
                  file=sys.stderr)
            bad += 1
    print(f"  Verification: {len(plans) - bad} OK, {bad} FAIL")
    conn.close()
    return 0 if bad == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
