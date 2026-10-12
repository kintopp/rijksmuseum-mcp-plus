#!/usr/bin/env python3
"""
Feasibility probe: text→image and image→image search with google/embeddinggemma-2.

Phase 1 (local):  Sample N random images from the local IIIF corpus mirror
                  (/Volumes/sand/rijksmuseum-bucket/downloads/shard-NNN/*.jpg),
                  downscale, and join metadata from the vocab DB.
Phase 2 (Modal):  Embed images + text queries on an A10G (bf16, audio tower off).
Phase 3 (local):  Rank and write a self-contained HTML report (IIIF thumbnails).

Usage:
    ~/miniconda3/envs/embeddings/bin/modal run scripts/explore-embeddinggemma2-modal.py
    ... --n 1000 --seed 7 --queries "a ship in a storm;een hond" --image-queries 4

Re-running with the same --n/--seed reuses cached image vectors and only
embeds the text queries.

Output: data/egemma2-test/{vectors-n<N>-s<seed>.npz, report-n<N>-s<seed>.html}
"""

import html
import io
import json
import random
import re
import sqlite3
import sys
import time
from pathlib import Path

import modal
import numpy as np

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent
VOCAB_DB = PROJECT_DIR / "data" / "vocabulary.db"
OUT_DIR = PROJECT_DIR / "data" / "egemma2-test"
CORPUS = Path("/Volumes/sand/rijksmuseum-bucket")

MODEL_NAME = "google/embeddinggemma-2"
REVISION = "914f7f89142e33e77833254d9c9b90c3cef7303b"
# Each soft token is a 3×3 pool of 16-px patches (48² px); the processor resizes every image
# to about tokens × 48² px, so staging anything larger is wasted upload
SOFT_TOKENS = 280  # model default; the image processor allows up to 1120


def max_pixels(tokens: int) -> int:
    return int(tokens * 48 * 48 * 1.12)

CHUNK = 128
TOP_K = 12

DEFAULT_QUERIES = [
    "a ship in a storm at sea",
    "portrait of a woman wearing a pearl necklace",
    "winter landscape with skaters on the ice",
    "een hond",  # Dutch: a dog
    "botanical illustration of a flower",
    "map of a city",
    "Japanese woodblock print",
    "crucifixion of Christ",
]

# --benchmark: planted targets hidden among random distractors.
# (query, target object numbers, proxy-relevance regex over Dutch title + creator).
# The regex credits distractors that genuinely match, so precision@10 is a lower bound.
TEXT_BENCH = [
    ("a ship crashing onto rocks during a storm", ["RP-P-1907-4040"], r"storm|schipbreuk"),
    ("ship in a storm held with ropes by men on the shore", ["RP-D-2002-17"], r"storm|schipbreuk"),
    ("winter landscape with ice skaters", ["SK-A-1718"], r"schaats|winter|\bijs"),
    ("farmhouse by a frozen river with skaters", ["RP-P-1944-747"], r"schaats|bevroren|\bijs"),
    ("a cat and a dog dancing", ["RP-T-1898-A-4058"], r"\bkat\b|\bhond"),
    ("fable of the old cat and the mice", ["RP-P-OB-5239"], r"\bkat\b|muis|muizen"),
    ("map of Friesland", ["RP-P-AO-2-22"], r"kaart|plattegrond"),
    ("map of Palestine", ["RP-P-OB-102.616"], r"kaart|plattegrond"),
    ("map of Japan", ["NG-501-87"], r"kaart|plattegrond"),
    ("still life with books", ["SK-A-4090"], r"stilleven"),
    ("lidded vase", ["BK-1965-104"], r"vaas|\bpot\b"),
    ("naval battle with warships firing cannons", ["RP-P-1905-1558"], r"zeeslag|zeegevecht"),
    ("the crucifixion of Christ", ["RP-P-OB-102.327"], r"kruisig|calvarie"),
    ("triumphal procession with elephants", ["RP-P-2016-671-107"], r"olifant|triomf"),
    ("interior of a church", ["RP-P-OB-24.590"], r"kerkinterieur|interieur van de"),
    ("a teapot", ["BK-17511"], r"theepot"),
    ("a silver teapot", ["NG-1991-8-2"], r"theepot"),
    ("equestrian portrait of a man in armour", ["RP-P-1906-3429"], r"ruiter|te paard|harnas"),
    ("a skeleton wearing armour, allegory of death", ["RP-P-2015-52-1"], r"skelet|\bdood\b"),
    ("a dollhouse", ["BK-NM-1010", "SK-A-4245"], r"poppenhuis"),
    ("a maid pouring milk in a kitchen", ["SK-A-2344"], r"melk|keuken"),
    ("militia company with muskets and a drum", ["SK-C-5"], r"schutter|militie"),
    # artist / style queries — the fine-tuning guide shows these are a known weak spot
    ("a painting by Rembrandt", ["SK-C-5", "SK-C-6", "SK-A-4885", "SK-C-597", "SK-A-4050"], r"rembrandt"),
    ("a painting by Vermeer", ["SK-A-2344", "SK-A-1595", "SK-A-2860", "SK-C-251"], r"vermeer"),
    ("Japanese woodblock print", ["RP-P-OB-JAP-3", "RP-P-OB-JAP-4", "RP-P-OB-JAP-5", "RP-P-OB-JAP-7"],
     r"hiroshige|hokusai|utagawa|kunisada|kuniyoshi|utamaro"),
]
# (query object, its counterpart): pendants, same series, or the same object in another medium
IMAGE_BENCH = [
    ("RP-P-1905-1558", "RP-P-1905-1559"),
    ("RP-P-1907-4040", "RP-P-1907-4041"),
    ("RP-P-2016-693-24", "RP-P-2016-693-21"),
    ("RP-P-2016-671-107", "RP-P-2016-671-106"),
    ("RP-P-OB-15.850", "RP-P-OB-15.849"),
    ("BK-NM-1010", "SK-A-4245"),  # Oortman dollhouse ↔ painting of it
]

