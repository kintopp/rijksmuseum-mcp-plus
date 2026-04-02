#!/usr/bin/env python3
"""Benchmark Phase 4-style resolution at low thread counts (1-8).

Focus: does the server's ~10 req/s aggregate throughput hold at lower concurrency,
or do fewer threads actually yield faster wall-clock time?
"""

import json
import sqlite3
import statistics
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

DB_PATH = "data/vocabulary.db"
USER_AGENT = "rijksmuseum-mcp-plus/bench"
SAMPLE_SIZE = 100
THREAD_COUNTS = [1, 2, 4, 6, 8]
ROUNDS = 2


def fetch_json(url):
    req = urllib.request.Request(url, headers={
        "Accept": "application/ld+json",
        "Profile": "https://linked.art/ns/v1/linked-art.json",
        "User-Agent": USER_AGENT,
    })
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def resolve_artwork_with_vi(uri):
    t0 = time.monotonic()
    obj = fetch_json(uri)
    shows = obj.get("shows", [])
    if isinstance(shows, dict):
        shows = [shows]
    if shows and isinstance(shows[0], dict) and shows[0].get("id"):
        fetch_json(shows[0]["id"])
    return time.monotonic() - t0


def run_batch(uris, threads):
    latencies = []
    successes = 0
    failures = 0
    errors_by_type = {}

    t0 = time.monotonic()
    with ThreadPoolExecutor(max_workers=threads) as pool:
        futures = {pool.submit(resolve_artwork_with_vi, uri): uri for uri in uris}
        for future in as_completed(futures):
            try:
                elapsed = future.result()
                latencies.append(elapsed)
                successes += 1
            except Exception as e:
                failures += 1
                key = f"{type(e).__name__}: {str(e)[:60]}"
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

    print(f"Selecting {SAMPLE_SIZE} artworks...")
    rows = conn.execute("""
        SELECT object_number FROM artworks
        WHERE has_image = 1 AND importance > 0
        ORDER BY RANDOM()
        LIMIT ?
    """, (SAMPLE_SIZE * 2,)).fetchall()

    print(f"Resolving Linked Art URIs...")
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

    print(f"Got {len(uris)} URIs\n")

    print(f"{'Threads':>7} {'Round':>5} {'OK':>5} {'Fail':>5} "
          f"{'Wall(s)':>8} {'Req/s':>7} {'Avg(s)':>7} {'P50(s)':>7} {'P95(s)':>7}  Errors")
    print("-" * 100)

    summary = {}
    for threads in THREAD_COUNTS:
        round_results = []
        for r in range(ROUNDS):
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

        all_lats = [l for r in round_results for l in r["latencies"]]
        total_ok = sum(r["successes"] for r in round_results)
        total_fail = sum(r["failures"] for r in round_results)
        total_wall = sum(r["wall_time"] for r in round_results)
        summary[threads] = {
            "ok": total_ok,
            "fail": total_fail,
            "rps": total_ok / total_wall if total_wall else 0,
            "wall_avg": total_wall / ROUNDS,
            "avg": statistics.mean(all_lats) if all_lats else 0,
            "p50": statistics.median(all_lats) if all_lats else 0,
            "p95": sorted(all_lats)[int(len(all_lats) * 0.95)] if all_lats else 0,
        }
        print()
        time.sleep(3)

    print(f"\n{'='*80}")
    print(f"SUMMARY ({SAMPLE_SIZE} artworks × {ROUNDS} rounds, HMO + VisualItem)")
    print(f"{'='*80}")
    print(f"{'Threads':>7} {'Req/s':>7} {'Wall(s)':>8} {'Avg(s)':>7} {'P50(s)':>7} {'P95(s)':>7}")
    print("-" * 50)
    for threads in THREAD_COUNTS:
        s = summary[threads]
        print(f"{threads:>7} {s['rps']:>7.1f} {s['wall_avg']:>8.1f} {s['avg']:>7.2f} {s['p50']:>7.2f} {s['p95']:>7.2f}")

    # Phase 4 time estimate for 832K artworks (2 requests each)
    print(f"\n  Estimated Phase 4 wall-clock for 832K artworks (HMO + VI):")
    for threads in THREAD_COUNTS:
        s = summary[threads]
        est_hours = (832000 / s["rps"]) / 3600 if s["rps"] else 0
        print(f"    {threads:>2} threads: {est_hours:.1f} hours")


if __name__ == "__main__":
    main()
