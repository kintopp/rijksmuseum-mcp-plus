"""Benchmark download throughput from iiif.micr.io at different concurrency levels.

Samples 400 random 1568px IIIF JPEGs from the Rijksmuseum collection, splits them
into 4 disjoint batches of 100, then downloads each batch at concurrency N=1/4/8/16.
Disjoint batches prevent IIIF edge-cache hits from inflating later runs.

Usage:
    uv run --with requests python scripts/tests/bench-iiif-download.py
"""

import concurrent.futures as cf
import random
import sqlite3
import statistics
import sys
import time
from pathlib import Path

import requests

DB_PATH = Path("data/vocabulary.db")
IIIF_URL = "https://iiif.micr.io/{iid}/full/1568,/0/default.jpg"
CONCURRENCY_LEVELS = [1, 4, 8, 16]
BATCH_SIZE = 100
USER_AGENT = "rijksmuseum-mcp-plus-bench/0.24 (benchmark; arno.bosse@gmail.com)"


def sample_ids(n: int, seed: int = 42) -> list[str]:
    con = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    # Use rowid window + ORDER BY RANDOM is slow on 729K rows; sample via bernoulli.
    # Cheap alternative: pick random offsets up to row count.
    total = con.execute(
        "SELECT COUNT(*) FROM artworks WHERE has_image = 1 AND iiif_id IS NOT NULL"
    ).fetchone()[0]
    rng = random.Random(seed)
    offsets = sorted(rng.sample(range(total), n))
    # Pull iiif_ids ordered by art_id; then pick by offsets.
    cur = con.execute(
        "SELECT iiif_id FROM artworks WHERE has_image = 1 AND iiif_id IS NOT NULL ORDER BY art_id"
    )
    picks = []
    idx = 0
    want = iter(offsets)
    next_wanted = next(want, None)
    for row in cur:
        if next_wanted is None:
            break
        if idx == next_wanted:
            picks.append(row[0])
            next_wanted = next(want, None)
        idx += 1
    con.close()
    assert len(picks) == n, f"expected {n} ids, got {len(picks)}"
    return picks


def fetch_one(session: requests.Session, iid: str) -> tuple[str, int, float, int]:
    """Fetch one IIIF image. Returns (iid, bytes, wall_seconds, http_status)."""
    url = IIIF_URL.format(iid=iid)
    t0 = time.monotonic()
    try:
        r = session.get(url, timeout=60, stream=False)
        nbytes = len(r.content) if r.status_code == 200 else 0
        return (iid, nbytes, time.monotonic() - t0, r.status_code)
    except requests.RequestException as e:
        return (iid, 0, time.monotonic() - t0, -1)


def bench(level: int, ids: list[str]):
    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})
    # Reuse connections across threads.
    adapter = requests.adapters.HTTPAdapter(pool_connections=level, pool_maxsize=level)
    session.mount("https://", adapter)

    t0 = time.monotonic()
    results: list[tuple[str, int, float, int]] = []
    with cf.ThreadPoolExecutor(max_workers=level) as pool:
        futs = [pool.submit(fetch_one, session, iid) for iid in ids]
        for fut in cf.as_completed(futs):
            results.append(fut.result())
    wall = time.monotonic() - t0

    ok = [r for r in results if r[3] == 200]
    errs = [r for r in results if r[3] != 200]
    total_bytes = sum(r[1] for r in ok)
    agg_mbs = total_bytes / wall / 1e6 if wall > 0 else 0

    per_image_times = [r[2] for r in ok]
    per_image_sizes = [r[1] for r in ok]
    p50_t = statistics.median(per_image_times) if per_image_times else 0
    p95_t = sorted(per_image_times)[int(len(per_image_times) * 0.95) - 1] if len(per_image_times) > 1 else 0

    err_summary = ""
    if errs:
        status_counts: dict[int, int] = {}
        for _, _, _, s in errs:
            status_counts[s] = status_counts.get(s, 0) + 1
        err_summary = "  errs=" + ",".join(f"{s}:{c}" for s, c in sorted(status_counts.items()))

    print(
        f"N={level:<2}  wall={wall:>6.1f}s  ok={len(ok):>3}/{len(results)}  "
        f"bytes={total_bytes / 1e6:>6.1f}MB  agg={agg_mbs:>5.2f}MB/s  "
        f"per-image p50={p50_t * 1000:.0f}ms p95={p95_t * 1000:.0f}ms  "
        f"avg size={statistics.mean(per_image_sizes) / 1024:.0f}KB{err_summary}"
    )


def main():
    if not DB_PATH.exists():
        print(f"vocab DB not found at {DB_PATH}", file=sys.stderr)
        sys.exit(1)

    total_needed = len(CONCURRENCY_LEVELS) * BATCH_SIZE
    print(f"sampling {total_needed} random IIIF IDs…")
    ids = sample_ids(total_needed)

    print(f"iiif.micr.io   1568,    batch={BATCH_SIZE} per concurrency level")
    print("-" * 100)
    for i, level in enumerate(CONCURRENCY_LEVELS):
        batch = ids[i * BATCH_SIZE : (i + 1) * BATCH_SIZE]
        bench(level, batch)


if __name__ == "__main__":
    main()
