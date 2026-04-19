#!/usr/bin/env python3
"""
Generate description-only embeddings using Modal A10G.

Phase 1 (local):  Load description texts from vocab DB (only artworks with description_text)
Phase 2 (Modal):  Embed with clips/e5-small-trm-nl on A10 GPU → int8[384]
Phase 3 (local):  Write to description tables in existing embeddings.db
Phase 4 (local):  Validate with test queries

Usage:
    modal run scripts/generate-description-embeddings-modal.py
    modal run scripts/generate-description-embeddings-modal.py --limit 5000  # quick test

Prerequisites:
    pip install modal sqlite-vec numpy
    modal setup

Output:
    Adds desc_embeddings + vec_desc_artworks tables to data/embeddings.db
"""

import os
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path

import modal
import numpy as np

# ─── Constants ──────────────────────────────────────────────────────────

SCRIPT_DIR = Path(__file__).resolve().parent


def _find_project_root() -> Path:
    d = SCRIPT_DIR
    for _ in range(10):
        if (d / "package.json").exists():
            return d
        d = d.parent
    return SCRIPT_DIR.parent


PROJECT_DIR = _find_project_root()
DEFAULT_VOCAB_DB = PROJECT_DIR / "data" / "vocabulary.db"
DEFAULT_EMBEDDINGS_DB = PROJECT_DIR / "data" / "embeddings.db"

MODEL_NAME = "clips/e5-small-trm-nl"
DIMS = 384
COMMIT_BATCH = 5000
MODAL_BATCH_SIZE = 512

# ─── Modal app ──────────────────────────────────────────────────────────

app = modal.App("rijksmuseum-desc-embeddings")


def download_model():
    from sentence_transformers import SentenceTransformer
    SentenceTransformer(MODEL_NAME)


gpu_image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "sentence-transformers>=3.0",
        "transformers>=4.46",
        "torch",
        "numpy",
    )
    .run_function(download_model, secrets=[modal.Secret.from_name("huggingface-secret")])
)


@app.cls(
    gpu="A10G",
    image=gpu_image,
    scaledown_window=60,
    timeout=3600,
    secrets=[modal.Secret.from_name("huggingface-secret")],
)
class Embedder:
    @modal.enter()
    def load(self):
        from sentence_transformers import SentenceTransformer
        self.model = SentenceTransformer(MODEL_NAME, device="cuda")
        self.model.encode(["warmup"], normalize_embeddings=True)

    def _encode_int8(self, texts: list[str]) -> bytes:
        """Encode texts → normalized float32 → int8 quantized bytes."""
        import numpy as np
        embs = self.model.encode(texts, normalize_embeddings=True, show_progress_bar=False)
        return np.clip(embs * 127, -127, 127).astype(np.int8).tobytes()

    @modal.method()
    def embed(self, texts: list[str]) -> bytes:
        """Embed passage texts → int8 → flat bytes."""
        return self._encode_int8([f"passage: {t}" for t in texts])

    @modal.method()
    def embed_queries(self, queries: list[str]) -> bytes:
        """Embed query texts → int8 → flat bytes."""
        return self._encode_int8([f"query: {q}" for q in queries])


# ─── Local helpers ──────────────────────────────────────────────────────


def open_vec_db(path: str) -> sqlite3.Connection:
    import sqlite_vec
    conn = sqlite3.connect(path)
    conn.enable_load_extension(True)
    sqlite_vec.load(conn)
    conn.enable_load_extension(False)
    return conn


def load_descriptions(vocab_db: str) -> list[tuple[int, str, str]]:
    """Load artworks that have description_text.

    Returns list of (art_id, object_number, description_text) tuples.
    """
    conn = sqlite3.connect(f"file:{vocab_db}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row

    print("  Loading artworks with descriptions...")
    rows = conn.execute("""
        SELECT art_id, object_number, description_text
        FROM artworks
        WHERE description_text IS NOT NULL AND description_text != ''
    """).fetchall()
    conn.close()

    artworks = [(r["art_id"], r["object_number"], r["description_text"]) for r in rows]
    avg_len = sum(len(t) for _, _, t in artworks) / max(len(artworks), 1)
    print(f"    {len(artworks):,} artworks with descriptions")
    print(f"    Average description length: {avg_len:.0f} chars")
    return artworks


def ensure_desc_tables(conn: sqlite3.Connection, dims: int):
    """Create description embedding tables (separate from main embeddings)."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS desc_embeddings (
            art_id        INTEGER PRIMARY KEY,
            object_number TEXT UNIQUE NOT NULL,
            embedding     BLOB NOT NULL
        )
    """)
    conn.execute(f"""
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_desc_artworks USING vec0(
            artwork_id INTEGER PRIMARY KEY,
            embedding int8[{dims}] distance_metric=cosine
        )
    """)


