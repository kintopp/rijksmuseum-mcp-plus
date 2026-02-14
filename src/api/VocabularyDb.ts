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
  maxResults?: number;
}

export interface VocabSearchResult {
  totalResults: number;
  results: { objectNumber: string; title: string; creator: string; url: string }[];
  source: "vocabulary";
}

// ─── Filter definitions ─────────────────────────────────────────────
// Each entry maps a VocabSearchParams key to the SQL constraints used
// in a mapping subquery.  `fields` restricts m.field, `vocabType`
// restricts v.type, and `matchMode` controls exact vs LIKE matching.

const ALLOWED_FIELDS = new Set(["subject", "spatial", "material", "technique", "type", "creator", "birth_place", "death_place", "profession"]);
const ALLOWED_VOCAB_TYPES = new Set(["person", "place", "classification"]);

interface VocabFilter {
  param: keyof VocabSearchParams;
  fields: string[];
  vocabType?: string;
  matchMode: "like" | "exact-notation";
}

const VOCAB_FILTERS: VocabFilter[] = [
  { param: "iconclass",      fields: ["subject"],               matchMode: "exact-notation" },
  { param: "subject",        fields: ["subject"],               matchMode: "like" },
  { param: "depictedPerson", fields: ["subject"],               matchMode: "like", vocabType: "person" },
  { param: "depictedPlace",  fields: ["subject", "spatial"],    matchMode: "like", vocabType: "place" },
  { param: "productionPlace",fields: ["spatial"],               matchMode: "like", vocabType: "place" },
  { param: "birthPlace",     fields: ["birth_place"],           matchMode: "like", vocabType: "place" },
  { param: "deathPlace",     fields: ["death_place"],           matchMode: "like", vocabType: "place" },
  { param: "profession",     fields: ["profession"],            matchMode: "like", vocabType: "classification" },
  { param: "material",       fields: ["material"],              matchMode: "like" },
  { param: "technique",      fields: ["technique"],             matchMode: "like" },
  { param: "type",           fields: ["type"],                  matchMode: "like" },
  { param: "creator",        fields: ["creator"],               matchMode: "like" },
];

// ─── VocabularyDb ────────────────────────────────────────────────────

export class VocabularyDb {
  private db: DatabaseType | null = null;

  constructor() {
    const dbPath = this.resolveDbPath();
    if (!dbPath) {
      console.error("Vocabulary DB not found — vocabulary search disabled");
      return;
    }

    try {
      this.db = new Database(dbPath, { readonly: true });
      this.db.pragma("journal_mode = WAL");
      const count = (this.db.prepare("SELECT COUNT(*) as n FROM artworks").get() as { n: number }).n;
      console.error(`Vocabulary DB loaded: ${dbPath} (${count.toLocaleString()} artworks)`);
    } catch (err) {
      console.error(`Failed to open vocabulary DB: ${err instanceof Error ? err.message : err}`);
      this.db = null;
    }
  }

  get available(): boolean {
    return this.db !== null;
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

      const typeClause = filter.vocabType ? ` AND v.type = '${filter.vocabType}'` : "";

      if (filter.matchMode === "exact-notation") {
        conditions.push(`a.object_number IN (
          SELECT m.object_number FROM mappings m
          JOIN vocabulary v ON m.vocab_id = v.id
          WHERE ${fieldClause}${typeClause} AND v.notation = ?
        )`);
        bindings.push(value);
      } else {
        conditions.push(`a.object_number IN (
          SELECT m.object_number FROM mappings m
          JOIN vocabulary v ON m.vocab_id = v.id
          WHERE ${fieldClause}${typeClause}
            AND (v.label_en LIKE ? COLLATE NOCASE OR v.label_nl LIKE ? COLLATE NOCASE)
        )`);
        const pat = `%${value}%`;
        bindings.push(pat, pat);
      }
    }

    if (conditions.length === 0) {
      return { totalResults: 0, results: [], source: "vocabulary" };
    }

    const where = conditions.join(" AND ");
    const limit = Math.min(params.maxResults ?? 25, 25);

    const countSql = `SELECT COUNT(*) as n FROM artworks a WHERE ${where}`;
    const totalResults = (this.db.prepare(countSql).get(...bindings) as { n: number }).n;

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
    const rows = this.db.prepare(
      `SELECT v.id AS uri FROM vocabulary v
       JOIN mappings m ON m.vocab_id = v.id
       GROUP BY v.id ORDER BY COUNT(*) DESC LIMIT ?`
    ).all(limit) as { uri: string }[];
    return rows.map((r) => r.uri);
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
