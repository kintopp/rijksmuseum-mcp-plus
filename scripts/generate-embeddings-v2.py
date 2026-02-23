#!/usr/bin/env python3
"""
Generate an embedding database for semantic artwork search (streaming version).

Streams embeddings to SQLite per-batch instead of accumulating all in memory.
Peak memory: ~700 MB (vs ~2.3 GB for v1). DB is written incrementally.

Usage:
    python scripts/generate-embeddings-v2.py
    python scripts/generate-embeddings-v2.py --vocab-db data/vocabulary.db --output data/embeddings.db
    python scripts/generate-embeddings-v2.py --batch-size 128 --device mps
    python scripts/generate-embeddings-v2.py --resume  # skip artworks already embedded

Requirements:
    pip install sentence-transformers sqlite-vec

Output: data/embeddings.db (~650 MB)
"""

import argparse
import hashlib
import os
import sqlite3
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
COMMIT_BATCH = 5000


def open_vec_db(path: str) -> sqlite3.Connection:
    """Open a SQLite connection with the sqlite-vec extension loaded."""
    import sqlite_vec

    conn = sqlite3.connect(path)
    conn.enable_load_extension(True)
    sqlite_vec.load(conn)
    conn.enable_load_extension(False)
    return conn


# ─── Phase 1: Build composite text ───────────────────────────────────


def load_artworks(vocab_db: str) -> list[tuple[int, str, str]]:
    """Load artworks and build composite text in one pass.

    Returns list of (art_id, object_number, composite_text) tuples.
    Raw text fields are discarded after compositing to minimize memory.
    """
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
    del subject_rows  # free ~50 MB
    print(f"    {len(subject_map):,} artworks with subject labels")

    # Build (art_id, object_number, composite_text) tuples — discard raw fields
    print("  Building composite texts...")
    artworks = []
    for row in rows:
        art_id = row["art_id"]
        obj_num = row["object_number"]
        subjects = subject_map.get(art_id, []) if has_int else subject_map.get(obj_num, [])

        # Build composite text inline (field order = truncation priority)
        fields = [
            ("Title", row["title_all_text"]),
            ("Creator", row["creator_label"]),
            ("Subjects", ", ".join(subjects) if subjects else None),
            ("Narrative", row["narrative_text"]),
            ("Inscriptions", row["inscription_text"]),
            ("Description", row["description_text"]),
        ]
        text = " ".join(f"[{label}] {val}" for label, val in fields if val)
        artworks.append((art_id, obj_num, text))

    del rows, subject_map  # free raw data
    conn.close()
    return artworks


# ─── Phase 2+3: Stream embed → quantize → write ─────────────────────


def _flush_batch(conn, regular_rows, vec_rows):
    """Insert a batch into both tables."""
    conn.executemany(
        "INSERT OR REPLACE INTO artwork_embeddings "
        "(art_id, object_number, embedding, source_text, source_hash) "
        "VALUES (?, ?, ?, ?, ?)",
        regular_rows,
    )
    # vec0: DELETE then INSERT (INSERT OR REPLACE is broken, issue #259)
    # vec_int8() wrapper required — raw bytes default to float32 interpretation
    conn.executemany(
        "DELETE FROM vec_artworks WHERE artwork_id = ?",
        [(art_id,) for art_id, _ in vec_rows],
    )
    conn.executemany(
        "INSERT INTO vec_artworks (artwork_id, embedding) VALUES (?, vec_int8(?))",
        vec_rows,
    )
    conn.commit()


def embed_and_write(
    model,
    artworks: list[tuple[int, str, str]],
    output_path: str,
    model_name: str,
    batch_size: int,
    resume: bool,
) -> int:
    """Stream: embed a batch → quantize → write to DB. Repeat.

    artworks: list of (art_id, object_number, composite_text) tuples.
    Returns number of newly inserted embeddings.
    """
    conn = open_vec_db(output_path)

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

    # Build set of existing art_ids for resume mode (intersection of both tables
    # to catch divergence from a crash mid-batch)
    existing_ids: set[int] = set()
    if resume:
        in_regular = {
            row[0] for row in conn.execute("SELECT art_id FROM artwork_embeddings").fetchall()
        }
        in_vec = {
            row[0] for row in conn.execute("SELECT artwork_id FROM vec_artworks").fetchall()
        }
        existing_ids = in_regular & in_vec
        dangling = in_regular - existing_ids
        if dangling:
            print(f"  Warning: {len(dangling):,} art_ids in artwork_embeddings but missing from vec_artworks — will re-embed")
        print(f"  Resume mode: {len(existing_ids):,} already embedded")

    total = len(artworks)
    inserted = 0
    skipped = 0
    batch_rows_regular = []
    batch_rows_vec = []
    last_progress = time.time()
    progress_interval = 30  # seconds between progress lines

    for batch_start in range(0, total, batch_size):
        batch_end = min(batch_start + batch_size, total)

        # Collect texts for this batch (skip already-embedded in resume mode)
        indices_to_embed = []
        for i in range(batch_start, batch_end):
            art_id, _, text = artworks[i]
            if art_id in existing_ids:
                skipped += 1
            elif not text:
                skipped += 1
            else:
                indices_to_embed.append(i)

        if not indices_to_embed:
            continue

        # Embed only the non-skipped texts
        batch_texts = [f"passage: {artworks[i][2]}" for i in indices_to_embed]
        embs_f32 = model.encode(batch_texts, normalize_embeddings=True, show_progress_bar=False)

        # Quantize inline
        embs_int8 = np.clip(embs_f32 * 127, -127, 127).astype(np.int8)
        del embs_f32  # free immediately

        # Build row tuples
        for j, idx in enumerate(indices_to_embed):
            art_id, obj_num, text = artworks[idx]
            emb_blob = embs_int8[j].tobytes()
            source_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]

            batch_rows_regular.append(
                (art_id, obj_num, emb_blob, text, source_hash)
            )
            batch_rows_vec.append((art_id, emb_blob))
            inserted += 1

        # Flush when we've accumulated enough rows
        if len(batch_rows_regular) >= COMMIT_BATCH:
            _flush_batch(conn, batch_rows_regular, batch_rows_vec)
            batch_rows_regular.clear()
            batch_rows_vec.clear()

        # Time-based progress (every 30s)
        now = time.time()
        if now - last_progress >= progress_interval:
            pct = batch_end / total * 100
            print(f"    {batch_end:,}/{total:,} ({pct:.1f}%) — {inserted:,} inserted")
            last_progress = now

    # Flush remaining
    if batch_rows_regular:
        _flush_batch(conn, batch_rows_regular, batch_rows_vec)

    # Write metadata
    built_at = datetime.now(timezone.utc).isoformat()
    artwork_count = inserted + len(existing_ids)
    meta = [
        ("model", model_name),
        ("dimensions", str(DIMENSIONS)),
        ("quantization", "int8"),
        ("artwork_count", str(artwork_count)),
        ("built_at", built_at),
    ]
    conn.executemany(
        "INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)", meta
    )
    conn.commit()
    conn.close()

    print(f"  Inserted: {inserted:,}, skipped: {skipped:,}")
    return inserted


