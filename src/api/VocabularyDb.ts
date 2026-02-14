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

    // Each vocabulary param produces a subquery: the artwork must have a mapping
    // to a vocabulary term matching the criterion for that field.

    if (params.iconclass) {
      conditions.push(`a.object_number IN (
        SELECT m.object_number FROM mappings m
        JOIN vocabulary v ON m.vocab_id = v.id
        WHERE m.field = 'subject' AND v.notation = ?
      )`);
      bindings.push(params.iconclass);
    }

    if (params.subject) {
      conditions.push(`a.object_number IN (
        SELECT m.object_number FROM mappings m
        JOIN vocabulary v ON m.vocab_id = v.id
        WHERE m.field = 'subject'
          AND (v.label_en LIKE ? COLLATE NOCASE OR v.label_nl LIKE ? COLLATE NOCASE)
      )`);
      const pat = `%${params.subject}%`;
      bindings.push(pat, pat);
    }

    if (params.depictedPerson) {
      conditions.push(`a.object_number IN (
        SELECT m.object_number FROM mappings m
        JOIN vocabulary v ON m.vocab_id = v.id
        WHERE m.field = 'subject' AND v.type = 'person'
          AND (v.label_en LIKE ? COLLATE NOCASE OR v.label_nl LIKE ? COLLATE NOCASE)
      )`);
      const pat = `%${params.depictedPerson}%`;
      bindings.push(pat, pat);
    }

    if (params.depictedPlace) {
      conditions.push(`a.object_number IN (
        SELECT m.object_number FROM mappings m
        JOIN vocabulary v ON m.vocab_id = v.id
        WHERE m.field IN ('subject', 'spatial') AND v.type = 'place'
          AND (v.label_en LIKE ? COLLATE NOCASE OR v.label_nl LIKE ? COLLATE NOCASE)
      )`);
      const pat = `%${params.depictedPlace}%`;
      bindings.push(pat, pat);
    }

    if (params.productionPlace) {
      conditions.push(`a.object_number IN (
        SELECT m.object_number FROM mappings m
        JOIN vocabulary v ON m.vocab_id = v.id
        WHERE m.field = 'spatial' AND v.type = 'place'
          AND (v.label_en LIKE ? COLLATE NOCASE OR v.label_nl LIKE ? COLLATE NOCASE)
      )`);
      const pat = `%${params.productionPlace}%`;
      bindings.push(pat, pat);
    }

    if (params.birthPlace) {
      conditions.push(`a.object_number IN (
        SELECT m.object_number FROM mappings m
        JOIN vocabulary v ON m.vocab_id = v.id
        WHERE m.field = 'birth_place' AND v.type = 'place'
          AND (v.label_en LIKE ? COLLATE NOCASE OR v.label_nl LIKE ? COLLATE NOCASE)
      )`);
      const pat = `%${params.birthPlace}%`;
      bindings.push(pat, pat);
    }

    if (params.deathPlace) {
      conditions.push(`a.object_number IN (
        SELECT m.object_number FROM mappings m
        JOIN vocabulary v ON m.vocab_id = v.id
        WHERE m.field = 'death_place' AND v.type = 'place'
          AND (v.label_en LIKE ? COLLATE NOCASE OR v.label_nl LIKE ? COLLATE NOCASE)
      )`);
      const pat = `%${params.deathPlace}%`;
      bindings.push(pat, pat);
    }

    if (params.profession) {
      conditions.push(`a.object_number IN (
        SELECT m.object_number FROM mappings m
        JOIN vocabulary v ON m.vocab_id = v.id
        WHERE m.field = 'profession' AND v.type = 'classification'
          AND (v.label_en LIKE ? COLLATE NOCASE OR v.label_nl LIKE ? COLLATE NOCASE)
      )`);
      const pat = `%${params.profession}%`;
      bindings.push(pat, pat);
    }

    if (params.material) {
      conditions.push(`a.object_number IN (
        SELECT m.object_number FROM mappings m
        JOIN vocabulary v ON m.vocab_id = v.id
        WHERE m.field = 'material'
          AND (v.label_en LIKE ? COLLATE NOCASE OR v.label_nl LIKE ? COLLATE NOCASE)
      )`);
      const pat = `%${params.material}%`;
      bindings.push(pat, pat);
    }

    if (params.technique) {
      conditions.push(`a.object_number IN (
        SELECT m.object_number FROM mappings m
        JOIN vocabulary v ON m.vocab_id = v.id
        WHERE m.field = 'technique'
          AND (v.label_en LIKE ? COLLATE NOCASE OR v.label_nl LIKE ? COLLATE NOCASE)
      )`);
      const pat = `%${params.technique}%`;
      bindings.push(pat, pat);
    }

    if (params.type) {
      conditions.push(`a.object_number IN (
        SELECT m.object_number FROM mappings m
        JOIN vocabulary v ON m.vocab_id = v.id
        WHERE m.field = 'type'
          AND (v.label_en LIKE ? COLLATE NOCASE OR v.label_nl LIKE ? COLLATE NOCASE)
      )`);
      const pat = `%${params.type}%`;
      bindings.push(pat, pat);
    }

    if (params.creator) {
      conditions.push(`a.object_number IN (
        SELECT m.object_number FROM mappings m
        JOIN vocabulary v ON m.vocab_id = v.id
        WHERE m.field = 'creator'
          AND (v.label_en LIKE ? COLLATE NOCASE OR v.label_nl LIKE ? COLLATE NOCASE)
      )`);
      const pat = `%${params.creator}%`;
      bindings.push(pat, pat);
    }

    if (conditions.length === 0) {
      return { totalResults: 0, results: [], source: "vocabulary" };
    }

    const where = conditions.join(" AND ");
    const limit = Math.min(params.maxResults ?? 25, 25);

    // Count total
    const countSql = `SELECT COUNT(*) as n FROM artworks a WHERE ${where}`;
    const totalResults = (this.db.prepare(countSql).get(...bindings) as { n: number }).n;

    // Fetch results
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
