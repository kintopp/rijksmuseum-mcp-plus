import Database, { type Database as DatabaseType } from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

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

/** Escape a value for safe FTS5 phrase matching. */
function escapeFts5(value: string): string {
  return `"${value.replace(/[*^():]/g, "").replace(/"/g, '""')}"`;
}

// ─── IconclassDb ─────────────────────────────────────────────────────

export class IconclassDb {
  private db: DatabaseType | null = null;
  private _countsAsOf: string | null = null;

  constructor() {
    const dbPath = this.resolveDbPath();
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
   * FTS5 UNION across texts + keywords, deduplicated, ordered by rijks_count DESC.
   */
  search(query: string, maxResults: number = 25, lang: string = "en"): IconclassSearchResult {
    if (!this.db) {
      return { query, totalResults: 0, results: [], countsAsOf: this._countsAsOf };
    }

    const ftsPhrase = escapeFts5(query);

    // Find matching notations from texts and keywords FTS indexes
    const textHits = this.db.prepare(
      `SELECT DISTINCT t.notation FROM texts t
       WHERE t.rowid IN (SELECT rowid FROM texts_fts WHERE texts_fts MATCH ?)`
    ).all(ftsPhrase) as { notation: string }[];

    const kwHits = this.db.prepare(
      `SELECT DISTINCT k.notation FROM keywords k
       WHERE k.rowid IN (SELECT rowid FROM keywords_fts WHERE keywords_fts MATCH ?)`
    ).all(ftsPhrase) as { notation: string }[];

    // Deduplicate
    const notationSet = new Set<string>();
    for (const r of textHits) notationSet.add(r.notation);
    for (const r of kwHits) notationSet.add(r.notation);

    if (notationSet.size === 0) {
      return { query, totalResults: 0, results: [], countsAsOf: this._countsAsOf };
    }

    // Get rijks_count for sorting
    const notations = [...notationSet];
    const placeholders = notations.map(() => "?").join(", ");
    const countRows = this.db.prepare(
      `SELECT notation, rijks_count FROM notations WHERE notation IN (${placeholders})`
    ).all(...notations) as { notation: string; rijks_count: number }[];

    const countMap = new Map<string, number>();
    for (const r of countRows) countMap.set(r.notation, r.rijks_count);

    // Sort by rijks_count DESC, then notation ASC
    const sorted = notations.sort((a, b) => {
      const ca = countMap.get(a) ?? 0;
      const cb = countMap.get(b) ?? 0;
      if (cb !== ca) return cb - ca;
      return a.localeCompare(b);
    });

    const totalResults = sorted.length;
    const limited = sorted.slice(0, maxResults);

    // Resolve full entries
    const results = limited
      .map((n) => this.resolveEntry(n, lang))
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

    const row = this.db.prepare(
      "SELECT notation, path, children, refs, rijks_count FROM notations WHERE notation = ?"
    ).get(notation) as {
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

  /** Get text label for a notation in preferred language (requested → en → nl → any). */
  private getText(notation: string, lang: string): string | null {
    if (!this.db) return null;

    // Try requested language
    const row = this.db.prepare(
      "SELECT text FROM texts WHERE notation = ? AND lang = ? LIMIT 1"
    ).get(notation, lang) as { text: string } | undefined;
    if (row) return row.text;

    // Fallback: en → nl → any
    for (const fallback of ["en", "nl"]) {
      if (fallback === lang) continue;
      const fb = this.db.prepare(
        "SELECT text FROM texts WHERE notation = ? AND lang = ? LIMIT 1"
      ).get(notation, fallback) as { text: string } | undefined;
      if (fb) return fb.text;
    }

    // Any language
    const any = this.db.prepare(
      "SELECT text FROM texts WHERE notation = ? LIMIT 1"
    ).get(notation) as { text: string } | undefined;
    return any?.text ?? null;
  }

  /** Get keywords for a notation in preferred language. */
  private getKeywords(notation: string, lang: string): string[] {
    if (!this.db) return [];

    // Try requested language
    let rows = this.db.prepare(
      "SELECT keyword FROM keywords WHERE notation = ? AND lang = ?"
    ).all(notation, lang) as { keyword: string }[];

    if (rows.length > 0) return rows.map((r) => r.keyword);

    // Fallback: en → nl
    for (const fallback of ["en", "nl"]) {
      if (fallback === lang) continue;
      rows = this.db.prepare(
        "SELECT keyword FROM keywords WHERE notation = ? AND lang = ?"
      ).all(notation, fallback) as { keyword: string }[];
      if (rows.length > 0) return rows.map((r) => r.keyword);
    }

    return [];
  }

  private resolveDbPath(): string | null {
    const envPath = process.env.ICONCLASS_DB_PATH;
    if (envPath && fs.existsSync(envPath)) return envPath;

    const defaultPath = path.join(process.cwd(), "data", "iconclass.db");
    if (fs.existsSync(defaultPath)) return defaultPath;

    return null;
  }
}
