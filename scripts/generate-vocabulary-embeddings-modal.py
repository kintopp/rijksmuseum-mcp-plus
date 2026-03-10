#!/usr/bin/env python3
"""
Generate e5-small embeddings under different source text strategies using Modal cloud GPUs.

Phase 1 (local):  Build composite texts from vocab DB under chosen strategy
Phase 2 (Modal):  Embed texts on A10 GPUs (10x parallel via .map())
Phase 3 (local):  Write int8 embeddings to SQLite + sqlite-vec DB

Usage:
    # Single strategy:
    modal run scripts/generate-vocabulary-embeddings-modal.py --strategy baseline

    # All 5 strategies (sequentially — each ~8-12 min on A10):
    for s in baseline no-subjects idf-filtered cherry-pick subjects-last; do
        modal run scripts/generate-vocabulary-embeddings-modal.py --strategy $s
    done

    # Quick test:
    modal run scripts/generate-vocabulary-embeddings-modal.py --strategy cherry-pick --limit 1000

    # Validate existing DB:
    modal run scripts/generate-vocabulary-embeddings-modal.py --strategy baseline --validate-only

Prerequisites:
    pip install modal sqlite-vec numpy
    modal setup

Output: data/embeddings-{strategy}.db (~650 MB each)
"""

import hashlib
import os
import sqlite3
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

import modal
import numpy as np

# ─── Constants ──────────────────────────────────────────────────────────

SCRIPT_DIR = Path(__file__).resolve().parent

def _find_project_root() -> Path:
    """Walk up from script dir until we find package.json (project root)."""
    d = SCRIPT_DIR
    for _ in range(10):
        if (d / "package.json").exists():
            return d
        d = d.parent
    # Fallback: assume 1 parent up from scripts/
    return SCRIPT_DIR.parent

PROJECT_DIR = _find_project_root()
DEFAULT_VOCAB_DB = PROJECT_DIR / "data" / "vocabulary.db"

MODEL_NAME = "intfloat/multilingual-e5-small"
DIMENSIONS = 384
COMMIT_BATCH = 5000
MODAL_BATCH_SIZE = 512  # texts per Modal call

STRATEGIES = ["baseline", "no-subjects", "idf-filtered", "cherry-pick", "subjects-last"]

# Categorical noise labels identified via Phase 2 IDF analysis.
# These are Iconclass classification artifacts, not semantic content.
CHERRY_PICK_NOISE = {
    "historical persons",              # df=90,459 (10.9%)
    "historical persons - BB - woman", # df=14,026 (1.7%)
    "adult man",                       # df=13,155 (1.6%)
    "adult woman",                     # df=10,153 (1.2%)
}

# ─── Modal app ──────────────────────────────────────────────────────────

app = modal.App("rijksmuseum-e5-strategies")


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
    .run_function(download_model)
)


@app.cls(gpu="A10G", image=gpu_image, scaledown_window=60, timeout=3600)
class Embedder:
    @modal.enter()
    def load(self):
        from sentence_transformers import SentenceTransformer
        self.model = SentenceTransformer(MODEL_NAME, device="cuda")
        self.model.encode(["warmup"], normalize_embeddings=True)

    @modal.method()
    def embed(self, texts: list[str]) -> bytes:
        """Embed passage texts → int8 quantize → flat bytes."""
        import numpy as np
        prefixed = [f"passage: {t}" for t in texts]
        embs = self.model.encode(prefixed, normalize_embeddings=True, show_progress_bar=False)
        embs_int8 = np.clip(embs * 127, -127, 127).astype(np.int8)
        return embs_int8.tobytes()

    @modal.method()
    def embed_queries(self, queries: list[str]) -> bytes:
        """Embed query texts (with query: prefix) → int8 → flat bytes."""
        import numpy as np
        prefixed = [f"query: {q}" for q in queries]
        embs = self.model.encode(prefixed, normalize_embeddings=True, show_progress_bar=False)
        embs_int8 = np.clip(embs * 127, -127, 127).astype(np.int8)
        return embs_int8.tobytes()


# ─── Local helpers ──────────────────────────────────────────────────────


