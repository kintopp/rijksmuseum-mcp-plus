"""Backfill examinations.report_type_en from data/backfills/report-types.csv (#278).

The harvest extractor read the wrong key, so report_type_en was NULL for 100%
of examinations rows. The fix in scripts/harvest-vocabulary-db.py only takes
effect on a full re-harvest — which may never run again (pivot to LDES/OAI), and
incremental ingest never retroactively touches the existing backlog. So this is
the one-time path that populates the standing rows: each CSV row maps a
report-type concept URI to its labels; the English label (Dutch fallback) is
written into every examinations row with that report_type_id.

Safety:
  - Only rows where report_type_en IS NULL are written.
  - A row already holding the target label is a no-op (idempotent re-runs).
  - A row holding a DIFFERENT non-NULL value is left untouched and reported as a
    conflict — e.g. a future ingest populated it differently. Surfaced, never
    silently clobbered.

Usage:
    python3 scripts/apply_examination_report_types.py --dry-run
    python3 scripts/apply_examination_report_types.py
"""
import argparse
import csv
import sqlite3
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent
CSV_PATH = PROJECT_DIR / "data" / "backfills" / "report-types.csv"
DB_PATH = PROJECT_DIR / "data" / "vocabulary.db"

REQUIRED_COLS = ("report_type_id", "label_en", "label_nl")


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

    print(f"Loaded {len(rows)} report-type label(s) from {args.csv.name}\n")
    conn = sqlite3.connect(str(args.db))

    plans: list[dict] = []      # one per concept URI that has NULL rows to fill
    skips: list[str] = []       # fully-populated or absent URIs
    conflicts: list[str] = []   # rows holding a different non-NULL value
    errors: list[str] = []
    for r in rows:
        uri = r["report_type_id"]
        target = r["label_en"] or r["label_nl"]
        if not target:
            errors.append(f"{uri}: CSV has no label_en/label_nl")
            continue
        counts = dict(conn.execute(
            "SELECT CASE "
            "  WHEN report_type_en IS NULL THEN 'null' "
            "  WHEN report_type_en = ? THEN 'match' "
            "  ELSE 'other' END AS bucket, COUNT(*) "
            "FROM examinations WHERE report_type_id = ? GROUP BY bucket",
            (target, uri)).fetchall())
        n_null = counts.get("null", 0)
        n_match = counts.get("match", 0)
        n_other = counts.get("other", 0)
        if n_null:
            plans.append({"uri": uri, "target": target, "n": n_null})
        if n_match and not n_null:
            skips.append(f"{uri}: {n_match} row(s) already = {target!r}")
        if n_other:
            conflicts.append(f"{uri}: {n_other} row(s) hold a different "
                             f"non-NULL value (expected {target!r}) — left "
                             "untouched")

    if errors:
        for e in errors:
            print(f"  ERROR {e}", file=sys.stderr)
        return 1

    total_writes = sum(p["n"] for p in plans)
    print(f"  {total_writes} row write(s) across {len(plans)} concept(s), "
          f"{len(skips)} already-populated, {len(conflicts)} conflict(s):")
    for p in plans:
        print(f"    [WRITE] {p['uri']}: {p['n']} row(s) -> {p['target']!r}")
    for s in skips:
        print(f"    [SKIP]  {s}")
    for c in conflicts:
        print(f"    [CONFLICT] {c}")

    if args.dry_run:
        print(f"\n[dry-run] {total_writes} row write(s). "
              "Re-run without --dry-run to commit.")
        conn.close()
        return 0

    if not plans:
        print("\nNothing to apply.")
        conn.close()
        return 0

    print(f"\nApplying {total_writes} row write(s) across {len(plans)} "
          "concept(s)...")
    with conn:
        for p in plans:
            conn.execute(
                "UPDATE examinations SET report_type_en = ? "
                "WHERE report_type_id = ? AND report_type_en IS NULL",
                (p["target"], p["uri"]))

    print("Verifying...")
    bad = 0
    for p in plans:
        remaining = conn.execute(
            "SELECT COUNT(*) FROM examinations "
            "WHERE report_type_id = ? AND report_type_en IS NULL",
            (p["uri"],)).fetchone()[0]
        if remaining:
            print(f"  [FAIL] {p['uri']}: {remaining} row(s) still NULL",
                  file=sys.stderr)
            bad += 1
    print(f"  Verification: {len(plans) - bad} concept(s) OK, {bad} FAIL")
    conn.close()
    return 0 if bad == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
