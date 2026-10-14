#!/usr/bin/env python3
"""
Build the deployable gemma.db (EmbeddingGemma 2 vectors) for multimodal_search.

Inputs are the int8 corpus sets quantised from the fp16 masters
(data/egemma2-test/corpus/int8/, one shared scale, 768d):
  text-metadata.npz  -> vec_gemma_metadata   (metadata composite, one per artwork)
  images.npz         -> vec_gemma_images     (one image per artwork)
  text-iconclass.npz -> vec_gemma_iconclass  (base notations that tag Rijksmuseum artworks)

art_ids are re-resolved against the vocab DB by object_number, so the vectors line
up with the harvest the server runs on; rows whose object_number is gone are dropped.
Iconclass notations keep only those whose base form (key expansion / bracketed name
stripped) occurs in the vocab DB — a notation with no artworks can't feed the channel.

Usage:
  ~/miniconda3/envs/embeddings/bin/python scripts/build-gemma-db.py \
    --out data/gemma.db
"""

import argparse
import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import sqlite_vec

ROOT = Path(__file__).resolve().parent.parent
MODEL = "google/embeddinggemma-2"
MODEL_REVISION = "914f7f8"
QUERY_MODEL = "onnx-community/embeddinggemma-2-ONNX"
IMAGE_SOFT_TOKENS = 280
BATCH = 10_000


