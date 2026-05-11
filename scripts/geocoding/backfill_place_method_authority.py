#!/usr/bin/env python3
"""Tactical v0.24 backfill: tag the audit-trail columns for place rows whose
``broader_id`` or ``external_id`` came from the baseline harvest.

Why: v0.24 introduced ``broader_method`` / ``external_id_method`` columns in
the audit-trail schema, but the harvest/enrichment pipeline only populates
them for rows touched by the #254 side-pass. Baseline rows with authority-
sourced ``broader_id`` or ``external_id`` are left with NULL (or empty-string)
method tags — 30,152 and 2,086 rows respectively.

Every ``broader_id`` in the DB today comes from authority-record hierarchy
edges (TGN ``tgn:broaderPartitive``, Wikidata P131/P276) embedded at harvest
time. Every untagged ``external_id`` is an AAT/GeoNames URI from the source
record. Tagging both as ``authority`` (coarse tier only; detail left NULL)
accurately reflects their provenance and closes the audit gap for v0.24.

A proper at-harvest population is v0.25 scope (see issue #268).

Usage:
    python scripts/backfill_place_method_authority.py              # dry-run
    python scripts/backfill_place_method_authority.py --apply      # execute
    python scripts/backfill_place_method_authority.py --db PATH    # override DB

Idempotent. Safe to re-run (WHERE guard on NULL/empty).
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib import enrichment_methods as em


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--db", type=Path, default=Path("data/vocabulary.db"))
    ap.add_argument("--apply", action="store_true", help="execute (default: dry-run)")
    args = ap.parse_args()

    if not args.db.exists():
        print(f"DB not found: {args.db}", file=sys.stderr)
        return 1

    conn = sqlite3.connect(args.db)

    # ── Pre-count the gaps ───────────────────────────────────────────
    broader_gap = conn.execute("""
        SELECT COUNT(*) FROM vocabulary
        WHERE type='place' AND broader_id IS NOT NULL
          AND (broader_method IS NULL OR broader_method = '')
    """).fetchone()[0]

    ext_gap = conn.execute("""
        SELECT COUNT(*) FROM vocabulary
        WHERE type='place' AND external_id IS NOT NULL
          AND (external_id_method IS NULL OR external_id_method = '')
    """).fetchone()[0]

    print(f"Rows to tag as '{em.AUTHORITY}':")
    print(f"  broader_method gap:     {broader_gap:,}")
    print(f"  external_id_method gap: {ext_gap:,}")

    if not args.apply:
        print("\n(dry-run — pass --apply to execute)")
        return 0

    # ── Apply ───────────────────────────────────────────────────────
    c1 = conn.execute(f"""
        UPDATE vocabulary SET broader_method = '{em.AUTHORITY}'
        WHERE type='place' AND broader_id IS NOT NULL
          AND (broader_method IS NULL OR broader_method = '')
    """)
    c2 = conn.execute(f"""
        UPDATE vocabulary SET external_id_method = '{em.AUTHORITY}'
        WHERE type='place' AND external_id IS NOT NULL
          AND (external_id_method IS NULL OR external_id_method = '')
    """)
    conn.commit()

    print(f"\nApplied:")
    print(f"  broader_method updates:     {c1.rowcount:,}")
    print(f"  external_id_method updates: {c2.rowcount:,}")

    # ── Post-verify ─────────────────────────────────────────────────
    broader_after = conn.execute("""
        SELECT COUNT(*) FROM vocabulary
        WHERE type='place' AND broader_id IS NOT NULL
          AND (broader_method IS NULL OR broader_method = '')
    """).fetchone()[0]
    ext_after = conn.execute("""
        SELECT COUNT(*) FROM vocabulary
        WHERE type='place' AND external_id IS NOT NULL
          AND (external_id_method IS NULL OR external_id_method = '')
    """).fetchone()[0]

    print(f"\nAfter:")
    print(f"  broader_method gap:     {broader_after:,}")
    print(f"  external_id_method gap: {ext_after:,}")

    if broader_after == 0 and ext_after == 0:
        print("\nSUCCESS — all place rows with hierarchy/external_id now have method tags.")
        return 0
    else:
        print("\nFAIL — gaps remain after UPDATE.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
