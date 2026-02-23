#!/usr/bin/env python3
"""
Generate an embedding database for semantic artwork search.

Reads the vocabulary DB, builds composite text per artwork, embeds with
intfloat/multilingual-e5-small, and writes a dual-storage embeddings.db
(vec0 virtual table for pure KNN + regular table for filtered KNN).

Usage:
    python scripts/generate-embeddings.py
    python scripts/generate-embeddings.py --vocab-db data/vocabulary.db --output data/embeddings.db
    python scripts/generate-embeddings.py --batch-size 128 --device mps
    python scripts/generate-embeddings.py --resume  # skip artworks already embedded

Requirements:
    pip install sentence-transformers sqlite-vec

Output: data/embeddings.db (~650 MB)
"""

import argparse
import hashlib
import os
import sqlite3
import struct
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

SCRIPT_DIR = Path(__file__).parent
PROJECT_DIR = SCRIPT_DIR.parent
DEFAULT_VOCAB_DB = PROJECT_DIR / "data" / "vocabulary.db"
DEFAULT_OUTPUT = PROJECT_DIR / "data" / "embeddings.db"
DEFAULT_MODEL = "intfloat/multilingual-e5-small"
DIMENSIONS = 384


# ─── Phase 1: Build composite text ───────────────────────────────────


def load_artworks(vocab_db: str) -> list[dict]:
    """Load all artworks from vocab DB with text fields for embedding."""
    conn = sqlite3.connect(vocab_db)
    conn.row_factory = sqlite3.Row

    # Check schema: integer-encoded or text mappings
    cols = {row[1] for row in conn.execute("PRAGMA table_info(mappings)").fetchall()}
    has_int = "field_id" in cols

    print("  Loading artworks...")
    rows = conn.execute("""
        SELECT art_id, object_number, title_all_text, creator_label,
               narrative_text, inscription_text, description_text
        FROM artworks
        WHERE tier2_done = 1
    """).fetchall()
    print(f"    {len(rows):,} artworks with Tier 2 data")

    # Load subject labels per artwork (most important for semantic search)
    print("  Loading subject labels...")
    if has_int:
        subject_field_id = conn.execute(
            "SELECT id FROM field_lookup WHERE name = 'subject'"
        ).fetchone()
        if subject_field_id:
            subject_rows = conn.execute("""
                SELECT m.artwork_id, COALESCE(v.label_en, v.label_nl) as label
                FROM mappings m
                JOIN vocabulary v ON v.vocab_int_id = m.vocab_rowid
                WHERE m.field_id = ?
                  AND (v.label_en IS NOT NULL OR v.label_nl IS NOT NULL)
            """, (subject_field_id[0],)).fetchall()
        else:
            subject_rows = []
    else:
        subject_rows = conn.execute("""
            SELECT m.object_number, COALESCE(v.label_en, v.label_nl) as label
            FROM mappings m
            JOIN vocabulary v ON v.id = m.vocab_id
            WHERE m.field = 'subject'
              AND (v.label_en IS NOT NULL OR v.label_nl IS NOT NULL)
        """).fetchall()

    # Build subject lookup: art_id/object_number → list of labels
    subject_map: dict[int | str, list[str]] = {}
    for row in subject_rows:
        key = row[0]
        subject_map.setdefault(key, []).append(row[1])
    print(f"    {len(subject_map):,} artworks with subject labels")

    conn.close()

    # Build artwork dicts with composite text
    artworks = []
    for row in rows:
        art_id = row["art_id"]
        obj_num = row["object_number"]

        # Get subjects for this artwork
        subjects = subject_map.get(art_id, []) if has_int else subject_map.get(obj_num, [])

        artworks.append({
            "art_id": art_id,
            "object_number": obj_num,
            "title_all_text": row["title_all_text"],
            "creator_label": row["creator_label"],
            "subjects": subjects,
            "narrative_text": row["narrative_text"],
            "inscription_text": row["inscription_text"],
            "description_text": row["description_text"],
        })

    return artworks


