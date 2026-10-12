#!/usr/bin/env python3
"""
Full-corpus EmbeddingGemma 2 vectors (test set, not deployed): every mirrored image, every Dutch
description, and the no-subjects metadata composite that semantic_search's e5 vectors are built from.

Model settings match explore-embeddinggemma2-modal.py (bf16, audio tower off, 280 soft tokens,
images ≤720K px JPEG q85), so its pooled-comparison vectors stay comparable.

Steps:
    # 1. plain python: downscale each mirror shard into a tar and upload it to the Volume
    ~/miniconda3/envs/embeddings/bin/python scripts/embed-corpus-embeddinggemma2-modal.py stage
    # 2. embed whatever shards are uploaded so far (rerun to pick up the rest); assembles when complete
    ~/miniconda3/envs/embeddings/bin/modal run scripts/embed-corpus-embeddinggemma2-modal.py --images
    ~/miniconda3/envs/embeddings/bin/python scripts/embed-corpus-embeddinggemma2-modal.py assemble  # no GPU
    # 3. text sets
    ~/miniconda3/envs/embeddings/bin/modal run scripts/embed-corpus-embeddinggemma2-modal.py --texts description
    ~/miniconda3/envs/embeddings/bin/modal run scripts/embed-corpus-embeddinggemma2-modal.py --texts metadata
    ~/miniconda3/envs/embeddings/bin/modal run scripts/embed-corpus-embeddinggemma2-modal.py --texts iconclass

Every step resumes from what is already done. Output in data/egemma2-test/corpus/:
    images.npz, text-description.npz, text-metadata.npz — keys art_id, object_number, vec (float16 768d,
    L2-normalised; truncate + renormalise for MRL 512/256/128). text-iconclass.npz carries the notation
    in object_number (art_id -1).
"""

import io
import json
import sqlite3
import sys
import tarfile
import time
from pathlib import Path

import modal
import numpy as np

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent
VOCAB_DB = PROJECT_DIR / "data" / "vocabulary.db"
INSCRIPTION_EMBED_DB = PROJECT_DIR / "data" / "inscription-embed-text.db"
ICONCLASS_DB = PROJECT_DIR.parent / "rijksmuseum-iconclass-mcp" / "data" / "iconclass.db"
OUT_DIR = PROJECT_DIR / "data" / "egemma2-test" / "corpus"
CORPUS = Path("/Volumes/sand/rijksmuseum-bucket")

MODEL_NAME = "google/embeddinggemma-2"
REVISION = "914f7f89142e33e77833254d9c9b90c3cef7303b"
MAX_PIXELS = int(280 * 48 * 48 * 1.12)  # the processor's 280-soft-token target, with a little headroom
TEXT_MAX_TOKENS = 1024
TEXT_CHUNK = 2048

# A separate Volume from the pool probe's: per-shard tars keep the file count low
VOLUME = "egemma2-corpus"
vol = modal.Volume.from_name(VOLUME, create_if_missing=True)

app = modal.App("rijksmuseum-egemma2-corpus")


def download_model():
    from sentence_transformers import SentenceTransformer
    SentenceTransformer(MODEL_NAME, revision=REVISION, config_kwargs={"audio_config": None})


gpu_image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "transformers==5.19.0",
        "sentence-transformers==6.1.0",
        "torch==2.10.0",
        "torchvision==0.25.0",
        "pillow",
        "numpy",
    )
    .run_function(download_model, secrets=[modal.Secret.from_name("huggingface-secret")])
    .env({"HF_HUB_OFFLINE": "1"})
)


@app.cls(gpu="A10G", image=gpu_image, cpu=4.0, memory=16384, scaledown_window=60, timeout=3600,
         max_containers=10, volumes={"/corpus": vol},
         secrets=[modal.Secret.from_name("huggingface-secret")])