def open_vec_db(path: str) -> sqlite3.Connection:
    import sqlite_vec
    conn = sqlite3.connect(path)
    conn.enable_load_extension(True)
    sqlite_vec.load(conn)
    conn.enable_load_extension(False)
    return conn


def load_artworks(
    vocab_db: str,
    strategy: str,
    idf_threshold: int = 8300,
) -> list[tuple[int, str, str]]:
    """Load artworks and build composite text under the chosen strategy.

    Returns list of (art_id, object_number, composite_text) tuples.
    """
    conn = sqlite3.connect(vocab_db)
    conn.row_factory = sqlite3.Row

    cols = {row[1] for row in conn.execute("PRAGMA table_info(mappings)").fetchall()}
    assert "field_id" in cols, "Requires integer-encoded schema (v0.13+)"

    field_ids = dict(conn.execute("SELECT name, id FROM field_lookup").fetchall())
    subject_fid = field_ids["subject"]

    print("  Loading artworks...")
    rows = conn.execute("""
        SELECT art_id, object_number, title_all_text, creator_label,
               narrative_text, inscription_text, description_text
        FROM artworks
    """).fetchall()
    print(f"    {len(rows):,} artworks")

    # Load subjects (needed for all strategies except no-subjects)
    subject_map: dict[int, list[str]] = {}
    if strategy != "no-subjects":
        print("  Loading subject labels...")
        subject_rows = conn.execute("""
            SELECT m.artwork_id, COALESCE(v.label_en, v.label_nl) AS label
            FROM mappings m
            JOIN vocabulary v ON v.vocab_int_id = m.vocab_rowid
            WHERE m.field_id = ?
              AND (v.label_en IS NOT NULL OR v.label_nl IS NOT NULL)
        """, (subject_fid,)).fetchall()
        for aid, label in subject_rows:
            if label:
                subject_map.setdefault(aid, []).append(label)
        del subject_rows
        print(f"    {len(subject_map):,} artworks with subjects")

    # Build filter set for strategies that remove specific subjects
    filter_labels: set[str] = set()
    if strategy == "idf-filtered":
        print(f"  Computing IDF filter (threshold: df > {idf_threshold})...")
        subject_df: Counter = Counter()
        for labels in subject_map.values():
            for label in set(labels):
                subject_df[label] += 1
        filter_labels = {label for label, df in subject_df.items() if df > idf_threshold}
        print(f"    Filtering {len(filter_labels):,} / {len(subject_df):,} subjects")
        del subject_df
    elif strategy == "cherry-pick":
        filter_labels = CHERRY_PICK_NOISE
        print(f"  Cherry-pick filter: removing {len(filter_labels)} categorical noise labels")

    conn.close()

    # Build composite texts
    print(f"  Building composite texts (strategy: {strategy})...")
    artworks = []
    for row in rows:
        art_id = row["art_id"]
        obj_num = row["object_number"]
        subjects = subject_map.get(art_id, [])

        if filter_labels:
            subjects = [s for s in subjects if s not in filter_labels]

        subject_text = ", ".join(subjects) if subjects else None

        if strategy in ("baseline", "idf-filtered", "cherry-pick"):
            fields = [
                ("Title", row["title_all_text"]),
                ("Creator", row["creator_label"]),
                ("Subjects", subject_text),
                ("Narrative", row["narrative_text"]),
                ("Inscriptions", row["inscription_text"]),
                ("Description", row["description_text"]),
            ]
        elif strategy == "no-subjects":
            fields = [
                ("Title", row["title_all_text"]),
                ("Creator", row["creator_label"]),
                ("Narrative", row["narrative_text"]),
                ("Inscriptions", row["inscription_text"]),
                ("Description", row["description_text"]),
            ]
        elif strategy == "subjects-last":
            fields = [
                ("Title", row["title_all_text"]),
                ("Creator", row["creator_label"]),
                ("Narrative", row["narrative_text"]),
                ("Inscriptions", row["inscription_text"]),
                ("Description", row["description_text"]),
                ("Subjects", subject_text),
            ]
        else:
            raise ValueError(f"Unknown strategy '{strategy}' in field builder")

        text = " ".join(f"[{label}] {val}" for label, val in fields if val)
        artworks.append((art_id, obj_num, text))

    del rows, subject_map

    non_empty = sum(1 for _, _, t in artworks if t)
    avg_len = sum(len(t) for _, _, t in artworks) / max(len(artworks), 1)
    print(f"  {len(artworks):,} artworks, {non_empty:,} with text")
    print(f"  Average composite text length: {avg_len:.0f} chars")
    return artworks


