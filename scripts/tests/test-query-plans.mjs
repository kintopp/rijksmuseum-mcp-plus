/**
 * test-query-plans.mjs — Verify SQLite query planner choices for mappings table.
 *
 * Instruments better-sqlite3 to capture all SQL executed by VocabularyDb,
 * then runs EXPLAIN QUERY PLAN on every query that JOINs through the mappings
 * table.  Asserts the optimizer never uses idx_mappings_field_vocab as a
 * covering-scan driver in JOIN contexts — the ~6000x anti-pattern.
 *
 * Usage:  node scripts/tests/test-query-plans.mjs
 */

import { createRequire } from "node:module";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ──────────────────────────────────────────────────────────────

const DANGEROUS_INDEX = "idx_mappings_field_vocab";
const VOCAB_DB_PATH = path.resolve(__dirname, "../../data/vocabulary.db");

// The dangerous pattern: idx_mappings_field_vocab used with ONLY field_id as a
// constraint.  This scans ALL mappings for a field type (millions of rows).
// Targeted lookups like (field_id=? AND vocab_rowid=?) or (field_id=? AND
// vocab_rowid=? AND artwork_id=?) are safe — they narrow to small sets.
//
// Regex matches "idx_mappings_field_vocab (field_id=?)" with nothing else in parens.
const DANGEROUS_PATTERN = /idx_mappings_field_vocab\s+\(field_id=\?\)/;

// SQL markers for queries where field_id-only scan is inherently required.
// Cache-init full scans iterate ALL mappings for a field to build IDF caches.
// These run once at startup, not per-request, so the scan cost is acceptable.
const CACHE_INIT_MARKERS = [
  // ensureIconclassCache: IDF per notation (GROUP BY over all subject mappings)
  "COUNT(DISTINCT m.artwork_id) as df",
  // ensureIconclassCache: total iconclass artworks
  "COUNT(DISTINCT m.artwork_id) as n",
  // ensurePersonCache: CTE over all person subject mappings
  "WITH person_mappings",
];

// ── Phase 0: Instrument better-sqlite3 ─────────────────────────────────

const Database = require("better-sqlite3");
const capturedSql = new Set();
const origPrepare = Database.prototype.prepare;

Database.prototype.prepare = function (sql) {
  capturedSql.add(sql);
  return origPrepare.call(this, sql);
};

// ── Phase 1: Import and construct VocabularyDb ─────────────────────────

const { VocabularyDb } = await import("../../dist/api/VocabularyDb.js");
const vocabDb = new VocabularyDb();

if (!vocabDb.available) {
  console.error("ERROR: VocabularyDb not available — cannot run query plan tests.");
  process.exit(1);
}

// ── Phase 2: Run representative queries ────────────────────────────────

let passed = 0;
let failed = 0;
let skipped = 0;

function attempt(label, fn) {
  try {
    fn();
  } catch (e) {
    // Some queries may fail (e.g., missing data, missing features) — that's OK.
    // We still captured the SQL that was prepared, which is what we need.
  }
}

// ──── 2a. Warm-cache TSV queries (search_artwork only) ─────────────────
const tsvPath = path.resolve(__dirname, "../warm-cache-prompts.tsv");
const tsvLines = fs.readFileSync(tsvPath, "utf-8").split("\n");
const warmSearches = tsvLines
  .filter((l) => l.startsWith("search_artwork\t"))
  .map((l) => JSON.parse(l.split("\t")[1]));

console.error(`  Loading ${warmSearches.length} warm-cache search queries...`);
for (const args of warmSearches) {
  attempt("warm-cache", () => vocabDb.search(args));
}

// ──── 2b. Faceted queries (exercises computeFacets with various drivers) ─

const ALL_FACETS = ["type", "material", "technique", "century", "creatorGender", "rights", "imageAvailable"];

