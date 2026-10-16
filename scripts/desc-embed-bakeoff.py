#!/usr/bin/env python3
"""
Bake-off of embedding models for the Dutch description corpus (find_similar's Description channel).

All models embed the same random sample of descriptions, so rankings compare within one sub-corpus.

    PY sample              # sample.json: 100K descriptions + item seeds + text queries
    PY encode <model-key>  # vecs-<key>.npz (docs + queries); 'gemma2' subsets the full-corpus vectors
    PY proxy               # Iconclass agreement of item→item neighbours, all encoded models
    PY pool                # pool.json + judge-NN.md: top-5 per model, shuffled, systems hidden
    PY score               # reads grades-*.json {item_id: {object_number: 0|1|2}} → nDCG@5 per model

PY = a venv with transformers==5.19.0 sentence-transformers==6.1.0 (the versions gemma.db was built with).
Outputs in gitignored data/egemma2-test/desc-bakeoff/.
"""

import json
import random
import sqlite3
import sys
import time
from pathlib import Path

import numpy as np

PROJECT_DIR = Path(__file__).resolve().parent.parent
VOCAB_DB = PROJECT_DIR / "data" / "vocabulary.db"
GEMMA_DESC = PROJECT_DIR / "data" / "egemma2-test" / "corpus" / "text-description.npz"
OUT = PROJECT_DIR / "data" / "egemma2-test" / "desc-bakeoff"
N_SAMPLE = 100_000
N_PROXY_SEEDS = 2000
N_JUDGED_SEEDS = 25
K_POOL = 5
K_PROXY = 10

# key → (hf id, doc prefix/prompt, query prefix/prompt, max_seq_length). prompt_name:<x> uses the model's own prompt.
MODELS = {
    "e5-small-trm-nl": ("clips/e5-small-trm-nl", "passage: ", "query: ", 512),
    "e5-base-trm-nl": ("clips/e5-base-trm-nl", "passage: ", "query: ", 512),
    "e5-large-trm-nl": ("clips/e5-large-trm-nl", "passage: ", "query: ", 512),
    "robbert-2022-st": ("NetherlandsForensicInstitute/robbert-2022-dutch-sentence-transformers", "", "", 512),
    "bge-m3": ("BAAI/bge-m3", "", "", 512),
    "me5-large-instruct": ("intfloat/multilingual-e5-large-instruct", "",
                           "Instruct: Given a search query, retrieve museum catalogue descriptions of matching artworks\nQuery: ", 512),
    "arctic-l-v2": ("Snowflake/snowflake-arctic-embed-l-v2.0", "", "prompt_name:query", 512),
    "qwen3-0.6b": ("Qwen/Qwen3-Embedding-0.6B", "",
                   "Instruct: Given a search query, retrieve museum catalogue descriptions of matching artworks\nQuery:", 512),
    "gemma2": ("google/embeddinggemma-2", None, None, 1024),  # docs from the full-corpus run; queries via encode_query
}

QUERIES = [
    "schaatsers op een bevroren rivier",
    "vrouw die een brief leest bij het raam",
    "schip in storm op zee",
    "kinderen die spelen op straat",
    "stilleven met bloemen in een vaas",
    "portret van een man met een plooikraag",
    "boerenbruiloft met dansende figuren",
    "gezicht op een stad vanaf het water",
    "beleg van een stad",
    "spotprent op de politiek",
    "allegorie op de vrede",
    "jachttafereel met honden",
    "interieur van een kerk",
    "walvisvangst",
    "woman reading a letter by a window",
    "horse market",
    "a city on fire at night",
    "ship being built in a shipyard",
    "soldiers plundering a village",
    "mother nursing a child",
]


def sample() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(f"file:{VOCAB_DB}?mode=ro", uri=True)
    rows = conn.execute("SELECT art_id, object_number, description_text FROM artworks "
                        "WHERE COALESCE(description_text, '') != '' ORDER BY art_id").fetchall()
    conn.close()
    rng = random.Random(7)
    rows = rng.sample(rows, N_SAMPLE)
    # Seeds: descriptions with enough substance to have meaningful neighbours.
    eligible = [i for i, r in enumerate(rows) if len(r[2]) >= 80]
    seeds = rng.sample(eligible, N_PROXY_SEEDS)
    data = {
        "art_id": [r[0] for r in rows],
        "object_number": [r[1] for r in rows],
        "text": [r[2] for r in rows],
        "proxy_seeds": seeds,
        "judged_seeds": seeds[:N_JUDGED_SEEDS],
        "queries": QUERIES,
    }
    (OUT / "sample.json").write_text(json.dumps(data, ensure_ascii=False))
    print(f"sample: {len(rows)} descriptions, {len(seeds)} proxy seeds, {len(QUERIES)} queries")


