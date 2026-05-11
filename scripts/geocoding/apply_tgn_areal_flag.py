"""Apply is_areal=1 to vocabulary places where:
  - TGN's RDF response confirmed no coord (status='no_coords' in
    data/inferred-rijks-tgn-coords.csv)
  - vocabulary.placetype is NOT in
    enrichment_methods.INHERITANCE_ALLOWED_PLACETYPES
    (i.e. the placetype is non-settlement — TGN's missing centroid is
    *expected* for an areal entity rather than anomalous)
  - is_areal is currently 0 (not already flagged)

Mirrors batch_geocode.revalidate_tgn_rdf's Branch D logic, applied to the
55 no-coords rows that promote_inferred_via_rijks_tgn.py skipped silently.

Idempotent. Defensive: NULL placetype rows are NOT flagged
(fail-closed — same semantics as the existing inheritance allow-list).

Usage:
    python3 scripts/apply_tgn_areal_flag.py --dry-run
    python3 scripts/apply_tgn_areal_flag.py
"""
import argparse
import csv
import sqlite3
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent.parent
sys.path.insert(0, str(SCRIPT_DIR.parent))
from lib import enrichment_methods as em  # noqa: E402

CACHE_CSV = PROJECT_DIR / "data" / "inferred-rijks-tgn-coords.csv"
DB_PATH = PROJECT_DIR / "data" / "vocabulary.db"


def parse_args():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--db", type=Path, default=DB_PATH)
    return p.parse_args()


def main() -> int:
    args = parse_args()
    if not CACHE_CSV.exists():
        sys.exit(f"missing {CACHE_CSV}; run promote_inferred_via_rijks_tgn.py "
                 "first")

    with CACHE_CSV.open(newline="") as f:
        no_coords_rows = [r for r in csv.DictReader(f)
                          if r["status"] == "no_coords"]
    print(f"no_coords rows in cache: {len(no_coords_rows)}")

    conn = sqlite3.connect(str(args.db))
    plans: list[dict] = []
    skips: dict[str, int] = {}
    for r in no_coords_rows:
        vid = r["vocab_id"]
        row = conn.execute(
            "SELECT placetype, is_areal, label_en, label_nl "
            "FROM vocabulary WHERE id = ?", (vid,)).fetchone()
        if row is None:
            skips["vocab_missing"] = skips.get("vocab_missing", 0) + 1
            continue
        pt, areal, en, nl = row
        if areal == 1:
            skips["already_areal"] = skips.get("already_areal", 0) + 1
            continue
        if not pt:
            skips["no_placetype_fail_closed"] = (
                skips.get("no_placetype_fail_closed", 0) + 1)
            continue
        if pt in em.INHERITANCE_ALLOWED_PLACETYPES:
            skips["settlement_anomaly"] = (
                skips.get("settlement_anomaly", 0) + 1)
            continue
        plans.append({
            "vocab_id": vid, "label": en or nl or "∅",
            "placetype": pt, "tgn_id": r["tgn_id"],
        })

    print(f"\nplans: {len(plans)}, skips: {dict(skips)}\n")
    for p in plans:
        print(f"  [WRITE] {p['vocab_id']} ({p['label']})  "
              f"tgn={p['tgn_id']}  placetype={p['placetype']}")

    if args.dry_run:
        print(f"\n[dry-run] {len(plans)} write(s) planned.")
        conn.close()
        return 0

    if not plans:
        print("\nNothing to apply.")
        conn.close()
        return 0

    print(f"\nApplying is_areal=1 to {len(plans)} row(s)...")
    with conn:
        for p in plans:
            conn.execute(
                "UPDATE vocabulary SET is_areal = 1 "
                "WHERE id = ? AND is_areal != 1",
                (p["vocab_id"],),
            )

    print("Verifying...")
    bad = 0
    for p in plans:
        row = conn.execute(
            "SELECT is_areal FROM vocabulary WHERE id = ?",
            (p["vocab_id"],)).fetchone()
        if row is None or row[0] != 1:
            print(f"  [FAIL] {p['vocab_id']}", file=sys.stderr); bad += 1
    print(f"  Verification: {len(plans) - bad} OK, {bad} FAIL")
    conn.close()
    return 0 if bad == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
