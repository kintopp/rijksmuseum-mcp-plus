"""Probe the post-fix Phase 4 throughput against the live Linked Art API.

Pulls 30 real pending URIs, runs them through resolve_artwork() with a 12-thread
pool, and reports per-request and aggregate timings. Used to verify that the
requests.Session + HTTPAdapter connection pool lifted throughput above the
pre-fix baseline of ~5 req/sec.
"""
import sqlite3
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from importlib import import_module
harvest = import_module("harvest-vocabulary-db")
resolve_artwork = harvest.resolve_artwork

DB = "/Users/bosse0000/Documents/GitHub/rijksmuseum-mcp-plus/data/vocabulary.db"
N = 30
THREADS = 12


def main() -> int:
    conn = sqlite3.connect(DB)
    uris = [
        u for (u,) in conn.execute(
            "SELECT linked_art_uri FROM artworks "
            "WHERE tier2_done = 0 AND linked_art_uri IS NOT NULL AND linked_art_uri != '' "
            f"LIMIT {N}"
        ).fetchall()
    ]
    conn.close()

    print(f"Probing {len(uris)} URIs with {THREADS} threads...")

    per_request = []
    t0 = time.time()
    ok = failed = not_found = 0

    with ThreadPoolExecutor(max_workers=THREADS) as pool:
        def timed(uri):
            t = time.time()
            r = resolve_artwork(uri)
            return r, time.time() - t

        futures = [pool.submit(timed, u) for u in uris]
        for fut in as_completed(futures):
            r, dt = fut.result()
            per_request.append(dt)
            if r is None:
                failed += 1
            elif r.get("_status") == "not_found":
                not_found += 1
            else:
                ok += 1

    elapsed = time.time() - t0
    rate = len(uris) / elapsed
    per_request.sort()
    median = per_request[len(per_request) // 2]
    p90 = per_request[int(len(per_request) * 0.9)]

    print(f"\nResults:")
    print(f"  ok={ok}  not_found={not_found}  failed={failed}")
    print(f"  wall clock: {elapsed:.2f}s")
    print(f"  throughput: {rate:.1f} req/sec  (pre-fix baseline: ~5 req/sec)")
    print(f"  per-request median: {median*1000:.0f}ms")
    print(f"  per-request p90:    {p90*1000:.0f}ms")
    print(f"  per-request max:    {max(per_request)*1000:.0f}ms")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
