#!/usr/bin/env python3
"""
Reference run of probe-sam3-points-mlx.py's point/box cases on the PyTorch SAM 3 tracker
(transformers Sam3TrackerModel, MPS), to separate model behaviour from MLX-port artefacts.

Same venv as the MLX probe, plus: uv pip install -p <venv>/bin/python transformers==5.19.0 torch torchvision
    <venv>/bin/python scripts/probe-sam3-points-torch.py
Writes data/sam3-probe/points-torch/.
"""

import html
import importlib.util
import json
import time
from pathlib import Path

import numpy as np
import torch
from PIL import Image

SCRIPT_DIR = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("mlx_probe", SCRIPT_DIR / "probe-sam3-points-mlx.py")
mlx_probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mlx_probe)

OUT_DIR = SCRIPT_DIR.parent / "data" / "sam3-probe" / "points-torch"
MODEL_NAME = "facebook/sam3"
REVISION = "3c879f39826c281e95690f02c7821c4de09afae7"


def main():
    from transformers import Sam3TrackerModel, Sam3TrackerProcessor

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    t = time.perf_counter()
    processor = Sam3TrackerProcessor.from_pretrained(MODEL_NAME, revision=REVISION)
    model = Sam3TrackerModel.from_pretrained(MODEL_NAME, revision=REVISION).to(device).eval()
    load_s = time.perf_counter() - t

    cache, results, encode_s, prompt_s = {}, [], [], []
    for i, (obj, label, kind, coords) in enumerate(mlx_probe.CASES):
        img = Image.open(mlx_probe.IMG_DIR / f"{obj}.jpg").convert("RGB")
        W, H = img.size
        with torch.inference_mode():
            if obj not in cache:
                t = time.perf_counter()
                inputs = processor(images=img, return_tensors="pt").to(device)
                emb = model.get_image_embeddings(inputs["pixel_values"])
                if device == "mps":
                    torch.mps.synchronize()
                encode_s.append(time.perf_counter() - t)
                cache = {obj: (inputs["original_sizes"], emb)}
            original_sizes, emb = cache[obj]

            t = time.perf_counter()
            if kind == "point":
                prompt_inputs = processor(input_points=[[[[coords[0] * W, coords[1] * H]]]],
                                          input_labels=[[[1]]], original_sizes=original_sizes,
                                          return_tensors="pt")
            else:
                prompt_inputs = processor(input_boxes=[[[coords[0] * W, coords[1] * H,
                                                         coords[2] * W, coords[3] * H]]],
                                          original_sizes=original_sizes, return_tensors="pt")
            prompt_inputs = {k: v.to(device) for k, v in prompt_inputs.items() if k != "original_sizes"}
            out = model(image_embeddings=emb, multimask_output=True, **prompt_inputs)
            masks = processor.post_process_masks(out.pred_masks.cpu(), original_sizes.cpu())[0][0].numpy()
            scores = out.iou_scores[0, 0].float().cpu().numpy()
            prompt_s.append(time.perf_counter() - t)

        fname = f"{obj}__{i}.jpg"
        mlx_probe.render(img, masks, scores, kind, coords, OUT_DIR / fname)
        results.append({"objectNumber": obj, "label": label, "kind": kind, "coords": coords,
                        "iou": [round(float(s), 3) for s in scores],
                        "area": [round(float(m.mean()), 4) for m in masks], "sheet": fname})
        print(f"{obj:<14} {label:<22} {kind:<5} iou={np.round(scores, 2)}")

    stats = {"model": MODEL_NAME, "device": device, "load_s": round(load_s, 1),
             "encode_s": [round(s, 2) for s in encode_s],
             "prompt_ms_median": round(sorted(prompt_s)[len(prompt_s) // 2] * 1000)}
    if device == "mps":
        stats["mps_driver_gb"] = round(torch.mps.driver_allocated_memory() / 1e9, 2)
    print(json.dumps(stats, indent=2))
    (OUT_DIR / "results.json").write_text(json.dumps({"stats": stats, "results": results}, indent=2))
    rows = "".join(
        f'<section><h3>{r["objectNumber"]} — {html.escape(r["label"])} ({r["kind"]})</h3>'
        f'<img src="{r["sheet"]}" loading="lazy"><br>'
        f'<img src="../points/{r["sheet"]}" loading="lazy" style="opacity:.85"><p>top: PyTorch, bottom: MLX</p></section>'
        for r in results)
    (OUT_DIR / "index.html").write_text(
        "<!doctype html><meta charset=utf-8><title>SAM 3 point probe (PyTorch)</title>"
        "<style>body{font:14px system-ui;margin:16px}img{max-width:100%}</style>"
        f"<h1>SAM 3 point/box probe — PyTorch vs MLX</h1><pre>{html.escape(json.dumps(stats, indent=2))}</pre>{rows}")


if __name__ == "__main__":
    main()