class Embedder:
    @modal.enter()
    def load(self):
        import torch
        from sentence_transformers import SentenceTransformer
        # bf16, never fp16: the model's activations overflow fp16 into NaNs
        self.model = SentenceTransformer(MODEL_NAME, revision=REVISION, device="cuda",
                                         config_kwargs={"audio_config": None},
                                         model_kwargs={"torch_dtype": torch.bfloat16})
        self.model.max_seq_length = TEXT_MAX_TOKENS

    @modal.method()
    def embed_shard(self, name: str) -> tuple[str, list[str], np.ndarray, float]:
        from PIL import Image
        vol.reload()  # shards uploaded after this container started
        ids, imgs = [], []
        with tarfile.open(f"/corpus/tars/{name}") as tar:
            for m in tar:
                if m.isfile() and m.name.endswith(".jpg"):
                    ids.append(m.name[:-4])
                    imgs.append(Image.open(io.BytesIO(tar.extractfile(m).read())).convert("RGB"))
        t0 = time.time()
        vecs = self.model.encode([{"image": im} for im in imgs], batch_size=32,
                                 normalize_embeddings=True, convert_to_numpy=True)
        return name, ids, vecs.astype(np.float16), time.time() - t0

    @modal.method()
    def embed_documents(self, texts: list[str]) -> np.ndarray:
        vecs = self.model.encode_document(texts, batch_size=64, normalize_embeddings=True, convert_to_numpy=True)
        return vecs.astype(np.float16)

    @modal.method()
    def embed_queries(self, texts: list[str]) -> np.ndarray:
        return self.model.encode_query(texts, normalize_embeddings=True, convert_to_numpy=True).astype(np.float32)


# ─── Stage (plain python) ───────────────────────────────────────────────

def build_shard_tar(state_file: str, out: str) -> int:
    """Downscaled JPEGs named by IIIF id: case-sensitive inside the tar, unlike the mirror's volume."""
    from PIL import Image
    sf = Path(state_file)
    expected = json.loads(sf.read_text())["expected"]
    lower: dict[str, int] = {}
    for iid in expected:
        lower[iid.lower()] = lower.get(iid.lower(), 0) + 1
    shard_dir = CORPUS / "downloads" / sf.name.replace(".state.json", "")
    tmp = Path(out + ".tmp")
    n = 0
    with tarfile.open(tmp, "w") as tar:
        for iid in expected:
            src = shard_dir / f"{iid}.jpg"
            # the mirror sits on a case-insensitive volume, so colliding ids are ambiguous
            if lower[iid.lower()] != 1 or not src.exists():
                continue
            try:
                im = Image.open(src).convert("RGB")
            except OSError as e:
                print(f"  ! {src.name}: {e}", flush=True)
                continue
            scale = (MAX_PIXELS / (im.width * im.height)) ** 0.5
            if scale < 1:
                im = im.resize((round(im.width * scale), round(im.height * scale)), Image.LANCZOS)
            buf = io.BytesIO()
            im.save(buf, "JPEG", quality=85)
            info = tarfile.TarInfo(f"{iid}.jpg")
            info.size = buf.tell()
            buf.seek(0)
            tar.addfile(info, buf)
            n += 1
    tmp.rename(out)
    return n


def upload(tar_path: Path) -> None:
    import subprocess
    modal_cli = Path(sys.executable).parent / "modal"
    for attempt in range(1, 6):
        r = subprocess.run([str(modal_cli), "volume", "put", "--force", VOLUME, str(tar_path), f"/tars/{tar_path.name}"],
                           capture_output=True, text=True)
        if r.returncode == 0:
            tar_path.with_suffix(".uploaded").touch()
            tar_path.unlink()
            return
        print(f"  upload {tar_path.name} attempt {attempt} failed: {r.stderr.strip()[-300:]}", flush=True)
        time.sleep(30 * attempt)
    raise RuntimeError(f"giving up on {tar_path.name}")


def stage(workers: int) -> None:
    import subprocess
    from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor, as_completed
    tars = OUT_DIR / "tars"
    tars.mkdir(parents=True, exist_ok=True)
    subprocess.run([str(Path(sys.executable).parent / "modal"), "volume", "create", "--version=2", VOLUME],
                   capture_output=True)
    shards = sorted((CORPUS / "state").glob("shard-*.state.json"))
    todo = [sf for sf in shards if not (tars / sf.name.replace(".state.json", ".uploaded")).exists()]
    print(f"{len(shards) - len(todo)}/{len(shards)} shards already uploaded", flush=True)
    t0, done_imgs, done_bytes = time.time(), 0, 0
    with ProcessPoolExecutor(workers) as cpu, ThreadPoolExecutor(3) as net:
        uploads = []
        builds = {}
        for sf in todo:
            out = tars / sf.name.replace(".state.json", ".tar")
            if out.exists():  # built on an earlier run, upload never finished
                uploads.append(net.submit(upload, out))
            else:
                builds[cpu.submit(build_shard_tar, str(sf), str(out))] = out
        for f in as_completed(builds):
            out = builds[f]
            done_imgs += f.result()
            done_bytes += out.stat().st_size
            mins = (time.time() - t0) / 60
            print(f"built {out.name}: {done_imgs:,} images, {done_bytes / 1e9:.1f} GB in {mins:.0f} min", flush=True)
            uploads.append(net.submit(upload, out))
        for i, u in enumerate(as_completed(uploads), 1):
            u.result()
            if i % 10 == 0 or i == len(uploads):
                print(f"uploaded {i}/{len(uploads)} shards ({(time.time() - t0) / 60:.0f} min)", flush=True)
    print("STAGED", flush=True)


