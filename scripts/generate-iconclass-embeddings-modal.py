#!/usr/bin/env python3
"""
Generate multilingual-e5-small embeddings for Iconclass notations using a Modal cloud GPU.

Splits work into four phases:
  Phase 1 (local):     Build composite texts from iconclass.db
  Phase 2 (cloud GPU): Embed texts in parallel batches on Modal T4
  Phase 3 (local):     Write int8 embeddings back into iconclass.db
  Phase 4 (cloud GPU): Validate with test queries

Usage:
    modal run scripts/generate-iconclass-embeddings-modal.py
    modal run scripts/generate-iconclass-embeddings-modal.py --resume
    modal run scripts/generate-iconclass-embeddings-modal.py --limit 1000
    modal run scripts/generate-iconclass-embeddings-modal.py --validate-only

Prerequisites:
    pip install modal sqlite-vec    # in the same Python env
    modal setup                     # one-time auth (free $30/mo tier)

Output: Adds iconclass_embeddings + vec_iconclass tables to existing data/iconclass.db
"""

import os
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path

import modal
import numpy as np

# ─── Constants ──────────────────────────────────────────────────────────

SCRIPT_DIR = Path(__file__).parent
PROJECT_DIR = SCRIPT_DIR.parent
DEFAULT_ICONCLASS_DB = PROJECT_DIR / "data" / "iconclass.db"

MODEL_NAME = "intfloat/multilingual-e5-small"
DIMENSIONS = 384  # native output, no MRL truncation needed
DOCUMENT_PREFIX = "passage: "
QUERY_PREFIX = "query: "
COMMIT_BATCH = 5000
MODAL_BATCH_SIZE = 512  # texts per Modal call


# ─── Modal app ──────────────────────────────────────────────────────────

app = modal.App("iconclass-embeddings")

hf_secret = modal.Secret.from_name("huggingface-secret")


def download_model():
    """Download model weights at image build time (cached in image layer)."""
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
    .run_function(download_model, secrets=[hf_secret])
)


@app.cls(gpu="T4", image=gpu_image, secrets=[hf_secret], scaledown_window=60, timeout=3600)
class Embedder:
    @modal.enter()
    def load(self):
        """Load model onto GPU when container starts."""
        from sentence_transformers import SentenceTransformer
        self.model = SentenceTransformer(MODEL_NAME, device="cuda")
        self.model.encode(["warmup"], normalize_embeddings=True)

    @modal.method()
    def embed(self, texts: list[str]) -> bytes:
        """Embed document texts → int8 quantize → flat bytes."""
        import numpy as np

        prefixed = [f"{DOCUMENT_PREFIX}{t}" for t in texts]
        embs = self.model.encode(prefixed, normalize_embeddings=True, show_progress_bar=False)

        # e5-small outputs 384d natively — no MRL truncation needed
        embs_int8 = np.clip(embs * 127, -127, 127).astype(np.int8)
        return embs_int8.tobytes()

    @modal.method()
    def embed_queries(self, queries: list[str]) -> bytes:
        """Embed query texts (with query prefix) → int8 → flat bytes."""
        import numpy as np

        prefixed = [f"{QUERY_PREFIX}{q}" for q in queries]
        embs = self.model.encode(prefixed, normalize_embeddings=True, show_progress_bar=False)

        embs_int8 = np.clip(embs * 127, -127, 127).astype(np.int8)
        return embs_int8.tobytes()


# ─── Local helpers (run on your Mac) ────────────────────────────────────


def open_vec_db(path: str) -> sqlite3.Connection:
    """Open a SQLite connection with the sqlite-vec extension loaded."""
    import sqlite_vec
    conn = sqlite3.connect(path)
    conn.enable_load_extension(True)
    sqlite_vec.load(conn)
    conn.enable_load_extension(False)
    return conn


