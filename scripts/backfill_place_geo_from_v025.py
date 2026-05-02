"""Backfill Stage-5.5 place columns on the v0.26 vocabulary DB from the v0.25
snapshot. Use when promoting v0.26 to v0.27-RC without re-running the full
geocoding orchestrator (e.g. Getty TGN outage).

Backfilled columns (only where v0.26 row IS NULL and v0.25 row has a value):
  - lat, lon
  - placetype
  - placetype_source
  - is_areal
  - coord_method     (preserves v0.25's 'authority' / 'derived' / 'manual')

Always stamps coord_method_detail = 'v0.25-snapshot-backfill' on touched rows
so a future fresh harvest's Stage 5.5 can recognise and override them.

NEVER overwrites: external_id (v0.26's harvest is richer), broader_id
(identical), label_en/label_nl, type.

Match key: vocabulary.id (TEXT). Rows in v0.26 not in v0.25 (≈22 new places)
are left untouched — they need a real Stage 5.5 pass when Getty returns.

Usage:
  uv run python scripts/backfill_place_geo_from_v025.py --dry-run
  uv run python scripts/backfill_place_geo_from_v025.py --apply
"""
from __future__ import annotations

import argparse
import gzip
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
V026_DB = PROJECT_ROOT / "data" / "vocabulary.db"
V025_SNAPSHOT_GZ = PROJECT_ROOT / "data" / "vocabulary-v0.25-snapshot.db.gz"

PROVENANCE_TAG = "v0.25-snapshot-backfill"


def decompress_v025(target_dir: Path) -> Path:
    target = target_dir / "v025.db"
    if target.exists():
        return target
    print(f"Decompressing {V025_SNAPSHOT_GZ.name} → {target} ...", flush=True)
    with gzip.open(V025_SNAPSHOT_GZ, "rb") as src, target.open("wb") as dst:
        shutil.copyfileobj(src, dst)
    print(f"  done ({target.stat().st_size:,} bytes)")
    return target


def coverage(conn: sqlite3.Connection, label: str) -> dict[str, int]:
    row = conn.execute("""
        SELECT
          COUNT(*),
          SUM(CASE WHEN lat IS NOT NULL THEN 1 ELSE 0 END),
          SUM(CASE WHEN placetype IS NOT NULL THEN 1 ELSE 0 END),
          SUM(CASE WHEN is_areal IS NOT NULL THEN 1 ELSE 0 END),
          SUM(CASE WHEN coord_method IS NOT NULL THEN 1 ELSE 0 END)
        FROM vocabulary WHERE type='place'
    """).fetchone()
    out = {"total": row[0], "lat": row[1], "placetype": row[2], "is_areal": row[3], "coord_method": row[4]}
    print(f"  [{label}] places={out['total']:,} lat={out['lat']:,} placetype={out['placetype']:,} is_areal={out['is_areal']:,} coord_method={out['coord_method']:,}")
    return out


def fetch_v025_places(v025_path: Path) -> dict[str, dict]:
    """Map vocab_id → row of place fields from v0.25 (only non-NULL geo rows)."""
    conn = sqlite3.connect(f"file:{v025_path}?mode=ro", uri=True)
    rows = conn.execute("""
        SELECT id, lat, lon, placetype, placetype_source, is_areal, coord_method, coord_method_detail
        FROM vocabulary
        WHERE type='place'
          AND (lat IS NOT NULL OR placetype IS NOT NULL OR is_areal IS NOT NULL)
    """).fetchall()
    conn.close()
    out = {}
    for vocab_id, lat, lon, placetype, placetype_source, is_areal, coord_method, coord_method_detail in rows:
        out[vocab_id] = {
            "lat": lat, "lon": lon,
            "placetype": placetype, "placetype_source": placetype_source,
            "is_areal": is_areal, "coord_method": coord_method,
            "coord_method_detail": coord_method_detail,
        }
    return out