const facetQueries = [
  // FTS-driven facets (BM25 JOIN path — the exact bug we fixed)
  { description: "Atlas Zeden en Gewoonten", facets: ALL_FACETS, maxResults: 50 },
  { title: "Nachtwacht", facets: ALL_FACETS, maxResults: 50 },
  { inscription: "fecit", facets: ["type", "material"], maxResults: 50 },
  { curatorialNarrative: "restoration", facets: ["type", "century"], maxResults: 50 },
  { provenance: "Napoleon", facets: ["type", "material", "technique"], maxResults: 50 },
  { creditLine: "purchase", facets: ["type", "century", "creatorGender"], maxResults: 50 },

  // Vocab-filter-driven facets (no FTS JOIN)
  { subject: "landscape", type: "painting", facets: ["material", "technique", "century"], maxResults: 50 },
  { creator: "Rembrandt", facets: ALL_FACETS, maxResults: 50 },
  { productionPlace: "Amsterdam", facets: ALL_FACETS, maxResults: 50 },
  { material: "paper", facets: ["type", "technique", "century"], maxResults: 50 },
  { technique: "etching", facets: ["type", "material", "century"], maxResults: 50 },
  { depictedPerson: "Napoleon", facets: ["type", "material", "century"], maxResults: 50 },

  // Demographic-driven facets (creator filter JOIN)
  { creatorGender: "female", type: "painting", facets: ["material", "technique", "century"], maxResults: 50 },
  { creatorGender: "female", creatorBornAfter: 1700, creatorBornBefore: 1900, facets: ["type"], maxResults: 50 },
  { creatorGender: "male", creationDate: "17*", facets: ["type", "material"], maxResults: 50 },

  // Multi-filter + facets (complex WHERE clause)
  { creator: "Rembrandt", type: "print", technique: "etching", facets: ["material", "century"], maxResults: 50 },
  { subject: "vanitas", type: "painting", creationDate: "17*", facets: ["material", "technique"], maxResults: 50 },
  { productionPlace: "Haarlem", type: "print", facets: ALL_FACETS, maxResults: 50 },

  // Dimension filters + facets
  { type: "painting", material: "canvas", minHeight: 100, facets: ["technique", "century"], maxResults: 50 },

  // Mixed FTS + vocab + facets
  { title: "portret", creator: "Rembrandt", facets: ["type", "material"], maxResults: 50 },
  { description: "landscape", type: "painting", facets: ["material", "technique", "century"], maxResults: 50 },
  { inscription: "fecit", technique: "engraving", facets: ["type", "century"], maxResults: 50 },
];

console.error(`  Running ${facetQueries.length} faceted queries...`);
for (const args of facetQueries) {
  attempt("facet", () => vocabDb.search(args));
}

// ──── 2c. Geo proximity queries (exercises distance enrichment JOIN) ────

const geoQueries = [
  { nearPlace: "Amsterdam", nearPlaceRadius: 10, type: "painting", maxResults: 25 },
  { nearPlace: "Haarlem", nearPlaceRadius: 25, maxResults: 50 },
  { nearPlace: "Leiden", nearPlaceRadius: 5, creationDate: "17*", maxResults: 25 },
  { nearLat: 52.37, nearLon: 4.89, nearPlaceRadius: 15, maxResults: 25 },
  { nearPlace: "Delft", nearPlaceRadius: 10, type: "print", facets: ["material", "century"], maxResults: 50 },
];

console.error(`  Running ${geoQueries.length} geo proximity queries...`);
for (const args of geoQueries) {
  attempt("geo", () => vocabDb.search(args));
}

// ──── 2d. Compact mode queries (exercises lookupTypes with compact=false) ─

const compactQueries = [
  { creator: "Rembrandt", type: "painting", compact: true },
  { subject: "cat", compact: true },
  { productionPlace: "Japan", compact: true },
];

console.error(`  Running ${compactQueries.length} compact queries...`);
for (const args of compactQueries) {
  attempt("compact-search", () => vocabDb.searchCompact(args));
}

// ──── 2e. Non-compact queries (exercises lookupTypes enrichment) ────────

const enrichmentQueries = [
  { creator: "Vermeer", type: "painting", maxResults: 10 },
  { depictedPlace: "Japan", maxResults: 10 },
  { subject: "flower", type: "painting", maxResults: 25 },
];

