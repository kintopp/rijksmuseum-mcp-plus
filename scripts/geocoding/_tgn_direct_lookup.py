"""One-shot Phase 1c-direct lookup.

Reads TGN-bearing places without coords from vocabulary.db, queries
Getty SPARQL directly for wgs84 coordinates, writes results to a TSV
for review. Does NOT touch the DB.

Run via: ~/miniconda3/envs/embeddings/bin/python scripts/_tgn_direct_lookup.py
"""
from __future__ import annotations

import csv
import sqlite3
import time
from pathlib import Path

import requests

DB = Path("data/vocabulary.db")
OUT = Path("data/audit/areal-classifier-extension/_tgn_direct_results.tsv")
ENDPOINT = "https://vocab.getty.edu/sparql.json"

QUERY_TMPL = """
PREFIX wgs: <http://www.w3.org/2003/01/geo/wgs84_pos#>
PREFIX foaf: <http://xmlns.com/foaf/0.1/>
PREFIX schema: <http://schema.org/>
SELECT ?tgn ?lat ?lon WHERE {{
  VALUES ?tgn {{ {values} }}
  {{
    ?tgn foaf:focus ?focus .
    ?focus wgs:lat ?lat ; wgs:long ?lon .
  }}
  UNION {{
    ?tgn wgs:lat ?lat ; wgs:long ?lon .
  }}
  UNION {{
    ?tgn schema:latitude ?lat ; schema:longitude ?lon .
  }}
}}
"""


def fetch_candidates(conn: sqlite3.Connection) -> list[tuple[str, str, str | None, str | None]]:
    rows = conn.execute(
        """
        SELECT v.id, vei.uri, v.label_en, v.label_nl
        FROM vocabulary v
        JOIN vocabulary_external_ids vei ON v.id = vei.vocab_id
        WHERE v.type='place' AND v.lat IS NULL AND vei.authority='tgn'
        ORDER BY v.id
        """
    ).fetchall()
    return rows


def query_batch(uris: list[str]) -> dict[str, tuple[float, float]]:
    values = " ".join(f"<{u}>" for u in uris)
    sparql = QUERY_TMPL.format(values=values)
    r = requests.post(
        ENDPOINT,
        data={"query": sparql, "format": "application/sparql-results+json"},
        headers={"Accept": "application/sparql-results+json"},
        timeout=60,
    )
    r.raise_for_status()
    out: dict[str, tuple[float, float]] = {}
    for b in r.json().get("results", {}).get("bindings", []):
        tgn = b["tgn"]["value"]
        lat = float(b["lat"]["value"])
        lon = float(b["lon"]["value"])
        out[tgn] = (lat, lon)
    return out


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(DB) as conn:
        candidates = fetch_candidates(conn)
    print(f"candidates: {len(candidates)}")

    BATCH = 25
    found: dict[str, tuple[float, float]] = {}
    for i in range(0, len(candidates), BATCH):
        chunk = candidates[i : i + BATCH]
        uris = [row[1] for row in chunk]
        try:
            res = query_batch(uris)
            found.update(res)
            print(f"  batch {i // BATCH + 1}: requested {len(uris)}, got {len(res)} hits")
        except Exception as e:
            print(f"  batch {i // BATCH + 1}: FAILED — {e}")
        time.sleep(0.3)

    with OUT.open("w", newline="") as f:
        w = csv.writer(f, delimiter="\t")
        w.writerow(["vocab_id", "tgn_uri", "label_en", "label_nl", "lat", "lon", "hit"])
        for vocab_id, uri, en, nl in candidates:
            coord = found.get(uri)
            if coord:
                w.writerow([vocab_id, uri, en or "", nl or "", coord[0], coord[1], "1"])
            else:
                w.writerow([vocab_id, uri, en or "", nl or "", "", "", "0"])

    hit_count = sum(1 for c in candidates if c[1] in found)
    miss_count = len(candidates) - hit_count
    print()
    print(f"hit:  {hit_count} / {len(candidates)}  ({100*hit_count/len(candidates):.1f}%)")
    print(f"miss: {miss_count}")
    print(f"output: {OUT}")


if __name__ == "__main__":
    main()
