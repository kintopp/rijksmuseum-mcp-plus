"""#276 backfill: re-fetch Linked Art payloads for existing vocab entities
and INSERT-OR-IGNORE every authority ID found in ``equivalent[]`` into
``vocabulary_external_ids``.

The bug fix in ``harvest-vocabulary-db.py`` (resolve_uri + Phase 2 callers)
covers all *future* harvests. This script applies the same fix retroactively
to an existing v0.24/v0.25-cold-rerun DB without re-running the full Phase 2.

The script touches *only* ``vocabulary_external_ids`` — never lat/lon, never
``vocabulary.external_id``, never ``coord_method``. INSERT-OR-IGNORE makes
it safe to re-run.

CLI:
    ~/miniconda3/envs/embeddings/bin/python scripts/backfill_vei_from_la.py \
      --db data/vocabulary.db --type place --threads 8

    # Dry run (no DB writes; reports per-row delta):
    ... --dry-run

    # Subset for testing:
    ... --limit 200
"""
from __future__ import annotations

import argparse
import importlib.util
import sqlite3
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
HARVEST_PATH = Path(__file__).resolve().parent.parent / "harvest-vocabulary-db.py"


def _load_harvest():
    spec = importlib.util.spec_from_file_location("harvest_vocab_db", HARVEST_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--db", default="data/vocabulary.db", type=Path)
    p.add_argument("--type", default="place",
                   choices=["place", "person", "organisation", "classification", "all"],
                   help="Vocab type to backfill (default: place)")
    p.add_argument("--threads", type=int, default=8)
    p.add_argument("--limit", type=int, default=None,
                   help="Process only the first N entities (for testing)")
    p.add_argument("--dry-run", action="store_true",
                   help="Don't write to DB; print per-row deltas")
    p.add_argument("--commit-every", type=int, default=200,
                   help="Commit every N entities (default 200)")
    args = p.parse_args()

    h = _load_harvest()
    conn = sqlite3.connect(str(args.db))

    if args.type == "all":
        rows = conn.execute(
            "SELECT id FROM vocabulary "
            "WHERE id NOT LIKE 'rkd_%' AND id NOT LIKE 'oai:%'"
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT id FROM vocabulary WHERE type = ?",
            (args.type,),
        ).fetchall()

    entity_ids = [r[0] for r in rows]
    if args.limit:
        entity_ids = entity_ids[: args.limit]

    print(f"Backfilling {len(entity_ids):,} {args.type} entities "
          f"({args.threads} threads, dry_run={args.dry_run})")

    pre_total = conn.execute(
        "SELECT COUNT(*) FROM vocabulary_external_ids"
    ).fetchone()[0]

    inserted = 0
    resolved_ok = 0
    failed = 0
    failures: dict[str, int] = {}
    t0 = time.time()
    pending: list[tuple[str, str, str, str]] = []

    def _flush() -> int:
        nonlocal pending
        if not pending or args.dry_run:
            count = len(pending)
            pending = []
            return count
        cur = conn.executemany(h.VEI_INSERT_SQL, pending)
        n = cur.rowcount if cur.rowcount and cur.rowcount > 0 else 0
        conn.commit()
        pending = []
        return n

    with ThreadPoolExecutor(max_workers=args.threads) as pool:
        futures = {pool.submit(h.resolve_uri, eid): eid for eid in entity_ids}
        for i, future in enumerate(as_completed(futures), 1):
            eid = futures[future]
            try:
                result, reason = future.result()
            except Exception as e:
                failed += 1
                failures[type(e).__name__] = failures.get(type(e).__name__, 0) + 1
                continue

            if result is None:
                failed += 1
                failures[reason or "unknown"] = failures.get(reason or "unknown", 0) + 1
                continue

            resolved_ok += 1
            ext_ids = result.get("_external_ids", [])
            for authority, local_id, uri in ext_ids:
                pending.append((eid, authority, local_id, uri))

            if len(pending) >= args.commit_every:
                inserted += _flush()

            if i % 500 == 0:
                elapsed = time.time() - t0
                rate = i / elapsed
                eta = (len(entity_ids) - i) / rate if rate else 0
                print(
                    f"  {i:,}/{len(entity_ids):,} "
                    f"({resolved_ok:,} ok, {failed:,} failed, "
                    f"{inserted:,} inserted so far, "
                    f"{rate:.1f}/s, ETA {eta:.0f}s)",
                    flush=True,
                )

    inserted += _flush()

    post_total = conn.execute(
        "SELECT COUNT(*) FROM vocabulary_external_ids"
    ).fetchone()[0]

    elapsed = time.time() - t0
    print(f"\nDone in {elapsed:.0f}s.")
    print(f"  Resolved OK:      {resolved_ok:,}")
    print(f"  Failed:           {failed:,}")
    if failures:
        breakdown = ", ".join(f"{r}={n}" for r, n in sorted(failures.items(),
                                                              key=lambda x: -x[1]))
        print(f"  Failure reasons:  {breakdown}")
    print(f"  vei rows pre:     {pre_total:,}")
    print(f"  vei rows post:    {post_total:,}")
    print(f"  Net delta:        +{post_total - pre_total:,}")
    if args.dry_run:
        print("  (dry-run — no writes)")

    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
