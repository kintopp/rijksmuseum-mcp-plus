import Database, { type Database as DatabaseType, type Statement } from "better-sqlite3";
import { escapeFts5, resolveDbPath } from "../utils/db.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface IconclassEntry {
  notation: string;
  text: string;
  path: { notation: string; text: string }[];
  children: string[];
  refs: string[];
  rijksCount: number;
  keywords: string[];
}

export interface IconclassSearchResult {
  query: string;
  totalResults: number;
  results: IconclassEntry[];
  countsAsOf: string | null;
}

export interface IconclassBrowseResult {
  notation: string;
  entry: IconclassEntry;
  subtree: IconclassEntry[];
  countsAsOf: string | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────

/** Build a deduplicated language fallback list: requested → en → nl. */
function langFallbacks(lang: string): string[] {
  const langs = [lang];
  if (lang !== "en") langs.push("en");
  if (lang !== "nl") langs.push("nl");
  return langs;
}

// ─── IconclassDb ─────────────────────────────────────────────────────

export class IconclassDb {
  private db: DatabaseType | null = null;
  private _countsAsOf: string | null = null;

  // Cached prepared statements (initialized after db opens)
  private stmtTextFts!: Statement;
  private stmtKwFts!: Statement;
  private stmtGetNotation!: Statement;
  private stmtGetText!: Statement;
  private stmtGetTextAny!: Statement;
  private stmtGetKeywords!: Statement;
  private stmtGetKeywordsAny!: Statement;

  constructor() {
    const dbPath = resolveDbPath("ICONCLASS_DB_PATH", "iconclass.db");
    if (!dbPath) {
      console.error("Iconclass DB not found — lookup_iconclass disabled");
      return;
    }

    try {
      this.db = new Database(dbPath, { readonly: true });
      const count = (this.db.prepare("SELECT COUNT(*) as n FROM notations").get() as { n: number }).n;

      // Read built_at for countsAsOf
      try {
        const row = this.db.prepare("SELECT value FROM version_info WHERE key = 'built_at'").get() as { value: string } | undefined;
        if (row) {
          // Extract date portion from ISO 8601 timestamp
          this._countsAsOf = row.value.slice(0, 10);
        }
      } catch { /* version_info table may not exist */ }

      // Cache all prepared statements
      this.stmtTextFts = this.db.prepare(
        `SELECT DISTINCT t.notation, n.rijks_count
         FROM texts t
         JOIN notations n ON t.notation = n.notation
         WHERE t.rowid IN (SELECT rowid FROM texts_fts WHERE texts_fts MATCH ?)`
      );
      this.stmtKwFts = this.db.prepare(
        `SELECT DISTINCT k.notation, n.rijks_count
         FROM keywords k
         JOIN notations n ON k.notation = n.notation
         WHERE k.rowid IN (SELECT rowid FROM keywords_fts WHERE keywords_fts MATCH ?)`
      );
      this.stmtGetNotation = this.db.prepare(
        "SELECT notation, path, children, refs, rijks_count FROM notations WHERE notation = ?"
      );
      this.stmtGetText = this.db.prepare(
        "SELECT text FROM texts WHERE notation = ? AND lang = ? LIMIT 1"
      );
      this.stmtGetTextAny = this.db.prepare(
        "SELECT text FROM texts WHERE notation = ? LIMIT 1"
      );
      this.stmtGetKeywords = this.db.prepare(
        "SELECT keyword FROM keywords WHERE notation = ? AND lang = ? LIMIT 20"
      );
      this.stmtGetKeywordsAny = this.db.prepare(
        "SELECT keyword FROM keywords WHERE notation = ? LIMIT 20"
      );

      console.error(`Iconclass DB loaded: ${dbPath} (${count.toLocaleString()} notations)`);
    } catch (err) {
      console.error(`Failed to open Iconclass DB: ${err instanceof Error ? err.message : err}`);
      this.db = null;
    }
  }

  get available(): boolean {
    return this.db !== null;
  }

  get countsAsOf(): string | null {
    return this._countsAsOf;
  }

