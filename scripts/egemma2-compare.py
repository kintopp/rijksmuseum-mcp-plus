#!/usr/bin/env python3
"""
Pooled comparison of EmbeddingGemma 2 against existing search systems.

  gather  Collect baseline rankings for each query:
            text  → our semantic_search (local CLI) + Rijksmuseum website keyword search
            image → Rijksmuseum website visual search (the API behind find_similar's Visual channel)
          Writes data/egemma2-test/compare/queries.json.
  score   Score data/egemma2-test/compare/judgements.json (exported from the blind
          judging page built by `explore-embeddinggemma2-modal.py --compare`).

Usage:
    python3 scripts/egemma2-compare.py gather
    python3 scripts/egemma2-compare.py score
"""

import json
import os
import sqlite3
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parent.parent
VOCAB_DB = PROJECT_DIR / "data" / "vocabulary.db"
OUT = PROJECT_DIR / "data" / "egemma2-test" / "compare"
RIJKS = "https://www.rijksmuseum.nl/api/v1/collection"
UA = "rijksmuseum-mcp-plus research probe"
DEPTH = 20  # baseline candidates per query that enter the pool
JUDGE_K = 8  # per-system cut that gets judged

TEXT_QUERIES = [
    # catalogue metadata usually names these
    "the crucifixion of Christ",
    "winter landscape with ice skaters",
    "a naval battle",
    "map of a city",
    "portrait of a woman wearing a pearl necklace",
    "still life with flowers in a vase",
    "the Annunciation",
    "a teapot",
    # visual content that catalogue text often omits
    "a dog sleeping under a table",
    "people looking at the sea",
    "a red umbrella",
    "a woman reading a letter by a window",
    "children playing in the street",
    "a horseman in a snowy landscape",
    "a moonlit landscape",
    "ships on a calm sea at sunset",
    "a crowd of people in a city square",
    "blue and white porcelain",
]
IMAGE_QUERIES = [
    "SK-A-2344",          # Milkmaid
    "SK-A-1718",          # Avercamp, winter landscape
    "RP-P-1905-1558",     # naval battle print (pendant: -1559)
    "RP-P-1907-4040",     # shipwreck print (pendant: -4041)
    "RP-P-OB-15.850",     # church interior print
    "BK-NM-1010",         # Oortman dollhouse (painting of it: SK-A-4245)
    "RP-P-OB-JAP-7",      # Hiroshige
    "BK-17511",           # teapot
    "RP-T-1898-A-4058",   # drawing: dancing cat and dog
    "SK-A-1505",          # windmill painting
    "SK-C-5",             # Night Watch
    "RP-P-2016-671-107",  # triumphal procession print
]


def http_json(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)


def rijks_search(text: str, n: int) -> list[str]:
    q = urllib.parse.urlencode({"query": text, "language": "en", "page": 1, "pageSize": n})
    return [o["objectNumber"] for o in http_json(f"{RIJKS}/search?{q}").get("artObjects", [])]


def rijks_visual(object_number: str, n: int) -> list[str] | None:
    q = urllib.parse.urlencode({"query": object_number, "language": "en", "pageSize": 5})
    node = next((o["objectNodeId"] for o in http_json(f"{RIJKS}/search?{q}").get("artObjects", [])
                 if o["objectNumber"] == object_number), None)
    if not node:
        return None
    q = urllib.parse.urlencode({"objectNodeId": node, "language": "en", "page": 1, "pageSize": n})
    return [o["objectNumber"] for o in http_json(f"{RIJKS}/visualsearch?{q}").get("artObjects", [])]


def semantic(text: str, n: int) -> list[str]:
    env = {k: v for k, v in os.environ.items() if k != "RIJKS_MCP_HTTP"}
    out = subprocess.run(
        ["node", "scripts/cli.mjs", "semantic", text, "-n", str(n), "--fields", "objectNumber", "--quiet"],
        cwd=PROJECT_DIR, env=env, capture_output=True, text=True, check=True,
    ).stdout
    return [json.loads(l)["objectNumber"] for l in out.splitlines() if l.startswith("{\"objectNumber\"")]


def with_image(conn, object_numbers: list[str]) -> list[str]:
    """Image search can only be judged on items that have an image."""
    keep = []
    for on in object_numbers:
        row = conn.execute("SELECT iiif_id FROM artworks WHERE object_number = ?", (on,)).fetchone()
        if row and row[0]:
            keep.append(on)
    return keep


def gather() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(f"file:{VOCAB_DB}?mode=ro", uri=True)
    queries = []
    for text in TEXT_QUERIES:
        sem = with_image(conn, semantic(text, DEPTH * 2))[:DEPTH]
        kw = with_image(conn, rijks_search(text, DEPTH * 2))[:DEPTH]
        time.sleep(0.5)
        queries.append({"kind": "text", "query": text, "systems": {"semantic_search": sem, "rijks_keyword": kw}})
        print(f"text  {text!r}: semantic {len(sem)}, rijks_keyword {len(kw)}")
    for on in IMAGE_QUERIES:
        vis = rijks_visual(on, DEPTH + 1)
        time.sleep(0.5)
        vis = None if vis is None else with_image(conn, [v for v in vis if v != on])[:DEPTH]
        queries.append({"kind": "image", "query": on, "systems": {"rijks_visual": vis or []},
                        "rijks_visual_missing": vis is None})
        print(f"image {on}: rijks_visual {'no objectNodeId' if vis is None else len(vis)}")
    (OUT / "queries.json").write_text(json.dumps(queries, indent=1))
    print(f"Wrote {OUT / 'queries.json'}")


def score() -> None:
    import math
    results = json.loads((OUT / "results.json").read_text())
    judged = json.loads((OUT / "judgements.json").read_text())  # {query: {objectNumber: 0|1|2}}
    gain_sum: dict[tuple[str, str], list[float]] = {}
    print(f"{'kind':5} {'system':16} {'P@8':>5} {'nDCG@8':>7} {'judged':>6}  query")
    for q in results:
        marks = judged.get(q["query"], {})
        for system, ranked in q["systems"].items():
            top = ranked[:JUDGE_K]
            gains = [marks.get(on) for on in top]
            if not top or any(g is None for g in gains):
                print(f"{q['kind']:5} {system:16} {'—':>5} {'—':>7} {'unjudged' if top else 'empty':>6}  {q['query']}")
                if not top:
                    gain_sum.setdefault((q["kind"], system), []).append((0.0, 0.0))
                continue
            p = sum(1 for g in gains if g >= 1) / JUDGE_K
            dcg = sum(g / math.log2(i + 2) for i, g in enumerate(gains))
            pool_gains = sorted((g for g in marks.values() if g is not None), reverse=True)[:JUDGE_K]
            idcg = sum(g / math.log2(i + 2) for i, g in enumerate(pool_gains)) or 1
            gain_sum.setdefault((q["kind"], system), []).append((p, dcg / idcg))
            print(f"{q['kind']:5} {system:16} {p:5.2f} {dcg / idcg:7.3f} {len(top):6}  {q['query']}")
    print("\nMeans (empty result lists count as 0):")
    for (kind, system), vals in sorted(gain_sum.items()):
        print(f"  {kind:5} {system:16} P@8 {sum(v[0] for v in vals) / len(vals):.2f}  "
              f"nDCG@8 {sum(v[1] for v in vals) / len(vals):.3f}  (n={len(vals)})")


if __name__ == "__main__":
    {"gather": gather, "score": score}[sys.argv[1] if len(sys.argv) > 1 else "gather"]()
