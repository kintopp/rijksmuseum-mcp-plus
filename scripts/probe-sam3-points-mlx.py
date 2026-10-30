#!/usr/bin/env python3
"""
Feasibility probe: SAM 3 point (click) and box prompts on Rijksmuseum images, locally via MLX.

Companion to probe-sam3-modal.py (text prompts on a GPU). Reuses its downloaded images in
data/sam3-probe/img/ and writes overlays + results to data/sam3-probe/points/. Points and boxes
are given as fractions of the image, as a viewer click or an LLM's rough bbox would arrive.

Needs mlx-vlm (not in the embeddings env):
    uv venv -p 3.12 <venv> && uv pip install -p <venv>/bin/python mlx-vlm pillow numpy
    <venv>/bin/python scripts/probe-sam3-points-mlx.py [--calibrate]
"""

import argparse
import html
import json
import time
from pathlib import Path

import mlx.core as mx
import numpy as np
from PIL import Image, ImageDraw

PROJECT_DIR = Path(__file__).resolve().parent.parent
IMG_DIR = PROJECT_DIR / "data" / "sam3-probe" / "img"
OUT_DIR = PROJECT_DIR / "data" / "sam3-probe" / "points"
MODEL = "mlx-community/sam3-bf16"

# (objectNumber, label, kind, coords) — point: (fx, fy); box: (fx1, fy1, fx2, fy2)
CASES = [
    ("SK-C-5", "dog", "point", (0.811, 0.863)),
    ("SK-C-5", "girl", "point", (0.294, 0.696)),
    ("SK-C-5", "Banninck face", "point", (0.478, 0.515)),
    ("SK-C-5", "girl (rough box)", "box", (0.24, 0.57, 0.35, 0.87)),
    ("SK-A-1718", "skater, foreground", "point", (0.667, 0.939)),
    ("SK-A-1718", "skater, mid", "point", (0.467, 0.814)),
    ("SK-A-1718", "boat on ice", "point", (0.511, 0.885)),
    ("SK-A-1718", "boat (rough box)", "box", (0.41, 0.85, 0.61, 0.92)),
    ("RP-P-1962-80", "dogs by the walker", "point", (0.394, 0.742)),
    ("RP-P-1962-80", "walker", "point", (0.461, 0.697)),
    ("SK-A-2344", "foot warmer", "point", (0.848, 0.878)),
    ("SK-A-2344", "hanging basket", "point", (0.217, 0.233)),
    ("SK-A-2344", "milkmaid (rough box)", "box", (0.28, 0.13, 0.75, 0.98)),
    ("SK-C-216", "bride's face", "point", (0.533, 0.26)),
    ("SK-C-216", "groom's sleeve", "point", (0.333, 0.428)),
    ("SK-A-1505", "man on path", "point", (0.691, 0.678)),
    ("SK-A-1505", "cow", "point", (0.237, 0.687)),
    ("SK-A-1505", "farmhouse", "point", (0.34, 0.622)),
    ("RP-P-OB-1033", "saw", "point", (0.25, 0.622)),
    ("RP-P-OB-1033", "saw (rough box)", "box", (0.06, 0.36, 0.33, 0.93)),
]


def load():
    from mlx_vlm.models.sam3.processing_sam3 import Sam3Processor
    from mlx_vlm.utils import get_model_path, load_model

    path = get_model_path(MODEL)
    return load_model(path), Sam3Processor.from_pretrained(str(path))


def encode(model, processor, img):
    pixel_values = mx.array(processor.preprocess_image(img)["pixel_values"])
    features = model.detector_model.vision_encoder.backbone(pixel_values)
    fpn = model.tracker_neck(features)
    # The mask decoder wants its skip features ordered 144² then 288², and silently drops a
    # mismatched level, which leaves blocky 72²-derived masks.
    high_res = sorted(fpn[:2], key=lambda f: f.shape[1])
    # A memoryless frame gets the learned no-memory embedding added (SAM 2's
    # directly_add_no_mem_embed); mlx-vlm loads the weight but its tracker never applies it.
    feats = fpn[2] + model.tracker_model.no_memory_embedding.reshape(1, 1, 1, -1)
    mx.eval(feats, *high_res)
    return feats, high_res


def prompt(model, feats, kind, coords, grid, point_scale):
    """Returns the multimask candidates (masks at decoder resolution, IoU scores)."""
    feats, high_res = feats
    if kind == "point":
        fx, fy = coords
        pts = mx.array([[[fx * point_scale - 0.5, fy * point_scale - 0.5]]], dtype=mx.float32)
        res = model.tracker_model.track_step(current_features=feats,
                                             prompt_points=(pts, mx.array([[1]], dtype=mx.int32)),
                                             multimask_output=True, high_res_features=high_res)
    else:
        res = model.tracker_model.track_step(current_features=feats,
                                             prompt_boxes=mx.array([[coords]], dtype=mx.float32),
                                             multimask_output=True, high_res_features=high_res)
    mx.eval(res["pred_masks"], res["iou_scores"])
    return np.array(res["pred_masks"][0]), 1 / (1 + np.exp(-np.array(res["iou_scores"][0])))