def ensure_tables(conn: sqlite3.Connection):
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
        CREATE TABLE IF NOT EXISTS version_info (key TEXT PRIMARY KEY, value TEXT)
    """)


def _flush_batch(conn, regular_rows, vec_rows):
    conn.executemany(
        "INSERT OR REPLACE INTO artwork_embeddings "
        "(art_id, object_number, embedding, source_text, source_hash) VALUES (?, ?, ?, ?, ?)",
        regular_rows,
    )
    conn.executemany(
        "DELETE FROM vec_artworks WHERE artwork_id = ?",
        [(aid,) for aid, _ in vec_rows],
    )
    conn.executemany(
        "INSERT INTO vec_artworks (artwork_id, embedding) VALUES (?, vec_int8(?))",
        vec_rows,
    )
    conn.commit()


def validate(output_path: str, embedder: Embedder):
    conn = open_vec_db(output_path)
    count = conn.execute("SELECT COUNT(*) FROM artwork_embeddings").fetchone()[0]
    vec_count = conn.execute("SELECT COUNT(*) FROM vec_artworks").fetchone()[0]
    size_mb = os.path.getsize(output_path) / (1024 * 1024)
    print(f"\n  Database: {size_mb:.1f} MB, {count:,} embeddings, {vec_count:,} vec0 rows")
    if count != vec_count:
        print(f"  WARNING: table mismatch! artwork_embeddings={count:,}, vec_artworks={vec_count:,}")

    queries = [
        "vanitas symbolism and mortality",
        "winter landscape with ice skating",
        "daily life in the Dutch Golden Age",
        "flowers and botanical illustration",
        "naval battle at sea",
    ]

    query_bytes = embedder.embed_queries.remote(queries)
    query_embs = np.frombuffer(query_bytes, dtype=np.int8).reshape(len(queries), DIMENSIONS)

    for i, query in enumerate(queries):
        qblob = query_embs[i].tobytes()
        rows = conn.execute("""
            SELECT ae.object_number,
                   vec_distance_cosine(vec_int8(ae.embedding), vec_int8(?)) as distance
            FROM artwork_embeddings ae ORDER BY distance LIMIT 5
        """, (qblob,)).fetchall()

        print(f'\n  Query: "{query}"')
        for obj_num, dist in rows:
            print(f"    [{1 - dist:.3f}] {obj_num}")

    conn.close()


# ─── Entrypoint ─────────────────────────────────────────────────────────


@app.local_entrypoint()
def main(
    strategy: str = "baseline",
    idf_threshold: int = 8300,
    resume: bool = False,
    limit: int = 0,
    batch_size: int = MODAL_BATCH_SIZE,
    validate_only: bool = False,
):
    if strategy not in STRATEGIES:
        print(f"ERROR: Unknown strategy '{strategy}'. Choose from: {', '.join(STRATEGIES)}")
        return

    output = str(PROJECT_DIR / "data" / f"embeddings-{strategy}.db")
    vocab_db = str(DEFAULT_VOCAB_DB)

    start = time.time()
    print(f"e5-small Strategy Embeddings via Modal (A10G GPU)")
    print(f"  Strategy:     {strategy}")
    print(f"  Model:        {MODEL_NAME}")
    print(f"  Dimensions:   {DIMENSIONS}")
    print(f"  Output:       {output}")
    if strategy == "idf-filtered":
        print(f"  IDF threshold: df > {idf_threshold}")

    embedder = Embedder()

    if validate_only:
        validate(output, embedder)
        return

    # ── Phase 1: Build composite texts (local) ────────────────────────
    print(f"\nPhase 1: Building composite texts (strategy: {strategy})...")
    artworks = load_artworks(vocab_db, strategy, idf_threshold)
    if limit > 0:
        artworks = artworks[:limit]
        print(f"  --limit {limit}: using first {len(artworks):,} artworks")

    # ── Resume filtering (local) ──────────────────────────────────────
    existing_count = 0
    if resume and os.path.exists(output):
        conn = open_vec_db(output)
        existing_reg = {r[0] for r in conn.execute("SELECT art_id FROM artwork_embeddings")}
        existing_vec = {r[0] for r in conn.execute("SELECT artwork_id FROM vec_artworks")}
        existing = existing_reg & existing_vec
        existing_count = len(existing)
        conn.close()
        artworks = [(a, o, t) for a, o, t in artworks if a not in existing and t]
        print(f"  Resume: {existing_count:,} already done, {len(artworks):,} remaining")
    else:
        artworks = [(a, o, t) for a, o, t in artworks if t]

    if not artworks:
        print("Nothing to embed!")
        validate(output, embedder)
        return

    # ── Phase 2+3: Embed on Modal → write locally ─────────────────────
    chunks = [artworks[i:i + batch_size] for i in range(0, len(artworks), batch_size)]
    text_chunks = [[t for _, _, t in chunk] for chunk in chunks]

    print(f"\nPhase 2: Embedding {len(artworks):,} texts in {len(chunks)} batches on Modal A10G...")

    conn = open_vec_db(output)
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

        for j, (art_id, obj_num, text) in enumerate(chunk):
            blob = embs[j].tobytes()
            source_hash = hashlib.sha256(text.encode()).hexdigest()[:16]
            batch_rows_regular.append((art_id, obj_num, blob, None, source_hash))
            batch_rows_vec.append((art_id, blob))
            total_inserted += 1

        if len(batch_rows_regular) >= COMMIT_BATCH:
            _flush_batch(conn, batch_rows_regular, batch_rows_vec)
            batch_rows_regular.clear()
            batch_rows_vec.clear()

        elapsed = time.time() - t0
        done = min((batch_idx + 1) * batch_size, len(artworks))
        rate = done / elapsed if elapsed > 0 else 0
        pct = done / len(artworks) * 100
        print(f"  {done:,}/{len(artworks):,} ({pct:.1f}%) — {rate:.0f} texts/sec")

    if batch_rows_regular:
        _flush_batch(conn, batch_rows_regular, batch_rows_vec)

    # ── Metadata ──────────────────────────────────────────────────────
    total_count = conn.execute("SELECT COUNT(*) FROM artwork_embeddings").fetchone()[0]
    # Read vocab DB provenance
    vocab_built_at = "unknown"
    try:
        vconn = sqlite3.connect(f"file:{vocab_db}?mode=ro", uri=True)
        row = vconn.execute("SELECT value FROM version_info WHERE key = 'built_at'").fetchone()
        if row:
            vocab_built_at = row[0]
        vconn.close()
    except Exception:
        pass

    meta = [
        ("model", MODEL_NAME),
        ("dimensions", str(DIMENSIONS)),
        ("quantization", "int8"),
        ("artwork_count", str(total_count)),
        ("strategy", strategy),
        ("idf_threshold", str(idf_threshold) if strategy == "idf-filtered" else ""),
        ("built_at", datetime.now(timezone.utc).isoformat()),
        ("vocab_db_built_at", vocab_built_at),
    ]
    conn.executemany("INSERT OR REPLACE INTO version_info (key, value) VALUES (?, ?)", meta)
    conn.commit()

    elapsed = time.time() - t0
    print(f"\nPhase 2+3 done: {total_inserted:,} embeddings in {elapsed:.1f}s")

    print("Running VACUUM...")
    conn.execute("VACUUM")
    conn.close()

    size_mb = os.path.getsize(output) / (1024 * 1024)
    total_elapsed = time.time() - start
    print(f"Output: {output} ({size_mb:.1f} MB)")
    print(f"Total time: {total_elapsed:.1f}s")

    # ── Phase 4: Validate ─────────────────────────────────────────────
    print("\nPhase 4: Validation...")
    validate(output, embedder)


if __name__ == "__main__":
    print("Use: modal run scripts/generate-vocabulary-embeddings-modal.py --strategy <name>")
    print("Not: python ...")
