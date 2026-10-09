"""Trim an XLM-R-tokenizer e5 ONNX model (multilingual-e5-small/-base) to the vocabulary we need.

The query model's RAM is dominated by its 250K-piece vocabulary (transformers.js tokenizer
trie + the word-embedding table), not the transformer. Dropping pieces never used by our
corpus or our users' query languages shrinks both while leaving every retained piece's
weights untouched. Unigram segmentation picks the best-scoring path, so any text whose
full-vocab segmentation uses only kept pieces tokenizes — and embeds — identically: the
stored document vectors stay valid with no re-embedding. Other text re-segments into
smaller kept pieces; single-character pieces are always kept so nothing becomes <unk>.

Keep-set = specials + every single-character piece + pieces used by --corpus SQL queries
+ pieces of the top --words-per-lang words (wordfreq) in each --langs language.

Usage (embeddings conda env or `uv run --with onnx --with numpy --with tokenizers --with wordfreq`):
  python scripts/trim-embedding-vocab.py \
    --model Xenova/multilingual-e5-small --out build/e5-small-trim \
    --corpus "data/vocabulary.db::SELECT title_all_text FROM artworks" \
    --langs en,nl,de,fr,es,it,pl --words-per-lang 30000
"""
import argparse, collections, json, os, shutil, sqlite3, sys

import numpy as np
import onnx
from onnx import numpy_helper
from tokenizers import Tokenizer

EMBED_INIT = "embeddings.word_embeddings.weight_quantized"
ONNX_REL = "onnx/model_quantized.onnx"
COPY_FILES = ["config.json", "tokenizer_config.json", "special_tokens_map.json"]


def resolve_model_dir(model: str) -> str:
    if os.path.isdir(model):
        return model
    from huggingface_hub import snapshot_download
    return snapshot_download(model, allow_patterns=["*.json", ONNX_REL])


