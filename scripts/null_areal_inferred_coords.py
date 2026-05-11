"""Strip lat/lon AND coord_method from curated areal places that only ever
carried an *inferred* (non-authority) centroid.

Background: the v0.30 strict 'authority-only' geocoding policy keeps an
'inferred' tier only for rows with a usable provenance breadcrumb. A
manual review of the 64 inferred-AND-areal places found that for most of
them a single point is either meaningless (regions, rivers, seas, valleys,
moors, ...) or actually wrong (islands that resolved to a same-named place
in the wrong country via a World Historical Gazetteer name collision;
neighbourhoods sitting on the England country centroid 53.0,-2.0). The
curator's call: keep fewer-but-correct inferred coords, strip the rest.

Kept (NOT in the curated CSV, so untouched by this script): the 3 Roman/
Florentine piazzas, both Deshima rows (Nagasaki, correct), 3 well-located
neighbourhoods (Bad Neuenahr, Jordaan, Kriegshaber) and 7 islands with
correct coordinates. Everything else in that 64-row set is listed in
data/curated-areal-null-coords.csv and gets nulled here.

What this script writes (for each curated vocab_id still tagged inferred):
  lat                 = NULL
  lon                 = NULL
  coord_method        = NULL
  coord_method_detail = NULL
  is_areal            = 1      (enforced — these are all areal entities)

What it does NOT touch:
  - external_id, vocabulary_external_ids — any authority IDs the
    Rijksmuseum supplied are preserved, so a future authority publication
    can re-geocode the place cleanly on the next backfill run.
  - placetype / placetype_source — independent of coord provenance.

Guards:
  - vocab_ids in data/curated-place-overrides.csv are skipped (a curator
    lock there wins).
  - the UPDATE only fires on rows whose coord_method is still 'inferred',
    so re-running after a harvest that has since promoted a row to an
    authority tier is a no-op for that row, and an already-stripped row
    (coord_method NULL) is also a no-op.

Idempotent — re-running on an already-stripped DB updates 0 rows.

Usage:
    python3 scripts/null_areal_inferred_coords.py --dry-run
    python3 scripts/null_areal_inferred_coords.py
"""
import argparse
import csv
import sqlite3
import sys
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parent.parent
DB_PATH = PROJECT_DIR / "data" / "vocabulary.db"
CSV_PATH = PROJECT_DIR / "data" / "curated-areal-null-coords.csv"
OVERRIDES_CSV = PROJECT_DIR / "data" / "curated-place-overrides.csv"

REQUIRED_COLS = ("vocab_id", "label", "reason")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--csv", type=Path, default=CSV_PATH)
    p.add_argument("--db", type=Path, default=DB_PATH)
    return p.parse_args()


def load_excluded() -> set[str]:
    if not OVERRIDES_CSV.exists():
        return set()
    with OVERRIDES_CSV.open(newline="") as f:
        return {r["vocab_id"] for r in csv.DictReader(f)}


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

    excluded = load_excluded()
    print(f"Loaded {len(rows)} curated areal place(s) from {args.csv.name}")
    print(f"Excluded vocab_ids (from {OVERRIDES_CSV.name}): {len(excluded)}\n")

    conn = sqlite3.connect(str(args.db))

    plans: list[dict] = []
    errors: list[str] = []
    for r in rows:
        vid = r["vocab_id"]
        if vid in excluded:
            print(f"  skip {vid} ({r['label']}): in curated-place-overrides")
            continue
        cur = conn.execute(
            "SELECT type, lat, lon, coord_method, coord_method_detail, is_areal "
            "FROM vocabulary WHERE id = ?", (vid,)).fetchone()
        if cur is None:
            errors.append(f"vocab_id {vid} ({r['label']}): not in vocabulary")
            continue
        vtype, lat, lon, cm, cmd, areal = cur
        if vtype != "place":
            errors.append(f"vocab_id {vid} ({r['label']}): type={vtype!r}, expected 'place'")
            continue
        if cm not in ("inferred", None):
            # Promoted to an authority tier since the CSV was curated — leave it.
            print(f"  skip {vid} ({r['label']}): coord_method={cm!r} (no longer inferred)")
            continue
        already_clean = lat is None and lon is None and cm is None and cmd is None
        plans.append({
            "vocab_id": vid, "label": r["label"],
            "lat": lat, "lon": lon, "cm": cm, "cmd": cmd, "areal": areal,
            "will_change": not (already_clean and areal == 1),
        })

    if errors:
        for e in errors:
            print(f"  ERROR {e}", file=sys.stderr)
        conn.close()
        return 1

    writes = [p for p in plans if p["will_change"]]
    print(f"\n  {len(plans)} curated row(s) present in DB; "
          f"{len(writes)} need a write, {len(plans) - len(writes)} already clean.")
    for p in writes:
        print(f"    {p['vocab_id']:<10} {p['label']:<24} "
              f"coord ({p['lat']}, {p['lon']}) [{p['cm']}/{p['cmd']}] -> NULL, is_areal=1")

    if args.dry_run:
        print(f"\n[dry-run] would update {len(writes)} row(s). "
              "Re-run without --dry-run to commit.")
        conn.close()
        return 0
    if not writes:
        print("\nNothing to do — all curated rows already stripped.")
        conn.close()
        return 0

    print(f"\nStripping {len(writes)} row(s)...")
    with conn:
        for p in writes:
            conn.execute("""
                UPDATE vocabulary
                SET lat = NULL, lon = NULL,
                    coord_method = NULL, coord_method_detail = NULL,
                    is_areal = 1
                WHERE id = ?
                  AND (coord_method = 'inferred' OR coord_method IS NULL)
            """, (p["vocab_id"],))

    print("Verifying...")
    bad = 0
    for p in writes:
        r = conn.execute(
            "SELECT lat, lon, coord_method, coord_method_detail, is_areal "
            "FROM vocabulary WHERE id = ?", (p["vocab_id"],)).fetchone()
        if r is None or r[0] is not None or r[1] is not None \
                or r[2] is not None or r[3] is not None or r[4] != 1:
            print(f"  [FAIL] {p['vocab_id']}: got {r}", file=sys.stderr)
            bad += 1
    print(f"  Verification: {len(writes) - bad} OK, {bad} FAIL")
    conn.close()
    return 0 if bad == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