def apply_v025_geo_backfill(
    target_conn: sqlite3.Connection,
    v025_path: Path,
    dry_run: bool = False,
    log_fn=print,
) -> dict:
    """Idempotent core: apply v0.25-snapshot geo backfill to an open target connection.

    Reusable from both the standalone CLI and from a fresh-harvest enrichment phase.
    Returns a dict of counts: {rows_touched, not_in_snapshot, per_column: {...}, before, after}.
    """
    log_fn("Loading v0.25 places with geo data ...")
    v025 = fetch_v025_places(v025_path)
    log_fn(f"  {len(v025):,} v0.25 places carry at least one populated geo field")

    before = coverage(target_conn, "before")

    rows_target = target_conn.execute("""
        SELECT id, lat, lon, placetype, placetype_source, is_areal, coord_method
        FROM vocabulary WHERE type='place'
    """).fetchall()

    patches = []
    not_in_v025 = 0
    for vocab_id, lat26, lon26, pt26, pts26, ia26, cm26 in rows_target:
        src = v025.get(vocab_id)
        if not src:
            not_in_v025 += 1
            continue
        updates: dict = {}
        if lat26 is None and lon26 is None and src["lat"] is not None and src["lon"] is not None:
            updates["lat"] = src["lat"]
            updates["lon"] = src["lon"]
        if pt26 is None and src["placetype"] is not None:
            updates["placetype"] = src["placetype"]
        if pts26 is None and src["placetype_source"] is not None:
            updates["placetype_source"] = src["placetype_source"]
        if ia26 is None and src["is_areal"] is not None:
            updates["is_areal"] = src["is_areal"]
        if cm26 is None and src["coord_method"] is not None:
            updates["coord_method"] = src["coord_method"]
        if updates:
            # Composite provenance: keeps v0.25's substantive mechanism (e.g.
            # 'wikidata_p131', 'whg_reconciliation') AND flags the backfill source
            # so a future Stage-5.5 run can recognise these rows.
            src_detail = src["coord_method_detail"]
            updates["coord_method_detail"] = (
                f"{PROVENANCE_TAG}:{src_detail}" if src_detail else PROVENANCE_TAG
            )
            patches.append((vocab_id, updates))

    per_col = {"lat/lon": 0, "placetype": 0, "placetype_source": 0, "is_areal": 0, "coord_method": 0}
    for _, updates in patches:
        if "lat" in updates: per_col["lat/lon"] += 1
        if "placetype" in updates: per_col["placetype"] += 1
        if "placetype_source" in updates: per_col["placetype_source"] += 1
        if "is_areal" in updates: per_col["is_areal"] += 1
        if "coord_method" in updates: per_col["coord_method"] += 1

    log_fn(f"\nPatch summary:")
    log_fn(f"  target places not present in v0.25:    {not_in_v025:,}")
    log_fn(f"  rows touched (≥1 column to backfill): {len(patches):,}")
    for col, n in per_col.items():
        log_fn(f"    {col:20s} {n:>6,}")

    after = before
    if patches and not dry_run:
        log_fn("\nApplying patches ...")
        cur = target_conn.cursor()
        for vocab_id, updates in patches:
            cols = list(updates.keys())
            set_clause = ", ".join(f"{c}=?" for c in cols)
            params = [updates[c] for c in cols] + [vocab_id]
            cur.execute(f"UPDATE vocabulary SET {set_clause} WHERE id=?", params)
        target_conn.commit()
        log_fn(f"  applied {len(patches):,} UPDATEs")
        after = coverage(target_conn, "after")
        log_fn("\nCoverage uplift:")
        for k in ("lat", "placetype", "is_areal", "coord_method"):
            d = after[k] - before[k]
            log_fn(f"  {k:15s} {before[k]:>6,} → {after[k]:>6,}  (+{d:,})")

    return {
        "rows_touched": len(patches),
        "not_in_snapshot": not_in_v025,
        "per_column": per_col,
        "before": before,
        "after": after,
    }


def backfill(apply: bool) -> int:
    if not V026_DB.exists():
        print(f"ERROR: {V026_DB} not found", file=sys.stderr)
        return 1
    if not V025_SNAPSHOT_GZ.exists():
        print(f"ERROR: {V025_SNAPSHOT_GZ} not found", file=sys.stderr)
        return 1

    with tempfile.TemporaryDirectory() as tmpdir:
        v025_path = decompress_v025(Path(tmpdir))
        v026 = sqlite3.connect(V026_DB)
        result = apply_v025_geo_backfill(v026, v025_path, dry_run=not apply)
        v026.close()

        if not apply and result["rows_touched"] > 0:
            print("\n[DRY RUN] No changes written. Re-run with --apply to commit.")
        return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--dry-run", action="store_true")
    g.add_argument("--apply", action="store_true")
    args = ap.parse_args()
    return backfill(apply=args.apply)


if __name__ == "__main__":
    sys.exit(main())
