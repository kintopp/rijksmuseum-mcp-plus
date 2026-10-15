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
const TABLES: GemmaVectorTable[] = ["metadata", "images"];

const VEC_TABLES: Record<GemmaVectorTable, string> = {
  metadata: "vec_gemma_metadata",
  images: "vec_gemma_images",
};

/** Coarse candidates rescored exactly; ≥8× the fused channel depth keeps top-50 recall ≈1. */
const COARSE_CANDIDATES = 2000;
/** Candidate sets up to this size skip the coarse scan and are rescored exactly. */
const EXACT_RESCORE_MAX = 20_000;

interface CoarseIndex {
  ids: Int32Array;        // ascending artwork_id
  prefixes: Int8Array;    // n × coarseDims
  invNorms: Float32Array; // 1 / ‖prefix‖
}

/**
 * Read-only wrapper around gemma.db (scripts/build-gemma-db.py): EmbeddingGemma 2
 * vectors for artwork metadata, artwork images and Iconclass notations, all in one
 * 768d space.
 *
 * Two layouts. Two-stage (version_info coarse_dims): an MRL-truncated prefix of every
 * artwork vector is held in memory and scanned in JS, and the top candidates are
 * rescored against the full vectors by rowid lookup — vec0's KNN cost grows with k,
 * so it can't serve a coarse pass of thousands. Legacy: exact vec0 KNN over the full
 * vectors. Iconclass stays on vec0 in both (small table, small k).
 */
export class GemmaDb {
  private db: DatabaseType | null = null;
  private dbPath_: string | null = null;
  private buildId_ = "unknown";
  private scale = 127;
  private dimensions = 768;
  private coarseDims = 0;
  private knn = new Map<GemmaVectorTable, Statement>();
  private filteredKnn = new Map<GemmaVectorTable, Statement>();
  private stmtVectors = new Map<GemmaVectorTable, Statement>();
  private stmtNotationKnn: Statement | null = null;
  private coarse = new Map<GemmaVectorTable, CoarseIndex>();
  private loaders = new Map<GemmaVectorTable, Generator<void, CoarseIndex>>();

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
      this.coarseDims = parseInt(meta.coarse_dims ?? "0", 10);
      // Two-stage scans an in-memory copy and rescores a few thousand rows per query, so
      // mmap only adds file pages to RSS — the coarse chunks would be resident twice.
      if (this.coarseDims) this.db.pragma("mmap_size = 0");

      for (const t of TABLES) {
        if (this.coarseDims) {
          this.stmtVectors.set(t, this.db.prepare(`
            SELECT artwork_id, embedding FROM gemma_${t}_vectors
            WHERE artwork_id IN (SELECT value FROM json_each(?))
          `));
        } else {
          this.knn.set(t, this.db.prepare(`
            SELECT artwork_id, distance FROM ${VEC_TABLES[t]}
            WHERE embedding MATCH vec_int8(?) AND k = ?
            ORDER BY distance
          `));
          this.filteredKnn.set(t, this.db.prepare(`
            SELECT artwork_id, distance FROM ${VEC_TABLES[t]}
            WHERE embedding MATCH vec_int8(?) AND k = ?
              AND artwork_id IN (SELECT value FROM json_each(?))
            ORDER BY distance
          `));
        }
      }
      this.stmtNotationKnn = this.db.prepare(`
        SELECT n.notation, n.label, v.distance FROM (
          SELECT notation_id, distance FROM vec_gemma_iconclass
          WHERE embedding MATCH vec_int8(?) AND k = ?
        ) v JOIN iconclass_notations n ON n.id = v.notation_id
        ORDER BY v.distance
      `);
      const layout = this.coarseDims ? `two-stage, ${this.coarseDims}d coarse` : "vec0";
      logInfo(`Gemma DB: ${meta.metadata_count} metadata / ${meta.image_count} image / ${meta.iconclass_count} Iconclass vectors (${this.dimensions}d, ${layout})`);
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
   * Load the in-memory coarse index, one chunk per event-loop turn so a warming
   * server keeps answering. No-op on the legacy layout or once loaded.
   */
  async loadCoarse(yieldTick: () => Promise<void>): Promise<void> {
    if (!this.db || !this.coarseDims) return;
    const t0 = Date.now();
    for (const t of TABLES) {
      const loader = this.loader(t);
      while (!this.coarse.has(t)) {
        loader.next();
        await yieldTick();
      }
    }
    const bytes = [...this.coarse.values()].reduce((s, c) => s + c.prefixes.byteLength + c.ids.byteLength + c.invNorms.byteLength, 0);
    logInfo(`Gemma coarse index loaded: ${Math.round(bytes / 1e6)} MB in ${Date.now() - t0}ms`);
  }

  /** Shared between the async warm-up and a search that arrives before it finishes. */
  private loader(t: GemmaVectorTable): Generator<void, CoarseIndex> {
    let g = this.loaders.get(t);
    if (!g) {
      g = this.loadChunks(t);
      this.loaders.set(t, g);
    }
    return g;
  }