# ─── Phase 4: Validate ───────────────────────────────────────────────


def validate(output_path: str, model):
    """Run test queries and report stats."""
    conn = open_vec_db(output_path)

    # Stats — check both tables for consistency
    count = conn.execute("SELECT COUNT(*) FROM artwork_embeddings").fetchone()[0]
    vec_count = conn.execute("SELECT COUNT(*) FROM vec_artworks").fetchone()[0]
    size_mb = os.path.getsize(output_path) / (1024 * 1024)
    print(f"\n  Database: {size_mb:.1f} MB, {count:,} embeddings, {vec_count:,} vec0 rows")
    if count != vec_count:
        print(f"  WARNING: table mismatch! artwork_embeddings={count:,}, vec_artworks={vec_count:,}")

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
            SELECT ae.object_number,
                   vec_distance_cosine(vec_int8(ae.embedding), vec_int8(?)) as distance
            FROM artwork_embeddings ae
            ORDER BY distance
            LIMIT 5
            """,
            (query_int8.tobytes(),),
        ).fetchall()

        # Also test vec0 KNN fast path
        vec_rows = conn.execute(
            """
            SELECT artwork_id, distance
            FROM vec_artworks
            WHERE embedding MATCH vec_int8(?) AND k = 5
            ORDER BY distance
            """,
            (query_int8.tobytes(),),
        ).fetchall()

        print(f'\n  Query: "{query}"')
        for obj_num, dist in rows:
            similarity = 1 - dist
            print(f"    [{similarity:.3f}] {obj_num}")

        # Cross-check: vec0 top-1 should match brute-force top-1
        if rows and vec_rows and rows[0][0] != str(vec_rows[0][0]):
            vec_top = conn.execute(
                "SELECT object_number FROM artwork_embeddings WHERE art_id = ?",
                (vec_rows[0][0],),
            ).fetchone()
            vec_top_obj = vec_top[0] if vec_top else "?"
            if rows[0][0] != vec_top_obj:
                print(f"    WARNING: vec0 top-1 ({vec_top_obj}) != brute-force top-1 ({rows[0][0]})")

    conn.close()


# ─── Main ────────────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(
        description="Generate embedding database for semantic artwork search (streaming)"
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
        "--limit",
        type=int,
        default=0,
        help="Only embed the first N artworks (0 = all, for testing)",
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
    print("Embedding DB generator (streaming)")
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
        validate(args.output, model)
        return

    # ── Phase 1: Build composite text ─────────────────────────────────
    print("\nPhase 1: Building composite text...")
    artworks = load_artworks(args.vocab_db)
    if args.limit > 0:
        artworks = artworks[: args.limit]
        print(f"  --limit {args.limit}: using first {len(artworks)} artworks")

    # Stats
    non_empty = sum(1 for _, _, t in artworks if t)
    avg_len = sum(len(t) for _, _, t in artworks) / max(len(artworks), 1)
    print(f"  {len(artworks):,} artworks, {non_empty:,} with text")
    print(f"  Average composite text length: {avg_len:.0f} chars")

    # ── Phase 2+3: Stream embed → write ───────────────────────────────
    print(f"\nPhase 2+3: Streaming embed → quantize → write ({args.batch_size} batch size)...")
    inserted = embed_and_write(
        model, artworks, args.output, args.model,
        args.batch_size, args.resume,
    )

    # ── Phase 4: Validate ─────────────────────────────────────────────
    print("\nPhase 4: Validation...")
    validate(args.output, model)

    # ── Final stats ───────────────────────────────────────────────────
    elapsed = time.time() - start
    size_mb = os.path.getsize(args.output) / (1024 * 1024)
    print(f"\nDone! {args.output} ({size_mb:.1f} MB) in {elapsed:.1f}s")
    print(f"  Estimated gzip size: ~{size_mb * 0.45:.0f} MB")

    # VACUUM — must load sqlite-vec or vec0 module resolution fails
    print("  Running VACUUM...")
    conn = open_vec_db(args.output)
    conn.execute("VACUUM")
    conn.close()
    final_mb = os.path.getsize(args.output) / (1024 * 1024)
    print(f"  After VACUUM: {final_mb:.1f} MB")


if __name__ == "__main__":
    main()
