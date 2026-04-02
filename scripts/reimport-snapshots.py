#!/usr/bin/env python3
"""Reimport supplementary data snapshots into a freshly-harvested vocabulary.db.

These snapshots capture data produced by external scripts (enrichment, backfill,
geocoding) that the harvest script does not reproduce on its own.

Usage:
    python3 scripts/reimport-snapshots.py                    # all snapshots
    python3 scripts/reimport-snapshots.py --only actors      # just actor enrichment
    python3 scripts/reimport-snapshots.py --only dates       # just date backfill
    python3 scripts/reimport-snapshots.py --only broader     # just broader_id links
    python3 scripts/reimport-snapshots.py --only geo         # just geocoded coordinates
    python3 scripts/reimport-snapshots.py --dry-run          # preview without writing

Snapshot files (all in data/backfills/):
    actors.csv       — birth_year, death_year, gender, bio, wikidata_id
    broader-ids.csv  — broader_id links (harvest-native + enrichment)
    dates.csv        — date_earliest, date_latest for artworks
    geocoded-places.csv — lat, lon, external_id for places
"""

import argparse
import csv
import sqlite3
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
BACKFILLS_DIR = DATA_DIR / "backfills"
DB_PATH = DATA_DIR / "vocabulary.db"


def ensure_columns(conn, table, columns):
    """Add columns if they don't exist yet."""
    existing = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
    for col, coltype in columns:
        if col not in existing:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {coltype}")
            print(f"  Added column {table}.{col}")


def reimport_actors(conn, dry_run=False):
    """Reimport actor enrichment: birth/death years, gender, bio, wikidata_id."""
    csv_path = BACKFILLS_DIR / "actors.csv"
    if not csv_path.exists():
        print(f"  SKIP: {csv_path} not found")
        return

    ensure_columns(conn, "vocabulary", [
        ("birth_year", "INTEGER"),
        ("death_year", "INTEGER"),
        ("gender", "TEXT"),
        ("bio", "TEXT"),
        ("wikidata_id", "TEXT"),
    ])

    with open(csv_path, "r", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))

    print(f"  Read {len(rows):,} actor records from {csv_path.name}")
    if dry_run:
        return

    updated = 0
    for row in rows:
        vid = row["id"]
        sets = []
        vals = []
        for col in ("birth_year", "death_year", "gender", "bio", "wikidata_id"):
            val = row.get(col, "").strip()
            if val:
                sets.append(f"{col} = COALESCE({col}, ?)")
                vals.append(int(val) if col in ("birth_year", "death_year") else val)
        if sets:
            vals.append(vid)
            cur = conn.execute(
                f"UPDATE vocabulary SET {', '.join(sets)} WHERE id = ?", vals
            )
            if cur.rowcount:
                updated += 1

    conn.commit()
    print(f"  Updated {updated:,} vocabulary records")


def reimport_broader(conn, dry_run=False):
    """Reimport broader_id links."""
    csv_path = BACKFILLS_DIR / "broader-ids.csv"
    if not csv_path.exists():
        print(f"  SKIP: {csv_path} not found")
        return

    with open(csv_path, "r", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))

    print(f"  Read {len(rows):,} broader_id links from {csv_path.name}")
    if dry_run:
        return

    updated = 0
    for row in rows:
        cur = conn.execute(
            "UPDATE vocabulary SET broader_id = COALESCE(broader_id, ?) WHERE id = ?",
            (row["broader_id"], row["id"]),
        )
        if cur.rowcount:
            updated += 1

    conn.commit()
    print(f"  Updated {updated:,} broader_id links")


def reimport_dates(conn, dry_run=False):
    """Reimport date backfill: date_earliest, date_latest."""
    csv_path = BACKFILLS_DIR / "dates.csv"
    if not csv_path.exists():
        print(f"  SKIP: {csv_path} not found")
        return

    with open(csv_path, "r", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))

    print(f"  Read {len(rows):,} date records from {csv_path.name}")
    if dry_run:
        return

    updated = 0
    for row in rows:
        vals = []
        sets = []
        for col in ("date_earliest", "date_latest"):
            val = row.get(col, "").strip()
            if val:
                sets.append(f"{col} = COALESCE({col}, ?)")
                vals.append(int(val))
        if sets:
            vals.append(row["object_number"])
            cur = conn.execute(
                f"UPDATE artworks SET {', '.join(sets)} WHERE object_number = ?", vals
            )
            if cur.rowcount:
                updated += 1

    conn.commit()
    print(f"  Updated {updated:,} artwork date records")


def reimport_geo(conn, dry_run=False):
    """Reimport geocoded place coordinates."""
    csv_path = BACKFILLS_DIR / "geocoded-places.csv"
    if not csv_path.exists():
        print(f"  SKIP: {csv_path} not found")
        return

    with open(csv_path, "r", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))

    print(f"  Read {len(rows):,} geocoded places from {csv_path.name}")
    if dry_run:
        return

    updated_coords = 0
    updated_ext = 0
    for row in rows:
        lat = row.get("lat", "").strip()
        lon = row.get("lon", "").strip()
        ext_id = row.get("external_id", "").strip()
        vid = row["id"]

        if lat and lon:
            cur = conn.execute(
                "UPDATE vocabulary SET lat = COALESCE(lat, ?), lon = COALESCE(lon, ?) WHERE id = ? AND type = 'place'",
                (float(lat), float(lon), vid),
            )
            if cur.rowcount:
                updated_coords += 1

        if ext_id:
            cur = conn.execute(
                "UPDATE vocabulary SET external_id = COALESCE(external_id, ?) WHERE id = ?",
                (ext_id, vid),
            )
            if cur.rowcount:
                updated_ext += 1

    conn.commit()
    print(f"  Updated {updated_coords:,} coordinates, {updated_ext:,} external_ids")


STEPS = {
    "actors": ("Actor enrichment", reimport_actors),
    "broader": ("Broader_id links", reimport_broader),
    "geo": ("Geocoded coordinates", reimport_geo),
    "dates": ("Date backfill", reimport_dates),
}


def main():
    parser = argparse.ArgumentParser(description="Reimport supplementary data snapshots")
    parser.add_argument("--only", choices=list(STEPS.keys()), help="Run only one step")
    parser.add_argument("--dry-run", action="store_true", help="Preview without writing")
    parser.add_argument("--db", type=str, default=str(DB_PATH), help="Path to vocabulary.db")
    args = parser.parse_args()

    db_path = Path(args.db)
    if not db_path.exists():
        print(f"ERROR: {db_path} not found")
        return

    conn = sqlite3.connect(str(db_path))
    conn.execute("PRAGMA journal_mode=WAL")

    steps = {args.only: STEPS[args.only]} if args.only else STEPS

    for key, (label, fn) in steps.items():
        print(f"\n── {label} ──")
        fn(conn, dry_run=args.dry_run)

    conn.close()
    print("\nDone.")


if __name__ == "__main__":
    main()
