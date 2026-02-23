import Database, { type Database as DatabaseType, type Statement } from "better-sqlite3";
import { createRequire } from "node:module";
import { resolveDbPath } from "../utils/db.js";

const require = createRequire(import.meta.url);

// ─── Types ───────────────────────────────────────────────────────────

export interface SemanticSearchResult {
  artId: number;
  objectNumber: string;
  sourceText: string | null;
  distance: number;
}

// ─── EmbeddingsDb ────────────────────────────────────────────────────

/**
 * Read-only wrapper around the embeddings SQLite database.
 *
 * Dual-path query architecture (see sqlite-vec issue #196):
 * - `search()` → vec0 virtual table for pure KNN (2-3x faster brute-force)
 * - `searchFiltered()` → regular table + vec_distance_cosine() for pre-filtered queries
 *   (vec0 pre-filtering is O(n²) internally — the maintainer recommends avoiding it)
 */
export class EmbeddingsDb {
  private db: DatabaseType | null = null;
  private dimensions = 0;
  private artworkCount = 0;

  // Cached prepared statements
  private stmtKnn!: Statement;
  private stmtArtwork!: Statement;

  constructor() {
    const dbPath = resolveDbPath("EMBEDDINGS_DB_PATH", "embeddings.db");
    if (!dbPath) {
      console.error("Embeddings DB not found — semantic_search disabled");
      return;
    }

    try {
      this.db = new Database(dbPath, { readonly: true });
      this.db.pragma("mmap_size = 3221225472"); // 3 GB — eliminates double-buffering

      // Load sqlite-vec extension
      const sqliteVec = require("sqlite-vec");
      sqliteVec.load(this.db);

      // Read metadata
      const meta = this.db.prepare("SELECT key, value FROM metadata").all() as { key: string; value: string }[];
      const metaMap = Object.fromEntries(meta.map(r => [r.key, r.value]));
      this.dimensions = parseInt(metaMap.dimensions ?? "384", 10);
      this.artworkCount = parseInt(metaMap.artwork_count ?? "0", 10);

      // Cache prepared statements — pure KNN path (vec0)
      this.stmtKnn = this.db.prepare(`
        SELECT rowid, distance FROM vec_artworks
        WHERE embedding MATCH ? AND k = ?
        ORDER BY distance
      `);

      // Artwork detail lookup by art_id
      this.stmtArtwork = this.db.prepare(
        "SELECT art_id, object_number, source_text FROM artwork_embeddings WHERE art_id = ?"
      );

      console.error(`Embeddings DB: ${this.artworkCount.toLocaleString()} vectors (${this.dimensions}d)`);
    } catch (err) {
      console.error(`Failed to open embeddings DB: ${err instanceof Error ? err.message : err}`);
      this.db = null;
    }
  }

  get available(): boolean { return this.db !== null; }

  /**
   * Pure KNN search — no metadata filters.
   * Uses vec0 virtual table for best performance (2-3x faster than regular table).
   */
  search(queryEmbedding: Float32Array, k: number): SemanticSearchResult[] {
    if (!this.db) return [];

    // Quantize query to int8 (must match stored format)
    const quantized = this.db.prepare(
      "SELECT vec_quantize_int8(vec_normalize(?), 'unit') as v"
    ).get(queryEmbedding) as { v: Buffer };

    // KNN scan via vec0
    const rows = this.stmtKnn.all(quantized.v, Math.min(k, 4096)) as { rowid: number; distance: number }[];

    // Resolve artwork details
    return rows.map(row => {
      const artwork = this.stmtArtwork.get(row.rowid) as { art_id: number; object_number: string; source_text: string | null } | undefined;
      if (!artwork) return null;
      return {
        artId: artwork.art_id,
        objectNumber: artwork.object_number,
        sourceText: artwork.source_text,
        distance: row.distance,
      };
    }).filter((r): r is SemanticSearchResult => r !== null);
  }

  /**
   * Filtered KNN search — pre-filter by art_id set, then compute distances.
   * Uses regular table + vec_distance_cosine() per sqlite-vec maintainer recommendation.
   * Best when filter is selective (returns <50K candidates from 831K total).
   */
  searchFiltered(queryEmbedding: Float32Array, candidateArtIds: number[], k: number): SemanticSearchResult[] {
    if (!this.db || candidateArtIds.length === 0) return [];

    // Quantize query to int8
    const quantized = this.db.prepare(
      "SELECT vec_quantize_int8(vec_normalize(?), 'unit') as v"
    ).get(queryEmbedding) as { v: Buffer };

    // For very large candidate sets (>50K), fall back to pure KNN + post-filter
    // since iterating 50K+ rows with vec_distance_cosine is slower than full scan
    if (candidateArtIds.length > 50000) {
      const allResults = this.search(queryEmbedding, Math.min(k * 10, 4096));
      const idSet = new Set(candidateArtIds);
      return allResults.filter(r => idSet.has(r.artId)).slice(0, k);
    }

    // Build parameterized IN list — batch in chunks to avoid SQLite variable limit
    const CHUNK_SIZE = 999; // SQLite max variables per statement
    const allResults: SemanticSearchResult[] = [];

    for (let i = 0; i < candidateArtIds.length; i += CHUNK_SIZE) {
      const chunk = candidateArtIds.slice(i, i + CHUNK_SIZE);
      const placeholders = chunk.map(() => "?").join(",");
      const stmt = this.db.prepare(`
        SELECT
          art_id AS artId,
          object_number AS objectNumber,
          source_text AS sourceText,
          vec_distance_cosine(embedding, ?) AS distance
        FROM artwork_embeddings
        WHERE art_id IN (${placeholders})
        ORDER BY distance
      `);

      const rows = stmt.all(quantized.v, ...chunk) as SemanticSearchResult[];
      allResults.push(...rows);
    }

    // Sort all chunks by distance and take top k
    allResults.sort((a, b) => a.distance - b.distance);
    return allResults.slice(0, k);
  }
}