def build_composite_text(artwork: dict) -> str:
    """Build composite text for embedding.

    Field order reflects truncation priority — multilingual-e5-small has a
    512-token window and silently truncates from the end. Most semantically
    rich fields first, most expendable last.
    """
    parts = []

    if artwork["title_all_text"]:
        parts.append(f"[Title] {artwork['title_all_text']}")

    if artwork["creator_label"]:
        parts.append(f"[Creator] {artwork['creator_label']}")

    if artwork["subjects"]:
        parts.append(f"[Subjects] {', '.join(artwork['subjects'])}")

    if artwork["narrative_text"]:
        parts.append(f"[Narrative] {artwork['narrative_text']}")

    if artwork["inscription_text"]:
        parts.append(f"[Inscriptions] {artwork['inscription_text']}")

    if artwork["description_text"]:
        parts.append(f"[Description] {artwork['description_text']}")

    return " ".join(parts)


# ─── Phase 2: Batch embed ────────────────────────────────────────────


def embed_batch(
    model, texts: list[str], batch_size: int, show_progress: bool = True
) -> np.ndarray:
    """Embed texts in batches, returning (N, 384) float32 array."""
    all_embeddings = []
    total = len(texts)

    for i in range(0, total, batch_size):
        batch = texts[i : i + batch_size]
        # E5 models require "passage: " prefix for documents
        prefixed = [f"passage: {t}" for t in batch]
        embs = model.encode(prefixed, normalize_embeddings=True, show_progress_bar=False)
        all_embeddings.append(embs)

        if show_progress and (i // batch_size) % 10 == 0:
            done = min(i + batch_size, total)
            pct = done / total * 100
            print(f"    {done:,}/{total:,} ({pct:.1f}%)")

    return np.vstack(all_embeddings).astype(np.float32)


def quantize_to_int8(vectors: np.ndarray) -> np.ndarray:
    """Quantize normalized float32 vectors to int8.

    Assumes vectors are already L2-normalized (values in [-1, 1]).
    Maps to [-127, 127] range (int8).
    """
    return np.clip(vectors * 127, -127, 127).astype(np.int8)


# ─── Phase 3: Write embeddings.db ────────────────────────────────────


def write_embeddings_db(
    output_path: str,
    artworks: list[dict],
    composite_texts: list[str],
    embeddings_int8: np.ndarray,
    model_name: str,
    resume: bool = False,
):
    """Write dual-storage embeddings database."""
    import sqlite_vec

    conn = sqlite3.connect(output_path)
    conn.enable_load_extension(True)
    sqlite_vec.load(conn)
    conn.enable_load_extension(False)

    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA cache_size=-64000")

    # Create tables
    conn.execute("""
        CREATE TABLE IF NOT EXISTS artwork_embeddings (
            art_id        INTEGER PRIMARY KEY,
            object_number TEXT UNIQUE NOT NULL,
            embedding     BLOB NOT NULL,
            source_text   TEXT,
            source_hash   TEXT
        )
    """)

    conn.execute(f"""
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_artworks USING vec0(
            artwork_id INTEGER PRIMARY KEY,
            embedding int8[{DIMENSIONS}] distance_metric=cosine
        )
    """)

    conn.execute("""
        CREATE TABLE IF NOT EXISTS metadata (
            key   TEXT PRIMARY KEY,
            value TEXT
        )
    """)

    # Build set of existing art_ids for resume mode
    existing_ids: set[int] = set()
    if resume:
        existing_ids = {
            row[0]
            for row in conn.execute("SELECT art_id FROM artwork_embeddings").fetchall()
        }
        print(f"  Resume mode: {len(existing_ids):,} already embedded")

    # Insert embeddings
    inserted = 0
    skipped = 0
    batch_rows_regular = []
    batch_rows_vec = []
    COMMIT_BATCH = 5000

    for i, (artwork, text, emb) in enumerate(
        zip(artworks, composite_texts, embeddings_int8)
    ):
        art_id = artwork["art_id"]
        if art_id in existing_ids:
            skipped += 1
            continue

        emb_blob = emb.tobytes()
        source_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]

        batch_rows_regular.append(
            (art_id, artwork["object_number"], emb_blob, text, source_hash)
        )
        batch_rows_vec.append((art_id, emb_blob))
        inserted += 1

        if len(batch_rows_regular) >= COMMIT_BATCH:
            _flush_batch(conn, batch_rows_regular, batch_rows_vec)
            batch_rows_regular.clear()
            batch_rows_vec.clear()
            if inserted % 50000 == 0:
                print(f"    Inserted {inserted:,}...")

    # Flush remaining
    if batch_rows_regular:
        _flush_batch(conn, batch_rows_regular, batch_rows_vec)

    # Write metadata
    built_at = datetime.now(timezone.utc).isoformat()
    meta = [
        ("model", model_name),
        ("dimensions", str(DIMENSIONS)),
        ("quantization", "int8"),
        ("artwork_count", str(inserted + len(existing_ids))),
        ("built_at", built_at),
    ]
    conn.executemany(
        "INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)", meta
    )
    conn.commit()

    print(f"  Inserted: {inserted:,}, skipped: {skipped:,}")
    return inserted


