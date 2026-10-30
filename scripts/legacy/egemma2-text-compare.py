#!/usr/bin/env python3
"""
Blind text-retrieval comparison: EmbeddingGemma 2 vs the deployed e5 vectors, on the metadata
composite (semantic_search) and on Dutch descriptions (find_similar's Description channel).

    python scripts/legacy/egemma2-text-compare.py queries   # writes queries.json; then encode with Gemma:
    modal run scripts/embed-corpus-embeddinggemma2-modal.py --queries data/egemma2-test/corpus/compare-text/queries.json
    python scripts/legacy/egemma2-text-compare.py pool      # rankings.json + pool.md (shuffled, systems hidden)
    python scripts/legacy/egemma2-text-compare.py score     # reads grades.json {query: {object_number: 0|1|2}}

Run with ~/miniconda3/envs/embeddings/bin/python.
"""

import json
import random
import sqlite3
import sys
from pathlib import Path

import numpy as np

PROJECT_DIR = Path(__file__).resolve().parent.parent.parent
VOCAB_DB = PROJECT_DIR / "data" / "vocabulary.db"
E5_DB = PROJECT_DIR / "data" / "embeddings.db"
CORPUS = PROJECT_DIR / "data" / "egemma2-test" / "corpus"
OUT = CORPUS / "compare-text"
K = 6

# Text queries drawn from the research scenarios (current and retired) and semantic-search.md
TEXT_QUERIES = [
    "cultural exchange between East and West",
    "contact between European and Asian cultures",
    "loneliness and isolation in a vast empty space",
    "Blumenstrauß in einer Vase",
    "vanitas symbolism and mortality",
    "winter landscape with ice skating",
    "glorification of stadholder William III",
    "an officer courting a young woman in an interior",
    "Japanese woodblock print of a courtesan",
    "Chinese porcelain made for the European market",
    "artworks looted during the Second World War and returned afterwards",
    "schip in storm op zee",
    "spotprent op de politiek",
    "beleg van een stad tijdens de Tachtigjarige Oorlog",
    "portrait of a man wearing a ruff collar",
    "slavery in the Dutch colonies",
    "Noah's ark and the animals",
    "children playing games",
    "triumphal entry of a prince into a city",
    "anatomy lesson with the dissection of a corpse",
]
# Item → item on descriptions (find_similar's Description channel): scenario seeds plus classics
SEED_OBJECTS = ["SK-A-404", "SK-A-1115", "SK-A-3901", "SK-C-5", "RP-P-1956-602",
                "SK-A-2344", "BK-NM-1010", "RP-P-OB-82.153"]


def load_e5(table: str) -> tuple[np.ndarray, np.ndarray]:
    conn = sqlite3.connect(f"file:{E5_DB}?mode=ro", uri=True)
    rows = conn.execute(f"SELECT object_number, embedding FROM {table}").fetchall()
    conn.close()
    ons = np.array([r[0] for r in rows])
    vecs = np.frombuffer(b"".join(r[1] for r in rows), dtype=np.int8).reshape(len(rows), 384).astype(np.float32)
    return ons, vecs / np.linalg.norm(vecs, axis=1, keepdims=True)


def load_gemma(kind: str) -> tuple[np.ndarray, np.ndarray]:
    d = np.load(CORPUS / f"text-{kind}.npz")
    return d["object_number"], d["vec"].astype(np.float32)


def e5_queries(model: str, qs: list[str]) -> np.ndarray:
    from sentence_transformers import SentenceTransformer
    m = SentenceTransformer(model, device="mps")
    return m.encode([f"query: {q}" for q in qs], normalize_embeddings=True)


def top(vecs: np.ndarray, ons: np.ndarray, q: np.ndarray, exclude: str | None = None) -> list[str]:
    scores = vecs @ q
    order = np.argpartition(-scores, K + 1)[:K + 1]
    ranked = [str(ons[i]) for i in order[np.argsort(-scores[order])]]
    return [on for on in ranked if on != exclude][:K]


def card_text(conn, on: str) -> str:
    row = conn.execute("SELECT title, creator_label, date_display, description_text, narrative_text "
                       "FROM artworks WHERE object_number = ?", (on,)).fetchone()
    if not row:
        return "(not in vocab DB)"
    title, creator, date, desc, narr = row
    parts = [f"**{title or '(untitled)'}** — {creator or '?'}, {date or '?'}"]
    if desc:
        parts.append(f"D: {desc[:350]}")
    if narr:
        parts.append(f"N: {narr[:250]}")
    return " ".join(parts).replace("\n", " ")