# ─── Embed (modal run) ──────────────────────────────────────────────────

def current_art_ids(object_numbers: list[str]) -> np.ndarray:
    conn = sqlite3.connect(f"file:{VOCAB_DB}?mode=ro", uri=True)
    lookup = dict(conn.execute("SELECT object_number, art_id FROM artworks"))
    conn.close()
    return np.array([lookup.get(on, -1) for on in object_numbers], dtype=np.int64)


def embed_images(embedder) -> None:
    out = OUT_DIR / "images"
    out.mkdir(parents=True, exist_ok=True)
    on_volume = sorted(Path(e.path).name for e in vol.listdir("/tars") if e.path.endswith(".tar"))
    todo = [n for n in on_volume if not (out / n.replace(".tar", ".npz")).exists()]
    print(f"{len(on_volume)} shards on Volume, {len(todo)} to embed")
    t0, gpu_s, n_imgs = time.time(), 0.0, 0
    for name, ids, vecs, secs in embedder.embed_shard.map(todo, order_outputs=False):
        np.savez(out / name.replace(".tar", ".npz"), iiif_id=np.array(ids), vec=vecs)
        gpu_s += secs
        n_imgs += len(ids)
        print(f"  {name}: {len(ids)} images; total {n_imgs:,} in {(time.time() - t0) / 60:.0f} min, "
              f"{n_imgs / gpu_s:.1f} img/s per A10G", flush=True)

    assemble_images()


def assemble_images() -> None:
    n_shards = len(list((CORPUS / "state").glob("shard-*.state.json")))
    parts = sorted((OUT_DIR / "images").glob("shard-*.npz"))
    if len(parts) < n_shards:
        print(f"{len(parts)}/{n_shards} shards embedded; rerun once the rest are uploaded")
        return
    # Map ids per shard: one image can serve objects in different shards
    seen, iiif, ons, vecs = set(), [], [], []
    for p in parts:
        d = np.load(p)
        expected = json.loads((CORPUS / "state" / p.name.replace(".npz", ".state.json")).read_text())["expected"]
        for iid, vec in zip(d["iiif_id"].tolist(), d["vec"]):
            on = expected[iid]["object_number"]
            if (iid, on) not in seen:
                seen.add((iid, on))
                iiif.append(iid), ons.append(on), vecs.append(vec)
    iiif, vecs = np.array(iiif), np.stack(vecs)
    art_ids = current_art_ids(ons)
    np.savez(OUT_DIR / "images.npz", art_id=art_ids, object_number=np.array(ons), iiif_id=iiif, vec=vecs)
    print(f"images.npz: {len(ons):,} vectors ({int((art_ids < 0).sum())} object numbers not in the current vocab DB)")


def load_iconclass_texts() -> list[tuple[int, str, str]]:
    """Base notations with the composite the Iconclass server's e5-base vectors use
    (rijksmuseum-iconclass-mcp scripts/generate-embeddings-modal.py), so the two stay comparable."""
    conn = sqlite3.connect(f"file:{ICONCLASS_DB}?mode=ro", uri=True)
    notations = conn.execute("SELECT notation, path FROM notations WHERE is_key_expanded = 0").fetchall()
    texts: dict[str, dict[str, str]] = {}
    for n, lang, t in conn.execute("SELECT notation, lang, text FROM texts WHERE lang IN ('en', 'nl')"):
        texts.setdefault(n, {})[lang] = t
    kws: dict[str, list[str]] = {}
    for n, kw in conn.execute("SELECT notation, keyword FROM keywords WHERE lang IN ('en', 'nl')"):
        kws.setdefault(n, []).append(kw)
    conn.close()
    label = {n: t.get("en") or t.get("nl") for n, t in texts.items()}
    out = []
    for n, path in notations:
        t = texts.get(n, {})
        parts = []
        if "en" in t:
            parts.append(f"[Description] {t['en']}")
        if "nl" in t:
            parts.append(f"[Description NL] {t['nl']}")
        if n in kws:
            parts.append(f"[Keywords] {', '.join(dict.fromkeys(kws[n]))}")
        ancestors = json.loads(path or "[]")
        if ancestors:
            parts.append("[Category] " + " > ".join([label.get(a, a) for a in ancestors] + [label.get(n, n)]))
        if parts:
            out.append((-1, n, " ".join(parts)))
    return out