def _flush_batch(conn, regular_rows, vec_rows):
    """Insert a batch into both tables."""
    conn.executemany(
        "INSERT OR REPLACE INTO artwork_embeddings "
        "(art_id, object_number, embedding, source_text, source_hash) "
        "VALUES (?, ?, ?, ?, ?)",
        regular_rows,
    )
    # vec0: DELETE then INSERT (INSERT OR REPLACE is broken, issue #259)
    for art_id, emb_blob in vec_rows:
        conn.execute("DELETE FROM vec_artworks WHERE artwork_id = ?", (art_id,))
    conn.executemany(
        "INSERT INTO vec_artworks (artwork_id, embedding) VALUES (?, ?)",
        vec_rows,
    )
    conn.commit()


# ─── Phase 4: Validate ───────────────────────────────────────────────


def validate(output_path: str, model, model_name: str):
    """Run test queries and report stats."""
    import sqlite_vec

    conn = sqlite3.connect(output_path)
    conn.enable_load_extension(True)
    sqlite_vec.load(conn)
    conn.enable_load_extension(False)

    # Stats
    count = conn.execute("SELECT COUNT(*) FROM artwork_embeddings").fetchone()[0]
    size_mb = os.path.getsize(output_path) / (1024 * 1024)
    print(f"\n  Database: {size_mb:.1f} MB, {count:,} embeddings")

    # Test queries
    test_queries = [
        "vanitas symbolism and mortality",
        "winter landscape with ice skating",
        "daily life in the Dutch Golden Age",
        "flowers and botanical illustration",
        "naval battle at sea",
    ]

    for query in test_queries:
        # Embed query with "query: " prefix
        query_emb = model.encode(
            f"query: {query}", normalize_embeddings=True
        ).astype(np.float32)
        query_int8 = np.clip(query_emb * 127, -127, 127).astype(np.int8)

        rows = conn.execute(
            """
            SELECT ae.object_number, ae.source_text,
                   vec_distance_cosine(ae.embedding, ?) as distance
            FROM artwork_embeddings ae
            ORDER BY distance
            LIMIT 5
            """,
            (query_int8.tobytes(),),
        ).fetchall()

        print(f'\n  Query: "{query}"')
        for obj_num, source_text, dist in rows:
            similarity = 1 - dist
            # Show first 80 chars of source text
            snippet = (source_text or "")[:80].replace("\n", " ")
            print(f"    [{similarity:.3f}] {obj_num}: {snippet}...")

    conn.close()