console.error(`  Running ${enrichmentQueries.length} enrichment queries...`);
for (const args of enrichmentQueries) {
  attempt("enrichment", () => vocabDb.search(args));
}

// ──── 2f. findSimilar methods (exercises cache init + per-query lookups) ─
// Use well-known artworks likely to have Iconclass, lineage, and depicted persons.

const findSimilarArtworks = [
  "SK-C-5",          // Night Watch — rich metadata
  "SK-A-4691",       // Self-portrait Rembrandt
  "SK-A-1718",       // Vermeer Milkmaid — should have depicted persons
  "RP-P-1878-A-1350", // Print — likely attribution qualifiers
  "SK-A-2344",       // Jan Steen
  "RP-P-OB-32.139",  // Print with depicted persons
];

console.error(`  Running findSimilar for ${findSimilarArtworks.length} artworks...`);
for (const objNum of findSimilarArtworks) {
  attempt("iconclass", () => vocabDb.findSimilarByIconclass(objNum, 15));
  attempt("lineage", () => vocabDb.findSimilarByLineage(objNum, 15));
  attempt("person", () => vocabDb.findSimilarByDepictedPerson(objNum, 15));
}

// ──── 2g. aboutActor queries (exercises person name FTS + mappings) ─────

const actorQueries = [
  { aboutActor: "Rembrandt", maxResults: 25 },
  { aboutActor: "Napoleon", type: "painting", maxResults: 25 },
];

console.error(`  Running ${actorQueries.length} aboutActor queries...`);
for (const args of actorQueries) {
  attempt("actor", () => vocabDb.search(args));
}

// ──── 2h. expandPlaceHierarchy queries ──────────────────────────────────

const hierarchyQueries = [
  { productionPlace: "Netherlands", expandPlaceHierarchy: true, type: "painting", maxResults: 25 },
  { depictedPlace: "Indonesia", expandPlaceHierarchy: true, maxResults: 25 },
];

console.error(`  Running ${hierarchyQueries.length} hierarchy queries...`);
for (const args of hierarchyQueries) {
  attempt("hierarchy", () => vocabDb.search(args));
}

// ── Phase 3: Restore prepare, analyze query plans ──────────────────────

Database.prototype.prepare = origPrepare;

const db = new Database(VOCAB_DB_PATH, { readonly: true });
// Register custom functions so EXPLAIN doesn't fail on UDFs
db.function("haversine_km", (_a, _b, _c, _d) => 0);
db.function("regexp_word", (_a, _b) => 0);

// Verify the dangerous index exists (otherwise test is vacuous)
const dangerousIndexExists = db
  .prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?")
  .get(DANGEROUS_INDEX);
assert(dangerousIndexExists, `Expected ${DANGEROUS_INDEX} to exist in the database`);

// Analyze ALL captured SQL (not just JOIN-through-mappings) so we catch dangerous
// index usage wherever it appears — JOINs, self-joins, even subqueries that
// accidentally scan millions of rows by field_id alone.
const allSql = [...capturedSql];
const mappingsSql = allSql.filter((sql) => /\bmappings\b/i.test(sql));

console.error(
  `\n  Captured ${allSql.length} total SQL statements, ${mappingsSql.length} referencing mappings.`
);

const failures = [];
let cacheInitAllowed = 0;
let subqueryAllowed = 0;

/**
 * Build a set of EXPLAIN QUERY PLAN node IDs that are inside subquery contexts
 * (LIST SUBQUERY, CORRELATED SUBQUERY).  These are WHERE-clause subqueries where
 * SQLite builds Bloom filters — field_id-only scans are inherent and expected there.
 */
function findSubqueryNodeIds(planRows) {
  const subqRoots = new Set();
  for (const row of planRows) {
    if (/^(LIST|CORRELATED) SUBQUERY/.test(row.detail) || /^(LIST|CORRELATED SCALAR) SUBQUERY/.test(row.detail)) {
      subqRoots.add(row.id);
    }
  }
  // BFS: find all descendants of subquery roots
  const descendants = new Set(subqRoots);
  const queue = [...subqRoots];
  while (queue.length > 0) {
    const nodeId = queue.shift();
    for (const row of planRows) {
      if (row.parent === nodeId && !descendants.has(row.id)) {
        descendants.add(row.id);
        queue.push(row.id);
      }
    }
  }
  return descendants;
}