  /**
   * Search Iconclass notations by text query.
   * FTS5 UNION across texts + keywords (with JOIN for rijks_count),
   * deduplicated, ordered by rijks_count DESC.
   */
  search(query: string, maxResults: number = 25, lang: string = "en"): IconclassSearchResult {
    const emptyResult = (): IconclassSearchResult => ({
      query, totalResults: 0, results: [], countsAsOf: this._countsAsOf,
    });

    if (!this.db) return emptyResult();

    const ftsPhrase = escapeFts5(query);
    if (!ftsPhrase) return emptyResult();

    // Find matching notations from texts and keywords FTS indexes (with rijks_count via JOIN)
    const textHits = this.stmtTextFts.all(ftsPhrase) as { notation: string; rijks_count: number }[];
    const kwHits = this.stmtKwFts.all(ftsPhrase) as { notation: string; rijks_count: number }[];

    // Deduplicate (rijks_count is identical for a notation from either source)
    const countMap = new Map<string, number>();
    for (const r of textHits) countMap.set(r.notation, r.rijks_count);
    for (const r of kwHits) {
      if (!countMap.has(r.notation)) countMap.set(r.notation, r.rijks_count);
    }

    if (countMap.size === 0) return emptyResult();

    // Sort by rijks_count DESC, then notation ASC
    const sorted = [...countMap.entries()].sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    });

    const totalResults = sorted.length;
    const limited = sorted.slice(0, maxResults);

    // Resolve full entries
    const results = limited
      .map(([n]) => this.resolveEntry(n, lang))
      .filter((e): e is IconclassEntry => e !== null);

    return { query, totalResults, results, countsAsOf: this._countsAsOf };
  }

  /**
   * Browse an Iconclass notation: get entry + direct children subtree.
   */
  browse(notation: string, lang: string = "en"): IconclassBrowseResult | null {
    if (!this.db) return null;

    const entry = this.resolveEntry(notation, lang);
    if (!entry) return null;

    // Resolve direct children
    const subtree = entry.children
      .map((n) => this.resolveEntry(n, lang))
      .filter((e): e is IconclassEntry => e !== null);

    return { notation, entry, subtree, countsAsOf: this._countsAsOf };
  }

  /** Resolve a notation to a full IconclassEntry. */
  private resolveEntry(notation: string, lang: string): IconclassEntry | null {
    if (!this.db) return null;

    const row = this.stmtGetNotation.get(notation) as {
      notation: string; path: string; children: string; refs: string; rijks_count: number;
    } | undefined;

    if (!row) return null;

    const pathNotations: string[] = JSON.parse(row.path);
    const children: string[] = JSON.parse(row.children);
    const refs: string[] = JSON.parse(row.refs);

    // Resolve path labels
    const pathEntries = pathNotations.map((n) => ({
      notation: n,
      text: this.getText(n, lang) ?? n,
    }));

    return {
      notation: row.notation,
      text: this.getText(row.notation, lang) ?? row.notation,
      path: pathEntries,
      children,
      refs,
      rijksCount: row.rijks_count,
      keywords: this.getKeywords(row.notation, lang),
    };
  }

  /** Get text label for a notation in preferred language (requested -> en -> nl -> any). */
  private getText(notation: string, lang: string): string | null {
    if (!this.db) return null;

    for (const l of langFallbacks(lang)) {
      const row = this.stmtGetText.get(notation, l) as { text: string } | undefined;
      if (row) return row.text;
    }

    // Final fallback: any language
    const any = this.stmtGetTextAny.get(notation) as { text: string } | undefined;
    return any?.text ?? null;
  }

  /** Get keywords for a notation in preferred language (requested -> en -> nl -> any). */
  private getKeywords(notation: string, lang: string): string[] {
    if (!this.db) return [];

    for (const l of langFallbacks(lang)) {
      const rows = this.stmtGetKeywords.all(notation, l) as { keyword: string }[];
      if (rows.length > 0) return rows.map((r) => r.keyword);
    }

    // Final fallback: any language
    const any = this.stmtGetKeywordsAny.all(notation) as { keyword: string }[];
    return any.map((r) => r.keyword);
  }

}