def load_iconclass_texts(db_path: str) -> list[tuple[str, str]]:
    """Build composite texts from iconclass.db for embedding.

    For each notation, builds:
      [Description] {EN text} [Description NL] {NL text} [Keywords] {kw1, kw2, ...}
      [Category] {root label} > {parent label} > ... > {current label}

    Returns list of (notation, composite_text) tuples.
    """
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row

    # 1. All notations + paths
    print("  Loading notations...")
    notations = conn.execute("SELECT notation, path FROM notations").fetchall()
    notation_paths = {row["notation"]: row["path"] for row in notations}
    print(f"    {len(notations):,} notations")

    # 2. Texts per notation (EN + NL)
    print("  Loading texts...")
    text_rows = conn.execute(
        "SELECT notation, lang, text FROM texts WHERE lang IN ('en', 'nl')"
    ).fetchall()
    texts_map: dict[str, dict[str, str]] = {}
    for row in text_rows:
        texts_map.setdefault(row["notation"], {})[row["lang"]] = row["text"]
    print(f"    {len(text_rows):,} text entries for {len(texts_map):,} notations")

    # 3. Keywords per notation (EN + NL)
    print("  Loading keywords...")
    kw_rows = conn.execute(
        "SELECT notation, lang, keyword FROM keywords WHERE lang IN ('en', 'nl')"
    ).fetchall()
    kw_map: dict[str, list[str]] = {}
    for row in kw_rows:
        kw_map.setdefault(row["notation"], []).append(row["keyword"])
    print(f"    {len(kw_rows):,} keyword entries for {len(kw_map):,} notations")

    # 4. Build a lookup for notation → EN text (for path label resolution)
    en_text_map: dict[str, str] = {}
    for notation, langs in texts_map.items():
        if "en" in langs:
            en_text_map[notation] = langs["en"]
        elif "nl" in langs:
            en_text_map[notation] = langs["nl"]

    # 5. Build composite texts
    print("  Building composite texts...")
    import json

    results: list[tuple[str, str]] = []
    skipped = 0

    for row in notations:
        notation = row["notation"]
        langs = texts_map.get(notation, {})

        # Skip notations with no text at all
        if not langs and notation not in kw_map:
            skipped += 1
            continue

        parts: list[str] = []

        # Description (EN)
        if "en" in langs:
            parts.append(f"[Description] {langs['en']}")

        # Description (NL) — always include if present, even as sole language
        if "nl" in langs:
            parts.append(f"[Description NL] {langs['nl']}")

        # Keywords (deduplicated)
        keywords = kw_map.get(notation, [])
        if keywords:
            unique_kw = list(dict.fromkeys(keywords))  # preserve order, deduplicate
            parts.append(f"[Keywords] {', '.join(unique_kw)}")

        # Category path: resolve ancestor labels
        path_notations = json.loads(notation_paths.get(notation, "[]"))
        if path_notations:
            path_labels = []
            for ancestor in path_notations:
                label = en_text_map.get(ancestor, ancestor)
                path_labels.append(label)
            # Add current notation's label at the end
            current_label = en_text_map.get(notation, notation)
            path_labels.append(current_label)
            parts.append(f"[Category] {' > '.join(path_labels)}")

        if parts:
            results.append((notation, " ".join(parts)))
        else:
            skipped += 1

    conn.close()
    print(f"    {len(results):,} composite texts built, {skipped} skipped (no text/keywords)")
    if results:
        avg_len = sum(len(t) for _, t in results) / len(results)
        print(f"    Average composite text length: {avg_len:.0f} chars")

    return results


def ensure_tables(conn: sqlite3.Connection):
    """Create embedding tables if they don't exist."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS iconclass_embeddings (
            notation  TEXT PRIMARY KEY,
            embedding BLOB NOT NULL
        )
    """)
    conn.execute(f"""
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_iconclass USING vec0(
            notation TEXT PRIMARY KEY,
            embedding int8[{DIMENSIONS}] distance_metric=cosine
        )
    """)


def _flush_batch(conn, regular_rows, vec_rows):
    """Insert a batch into both tables."""
    conn.executemany(
        "INSERT OR REPLACE INTO iconclass_embeddings (notation, embedding) VALUES (?, ?)",
        regular_rows,
    )
    # vec0: DELETE then INSERT (INSERT OR REPLACE is broken, sqlite-vec #259)
    conn.executemany(
        "DELETE FROM vec_iconclass WHERE notation = ?",
        [(n,) for n, _ in vec_rows],
    )
    conn.executemany(
        "INSERT INTO vec_iconclass (notation, embedding) VALUES (?, vec_int8(?))",
        vec_rows,
    )
    conn.commit()


