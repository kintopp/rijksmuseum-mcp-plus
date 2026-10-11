/**
 * test-query-plans.mjs — Verify SQLite query planner choices for mappings table.
 *
 * Instruments better-sqlite3 to capture all SQL executed by VocabularyDb,
 * then runs EXPLAIN QUERY PLAN on every query that touches the mappings
 * table.  Asserts the optimizer never uses idx_mappings_field_vocab as a
 * covering-scan driver in non-subquery contexts — the ~6000x anti-pattern.
 *
 * Runs 200 purpose-built queries across every VocabSearchParams code path:
 * single-field vocab, multi-field combos, text FTS, facets, geo proximity,
 * compact mode, findSimilar (iconclass/lineage/person), demographics,
 * hierarchy expansion, dimensions, dates, aboutActor, and more.
 *
 * Usage:  node scripts/tests/test-query-plans.mjs
 */

import { createRequire } from "node:module";
import assert from "node:assert/strict";
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
const DANGEROUS_PATTERN = /idx_mappings_field_vocab\s+\(field_id=\?\)/;

// Search facets join the result set to mappings (alias fm) and then vocabulary.
// Driving that join from vocabulary walks every person/place row and probes the
// result set per row — minutes instead of milliseconds on a broad filter.
const FACET_SQL = /JOIN mappings fm\b/;
const firstTopLevelAccess = (planRows, subqueryNodeIds) =>
  planRows.find((r) => /^(SCAN|SEARCH) /.test(r.detail) && !subqueryNodeIds.has(r.id))?.detail ?? "";

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
  // searchPersons birthPlace/profession pivot: the creator-field scan is
  // Bloom-filtered against the attribute's artworks and stays sub-second.
  "SELECT DISTINCT cv.id AS person_id",
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

const { VocabularyDb, FILTER_ART_IDS_KEYS } = await import("../../dist/api/VocabularyDb.js");
const { FACET_DIMENSIONS } = await import("../../dist/registration/helpers.js");
const vocabDb = new VocabularyDb();

if (!vocabDb.available) {
  console.error("ERROR: VocabularyDb not available — cannot run query plan tests.");
  process.exit(1);
}

// ── Phase 2: Run 200 representative queries ────────────────────────────
//
// Organized by the SQL code paths they exercise.  Each section targets a
// specific area of VocabularyDb that touches the mappings table, with
// enough variety to cover different WHERE-clause shapes that might cause
// the optimizer to choose different index plans.

let queryCount = 0;

// search() ignores keys it does not know, so a removed param would leave its
// queries running unfiltered and checking nothing. Reject such keys up front.
const NON_VOCAB_SEARCH_KEYS = [
  "description", "inscription", "curatorialNarrative", "textQuery", "title", "objectNumber",
  "minHeight", "maxHeight", "minWidth", "maxWidth", "nearPlace", "nearLat", "nearLon",
  "nearPlaceRadius", "aboutActor", "expandPlaceHierarchy", "sameRowMatching", "hasProvenance",
  "sortBy", "sortOrder", "maxResults", "offset", "facets", "facetLimit",
];
const KNOWN_SEARCH_KEYS = new Set([...FILTER_ART_IDS_KEYS, ...NON_VOCAB_SEARCH_KEYS]);
const unknownArgs = [];
function checked(args, allowed = KNOWN_SEARCH_KEYS) {
  const bad = Object.keys(args).filter((k) => !allowed.has(k));
  for (const f of args.facets ?? []) if (!FACET_DIMENSIONS.includes(f)) bad.push(`facets:${f}`);
  if (bad.length) unknownArgs.push(`${JSON.stringify(args)} → ${bad.join(", ")}`);
  return args;
}

function attempt(fn) {
  queryCount++;
  try { fn(); } catch { /* OK — SQL was still captured */ }
}

function runAll(queries, method = "search", allowed = KNOWN_SEARCH_KEYS) {
  for (const args of queries) attempt(() => vocabDb[method](checked(args, allowed)));
}

const ALL_FACETS = [...FACET_DIMENSIONS];

// ──── A. Single-field vocab filters (15 params × ~1-2 each = ~20) ──────
// Each VOCAB_FILTERS entry produces a different mappingFilterDirect or
// mappingFilterSubquery SQL depending on FTS availability.

