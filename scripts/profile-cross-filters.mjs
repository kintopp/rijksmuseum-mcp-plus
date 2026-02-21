#!/usr/bin/env node
/**
 * profile-cross-filters.mjs — Profile cross-filter vocab query performance
 *
 * Runs representative multi-filter combinations against the local vocabulary DB
 * and reports timing, intermediate cardinalities, and EXPLAIN QUERY PLAN output.
 *
 * Usage:
 *   node scripts/profile-cross-filters.mjs [--db PATH] [--output PATH] [--mmap SIZE] [--no-warmup] [--label TEXT]
 *
 * Options:
 *   --db         data/vocabulary.db
 *   --output     offline/explorations/cross-filter-profiling.md
 *   --mmap SIZE  Set PRAGMA mmap_size (bytes). e.g. 3221225472 for 3GB
 *   --no-warmup  Skip the initial warm-up query (for true cold-start measurement)
 *   --label TEXT  Label for this run (printed in header)
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");

// ─── CLI args ────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    db: resolve(PROJECT_ROOT, "data/vocabulary.db"),
    output: resolve(PROJECT_ROOT, "offline/explorations/cross-filter-profiling.md"),
    mmap: null,     // null = don't set; number = PRAGMA mmap_size value in bytes
    warmup: true,   // run warm-up query before profiling
    label: null,    // optional run label
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--db" && args[i + 1]) opts.db = resolve(args[++i]);
    if (args[i] === "--output" && args[i + 1]) opts.output = resolve(args[++i]);
    if (args[i] === "--mmap" && args[i + 1]) opts.mmap = parseInt(args[++i], 10);
    if (args[i] === "--no-warmup") opts.warmup = false;
    if (args[i] === "--label" && args[i + 1]) opts.label = args[++i];
  }
  return opts;
}

// ─── FTS5 helper (mirrors src/utils/db.ts) ───────────────────────────

function escapeFts5(value) {
  const cleaned = value.replace(/[*^():{}[\]\\]/g, "").replace(/"/g, '""').trim();
  if (!cleaned) return null;
  return `"${cleaned}"`;
}

// ─── Date filter parser (mirrors VocabularyDb.ts) ────────────────────

function parseDateFilter(creationDate) {
  const trimmed = creationDate.trim();
  if (!trimmed) return null;
  if (trimmed.endsWith("*")) {
    const prefix = trimmed.slice(0, -1);
    if (!prefix || !/^-?\d+$/.test(prefix)) return null;
    const isNegative = prefix.startsWith("-");
    const magnitude = isNegative ? prefix.slice(1) : prefix;
    if (!magnitude) return null;
    const wildcardDigits = 4 - magnitude.length;
    if (wildcardDigits <= 0) return null;
    const multiplier = 10 ** wildcardDigits;
    const magNum = parseInt(magnitude, 10);
    const posEarliest = magNum * multiplier;
    const posLatest = posEarliest + multiplier - 1;
    if (isNegative) return { earliest: -posLatest, latest: -posEarliest };
    return { earliest: posEarliest, latest: posLatest };
  }
  const year = parseInt(trimmed, 10);
  if (isNaN(year)) return null;
  return { earliest: year, latest: year };
}

// ─── Filter definitions (mirrors VOCAB_FILTERS) ─────────────────────

const VOCAB_FILTERS = {
  subject:        { fields: ["subject"],            matchMode: "like-word", fts: true },
  iconclass:      { fields: ["subject"],            matchMode: "exact-notation" },
  depictedPerson: { fields: ["subject"],            matchMode: "like", vocabType: "person", fts: true },
  depictedPlace:  { fields: ["subject", "spatial"], matchMode: "like", vocabType: "place", fts: true },
  productionPlace:{ fields: ["spatial"],            matchMode: "like", vocabType: "place", fts: true },
  birthPlace:     { fields: ["birth_place"],        matchMode: "like", vocabType: "place", fts: true },
  deathPlace:     { fields: ["death_place"],        matchMode: "like", vocabType: "place", fts: true },
  profession:     { fields: ["profession"],         matchMode: "like", vocabType: "classification", fts: true },
  material:       { fields: ["material"],           matchMode: "like", fts: true },
  technique:      { fields: ["technique"],          matchMode: "like", fts: true },
  type:           { fields: ["type"],               matchMode: "like", fts: true },
  creator:        { fields: ["creator"],            matchMode: "like", fts: true },
  collectionSet:  { fields: ["collection_set"],     matchMode: "like", vocabType: "set", fts: true },
  productionRole: { fields: ["production_role"],    matchMode: "like", fts: true },
};

// Text FTS filters (narrative, creditLine, inscription, provenance)
const TEXT_FILTERS = {
  narrative:   "narrative_text",
  creditLine:  "credit_line",
  inscription: "inscription_text",
  provenance:  "provenance_text",
};

// ─── Query matrix ────────────────────────────────────────────────────

const QUERIES = [
  // 2-filter combinations (known Railway timings in comments)
  { label: "narrative + type",              filters: { narrative: "night watch", type: "painting" },           railwayMs: 102000 },
  { label: "productionPlace + technique",   filters: { productionPlace: "Delft", technique: "etching" },      railwayMs: 9000 },
  { label: "creditLine + type",             filters: { creditLine: "Drucker", type: "painting" },             railwayMs: 20000 },
  { label: "subject + creationDate",        filters: { subject: "cat", creationDate: "17*" },                 railwayMs: 2000 },
  { label: "iconclass + productionPlace",   filters: { iconclass: "34B11", productionPlace: "Amsterdam" },    railwayMs: null },
  { label: "subject + material",            filters: { subject: "ship", material: "canvas" },                 railwayMs: null },
  { label: "subject + productionPlace",     filters: { subject: "landscape", productionPlace: "Haarlem" },    railwayMs: null },
  { label: "technique + creationDate",      filters: { technique: "oil painting", creationDate: "164*" },     railwayMs: null },
  { label: "narrative + material",          filters: { narrative: "Rembrandt", material: "paper" },           railwayMs: null },
  { label: "type + creator",               filters: { type: "painting", creator: "Rembrandt" },              railwayMs: null },

  // 3-filter combinations
  { label: "iconclass + prodPlace + date",  filters: { iconclass: "34B11", productionPlace: "Amsterdam", creationDate: "17*" }, railwayMs: null },
  { label: "subject + technique + date",    filters: { subject: "portrait", technique: "etching", creationDate: "16*" },        railwayMs: null },
  { label: "type + material + prodPlace",   filters: { type: "print", material: "paper", productionPlace: "Amsterdam" },        railwayMs: null },
];

// ─── Profiler ────────────────────────────────────────────────────────

class CrossFilterProfiler {
  constructor(dbPath, { mmap = null } = {}) {
    if (!existsSync(dbPath)) {
      throw new Error(`DB not found: ${dbPath}`);
    }
    this.db = new Database(dbPath, { readonly: true });
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("cache_size = -256000"); // 256MB cache — match production-like conditions

    if (mmap != null) {
      const result = this.db.pragma(`mmap_size = ${mmap}`);
      console.log(`PRAGMA mmap_size = ${mmap} (${(mmap / 1024 / 1024 / 1024).toFixed(1)} GB) → ${JSON.stringify(result)}`);
    }

    // Check capabilities
    this.hasFts5 = this._tableExists("vocabulary_fts");
    this.hasTextFts = this._tableExists("artwork_texts_fts");
    console.log(`DB opened: FTS5=${this.hasFts5}, TextFTS=${this.hasTextFts}, mmap=${mmap ?? "off"}`);

    // Log DB stats
    const artworkCount = this.db.prepare("SELECT COUNT(*) as n FROM artworks").get().n;
    const mappingCount = this.db.prepare("SELECT COUNT(*) as n FROM mappings").get().n;
    const vocabCount = this.db.prepare("SELECT COUNT(*) as n FROM vocabulary").get().n;
    console.log(`Artworks: ${artworkCount.toLocaleString()}, Mappings: ${mappingCount.toLocaleString()}, Vocab: ${vocabCount.toLocaleString()}\n`);
  }

  _tableExists(name) {
    const row = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    return row !== undefined;
  }

  /**
   * Resolve a filter value to vocab IDs (FTS5 path).
   * Returns { ids, timeMs }.
   */
  resolveVocabIds(filterName, value) {
    const filter = VOCAB_FILTERS[filterName];
    if (!filter) throw new Error(`Unknown filter: ${filterName}`);

    const start = performance.now();
    let ids;

    if (filter.matchMode === "exact-notation") {
      // Iconclass — look up by notation
      const rows = this.db.prepare("SELECT id FROM vocabulary WHERE notation = ?").all(value);
      ids = rows.map(r => r.id);
    } else if (this.hasFts5 && filter.fts) {
      const ftsPhrase = escapeFts5(String(value));
      if (!ftsPhrase) return { ids: [], timeMs: performance.now() - start };
      const typeClause = filter.vocabType ? " AND type = ?" : "";
      const typeBindings = filter.vocabType ? [filter.vocabType] : [];
      const rows = this.db.prepare(
        `SELECT id FROM vocabulary WHERE rowid IN (SELECT rowid FROM vocabulary_fts WHERE vocabulary_fts MATCH ?)${typeClause}`
      ).all(ftsPhrase, ...typeBindings);
      ids = rows.map(r => r.id);
    } else {
      // LIKE fallback
      const typeClause = filter.vocabType ? " AND type = ?" : "";
      const typeBindings = filter.vocabType ? [filter.vocabType] : [];
      const rows = this.db.prepare(
        `SELECT id FROM vocabulary WHERE (label_en LIKE ? COLLATE NOCASE OR label_nl LIKE ? COLLATE NOCASE)${typeClause}`
      ).all(`%${value}%`, `%${value}%`, ...typeBindings);
      ids = rows.map(r => r.id);
    }

    return { ids, timeMs: performance.now() - start };
  }

  /**
   * Count distinct object_numbers for a single vocab-based subquery.
   */
  subqueryCardinality(filterName, vocabIds) {
    const filter = VOCAB_FILTERS[filterName];
    const placeholders = vocabIds.map(() => "?").join(", ");
    const fieldClause = filter.fields.length === 1
      ? "m.field = ?"
      : `m.field IN (${filter.fields.map(() => "?").join(", ")})`;

    const start = performance.now();
    const row = this.db.prepare(
      `SELECT COUNT(DISTINCT m.object_number) as n FROM mappings m WHERE ${fieldClause} AND m.vocab_id IN (${placeholders})`
    ).get(...filter.fields, ...vocabIds);
    return { count: row.n, timeMs: performance.now() - start };
  }

  /**
   * Count distinct object_numbers for a text FTS subquery.
   */
  textFtsCardinality(column, value) {
    const ftsPhrase = escapeFts5(value);
    if (!ftsPhrase) return { count: 0, timeMs: 0 };
    const start = performance.now();
    const row = this.db.prepare(
      `SELECT COUNT(*) as n FROM artwork_texts_fts WHERE ${column} MATCH ?`
    ).get(ftsPhrase);
    return { count: row.n, timeMs: performance.now() - start };
  }

  /**
   * Count artworks matching a creationDate range.
   */
  dateCardinality(creationDate) {
    const range = parseDateFilter(creationDate);
    if (!range) return { count: 0, timeMs: 0 };
    const start = performance.now();
    const row = this.db.prepare(
      "SELECT COUNT(*) as n FROM artworks WHERE date_earliest IS NOT NULL AND date_latest >= ? AND date_earliest <= ?"
    ).get(range.earliest, range.latest);
    return { count: row.n, timeMs: performance.now() - start };
  }

  /**
   * Build and execute the full cross-filter query (mirrors VocabularyDb.search).
   * Returns { resultCount, timeMs, sql, bindings }.
   */
  runFullQuery(filters) {
    const conditions = [];
    const bindings = [];
    const subqueryDetails = []; // for reporting

    // Vocab-based filters
    for (const [name, value] of Object.entries(filters)) {
      if (name === "creationDate") continue; // handled separately
      if (TEXT_FILTERS[name]) continue;       // handled separately

      const filter = VOCAB_FILTERS[name];
      if (!filter) continue;

      const { ids, timeMs: resolveMs } = this.resolveVocabIds(name, value);
      if (ids.length === 0) {
        subqueryDetails.push({ name, value, vocabIds: 0, cardinality: 0, resolveMs, cardMs: 0 });
        return { resultCount: 0, timeMs: 0, sql: "(empty — 0 vocab IDs)", bindings: [], subqueryDetails };
      }

      const { count, timeMs: cardMs } = this.subqueryCardinality(name, ids);
      subqueryDetails.push({ name, value, vocabIds: ids.length, cardinality: count, resolveMs, cardMs });

      const placeholders = ids.map(() => "?").join(", ");
      const fieldClause = filter.fields.length === 1
        ? "m.field = ?"
        : `m.field IN (${filter.fields.map(() => "?").join(", ")})`;

      conditions.push(`a.object_number IN (
        SELECT m.object_number FROM mappings m
        WHERE ${fieldClause} AND m.vocab_id IN (${placeholders})
      )`);
      bindings.push(...filter.fields, ...ids);
    }

    // Text FTS filters
    for (const [name, column] of Object.entries(TEXT_FILTERS)) {
      const value = filters[name];
      if (!value) continue;

      const ftsPhrase = escapeFts5(value);
      if (!ftsPhrase) continue;

      const { count, timeMs: cardMs } = this.textFtsCardinality(column, value);
      subqueryDetails.push({ name, value, vocabIds: "FTS", cardinality: count, resolveMs: 0, cardMs });

      conditions.push(`a.rowid IN (SELECT rowid FROM artwork_texts_fts WHERE ${column} MATCH ?)`);
      bindings.push(ftsPhrase);
    }

    // Date filter
    if (filters.creationDate) {
      const range = parseDateFilter(filters.creationDate);
      if (range) {
        const { count, timeMs: cardMs } = this.dateCardinality(filters.creationDate);
        subqueryDetails.push({ name: "creationDate", value: filters.creationDate, vocabIds: "—", cardinality: count, resolveMs: 0, cardMs });

        conditions.push("a.date_earliest IS NOT NULL AND a.date_latest >= ? AND a.date_earliest <= ?");
        bindings.push(range.earliest, range.latest);
      }
    }

    if (conditions.length === 0) {
      return { resultCount: 0, timeMs: 0, sql: "(no conditions)", bindings: [], subqueryDetails };
    }

    const where = conditions.join(" AND ");
    const sql = `SELECT a.object_number, a.title, a.creator_label, a.date_earliest, a.date_latest FROM artworks a WHERE ${where} LIMIT 25`;

    // Run the full query
    const start = performance.now();
    const rows = this.db.prepare(sql).all(...bindings);
    const timeMs = performance.now() - start;

    return { resultCount: rows.length, timeMs, sql, bindings, subqueryDetails };
  }

  /**
   * Get EXPLAIN QUERY PLAN output for the full query.
   */
  explainQuery(sql, bindings) {
    try {
      const rows = this.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...bindings);
      return rows.map(r => `  ${"  ".repeat(r.selectid || 0)}${r.detail}`).join("\n");
    } catch (e) {
      return `  (EXPLAIN failed: ${e.message})`;
    }
  }

  /**
   * Profile a single query combination.
   */
  profileQuery(query) {
    console.log(`  Running: ${query.label} ...`);
    const result = this.runFullQuery(query.filters);

    // Get EXPLAIN for the actual query
    let explain = "";
    if (result.sql && !result.sql.startsWith("(")) {
      explain = this.explainQuery(result.sql, result.bindings);
    }

    return { ...result, explain };
  }

  close() {
    this.db.close();
  }
}

