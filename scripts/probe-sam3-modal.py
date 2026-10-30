#!/usr/bin/env python3
"""
Feasibility probe: SAM 3 text-prompted segmentation on Rijksmuseum IIIF images.

Runs facebook/sam3 on a GPU (quality + warm latency) and once on CPU (a stand-in for Railway),
then writes overlay PNGs, results.json and an HTML contact sheet to data/sam3-probe/.
Some prompts name objects that are absent, to measure false positives.

    ~/miniconda3/envs/embeddings/bin/modal run scripts/probe-sam3-modal.py
    ~/miniconda3/envs/embeddings/bin/modal run scripts/probe-sam3-modal.py --no-cpu
"""

import html
import io
import json
import time
from pathlib import Path

import modal

PROJECT_DIR = Path(__file__).resolve().parent.parent
OUT_DIR = PROJECT_DIR / "data" / "sam3-probe"
VOCAB_DB = PROJECT_DIR / "data" / "vocabulary.db"

MODEL_NAME = "facebook/sam3"
REVISION = "3c879f39826c281e95690f02c7821c4de09afae7"
IIIF_BOX = 1536
KEEP_SCORE = 0.3   # returned to the client
SHOW_SCORE = 0.5   # drawn in the overlay

# (objectNumber, prompts) — prompts prefixed "!" are absent from the image
CASES = [
    ("SK-C-5", ["dog", "drum", "girl", "!cat"]),
    ("SK-A-2344", ["jug", "bread", "woman", "!dog"]),
    ("SK-A-1718", ["ice skater", "horse", "tree"]),
    ("SK-A-4118", ["horse", "rider", "cow"]),
    ("SK-A-3262", ["face", "beard", "!ship"]),
    ("SK-A-1505", ["windmill", "boat", "tree"]),
    ("SK-C-216", ["hand", "necklace", "!horse"]),
    ("SK-A-2860", ["woman", "door", "window"]),
    ("SK-A-180", ["violin", "glass", "hat"]),
    ("SK-C-229", ["dog", "child", "jug"]),
    ("SK-A-3924", ["skull", "flower", "hand"]),
    ("SK-A-4867", ["horse", "flag", "building"]),
    ("RP-P-1962-80", ["dog", "man", "tree"]),
    ("RP-P-OB-1033", ["book", "saw", "halo"]),
    ("RP-T-1930-30", ["person", "table", "!horse"]),
    ("RP-P-1883-A-6862", ["face", "ruff", "text"]),
    ("RP-F-F01171", ["person", "face"]),
    ("BK-16672", ["clock face", "figure"]),
    ("NG-MC-651", ["sail", "cannon", "flag"]),
    ("BK-1978-315-A", ["person", "tree", "!dog"]),
]

app = modal.App("rijksmuseum-sam3-probe")


def download_model():
    from transformers import Sam3Model, Sam3Processor
    Sam3Model.from_pretrained(MODEL_NAME, revision=REVISION)
    Sam3Processor.from_pretrained(MODEL_NAME, revision=REVISION)


image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "transformers==5.19.0",
        "torch==2.10.0",
        "torchvision==0.25.0",
        "pillow",
        "numpy",
        "psutil",
    )
    .run_function(download_model, secrets=[modal.Secret.from_name("huggingface-secret")])
    .env({"HF_HUB_OFFLINE": "1"})
)


