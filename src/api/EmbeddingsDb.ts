import Database, { type Database as DatabaseType, type Statement } from "better-sqlite3";
import { createRequire } from "node:module";
import { resolveDbPath } from "../utils/db.js";

const require = createRequire(import.meta.url);

// ─── Types ───────────────────────────────────────────────────────────

export interface SemanticSearchResult {
  artId: number;
  objectNumber: string;
  distance: number;
}

export interface FilteredSearchResponse {
  results: SemanticSearchResult[];
  warning?: string;
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

  // Cached prepared statements (null until constructor succeeds)
  private stmtQuantize: Statement | null = null;
  private stmtKnn: Statement | null = null;
  private stmtArtwork: Statement | null = null;
  private stmtFilteredKnn = new Map<number, Statement>(); // keyed by chunk size

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

      // Cache prepared statements
      this.stmtQuantize = this.db.prepare(
        "SELECT vec_quantize_int8(vec_normalize(?), 'unit') as v"
      );

      // Pure KNN path (vec0) — vec_int8() wrapper required so sqlite-vec
      // interprets the BLOB as int8 (default assumption is float32)
      this.stmtKnn = this.db.prepare(`
        SELECT artwork_id, distance FROM vec_artworks
        WHERE embedding MATCH vec_int8(?) AND k = ?
        ORDER BY distance
      `);

      // Artwork detail lookup by art_id
      this.stmtArtwork = this.db.prepare(
        "SELECT art_id, object_number FROM artwork_embeddings WHERE art_id = ?"
      );

      console.error(`Embeddings DB: ${this.artworkCount.toLocaleString()} vectors (${this.dimensions}d)`);
    } catch (err) {
      console.error(`Failed to open embeddings DB: ${err instanceof Error ? err.message : err}`);
      this.db = null;
    }
  }

  get available(): boolean { return this.db !== null && this.stmtQuantize !== null; }

  /**
   * Pure KNN search — no metadata filters.
   * Uses vec0 virtual table for best performance (2-3x faster than regular table).
   */
  search(queryEmbedding: Float32Array, k: number): SemanticSearchResult[] {
    if (!this.db || !this.stmtQuantize || !this.stmtKnn || !this.stmtArtwork) return [];

    const { stmtQuantize, stmtKnn, stmtArtwork } = this;
    const quantized = stmtQuantize.get(queryEmbedding) as { v: Buffer };

    // KNN scan via vec0
    const rows = stmtKnn.all(quantized.v, Math.min(k, 4096)) as { artwork_id: number; distance: number }[];

    // Resolve artwork details
    return rows.map(row => {
      const artwork = stmtArtwork.get(row.artwork_id) as { art_id: number; object_number: string } | undefined;
      if (!artwork) return null;
      return {
        artId: artwork.art_id,
        objectNumber: artwork.object_number,
        distance: row.distance,
      };
    }).filter((r): r is SemanticSearchResult => r !== null);
  }

  /**
   * Filtered KNN search — pre-filter by art_id set, then compute distances.
   * Uses regular table + vec_distance_cosine() per sqlite-vec maintainer recommendation.
   * Best when filter is selective (returns <50K candidates from 831K total).
   */
  searchFiltered(queryEmbedding: Float32Array, candidateArtIds: number[], k: number): FilteredSearchResponse {
    if (!this.db || !this.stmtQuantize || candidateArtIds.length === 0) return { results: [] };

    const quantized = this.stmtQuantize.get(queryEmbedding) as { v: Buffer };

    // For very large candidate sets (>50K), fall back to pure KNN + post-filter
    // since iterating 50K+ rows with vec_distance_cosine is slower than full scan
    if (candidateArtIds.length > 50000) {
      const allResults = this.search(queryEmbedding, Math.min(k * 10, 4096));
      const idSet = new Set(candidateArtIds);
      const filtered = allResults.filter(r => idSet.has(r.artId)).slice(0, k);
      const warning = filtered.length < k
        ? `Filter matched ${candidateArtIds.length.toLocaleString()} artworks (too many for precise ranking). Results are approximate — consider adding more filters to narrow the search.`
        : undefined;
      return { results: filtered, warning };
    }

    // Build parameterized IN list — batch in chunks to avoid SQLite variable limit.
    // Statements cached by chunk size (only 2 shapes: full 999 and remainder).
    const CHUNK_SIZE = 999; // SQLite max variables per statement
    const allResults: SemanticSearchResult[] = [];

    for (let i = 0; i < candidateArtIds.length; i += CHUNK_SIZE) {
      const chunk = candidateArtIds.slice(i, i + CHUNK_SIZE);
      const stmt = this.getFilteredKnnStmt(chunk.length);
      const rows = stmt.all(quantized.v, ...chunk) as SemanticSearchResult[];
      allResults.push(...rows);
    }

    // Sort all chunks by distance and take top k
    allResults.sort((a, b) => a.distance - b.distance);
    return { results: allResults.slice(0, k) };
  }

  /** Get or create a cached prepared statement for filtered KNN with a given chunk size. */
  private getFilteredKnnStmt(chunkSize: number): Statement {
    let stmt = this.stmtFilteredKnn.get(chunkSize);
    if (!stmt) {
      const placeholders = Array.from({ length: chunkSize }, () => "?").join(", ");
      stmt = this.db!.prepare(`
        SELECT
          art_id AS artId,
          object_number AS objectNumber,
          vec_distance_cosine(vec_int8(embedding), vec_int8(?)) AS distance
        FROM artwork_embeddings
        WHERE art_id IN (${placeholders})
        ORDER BY distance
      `);
      this.stmtFilteredKnn.set(chunkSize, stmt);
    }
    return stmt;
  }
}