# ─── Modal app ──────────────────────────────────────────────────────────

app = modal.App("rijksmuseum-egemma2-probe")
# Large image sets go through a Volume (`modal volume put`): streaming GBs as function
# inputs saturates the uplink and the app's heartbeat times out
POOL_VOLUME = "egemma2-pool"
pool_vol = modal.Volume.from_name(POOL_VOLUME, create_if_missing=True)


def download_model():
    from sentence_transformers import SentenceTransformer
    SentenceTransformer(MODEL_NAME, revision=REVISION, config_kwargs={"audio_config": None})


gpu_image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        # transformers 5.19.0 is the first release with EmbeddingGemma2
        "transformers==5.19.0",
        "sentence-transformers==6.1.0",
        "torch==2.10.0",
        "torchvision==0.25.0",
        "pillow",
        "numpy",
    )
    .run_function(download_model, secrets=[modal.Secret.from_name("huggingface-secret")])
    .env({"HF_HUB_OFFLINE": "1"})  # weights are baked in; skip runtime Hub calls
)


@app.cls(gpu="A10G", image=gpu_image, scaledown_window=60, timeout=1800, max_containers=10,
         volumes={"/pool": pool_vol},
         secrets=[modal.Secret.from_name("huggingface-secret")])
class Embedder:
    tokens: int = modal.parameter(default=SOFT_TOKENS)

    @modal.enter()
    def load(self):
        import torch
        from sentence_transformers import SentenceTransformer
        # bf16, never fp16: the model's activations overflow fp16 into NaNs
        self.model = SentenceTransformer(
            MODEL_NAME,
            revision=REVISION,
            device="cuda",
            config_kwargs={"audio_config": None},
            model_kwargs={"torch_dtype": torch.bfloat16},
        )
        if self.tokens != SOFT_TOKENS:
            proc = self.model[0].processor
            proc.image_processor.max_soft_tokens = self.tokens
            proc.image_processor.image_seq_length = self.tokens
            proc.image_seq_length = self.tokens

    @modal.method()
    def check_tokens(self, jpeg: bytes) -> str:
        """Report the processor's settings and the patch grid it produces for one image."""
        from PIL import Image
        proc = self.model[0].processor
        im = Image.open(io.BytesIO(jpeg)).convert("RGB")
        feats = self.model[0].preprocess([{"image": im}])
        shapes = {k: tuple(v.shape) for k, v in feats.items() if hasattr(v, "shape")}
        return (f"requested {self.tokens}; image_processor.max_soft_tokens="
                f"{proc.image_processor.max_soft_tokens}, image_seq_length={proc.image_seq_length}; "
                f"input {im.size}; features {shapes}")

    @modal.method()
    def embed_files(self, names: list[str]) -> tuple[np.ndarray, float]:
        return self.embed_images.local([Path(f"/pool/{n}").read_bytes() for n in names])

    @modal.method()
    def embed_images(self, jpegs: list[bytes]) -> tuple[np.ndarray, float]:
        from PIL import Image
        imgs = [Image.open(io.BytesIO(b)).convert("RGB") for b in jpegs]
        t0 = time.time()
        vecs = self.model.encode(
            [{"image": im} for im in imgs],
            batch_size=32,
            normalize_embeddings=True,
            convert_to_numpy=True,
        )
        return vecs.astype(np.float32), time.time() - t0

    @modal.method()
    def diagnose(self, jpegs: list[bytes], captions: list[str]) -> str:
        """Caption↔image matrix under bf16 vs fp32, plus a blank-image control."""
        import torch
        from PIL import Image
        from sentence_transformers import SentenceTransformer
        imgs = [Image.open(io.BytesIO(b)).convert("RGB") for b in jpegs]
        imgs.append(Image.new("RGB", (512, 512), "white"))
        out = []
        fp32 = SentenceTransformer(MODEL_NAME, revision=REVISION, device="cuda", config_kwargs={"audio_config": None})
        for name, m in (("bf16", self.model), ("fp32", fp32)):
            iv = m.encode([{"image": im} for im in imgs], normalize_embeddings=True, convert_to_numpy=True)
            for label, tv in (
                ("encode_query", m.encode_query(captions, normalize_embeddings=True, convert_to_numpy=True)),
                ("SearchQuery", m.encode(captions, prompt_name="SearchQuery", normalize_embeddings=True, convert_to_numpy=True)),
                ("no prompt", m.encode(captions, normalize_embeddings=True, convert_to_numpy=True)),
            ):
                out.append(f"--- {name} / {label}: rows=captions, cols=images (+blank)")
                out.append(np.array2string(tv @ iv.T, precision=3, suppress_small=True))
            out.append(f"--- {name} image↔image")
            out.append(np.array2string(iv @ iv.T, precision=3))
        out.append(f"prompts: {self.model.prompts}")
        out.append(f"default_prompt_name: {self.model.default_prompt_name}")
        return "\n".join(out)

    @modal.method()
    def embed_queries(self, texts: list[str]) -> np.ndarray:
        vecs = self.model.encode_query(texts, normalize_embeddings=True, convert_to_numpy=True)
        return vecs.astype(np.float32)


