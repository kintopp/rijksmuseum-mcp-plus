#!/usr/bin/env python3
"""
Recall of a binary (1 bit/dim) coarse scan against exact int8 cosine KNN, for the
gemma.db metadata and image channels.

For each query, exact top-K (cosine on the int8 corpus, what vec0 returns today) is the
reference; a coarse scan returns top-C by Hamming distance, and the rescored list is the
exact ranking restricted to those C — so recall@K of the coarse set is the whole story.

Variants (doc bits / query bits):
  sign      sign(x)      / sign(q)
  centered  sign(x - mu) / sign(q)     mu = corpus mean; q·x = q·(x-mu) + const
Also: 512d MRL truncation (exact, renormalised) for reference.

Usage:
  ~/miniconda3/envs/embeddings/bin/python scripts/gemma-binary-recall.py \
    --queries data/egemma2-test/binary/queries.json
"""

import argparse
import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
CHUNK = 100_000


def topk(scores: np.ndarray, k: int) -> np.ndarray:
    idx = np.argpartition(-scores, k, axis=1)[:, :k]
    order = np.argsort(-np.take_along_axis(scores, idx, axis=1), axis=1)
    return np.take_along_axis(idx, order, axis=1)


def scores_for(q: np.ndarray, docs: np.ndarray, transform) -> np.ndarray:
    out = np.empty((q.shape[0], docs.shape[0]), dtype=np.float32)
    for i in range(0, docs.shape[0], CHUNK):
        out[:, i:i + CHUNK] = q @ transform(docs[i:i + CHUNK]).T
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--queries", required=True)
    ap.add_argument("--src", default=str(ROOT / "data/egemma2-test/corpus/int8"))
    ap.add_argument("--k", type=int, nargs="+", default=[10, 50, 250])
    ap.add_argument("--c", type=int, nargs="+", default=[1000, 2000, 4000])
    args = ap.parse_args()

    rows = json.loads(Path(args.queries).read_text())
    q = np.asarray([r["vec"] for r in rows], dtype=np.float32)
    print(f"{len(q)} queries")

    mu_text = None
    for stem in ("text-metadata", "images"):
        x = np.load(Path(args.src) / f"{stem}.npz")["vec"]  # int8
        n = x.shape[0]
        norms = np.linalg.norm(x.astype(np.float32), axis=1)
        exact = scores_for(q, x, lambda d: d.astype(np.float32)) / norms[None, :]
        ref = topk(exact, max(args.k))
        mu = x.astype(np.float32).mean(axis=0)
        if mu_text is None:
            mu_text = mu / np.linalg.norm(mu)  # text-side mean, used to centre queries
        qc = q - (q @ mu_text)[:, None] * mu_text[None, :]

        def trunc(d: int):
            def tf(b):
                f = b[:, :d].astype(np.float32)
                return f / np.linalg.norm(f, axis=1, keepdims=True)
            return tf

        variants = {
            "sign": (np.sign(q), lambda d: np.where(d > 0, 1.0, -1.0).astype(np.float32)),
            "centered": (np.sign(q), lambda d: np.where(d.astype(np.float32) > mu, 1.0, -1.0).astype(np.float32)),
            "both-ctr": (np.sign(qc), lambda d: np.where(d.astype(np.float32) > mu, 1.0, -1.0).astype(np.float32)),
            "asym(ub)": (q, lambda d: np.where(d.astype(np.float32) > mu, 1.0, -1.0).astype(np.float32)),
            "int8-256": (q[:, :256] / np.linalg.norm(q[:, :256], axis=1, keepdims=True), trunc(256)),
            "int8-384": (q[:, :384] / np.linalg.norm(q[:, :384], axis=1, keepdims=True), trunc(384)),
        }
        print(f"\n=== {stem} ({n:,} vectors) — recall of exact top-K within coarse top-C (mean / min over queries) ===")
        for name, (qq, tf) in variants.items():
            coarse = topk(scores_for(qq.astype(np.float32), x, tf), max(args.c))
            for c in args.c:
                parts = []
                for k in args.k:
                    rec = [len(set(ref[i, :k]) & set(coarse[i, :c])) / k for i in range(len(q))]
                    parts.append(f"R@{k} {np.mean(rec):.3f}/{np.min(rec):.2f}")
                print(f"  {name:9s} C={c:5d}  " + "  ".join(parts))

        x512 = x[:, :512].astype(np.float32)
        x512 /= np.linalg.norm(x512, axis=1, keepdims=True)
        q512 = q[:, :512] / np.linalg.norm(q[:, :512], axis=1, keepdims=True)
        t512 = topk(scores_for(q512, x512, lambda d: d), max(args.k))
        parts = [f"overlap@{k} {np.mean([len(set(ref[i, :k]) & set(t512[i, :k])) / k for i in range(len(q))]):.3f}"
                 for k in args.k]
        print(f"  512d exact (no rescore)  " + "  ".join(parts))
        del exact


if __name__ == "__main__":
    main()