def collect_ids(tok: Tokenizer, texts, counter: collections.Counter, batch=8192):
    buf = []
    for t in texts:
        if t:
            buf.append(t)
        if len(buf) >= batch:
            for enc in tok.encode_batch(buf, add_special_tokens=False):
                counter.update(enc.ids)
            buf.clear()
    for enc in tok.encode_batch(buf, add_special_tokens=False):
        counter.update(enc.ids)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", required=True, help="HF id or local dir containing tokenizer.json + onnx/model_quantized.onnx")
    ap.add_argument("--out", required=True)
    ap.add_argument("--corpus", action="append", default=[], help='"path/to.db::SELECT text_col FROM …" (repeatable)')
    ap.add_argument("--langs", default="en,nl,de,fr,es,it,pl", help="wordfreq language codes")
    ap.add_argument("--words-per-lang", type=int, default=30000)
    ap.add_argument("--langs-secondary", default="", help="wordfreq codes kept at a smaller depth")
    ap.add_argument("--words-secondary", type=int, default=10000)
    ap.add_argument("--extra", action="append", default=["query: ", "passage: "], help="literal strings to keep")
    args = ap.parse_args()

    src = resolve_model_dir(args.model)
    tok = Tokenizer.from_file(f"{src}/tokenizer.json")
    tj = json.load(open(f"{src}/tokenizer.json", encoding="utf-8"))
    if tj["model"]["type"] != "Unigram":
        sys.exit(f"expected a Unigram tokenizer, got {tj['model']['type']}")
    vocab = tj["model"]["vocab"]  # list of [piece, score]; id = position
    V = len(vocab)

    keep = {t["id"] for t in tj.get("added_tokens", [])} | {tj["model"]["unk_id"]}
    keep |= {i for i, (piece, _) in enumerate(vocab) if len(piece.lstrip("▁")) <= 1}
    n_single = len(keep)

    corpus = collections.Counter()
    for spec in args.corpus:
        dbp, sql = spec.split("::", 1)
        db = sqlite3.connect(f"file:{dbp}?mode=ro", uri=True)
        collect_ids(tok, (r[0] for r in db.execute(sql)), corpus)
        print(f"  corpus {sql[:70]!r}: {len(corpus):,} distinct pieces so far", flush=True)
    collect_ids(tok, args.extra, corpus)

    words = collections.Counter()
    for langs, n in ((args.langs, args.words_per_lang), (args.langs_secondary, args.words_secondary)):
        if not langs:
            continue
        from wordfreq import top_n_list
        for lang in langs.split(","):
            ws = top_n_list(lang, n)
            # Both word-initial ("▁word") and mid-compound forms occur in queries.
            collect_ids(tok, ws + [" " + w for w in ws] + [w.capitalize() for w in ws], words)
        print(f"  wordfreq {langs} × {n:,}: {len(words):,} distinct pieces so far", flush=True)

    keep |= set(corpus) | set(words)
    keep = sorted(keep)
    remap = {o: n for n, o in enumerate(keep)}
    print(f"keep {len(keep):,} of {V:,} pieces (single-char/specials {n_single:,}, corpus {len(corpus):,}, words {len(words):,})")

    tj["model"]["vocab"] = [vocab[o] for o in keep]
    tj["model"]["unk_id"] = remap[tj["model"]["unk_id"]]
    for t in tj.get("added_tokens", []):
        t["id"] = remap[t["id"]]

    def fix_post(p):
        if not p:
            return
        for v in (p.get("special_tokens") or {}).values():
            v["ids"] = [remap[i] for i in v["ids"]]
        for k in ("sep", "cls"):
            if k in p:
                p[k] = [p[k][0], remap[p[k][1]]]
        for q in p.get("processors") or []:
            fix_post(q)
    fix_post(tj.get("post_processor"))

    os.makedirs(f"{args.out}/onnx", exist_ok=True)
    with open(f"{args.out}/tokenizer.json", "w", encoding="utf-8") as f:
        json.dump(tj, f, ensure_ascii=False)
    for name in COPY_FILES:
        if os.path.exists(f"{src}/{name}"):
            shutil.copy(f"{src}/{name}", f"{args.out}/{name}")
    cfg = json.load(open(f"{args.out}/config.json"))
    cfg["vocab_size"] = len(keep)
    for k in ("bos_token_id", "eos_token_id", "pad_token_id"):
        if cfg.get(k) is not None:
            cfg[k] = remap[cfg[k]]
    json.dump(cfg, open(f"{args.out}/config.json", "w"), indent=2)

    m = onnx.load(f"{src}/{ONNX_REL}")
    hit = [i for i, t in enumerate(m.graph.initializer) if t.name == EMBED_INIT]
    if len(hit) != 1:
        sys.exit(f"initializer {EMBED_INIT} not found exactly once")
    t = m.graph.initializer[hit[0]]
    # The table may be padded past the tokenizer (e5: 250,037 rows vs 250,002 pieces).
    if t.dims[0] < V:
        sys.exit(f"{EMBED_INIT} has {t.dims[0]} rows, tokenizer has {V} pieces")
    rows = numpy_helper.to_array(t)[np.array(keep)]
    m.graph.initializer[hit[0]].CopyFrom(numpy_helper.from_array(rows, EMBED_INIT))
    onnx.save(m, f"{args.out}/{ONNX_REL}")

    with open(f"{args.out}/trim_manifest.json", "w") as f:
        json.dump({"source": args.model, "kept": len(keep), "original": V, "corpus": args.corpus,
                   "langs": args.langs, "words_per_lang": args.words_per_lang,
                   "langs_secondary": args.langs_secondary, "words_secondary": args.words_secondary,
                   "kept_ids": keep}, f)
    mb = lambda p: os.path.getsize(p) / 2**20
    print(f"wrote {args.out}: onnx {mb(f'{args.out}/{ONNX_REL}'):.0f} MB, tokenizer.json {mb(f'{args.out}/tokenizer.json'):.1f} MB")


if __name__ == "__main__":
    main()