console.error("  A. Single-field vocab filters...");
const singleFieldQueries = [
  { subject: "landscape" },
  { subject: "cat" },
  { subject: "vanitas" },
  { iconclass: "73D82" },
  { iconclass: "25F" },
  { depictedPerson: "Napoleon" },
  { depictedPerson: "Amalia van Solms" },
  { depictedPlace: "Amsterdam" },
  { depictedPlace: "Japan" },
  { productionPlace: "Haarlem" },
  { productionPlace: "China" },
  { theme: "slavery" },
  { sourceType: "designs" },
  { productionRole: "printmaker" },
  { attributionQualifier: "workshop of" },
  { material: "paper" },
  { material: "canvas" },
  { technique: "etching" },
  { technique: "mezzotint" },
  { type: "painting" },
  { type: "print" },
  { type: "drawing" },
  { creator: "Rembrandt" },
  { creator: "Jan Steen" },
  { collectionSet: "Rijksprentenkabinet" },
  { productionRole: "after painting by" },
  { attributionQualifier: "workshop of" },
  { attributionQualifier: "circle of" },
];
runAll(singleFieldQueries);

// ──── B. Multi-field vocab combos (different WHERE clause shapes) ───────

console.error("  B. Multi-field vocab combos...");
const multiFieldQueries = [
  // Two-field combos
  { creator: "Rembrandt", type: "painting" },
  { creator: "Rembrandt", type: "print" },
  { creator: "Rembrandt", type: "drawing" },
  { subject: "landscape", type: "painting" },
  { subject: "winter landscape", creationDate: "17*" },
  { productionPlace: "Haarlem", technique: "mezzotint" },
  { productionPlace: "Amsterdam", type: "print" },
  { depictedPerson: "Napoleon", type: "painting" },
  { material: "panel", type: "painting" },
  { productionRole: "printmaker", productionPlace: "Haarlem" },
  { attributionQualifier: "workshop of", type: "painting" },
  { depictedPlace: "Japan", type: "print" },
  { productionRole: "after painting by", creator: "Rembrandt" },
  { attributionQualifier: "workshop of", creator: "Rembrandt" },
  // Three-field combos
  { creator: "Rembrandt", type: "print", technique: "etching" },
  { subject: "vanitas", type: "painting", creationDate: "17*" },
  { productionPlace: "Haarlem", type: "print", technique: "engraving" },
  { depictedPerson: "Maurits", type: "print", productionPlace: "Haarlem" },
  { material: "paper", technique: "watercolor", type: "drawing" },
  { productionRole: "painter", productionPlace: "Leiden", type: "painting" },
  // Four-field combos
  { creator: "Rembrandt", type: "print", technique: "etching", creationDate: "164*" },
  { productionPlace: "Amsterdam", type: "print", material: "paper", technique: "etching" },
];
runAll(multiFieldQueries);

// ──── C. Text FTS filters (each triggers FTS JOIN + BM25 ranking) ──────

console.error("  C. Text FTS filters...");
const textFtsQueries = [
  // Title (title_all_text FTS)
  { title: "Nachtwacht" },
  { title: "portret" },
  { title: "landschap" },
  { title: "zelfportret" },
  // Description (description_text FTS)
  { description: "Atlas Zeden en Gewoonten" },
  { description: "landscape" },
  { description: "restoration" },
  { description: "allegory" },
  // Inscription (inscription_text FTS)
  { inscription: "fecit" },
  { inscription: "luctor et emergo" },
  { inscription: "sculpsit" },
  { curatorialNarrative: "Napoleon" },
  { curatorialNarrative: "VOC" },
  { textQuery: { must: [{ field: "description", any: ["schip"] }] } },
  // Credit line (credit_line FTS)
  { hasProvenance: true },
  { hasProvenance: true, type: "painting" },
  { hasProvenance: true, creator: "Rembrandt" },
  // Curatorial narrative (narrative_text FTS)
  { curatorialNarrative: "restoration" },
  { curatorialNarrative: "dune" },
  { curatorialNarrative: "bleaching" },
];
runAll(textFtsQueries);

