import Database, { type Database as DatabaseType } from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

// ─── Types ───────────────────────────────────────────────────────────

export interface VocabSearchParams {
  subject?: string;
  iconclass?: string;
  depictedPerson?: string;
  depictedPlace?: string;
  productionPlace?: string;
  birthPlace?: string;
  deathPlace?: string;
  profession?: string;
  material?: string;
  technique?: string;
  type?: string;
  creator?: string;
  collectionSet?: string;
  license?: string;
  maxResults?: number;
}

export interface VocabSearchResult {
  totalResults?: number;
  results: { objectNumber: string; title: string; creator: string; url: string }[];
  source: "vocabulary";
  warnings?: string[];
}

// ─── Filter definitions ─────────────────────────────────────────────
// Each entry maps a VocabSearchParams key to the SQL constraints used
// in a mapping subquery.  `fields` restricts m.field, `vocabType`
// restricts v.type, and `matchMode` controls exact vs LIKE matching.

const ALLOWED_FIELDS = new Set(["subject", "spatial", "material", "technique", "type", "creator", "birth_place", "death_place", "profession", "collection_set"]);
const ALLOWED_VOCAB_TYPES = new Set(["person", "place", "classification", "set"]);

interface VocabFilter {
  param: keyof VocabSearchParams;
  fields: string[];
  vocabType?: string;
  matchMode: "like" | "like-word" | "exact-notation";
  /** When FTS5 is available, upgrade this mode to FTS5 instead. */
  ftsUpgrade?: boolean;
}

const VOCAB_FILTERS: VocabFilter[] = [
  { param: "iconclass",      fields: ["subject"],               matchMode: "exact-notation" },
  { param: "subject",        fields: ["subject"],               matchMode: "like-word",  ftsUpgrade: true },
  { param: "depictedPerson", fields: ["subject"],               matchMode: "like", vocabType: "person",         ftsUpgrade: true },
  { param: "depictedPlace",  fields: ["subject", "spatial"],    matchMode: "like", vocabType: "place",          ftsUpgrade: true },
  { param: "productionPlace",fields: ["spatial"],               matchMode: "like", vocabType: "place",          ftsUpgrade: true },
  { param: "birthPlace",     fields: ["birth_place"],           matchMode: "like", vocabType: "place",          ftsUpgrade: true },
  { param: "deathPlace",     fields: ["death_place"],           matchMode: "like", vocabType: "place",          ftsUpgrade: true },
  { param: "profession",     fields: ["profession"],            matchMode: "like", vocabType: "classification", ftsUpgrade: true },
  { param: "material",       fields: ["material"],              matchMode: "like",                               ftsUpgrade: true },
  { param: "technique",      fields: ["technique"],             matchMode: "like",                               ftsUpgrade: true },
  { param: "type",           fields: ["type"],                  matchMode: "like",                               ftsUpgrade: true },
  { param: "creator",        fields: ["creator"],               matchMode: "like",                               ftsUpgrade: true },
  { param: "collectionSet",  fields: ["collection_set"],        matchMode: "like", vocabType: "set",            ftsUpgrade: true },
];

// ─── VocabularyDb ────────────────────────────────────────────────────

export class VocabularyDb {
  private db: DatabaseType | null = null;
  private hasFts5 = false;

