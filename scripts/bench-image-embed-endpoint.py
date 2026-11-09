#!/usr/bin/env python3
"""
Benchmark for image-embed-endpoint-modal.py: cold start, warm latency, parity with the stored
corpus vectors, and robustness to photo-like distortions. Plain python (numpy + Pillow); no
Modal SDK needed, it talks HTTP to the deployed endpoints.

    export IMAGE_EMBED_TOKEN=...   # the one stored in the image-embed-auth Modal secret
    ~/miniconda3/envs/embeddings/bin/python scripts/bench-image-embed-endpoint.py \\
        --endpoint gpu=https://<workspace>--rijksmuseum-image-embed-imageembedgpu-web.modal.run \\
        --endpoint cpu=https://<workspace>--rijksmuseum-image-embed-imageembedcpu-web.modal.run

Per endpoint:
  1. cold   one /embed call; reported as cold only if the container had served nothing before it.
            Containers scale down after 120 s idle, so for a true cold start run this at least
            that long after the last call (or pass --cold-wait 150).
  2. warm   --n mirrored collection images sent as-is (the endpoint applies the corpus resize).
  3. parity cosine of each returned vector with its stored vector in images.npz, and its
            self-retrieval rank among all stored image vectors (1 = its own image comes first).
  4. robust the same images after a centre crop, a slight rotation, and a phone-like downscale
            with heavy JPEG compression; reports the rank of the original artwork.

Writes everything to data/egemma2-test/image-endpoint-bench-<time>.json and prints a summary.
"""

import argparse
import io
import json
import os
import random
import statistics
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image

PROJECT_DIR = Path(__file__).resolve().parent.parent
DEFAULT_NPZ = PROJECT_DIR / "data" / "egemma2-test" / "corpus" / "images.npz"
CORPUS = Path("/Volumes/sand/rijksmuseum-bucket")
OUT_DIR = PROJECT_DIR / "data" / "egemma2-test"


def call(url: str, token: str, path: str, body: bytes | None = None, timeout: float = 300) -> tuple[dict, float]:
    req = urllib.request.Request(url.rstrip("/") + path, data=body, method="POST" if body is not None else "GET",
                                 headers={"Authorization": f"Bearer {token}",
                                          **({"Content-Type": "application/octet-stream"} if body else {})})
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = json.load(r)
    except urllib.error.HTTPError as e:
        sys.exit(f"{path} -> HTTP {e.code}: {e.read().decode(errors='replace')[:300]}")
    return data, (time.perf_counter() - t0) * 1e3


def sample_images(ids_in_npz: set[str], n: int, seed: int) -> list[tuple[str, Path]]:
    """n random mirrored images that have a stored vector, avoiding ids that collide case-insensitively
    on the mirror's volume (the corpus build skipped those too)."""
    rng = random.Random(seed)
    shards = sorted((CORPUS / "state").glob("shard-*.state.json"))
    if not shards:
        sys.exit(f"no shard state files under {CORPUS / 'state'}; is the mirror volume mounted?")
    rng.shuffle(shards)
    picked: list[tuple[str, Path]] = []
    for sf in shards:
        expected = json.loads(sf.read_text())["expected"]
        lower: dict[str, int] = {}
        for iid in expected:
            lower[iid.lower()] = lower.get(iid.lower(), 0) + 1
        cands = [i for i in expected if i in ids_in_npz and lower[i.lower()] == 1]
        rng.shuffle(cands)
        for iid in cands[:1]:
            src = CORPUS / "downloads" / sf.name.replace(".state.json", "") / f"{iid}.jpg"
            if src.exists():
                picked.append((iid, src))
        if len(picked) >= n:
            break
    return picked


def variants(data: bytes) -> dict[str, bytes]:
    im = Image.open(io.BytesIO(data)).convert("RGB")
    w, h = im.size

    def jpeg(x: Image.Image, q: int = 90) -> bytes:
        buf = io.BytesIO()
        x.save(buf, "JPEG", quality=q)
        return buf.getvalue()

    crop = im.crop((round(w * 0.125), round(h * 0.125), round(w * 0.875), round(h * 0.875)))
    rot = im.rotate(6, resample=Image.BICUBIC, expand=False)
    rot = rot.crop((round(w * 0.08), round(h * 0.08), round(w * 0.92), round(h * 0.92)))
    s = 480 / max(w, h)
    small = im.resize((max(1, round(w * s)), max(1, round(h * s))), Image.LANCZOS) if s < 1 else im
    return {"crop75": jpeg(crop), "rotate6": jpeg(rot), "small_q35": jpeg(small, 35)}


def rank_of(q: np.ndarray, vecs: np.ndarray, own_rows: np.ndarray, chunk: int = 200_000) -> int:
    """1 + number of stored vectors from other images scoring above the best of the image's own rows."""
    own = float((vecs[own_rows].astype(np.float32) @ q).max())
    mask = np.ones(len(vecs), dtype=bool)
    mask[own_rows] = False
    above = 0
    for i in range(0, len(vecs), chunk):
        s = vecs[i:i + chunk].astype(np.float32) @ q
        above += int(((s > own) & mask[i:i + chunk]).sum())
    return above + 1