// ─── Report generation ───────────────────────────────────────────────

function formatMs(ms) {
  if (ms < 1) return "<1ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function generateReport(results) {
  const lines = [];
  lines.push("# Cross-Filter Vocab Query Profiling");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");

  // Summary table
  lines.push("## Summary");
  lines.push("");
  lines.push("| # | Query | Filters | Sub1 (card) | Sub2 (card) | Sub3 (card) | Results | Query Time | Railway |");
  lines.push("|---|-------|---------|-------------|-------------|-------------|---------|------------|---------|");

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const subs = r.subqueryDetails.map(s =>
      `${s.name}=${s.vocabIds === "FTS" || s.vocabIds === "—" ? s.vocabIds : s.vocabIds + " ids"} (${s.cardinality.toLocaleString()})`
    );
    const sub1 = subs[0] || "—";
    const sub2 = subs[1] || "—";
    const sub3 = subs[2] || "—";
    const railway = r.railwayMs ? formatMs(r.railwayMs) : "—";
    lines.push(`| ${i + 1} | ${r.label} | ${r.filterCount} | ${sub1} | ${sub2} | ${sub3} | ${r.resultCount} | **${formatMs(r.timeMs)}** | ${railway} |`);
  }

  // Detailed per-query sections
  lines.push("");
  lines.push("## Detailed Results");

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    lines.push("");
    lines.push(`### ${i + 1}. ${r.label}`);
    lines.push("");
    lines.push(`**Filters:** ${JSON.stringify(r.filters)}`);
    lines.push(`**Full query time:** ${formatMs(r.timeMs)} → ${r.resultCount} results`);
    lines.push("");

    // Subquery breakdown
    lines.push("**Subquery breakdown:**");
    lines.push("");
    lines.push("| Filter | Value | Vocab IDs | Resolve Time | Cardinality | Card Time |");
    lines.push("|--------|-------|-----------|-------------|-------------|-----------|");
    for (const s of r.subqueryDetails) {
      lines.push(`| ${s.name} | ${s.value} | ${s.vocabIds} | ${formatMs(s.resolveMs)} | ${s.cardinality.toLocaleString()} | ${formatMs(s.cardMs)} |`);
    }

    // EXPLAIN
    if (r.explain) {
      lines.push("");
      lines.push("**EXPLAIN QUERY PLAN:**");
      lines.push("```");
      lines.push(r.explain);
      lines.push("```");
    }
  }

  // Analysis section (placeholder)
  lines.push("");
  lines.push("## Analysis");
  lines.push("");

  // Sort by time to find patterns
  const sorted = [...results].sort((a, b) => b.timeMs - a.timeMs);
  lines.push("**Slowest to fastest:**");
  lines.push("");
  for (const r of sorted) {
    const maxCard = Math.max(...r.subqueryDetails.map(s => s.cardinality));
    const minCard = Math.min(...r.subqueryDetails.map(s => s.cardinality));
    lines.push(`- ${formatMs(r.timeMs)} — ${r.label} (max cardinality: ${maxCard.toLocaleString()}, min: ${minCard.toLocaleString()}, ratio: ${minCard > 0 ? (maxCard / minCard).toFixed(1) : "∞"})`);
  }

  lines.push("");
  lines.push("**Key observations:**");
  lines.push("");
  lines.push("<!-- Fill in after reviewing results -->");
  lines.push("");

  return lines.join("\n");
}