  constructor() {
    const dbPath = this.resolveDbPath();
    if (!dbPath) {
      console.error("Vocabulary DB not found — vocabulary search disabled");
      return;
    }

    try {
      this.db = new Database(dbPath, { readonly: true });
      // Word-boundary matching for subject search (e.g. "cat" must not match "Catharijnekerk")
      this.db.function("regexp_word", (pattern: string, value: string) => {
        const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`\\b${escaped}\\b`, "i").test(value) ? 1 : 0;
      });
      const count = (this.db.prepare("SELECT COUNT(*) as n FROM artworks").get() as { n: number }).n;

      // Check for FTS5 table (present in v0.9+ DBs)
      try {
        this.db.prepare("SELECT 1 FROM vocabulary_fts LIMIT 1").get();
        this.hasFts5 = true;
      } catch {
        this.hasFts5 = false;
      }

      console.error(`Vocabulary DB loaded: ${dbPath} (${count.toLocaleString()} artworks, FTS5=${this.hasFts5})`);
    } catch (err) {
      console.error(`Failed to open vocabulary DB: ${err instanceof Error ? err.message : err}`);
      this.db = null;
    }
  }

  get available(): boolean {
    return this.db !== null;
  }

  /**
   * Touch each mapping field's B-tree pages to load them into SQLite's page cache.
   * Eliminates the 10–25s cold-start penalty on the first vocab query per field.
   * Synchronous — blocks the event loop. Call before accepting connections.
   */
  warmPageCache(): void {
    if (!this.db) return;
    const start = performance.now();
    const fields = [...new Set(VOCAB_FILTERS.flatMap((f) => f.fields))];
    for (const field of fields) {
      const { n } = this.db.prepare(
        `SELECT COUNT(*) as n FROM mappings WHERE field = ?`
      ).get(field) as { n: number };
      console.error(`  ${field}: ${n.toLocaleString()} mappings`);
    }
    const ms = Math.round(performance.now() - start);
    console.error(`SQLite page cache warmed: ${fields.length} fields in ${ms}ms`);
  }

  /** Search artworks by vocabulary criteria. Multiple params are intersected (AND). */
  search(params: VocabSearchParams): VocabSearchResult {
    if (!this.db) {
      return { totalResults: 0, results: [], source: "vocabulary" };
    }

    const conditions: string[] = [];
    const bindings: unknown[] = [];

    for (const filter of VOCAB_FILTERS) {
      const value = params[filter.param];
      if (value === undefined) continue;

      for (const f of filter.fields) {
        if (!ALLOWED_FIELDS.has(f)) throw new Error(`Invalid vocab field: ${f}`);
      }
      if (filter.vocabType && !ALLOWED_VOCAB_TYPES.has(filter.vocabType)) {
        throw new Error(`Invalid vocab type: ${filter.vocabType}`);
      }

      const fieldClause = filter.fields.length === 1
        ? `m.field = '${filter.fields[0]}'`
        : `m.field IN (${filter.fields.map((f) => `'${f}'`).join(", ")})`;

      const typeClause = filter.vocabType ? ` AND type = '${filter.vocabType}'` : "";

      // Two-step subquery: first narrow vocabulary (149K rows), then index-lookup mappings.
      // ~20x faster than JOIN which scans up to 2M mapping rows.
      let vocabWhere: string;
      let matchBindings: unknown[];

      // When FTS5 is available and the filter supports it, use token lookup (~500x faster)
      const useFts = this.hasFts5 && filter.ftsUpgrade && filter.matchMode !== "exact-notation";

      if (useFts) {
        // FTS5 match: double-quote the value to treat it as a phrase/token.
        // Escape any embedded double quotes (FTS5 uses "" to escape " inside phrases).
        const escaped = String(value).replace(/"/g, '""');
        vocabWhere = `rowid IN (SELECT rowid FROM vocabulary_fts WHERE vocabulary_fts MATCH ?)`;
        matchBindings = [`"${escaped}"`];
      } else {
        switch (filter.matchMode) {
          case "exact-notation":
            vocabWhere = "notation = ?";
            matchBindings = [value];
            break;
          case "like-word":
            vocabWhere = "(regexp_word(?, label_en) OR regexp_word(?, label_nl))";
            matchBindings = [value, value];
            break;
          default: // "like"
            vocabWhere = "(label_en LIKE ? COLLATE NOCASE OR label_nl LIKE ? COLLATE NOCASE)";
            matchBindings = [`%${value}%`, `%${value}%`];
            break;
        }
      }

      conditions.push(`a.object_number IN (
        SELECT m.object_number FROM mappings m
        WHERE ${fieldClause} AND m.vocab_id IN (
          SELECT id FROM vocabulary WHERE ${vocabWhere}${typeClause}
        )
      )`);
      bindings.push(...matchBindings);
    }

    // Direct column filter: license matches against artworks.rights_uri
    if (params.license) {
      conditions.push("a.rights_uri LIKE ?");
      bindings.push(`%${params.license}%`);
    }

    if (conditions.length === 0) {
      return { totalResults: 0, results: [], source: "vocabulary" };
    }

    const where = conditions.join(" AND ");
    const limit = Math.min(params.maxResults ?? 25, 25);

    // COUNT is expensive for cross-filter queries (multiple IN-subquery intersections
    // can scan tens of thousands of rows). Only compute it for single-filter queries.
    const totalResults = conditions.length === 1
      ? (this.db.prepare(`SELECT COUNT(*) as n FROM artworks a WHERE ${where}`).get(...bindings) as { n: number }).n
      : undefined;

    const sql = `SELECT a.object_number, a.title, a.creator_label FROM artworks a WHERE ${where} LIMIT ?`;
    const rows = this.db.prepare(sql).all(...bindings, limit) as {
      object_number: string;
      title: string;
      creator_label: string;
    }[];

    return {
      totalResults,
      results: rows.map((r) => ({
        objectNumber: r.object_number,
        title: r.title || "",
        creator: r.creator_label || "",
        url: `https://www.rijksmuseum.nl/en/collection/${r.object_number}`,
      })),
      source: "vocabulary",
    };
  }

  /** Return the URIs of the N most frequently referenced vocabulary terms. */
  topTermUris(limit: number = 200): string[] {
    if (!this.db) return [];
    // Requires pre-computed vocab_term_counts table (~14ms).
    // Without it, the GROUP BY over 7.3M rows takes ~41s and blocks the event loop.
    try {
      const rows = this.db.prepare(
        `SELECT vocab_id FROM vocab_term_counts ORDER BY cnt DESC LIMIT ?`
      ).all(limit) as { vocab_id: string }[];
      return rows.map((r) => `https://id.rijksmuseum.nl/${r.vocab_id}`);
    } catch {
      return [];
    }
  }

  /** Look up a vocabulary term by Iconclass notation. */
  lookupByNotation(code: string): { id: string; labelEn: string; labelNl: string } | null {
    if (!this.db) return null;
    const row = this.db
      .prepare("SELECT id, label_en, label_nl FROM vocabulary WHERE notation = ?")
      .get(code) as { id: string; label_en: string; label_nl: string } | undefined;
    if (!row) return null;
    return { id: row.id, labelEn: row.label_en || "", labelNl: row.label_nl || "" };
  }

  private resolveDbPath(): string | null {
    // 1. Explicit env var
    const envPath = process.env.VOCAB_DB_PATH;
    if (envPath && fs.existsSync(envPath)) return envPath;

    // 2. Default ./data/vocabulary.db
    const defaultPath = path.join(process.cwd(), "data", "vocabulary.db");
    if (fs.existsSync(defaultPath)) return defaultPath;

    return null;
  }
}