def load_sample() -> dict:
    return json.loads((OUT / "sample.json").read_text())


def encode(key: str) -> None:
    import torch
    from sentence_transformers import SentenceTransformer

    s = load_sample()
    hf_id, doc_p, query_p, max_len = MODELS[key]
    t0 = time.time()
    if key == "gemma2":
        full = np.load(GEMMA_DESC)
        pos = {int(a): i for i, a in enumerate(full["art_id"])}
        docs = full["vec"][[pos[a] for a in s["art_id"]]].astype(np.float32)
        docs /= np.linalg.norm(docs, axis=1, keepdims=True)
        m = SentenceTransformer(hf_id, device="mps", model_kwargs={"torch_dtype": torch.bfloat16})
        queries = m.encode_query(s["queries"], normalize_embeddings=True, convert_to_numpy=True)
    else:
        m = SentenceTransformer(hf_id, device="mps", model_kwargs={"torch_dtype": torch.float16})
        m.max_seq_length = max_len

        def enc(texts: list[str], p: str, bs: int) -> np.ndarray:
            if p.startswith("prompt_name:"):
                return m.encode(texts, prompt_name=p.split(":", 1)[1], batch_size=bs,
                                normalize_embeddings=True, convert_to_numpy=True)
            return m.encode([p + t for t in texts], batch_size=bs, normalize_embeddings=True,
                            convert_to_numpy=True, show_progress_bar=True)

        # Length-sorted batches keep padding (and MPS memory) down.
        order = np.argsort([len(t) for t in s["text"]])
        sorted_vecs = enc([s["text"][i] for i in order], doc_p, 64)
        docs = np.empty_like(sorted_vecs)
        docs[order] = sorted_vecs
        queries = enc(s["queries"], query_p, 32)
    np.savez(OUT / f"vecs-{key}.npz", docs=docs.astype(np.float16), queries=queries.astype(np.float16))
    print(f"{key}: {docs.shape} docs in {time.time() - t0:.0f}s")


def encoded() -> list[str]:
    return [k for k in MODELS if (OUT / f"vecs-{k}.npz").exists()]


def neighbours(docs: np.ndarray, texts: list[str], seed: int, k: int) -> list[int]:
    """Top-k by cosine, skipping the seed and verbatim-identical descriptions (series duplicates)."""
    scores = docs @ docs[seed]
    window = k + 1 + texts.count(texts[seed])
    cand = np.argpartition(-scores, window)[:window]
    out = []
    for i in cand[np.argsort(-scores[cand])]:
        if i != seed and texts[i] != texts[seed]:
            out.append(int(i))
            if len(out) == k:
                break
    return out


def proxy() -> None:
    s = load_sample()
    conn = sqlite3.connect(f"file:{VOCAB_DB}?mode=ro", uri=True)
    field = conn.execute("SELECT id FROM field_lookup WHERE name = 'subject'").fetchone()[0]
    ids = s["art_id"]
    notations: dict[int, set[str]] = {}
    for i in range(0, len(ids), 5000):
        chunk = ids[i:i + 5000]
        q = (f"SELECT m.artwork_id, v.notation FROM mappings m JOIN vocabulary v ON v.vocab_int_id = m.vocab_rowid "
             f"WHERE m.field_id = ? AND v.notation IS NOT NULL AND m.artwork_id IN ({','.join('?' * len(chunk))})")
        for a, n in conn.execute(q, [field, *chunk]):
            notations.setdefault(a, set()).add(n.split("(")[0])
    conn.close()
    seeds = [i for i in s["proxy_seeds"] if ids[i] in notations]
    print(f"proxy: {len(seeds)} seeds with Iconclass subjects; neighbours@{K_PROXY}, identical texts skipped\n")
    print(f"{'model':22} {'share':>7} {'any@10':>7} {'prefix5':>8}")
    for key in encoded():
        docs = np.load(OUT / f"vecs-{key}.npz")["docs"].astype(np.float32)
        share = anyhit = pref = 0.0
        for sd in seeds:
            nb = neighbours(docs, s["text"], sd, K_PROXY)
            mine = notations[ids[sd]]
            hits = [bool(notations.get(ids[n], set()) & mine) for n in nb]
            share += sum(hits) / len(nb)
            anyhit += any(hits)
            p5 = {x[:5] for x in mine}
            pref += sum(bool({x[:5] for x in notations.get(ids[n], set())} & p5) for n in nb) / len(nb)
        n = len(seeds)
        print(f"{key:22} {share / n:7.3f} {anyhit / n:7.3f} {pref / n:8.3f}")