// ──── D. Mixed FTS + vocab (exercises both JOIN paths simultaneously) ──

console.error("  D. Mixed FTS + vocab filters...");
const mixedFtsVocabQueries = [
  { title: "portret", creator: "Rembrandt" },
  { title: "landschap", type: "painting" },
  { description: "landscape", type: "painting" },
  { description: "allegory", creator: "Rembrandt" },
  { inscription: "fecit", technique: "engraving" },
  { inscription: "sculpsit", type: "print" },
  { curatorialNarrative: "Napoleon", type: "painting" },
  { textQuery: { must: [{ field: "description", any: ["schip"] }] }, creator: "Rembrandt" },
  { curatorialNarrative: "dune", productionPlace: "Haarlem" },
  { title: "bloemen", type: "painting", material: "canvas" },
  { description: "restoration", type: "painting", creator: "Rembrandt" },
  // Multiple text FTS fields (second becomes IN-subquery)
  { title: "portret", inscription: "pinxit" },
  { description: "landscape", curatorialNarrative: "restoration" },
];
runAll(mixedFtsVocabQueries);

// ──── E. Faceted queries (exercises computeFacets JOINs) ────────────────

console.error("  E. Faceted queries...");
const facetQueries = [
  // FTS-driven facets (BM25 JOIN path — the original bug)
  { description: "Atlas Zeden en Gewoonten", facets: ALL_FACETS, maxResults: 50 },
  { title: "Nachtwacht", facets: ALL_FACETS, maxResults: 50 },
  { inscription: "fecit", facets: ["type", "material"], maxResults: 50 },
  { curatorialNarrative: "restoration", facets: ["type", "century"], maxResults: 50 },
  { hasProvenance: true, facets: ["type", "material", "technique"], maxResults: 50 },
  { curatorialNarrative: "Napoleon", facets: ["type", "century", "creator"], maxResults: 50 },
  // Vocab-filter-driven facets (no FTS JOIN in main query)
  { subject: "landscape", type: "painting", facets: ["material", "technique", "century"], maxResults: 50 },
  { creator: "Rembrandt", facets: ALL_FACETS, maxResults: 50 },
  { productionPlace: "Amsterdam", facets: ALL_FACETS, maxResults: 50 },
  { material: "paper", facets: ["type", "technique", "century"], maxResults: 50 },
  { technique: "etching", facets: ["type", "material", "century"], maxResults: 50 },
  { depictedPerson: "Napoleon", facets: ["type", "material", "century"], maxResults: 50 },
  // Demographic-driven facets
  { theme: "slavery", type: "painting", facets: ["material", "technique", "century"], maxResults: 50 },
  { sourceType: "designs", creationDate: "18*", facets: ["type"], maxResults: 50 },
  { productionRole: "printmaker", creationDate: "17*", facets: ["type", "material"], maxResults: 50 },
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
  // Single-facet requests (different computeFacets branches)
  { type: "painting", facets: ["century"], maxResults: 50 },
  { creator: "Rembrandt", facets: ["depictedPerson"], maxResults: 50 },
  { material: "paper", facets: ["rights"], maxResults: 50 },
  { technique: "etching", facets: ["imageAvailable"], maxResults: 50 },
];
runAll(facetQueries);

// ──── F. Geo proximity (exercises haversine JOIN through mappings) ──────

console.error("  F. Geo proximity queries...");
const geoQueries = [
  { nearPlace: "Amsterdam", nearPlaceRadius: 10, type: "painting", maxResults: 25 },
  { nearPlace: "Haarlem", nearPlaceRadius: 25, maxResults: 50 },
  { nearPlace: "Leiden", nearPlaceRadius: 5, creationDate: "17*", maxResults: 25 },
  { nearLat: 52.37, nearLon: 4.89, nearPlaceRadius: 15, maxResults: 25 },
  { nearPlace: "Delft", nearPlaceRadius: 10, type: "print", facets: ["material", "century"], maxResults: 50 },
  { nearPlace: "Utrecht", nearPlaceRadius: 20, technique: "etching", maxResults: 25 },
  { nearPlace: "Dordrecht", nearPlaceRadius: 15, maxResults: 25 },
  { nearLat: 51.92, nearLon: 4.48, nearPlaceRadius: 5, type: "drawing", maxResults: 25 },
];
runAll(geoQueries);