def validate(db_path: str, embedder: Embedder):
    """Run test queries: embed on Modal, KNN search locally."""
    conn = open_vec_db(db_path)
    try:
        count = conn.execute("SELECT COUNT(*) FROM iconclass_embeddings").fetchone()[0]
    except Exception:
        print("  No iconclass_embeddings table found — run without --validate-only first.")
        conn.close()
        return

    vec_count = conn.execute("SELECT COUNT(*) FROM vec_iconclass").fetchone()[0]
    size_mb = os.path.getsize(db_path) / (1024 * 1024)
    print(f"\n  Database: {size_mb:.1f} MB, {count:,} embeddings, {vec_count:,} vec0 rows")
    if count != vec_count:
        print(f"  WARNING: table mismatch! iconclass_embeddings={count:,}, vec_iconclass={vec_count:,}")

    queries = [
        "dogs and domestic animals",
        "crucifixion of Christ",
        "flowers and plants",
        "ships and naval vessels",
        "portrait of a woman",
    ]

    # Embed all queries in one Modal call
    query_bytes = embedder.embed_queries.remote(queries)
    query_embs = np.frombuffer(query_bytes, dtype=np.int8).reshape(len(queries), DIMENSIONS)

    for i, query in enumerate(queries):
        qblob = query_embs[i].tobytes()

        # vec0 KNN path
        knn_rows = conn.execute("""
            SELECT notation, distance FROM vec_iconclass
            WHERE embedding MATCH vec_int8(?) AND k = 5
            ORDER BY distance
        """, (qblob,)).fetchall()

        # Brute-force path (cross-check)
        bf_rows = conn.execute("""
            SELECT ie.notation,
                   vec_distance_cosine(vec_int8(ie.embedding), vec_int8(?)) as distance
            FROM iconclass_embeddings ie ORDER BY distance LIMIT 5
        """, (qblob,)).fetchall()

        # Look up text labels for top results
        print(f'\n  Query: "{query}"')
        print(f"  KNN (vec0):")
        for notation, dist in knn_rows:
            label = conn.execute(
                "SELECT text FROM texts WHERE notation = ? AND lang = 'en' LIMIT 1",
                (notation,)
            ).fetchone()
            label_str = label[0] if label else notation
            print(f"    [{1 - dist:.3f}] {notation} — {label_str}")

        # Verify top-1 matches
        if knn_rows and bf_rows:
            if knn_rows[0][0] == bf_rows[0][0]:
                print(f"  ✓ Top-1 matches between KNN and brute-force: {knn_rows[0][0]}")
            else:
                print(f"  ✗ Top-1 MISMATCH: KNN={knn_rows[0][0]} vs BF={bf_rows[0][0]}")

    conn.close()


# ─── Entrypoint ─────────────────────────────────────────────────────────


