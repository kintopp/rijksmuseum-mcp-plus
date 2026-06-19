#!/usr/bin/env python3
"""Apply recovered place rows + depicted-place subject mappings from the curated
CSVs (Tier 4 of #245 / issue #318; the schema is tier-aware so Tier 2 / #316
alias places can be folded in later — see issue #410).

This is the **durable, harvest-surviving** half of the #318 recovery. It runs in
RELEASE.md's "Pre-publish backfills (vocabulary.db only)" chain against the
freshly-harvested DB, **before `strip_non_authority_coords.py`** so the
deterministic coords survive the two-tier geo gate. Unlike the direct-write
`recover_316` precedent (a one-off, now in scripts/legacy/, NOT registered — so
its rows vanish on the next full harvest), this re-applies from version-controlled
CSVs every release.

Idempotent — INSERT OR IGNORE throughout; safe to re-run (0 new rows on a
second pass). NO network, NO dump dependency: the curated CSVs carry the
already-resolved labels/coords/placetype + provenance.

Reads (defaults under data/backfills/):
  recovered-places.csv          — vocab_id, recovery_tier, label_en, label_nl, lat, lon,
                                    coord_method, coord_method_detail, placetype,
                                    placetype_source, broader_id, authority, auth_id, uri,
                                    resolved_at, evidence
  recovered-place-mappings.csv  — object_number, vocab_id, field, source, resolved_at

Writes:
  vocabulary                — place rows + method columns + a fresh vocab_int_id
  vocabulary_external_ids   — authority link per place
  mappings                  — (artwork_id, vocab_rowid, field_id) subject edges
  version_info              — recovered_places_applied_at / _count / _mappings_count

Usage:
  ~/miniconda3/envs/embeddings/bin/python scripts/apply_recovered_places.py --dry-run
  ~/miniconda3/envs/embeddings/bin/python scripts/apply_recovered_places.py
"""
from __future__ import annotations

import argparse
import csv
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DB = REPO_ROOT / "data" / "vocabulary.db"
DEFAULT_PLACES = REPO_ROOT / "data" / "backfills" / "recovered-places.csv"
DEFAULT_MAPPINGS = REPO_ROOT / "data" / "backfills" / "recovered-place-mappings.csv"