def pool() -> None:
    s = load_sample()
    keys = encoded()
    vecs = {k: np.load(OUT / f"vecs-{k}.npz") for k in keys}
    items = []
    for sd in s["judged_seeds"]:
        items.append({"id": f"item-{s['object_number'][sd]}", "kind": "item", "seed": s["text"][sd],
                      "runs": {k: neighbours(vecs[k]["docs"].astype(np.float32), s["text"], sd, K_POOL) for k in keys}})
    for qi, q in enumerate(s["queries"]):
        runs = {}
        for k in keys:
            sc = vecs[k]["docs"].astype(np.float32) @ vecs[k]["queries"][qi].astype(np.float32)
            top = np.argpartition(-sc, K_POOL)[:K_POOL]
            runs[k] = [int(i) for i in top[np.argsort(-sc[top])]]
        items.append({"id": f"query-{qi:02d}", "kind": "query", "seed": q, "runs": runs})
    rng = random.Random(11)
    for it in items:
        cands = sorted({i for r in it["runs"].values() for i in r})
        rng.shuffle(cands)
        it["candidates"] = [{"object_number": s["object_number"][i], "text": s["text"][i][:1200]} for i in cands]
        it["runs"] = {k: [s["object_number"][i] for i in r] for k, r in it["runs"].items()}
    (OUT / "pool.json").write_text(json.dumps(items, ensure_ascii=False, indent=1))
    # Judge batches without system labels.
    batch = 5
    for b in range(0, len(items), batch):
        md = []
        for it in items[b:b + batch]:
            head = (f"## {it['id']}\nQUERY: {it['seed']}" if it["kind"] == "query"
                    else f"## {it['id']}\nSEED DESCRIPTION: {it['seed']}")
            md.append(head + "\n\n" + "\n".join(f"- [{c['object_number']}] {c['text']}" for c in it["candidates"]))
        (OUT / f"judge-{b // batch:02d}.md").write_text("\n\n".join(md))
    print(f"pool: {len(items)} items, {sum(len(i['candidates']) for i in items)} candidates, "
          f"{(len(items) + batch - 1) // batch} judge files")


def score() -> None:
    items = json.loads((OUT / "pool.json").read_text())
    grades: dict[str, dict[str, int]] = {}
    for f in sorted(OUT.glob("grades-*.json")):
        grades.update(json.loads(f.read_text()))
    ideal_cache = {}

    def ndcg(ranked: list[str], g: dict[str, int]) -> float:
        dcg = sum((2 ** g.get(o, 0) - 1) / np.log2(i + 2) for i, o in enumerate(ranked))
        ideal = sorted(g.values(), reverse=True)[:K_POOL]
        idcg = sum((2 ** v - 1) / np.log2(i + 2) for i, v in enumerate(ideal))
        return dcg / idcg if idcg else 0.0

    keys = list(items[0]["runs"].keys())
    missing = [it["id"] for it in items if it["id"] not in grades]
    if missing:
        print(f"ungraded items: {missing}")
    print(f"{'model':22} {'item nDCG':>10} {'item P':>7} {'query nDCG':>11} {'query P':>8} {'all nDCG':>9}")
    for k in keys:
        res = {"item": [], "query": []}
        prec = {"item": [], "query": []}
        for it in items:
            g = grades.get(it["id"])
            if g is None:
                continue
            r = it["runs"][k]
            res[it["kind"]].append(ndcg(r, g))
            prec[it["kind"]].append(sum(g.get(o, 0) >= 1 for o in r) / len(r))
        allv = res["item"] + res["query"]
        print(f"{k:22} {np.mean(res['item']):10.3f} {np.mean(prec['item']):7.2f} "
              f"{np.mean(res['query']):11.3f} {np.mean(prec['query']):8.2f} {np.mean(allv):9.3f}")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "sample":
        sample()
    elif cmd == "encode":
        encode(sys.argv[2])
    elif cmd == "proxy":
        proxy()
    elif cmd == "pool":
        pool()
    elif cmd == "score":
        score()
    else:
        sys.exit(__doc__)