# ─── Main ────────────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(
        description="Generate embedding database for semantic artwork search"
    )
    parser.add_argument(
        "--vocab-db",
        default=str(DEFAULT_VOCAB_DB),
        help="Path to vocabulary.db (default: data/vocabulary.db)",
    )
    parser.add_argument(
        "--output",
        default=str(DEFAULT_OUTPUT),
        help="Output path for embeddings.db (default: data/embeddings.db)",
    )
    parser.add_argument(
        "--model",
        default=DEFAULT_MODEL,
        help=f"HuggingFace model name (default: {DEFAULT_MODEL})",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=64,
        help="Batch size for embedding (default: 64)",
    )
    parser.add_argument(
        "--device",
        default=None,
        help="Device: cpu, mps, cuda (default: auto-detect)",
    )
    parser.add_argument(
        "--resume",
        action="store_true",
        help="Skip artworks already in output DB",
    )
    parser.add_argument(
        "--validate-only",
        action="store_true",
        help="Only run validation on existing DB",
    )
    args = parser.parse_args()

    start = time.time()
    print(f"Embedding DB generator")
    print(f"  Model: {args.model}")
    print(f"  Vocab DB: {args.vocab_db}")
    print(f"  Output: {args.output}")

    # ── Load model ────────────────────────────────────────────────────
    print("\nLoading model...")
    from sentence_transformers import SentenceTransformer

    device = args.device
    if device is None:
        import torch
        if torch.backends.mps.is_available():
            device = "mps"
        elif torch.cuda.is_available():
            device = "cuda"
        else:
            device = "cpu"
    print(f"  Device: {device}")

    model = SentenceTransformer(args.model, device=device)

    if args.validate_only:
        validate(args.output, model, args.model)
        return

    # ── Phase 1: Build composite text ─────────────────────────────────
    print("\nPhase 1: Building composite text...")
    artworks = load_artworks(args.vocab_db)
    composite_texts = [build_composite_text(a) for a in artworks]

    # Stats
    non_empty = sum(1 for t in composite_texts if t)
    avg_len = sum(len(t) for t in composite_texts) / max(len(composite_texts), 1)
    print(f"  {len(artworks):,} artworks, {non_empty:,} with text")
    print(f"  Average composite text length: {avg_len:.0f} chars")

    # ── Phase 2: Batch embed ──────────────────────────────────────────
    print(f"\nPhase 2: Embedding ({args.batch_size} batch size)...")
    embeddings_f32 = embed_batch(model, composite_texts, args.batch_size)
    print(f"  Shape: {embeddings_f32.shape}")

    # Quantize to int8
    print("  Quantizing to int8...")
    embeddings_int8 = quantize_to_int8(embeddings_f32)
    del embeddings_f32  # free memory

    # ── Phase 3: Write DB ─────────────────────────────────────────────
    print(f"\nPhase 3: Writing {args.output}...")
    inserted = write_embeddings_db(
        args.output, artworks, composite_texts, embeddings_int8, args.model, args.resume
    )

    # ── Phase 4: Validate ─────────────────────────────────────────────
    print("\nPhase 4: Validation...")
    validate(args.output, model, args.model)

    # ── Final stats ───────────────────────────────────────────────────
    elapsed = time.time() - start
    size_mb = os.path.getsize(args.output) / (1024 * 1024)
    print(f"\nDone! {args.output} ({size_mb:.1f} MB) in {elapsed:.1f}s")
    print(f"  Estimated gzip size: ~{size_mb * 0.45:.0f} MB")

    # VACUUM
    print("  Running VACUUM...")
    conn = sqlite3.connect(args.output)
    conn.execute("VACUUM")
    conn.close()
    final_mb = os.path.getsize(args.output) / (1024 * 1024)
    print(f"  After VACUUM: {final_mb:.1f} MB")


if __name__ == "__main__":
    main()
