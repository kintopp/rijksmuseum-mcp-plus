#!/usr/bin/env python3
"""Detection probe for issues #231 (bare-string classified_as/equivalent)
and #232 (timespan/content singular-vs-array inconsistency).

Fetches a sample of Linked Art records from id.rijksmuseum.nl and reports
whether the documented upstream bugs are still present.
"""
import json
import sys
import urllib.request

SAMPLE = [
    # From the #231 issue's detection script
    "200104612",
    # Varied HMO IDs harvested from offline/explorations notes
    "200108516", "200902396", "200120822", "200120823", "200106038",
    "200150901", "200391871", "200780925",
    "200801198", "200574683", "200585120",
    "200216591", "200429035", "200241644",
    "200261863", "200808817", "200590769", "200909498",
    "200117708", "200396070",
]

def fetch(art_id):
    url = f"https://id.rijksmuseum.nl/{art_id}"
    req = urllib.request.Request(url, headers={"Accept": "application/ld+json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)

def walk_bare(obj, path=""):
    """#231 — yield (path, value) for every bare-string entry in
    classified_as / equivalent arrays."""
    if isinstance(obj, dict):
        for field in ("classified_as", "equivalent"):
            for i, c in enumerate(obj.get(field) or []):
                if isinstance(c, str):
                    yield (f"{path}.{field}[{i}]", c)
        for k, v in obj.items():
            yield from walk_bare(v, f"{path}.{k}")
    elif isinstance(obj, list):
        for i, x in enumerate(obj):
            yield from walk_bare(x, f"{path}[{i}]")

def walk_arrays(obj, path=""):
    """#232 — yield (path, kind) for every timespan-as-array and content-as-array hit."""
    if isinstance(obj, dict):
        if "timespan" in obj and isinstance(obj["timespan"], list):
            yield (f"{path}.timespan", f"array[{len(obj['timespan'])}]")
        if "content" in obj and isinstance(obj["content"], list):
            yield (f"{path}.content", f"array[{len(obj['content'])}]")
        for k, v in obj.items():
            yield from walk_arrays(v, f"{path}.{k}")
    elif isinstance(obj, list):
        for i, x in enumerate(obj):
            yield from walk_arrays(x, f"{path}[{i}]")

def main():
    bare_total = 0
    timespan_arr_total = 0
    content_arr_total = 0
    fetch_fail = []
    per_record = []

    for art_id in SAMPLE:
        try:
            data = fetch(art_id)
        except Exception as e:
            fetch_fail.append((art_id, str(e)))
            continue

        bares = list(walk_bare(data))
        arrs = list(walk_arrays(data))
        ts_arrs = [a for a in arrs if a[0].endswith(".timespan")]
        c_arrs = [a for a in arrs if a[0].endswith(".content")]

        bare_total += len(bares)
        timespan_arr_total += len(ts_arrs)
        content_arr_total += len(c_arrs)

        per_record.append((art_id, len(bares), len(ts_arrs), len(c_arrs)))

        if bares or ts_arrs or c_arrs:
            print(f"\n=== {art_id} ===")
            for p, v in bares[:5]:
                print(f"  [#231 BARE] {p}: {v}")
            if len(bares) > 5:
                print(f"  [#231 BARE] … {len(bares) - 5} more")
            for p, k in ts_arrs:
                print(f"  [#232 TS-ARR] {p}: {k}")
            for p, k in c_arrs:
                print(f"  [#232 CONTENT-ARR] {p}: {k}")

    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    print(f"Records sampled:        {len(SAMPLE) - len(fetch_fail)}/{len(SAMPLE)}")
    print(f"#231 bare-string hits:  {bare_total}")
    print(f"#232 timespan-as-array: {timespan_arr_total}")
    print(f"#232 content-as-array:  {content_arr_total}")
    if fetch_fail:
        print(f"Fetch failures: {fetch_fail}")

    print("\nPer-record breakdown (art_id, #231 bare, #232 ts-arr, #232 content-arr):")
    for r in per_record:
        marker = "  " if (r[1] + r[2] + r[3] == 0) else "* "
        print(f"  {marker}{r[0]:>10}  bare={r[1]:>3}  ts-arr={r[2]}  content-arr={r[3]}")

    return 1 if (bare_total + timespan_arr_total + content_arr_total) > 0 else 0

if __name__ == "__main__":
    sys.exit(main())
