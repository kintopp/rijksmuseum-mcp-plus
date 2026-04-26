import Database, { type Database as DatabaseType, type Statement } from "better-sqlite3";
import { createRequire } from "node:module";
import { resolveDbPath } from "../utils/db.js";
import { FILTER_ART_IDS_LIMIT } from "./VocabularyDb.js";

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

export interface DescriptionSearchResult {
  artId: number;
  objectNumber: string;
  similarity: number; // 1 - distance (cosine similarity)
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
  private dbPath_: string | null = null;
  private dimensions = 0;
  private artworkCount = 0;

  // Cached prepared statements (null until constructor succeeds)
  private stmtQuantize: Statement | null = null;
  private stmtKnn: Statement | null = null;
  private stmtArtwork: Statement | null = null;
  private stmtFilteredKnn = new Map<number, Statement>(); // keyed by chunk size

  // Description embedding statements (null if desc tables not present)
  private stmtDescLookup: Statement | null = null;
  private stmtDescKnn: Statement | null = null;
  private descAvailable_ = false;
  private descDimensions = 0;
  private descArtworkCount = 0;

  constructor() {
    const dbPath = resolveDbPath("EMBEDDINGS_DB_PATH", "embeddings.db");
    if (!dbPath) {
      console.error("Embeddings DB not found — semantic_search disabled");
      return;
    }

    try {
      this.db = new Database(dbPath, { readonly: true });
      this.dbPath_ = dbPath;
      this.db.pragma("mmap_size = 1073741824"); // 1 GB — DB is ~2 GB on disk; observed working set ~740 MB (vec0 warmed + desc on demand, issue #272)

      // Load sqlite-vec extension
      const sqliteVec = require("sqlite-vec");
      sqliteVec.load(this.db);

      // Read version info
      const meta = this.db.prepare("SELECT key, value FROM version_info").all() as { key: string; value: string }[];
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

      // Description embedding tables (optional — added by generate-description-embeddings-modal.py)
      try {
        this.db.prepare("SELECT 1 FROM desc_embeddings LIMIT 1").get();
        this.db.prepare("SELECT 1 FROM vec_desc_artworks LIMIT 1").get();

        this.descDimensions = parseInt(metaMap.desc_dimensions ?? "384", 10);
        this.descArtworkCount = parseInt(metaMap.desc_artwork_count ?? "0", 10);

        this.stmtDescLookup = this.db.prepare(
          "SELECT embedding FROM desc_embeddings WHERE art_id = ?"
        );
        this.stmtDescKnn = this.db.prepare(`
          SELECT artwork_id, distance FROM vec_desc_artworks
          WHERE embedding MATCH vec_int8(?) AND k = ?
          ORDER BY distance
        `);
        this.descAvailable_ = true;
        console.error(`  Description embeddings: ${this.descArtworkCount.toLocaleString()} vectors (${this.descDimensions}d)`);
      } catch {
        // desc tables not present — description similarity disabled
      }
    } catch (err) {
      console.error(`Failed to open embeddings DB: ${err instanceof Error ? err.message : err}`);
      this.db = null;
    }
  }

  get available(): boolean { return this.db !== null && this.stmtQuantize !== null; }
  get vectorDimensions(): number { return this.dimensions; }
  get dbPath(): string | null { return this.dbPath_; }
  get rawDb(): DatabaseType | null { return this.db; }