// ──── G. Compact mode (exercises searchCompact — lookupTypes skipped) ──

console.error("  G. Compact mode queries...");
const compactQueries = [
  { creator: "Rembrandt", type: "painting" },
  { subject: "cat" },
  { productionPlace: "Japan" },
  { material: "paper", technique: "etching" },
  { depictedPerson: "Napoleon" },
  { iconclass: "73D82" },
  { type: "painting", creationDate: "17*" },
  { creator: "Vermeer", type: "painting" },
];
runAll(compactQueries, "searchCompact");

// ──── H. Creator demographics (search_persons: person filters + artwork join) ──

console.error("  H. Creator demographic queries...");
const PERSON_KEYS = new Set(["name", "gender", "bornAfter", "bornBefore", "birthPlace", "deathPlace",
  "profession", "hasArtworks", "maxResults", "offset"]);
const demographicQueries = [
  { gender: "female", profession: "painter" },
  { gender: "female", bornAfter: 1800 },
  { gender: "female", bornAfter: 1600, bornBefore: 1700 },
  { gender: "male", bornAfter: 1800, bornBefore: 1900, profession: "printmaker" },
  { birthPlace: "Leiden" },
  { deathPlace: "Amsterdam" },
  { birthPlace: "Haarlem", profession: "printmaker" },
  { profession: "painter", birthPlace: "Leiden", hasArtworks: true },
  { bornAfter: 1400, bornBefore: 1500, hasArtworks: true },
  { name: "Rembrandt", hasArtworks: true },
];
runAll(demographicQueries, "searchPersons", PERSON_KEYS);

// ──── I. Place hierarchy expansion (exercises recursive CTE) ────────────

console.error("  I. Place hierarchy queries...");
const hierarchyQueries = [
  { productionPlace: "Netherlands", expandPlaceHierarchy: true, type: "painting", maxResults: 25 },
  { depictedPlace: "Indonesia", expandPlaceHierarchy: true, maxResults: 25 },
  { productionPlace: "Germany", expandPlaceHierarchy: true, type: "print", maxResults: 25 },
  { depictedPlace: "France", expandPlaceHierarchy: true, type: "painting", maxResults: 25 },
  { productionPlace: "Italy", expandPlaceHierarchy: true, maxResults: 25 },
  { productionPlace: "Netherlands", expandPlaceHierarchy: true, productionRole: "printmaker", maxResults: 25 },
];
runAll(hierarchyQueries);

// ──── J. aboutActor (exercises multi-field [subject, creator] filter) ───

console.error("  J. aboutActor queries...");
const actorQueries = [
  { aboutActor: "Rembrandt", maxResults: 25 },
  { aboutActor: "Napoleon", type: "painting", maxResults: 25 },
  { aboutActor: "Vermeer", maxResults: 25 },
  { aboutActor: "Maria", type: "print", maxResults: 25 },
  { aboutActor: "Willem", maxResults: 25 },
  { aboutActor: "Amalia van Solms", maxResults: 25 },
];
runAll(actorQueries);

// ──── K. Date filters (different dateMatch modes) ───────────────────────

console.error("  K. Date filter variants...");
const dateQueries = [
  // Wildcard dates
  { type: "painting", creationDate: "17*" },
  { type: "painting", creationDate: "16*" },
  { type: "print", creationDate: "15*" },
  { type: "painting", creationDate: "164*" },
  // Exact year
  { type: "painting", creationDate: "1642" },
  { creator: "Rembrandt", creationDate: "1642" },
  // Date match modes
  { type: "painting", creationDate: "17*", dateMatch: "overlaps" },
  { type: "painting", creationDate: "17*", dateMatch: "within" },
  { type: "painting", creationDate: "17*", dateMatch: "midpoint" },
  // Date + other filters
  { creator: "Rembrandt", type: "print", creationDate: "164*" },
  { productionPlace: "Amsterdam", creationDate: "16*", type: "painting" },
];
runAll(dateQueries);

// ──── L. Dimension filters ──────────────────────────────────────────────