def pool() -> None:
    qd = np.load(OUT / "queries.npz")
    gq = dict(zip(qd["query"].tolist(), qd["vec"]))
    systems = {}
    print("loading vectors…")
    systems["e5-meta"] = load_e5("artwork_embeddings")
    systems["gemma-meta"] = load_gemma("metadata")
    systems["e5-desc"] = load_e5("desc_embeddings")
    systems["gemma-desc"] = load_gemma("description")
    e5m = dict(zip(TEXT_QUERIES, e5_queries("intfloat/multilingual-e5-small", TEXT_QUERIES)))
    e5d = dict(zip(TEXT_QUERIES, e5_queries("clips/e5-small-trm-nl", TEXT_QUERIES)))
    qvec = {"e5-meta": e5m, "e5-desc": e5d, "gemma-meta": gq, "gemma-desc": gq}

    rankings = {}
    for q in TEXT_QUERIES:
        rankings[q] = {s: top(v, o, qvec[s][q]) for s, (o, v) in systems.items()}
    for seed in SEED_OBJECTS:
        r = {}
        for s in ("e5-desc", "gemma-desc"):
            ons, vecs = systems[s]
            hit = np.where(ons == seed)[0]
            r[s] = top(vecs, ons, vecs[hit[0]], exclude=seed) if len(hit) else []
        rankings[f"similar:{seed}"] = r
    (OUT / "rankings.json").write_text(json.dumps(rankings, indent=1))

    conn = sqlite3.connect(f"file:{VOCAB_DB}?mode=ro", uri=True)
    rng = random.Random(5)
    lines = ["# Blind pool (systems hidden)\n"]
    for q, r in rankings.items():
        items = sorted({on for ranked in r.values() for on in ranked})
        rng.shuffle(items)
        head = f"Similar to {q[8:]}: {card_text(conn, q[8:])}" if q.startswith("similar:") else f"Query: “{q}”"
        lines.append(f"\n## {head}\n")
        lines += [f"- `{on}` {card_text(conn, on)}" for on in items]
    conn.close()
    (OUT / "pool.md").write_text("\n".join(lines))
    n = sum(len({on for ranked in r.values() for on in ranked}) for r in rankings.values())
    print(f"pool.md: {len(rankings)} queries, {n} items to grade")


def score() -> None:
    rankings = json.loads((OUT / "rankings.json").read_text())
    grades = json.loads((OUT / "grades.json").read_text())

    def ndcg(ranked: list[str], g: dict) -> float:
        dcg = sum(g.get(on, 0) / np.log2(i + 2) for i, on in enumerate(ranked))
        ideal = sorted(g.values(), reverse=True)[:K]
        idcg = sum(v / np.log2(i + 2) for i, v in enumerate(ideal))
        return dcg / idcg if idcg else 0.0

    rows = []
    for q, r in rankings.items():
        g = grades.get(q, {})
        for s, ranked in r.items():
            if ranked:
                p = np.mean([g.get(on, 0) >= 1 for on in ranked])
                rows.append((q, s, p, np.mean([g.get(on, 0) == 2 for on in ranked]), ndcg(ranked, g)))
    for label, pred in (("text queries", lambda q: not q.startswith("similar:")),
                        ("item→item (descriptions)", lambda q: q.startswith("similar:"))):
        print(f"\n{label}: P@{K} (≥partly) / strict P@{K} (yes) / nDCG@{K}")
        for s in ("e5-meta", "gemma-meta", "e5-desc", "gemma-desc"):
            sel = [x for x in rows if x[1] == s and pred(x[0])]
            if sel:
                print(f"  {s:11} {np.mean([x[2] for x in sel]):.2f} / {np.mean([x[3] for x in sel]):.2f} / "
                      f"{np.mean([x[4] for x in sel]):.3f}  (n={len(sel)})")
    print("\nper query nDCG (e5-meta, gemma-meta, e5-desc, gemma-desc):")
    for q in rankings:
        vals = {x[1]: x[4] for x in rows if x[0] == q}
        print("  " + "  ".join(f"{vals[s]:.2f}" if s in vals else "  - " for s in
                               ("e5-meta", "gemma-meta", "e5-desc", "gemma-desc")) + f"  {q}")


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    step = sys.argv[1] if len(sys.argv) > 1 else ""
    if step == "queries":
        (OUT / "queries.json").write_text(json.dumps(TEXT_QUERIES, ensure_ascii=False, indent=1))
    elif step == "pool":
        pool()
    elif step == "score":
        score()
    else:
        sys.exit(__doc__)