@app.local_entrypoint()
def main(
    resume: bool = False,
    limit: int = 0,
    batch_size: int = MODAL_BATCH_SIZE,
    validate_only: bool = False,
):
    start = time.time()
    db_path = str(DEFAULT_ICONCLASS_DB)

    print(f"Iconclass embeddings via Modal (T4 GPU)")
    print(f"  Model: {MODEL_NAME}")
    print(f"  Dimensions: {DIMENSIONS}")
    print(f"  Database: {db_path}")

    if not os.path.exists(db_path):
        print(f"ERROR: iconclass.db not found at {db_path}")
        print("Run scripts/build-iconclass-db.py first.")
        return

    embedder = Embedder()

    if validate_only:
        validate(db_path, embedder)
        return

    # ── Phase 1: Build composite texts (local) ────────────────────────
    print("\nPhase 1: Building composite texts from iconclass.db...")
    all_texts = load_iconclass_texts(db_path)
    if limit > 0:
        all_texts = all_texts[:limit]
        print(f"  --limit {limit}: using first {len(all_texts):,} notations")

    # ── Resume filtering (local) ──────────────────────────────────────
    if resume:
        try:
            conn = open_vec_db(db_path)
            existing_reg = {r[0] for r in conn.execute("SELECT notation FROM iconclass_embeddings")}
            existing_vec = {r[0] for r in conn.execute("SELECT notation FROM vec_iconclass")}
            existing = existing_reg & existing_vec
            conn.close()
            all_texts = [(n, t) for n, t in all_texts if n not in existing]
            print(f"  Resume: {len(existing):,} already done, {len(all_texts):,} remaining")
        except Exception:
            print("  Resume: no existing embedding tables found, starting fresh")

    if not all_texts:
        print("Nothing to embed!")
        validate(db_path, embedder)
        return

    # ── Phase 2: Embed on Modal GPU ───────────────────────────────────
    chunks = [all_texts[i:i + batch_size] for i in range(0, len(all_texts), batch_size)]
    text_chunks = [[t for _, t in chunk] for chunk in chunks]

    print(f"\nPhase 2: Embedding {len(all_texts):,} texts in {len(chunks)} batches on Modal T4...")

    # ── Phase 3: Write to iconclass.db ────────────────────────────────
    conn = open_vec_db(db_path)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    ensure_tables(conn)

    total_inserted = 0
    batch_rows_regular = []
    batch_rows_vec = []
    t0 = time.time()

    for batch_idx, emb_bytes in enumerate(embedder.embed.map(text_chunks)):
        chunk = chunks[batch_idx]
        n = len(chunk)
        embs = np.frombuffer(emb_bytes, dtype=np.int8).reshape(n, DIMENSIONS)

        for j, (notation, _text) in enumerate(chunk):
            blob = embs[j].tobytes()
            batch_rows_regular.append((notation, blob))
            batch_rows_vec.append((notation, blob))
            total_inserted += 1

        if len(batch_rows_regular) >= COMMIT_BATCH:
            _flush_batch(conn, batch_rows_regular, batch_rows_vec)
            batch_rows_regular.clear()
            batch_rows_vec.clear()

        elapsed = time.time() - t0
        done = min((batch_idx + 1) * batch_size, len(all_texts))
        rate = done / elapsed if elapsed > 0 else 0
        pct = done / len(all_texts) * 100
        print(f"  {done:,}/{len(all_texts):,} ({pct:.1f}%) — {rate:.0f} texts/sec")

    # Flush remaining
    if batch_rows_regular:
        _flush_batch(conn, batch_rows_regular, batch_rows_vec)

    # ── Update version_info ───────────────────────────────────────────
    total_count = conn.execute("SELECT COUNT(*) FROM iconclass_embeddings").fetchone()[0]
    meta = [
        ("embedding_model", MODEL_NAME),
        ("embedding_dimensions", str(DIMENSIONS)),
        ("embedding_count", str(total_count)),
        ("embeddings_built_at", datetime.now(timezone.utc).isoformat()),
    ]
    conn.executemany("INSERT OR REPLACE INTO version_info (key, value) VALUES (?, ?)", meta)
    conn.commit()

    elapsed = time.time() - t0
    print(f"\nPhase 2+3 done: {total_inserted:,} embeddings in {elapsed:.1f}s")

    # VACUUM (requires sqlite-vec loaded)
    print("Running VACUUM...")
    conn.execute("VACUUM")
    conn.close()

    size_mb = os.path.getsize(db_path) / (1024 * 1024)
    total_elapsed = time.time() - start
    print(f"Database: {db_path} ({size_mb:.1f} MB)")
    print(f"Total time: {total_elapsed:.1f}s")

    # ── Phase 4: Validate ─────────────────────────────────────────────
    print("\nPhase 4: Validation...")
    validate(db_path, embedder)


if __name__ == "__main__":
    print("Use: modal run scripts/generate-iconclass-embeddings-modal.py [--resume] [--limit N]")
    print("Not: python scripts/generate-iconclass-embeddings-modal.py")