def pct(xs: list[float], p: float) -> float:
    xs = sorted(xs)
    return xs[min(len(xs) - 1, round(p * (len(xs) - 1)))]


def summarise_ranks(ranks: list[int]) -> dict:
    return {"top1": sum(r == 1 for r in ranks) / len(ranks), "top10": sum(r <= 10 for r in ranks) / len(ranks),
            "median": statistics.median(ranks), "worst": max(ranks)}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--endpoint", action="append", required=True, help="label=url (repeatable)")
    ap.add_argument("--n", type=int, default=40, help="sampled collection images (default 40)")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--npz", type=Path, default=DEFAULT_NPZ)
    ap.add_argument("--cold-wait", type=float, default=0, help="seconds to wait before each endpoint's cold call")
    ap.add_argument("--no-robust", action="store_true", help="skip the distortion variants")
    args = ap.parse_args()
    token = os.environ.get("IMAGE_EMBED_TOKEN") or sys.exit("set IMAGE_EMBED_TOKEN")
    endpoints = [e.split("=", 1) for e in args.endpoint]

    print(f"loading {args.npz} ...", flush=True)
    d = np.load(args.npz)
    iiif_ids, vecs = d["iiif_id"], d["vec"]  # float16, L2-normalised
    rows_by_id: dict[str, list[int]] = {}
    for i, iid in enumerate(iiif_ids.tolist()):
        rows_by_id.setdefault(iid, []).append(i)
    print(f"{len(vecs):,} stored image vectors", flush=True)

    sample = sample_images(set(rows_by_id), args.n, args.seed)
    print(f"{len(sample)} sampled images", flush=True)
    raw = {iid: p.read_bytes() for iid, p in sample}
    report: dict = {"n": len(sample), "seed": args.seed, "stored_vectors": len(vecs), "endpoints": {}}

    for label, url in endpoints:
        print(f"\n== {label}: {url}", flush=True)
        if args.cold_wait:
            print(f"waiting {args.cold_wait:.0f} s for containers to scale down ...", flush=True)
            time.sleep(args.cold_wait)
        first_iid = sample[0][0]
        cold, cold_ms = call(url, token, "/embed", raw[first_iid])
        was_cold = cold["container"]["requests_served"] == 0
        print(f"first call {cold_ms / 1e3:.1f} s ({'cold' if was_cold else 'container was already warm'}); "
              f"container {cold['container']}", flush=True)

        warm_rt, warm_enc, cosines, ranks, per_image = [], [], [], [], []
        robust: dict[str, list[int]] = {}
        for k, (iid, _) in enumerate(sample, 1):
            res, ms = call(url, token, "/embed", raw[iid])
            q = np.asarray(res["vector"], dtype=np.float32)
            own = np.array(rows_by_id[iid])
            cos = float((vecs[own].astype(np.float32) @ q).max())
            r = rank_of(q, vecs, own)
            warm_rt.append(ms), warm_enc.append(res["timings_ms"]["encode"]), cosines.append(cos), ranks.append(r)
            row = {"iiif_id": iid, "bytes": len(raw[iid]), "roundtrip_ms": round(ms, 1),
                   "timings_ms": res["timings_ms"], "cosine_to_stored": round(cos, 4), "rank": r}
            if not args.no_robust:
                for name, body in variants(raw[iid]).items():
                    vres, _ = call(url, token, "/embed", body)
                    vr = rank_of(np.asarray(vres["vector"], dtype=np.float32), vecs, own)
                    robust.setdefault(name, []).append(vr)
                    row[f"rank_{name}"] = vr
            per_image.append(row)
            print(f"  {k}/{len(sample)} {iid}: {ms:.0f} ms, cos {cos:.4f}, rank {r}"
                  + "".join(f", {n} {row[f'rank_{n}']}" for n in robust), flush=True)

        summary = {
            "first_call_s": round(cold_ms / 1e3, 2), "first_call_was_cold": was_cold,
            "first_call_container": cold["container"],
            "warm_roundtrip_ms": {"p50": round(pct(warm_rt, .5)), "p90": round(pct(warm_rt, .9)), "max": round(max(warm_rt))},
            "warm_encode_ms": {"p50": round(pct(warm_enc, .5)), "p90": round(pct(warm_enc, .9))},
            "cosine_to_stored": {"min": round(min(cosines), 4), "median": round(statistics.median(cosines), 4)},
            "self_retrieval": summarise_ranks(ranks),
            "robustness": {n: summarise_ranks(rs) for n, rs in robust.items()},
        }
        report["endpoints"][label] = {"url": url, "summary": summary, "images": per_image}
        print(json.dumps(summary, indent=2), flush=True)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / f"image-endpoint-bench-{time.strftime('%Y%m%d-%H%M%S')}.json"
    out.write_text(json.dumps(report, indent=2))
    print(f"\nwrote {out}")


if __name__ == "__main__":
    main()