def _norm(label: str | None) -> str | None:
    return label.lower().replace(" ", "") if label else None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    ap.add_argument("--db", type=Path, default=DEFAULT_DB)
    ap.add_argument("--places-csv", type=Path, default=DEFAULT_PLACES)
    ap.add_argument("--mappings-csv", type=Path, default=DEFAULT_MAPPINGS)
    ap.add_argument("--dry-run", action="store_true", help="Scan + report; roll back, no writes.")
    args = ap.parse_args()

    if not args.db.exists():
        print(f"ERROR: DB not found: {args.db}", file=sys.stderr)
        return 1
    if not args.places_csv.exists():
        print(f"ERROR: places CSV not found: {args.places_csv}", file=sys.stderr)
        return 1

    conn = sqlite3.connect(args.db)
    conn.execute("PRAGMA foreign_keys = OFF")
    c = conn.cursor()

    existing_ids = {r[0] for r in c.execute("SELECT id FROM vocabulary").fetchall()}
    next_int_id = (c.execute("SELECT COALESCE(MAX(vocab_int_id), 0) FROM vocabulary").fetchone()[0]) + 1
    print(f"Vocab rows: {len(existing_ids):,}  |  next vocab_int_id: {next_int_id}")

    # ---- 1. place rows ----
    counters = {"new_place": 0, "already_present": 0, "vei": 0}
    with args.places_csv.open(newline="") as f:
        for row in csv.DictReader(f):
            vid = row["vocab_id"]
            lat = float(row["lat"]) if row["lat"] else None
            lon = float(row["lon"]) if row["lon"] else None
            if vid not in existing_ids:
                c.execute(
                    "INSERT OR IGNORE INTO vocabulary "
                    "(id, type, label_en, label_nl, label_en_norm, label_nl_norm, "
                    " external_id, broader_id, notation, lat, lon, "
                    " coord_method, coord_method_detail, placetype, placetype_source) "
                    "VALUES (?, 'place', ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)",
                    (
                        vid, row["label_en"] or None, row["label_nl"] or None,
                        _norm(row["label_en"]), _norm(row["label_nl"]),
                        row["uri"] or None, row["broader_id"] or None,
                        lat, lon,
                        row["coord_method"] or None, row["coord_method_detail"] or None,
                        row["placetype"] or None, row["placetype_source"] or None,
                    ),
                )
                cur = c.execute(
                    "UPDATE vocabulary SET vocab_int_id = ? WHERE id = ? AND vocab_int_id IS NULL",
                    (next_int_id, vid),
                )
                if cur.rowcount:
                    next_int_id += 1
                existing_ids.add(vid)
                counters["new_place"] += 1
            else:
                counters["already_present"] += 1
            if row["authority"] and row["auth_id"]:
                cur = c.execute(
                    "INSERT OR IGNORE INTO vocabulary_external_ids (vocab_id, authority, id, uri) "
                    "VALUES (?, ?, ?, ?)",
                    (vid, row["authority"], row["auth_id"], row["uri"]),
                )
                counters["vei"] += cur.rowcount

    # ---- 2. subject mappings ----
    field_ids = {name: fid for name, fid in c.execute("SELECT name, id FROM field_lookup").fetchall()}
    art_id = {obj: aid for obj, aid in c.execute("SELECT object_number, art_id FROM artworks").fetchall()}
    vint = {vid: vi for vid, vi in c.execute(
        "SELECT id, vocab_int_id FROM vocabulary WHERE type='place' AND vocab_int_id IS NOT NULL").fetchall()}
    m_counts = {"new": 0, "exists_or_dup": 0, "skip_no_artwork": 0, "skip_no_vocab": 0, "skip_no_field": 0}
    if args.mappings_csv.exists():
        with args.mappings_csv.open(newline="") as f:
            for row in csv.DictReader(f):
                aid = art_id.get(row["object_number"])
                vi = vint.get(row["vocab_id"])
                fid = field_ids.get(row["field"])
                if aid is None:
                    m_counts["skip_no_artwork"] += 1; continue
                if vi is None:
                    m_counts["skip_no_vocab"] += 1; continue
                if fid is None:
                    m_counts["skip_no_field"] += 1; continue
                cur = c.execute(
                    "INSERT OR IGNORE INTO mappings (artwork_id, vocab_rowid, field_id) VALUES (?, ?, ?)",
                    (aid, vi, fid),
                )
                if cur.rowcount:
                    m_counts["new"] += 1
                else:
                    m_counts["exists_or_dup"] += 1

    print("\nPlace rows:")
    for k in ("new_place", "already_present", "vei"):
        print(f"  {k:>16}: {counters[k]:,}")
    print("Subject mappings:")
    for k in ("new", "exists_or_dup", "skip_no_artwork", "skip_no_vocab", "skip_no_field"):
        print(f"  {k:>16}: {m_counts[k]:,}")

    if args.dry_run:
        conn.rollback()
        conn.close()
        print("\n[DRY-RUN] rolled back — no writes.")
        return 0

    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    for k, v in (("recovered_places_applied_at", now),
                 ("recovered_places_count", str(counters["new_place"])),
                 ("recovered_place_mappings_count", str(m_counts["new"]))):
        c.execute("INSERT OR REPLACE INTO version_info (key, value) VALUES (?, ?)", (k, v))
    conn.commit()
    conn.close()
    print(f"\nApplied: {counters['new_place']} new places, {m_counts['new']} new mappings. "
          f"version_info stamped ({now}).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