  private *loadChunks(t: GemmaVectorTable): Generator<void, CoarseIndex> {
    const db = this.db!;
    const d = this.coarseDims;
    const { total, chunks } = db.prepare(
      "SELECT SUM(n) AS total, COUNT(*) AS chunks FROM gemma_coarse_chunks WHERE channel = ?",
    ).get(t) as { total: number; chunks: number };
    const ids = new Int32Array(total);
    const prefixes = new Int8Array(total * d);
    const invNorms = new Float32Array(total);
    const stmt = db.prepare(
      "SELECT n, artwork_ids, prefixes, inv_norms FROM gemma_coarse_chunks WHERE channel = ? AND chunk_no = ?",
    );
    let off = 0;
    for (let c = 0; c < chunks; c++) {
      const row = stmt.get(t, c) as { n: number; artwork_ids: Buffer; prefixes: Buffer; inv_norms: Buffer };
      // Blobs aren't guaranteed 4-byte aligned, so copy bytes rather than view them as int32/float32.
      new Uint8Array(ids.buffer, off * 4, row.n * 4).set(row.artwork_ids);
      new Uint8Array(prefixes.buffer, off * d, row.n * d).set(row.prefixes);
      new Uint8Array(invNorms.buffer, off * 4, row.n * 4).set(row.inv_norms);
      off += row.n;
      yield;
    }
    const index = { ids, prefixes, invNorms };
    this.coarse.set(t, index);
    return index;
  }

  private ensureCoarse(t: GemmaVectorTable): CoarseIndex {
    const loaded = this.coarse.get(t);
    if (loaded) return loaded;
    const g = this.loader(t);
    let r = g.next();
    while (!r.done) r = g.next();
    return this.coarse.get(t)!;
  }

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
    if (!this.coarseDims) {
      const rows = (candidates
        ? this.filteredKnn.get(table)!.all(query, kk, JSON.stringify(candidates))
        : this.knn.get(table)!.all(query, kk)) as { artwork_id: number; distance: number }[];
      return rows.map(r => ({ artId: r.artwork_id, similarity: 1 - r.distance }));
    }
    const q = new Int8Array(query.buffer, query.byteOffset, query.length);
    const ids = candidates && candidates.length <= EXACT_RESCORE_MAX
      ? candidates
      : this.coarseCandidates(table, q, Math.max(COARSE_CANDIDATES, kk * 8), candidates);
    return this.rescore(table, q, ids, kk);
  }

  /** Top-c artwork ids by prefix cosine, over all rows or only those in `candidates`. */
  private coarseCandidates(t: GemmaVectorTable, q: Int8Array, c: number, candidates?: number[]): number[] {
    const { ids, prefixes, invNorms } = this.ensureCoarse(t);
    const d = this.coarseDims;
    const heap = new TopK(c);
    const scoreRow = (i: number): void => {
      let dot = 0;
      for (let j = 0, o = i * d; j < d; j++, o++) dot += prefixes[o] * q[j];
      heap.push(dot * invNorms[i], i);
    };
    if (candidates) {
      // Sorted merge walk: sequential over the prefix buffer, unlike per-id binary search.
      const sorted = Int32Array.from(candidates).sort();
      for (let s = 0, i = 0; s < sorted.length && i < ids.length; s++) {
        while (i < ids.length && ids[i] < sorted[s]) i++;
        if (ids[i] === sorted[s]) scoreRow(i);
      }
    } else {
      for (let i = 0; i < ids.length; i++) scoreRow(i);
    }
    return heap.indices().map(i => ids[i]);
  }

  /** Exact cosine over the full vectors of `ids`, best k first. */
  private rescore(t: GemmaVectorTable, q: Int8Array, ids: number[], k: number): GemmaHit[] {
    let qq = 0;
    for (let j = 0; j < q.length; j++) qq += q[j] * q[j];
    const qNorm = Math.sqrt(qq);
    const rows = this.stmtVectors.get(t)!.all(JSON.stringify(ids)) as { artwork_id: number; embedding: Buffer }[];
    const hits: GemmaHit[] = rows.map(r => {
      const v = r.embedding;
      let dot = 0, vv = 0;
      for (let j = 0; j < v.length; j++) {
        const x = (v[j] << 24) >> 24; // Buffer reads uint8; sign-extend to int8
        dot += x * q[j];
        vv += x * x;
      }
      return { artId: r.artwork_id, similarity: dot / (Math.sqrt(vv) * qNorm) };
    });
    hits.sort((a, b) => b.similarity - a.similarity);
    return hits.slice(0, k);
  }

  /** Nearest Iconclass notations (only those that tag Rijksmuseum artworks). */
  nearestNotations(query: Buffer, k: number): GemmaNotation[] {
    if (!this.stmtNotationKnn) return [];
    return (this.stmtNotationKnn.all(query, k) as { notation: string; label: string | null; distance: number }[])
      .map(r => ({ notation: r.notation, label: r.label ?? "", similarity: 1 - r.distance }));
  }
}

/** Fixed-capacity min-heap keeping the c highest scores; most rows fail the root test. */
class TopK {
  private scores: Float32Array;
  private idx: Int32Array;
  private size = 0;

  constructor(private cap: number) {
    this.scores = new Float32Array(cap);
    this.idx = new Int32Array(cap);
  }

  push(score: number, i: number): void {
    if (this.size < this.cap) {
      let p = this.size++;
      while (p > 0) {
        const parent = (p - 1) >> 1;
        if (this.scores[parent] <= score) break;
        this.scores[p] = this.scores[parent]; this.idx[p] = this.idx[parent];
        p = parent;
      }
      this.scores[p] = score; this.idx[p] = i;
    } else if (score > this.scores[0]) {
      let p = 0;
      for (;;) {
        let ch = 2 * p + 1;
        if (ch >= this.cap) break;
        if (ch + 1 < this.cap && this.scores[ch + 1] < this.scores[ch]) ch++;
        if (this.scores[ch] >= score) break;
        this.scores[p] = this.scores[ch]; this.idx[p] = this.idx[ch];
        p = ch;
      }
      this.scores[p] = score; this.idx[p] = i;
    }
  }

  indices(): number[] {
    return Array.from(this.idx.subarray(0, this.size));
  }
}
