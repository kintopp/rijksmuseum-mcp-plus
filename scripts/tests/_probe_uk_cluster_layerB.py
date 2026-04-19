#!/usr/bin/env python3
"""Re-run #262 probe with Layer B (description post-filter for Country: GB).

Estimates realistic recovery rate when both Layer A (P17 query hint) and
Layer B (per-result country filter against the description string) are
applied — same filter logic that landed in WI-3 / #257.
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DB_PATH = REPO_ROOT / "data" / "vocabulary.db"

WHG_RECONCILE_URL = "https://whgazetteer.org/reconcile"
WHG_PLACE_TYPE = "https://whgazetteer.org/static/whg_schema.jsonld#Place"
USER_AGENT = "rijksmuseum-mcp-262probe/1.0"
UK_QID = "Q145"

# Layer B regex (mirrors phase_3b_whg)
COUNTRY_RE = re.compile(r"Country:\s*([A-Z]{2})", re.IGNORECASE)


def _whg_post(params, retries=3):
    body = urllib.parse.urlencode(params).encode()
    req = urllib.request.Request(WHG_RECONCILE_URL, data=body, method="POST")
    req.add_header("User-Agent", USER_AGENT)
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    token = os.environ.get("WHG_TOKEN", "").strip().strip('"').strip("'")
    if not token:
        sys.exit("ERROR: WHG_TOKEN env var not set")
    req.add_header("Authorization", f"Bearer {token}")
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                return json.loads(resp.read().decode())
        except Exception as e:
            if attempt == retries - 1:
                raise
            time.sleep(2 ** (attempt + 1))


def main():
    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    rows = conn.execute("""
        SELECT id, COALESCE(label_en, label_nl) AS name
        FROM vocabulary
        WHERE type='place' AND lat=53.0 AND lon=-2.0
          AND (is_areal = 0 OR is_areal IS NULL)
        ORDER BY id
    """).fetchall()

    BATCH = 50
    all_results = {}
    for i in range(0, len(rows), BATCH):
        batch = rows[i:i + BATCH]
        queries, batch_map = {}, {}
        for j, r in enumerate(batch):
            key = f"q{j}"
            queries[key] = {
                "query": r["name"],
                "type": WHG_PLACE_TYPE,
                "limit": 5,  # check more candidates
                "properties": [{"pid": "P17", "v": UK_QID}],
            }
            batch_map[key] = (r["id"], r["name"])
        resp = _whg_post({"queries": json.dumps(queries)})
        for key, data in resp.items():
            if key in batch_map:
                vid, _ = batch_map[key]
                results = data.get("result", []) if isinstance(data, dict) else []
                results = [r for r in results if not r.get("id", "").startswith("dummy:")]
                all_results[vid] = results
        time.sleep(0.5)

    # Layer B: filter each row's candidates to only those with Country: GB
    layer_b = {}
    for r in rows:
        vid, name = r["id"], r["name"]
        candidates = all_results.get(vid, [])
        gb_candidates = []
        for c in candidates:
            desc = c.get("description", "") or ""
            m = COUNTRY_RE.search(desc)
            country = m.group(1).upper() if m else None
            if country == "GB":
                gb_candidates.append(c)
        layer_b[vid] = {"all": candidates, "gb": gb_candidates}

    # Categorize
    bucket_top1_gb = []      # First candidate is Country: GB
    bucket_in_top3_gb = []   # Some candidate in top 3 is GB (but not #1)
    bucket_in_top5_gb = []   # GB only in 4th/5th
    bucket_no_gb = []        # No GB candidate at all

    for r in rows:
        vid, name = r["id"], r["name"]
        all_c = layer_b[vid]["all"]
        gb_c = layer_b[vid]["gb"]
        if not gb_c:
            bucket_no_gb.append((vid, name, all_c[:1]))
            continue
        top_country = COUNTRY_RE.search(all_c[0].get("description", "") or "")
        if top_country and top_country.group(1).upper() == "GB":
            bucket_top1_gb.append((vid, name, gb_c[0]))
        else:
            top_indices = [i for i, c in enumerate(all_c) if c in gb_c]
            best_idx = min(top_indices) if top_indices else 99
            if best_idx <= 2:
                bucket_in_top3_gb.append((vid, name, gb_c[0], best_idx))
            else:
                bucket_in_top5_gb.append((vid, name, gb_c[0], best_idx))

    print("=" * 70)
    print(f"Layer B (post-filter Country: GB) recovery analysis — 75 rows")
    print("=" * 70)
    print(f"  Top candidate is GB:                  {len(bucket_top1_gb):>3} ({100*len(bucket_top1_gb)/75:.1f}%)")
    print(f"  GB found in candidates 2-3:           {len(bucket_in_top3_gb):>3} ({100*len(bucket_in_top3_gb)/75:.1f}%)")
    print(f"  GB found in candidates 4-5:           {len(bucket_in_top5_gb):>3} ({100*len(bucket_in_top5_gb)/75:.1f}%)")
    print(f"  No GB candidate (recovery fails):     {len(bucket_no_gb):>3} ({100*len(bucket_no_gb)/75:.1f}%)")

    n_recoverable = len(bucket_top1_gb) + len(bucket_in_top3_gb) + len(bucket_in_top5_gb)
    print(f"\n  TOTAL recoverable via Layer A+B:      {n_recoverable:>3} ({100*n_recoverable/75:.1f}%)")
    print(f"  TOTAL not recoverable via WHG:        {len(bucket_no_gb):>3} ({100*len(bucket_no_gb)/75:.1f}%)")

    print(f"\n--- 'No GB candidate' rows (would need other source) ---")
    for vid, name, top in bucket_no_gb:
        topdesc = ""
        if top:
            t = top[0]
            cm = COUNTRY_RE.search(t.get("description", "") or "")
            cstr = cm.group(1) if cm else "?"
            topdesc = f"  (top result: '{t.get('name','')}' Country:{cstr})"
        print(f"    {name}{topdesc}")


if __name__ == "__main__":
    main()