// ─── Main ────────────────────────────────────────────────────────────

const opts = parseArgs();
console.log("Cross-Filter Vocab Query Profiler");
console.log("=================================");
if (opts.label) console.log(`Label: ${opts.label}`);
console.log(`DB: ${opts.db}`);
console.log(`Output: ${opts.output}`);
console.log(`mmap: ${opts.mmap != null ? `${opts.mmap} (${(opts.mmap / 1024 / 1024 / 1024).toFixed(1)} GB)` : "off"}`);
console.log(`Warm-up: ${opts.warmup ? "yes" : "no"}`);
console.log("");

const profiler = new CrossFilterProfiler(opts.db, { mmap: opts.mmap });

if (opts.warmup) {
  console.log("Warming SQLite page cache...");
  profiler.db.prepare("SELECT COUNT(*) FROM mappings WHERE field = 'subject'").get();
  console.log("");
} else {
  console.log("Skipping warm-up query (--no-warmup).\n");
}

console.log("Profiling queries...");
const results = [];

for (const query of QUERIES) {
  const result = profiler.profileQuery(query);
  results.push({
    label: query.label,
    filters: query.filters,
    filterCount: Object.keys(query.filters).length,
    railwayMs: query.railwayMs,
    ...result,
  });
  console.log(`    → ${result.resultCount} results in ${formatMs(result.timeMs)}`);
}

profiler.close();

// Print summary to stdout
console.log("\n=== Summary ===\n");
console.log("| Query | Results | Time |");
console.log("|-------|---------|------|");
for (const r of results) {
  console.log(`| ${r.label} | ${r.resultCount} | ${formatMs(r.timeMs)} |`);
}

// Write full report
const report = generateReport(results);
const outputDir = dirname(opts.output);
if (!existsSync(outputDir)) {
  mkdirSync(outputDir, { recursive: true });
}
writeFileSync(opts.output, report + "\n");
console.log(`\nFull report written to: ${opts.output}`);
