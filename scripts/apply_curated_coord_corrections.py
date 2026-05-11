"""Apply curated coord corrections from data/backfills/curated-coord-corrections.csv.

Use case: a row was promoted to a known authority tier (e.g. via
promote_snapshot_backfill_to_authority.py) but the lat/lon currently in
the DB doesn't match what that authority publishes. This script writes
the authority's coord without changing the tier label or detail (which
were set correctly by upstream promotion scripts).

Differs from apply_curated_place_overrides.py: that script locks
coord_method='manual' for *curator-decided exceptions* (e.g. choosing
the reconciled TGN over Rijks's TGN). This script writes
*authority-aligned* coords without locking — the row was already
correctly tagged as deterministic/<authority>, just with the wrong coord.

Idempotent: re-running on already-corrected rows is a no-op.

Usage:
    python3 scripts/apply_curated_coord_corrections.py --dry-run
    python3 scripts/apply_curated_coord_corrections.py
"""
import argparse
import csv
import sqlite3
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent
sys.path.insert(0, str(SCRIPT_DIR))
import enrichment_methods as em  # noqa: E402

CSV_PATH = PROJECT_DIR / "data" / "backfills" / "curated-coord-corrections.csv"
DB_PATH = PROJECT_DIR / "data" / "vocabulary.db"

REQUIRED_COLS = ("vocab_id", "label", "source_authority", "authority_uri",
                 "lat", "lon", "reviewed_by", "reviewed_at", "evidence")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--csv", type=Path, default=CSV_PATH)
    p.add_argument("--db", type=Path, default=DB_PATH)
    return p.parse_args()


def fetch_state(conn, vid):
    r = conn.execute(
        "SELECT lat, lon, coord_method, coord_method_detail "
        "FROM vocabulary WHERE id = ?", (vid,)).fetchone()
    if r is None:
        return None
    return {"lat": r[0], "lon": r[1], "coord_method": r[2],
            "coord_method_detail": r[3]}


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

    print(f"Loaded {len(rows)} coord correction(s) from {args.csv.name}\n")
    conn = sqlite3.connect(str(args.db))

    plans: list[dict] = []
    errors: list[str] = []
    for r in rows:
        vid = r["vocab_id"]
        cur = fetch_state(conn, vid)
        if cur is None:
            errors.append(f"vocab_id {vid}: not in vocabulary")
            continue
        if cur["coord_method"] == em.MANUAL:
            errors.append(f"vocab_id {vid}: coord_method='manual' — refusing "
                          "to overwrite a manual lock. Use the curated-place-"
                          "overrides flow instead if intentional.")
            continue
        try:
            target_lat = float(r["lat"])
            target_lon = float(r["lon"])
        except ValueError:
            errors.append(f"vocab_id {vid}: bad lat/lon")
            continue
        will_change = (cur["lat"] != target_lat or cur["lon"] != target_lon)
        plans.append({
            "vocab_id": vid, "label": r["label"], "src": r["source_authority"],
            "cur_lat": cur["lat"], "cur_lon": cur["lon"],
            "target_lat": target_lat, "target_lon": target_lon,
            "will_change": will_change,
        })

    if errors:
        for e in errors:
            print(f"  ERROR {e}", file=sys.stderr)
        return 1

    print(f"  {'vocab_id':<10} {'label':<20} {'source':<14} change")
    for p in plans:
        marker = "✓ no-op" if not p["will_change"] else " WILL WRITE"
        print(f"  {p['vocab_id']:<10} {p['label']:<20} {p['src']:<14} {marker}")
        if p["will_change"]:
            print(f"      lat: {p['cur_lat']!r:<22} -> {p['target_lat']!r}")
            print(f"      lon: {p['cur_lon']!r:<22} -> {p['target_lon']!r}")

    writes = [p for p in plans if p["will_change"]]
    if args.dry_run:
        print(f"\n[dry-run] {len(writes)} write(s) planned. "
              "Re-run without --dry-run to commit.")
        conn.close()
        return 0

    if not writes:
        print("\nNothing to do — all rows already correct.")
        conn.close()
        return 0

    print(f"\nApplying {len(writes)} coord correction(s)...")
    with conn:
        for p in writes:
            conn.execute(
                "UPDATE vocabulary SET lat = ?, lon = ? WHERE id = ?",
                (p["target_lat"], p["target_lon"], p["vocab_id"]),
            )

    print("Verifying...")
    bad = 0
    for p in writes:
        cur = fetch_state(conn, p["vocab_id"])
        if cur is None or cur["lat"] != p["target_lat"] \
                or cur["lon"] != p["target_lon"]:
            print(f"  [FAIL] {p['vocab_id']}", file=sys.stderr)
            bad += 1
    print(f"  Verification: {len(writes) - bad} OK, {bad} FAIL")
    conn.close()
    return 0 if bad == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
