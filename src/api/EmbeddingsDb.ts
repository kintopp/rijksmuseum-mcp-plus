import Database, { type Database as DatabaseType, type Statement } from "better-sqlite3";
import { createRequire } from "node:module";
import { resolveDbPath } from "../utils/db.js";
import { logInfo, logWarn, logError } from "../utils/log.js";

const require = createRequire(import.meta.url);

// ─── Types ───────────────────────────────────────────────────────────

export interface SemanticSearchResult {
  artId: number;
  objectNumber: string;
  distance: number;
}

export interface FilteredSearchResponse {
  results: SemanticSearchResult[];
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
 * All KNN runs on the vec0 tables. Filtered search passes the candidate art_ids
 * as one JSON array (`artwork_id IN (SELECT value FROM json_each(?))`), which
 * scales roughly linearly and ranks exactly. Don't switch to per-id point
 * lookups or a JOIN against vec0: both hit sqlite-vec's slow paths (#74).
 *
 * Object numbers come from `artwork_object_numbers` in a slimmed DB
 * (scripts/slim-embeddings-db.py) or from the plain `artwork_embeddings` /
 * `desc_embeddings` tables in a full one.
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
  private stmtFilteredKnn: Statement | null = null;
  private stmtDescObjLookup = new Map<number, Statement>(); // keyed by placeholder count
  private objectNumberSource = "artwork_embeddings";

  // Description embedding statements (null if desc tables not present)
  private stmtDescLookup: Statement | null = null;
  private stmtDescKnn: Statement | null = null;
  private descAvailable_ = false;
  private descDimensions = 0;
  private descArtworkCount = 0;
  private buildId_ = "unknown";
  private modelId_ = "";

  constructor() {
    const dbPath = resolveDbPath("EMBEDDINGS_DB_PATH", "embeddings.db");
    if (!dbPath) {
      logWarn("Embeddings DB not found — semantic_search disabled");
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
      this.buildId_ = metaMap.built_at ?? "unknown";  // #378 cache-key component
      this.modelId_ = metaMap.model ?? "";

      // Cache prepared statements
      this.stmtQuantize = this.db.prepare(
        "SELECT vec_quantize_int8(vec_normalize(?), 'unit') as v"
      );

      // vec_int8() wrapper required so sqlite-vec interprets the BLOB as int8
      // (default assumption is float32)
      this.stmtKnn = this.db.prepare(`
        SELECT artwork_id, distance FROM vec_artworks
        WHERE embedding MATCH vec_int8(?) AND k = ?
        ORDER BY distance
      `);
      this.stmtFilteredKnn = this.db.prepare(`
        SELECT artwork_id, distance FROM vec_artworks
        WHERE embedding MATCH vec_int8(?) AND k = ?
          AND artwork_id IN (SELECT value FROM json_each(?))
        ORDER BY distance
      `);

      const slim = this.db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'artwork_object_numbers'"
      ).get();
      this.objectNumberSource = slim ? "artwork_object_numbers" : "artwork_embeddings";
      this.stmtArtwork = this.db.prepare(
        `SELECT art_id, object_number FROM ${this.objectNumberSource} WHERE art_id = ?`
      );

      logInfo(`Embeddings DB: ${this.artworkCount.toLocaleString()} vectors (${this.dimensions}d)`);

      // Description embedding tables (optional — added by generate-description-embeddings-modal.py)
      try {
        this.db.prepare("SELECT 1 FROM vec_desc_artworks LIMIT 1").get();

        this.descDimensions = parseInt(metaMap.desc_dimensions ?? "384", 10);
        this.descArtworkCount = parseInt(metaMap.desc_artwork_count ?? "0", 10);

        this.stmtDescLookup = this.db.prepare(
          "SELECT embedding FROM vec_desc_artworks WHERE artwork_id = ?"
        );
        this.stmtDescKnn = this.db.prepare(`
          SELECT artwork_id, distance FROM vec_desc_artworks
          WHERE embedding MATCH vec_int8(?) AND k = ?
          ORDER BY distance
        `);
        this.descAvailable_ = true;
        logInfo(`  Description embeddings: ${this.descArtworkCount.toLocaleString()} vectors (${this.descDimensions}d)`);
      } catch {
        // desc tables not present — description similarity disabled
      }
    } catch (err) {
      logError("Failed to open embeddings DB", err);
      this.db = null;
    }
  }

  get available(): boolean { return this.db !== null && this.stmtQuantize !== null; }
  /** version_info.built_at — cache-key component so a DB swap invalidates results (#378). */
  get buildId(): string { return this.buildId_; }
  /** version_info.model — the embedding model the vectors were generated with. */
  get modelId(): string { return this.modelId_; }
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
      logInfo(`  Embeddings vec0 pages warmed in ${Date.now() - t0}ms`);
    } catch (err) {
      logWarn("  Embeddings warmup failed", err);
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
   * Filtered KNN search — exact top-k among the candidate art_ids. Results
   * keep the `artId`/`objectNumber`/`distance` shape of `search()`.
   */
  searchFiltered(queryEmbedding: Float32Array, candidateArtIds: number[], k: number): FilteredSearchResponse {
    if (!this.db || !this.stmtQuantize || !this.stmtFilteredKnn || !this.stmtArtwork || candidateArtIds.length === 0) {
      return { results: [] };
    }

    const quantized = this.stmtQuantize.get(queryEmbedding) as { v: Buffer };
    const rows = this.stmtFilteredKnn.all(
      quantized.v, Math.min(k, 4096), JSON.stringify(candidateArtIds),
    ) as { artwork_id: number; distance: number }[];

    const stmtArtwork = this.stmtArtwork;
    const results = rows.map(row => {
      const artwork = stmtArtwork.get(row.artwork_id) as { art_id: number; object_number: string } | undefined;
      return artwork ? { artId: artwork.art_id, objectNumber: artwork.object_number, distance: row.distance } : null;
    }).filter((r): r is SemanticSearchResult => r !== null);
    return { results };
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

    // Batch-resolve object_numbers in a single query (statement cached by size)
    const artIds = filtered.map(r => r.artwork_id);
    let objStmt = this.stmtDescObjLookup.get(artIds.length);
    if (!objStmt) {
      const placeholders = artIds.map(() => "?").join(", ");
      objStmt = this.db.prepare(
        `SELECT art_id, object_number FROM ${this.objectNumberSource} WHERE art_id IN (${placeholders})`
      );
      this.stmtDescObjLookup.set(artIds.length, objStmt);
    }
    const objRows = objStmt.all(...artIds) as { art_id: number; object_number: string }[];
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