def flush_desc_batch(conn, regular_rows, vec_rows):
    conn.executemany(
        "INSERT OR REPLACE INTO desc_embeddings "
        "(art_id, object_number, embedding) VALUES (?, ?, ?)",
        regular_rows,
    )
    conn.executemany(
        "DELETE FROM vec_desc_artworks WHERE artwork_id = ?",
        [(aid,) for aid, _ in vec_rows],
    )
    conn.executemany(
        "INSERT INTO vec_desc_artworks (artwork_id, embedding) VALUES (?, vec_int8(?))",
        vec_rows,
    )
    conn.commit()


def validate_desc(output_path: str, embedder: Embedder):
    """Run test queries against description embeddings."""
    conn = open_vec_db(output_path)
    count = conn.execute("SELECT COUNT(*) FROM desc_embeddings").fetchone()[0]
    vec_count = conn.execute("SELECT COUNT(*) FROM vec_desc_artworks").fetchone()[0]
    size_mb = os.path.getsize(output_path) / (1024 * 1024)
    print(f"\n  Embeddings DB: {size_mb:.1f} MB total")
    print(f"  Description embeddings: {count:,} regular, {vec_count:,} vec0")
    if count != vec_count:
        print(f"  WARNING: table mismatch!")

    # Dutch description-style queries (since descriptions are in Dutch)
    queries = [
        "winterlandschap met schaatsers op het ijs",
        "portret van een man met een baard",
        "stilleven met bloemen in een vaas",
        "gezicht op een stad met kerktoren",
        "schip op zee bij storm",
    ]

    query_bytes = embedder.embed_queries.remote(queries)
    query_int8 = np.frombuffer(query_bytes, dtype=np.int8).reshape(len(queries), DIMS)

    # Look up titles for display
    vocab_db = str(DEFAULT_VOCAB_DB)
    vconn = sqlite3.connect(f"file:{vocab_db}?mode=ro", uri=True)

    for i, query in enumerate(queries):
        qblob = query_int8[i].tobytes()
        rows = conn.execute("""
            SELECT artwork_id, distance FROM vec_desc_artworks
            WHERE embedding MATCH vec_int8(?) AND k = 5
            ORDER BY distance
        """, (qblob,)).fetchall()

        print(f'\n  Query: "{query}"')
        for art_id, dist in rows:
            obj_row = conn.execute(
                "SELECT object_number FROM desc_embeddings WHERE art_id = ?", (art_id,)
            ).fetchone()
            obj_num = obj_row[0] if obj_row else f"art_id:{art_id}"
            title_row = vconn.execute(
                "SELECT title FROM artworks WHERE art_id = ?", (art_id,)
            ).fetchone()
            title = title_row[0] if title_row else ""
            print(f"    [{1 - dist:.3f}] {obj_num} — {title[:60]}")

    vconn.close()
    conn.close()


# ─── Entrypoint ─────────────────────────────────────────────────────────


