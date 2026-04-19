#!/usr/bin/env python3
"""Apply ``scripts/areal_overrides.tsv`` to the DB (manual-tier #254 writes).

Per the plan's priority order:
  manual (this script)  >  TGN  >  Wikidata  >  label_heuristic  >  NULL

Idempotent. Safe to re-run. Only writes to rows where the current
``placetype_source`` is NULL OR 'manual' — TGN/Wikidata-sourced
placetype_source is shielded. Mismatches (TGN said is_areal=0 but
the TSV says 1) are logged but NOT overwritten — the orchestrator
flags them for follow-up rather than letting a manual override
silently clobber an authority classification.

Typical run (inside the v0.24 orchestrator post-schema-migration):
    python3 scripts/apply_areal_overrides.py \\
        --db data/vocabulary.db \\
        --overrides scripts/areal_overrides.tsv
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path


def load_overrides(path: Path) -> list[dict]:
    """Parse the TSV. Ignore comment lines (#-prefixed) and blanks."""
    rows: list[dict] = []
    for line in path.read_text().splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) < 2:
            print(f"  [WARN] bad TSV row: {line!r}", file=sys.stderr)
            continue
        vocab_id = parts[0].strip()
        label    = parts[1].strip() if len(parts) > 1 else ""
        category = parts[2].strip() if len(parts) > 2 else ""
        reason   = parts[3].strip() if len(parts) > 3 else ""
        rows.append({
            "vocab_id": vocab_id,
            "label":    label,
            "category": category,
            "reason":   reason,
        })
    return rows


def apply(conn: sqlite3.Connection, overrides: list[dict],
          dry_run: bool = False) -> dict:
    cur = conn.cursor()
    stats = {
        "total":          len(overrides),
        "missing":        0,  # vocab_id not in DB
        "authority_held": 0,  # TGN/Wikidata already set — we don't overwrite
        "updated":        0,
        "already_manual": 0,
        "conflicts":      [],  # list of (vocab_id, label, authority_value)
    }

    for row in overrides:
        vid = row["vocab_id"]
        existing = cur.execute(
            "SELECT type, placetype_source, is_areal "
            "FROM vocabulary WHERE id = ?",
            (vid,),
        ).fetchone()
        if not existing:
            print(f"  [MISS] {vid} '{row['label']}' — not in vocabulary",
                  file=sys.stderr)
            stats["missing"] += 1
            continue
        # Rows use positional tuple access below; works whether or not
        # conn.row_factory is sqlite3.Row.
        if isinstance(existing, sqlite3.Row):
            row_type   = existing["type"]
            row_source = existing["placetype_source"]
            row_areal  = existing["is_areal"]
        else:
            row_type, row_source, row_areal = existing

        if row_type != "place":
            print(f"  [SKIP] {vid} '{row['label']}' — type={row_type!r}, not place",
                  file=sys.stderr)
            continue

        # Authority-held: TGN / Wikidata / label_heuristic wrote a value;
        # don't overwrite. Log if they disagree with the manual tag.
        if row_source in ("tgn", "wikidata", "label_heuristic"):
            if row_areal != 1:
                stats["conflicts"].append({
                    "vocab_id":         vid,
                    "label":            row["label"],
                    "authority_source": row_source,
                    "authority_areal":  row_areal,
                })
                print(f"  [CONFLICT] {vid} '{row['label']}' — "
                      f"{row_source} says is_areal={row_areal}, manual says 1 "
                      f"(not overwritten)", file=sys.stderr)
            stats["authority_held"] += 1
            continue

        if row_source == "manual" and row_areal == 1:
            stats["already_manual"] += 1
            continue

        if not dry_run:
            cur.execute(
                "UPDATE vocabulary SET is_areal = 1, placetype_source = 'manual', "
                "placetype = NULL WHERE id = ?",
                (vid,),
            )
        stats["updated"] += 1

    if not dry_run:
        conn.commit()
    return stats


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--db", type=Path, default=Path("data/vocabulary.db"))
    ap.add_argument("--overrides", type=Path,
                    default=Path(__file__).resolve().parent / "areal_overrides.tsv")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not args.db.exists():
        print(f"DB not found: {args.db}", file=sys.stderr)
        return 1
    if not args.overrides.exists():
        print(f"Overrides TSV not found: {args.overrides}", file=sys.stderr)
        return 1

    overrides = load_overrides(args.overrides)
    print(f"Loaded {len(overrides)} overrides from {args.overrides}",
          file=sys.stderr)

    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row
    # Defensive: ensure the column exists even if this script runs before
    # harvest-placetypes.py has set up the schema.
    cols = {r[1] for r in conn.execute("PRAGMA table_info(vocabulary)").fetchall()}
    for name, typ in (("placetype", "TEXT"), ("placetype_source", "TEXT"),
                      ("is_areal", "INTEGER")):
        if name not in cols:
            conn.execute(f"ALTER TABLE vocabulary ADD COLUMN {name} {typ}")
    conn.commit()

    stats = apply(conn, overrides, dry_run=args.dry_run)
    conn.close()

    print("\nSummary:", file=sys.stderr)
    print(f"  total overrides:      {stats['total']}", file=sys.stderr)
    print(f"  updated (→ manual=1): {stats['updated']}", file=sys.stderr)
    print(f"  already manual:       {stats['already_manual']}", file=sys.stderr)
    print(f"  authority held:       {stats['authority_held']}", file=sys.stderr)
    print(f"  missing from DB:      {stats['missing']}", file=sys.stderr)
    print(f"  conflicts:            {len(stats['conflicts'])}", file=sys.stderr)
    if stats["conflicts"]:
        print("\nConflicts (authority says non-areal, manual says areal):",
              file=sys.stderr)
        for c in stats["conflicts"][:10]:
            print(f"  {c['vocab_id']} {c['label']!r}: "
                  f"{c['authority_source']} is_areal={c['authority_areal']}",
                  file=sys.stderr)
        if len(stats["conflicts"]) > 10:
            print(f"  ... and {len(stats['conflicts']) - 10} more", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
