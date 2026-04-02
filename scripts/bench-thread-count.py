#!/usr/bin/env python3
"""Benchmark Phase 4-style Linked Art resolution at different thread counts.

Tests 8, 10, 12, 14, 16 threads against a fixed sample of artworks.
Measures: success rate, error types, avg/p50/p95 latency, throughput.
"""

import json
import sqlite3
import statistics
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

DB_PATH = "data/vocabulary.db"
LINKED_ART_BASE = "https://id.rijksmuseum.nl"
USER_AGENT = "rijksmuseum-mcp-plus/bench"
SAMPLE_SIZE = 100  # artworks per thread-count run
THREAD_COUNTS = [8, 10, 12, 14, 16]
ROUNDS = 2  # repeat each thread count to smooth variance


def fetch_json(url):
    """Fetch JSON-LD — mirrors resolve_artwork() HTTP pattern."""
    req = urllib.request.Request(url, headers={
        "Accept": "application/ld+json",
        "Profile": "https://linked.art/ns/v1/linked-art.json",
        "User-Agent": USER_AGENT,
    })
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def resolve_artwork_with_vi(uri):
    """Resolve HumanMadeObject + VisualItem (simulates Phase 4 + VI fetch)."""
    t0 = time.monotonic()

    # Step 1: HumanMadeObject
    obj = fetch_json(uri)

    # Step 2: VisualItem
    shows = obj.get("shows", [])
    if isinstance(shows, dict):
        shows = [shows]
    vi_data = None
    if shows and isinstance(shows[0], dict) and shows[0].get("id"):
        vi_data = fetch_json(shows[0]["id"])

    elapsed = time.monotonic() - t0
    return elapsed, vi_data is not None


def run_batch(uris, threads):
    """Run a batch of resolutions and return stats."""
    latencies = []
    successes = 0
    failures = 0
    errors_by_type = {}

    t0 = time.monotonic()
    with ThreadPoolExecutor(max_workers=threads) as pool:
        futures = {pool.submit(resolve_artwork_with_vi, uri): uri for uri in uris}
        for future in as_completed(futures):
            try:
                elapsed, has_vi = future.result()
                latencies.append(elapsed)
                successes += 1
            except Exception as e:
                failures += 1
                etype = type(e).__name__
                msg = str(e)[:80]
                key = f"{etype}: {msg}"
                errors_by_type[key] = errors_by_type.get(key, 0) + 1

    wall_time = time.monotonic() - t0
    return {
        "successes": successes,
        "failures": failures,
        "wall_time": wall_time,
        "latencies": latencies,
        "errors": errors_by_type,
    }


def main():
    conn = sqlite3.connect(DB_PATH)

    # Get a diverse sample of artworks with known Linked Art URIs
    # Use the search API to map object_numbers → URIs (cached for reuse)
    print(f"Selecting {SAMPLE_SIZE} artworks from vocab DB...")
    rows = conn.execute("""
        SELECT object_number FROM artworks
        WHERE has_image = 1 AND importance > 0
        ORDER BY RANDOM()
        LIMIT ?
    """, (SAMPLE_SIZE * 2,)).fetchall()  # oversample to handle search failures

    print(f"Resolving Linked Art URIs via search API...")
    uris = []
    for obj_num, in rows:
        if len(uris) >= SAMPLE_SIZE:
            break
        url = f"https://data.rijksmuseum.nl/search/collection?objectNumber={urllib.parse.quote(obj_num)}"
        req = urllib.request.Request(url, headers={
            "Accept": "application/ld+json",
            "User-Agent": USER_AGENT,
        })
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read())
            items = data.get("orderedItems", [])
            if items and items[0].get("id"):
                uris.append(items[0]["id"])
        except Exception:
            pass
        time.sleep(0.05)

    print(f"Got {len(uris)} Linked Art URIs\n")
    if len(uris) < SAMPLE_SIZE:
        print(f"Warning: only {len(uris)} URIs (wanted {SAMPLE_SIZE})")

    # Run benchmarks
    print(f"{'Threads':>7} {'Round':>5} {'OK':>5} {'Fail':>5} "
          f"{'Wall(s)':>8} {'Req/s':>7} {'Avg(s)':>7} {'P50(s)':>7} {'P95(s)':>7}  Errors")
    print("-" * 100)

    summary = {}
    for threads in THREAD_COUNTS:
        round_results = []
        for r in range(ROUNDS):
            # Stagger start to avoid burst
            if r > 0:
                time.sleep(2)

            result = run_batch(uris, threads)
            lats = result["latencies"]

            avg = statistics.mean(lats) if lats else 0
            p50 = statistics.median(lats) if lats else 0
            p95 = sorted(lats)[int(len(lats) * 0.95)] if lats else 0
            rps = result["successes"] / result["wall_time"] if result["wall_time"] > 0 else 0

            err_str = "; ".join(f"{v}x {k}" for k, v in result["errors"].items()) if result["errors"] else "-"

            print(f"{threads:>7} {r+1:>5} {result['successes']:>5} {result['failures']:>5} "
                  f"{result['wall_time']:>8.1f} {rps:>7.1f} {avg:>7.2f} {p50:>7.2f} {p95:>7.2f}  {err_str}")

            round_results.append(result)

        # Aggregate across rounds
        all_lats = [l for r in round_results for l in r["latencies"]]
        total_ok = sum(r["successes"] for r in round_results)
        total_fail = sum(r["failures"] for r in round_results)
        total_wall = sum(r["wall_time"] for r in round_results)
        summary[threads] = {
            "ok": total_ok,
            "fail": total_fail,
            "fail_pct": 100 * total_fail / (total_ok + total_fail) if (total_ok + total_fail) else 0,
            "rps": total_ok / total_wall if total_wall else 0,
            "avg": statistics.mean(all_lats) if all_lats else 0,
            "p50": statistics.median(all_lats) if all_lats else 0,
            "p95": sorted(all_lats)[int(len(all_lats) * 0.95)] if all_lats else 0,
        }

        # Cool-down between thread counts
        print()
        time.sleep(3)

    # Summary table
    print(f"\n{'='*80}")
    print(f"SUMMARY ({SAMPLE_SIZE} artworks × {ROUNDS} rounds, HumanMadeObject + VisualItem)")
    print(f"{'='*80}")
    print(f"{'Threads':>7} {'OK':>6} {'Fail':>6} {'Fail%':>6} {'Req/s':>7} {'Avg(s)':>7} {'P50(s)':>7} {'P95(s)':>7}")
    print("-" * 65)
    for threads in THREAD_COUNTS:
        s = summary[threads]
        print(f"{threads:>7} {s['ok']:>6} {s['fail']:>6} {s['fail_pct']:>5.1f}% {s['rps']:>7.1f} "
              f"{s['avg']:>7.2f} {s['p50']:>7.2f} {s['p95']:>7.2f}")

    # Recommendation
    print()
    baseline = summary[8]
    for threads in THREAD_COUNTS:
        s = summary[threads]
        if s["fail_pct"] > 5:
            print(f"⚠ {threads} threads: {s['fail_pct']:.1f}% failure rate — too aggressive")
        elif s["fail_pct"] > 1:
            print(f"⚠ {threads} threads: {s['fail_pct']:.1f}% failure rate — marginal")
        else:
            speedup = s["rps"] / baseline["rps"] if baseline["rps"] else 0
            print(f"✓ {threads} threads: {s['fail_pct']:.1f}% failures, {speedup:.2f}x throughput vs 8 threads")


if __name__ == "__main__":
    main()