def to_image_mask(m, size):
    return np.array(Image.fromarray((m > 0).astype(np.uint8) * 255).resize(size, Image.BILINEAR)) > 127


COLORS = [(230, 25, 75), (0, 130, 200), (60, 180, 75)]


def render(img, masks, scores, kind, coords, path):
    W, H = img.size
    tiles = []
    for k, (m, s) in enumerate(zip(masks, scores)):
        base = img.convert("RGBA")
        bm = to_image_mask(m, (W, H))
        rgba = np.zeros((H, W, 4), dtype=np.uint8)
        rgba[bm] = (*COLORS[k], 120)
        tile = Image.alpha_composite(base, Image.fromarray(rgba, "RGBA"))
        d = ImageDraw.Draw(tile)
        if kind == "point":
            x, y = coords[0] * W, coords[1] * H
            d.ellipse([x - 9, y - 9, x + 9, y + 9], outline=(255, 255, 0, 255), width=4)
        else:
            d.rectangle([coords[0] * W, coords[1] * H, coords[2] * W, coords[3] * H],
                        outline=(255, 255, 0, 255), width=4)
        d.text((10, 10), f"cand {k}  iou {s:.2f}  area {bm.mean():.1%}", fill=(255, 255, 0, 255))
        tile = tile.convert("RGB")
        tile.thumbnail((600, 600))
        tiles.append(tile)
    sheet = Image.new("RGB", (sum(t.width for t in tiles) + 8 * (len(tiles) - 1), max(t.height for t in tiles)), "white")
    x = 0
    for t in tiles:
        sheet.paste(t, (x, 0))
        x += t.width + 8
    sheet.save(path, quality=82)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--calibrate", action="store_true",
                    help="render the Night Watch dog click under each candidate coordinate scale")
    args = ap.parse_args()
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    t = time.perf_counter()
    model, processor = load()
    load_s = time.perf_counter() - t
    grid = model.tracker_model.prompt_encoder.image_embedding_size[0]

    if args.calibrate:
        img = Image.open(IMG_DIR / "SK-C-5.jpg").convert("RGB")
        feats = encode(model, processor, img)
        for scale in (grid, 1008, 1):
            masks, scores = prompt(model, feats, "point", CASES[0][3], grid, scale)
            render(img, masks, scores, "point", CASES[0][3], OUT_DIR / f"calibrate-{scale}.jpg")
            print(f"scale {scale}: iou {np.round(scores, 2)}")
        return

    feats_cache, results, encode_s, prompt_s = {}, [], [], []
    for i, (obj, label, kind, coords) in enumerate(CASES):
        img = Image.open(IMG_DIR / f"{obj}.jpg").convert("RGB")
        if obj not in feats_cache:
            t = time.perf_counter()
            feats_cache = {obj: encode(model, processor, img)}
            encode_s.append(time.perf_counter() - t)
        t = time.perf_counter()
        masks, scores = prompt(model, feats_cache[obj], kind, coords, grid, grid)
        prompt_s.append(time.perf_counter() - t)
        fname = f"{obj}__{i}.jpg"
        render(img, masks, scores, kind, coords, OUT_DIR / fname)
        results.append({"objectNumber": obj, "label": label, "kind": kind, "coords": coords,
                        "iou": [round(float(s), 3) for s in scores],
                        "area": [round(float(to_image_mask(m, img.size).mean()), 4) for m in masks],
                        "sheet": fname})
        print(f"{obj:<14} {label:<22} {kind:<5} iou={np.round(scores, 2)}")

    stats = {"model": MODEL, "load_s": round(load_s, 1),
             "encode_s": [round(s, 2) for s in encode_s],
             "prompt_ms_median": round(sorted(prompt_s)[len(prompt_s) // 2] * 1000),
             "peak_mem_gb": round(mx.get_peak_memory() / 1e9, 2)}
    print(json.dumps(stats, indent=2))
    (OUT_DIR / "results.json").write_text(json.dumps({"stats": stats, "results": results}, indent=2))
    rows = "".join(
        f'<section><h3>{r["objectNumber"]} — {html.escape(r["label"])} ({r["kind"]})</h3>'
        f'<img src="{r["sheet"]}" loading="lazy"></section>' for r in results)
    (OUT_DIR / "index.html").write_text(
        "<!doctype html><meta charset=utf-8><title>SAM 3 point probe</title>"
        "<style>body{font:14px system-ui;margin:16px}img{max-width:100%}</style>"
        f"<h1>SAM 3 point/box probe (MLX)</h1><pre>{html.escape(json.dumps(stats, indent=2))}</pre>{rows}")


if __name__ == "__main__":
    main()
