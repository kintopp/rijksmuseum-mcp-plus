import Database, { type Database as DatabaseType, type Statement } from "better-sqlite3";
import { createRequire } from "node:module";
import { resolveDbPath } from "../utils/db.js";
import { logInfo, logWarn, logError } from "../utils/log.js";

const require = createRequire(import.meta.url);

// ─── Types ───────────────────────────────────────────────────────────

export interface DescriptionSearchResult {
  artId: number;
  objectNumber: string;
  similarity: number; // 1 - distance (cosine similarity)
}

// ─── EmbeddingsDb ────────────────────────────────────────────────────

/**
 * Read-only wrapper around the embeddings SQLite database. Only its description
 * vectors (`vec_desc_artworks`, find_similar's Description channel) are read;
 * semantic_search runs on gemma.db.
 *
 * Object numbers come from `artwork_object_numbers` in a slimmed DB
 * (scripts/slim-embeddings-db.py) or from the plain `desc_embeddings` table in a full one.
 */
export class EmbeddingsDb {
  private db: DatabaseType | null = null;
  private dbPath_: string | null = null;
  private stmtDescObjLookup = new Map<number, Statement>(); // keyed by placeholder count
  private objectNumberSource = "desc_embeddings";

  private stmtDescLookup: Statement | null = null;
  private stmtDescKnn: Statement | null = null;
  private descAvailable_ = false;

  constructor() {
    const dbPath = resolveDbPath("EMBEDDINGS_DB_PATH", "embeddings.db");
    if (!dbPath) {
      logWarn("Embeddings DB not found — find_similar Description channel disabled");
      return;
    }

    try {
      this.db = new Database(dbPath, { readonly: true });
      this.dbPath_ = dbPath;
      this.db.pragma("mmap_size = 1073741824");
      require("sqlite-vec").load(this.db);

      const meta = this.db.prepare("SELECT key, value FROM version_info").all() as { key: string; value: string }[];
      const metaMap = Object.fromEntries(meta.map(r => [r.key, r.value]));

      const slim = this.db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'artwork_object_numbers'"
      ).get();
      if (slim) this.objectNumberSource = "artwork_object_numbers";

      // vec_int8() wrapper required so sqlite-vec interprets the BLOB as int8 (default is float32)
      this.stmtDescLookup = this.db.prepare(
        "SELECT embedding FROM vec_desc_artworks WHERE artwork_id = ?"
      );
      this.stmtDescKnn = this.db.prepare(`
        SELECT artwork_id, distance FROM vec_desc_artworks
        WHERE embedding MATCH vec_int8(?) AND k = ?
        ORDER BY distance
      `);
      this.descAvailable_ = true;
      const count = parseInt(metaMap.desc_artwork_count ?? "0", 10);
      logInfo(`Description embeddings: ${count.toLocaleString()} vectors (${metaMap.desc_dimensions ?? "384"}d)`);
    } catch (err) {
      logError("Failed to open embeddings DB", err);
      this.db = null;
    }
  }

  get dbPath(): string | null { return this.dbPath_; }
  get rawDb(): DatabaseType | null { return this.db; }

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