def _run(cases, device):
    """cases: list of (key, jpeg_bytes, [prompt, ...]). Returns timings + per-prompt detections."""
    import numpy as np
    import psutil
    import torch
    from PIL import Image
    from transformers import Sam3Model, Sam3Processor

    t0 = time.perf_counter()
    processor = Sam3Processor.from_pretrained(MODEL_NAME, revision=REVISION)
    model = Sam3Model.from_pretrained(MODEL_NAME, revision=REVISION).to(device).eval()
    load_s = time.perf_counter() - t0

    def sync():
        if device == "cuda":
            torch.cuda.synchronize()

    out = []
    for key, jpg, prompts in cases:
        img = Image.open(io.BytesIO(jpg)).convert("RGB")
        rec = {"key": key, "size": img.size, "prompts": []}
        with torch.inference_mode():
            t = time.perf_counter()
            img_inputs = processor(images=img, return_tensors="pt").to(device)
            vision_embeds = model.get_vision_features(pixel_values=img_inputs.pixel_values)
            sync()
            rec["encode_s"] = time.perf_counter() - t
            for prompt in prompts:
                t = time.perf_counter()
                text_inputs = processor(text=prompt, return_tensors="pt").to(device)
                outputs = model(vision_embeds=vision_embeds, **text_inputs)
                res = processor.post_process_instance_segmentation(
                    outputs, threshold=KEEP_SCORE, mask_threshold=0.5,
                    target_sizes=img_inputs.get("original_sizes").tolist())[0]
                sync()
                dt = time.perf_counter() - t
                dets = []
                for m, b, s in zip(res["masks"], res["boxes"], res["scores"]):
                    m = m.cpu().numpy().astype(bool)
                    dets.append({
                        "score": float(s),
                        "box": [float(v) for v in b.cpu().tolist()],
                        "area_frac": float(m.mean()),
                        "mask_shape": list(m.shape),
                        "mask_bits": np.packbits(m).tobytes(),
                    })
                rec["prompts"].append({"prompt": prompt, "decode_s": dt, "dets": dets})
        out.append(rec)

    mem = {"rss_gb": psutil.Process().memory_info().rss / 1e9}
    if device == "cuda":
        mem["cuda_peak_gb"] = torch.cuda.max_memory_allocated() / 1e9
        mem["gpu"] = torch.cuda.get_device_name(0)
    return {"device": device, "load_s": load_s, "mem": mem, "results": out}


@app.function(gpu="A10G", image=image, cpu=4.0, memory=16384, timeout=1800,
              secrets=[modal.Secret.from_name("huggingface-secret")])
def run_gpu(cases):
    return _run(cases, "cuda")


@app.function(image=image, cpu=4.0, memory=16384, timeout=1800,
              secrets=[modal.Secret.from_name("huggingface-secret")])
def run_cpu(cases):
    return _run(cases, "cpu")


def fetch_images():
    import sqlite3
    import requests

    img_dir = OUT_DIR / "img"
    img_dir.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(f"file:{VOCAB_DB}?mode=ro", uri=True)
    meta, cases = {}, []
    for obj, prompts in CASES:
        row = db.execute("SELECT iiif_id, title, creator_label FROM artworks WHERE object_number = ?",
                         (obj,)).fetchone()
        if not row or not row[0]:
            print(f"skip {obj}: no iiif_id")
            continue
        path = img_dir / f"{obj}.jpg"
        if not path.exists():
            url = f"https://iiif.micr.io/{row[0]}/full/!{IIIF_BOX},{IIIF_BOX}/0/default.jpg"
            r = requests.get(url, timeout=60)
            r.raise_for_status()
            path.write_bytes(r.content)
        meta[obj] = {"title": row[1], "creator": row[2], "iiif_id": row[0]}
        cases.append((obj, path.read_bytes(), [p.lstrip("!") for p in prompts]))
    return meta, cases


COLORS = [(230, 25, 75), (60, 180, 75), (0, 130, 200), (245, 130, 48), (145, 30, 180), (70, 240, 240)]


def render(gpu, meta, cases):
    import numpy as np
    from PIL import Image, ImageDraw

    ov_dir = OUT_DIR / "overlay"
    ov_dir.mkdir(parents=True, exist_ok=True)
    jpgs = {k: b for k, b, _ in cases}
    absent = {obj: {p.lstrip("!") for p in ps if p.startswith("!")} for obj, ps in CASES}
    summary = []
    for rec in gpu["results"]:
        key = rec["key"]
        for i, pr in enumerate(rec["prompts"]):
            base = Image.open(io.BytesIO(jpgs[key])).convert("RGBA")
            layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
            draw = ImageDraw.Draw(layer)
            shown = [d for d in pr["dets"] if d["score"] >= SHOW_SCORE]
            for j, d in enumerate(shown):
                c = COLORS[j % len(COLORS)]
                h, w = d["mask_shape"]
                m = np.unpackbits(np.frombuffer(d["mask_bits"], dtype=np.uint8))[: h * w].reshape(h, w)
                rgba = np.zeros((h, w, 4), dtype=np.uint8)
                rgba[m == 1] = (*c, 110)
                layer = Image.alpha_composite(layer, Image.fromarray(rgba, "RGBA"))
                draw = ImageDraw.Draw(layer)
                draw.rectangle(d["box"], outline=(*c, 255), width=3)
                draw.text((d["box"][0] + 4, d["box"][1] + 4), f"{d['score']:.2f}", fill=(*c, 255))
            out = Image.alpha_composite(base, layer).convert("RGB")
            out.thumbnail((900, 900))
            fname = f"{key}__{i}.jpg"
            out.save(ov_dir / fname, quality=82)
            summary.append({
                "objectNumber": key, "prompt": pr["prompt"], "absent": pr["prompt"] in absent.get(key, set()),
                "n_shown": len(shown), "n_kept": len(pr["dets"]),
                "top_score": max((d["score"] for d in pr["dets"]), default=0.0),
                "decode_ms": round(pr["decode_s"] * 1000), "overlay": f"overlay/{fname}",
            })
    return summary


