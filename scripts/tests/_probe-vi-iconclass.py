"""Dry-run probe for the VI-Iconclass backfill script (#203).

Runs the per-artwork flow on 30 real tier2_done=1 artworks without writing to
vocabulary.db. For each artwork, prints the VI URI, the number of Type URIs,
per-Type resolution outcome, and whether any new iconclass mappings would be
added. Useful sanity check before the full ~2h run.

Usage:
    python scripts/tests/_probe-vi-iconclass.py
    python scripts/tests/_probe-vi-iconclass.py --n 50     # more artworks
    python scripts/tests/_probe-vi-iconclass.py --obj SK-A-2152  # a specific one
"""
import argparse
import sqlite3
import sys
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from importlib import import_module
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent.parent
sys.path.insert(0, str(PROJECT_DIR / "scripts"))

backfill = import_module("backfill-vi-iconclass")

DEFAULT_DB = str(PROJECT_DIR / "data" / "vocabulary.db")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--db", default=DEFAULT_DB,
                        help=f"Path to vocabulary.db (default: {DEFAULT_DB})")
    parser.add_argument("--n", type=int, default=30, help="Number of artworks to probe")
    parser.add_argument("--obj", type=str, default=None,
                        help="Specific object_number to probe (overrides --n)")
    parser.add_argument("--threads", type=int, default=8)
    args = parser.parse_args()

    print(f"Target DB: {args.db}")
    conn = sqlite3.connect(args.db)

    # #253: reconstruct HMO URI from the permanent artwork_hmo_ids lookup so the
    # probe works against post-Phase-3 DBs where linked_art_uri has been dropped.
    if args.obj:
        rows = conn.execute(
            "SELECT a.object_number, 'https://id.rijksmuseum.nl/' || h.hmo_id "
            "FROM artworks a JOIN artwork_hmo_ids h ON h.art_id = a.art_id "
            "WHERE a.object_number = ?",
            (args.obj,),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT a.object_number, 'https://id.rijksmuseum.nl/' || h.hmo_id "
            "FROM artworks a JOIN artwork_hmo_ids h ON h.art_id = a.art_id "
            f"ORDER BY RANDOM() LIMIT {args.n}"
        ).fetchall()

    if not rows:
        print("No artworks matched.")
        return 1

    print(f"Probing {len(rows)} artwork(s) (no DB writes)...")
    print(f"Loading vocab cache...")
    vocab_cache = backfill.load_vocab_cache(conn)
    print(f"  {len(vocab_cache):,} classification entries cached.\n")

    counters: Counter = Counter()
    status_counts: Counter = Counter()
    error_reason_counts: Counter = Counter()
    per_artwork_mappings: list[int] = []

    t0 = time.time()
    with ThreadPoolExecutor(max_workers=args.threads) as pool:
        futures = {
            pool.submit(backfill.worker_fetch_vi, obj_num, uri): (obj_num, uri)
            for obj_num, uri in rows
        }
        for future in as_completed(futures):
            obj_num, uri = futures[future]
            result = future.result()
            status = result["status"]

            if status == "done_pending_types":
                type_uris = result["type_uris"]
                # Use a throwaway copy of the cache — we don't want to pollute
                # subsequent probe iterations with half-resolved state, but we do
                # want to exercise the full resolution path.
                pending_vocab: list[dict] = []
                pending_vei: list = []
                iconclass_entity_ids, new_types_this = backfill.process_type_uris(
                    type_uris, vocab_cache, pending_vocab, pending_vei, counters
                )
                status_counts["done"] += 1
                per_artwork_mappings.append(len(iconclass_entity_ids))
                print(f"  {obj_num:<20} VI {backfill.derive_vi_uri(uri)}")
                print(f"    {len(type_uris)} Type URIs, {len(iconclass_entity_ids)} iconclass-bearing")
                if pending_vocab:
                    print(f"    Would create {len(pending_vocab)} new vocab row(s):")
                    for v in pending_vocab[:3]:
                        print(f"      notation={v['notation']} label_en={v.get('label_en')!r}")
                    if len(pending_vocab) > 3:
                        print(f"      ... +{len(pending_vocab)-3} more")
                if iconclass_entity_ids:
                    print(f"    Would INSERT {len(iconclass_entity_ids)} mapping(s) as field='subject'")
            else:
                status_counts[status] += 1
                reason = result.get("error_reason")
                if reason:
                    error_reason_counts[reason] += 1
                per_artwork_mappings.append(0)
                print(f"  {obj_num:<20} status={status}" + (f" reason={reason}" if reason else ""))

    elapsed = time.time() - t0
    print(f"\nProbe complete in {elapsed:.1f}s.")
    print(f"  done:     {status_counts['done']}")
    print(f"  empty_vi: {status_counts['empty_vi']}")
    print(f"  error:    {status_counts['error']}")
    for reason, count in sorted(error_reason_counts.items(), key=lambda x: -x[1]):
        print(f"    {reason}: {count}")
    total_new_mappings = sum(per_artwork_mappings)
    artworks_with_mappings = sum(1 for m in per_artwork_mappings if m > 0)
    print(f"  artworks that would get new mappings: {artworks_with_mappings}/{len(rows)}")
    print(f"  total new mappings across sample:     {total_new_mappings}")
    print(f"  new types resolved (cold cache hits): {counters.get('new_types_resolved', 0)}")
    print(f"  type HTTP permanent failures:         {counters.get('type_http_permanent', 0)}")
    print(f"  type transient (post-retry) failures: {counters.get('type_http_transient_failed', 0)}")

    print("\nNo writes were performed. vocab_cache state was modified in-process only.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