  /** Page in vec0 data so the first real KNN query is fast.
   *  Runs a single k=1 scan over the full vector index. */
  warmCorePages(): void {
    if (!this.db || !this.stmtQuantize || !this.stmtKnn) return;
    const t0 = Date.now();
    try {
      // Encode a zero vector — content doesn't matter, we just need to scan the index
      const zeros = new Float32Array(this.dimensions);
      const quantized = this.stmtQuantize.get(zeros) as { v: Buffer };
      this.stmtKnn.all(quantized.v, 1);
      console.error(`  Embeddings vec0 pages warmed in ${Date.now() - t0}ms`);
    } catch (err) {
      console.error(`  Embeddings warmup failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Page in the `artwork_embeddings` table + compile the filtered-KNN prepared
   *  statement. Runs a one-shot filtered query against a small slice of real
   *  art_ids so the first filtered semantic_search doesn't pay cold-page cost. */
  warmFilteredPath(queryEmbedding: Float32Array): void {
    if (!this.db || !this.stmtQuantize) return;
    const t0 = Date.now();
    try {
      const rows = this.db.prepare(
        "SELECT art_id FROM artwork_embeddings LIMIT 100"
      ).all() as { art_id: number }[];
      if (rows.length === 0) return;
      this.searchFiltered(queryEmbedding, rows.map(r => r.art_id), 1);
      console.error(`  Embeddings filtered path warmed in ${Date.now() - t0}ms`);
    } catch (err) {
      console.error(`  Embeddings filtered warmup failed: ${err instanceof Error ? err.message : err}`);
    }
  }

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
   * Chunked path scales linearly (~3ms/1K candidates) up to FILTER_ART_IDS_LIMIT;
   * beyond that, falls back to pure KNN + post-filter (~1.5s full scan).
   */
  searchFiltered(queryEmbedding: Float32Array, candidateArtIds: number[], k: number): FilteredSearchResponse {
    if (!this.db || !this.stmtQuantize || candidateArtIds.length === 0) return { results: [] };

    const quantized = this.stmtQuantize.get(queryEmbedding) as { v: Buffer };

    // For very large candidate sets (>200K), fall back to pure KNN + post-filter.
    // The chunked vec_distance_cosine path scales linearly (~2.5ms/1K candidates)
    // and stays faster than the ~1.5s full vec0 scan up to ~600K candidates.
    // 200K is a conservative threshold (~500ms) that leaves headroom.
    if (candidateArtIds.length >= FILTER_ART_IDS_LIMIT) {
      const allResults = this.search(queryEmbedding, 4096);
      const idSet = new Set(candidateArtIds);
      const filtered = allResults.filter(r => idSet.has(r.artId)).slice(0, k);
      const warning = filtered.length < k
        ? `Filter matched ${candidateArtIds.length.toLocaleString()} artworks (too many for precise ranking). Results are approximate — consider adding more filters to narrow the search.`
        : undefined;
      return { results: filtered, warning };
    }

    // Build parameterized IN list — batch in chunks to avoid SQLite variable limit.
    // Statements cached by chunk size (only 2 shapes: full 999 and remainder).
    const CHUNK_SIZE = 998; // SQLite max 999 variables; 1 reserved for query embedding
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

  // ── Description similarity ──────────────────────────────────────────

  get descriptionAvailable(): boolean { return this.descAvailable_; }

  /**
   * Find artworks with similar descriptions to a given artwork.
   * Looks up the query artwork's pre-computed description embedding,
   * then runs KNN on vec_desc_artworks. No model or PCA needed at runtime.
   */
  searchDescriptionSimilar(queryArtId: number, k: number): DescriptionSearchResult[] {
    if (!this.db || !this.stmtDescLookup || !this.stmtDescKnn) return [];

    // Look up the query artwork's pre-computed description embedding
    const row = this.stmtDescLookup.get(queryArtId) as { embedding: Buffer } | undefined;
    if (!row) return [];

    // KNN scan — fetch k+1 to account for self-match
    const knnRows = this.stmtDescKnn.all(row.embedding, Math.min(k + 1, 4096)) as {
      artwork_id: number; distance: number;
    }[];

    // Filter self-match and cap at k
    const filtered = knnRows.filter(r => r.artwork_id !== queryArtId).slice(0, k);
    if (filtered.length === 0) return [];

    // Batch-resolve object_numbers in a single query
    const placeholders = filtered.map(() => "?").join(", ");
    const artIds = filtered.map(r => r.artwork_id);
    const objRows = this.db.prepare(
      `SELECT art_id, object_number FROM desc_embeddings WHERE art_id IN (${placeholders})`
    ).all(...artIds) as { art_id: number; object_number: string }[];
    const objMap = new Map(objRows.map(r => [r.art_id, r.object_number]));

    return filtered
      .filter(r => objMap.has(r.artwork_id))
      .map(r => ({
        artId: r.artwork_id,
        objectNumber: objMap.get(r.artwork_id)!,
        similarity: Math.round((1 - r.distance) * 1000) / 1000,
      }));
  }
}