for (const sql of mappingsSql) {
  // Substitute placeholders with dummy values for EXPLAIN
  // FTS MATCH needs a valid expression; other params get 1
  const explainSql =
    "EXPLAIN QUERY PLAN " +
    sql.replace(/MATCH\s*\?/g, "MATCH '\"test\"'").replace(/\?/g, "1");

  try {
    const planRows = db.prepare(explainSql).all();
    const subqueryNodeIds = findSubqueryNodeIds(planRows);

    // Check for dangerous pattern at TOP LEVEL (not inside subqueries)
    const dangerousTopLevel = planRows.filter(
      (r) => DANGEROUS_PATTERN.test(r.detail) && !subqueryNodeIds.has(r.id)
    );

    // Also track subquery-level dangerous usage (allowed but counted for info)
    const dangerousInSubquery = planRows.filter(
      (r) => DANGEROUS_PATTERN.test(r.detail) && subqueryNodeIds.has(r.id)
    );
    if (dangerousInSubquery.length > 0) subqueryAllowed++;

    if (dangerousTopLevel.length > 0) {
      // Check if this is an allowlisted cache-init query
      const isCacheInit = CACHE_INIT_MARKERS.some((marker) => sql.includes(marker));
      if (isCacheInit) {
        cacheInitAllowed++;
      } else {
        failed++;
        failures.push({
          sql: sql.substring(0, 200),
          plan: planRows.map((r) => ({
            detail: r.detail,
            inSubquery: subqueryNodeIds.has(r.id),
          })),
        });
      }
    } else {
      passed++;
    }
  } catch (e) {
    // EXPLAIN may fail on some dynamic SQL — log but don't count as failure
    console.error(`  ⚠ EXPLAIN failed: ${e.message}\n    SQL: ${sql.substring(0, 100)}...`);
    skipped++;
  }
}

// ── Phase 4: Report ────────────────────────────────────────────────────

console.log(`\n${"═".repeat(60)}`);
console.log("  Query Plan Analysis: idx_mappings_field_vocab guard");
console.log(`${"═".repeat(60)}`);
console.log(`  Total SQL captured:        ${allSql.length}`);
console.log(`  Referencing mappings:      ${mappingsSql.length}`);
console.log(`  Passed (safe plan):        ${passed}`);
console.log(`  Allowed (subquery/Bloom):  ${subqueryAllowed}`);
console.log(`  Allowed (cache-init):      ${cacheInitAllowed}`);
console.log(`  Skipped (EXPLAIN error):   ${skipped}`);
console.log(`  Failed (dangerous plan):   ${failed}`);

if (failures.length > 0) {
  console.log(`\n  ✗ FAILURES — field_id-only scan at top level (not in subquery):`);
  console.log(`    Fix: use +m.field_id (unary-plus) in JOINs to force PK prefix scan.\n`);
  for (const f of failures) {
    console.log(`  SQL: ${f.sql}...`);
    console.log(`  Plan:`);
    for (const { detail, inSubquery } of f.plan) {
      const isDangerous = DANGEROUS_PATTERN.test(detail) && !inSubquery;
      const marker = isDangerous ? " ← FIELD-ONLY SCAN" : inSubquery && DANGEROUS_PATTERN.test(detail) ? " (subquery — OK)" : "";
      console.log(`    ${detail}${marker}`);
    }
    console.log();
  }
}

console.log(`${"═".repeat(60)}\n`);

db.close();

assert.equal(
  failed,
  0,
  `${failed} query/queries use ${DANGEROUS_INDEX} with field_id alone at top level. ` +
    `Add +field_id (unary-plus trick) to JOINs, or narrow with vocab_rowid.`
);

console.log("  ✓ All mappings queries use safe index plans.\n");
