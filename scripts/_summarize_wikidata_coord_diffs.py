"""Summarize the magnitude of coord changes that would result from
backfilling data/tgn-rdf-rijks-wikidata-coords.csv into vocabulary.db
under the strict 'Rijks-supplied IDs only' policy.

Buckets diffs in degrees so the user can see how many rows are pure
provenance upgrades vs. real coord rewrites.
"""
import csv
import math
import sys
from pathlib import Path

CSV_PATH = Path(__file__).resolve().parent.parent \
    / "data" / "tgn-rdf-rijks-wikidata-coords.csv"


def main() -> int:
    rows = list(csv.DictReader(CSV_PATH.open(newline="")))
    rows = [r for r in rows if r["status"] == "ok"]
    print(f"Total ok rows: {len(rows)}\n")

    buckets = [
        ("identical (delta = 0)", lambda d: d == 0),
        ("≤ 0.001°  (~100 m)",    lambda d: 0 < d <= 0.001),
        ("≤ 0.01°   (~1 km)",     lambda d: 0.001 < d <= 0.01),
        ("≤ 0.1°    (~10 km)",    lambda d: 0.01 < d <= 0.1),
        ("≤ 1°      (~100 km)",   lambda d: 0.1 < d <= 1.0),
        ("≤ 10°     (regional)",  lambda d: 1.0 < d <= 10.0),
        ("> 10°     (continental)", lambda d: d > 10.0),
    ]
    counts = [0] * len(buckets)
    examples: list[list[str]] = [[] for _ in buckets]
    big_changes = []  # (delta_total, vocab_id, label, existing, wikidata)

    for r in rows:
        try:
            ex_lat = float(r["existing_lat"])
            ex_lon = float(r["existing_lon"])
        except ValueError:
            continue
        wd_lat = float(r["wikidata_lat"])
        wd_lon = float(r["wikidata_lon"])
        # Use max of |dLat|, |dLon| as rough magnitude — close enough for
        # bucketing without per-row haversine.
        delta = max(abs(ex_lat - wd_lat), abs(ex_lon - wd_lon))
        for i, (_, pred) in enumerate(buckets):
            if pred(delta):
                counts[i] += 1
                if len(examples[i]) < 3:
                    label = r["label_en"] or r["qid"]
                    examples[i].append(
                        f"{r['vocab_id']} ({label}): "
                        f"({ex_lat:.4f},{ex_lon:.4f}) -> "
                        f"({wd_lat:.4f},{wd_lon:.4f})"
                    )
                break
        if delta > 1.0:
            big_changes.append((delta, r))

    print(f"{'bucket':<28}  {'count':>6}  {'examples'}")
    for (label, _), n, ex in zip(buckets, counts, examples):
        print(f"  {label:<26}  {n:>6}")
        for e in ex:
            print(f"      {e}")

    print(f"\nTotal classified: {sum(counts)}")
    upgrades = counts[0] + counts[1] + counts[2]
    rewrites = sum(counts[3:])
    print(f"  pure provenance upgrades (≤ 1 km diff): {upgrades}")
    print(f"  real coord rewrites (> 1 km diff):       {rewrites}")

    if big_changes:
        print(f"\nLargest changes (delta > 1°), top 10:")
        big_changes.sort(key=lambda kv: -kv[0])
        for delta, r in big_changes[:10]:
            label = r["label_en"] or r["qid"]
            method = r["existing_method_detail"]
            print(f"  delta={delta:5.2f}°  {r['vocab_id']:<10}  {label[:30]:<30}  "
                  f"({float(r['existing_lat']):.3f},{float(r['existing_lon']):.3f}) -> "
                  f"({float(r['wikidata_lat']):.3f},{float(r['wikidata_lon']):.3f})  "
                  f"via={method}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