console.error("  L. Dimension filters...");
const dimensionQueries = [
  { type: "painting", minWidth: 300 },
  { type: "painting", maxHeight: 30 },
  { type: "painting", material: "panel", minHeight: 40, maxHeight: 50, minWidth: 30, maxWidth: 40 },
  { type: "painting", material: "canvas", minHeight: 200, minWidth: 200 },
  { type: "drawing", maxHeight: 15, maxWidth: 15 },
];
runAll(dimensionQueries);

// ──── N. imageAvailable modifier ────────────────────────────────────────

console.error("  N. imageAvailable queries...");
const imageQueries = [
  { type: "painting", imageAvailable: true },
  { creator: "Rembrandt", imageAvailable: true },
  { productionPlace: "Japan", imageAvailable: true },
  { subject: "landscape", type: "painting", imageAvailable: true },
];
runAll(imageQueries);

// ──── O. Array params (multi-value AND) ─────────────────────────────────

console.error("  O. Array param queries...");
const arrayParamQueries = [
  { type: ["painting", "drawing"], creator: "Rembrandt" },
  { material: ["paper", "canvas"], type: "painting" },
  { technique: ["etching", "engraving"], type: "print" },
  { productionPlace: ["Amsterdam", "Haarlem"], type: "print" },
  { subject: ["landscape", "winter"], type: "painting" },
];
runAll(arrayParamQueries);

// ──── P. findSimilar methods (cache init + per-query lookups) ───────────
// Use well-known artworks likely to have rich metadata.

console.error("  P. findSimilar queries...");
const findSimilarArtworks = [
  "SK-C-5",            // Night Watch
  "SK-A-4691",         // Self-portrait Rembrandt
  "SK-A-1718",         // Vermeer Milkmaid
  "RP-P-1878-A-1350",  // Print
  "SK-A-2344",         // Jan Steen
  "RP-P-OB-32.139",    // Print with depicted persons
  "SK-A-3262",         // Avercamp winter landscape
  "SK-A-4050",         // Saul and David
];
for (const objNum of findSimilarArtworks) {
  attempt(() => vocabDb.findSimilarByIconclass(objNum, 15));
  attempt(() => vocabDb.findSimilarByLineage(objNum, 15));
  attempt(() => vocabDb.findSimilarByDepictedPerson(objNum, 15));
}

// ──── Q. filterArtIds (used by semantic_search for pre-filtering) ──────

console.error("  Q. filterArtIds queries...");
const filterArtIdQueries = [
  { type: "painting" },
  { material: "canvas" },
  { technique: "etching" },
  { creator: "Rembrandt", type: "painting" },
  { subject: "landscape", type: "painting" },
  { productionPlace: "Amsterdam" },
  { theme: "slavery", imageAvailable: true },
];
runAll(filterArtIdQueries, "filterArtIds", FILTER_ART_IDS_KEYS);

console.error(`  → ${queryCount} queries executed.\n`);
assert.deepEqual(unknownArgs, [], "queries pass params search() does not accept");
assert(queryCount >= 200, `Expected ≥200 queries, got ${queryCount}`);

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
  `  Captured ${allSql.length} total SQL statements, ${mappingsSql.length} referencing mappings.`
);

let passed = 0;
let failed = 0;
let skipped = 0;
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
    if (/^(LIST|CORRELATED|CORRELATED SCALAR) SUBQUERY/.test(row.detail)) {
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

    const drivesFromVocab = FACET_SQL.test(sql) && /^(SCAN|SEARCH) v\b/.test(firstTopLevelAccess(planRows, subqueryNodeIds));

    const isCacheInit = CACHE_INIT_MARKERS.some((marker) => sql.includes(marker));
    if (drivesFromVocab || (dangerousTopLevel.length > 0 && !isCacheInit)) {
      failed++;
      failures.push({
        sql: sql.substring(0, 200),
        plan: planRows.map((r) => ({ detail: r.detail, inSubquery: subqueryNodeIds.has(r.id) })),
      });
    } else if (dangerousTopLevel.length > 0) {
      cacheInitAllowed++;
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
console.log(`  Queries executed:          ${queryCount}`);
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