@app.local_entrypoint()
def main(
    limit: int = 0,
    batch_size: int = MODAL_BATCH_SIZE,
):
    output = str(DEFAULT_EMBEDDINGS_DB)
    vocab_db = str(DEFAULT_VOCAB_DB)

    start = time.time()
    print("Description Embeddings via Modal (A10G GPU)")
    print(f"  Model:        {MODEL_NAME}")
    print(f"  Dimensions:   {DIMS}")
    print(f"  Quantization: int8")
    print(f"  Output:       {output} (adding desc tables)")

    embedder = Embedder()

    # ── Phase 1: Load descriptions ────────────────────────────────────
    print(f"\nPhase 1: Loading descriptions...")
    artworks = load_descriptions(vocab_db)
    if limit > 0:
        artworks = artworks[:limit]
        print(f"  --limit {limit}: using first {len(artworks):,} artworks")

    artworks = [(a, o, t) for a, o, t in artworks if t]
    if not artworks:
        print("Nothing to embed!")
        return

    # ── Phase 2: Embed on Modal (returns int8 directly) ────────────────
    chunks = [artworks[i:i + batch_size] for i in range(0, len(artworks), batch_size)]
    text_chunks = [[t for _, _, t in chunk] for chunk in chunks]

    print(f"\nPhase 2: Embedding {len(artworks):,} descriptions in {len(chunks)} batches on Modal A10G...")

    all_int8 = np.empty((len(artworks), DIMS), dtype=np.int8)
    t0 = time.time()
    offset = 0

    for batch_idx, emb_bytes in enumerate(embedder.embed.map(text_chunks)):
        n = len(chunks[batch_idx])
        batch_embs = np.frombuffer(emb_bytes, dtype=np.int8).reshape(n, DIMS)
        all_int8[offset:offset + n] = batch_embs
        offset += n

        elapsed = time.time() - t0
        done = offset
        rate = done / elapsed if elapsed > 0 else 0
        pct = done / len(artworks) * 100
        if (batch_idx + 1) % 10 == 0 or batch_idx == len(chunks) - 1:
            print(f"  {done:,}/{len(artworks):,} ({pct:.1f}%) — {rate:.0f} texts/sec")

    embed_elapsed = time.time() - t0
    print(f"  Embedding done in {embed_elapsed:.1f}s")

    # ── Phase 3: Write to DB ──────────────────────────────────────────
    print(f"\nPhase 3: Writing {len(artworks):,} description embeddings to {output}...")

    conn = open_vec_db(output)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")

    # Drop existing description tables if they exist (clean rebuild)
    conn.execute("DROP TABLE IF EXISTS desc_embeddings")
    try:
        conn.execute("DROP TABLE IF EXISTS vec_desc_artworks")
    except Exception:
        pass  # vec0 tables may need special handling
    conn.commit()

    ensure_desc_tables(conn, DIMS)

    batch_regular = []
    batch_vec = []
    for i, (art_id, obj_num, _) in enumerate(artworks):
        blob = all_int8[i].tobytes()
        batch_regular.append((art_id, obj_num, blob))
        batch_vec.append((art_id, blob))

        if len(batch_regular) >= COMMIT_BATCH:
            flush_desc_batch(conn, batch_regular, batch_vec)
            batch_regular.clear()
            batch_vec.clear()
            if (i + 1) % 50000 == 0:
                print(f"    {i + 1:,}/{len(artworks):,} written")

    if batch_regular:
        flush_desc_batch(conn, batch_regular, batch_vec)

    del all_int8

    # Update version_info with description embedding metadata
    vocab_built_at = "unknown"
    try:
        vconn = sqlite3.connect(f"file:{vocab_db}?mode=ro", uri=True)
        row = vconn.execute("SELECT value FROM version_info WHERE key = 'built_at'").fetchone()
        if row:
            vocab_built_at = row[0]
        vconn.close()
    except Exception:
        pass

    desc_meta = [
        ("desc_model", MODEL_NAME),
        ("desc_dimensions", str(DIMS)),
        ("desc_quantization", "int8"),
        ("desc_artwork_count", str(len(artworks))),
        ("desc_built_at", datetime.now(timezone.utc).isoformat()),
        ("desc_vocab_db_built_at", vocab_built_at),
    ]
    # Remove stale PCA-era keys if present
    for stale_key in ("desc_native_dimensions", "desc_pca"):
        conn.execute("DELETE FROM version_info WHERE key = ?", (stale_key,))
    conn.executemany(
        "INSERT OR REPLACE INTO version_info (key, value) VALUES (?, ?)", desc_meta
    )
    conn.commit()
    conn.close()

    # ── Phase 4: Validate ─────────────────────────────────────────────
    print(f"\nPhase 4: Validation...")
    validate_desc(output, embedder)

    # Final stats
    total_elapsed = time.time() - start
    db_size_mb = os.path.getsize(output) / (1024 * 1024)
    print(f"\nDone in {total_elapsed:.1f}s")
    print(f"  Embeddings DB size: {db_size_mb:.1f} MB")
    print(f"  Description vectors: {len(artworks):,} × int8[{DIMS}]")
    est_desc_size = len(artworks) * DIMS / (1024 * 1024)
    print(f"  Estimated description vector storage: {est_desc_size:.0f} MB")


if __name__ == "__main__":
    print("Use: modal run scripts/generate-description-embeddings-modal.py")
    print("Not: python ...")
