#!/usr/bin/env python3
"""
Prototype two-stage layout for gemma.db latency/memory benchmarking (not deployable:
art_ids come straight from the npz, no vocab re-resolution).

Per channel:
  vec_<ch>_c<D>     vec0 int8[D] (MRL-truncated prefix of the 768d vector) — coarse scan
  <ch>_vectors      plain rowid table, artwork_id -> 768-byte int8 blob — rescore lookups

Usage:
  ~/miniconda3/envs/embeddings/bin/python scripts/build-gemma-twostage-proto.py \
    --out data/egemma2-test/binary/proto.db --dims 256 384
"""

import argparse
import os
import sqlite3
from pathlib import Path

import numpy as np
import sqlite_vec

ROOT = Path(__file__).resolve().parent.parent
BATCH = 10_000


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=str(ROOT / "data/egemma2-test/corpus/int8"))
    ap.add_argument("--out", required=True)
    ap.add_argument("--dims", type=int, nargs="+", default=[384])
    args = ap.parse_args()
    if os.path.exists(args.out):
        raise SystemExit(f"refusing to overwrite {args.out}")

    db = sqlite3.connect(args.out)
    db.enable_load_extension(True)
    sqlite_vec.load(db)
    for stem, ch in (("text-metadata", "metadata"), ("images", "images")):
        z = np.load(Path(args.src) / f"{stem}.npz")
        ids, vec = z["art_id"].astype(np.int64), z["vec"]
        _, first = np.unique(ids, return_index=True)
        ids, vec = ids[first], vec[first]
        db.execute(f"CREATE TABLE {ch}_vectors (artwork_id INTEGER PRIMARY KEY, embedding BLOB NOT NULL)")
        for i in range(0, len(ids), BATCH):
            db.executemany(f"INSERT INTO {ch}_vectors VALUES (?, ?)",
                           ((int(a), v.tobytes()) for a, v in zip(ids[i:i + BATCH], vec[i:i + BATCH])))
        for d in args.dims:
            db.execute(f"CREATE VIRTUAL TABLE vec_{ch}_c{d} USING vec0(artwork_id INTEGER PRIMARY KEY, "
                       f"embedding int8[{d}] distance_metric=cosine)")
            for i in range(0, len(ids), BATCH):
                db.executemany(f"INSERT INTO vec_{ch}_c{d} (artwork_id, embedding) VALUES (?, vec_int8(?))",
                               ((int(a), np.ascontiguousarray(v[:d]).tobytes())
                                for a, v in zip(ids[i:i + BATCH], vec[i:i + BATCH])))
        db.commit()
        print(f"{ch}: {len(ids):,} rows")
    db.execute("VACUUM")
    db.close()
    print(f"{args.out}: {os.path.getsize(args.out) / 2**20:.0f} MB")


if __name__ == "__main__":
    main()