def open_vec(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.enable_load_extension(True)
    sqlite_vec.load(conn)
    conn.enable_load_extension(False)
    return conn


def create_vec0(db: sqlite3.Connection, name: str, key: str, dims: int) -> None:
    db.execute(f"""
        CREATE VIRTUAL TABLE {name} USING vec0(
            {key} INTEGER PRIMARY KEY,
            embedding int8[{dims}] distance_metric=cosine
        )
    """)


def insert_vectors(db: sqlite3.Connection, table: str, key: str, ids: np.ndarray, vecs: np.ndarray) -> None:
    for i in range(0, len(ids), BATCH):
        db.executemany(
            f"INSERT INTO {table} ({key}, embedding) VALUES (?, vec_int8(?))",
            ((int(a), v.tobytes()) for a, v in zip(ids[i:i + BATCH], vecs[i:i + BATCH])),
        )
    db.commit()


def resolve_art_ids(object_numbers: np.ndarray, art_by_obj: dict[str, int]) -> tuple[np.ndarray, np.ndarray]:
    """Return (row indices to keep, current art_ids) for rows whose object_number is in the vocab DB."""
    keep, ids = [], []
    for i, o in enumerate(object_numbers.tolist()):
        a = art_by_obj.get(o)
        if a is not None:
            keep.append(i)
            ids.append(a)
    return np.asarray(keep, dtype=np.int64), np.asarray(ids, dtype=np.int64)


def base_notation(n: str) -> str:
    return n.split("(", 1)[0]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=str(ROOT / "data/egemma2-test/corpus/int8"))
    ap.add_argument("--vocab", default=str(ROOT / "data/vocabulary.db"))
    ap.add_argument("--iconclass-db", default=str(ROOT.parent / "rijksmuseum-iconclass-mcp/data/iconclass.db"))
    ap.add_argument("--out", default=str(ROOT / "data/gemma.db"))
    args = ap.parse_args()

    if os.path.exists(args.out):
        raise SystemExit(f"refusing to overwrite existing {args.out} — remove it first")
    src = Path(args.src)
    quant = json.loads((src / "quantization.json").read_text())
    dims = int(quant["dims"])

    vocab = sqlite3.connect(f"file:{args.vocab}?mode=ro", uri=True)
    art_by_obj = dict(vocab.execute("SELECT object_number, art_id FROM artworks"))
    vocab_vi = dict(vocab.execute("SELECT key, value FROM version_info"))
    vocab_notations = {r[0] for r in vocab.execute(
        "SELECT notation FROM vocabulary WHERE notation IS NOT NULL AND notation != ''"
    )}
    vocab.close()
    vocab_bases = {base_notation(n) for n in vocab_notations}
    print(f"vocab: {len(art_by_obj):,} artworks, {len(vocab_notations):,} notations ({len(vocab_bases):,} base)")

    db = open_vec(args.out)
    db.execute("CREATE TABLE version_info (key TEXT PRIMARY KEY, value TEXT)")
    db.execute("CREATE TABLE artwork_object_numbers (art_id INTEGER PRIMARY KEY, object_number TEXT NOT NULL)")
    db.execute("CREATE TABLE iconclass_notations (id INTEGER PRIMARY KEY, notation TEXT UNIQUE NOT NULL, label TEXT)")

    counts: dict[str, int] = {}
    objects: dict[int, str] = {}
    for stem, table in (("text-metadata", "vec_gemma_metadata"), ("images", "vec_gemma_images")):
        z = np.load(src / f"{stem}.npz")
        on, vec = z["object_number"], z["vec"]
        assert vec.shape[1] == dims, f"{stem}: {vec.shape[1]}d != {dims}d"
        keep, ids = resolve_art_ids(on, art_by_obj)
        assert len(set(ids.tolist())) == len(ids), f"{stem}: duplicate art_ids after resolution"
        stale = int((z["art_id"][keep] != ids).sum())
        print(f"{stem}: {len(on):,} rows, {len(on) - len(keep):,} not in vocab DB (dropped), {stale:,} art_ids remapped")
        create_vec0(db, table, "artwork_id", dims)
        insert_vectors(db, table, "artwork_id", ids, vec[keep])
        counts[table] = len(ids)
        objects.update(zip(ids.tolist(), on[keep].tolist()))
    db.executemany("INSERT INTO artwork_object_numbers (art_id, object_number) VALUES (?, ?)", sorted(objects.items()))
    db.commit()

    z = np.load(src / "text-iconclass.npz")
    notations, vec = z["object_number"].tolist(), z["vec"]
    keep = [i for i, n in enumerate(notations) if n in vocab_bases]
    ic = sqlite3.connect(f"file:{args.iconclass_db}?mode=ro", uri=True)
    labels: dict[str, dict[str, str]] = {}
    for n, lang, t in ic.execute("SELECT notation, lang, text FROM texts WHERE lang IN ('en', 'nl')"):
        labels.setdefault(n, {})[lang] = t
    ic.close()
    db.executemany(
        "INSERT INTO iconclass_notations (id, notation, label) VALUES (?, ?, ?)",
        ((k, notations[i], labels.get(notations[i], {}).get("en") or labels.get(notations[i], {}).get("nl"))
         for k, i in enumerate(keep)),
    )
    create_vec0(db, "vec_gemma_iconclass", "notation_id", dims)
    insert_vectors(db, "vec_gemma_iconclass", "notation_id", np.arange(len(keep)), vec[keep])
    counts["vec_gemma_iconclass"] = len(keep)
    print(f"iconclass: {len(notations):,} base notations, {len(keep):,} tag Rijksmuseum artworks")

    vi = {
        "model": MODEL,
        "model_revision": MODEL_REVISION,
        "query_model": QUERY_MODEL,
        "dimensions": str(dims),
        "quantization": "int8",
        "int8_scale": str(quant["int8_scale"]),
        "image_soft_tokens": str(IMAGE_SOFT_TOKENS),
        "metadata_count": str(counts["vec_gemma_metadata"]),
        "image_count": str(counts["vec_gemma_images"]),
        "iconclass_count": str(counts["vec_gemma_iconclass"]),
        "built_at": datetime.now(timezone.utc).isoformat(),
        "vocab_db_built_at": vocab_vi.get("built_at", ""),
    }
    db.executemany("INSERT INTO version_info (key, value) VALUES (?, ?)", vi.items())
    db.commit()

    print("VACUUM ...")
    db.execute("VACUUM")
    for table, n in counts.items():
        got = db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        assert got == n, f"{table}: {got} != {n}"
    db.close()
    print(f"\n=== {args.out} ({os.path.getsize(args.out) / 2**20:.1f} MB) ===")
    for k, v in vi.items():
        print(f"  {k}: {v}")


if __name__ == "__main__":
    main()