def load_texts(kind: str) -> list[tuple[int, str, str]]:
    if kind == "iconclass":
        return load_iconclass_texts()
    conn = sqlite3.connect(f"file:{VOCAB_DB}?mode=ro", uri=True)
    if kind == "description":
        rows = conn.execute("SELECT art_id, object_number, description_text FROM artworks "
                            "WHERE COALESCE(description_text, '') != ''").fetchall()
        conn.close()
        return rows
    # same fields, order and inscription cleaning as the e5 'no-subjects' strategy behind semantic_search
    rows = conn.execute("SELECT art_id, object_number, title, inscription_text, description_text, narrative_text "
                        "FROM artworks").fetchall()
    conn.close()
    iconn = sqlite3.connect(f"file:{INSCRIPTION_EMBED_DB}?mode=ro", uri=True)
    cleaned = dict(iconn.execute("SELECT art_id, embed_text FROM inscription_embed_text"))
    iconn.close()
    out = []
    for art_id, on, title, insc, desc, narr in rows:
        fields = [("Title", title), ("Inscriptions", cleaned.get(art_id, insc)),
                  ("Description", desc), ("Narrative", narr)]
        text = " ".join(f"[{label}] {val}" for label, val in fields if val)
        if text:
            out.append((art_id, on, text))
    return out


def embed_texts(embedder, kind: str, limit: int) -> None:
    rows = load_texts(kind)[:limit or None]
    print(f"{kind}: {len(rows):,} texts, mean {np.mean([len(t) for _, _, t in rows]):.0f} chars")
    parts = OUT_DIR / f"text-{kind}.parts"
    parts.mkdir(parents=True, exist_ok=True)
    spans = [(i, i + TEXT_CHUNK) for i in range(0, len(rows), TEXT_CHUNK)]
    todo = [k for k in range(len(spans)) if not (parts / f"{k:05d}.npy").exists()]
    print(f"{len(spans) - len(todo)}/{len(spans)} chunks already embedded")
    t0 = time.time()
    inputs = [[t for _, _, t in rows[spans[k][0]:spans[k][1]]] for k in todo]
    for i, vecs in enumerate(embedder.embed_documents.map(inputs), 1):
        np.save(parts / f"{todo[i - 1]:05d}.npy", vecs)
        if i % 20 == 0 or i == len(todo):
            print(f"  {i}/{len(todo)} chunks in {(time.time() - t0) / 60:.1f} min", flush=True)
    vecs = np.concatenate([np.load(parts / f"{k:05d}.npy") for k in range(len(spans))])
    suffix = f"-limit{limit}" if limit else ""
    np.savez(OUT_DIR / f"text-{kind}{suffix}.npz", art_id=np.array([r[0] for r in rows], dtype=np.int64),
             object_number=np.array([r[1] for r in rows]), vec=vecs)
    print(f"text-{kind}{suffix}.npz: {len(rows):,} vectors")


@app.local_entrypoint()
def main(images: bool = False, texts: str = "", limit: int = 0, queries: str = ""):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    embedder = Embedder()
    if queries:  # JSON list of strings → <same name>.npz alongside it
        qs = json.loads(Path(queries).read_text())
        np.savez(Path(queries).with_suffix(".npz"), query=np.array(qs), vec=embedder.embed_queries.remote(qs))
        return
    if images:
        embed_images(embedder)
    if texts:
        if texts not in ("description", "metadata", "iconclass"):
            sys.exit("--texts description|metadata|iconclass")
        if limit:  # a test run must not leave chunks a full run would reuse
            import shutil
            shutil.rmtree(OUT_DIR / f"text-{texts}.parts", ignore_errors=True)
        embed_texts(embedder, texts, limit)
        if limit:
            shutil.rmtree(OUT_DIR / f"text-{texts}.parts", ignore_errors=True)


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("step", choices=["stage", "assemble"])
    ap.add_argument("--workers", type=int, default=8)
    args = ap.parse_args()
    stage(args.workers) if args.step == "stage" else assemble_images()