def write_report(meta, gpu, cpu, summary):
    enc = [r["encode_s"] for r in gpu["results"][1:]] or [gpu["results"][0]["encode_s"]]
    dec = [p["decode_s"] for r in gpu["results"] for p in r["prompts"]][3:]
    stats = {
        "gpu": gpu["mem"], "gpu_load_s": round(gpu["load_s"], 1),
        "gpu_encode_ms_median": round(sorted(enc)[len(enc) // 2] * 1000),
        "gpu_decode_ms_median": round(sorted(dec)[len(dec) // 2] * 1000),
        "gpu_first_encode_ms": round(gpu["results"][0]["encode_s"] * 1000),
    }
    if cpu:
        stats["cpu"] = {
            "load_s": round(cpu["load_s"], 1), "mem": cpu["mem"],
            "encode_s": [round(r["encode_s"], 1) for r in cpu["results"]],
            "decode_s": [round(p["decode_s"], 2) for r in cpu["results"] for p in r["prompts"]],
        }
    (OUT_DIR / "results.json").write_text(json.dumps({"stats": stats, "meta": meta, "summary": summary}, indent=2))

    rows = []
    for obj in meta:
        cells = []
        for s in (s for s in summary if s["objectNumber"] == obj):
            flag = " (absent)" if s["absent"] else ""
            cells.append(
                f'<figure><img src="{s["overlay"]}" loading="lazy"><figcaption><b>{html.escape(s["prompt"])}</b>{flag}'
                f' — {s["n_shown"]} shown, top {s["top_score"]:.2f}, {s["decode_ms"]} ms</figcaption></figure>')
        m = meta[obj]
        rows.append(f'<section><h2>{obj} — {html.escape(m["title"] or "")}</h2>'
                    f'<p>{html.escape(m["creator"] or "")}</p><div class="row">{"".join(cells)}</div></section>')
    (OUT_DIR / "index.html").write_text(
        "<!doctype html><meta charset=utf-8><title>SAM 3 probe</title><style>"
        "body{font:14px system-ui;margin:16px}.row{display:flex;flex-wrap:wrap;gap:8px}"
        "figure{margin:0;width:300px}img{width:300px}figcaption{font-size:12px}</style>"
        f"<h1>SAM 3 probe</h1><pre>{html.escape(json.dumps(stats, indent=2))}</pre>{''.join(rows)}")
    return stats


@app.local_entrypoint()
def main(no_cpu: bool = False):
    meta, cases = fetch_images()
    print(f"{len(cases)} images, {sum(len(p) for _, _, p in cases)} prompts")
    t = time.perf_counter()
    cpu_call = None if no_cpu else run_cpu.spawn(cases[:2])
    gpu = run_gpu.remote(cases)
    print(f"GPU call incl. cold start: {time.perf_counter() - t:.1f}s")
    cpu = cpu_call.get() if cpu_call else None
    summary = render(gpu, meta, cases)
    stats = write_report(meta, gpu, cpu, summary)
    print(json.dumps(stats, indent=2))
    for s in summary:
        mark = "ABSENT" if s["absent"] else ""
        print(f'{s["objectNumber"]:<18} {s["prompt"]:<12} shown={s["n_shown"]:<3} top={s["top_score"]:.2f} {mark}')
    print(f"report: {OUT_DIR / 'index.html'}")
