#!/usr/bin/env python3
"""
Prototype: an EmbeddingGemma 2 image-embedding endpoint on Modal, for searching the collection
with a user's own image (not deployed with the server; feasibility test only).

The model, revision, dtype and resize step are those of embed-corpus-embeddinggemma2-modal.py,
so a returned vector lands in the same space as gemma.db's `images` channel. Two variants are
deployed side by side so the benchmark can compare them:

    ImageEmbedGPU   A10G, bf16 (identical to the corpus build)
    ImageEmbedCPU   no GPU, fp32 (bf16 on CPU is slow; the benchmark measures the parity cost)

Both scale to zero after SCALEDOWN_S idle seconds and load the model from a memory snapshot
on a cold start.

Setup (once):
    export IMAGE_EMBED_TOKEN=$(openssl rand -hex 32)   # keep it: the benchmark needs it too
    ~/miniconda3/envs/embeddings/bin/modal secret create image-embed-auth IMAGE_EMBED_TOKEN=$IMAGE_EMBED_TOKEN
Deploy:
    ~/miniconda3/envs/embeddings/bin/modal deploy scripts/image-embed-endpoint-modal.py
    # prints one https://...modal.run URL per class; pass them to bench-image-embed-endpoint.py

API (every route needs `Authorization: Bearer $IMAGE_EMBED_TOKEN`, so strangers can't start containers):
    GET  /health  -> container facts; use as a warm-up ping
    POST /embed   -> body: raw image bytes (JPEG/PNG/WebP, <= MAX_UPLOAD_BYTES)
                     returns {dim, vector (768 floats, L2-normalised), timings_ms, image, container}
"""

import io
import os
import time

import modal

MODEL_NAME = "google/embeddinggemma-2"
REVISION = "914f7f89142e33e77833254d9c9b90c3cef7303b"   # = embed-corpus-embeddinggemma2-modal.py
MAX_PIXELS = int(280 * 48 * 48 * 1.12)                    # = embed-corpus-embeddinggemma2-modal.py
JPEG_QUALITY = 85                                         # the corpus tars were re-encoded at q85
MAX_UPLOAD_BYTES = 15 * 1024 * 1024
SCALEDOWN_S = 120

app = modal.App("rijksmuseum-image-embed")


def download_model():
    from sentence_transformers import SentenceTransformer
    SentenceTransformer(MODEL_NAME, revision=REVISION, config_kwargs={"audio_config": None})


image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "transformers==5.19.0",
        "sentence-transformers==6.1.0",
        "torch==2.10.0",
        "torchvision==0.25.0",
        "pillow",
        "numpy",
        "fastapi[standard]",
    )
    .run_function(download_model, secrets=[modal.Secret.from_name("huggingface-secret")])
    .env({"HF_HUB_OFFLINE": "1"})
)
auth = modal.Secret.from_name("image-embed-auth")


def preprocess(data: bytes):
    """Same steps as build_shard_tar in the corpus script, plus EXIF rotation for phone photos
    (a no-op for the mirrored IIIF JPEGs, which carry no orientation tag)."""
    from PIL import Image, ImageOps
    im = Image.open(io.BytesIO(data))
    im = ImageOps.exif_transpose(im).convert("RGB")
    original = (im.width, im.height)
    scale = (MAX_PIXELS / (im.width * im.height)) ** 0.5
    if scale < 1:
        im = im.resize((round(im.width * scale), round(im.height * scale)), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=JPEG_QUALITY)
    buf.seek(0)
    return Image.open(buf).convert("RGB"), original


class _Embedder:
    device = "cpu"
    dtype_name = "float32"

    @modal.enter(snap=True)
    def load_cpu(self):
        """Runs before the memory snapshot: the model is restored from it on later cold starts."""
        import torch
        from sentence_transformers import SentenceTransformer
        t0 = time.time()
        self.model = SentenceTransformer(MODEL_NAME, revision=REVISION, device="cpu",
                                         config_kwargs={"audio_config": None},
                                         model_kwargs={"torch_dtype": getattr(torch, self.dtype_name)})
        self.snapshot_load_s = round(time.time() - t0, 2)

    @modal.enter(snap=False)
    def start(self):
        t0 = time.time()
        if self.device != "cpu":
            self.model.to(self.device)
        self.started_at = time.time()
        self.post_restore_s = round(self.started_at - t0, 2)
        self.served = 0

    def facts(self) -> dict:
        return {
            "device": self.device, "dtype": self.dtype_name,
            "uptime_s": round(time.time() - self.started_at, 1),
            "requests_served": self.served,
            "snapshot_load_s": self.snapshot_load_s, "post_restore_s": self.post_restore_s,
        }

    def build_app(self):
        import numpy as np
        from fastapi import FastAPI, HTTPException, Request

        web = FastAPI()
        token = os.environ["IMAGE_EMBED_TOKEN"]

        def check(request: Request):
            if request.headers.get("authorization") != f"Bearer {token}":
                raise HTTPException(401, "bad or missing token")

        @web.get("/health")
        def health(request: Request):
            check(request)
            return {"ok": True, "container": self.facts()}

        @web.post("/embed")
        async def embed(request: Request):
            check(request)
            container = self.facts()  # before this request counts, so requests_served 0 marks a cold call
            t0 = time.perf_counter()
            data = await request.body()
            if not data:
                raise HTTPException(400, "empty body")
            if len(data) > MAX_UPLOAD_BYTES:
                raise HTTPException(413, f"image over {MAX_UPLOAD_BYTES} bytes")
            t1 = time.perf_counter()
            try:
                im, original = preprocess(data)
            except Exception as e:  # PIL raises several types for bad input
                raise HTTPException(415, f"not a readable image: {e}")
            t2 = time.perf_counter()
            vec = self.model.encode([{"image": im}], normalize_embeddings=True, convert_to_numpy=True)[0]
            t3 = time.perf_counter()
            self.served += 1
            return {
                "dim": int(vec.shape[0]),
                "vector": np.asarray(vec, dtype=np.float32).tolist(),
                "timings_ms": {"read": round((t1 - t0) * 1e3, 1), "preprocess": round((t2 - t1) * 1e3, 1),
                               "encode": round((t3 - t2) * 1e3, 1)},
                "image": {"bytes": len(data), "original": original, "encoded": [im.width, im.height]},
                "container": container,
            }

        return web


@app.cls(gpu="A10G", image=image, secrets=[auth], enable_memory_snapshot=True,
         scaledown_window=SCALEDOWN_S, max_containers=2, timeout=300)
class ImageEmbedGPU(_Embedder):
    device = "cuda"
    dtype_name = "bfloat16"  # never fp16: activations overflow into NaNs

    @modal.asgi_app()
    def web(self):
        return self.build_app()


@app.cls(cpu=4.0, memory=8192, image=image, secrets=[auth], enable_memory_snapshot=True,
         scaledown_window=SCALEDOWN_S, max_containers=2, timeout=300)
class ImageEmbedCPU(_Embedder):
    device = "cpu"
    dtype_name = "float32"

    @modal.asgi_app()
    def web(self):
        return self.build_app()
