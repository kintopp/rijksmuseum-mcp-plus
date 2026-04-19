#!/usr/bin/env python3
"""One-off probe for issue #262: would re-geocoding the 75-row (53.0, -2.0)
cluster via WHG with country-context filter (P17=Q145 United Kingdom)
recover proper coords?

Output: per-row WHG candidates (top 3) + recovery rate summary.
"""
from __future__ import annotations

import json
import os
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
UK_QID = "Q145"  # United Kingdom


def _whg_post(params: dict[str, str], retries: int = 3) -> dict:
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
            wait = 2 ** (attempt + 1)
            print(f"  WHG retry in {wait}s: {e}", file=sys.stderr)
            time.sleep(wait)
    return {}


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
    print(f"Probing {len(rows)} rows from (53.0, -2.0) cluster against WHG with country=GB (Q145)...")
    print()

    BATCH = 50
    all_results: dict[str, list] = {}

    for i in range(0, len(rows), BATCH):
        batch = rows[i:i + BATCH]
        queries: dict[str, dict] = {}
        batch_map: dict[str, tuple[str, str]] = {}
        for j, r in enumerate(batch):
            key = f"q{j}"
            queries[key] = {
                "query": r["name"],
                "type": WHG_PLACE_TYPE,
                "limit": 3,
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
        print(f"  {min(i + BATCH, len(rows))}/{len(rows)} done", file=sys.stderr)

    # Print per-row results
    n_with_match = 0
    n_with_match_score_high = 0  # score >= 80
    n_no_match = 0

    for r in rows:
        vid, name = r["id"], r["name"]
        results = all_results.get(vid, [])
        if not results:
            n_no_match += 1
            print(f"  [NO MATCH] {vid:>10} '{name}'")
            continue

        n_with_match += 1
        top = results[0]
        score = top.get("score", 0)
        if score >= 80:
            n_with_match_score_high += 1

        descs = " | ".join(
            f"{r.get('name', '?')} (s={r.get('score', 0):.0f}) [{r.get('description', '')[:30]}]"
            for r in results[:2]
        )
        print(f"  {vid:>10} '{name}': {descs}")

    print()
    print("=" * 60)
    print(f"Recovery rate summary (cluster = {len(rows)} rows)")
    print("=" * 60)
    print(f"  WHG returned ≥1 candidate:        {n_with_match:>4} / {len(rows)} ({100*n_with_match/len(rows):.1f}%)")
    print(f"  Top candidate score ≥ 80:         {n_with_match_score_high:>4} / {len(rows)} ({100*n_with_match_score_high/len(rows):.1f}%)")
    print(f"  No candidate / WHG returned []:   {n_no_match:>4} / {len(rows)} ({100*n_no_match/len(rows):.1f}%)")


if __name__ == "__main__":
    main()