# ─── Local helpers ──────────────────────────────────────────────────────

def sample_images(n: int, seed: int) -> list[dict]:
    """Random sample across shards; skips IIIF ids that collide case-insensitively
    (the local mirror sits on a case-insensitive volume, so those files are ambiguous)."""
    rng = random.Random(seed)
    shards = sorted((CORPUS / "state").glob("shard-*.state.json"))
    rng.shuffle(shards)
    per_shard = max(1, n // 20)
    picked: list[dict] = []
    for sf in shards:
        if len(picked) >= n:
            break
        expected = json.loads(sf.read_text())["expected"]
        lower_counts: dict[str, int] = {}
        for iid in expected:
            lower_counts[iid.lower()] = lower_counts.get(iid.lower(), 0) + 1
        shard_dir = CORPUS / "downloads" / sf.name.replace(".state.json", "")
        ids = [i for i in expected if lower_counts[i.lower()] == 1 and (shard_dir / f"{i}.jpg").exists()]
        for iid in rng.sample(ids, min(per_shard, len(ids), n - len(picked))):
            picked.append({"iiif_id": iid, "path": str(shard_dir / f"{iid}.jpg"), **expected[iid]})
    return picked


def load_jpeg(path: str, tokens: int = SOFT_TOKENS) -> bytes:
    from PIL import Image
    im = Image.open(path).convert("RGB")
    scale = (max_pixels(tokens) / (im.width * im.height)) ** 0.5
    if scale < 1:
        im = im.resize((round(im.width * scale), round(im.height * scale)), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=85)
    return buf.getvalue()


def attach_metadata(items: list[dict]) -> None:
    conn = sqlite3.connect(f"file:{VOCAB_DB}?mode=ro", uri=True)
    # by object_number: the mirror's art_ids come from an older harvest and no longer line up
    q = "SELECT title, creator_label, date_display FROM artworks WHERE object_number = ?"
    for it in items:
        row = conn.execute(q, (it["object_number"],)).fetchone() or (None, None, None)
        it["title"], it["creator"], it["date"] = row
    conn.close()


def card(it: dict, rank: int, score: float, hit: bool = False) -> str:
    thumb = f"https://iiif.micr.io/{it['iiif_id']}/full/!600,600/0/default.jpg"
    link = f"https://www.rijksmuseum.nl/en/collection/{it['object_number']}"
    title = html.escape((it.get("title") or "(untitled)")[:90])
    sub = html.escape(" · ".join(x for x in (it.get("creator"), it.get("date")) if x)[:80])
    return (
        f'<a class="{"card hit" if hit else "card"}" href="{link}" target="_blank" rel="noopener">'
        f'<img loading="lazy" src="{thumb}" alt="">'
        f'<div class="meta"><b>#{rank}</b> <span class="score">{score:.3f}</span><br>'
        f'{title}<br><small>{sub}</small><br><small class="on">{html.escape(it["object_number"])}</small></div></a>'
    )


def write_report(path: Path, sections: list[tuple], info: str) -> None:
    """sections: (heading, head_html, ranked[(item, score)], optional set of target object numbers)"""
    body = []
    for heading, head_html, ranked, *rest in sections:
        targets = rest[0] if rest else set()
        cards = "".join(card(it, r + 1, s, it["object_number"] in targets) for r, (it, s) in enumerate(ranked))
        body.append(f"<section><h2>{heading}</h2>{head_html}<div class='grid'>{cards}</div></section>")
    path.write_text(f"""<!doctype html><meta charset="utf-8">
<title>EmbeddingGemma 2 probe</title>
<style>
body{{font:14px system-ui,sans-serif;margin:0 auto;max-width:1600px;padding:16px;background:#f7f7f5;color:#222}}
h1{{font-size:20px}} h2{{font-size:16px;margin:28px 0 8px;border-bottom:1px solid #ccc;padding-bottom:4px}}
.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:10px}}
.card{{background:#fff;border:1px solid #ddd;border-radius:6px;overflow:hidden;color:inherit;text-decoration:none}}
.card img{{width:100%;aspect-ratio:1;object-fit:contain;background:#eee}}
.meta{{padding:6px 8px;font-size:12px;line-height:1.35}} .score{{color:#0a7}} .on{{color:#888}}
.qimg{{max-height:220px;border:3px solid #0a7;border-radius:6px}}
.card.hit{{border:3px solid #e07b00}} table{{border-collapse:collapse;font-size:13px}}
td,th{{border-bottom:1px solid #ddd;padding:3px 10px;text-align:left}} td.n{{text-align:right}}
</style>
<h1>EmbeddingGemma 2 — Rijksmuseum probe</h1>{info}
{''.join(body)}""")


def stage_dir(cache: Path) -> Path:
    return cache.with_suffix(".jpegs")  # files named by art_id: IIIF ids collide on case-insensitive disks


def stage_and_upload(items: list[dict], cache: Path, tokens: int = SOFT_TOKENS) -> None:
    """Run outside `modal run` (plain python), so the upload can't starve an app heartbeat."""
    import subprocess
    from concurrent.futures import ThreadPoolExecutor
    stage = stage_dir(cache)
    stage.mkdir(parents=True, exist_ok=True)

    def write(it: dict) -> None:
        f = stage / f"{it['art_id']}.jpg"
        if not f.exists():
            f.write_bytes(load_jpeg(it["path"], tokens))

    t0 = time.time()
    with ThreadPoolExecutor(8) as ex:
        list(ex.map(write, items))
    print(f"Staged {len(items)} JPEGs in {time.time() - t0:.0f}s; uploading to Volume {POOL_VOLUME}…")
    t0 = time.time()
    modal_cli = Path(sys.executable).parent / "modal"
    # create_if_missing only applies inside a running app, not to `volume put`
    subprocess.run([str(modal_cli), "volume", "create", POOL_VOLUME], capture_output=True)
    subprocess.run([str(modal_cli), "volume", "put", "--force", POOL_VOLUME, str(stage), f"/{stage.name}"], check=True)
    (stage / ".uploaded").touch()
    print(f"Uploaded in {time.time() - t0:.0f}s")


def embed_via_volume(embedder, items: list[dict], cache: Path) -> tuple[np.ndarray, float | None]:
    if cache.exists():
        print(f"Reusing cached image vectors: {cache.name}")
        return np.load(cache)["img"], None
    stage = stage_dir(cache)
    if not (stage / ".uploaded").exists():
        sys.exit(f"Stage and upload first: python {Path(__file__).name} stage --n … --seed …")
    names = [f"{stage.name}/{it['art_id']}.jpg" for it in items]
    chunks = [names[i:i + CHUNK] for i in range(0, len(names), CHUNK)]
    t0 = time.time()
    results = list(embedder.embed_files.map(chunks))
    vecs = np.concatenate([r[0] for r in results])
    gpu_s = sum(r[1] for r in results)
    print(f"Embedded images: wall {time.time() - t0:.0f}s, GPU encode {gpu_s:.0f}s "
          f"→ {len(items) / gpu_s:.1f} img/s per A10G")
    np.savez(cache, img=vecs)
    return vecs, gpu_s


def embed_items(embedder, items: list[dict], cache: Path) -> tuple[np.ndarray, float | None]:
    """Chunks are saved as they finish, so a run cut off by a dropped connection resumes."""
    if cache.exists():
        print(f"Reusing cached image vectors: {cache.name}")
        return np.load(cache)["img"], None
    parts = cache.with_suffix(".parts")
    parts.mkdir(exist_ok=True)
    spans = [(i, i + CHUNK) for i in range(0, len(items), CHUNK)]
    todo = [k for k in range(len(spans)) if not (parts / f"{k:05d}.npy").exists()]
    print(f"{len(spans) - len(todo)}/{len(spans)} chunks already embedded")

    def load_chunk(k: int) -> tuple[int, list[bytes]]:
        a, b = spans[k]
        return k, [load_jpeg(it["path"]) for it in items[a:b]]

    gpu_s, t0 = 0.0, time.time()
    if todo:
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(8) as ex:
            loaded = dict(ex.map(load_chunk, todo))
        print(f"Downscaled {len(todo)} chunks in {time.time() - t0:.0f}s "
              f"({sum(len(b) for c in loaded.values() for b in c) / 1e6:.0f} MB to upload)")
        t0 = time.time()
        for k, (vecs, secs) in zip(todo, embedder.embed_images.map([loaded[k] for k in todo])):
            np.save(parts / f"{k:05d}.npy", vecs)
            gpu_s += secs
        print(f"Embedded images: wall {time.time() - t0:.0f}s, GPU encode {gpu_s:.0f}s "
              f"→ {sum(spans[k][1] - spans[k][0] for k in todo) / gpu_s:.1f} img/s per A10G")
    vecs = np.concatenate([np.load(parts / f"{k:05d}.npy") for k in range(len(spans))])
    np.savez(cache, img=vecs)
    return vecs, gpu_s or None


def locate(object_numbers: list[str]) -> list[dict]:
    conn = sqlite3.connect(f"file:{VOCAB_DB}?mode=ro", uri=True)
    shard_dirs = sorted((CORPUS / "downloads").glob("shard-*"))
    found = []
    for on in object_numbers:
        row = conn.execute("SELECT art_id, iiif_id FROM artworks WHERE object_number = ?", (on,)).fetchone()
        if not row or not row[1]:
            print(f"  ! {on}: no iiif_id in vocab DB")
            continue
        path = next((d / f"{row[1]}.jpg" for d in shard_dirs if (d / f"{row[1]}.jpg").exists()), None)
        if not path:
            print(f"  ! {on}: {row[1]}.jpg not in local mirror")
            continue
        found.append({"iiif_id": row[1], "path": str(path), "art_id": row[0], "object_number": on})
    conn.close()
    return found


def truncate(v: np.ndarray, d: int) -> np.ndarray:
    t = v[..., :d]
    return t / np.linalg.norm(t, axis=-1, keepdims=True)


def run_benchmark(embedder, n: int, seed: int) -> None:
    planted_ons = sorted({on for _, ts, _ in TEXT_BENCH for on in ts} | {on for pair in IMAGE_BENCH for on in pair})
    planted = locate(planted_ons)
    planted_set = {p["object_number"] for p in planted}
    distractors = [d for d in sample_images(n, seed) if d["object_number"] not in planted_set]
    items = planted + distractors
    attach_metadata(items)
    print(f"Benchmark corpus: {len(planted)} planted + {len(distractors)} distractors")

    vecs, gpu_s = embed_items(embedder, items, OUT_DIR / f"bench-vectors-n{n}-s{seed}.npz")
    idx = {it["object_number"]: i for i, it in enumerate(items)}
    q_vecs = embedder.embed_queries.remote([q for q, _, _ in TEXT_BENCH])

    def rank_of(scores: np.ndarray, targets: list[str]) -> int:
        order = np.argsort(-scores)
        pos = {int(i): r for r, i in enumerate(order)}
        return min(pos[idx[t]] for t in targets if t in idx) + 1

    rows, sections = [], []
    for (q, targets, rel), qv in zip(TEXT_BENCH, q_vecs):
        targets = [t for t in targets if t in idx]
        if not targets:
            continue
        s768, s256 = vecs @ qv, truncate(vecs, 256) @ truncate(qv, 256)
        top = np.argsort(-s768)[:10]
        pat = re.compile(rel, re.I)
        p10 = sum(1 for i in top if items[i]["object_number"] in targets
                  or pat.search(f"{items[i].get('title') or ''} {items[i].get('creator') or ''}")) / 10
        rows.append(("text", q, rank_of(s768, targets), rank_of(s256, targets), p10))
        sections.append((f"Text: “{html.escape(q)}”", "", [(items[i], float(s768[i])) for i in np.argsort(-s768)[:TOP_K]],
                         set(targets)))
    for a, b in IMAGE_BENCH:
        if a not in idx or b not in idx:
            continue
        s768 = vecs @ vecs[idx[a]]
        s256 = truncate(vecs, 256) @ truncate(vecs[idx[a]], 256)
        s768[idx[a]] = s256[idx[a]] = -np.inf
        rows.append(("image", f"{a} → {b}", rank_of(s768, [b]), rank_of(s256, [b]), None))
        q = items[idx[a]]
        head = (f"<img class='qimg' src='https://iiif.micr.io/{q['iiif_id']}/full/!800,800/0/default.jpg'>"
                f"<p>{html.escape(q.get('title') or '')} — {html.escape(a)}</p>")
        sections.append((f"Image → similar (target {html.escape(b)})", head,
                         [(items[i], float(s768[i])) for i in np.argsort(-s768)[:TOP_K]], {b}))

    def summary(kind: str, col: int) -> str:
        ranks = [r[col] for r in rows if r[0] == kind]
        return (f"R@1 {np.mean([r <= 1 for r in ranks]):.2f}  R@10 {np.mean([r <= 10 for r in ranks]):.2f}  "
                f"MRR {np.mean([1 / r for r in ranks]):.3f}  (n={len(ranks)})")

    lines = [f"{len(items)} images: {len(planted)} planted targets + {len(distractors)} random distractors (seed {seed}).",
             f"text→image 768d: {summary('text', 2)}", f"text→image 256d: {summary('text', 3)}",
             f"text→image proxy P@10 (lower bound): {np.mean([r[4] for r in rows if r[0] == 'text']):.2f}",
             f"image→image 768d: {summary('image', 2)}", f"image→image 256d: {summary('image', 3)}"]
    print("\n".join(lines))
    for kind, q, r768, r256, p10 in rows:
        print(f"  {kind:5} rank768={r768:<5} rank256={r256:<5} " + (f"P@10={p10:.1f} " if p10 is not None else "") + q)

    table = "".join(
        f"<tr><td>{k}</td><td>{html.escape(q)}</td><td class=n>{a}</td><td class=n>{b}</td>"
        f"<td class=n>{'' if p is None else f'{p:.1f}'}</td></tr>" for k, q, a, b, p in rows)
    info = ("".join(f"<p>{html.escape(l)}</p>" for l in lines)
            + "<p>Planted targets have an orange border. Rank = best target's rank among all images.</p>"
            + "<table><tr><th>kind</th><th>query</th><th>rank 768d</th><th>rank 256d</th><th>proxy P@10</th></tr>"
            + table + "</table>")
    out = OUT_DIR / f"bench-n{n}-s{seed}.html"
    write_report(out, sections, info)
    print(f"Report: {out}")


COMPARE_DIR = OUT_DIR / "compare"


def mirror_index() -> dict[str, dict]:
    """iiif_id → {path, art_id, object_number} for every unambiguous file in the local mirror."""
    index = {}
    for sf in sorted((CORPUS / "state").glob("shard-*.state.json")):
        expected = json.loads(sf.read_text())["expected"]
        lower: dict[str, int] = {}
        for iid in expected:
            lower[iid.lower()] = lower.get(iid.lower(), 0) + 1
        shard_dir = CORPUS / "downloads" / sf.name.replace(".state.json", "")
        for iid, meta in expected.items():
            if lower[iid.lower()] == 1:
                index[iid] = {"iiif_id": iid, "path": str(shard_dir / f"{iid}.jpg"), **meta}
    return index


def build_pool(n: int, seed: int) -> tuple[list[dict], list[dict], list[str]]:
    queries = json.loads((COMPARE_DIR / "queries.json").read_text())
    needed = {on for q in queries for ranked in q["systems"].values() for on in ranked}
    needed |= {q["query"] for q in queries if q["kind"] == "image"}

    conn = sqlite3.connect(f"file:{VOCAB_DB}?mode=ro", uri=True)
    iiif_of = {on: conn.execute("SELECT iiif_id FROM artworks WHERE object_number = ?", (on,)).fetchone()
               for on in needed}
    conn.close()
    index = mirror_index()
    by_on = {}
    missing = []
    for on, row in iiif_of.items():
        meta = index.get(row[0]) if row else None
        if meta and Path(meta["path"]).exists():
            by_on[on] = meta
        else:
            missing.append(on)
    for it in sample_images(n, seed):
        by_on.setdefault(it["object_number"], it)
    items = list(by_on.values())
    attach_metadata(items)
    print(f"Pool: {len(items)} images ({len(needed) - len(missing)} baseline/query items + random fill; "
          f"{len(missing)} baseline items not in local mirror)")

    return queries, items, missing


def pool_cache(n: int, seed: int, tokens: int = SOFT_TOKENS) -> Path:
    suffix = "" if tokens == SOFT_TOKENS else f"-t{tokens}"
    return COMPARE_DIR / f"pool-vectors-n{n}-s{seed}{suffix}.npz"


def system_name(tokens: int) -> str:
    return "gemma" if tokens == SOFT_TOKENS else f"gemma-t{tokens}"


def run_compare(embedder, n: int, seed: int, tokens: int) -> None:
    """Adds this token setting's ranking to results.json alongside earlier runs; the judging
    page for a non-default setting shows only cards not already in judgements.json."""
    queries, items, missing = build_pool(n, seed)
    results_path = COMPARE_DIR / "results.json"
    if results_path.exists():
        earlier = {q["query"]: q["systems"] for q in json.loads(results_path.read_text())}
        for q in queries:
            q["systems"] = {**earlier.get(q["query"], {}), **q["systems"]}
    system = system_name(tokens)
    vecs, gpu_s = embed_via_volume(embedder, items, pool_cache(n, seed, tokens))
    idx = {it["object_number"]: i for i, it in enumerate(items)}
    text_qs = [q["query"] for q in queries if q["kind"] == "text"]
    q_vecs = dict(zip(text_qs, embedder.embed_queries.remote(text_qs)))

    for q in queries:
        if q["kind"] == "text":
            scores = vecs @ q_vecs[q["query"]]
        elif q["query"] in idx:
            scores = vecs @ vecs[idx[q["query"]]]
            scores[idx[q["query"]]] = -np.inf
        else:
            q["systems"][system] = []
            continue
        q["systems"][system] = [items[i]["object_number"] for i in np.argsort(-scores)[:20]]
    results_path.write_text(json.dumps(queries, indent=1))

    meta = {it["object_number"]: it for it in items}
    conn = sqlite3.connect(f"file:{VOCAB_DB}?mode=ro", uri=True)
    for on in missing:  # baseline items Gemma couldn't see still need a card
        row = conn.execute("SELECT iiif_id, title, creator_label, date_display FROM artworks WHERE object_number = ?",
                           (on,)).fetchone()
        if row:
            meta[on] = {"object_number": on, "iiif_id": row[0], "title": row[1], "creator": row[2], "date": row[3]}
    conn.close()
    judged_path = COMPARE_DIR / "judgements.json"
    if tokens == SOFT_TOKENS or not judged_path.exists():
        write_judging_page(queries, meta, seed, COMPARE_DIR / "judge.html")
    else:
        write_judging_page(queries, meta, seed, COMPARE_DIR / f"judge-t{tokens}.html",
                           prior=json.loads(judged_path.read_text()))
    overlap = [len(set(q["systems"][system][:8]) & {on for s, r in q["systems"].items() if s != system for on in r[:8]})
               for q in queries]
    print(f"Mean top-8 overlap between {system} and the other systems: {np.mean(overlap):.1f} of 8")


def write_judging_page(queries: list[dict], meta: dict, seed: int, out: Path, prior: dict | None = None) -> None:
    """prior: earlier judgements; their cards are left out, and Export merges them back in."""
    prior = prior or {}
    rng = random.Random(seed)
    blocks = []
    for qi, q in enumerate(queries):
        pool = sorted({on for ranked in q["systems"].values() for on in ranked[:8]} - set(prior.get(q["query"], {})))
        if not pool:
            continue
        rng.shuffle(pool)
        cards = []
        for on in pool:
            m = meta.get(on, {"object_number": on})
            thumb = f"https://iiif.micr.io/{m.get('iiif_id')}/full/!600,600/0/default.jpg"
            sub = " · ".join(x for x in (m.get("creator"), m.get("date")) if x)
            cards.append(
                f'<div class="card" data-on="{html.escape(on)}">'
                f'<a href="https://www.rijksmuseum.nl/en/collection/{html.escape(on)}" target="_blank" rel="noopener">'
                f'<img loading="lazy" src="{thumb}" alt=""></a>'
                f'<div class="meta">{html.escape((m.get("title") or "")[:80])}<br><small>{html.escape(sub[:70])}</small></div>'
                f'<div class="btns"><button data-g="0">✗ no</button><button data-g="1">~ partly</button>'
                f'<button data-g="2">✓ yes</button></div></div>')
        if q["kind"] == "image":
            m = meta.get(q["query"], {})
            head = (f"<h2>{qi + 1}. Image query: {html.escape(q['query'])} — {html.escape((m.get('title') or '')[:80])}</h2>"
                    f"<img class='qimg' src='https://iiif.micr.io/{m.get('iiif_id')}/full/!800,800/0/default.jpg'>"
                    "<p class='hint'>Is the candidate visually or iconographically similar to this image?</p>")
        else:
            head = (f"<h2>{qi + 1}. Text query: “{html.escape(q['query'])}”</h2>"
                    "<p class='hint'>Does the image show what the query describes?</p>")
        blocks.append(f"<section data-q=\"{html.escape(q['query'])}\">{head}<div class='grid'>{''.join(cards)}</div></section>")

    page = """<!doctype html><meta charset="utf-8"><title>Image search judging</title>
<style>
body{font:14px system-ui,sans-serif;margin:0 auto;max-width:1600px;padding:16px 16px 90px;background:#f7f7f5;color:#222}
h2{font-size:16px;margin:32px 0 6px;border-bottom:1px solid #ccc;padding-bottom:4px} .hint{color:#666;margin:4px 0 10px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:10px}
.card{background:#fff;border:3px solid #ddd;border-radius:6px;overflow:hidden}
.card img{width:100%;aspect-ratio:1;object-fit:contain;background:#eee;display:block}
.meta{padding:5px 7px;font-size:11.5px;line-height:1.3;color:#555;min-height:2.6em}
.btns{display:flex;border-top:1px solid #eee} .btns button{flex:1;border:0;background:#fafafa;padding:7px 0;cursor:pointer;font-size:12px}
.btns button+button{border-left:1px solid #eee}
.card[data-g="0"]{border-color:#c44}.card[data-g="1"]{border-color:#e0a000}.card[data-g="2"]{border-color:#2a2}
.card[data-g="0"] [data-g="0"]{background:#c44;color:#fff}.card[data-g="1"] [data-g="1"]{background:#e0a000;color:#fff}
.card[data-g="2"] [data-g="2"]{background:#2a2;color:#fff}
.qimg{max-height:480px;border:3px solid #346;border-radius:6px}
#bar{position:fixed;left:0;right:0;bottom:0;background:#234;color:#fff;padding:10px 16px;display:flex;gap:14px;align-items:center}
#bar button{padding:6px 12px;cursor:pointer} #out{width:100%;height:120px;margin-top:20px;font:11px monospace}
</style>
<h1>Blind relevance judging</h1>
<p>Each query shows the merged top results from several search systems, shuffled; the source system is hidden.
Mark every card. Choices are saved in this browser as you go. When done, press <b>Export</b> and save the file as
<code>data/egemma2-test/compare/judgements.json</code> (or copy the JSON from the box at the bottom).</p>
""" + "".join(blocks) + """
<textarea id="out" readonly placeholder="Exported JSON appears here"></textarea>
<div id="bar"><span id="prog"></span><button id="exp">Export judgements.json</button><button id="next">Jump to next unjudged</button></div>
<script>
const KEY = "egemma2-judgements";
const PRIOR = """ + json.dumps(prior) + """;
let J = {};
try { J = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (e) {}
for (const [q, marks] of Object.entries(PRIOR)) J[q] = {...marks, ...(J[q] || {})};
const cards = [...document.querySelectorAll(".card")];
function q(c) { return c.closest("section").dataset.q; }
function paint() {
  let done = 0;
  for (const c of cards) {
    const g = (J[q(c)] || {})[c.dataset.on];
    if (g === undefined) c.removeAttribute("data-g"); else { c.dataset.g = g; done++; }
  }
  document.getElementById("prog").textContent = done + " / " + cards.length + " judged";
}
document.addEventListener("click", e => {
  const b = e.target.closest(".btns button"); if (!b) return;
  const c = b.closest(".card");
  (J[q(c)] ||= {})[c.dataset.on] = Number(b.dataset.g);
  try { localStorage.setItem(KEY, JSON.stringify(J)); } catch (e) {}
  paint();
});
document.getElementById("exp").onclick = () => {
  const text = JSON.stringify(J, null, 1);
  document.getElementById("out").value = text;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], {type: "application/json"}));
  a.download = "judgements.json"; a.click();
};
document.getElementById("next").onclick = () => {
  const c = cards.find(c => !c.hasAttribute("data-g"));
  if (c) c.scrollIntoView({behavior: "smooth", block: "center"});
};
paint();
</script>"""
    out.write_text(page)
    n_cards = page.count('<div class="card"')
    print(f"Judging page: {out} ({len(blocks)} queries, {n_cards} cards to judge)")


@app.local_entrypoint()
def main(n: int = 1000, seed: int = 7, queries: str = "", image_queries: int = 4, diagnose: str = "",
         benchmark: bool = False, compare: bool = False, tokens: int = SOFT_TOKENS, check: bool = False):
    if diagnose:
        # "objnum=caption;objnum=caption" — objects looked up in the local mirror via the vocab DB
        pairs = [p.split("=", 1) for p in diagnose.split(";")]
        conn = sqlite3.connect(f"file:{VOCAB_DB}?mode=ro", uri=True)
        paths = []
        for objnum, _ in pairs:
            iid = conn.execute("SELECT iiif_id FROM artworks WHERE object_number = ?", (objnum,)).fetchone()[0]
            paths.append(next((CORPUS / "downloads").glob(f"shard-*/{iid}.jpg")))
        print(Embedder().diagnose.remote([load_jpeg(str(p)) for p in paths], [c for _, c in pairs]))
        return
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    embedder = Embedder(tokens=tokens)
    if check:
        path = next((CORPUS / "downloads").glob("shard-*/*.jpg"), None) or next(COMPARE_DIR.glob("*.jpegs/*.jpg"))
        print(embedder.check_tokens.remote(load_jpeg(str(path), tokens)))
        return
    if benchmark:
        run_benchmark(embedder, n, seed)
        return
    if compare:
        run_compare(embedder, n, seed, tokens)
        return
    cache = OUT_DIR / f"vectors-n{n}-s{seed}.npz"
    items = sample_images(n, seed)
    attach_metadata(items)
    print(f"Sampled {len(items)} images")
    img_vecs, gpu_s = embed_items(embedder, items, cache)

    qs = [q.strip() for q in queries.split(";") if q.strip()] or DEFAULT_QUERIES
    q_vecs = embedder.embed_queries.remote(qs)

    sections = []
    for q, qv in zip(qs, q_vecs):
        scores = img_vecs @ qv
        top = np.argsort(-scores)[:TOP_K]
        sections.append((f"Text: “{html.escape(q)}”", "", [(items[i], float(scores[i])) for i in top]))

    rng = random.Random(seed + 1)
    for qi in rng.sample(range(len(items)), min(image_queries, len(items))):
        scores = img_vecs @ img_vecs[qi]
        scores[qi] = -np.inf
        top = np.argsort(-scores)[:TOP_K]
        q = items[qi]
        head = (f"<img class='qimg' src='https://iiif.micr.io/{q['iiif_id']}/full/!800,800/0/default.jpg'>"
                f"<p>{html.escape(q.get('title') or '')} — {html.escape(q['object_number'])}</p>")
        sections.append(("Image → similar images", head, [(items[i], float(scores[i])) for i in top]))

    rate = f"; GPU throughput {len(items) / gpu_s:.1f} img/s on A10G" if gpu_s else ""
    info = f"<p>{len(items)} random images (seed {seed}), 768-d, cosine{rate}.</p>"
    out = OUT_DIR / f"report-n{n}-s{seed}.html"
    write_report(out, sections, info)
    print(f"Report: {out}")


if __name__ == "__main__":
    # plain-python step: `python scripts/explore-embeddinggemma2-modal.py stage --n 20000 --seed 11 [--tokens 560]`
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("step", choices=["stage"])
    ap.add_argument("--n", type=int, default=20000)
    ap.add_argument("--seed", type=int, default=11)
    ap.add_argument("--tokens", type=int, default=SOFT_TOKENS)
    args = ap.parse_args()
    _, pool_items, _ = build_pool(args.n, args.seed)
    stage_and_upload(pool_items, pool_cache(args.n, args.seed, args.tokens), args.tokens)
