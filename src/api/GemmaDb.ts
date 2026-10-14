import Database, { type Database as DatabaseType, type Statement } from "better-sqlite3";
import { createRequire } from "node:module";
import { resolveDbPath } from "../utils/db.js";
import { logInfo, logWarn, logError } from "../utils/log.js";

const require = createRequire(import.meta.url);

export interface GemmaHit {
  artId: number;
  similarity: number;
}

export interface GemmaNotation {
  notation: string;
  label: string;
  similarity: number;
}

export type GemmaVectorTable = "metadata" | "images";

const VEC_TABLES: Record<GemmaVectorTable, string> = {
  metadata: "vec_gemma_metadata",
  images: "vec_gemma_images",
};

/**
 * Read-only wrapper around gemma.db (scripts/build-gemma-db.py): EmbeddingGemma 2
 * vectors for artwork metadata, artwork images and Iconclass notations, all in one
 * 768d space. KNN follows EmbeddingsDb's rules — vec0 only, and filtered search
 * passes candidates as one JSON array, never per-id lookups or a JOIN.
 */
export class GemmaDb {
  private db: DatabaseType | null = null;
  private dbPath_: string | null = null;
  private buildId_ = "unknown";
  private scale = 127;
  private dimensions = 768;
  private knn = new Map<GemmaVectorTable, Statement>();
  private filteredKnn = new Map<GemmaVectorTable, Statement>();
  private stmtNotationKnn: Statement | null = null;

  constructor() {
    const dbPath = resolveDbPath("GEMMA_DB_PATH", "gemma.db");
    if (!dbPath) {
      logWarn("Gemma DB not found — multimodal_search disabled");
      return;
    }
    try {
      this.db = new Database(dbPath, { readonly: true });
      this.dbPath_ = dbPath;
      this.db.pragma("mmap_size = 1073741824");
      require("sqlite-vec").load(this.db);

      const meta = Object.fromEntries(
        (this.db.prepare("SELECT key, value FROM version_info").all() as { key: string; value: string }[])
          .map(r => [r.key, r.value]),
      );
      this.buildId_ = meta.built_at ?? "unknown";
      this.scale = parseFloat(meta.int8_scale ?? "127");
      this.dimensions = parseInt(meta.dimensions ?? "768", 10);

      for (const [key, table] of Object.entries(VEC_TABLES) as [GemmaVectorTable, string][]) {
        this.knn.set(key, this.db.prepare(`
          SELECT artwork_id, distance FROM ${table}
          WHERE embedding MATCH vec_int8(?) AND k = ?
          ORDER BY distance
        `));
        this.filteredKnn.set(key, this.db.prepare(`
          SELECT artwork_id, distance FROM ${table}
          WHERE embedding MATCH vec_int8(?) AND k = ?
            AND artwork_id IN (SELECT value FROM json_each(?))
          ORDER BY distance
        `));
      }
      this.stmtNotationKnn = this.db.prepare(`
        SELECT n.notation, n.label, v.distance FROM (
          SELECT notation_id, distance FROM vec_gemma_iconclass
          WHERE embedding MATCH vec_int8(?) AND k = ?
        ) v JOIN iconclass_notations n ON n.id = v.notation_id
        ORDER BY v.distance
      `);
      logInfo(`Gemma DB: ${meta.metadata_count} metadata / ${meta.image_count} image / ${meta.iconclass_count} Iconclass vectors (${this.dimensions}d)`);
    } catch (err) {
      logError("Failed to open Gemma DB", err);
      this.db = null;
    }
  }

  get available(): boolean { return this.db !== null && this.stmtNotationKnn !== null; }
  get buildId(): string { return this.buildId_; }
  get dbPath(): string | null { return this.dbPath_; }
  get rawDb(): DatabaseType | null { return this.db; }

  /**
   * Quantise a unit query vector with the corpus scale. Gemma components peak
   * ~0.4, so sqlite-vec's 'unit' quantiser (×127) would use only ~±50 levels;
   * cosine distance is scale-invariant, so matching the corpus scale is free precision.
   */
  quantize(vec: Float32Array): Buffer {
    const q = new Int8Array(vec.length);
    for (let i = 0; i < vec.length; i++) {
      q[i] = Math.max(-127, Math.min(127, Math.round(vec[i] * this.scale)));
    }
    return Buffer.from(q.buffer);
  }

  /** Top-k artworks by cosine similarity; restricted to `candidates` when given. */
  search(table: GemmaVectorTable, query: Buffer, k: number, candidates?: number[]): GemmaHit[] {
    if (!this.db) return [];
    if (candidates && candidates.length === 0) return [];
    const kk = Math.min(k, 4096);
    const rows = (candidates
      ? this.filteredKnn.get(table)!.all(query, kk, JSON.stringify(candidates))
      : this.knn.get(table)!.all(query, kk)) as { artwork_id: number; distance: number }[];
    return rows.map(r => ({ artId: r.artwork_id, similarity: 1 - r.distance }));
  }

  /** Nearest Iconclass notations (only those that tag Rijksmuseum artworks). */
  nearestNotations(query: Buffer, k: number): GemmaNotation[] {
    if (!this.stmtNotationKnn) return [];
    return (this.stmtNotationKnn.all(query, k) as { notation: string; label: string | null; distance: number }[])
      .map(r => ({ notation: r.notation, label: r.label ?? "", similarity: 1 - r.distance }));
  }
}
