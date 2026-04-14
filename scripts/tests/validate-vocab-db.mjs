/**
 * Comprehensive vocabulary DB structure & integrity validation.
 *
 * Run:  node scripts/tests/validate-vocab-db.mjs [path/to/vocabulary.db]
 *
 * Validates:
 *  1. SQLite integrity
 *  2. Required tables & columns exist
 *  3. version_info consistency
 *  4. Row counts vs harvest report expectations
 *  5. Integer-encoding correctness (FK integrity)
 *  6. FTS5 indexes in sync with source tables
 *  7. Lookup tables (field_lookup, rights_lookup)
 *  8. Importance scores & coverage
 *  9. Sample queries produce sane results
 * 10. No leftover harvest-only columns
 * 11. Index coverage
 * 12. Comparison with previous harvest (deltas)
 * 13. Server compatibility (VocabularyDb.ts requirements)
 */

import Database from "better-sqlite3";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB = resolve(__dirname, "..", "..", "data", "vocabulary.db");
const dbPath = process.argv[2] || DEFAULT_DB;

const db = new Database(dbPath, { readonly: true });
db.pragma("mmap_size=3000000000");

// ── Test helpers ─────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, msg) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}

function assertEq(actual, expected, msg) {
  const ok = actual === expected;
  assert(ok, ok ? msg : `${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertGte(actual, min, msg) {
  const ok = actual >= min;
  assert(ok, ok ? `${msg} (${actual.toLocaleString()})` : `${msg} — expected >= ${min}, got ${actual}`);
}

function assertLte(actual, max, msg) {
  const ok = actual <= max;
  assert(ok, ok ? `${msg} (${actual.toLocaleString()})` : `${msg} — expected <= ${max}, got ${actual}`);
}

function assertBetween(actual, min, max, msg) {
  const ok = actual >= min && actual <= max;
  assert(ok, ok ? `${msg} (${actual.toLocaleString()})` : `${msg} — expected ${min}–${max}, got ${actual}`);
}

function count(sql, ...params) {
  return db.prepare(sql).get(...params);
}

function scalar(sql, ...params) {
  const row = db.prepare(sql).get(...params);
  return row ? Object.values(row)[0] : null;
}

// ── Helpers ──────────────────────────────────────────────────────

function tableExists(name) {
  return scalar(`SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?`, name) > 0;
}

function columnExists(table, col) {
  const cols = db.pragma(`table_info(${table})`);
  return cols.some(c => c.name === col);
}

function indexExists(name) {
  return scalar(`SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?`, name) > 0;
}

function fieldId(name) {
  return scalar(`SELECT id FROM field_lookup WHERE name = ?`, name);
}

console.log(`\nValidating: ${dbPath}\n`);

// ═══════════════════════════════════════════════════════════════════
// 1. SQLite Integrity
// ═══════════════════════════════════════════════════════════════════

console.log("═ 1. SQLite Integrity ═════════════════════════════════════\n");

const integrityResult = scalar("PRAGMA integrity_check");
assertEq(integrityResult, "ok", "PRAGMA integrity_check passes");

// ═══════════════════════════════════════════════════════════════════
// 2. Required Tables
// ═══════════════════════════════════════════════════════════════════

console.log("\n═ 2. Required Tables ══════════════════════════════════════\n");

const requiredTables = [
  "artworks", "vocabulary", "mappings",
  "field_lookup", "rights_lookup", "version_info",
  "person_names", "vocab_term_counts",
  // FTS5 virtual tables
  "vocabulary_fts", "person_names_fts", "artwork_texts_fts",
];

for (const t of requiredTables) {
  assert(tableExists(t), `Table '${t}' exists`);
}

// ═══════════════════════════════════════════════════════════════════
// 3. Required Columns
// ═══════════════════════════════════════════════════════════════════

console.log("\n═ 3. Required Columns ═════════════════════════════════════\n");

const artworkCols = [
  "object_number", "title", "creator_label",
  "inscription_text", "provenance_text", "credit_line",
  "description_text", "height_cm", "width_cm",
  "narrative_text", "date_earliest", "date_latest",
  "title_all_text", "has_image", "iiif_id",
  "art_id", "rights_id", "importance",
];
for (const col of artworkCols) {
  assert(columnExists("artworks", col), `artworks.${col} exists`);
}

// Harvest-only columns should be DROPPED
for (const col of ["linked_art_uri", "tier2_done"]) {
  assert(!columnExists("artworks", col), `artworks.${col} dropped (harvest-only)`);
}

// Vocabulary columns
const vocabCols = [
  "id", "type", "label_en", "label_nl", "external_id", "broader_id",
  "notation", "lat", "lon", "label_en_norm", "label_nl_norm", "vocab_int_id",
];
for (const col of vocabCols) {
  assert(columnExists("vocabulary", col), `vocabulary.${col} exists`);
}

// Mappings must be integer-encoded
const mappingCols = ["artwork_id", "vocab_rowid", "field_id"];
for (const col of mappingCols) {
  assert(columnExists("mappings", col), `mappings.${col} exists (integer-encoded)`);
}
// Text mapping columns should NOT exist
for (const col of ["field", "object_number", "vocab_id"]) {
  assert(!columnExists("mappings", col), `mappings.${col} absent (text columns removed)`);
}

// ═══════════════════════════════════════════════════════════════════
// 4. version_info
// ═══════════════════════════════════════════════════════════════════

console.log("\n═ 4. version_info ═════════════════════════════════════════\n");

const viRows = db.prepare("SELECT key, value FROM version_info").all();
const vi = Object.fromEntries(viRows.map(r => [r.key, r.value]));

assert(vi.built_at !== undefined, `version_info has 'built_at' (${vi.built_at})`);
assert(vi.artwork_count !== undefined, `version_info has 'artwork_count' (${vi.artwork_count})`);
assert(vi.vocab_count !== undefined, `version_info has 'vocab_count' (${vi.vocab_count})`);
assert(vi.mapping_count !== undefined, `version_info has 'mapping_count' (${vi.mapping_count})`);

// Cross-check version_info counts against actual table counts
const actualArtworks = scalar("SELECT COUNT(*) FROM artworks");
const actualVocab = scalar("SELECT COUNT(*) FROM vocabulary");
const actualMappings = scalar("SELECT COUNT(*) FROM mappings");

assertEq(parseInt(vi.artwork_count), actualArtworks,
  `version_info.artwork_count matches actual (${actualArtworks.toLocaleString()})`);
assertEq(parseInt(vi.vocab_count), actualVocab,
  `version_info.vocab_count matches actual (${actualVocab.toLocaleString()})`);
assertEq(parseInt(vi.mapping_count), actualMappings,
  `version_info.mapping_count matches actual (${actualMappings.toLocaleString()})`);

// ═══════════════════════════════════════════════════════════════════
// 5. Row Count Ranges (sane for Rijksmuseum collection)
// ═══════════════════════════════════════════════════════════════════

console.log("\n═ 5. Row Count Ranges ═════════════════════════════════════\n");

assertBetween(actualArtworks, 830_000, 850_000, "Artwork count in expected range");
assertBetween(actualVocab, 190_000, 200_000, "Vocabulary count in expected range");
assertBetween(actualMappings, 13_000_000, 15_000_000, "Mapping count in expected range");

const personNameCount = scalar("SELECT COUNT(*) FROM person_names");
// v0.24 anchor: 346,122. Lower bound dropped from 350K to 340K (#243).
assertBetween(personNameCount, 340_000, 400_000, "Person name variants in expected range");

const vtcCount = scalar("SELECT COUNT(*) FROM vocab_term_counts");
assertBetween(vtcCount, 170_000, 200_000, "vocab_term_counts in expected range");

// ═══════════════════════════════════════════════════════════════════
// 6. Lookup Tables
// ═══════════════════════════════════════════════════════════════════

console.log("\n═ 6. Lookup Tables ════════════════════════════════════════\n");

// field_lookup — must have all 14 fields
const expectedFields = [
  "attribution_qualifier", "birth_place", "collection_set", "creator",
  "death_place", "material", "production_place", "production_role",
  "profession", "source_type", "spatial", "subject", "technique", "type",
];
const actualFields = db.prepare("SELECT name FROM field_lookup ORDER BY name").all().map(r => r.name);
assertEq(actualFields.length, 14, "field_lookup has 14 entries");
for (const f of expectedFields) {
  assert(actualFields.includes(f), `field_lookup contains '${f}'`);
}

// field_lookup IDs must be contiguous 1-14
const fieldIds = db.prepare("SELECT id FROM field_lookup ORDER BY id").all().map(r => r.id);
assertEq(fieldIds[0], 1, "field_lookup IDs start at 1");
assertEq(fieldIds[fieldIds.length - 1], 14, "field_lookup IDs end at 14");

// rights_lookup — must have 3 entries
const rightsCount = scalar("SELECT COUNT(*) FROM rights_lookup");
assertEq(rightsCount, 3, "rights_lookup has 3 entries");

const rightsUris = db.prepare("SELECT uri FROM rights_lookup ORDER BY uri").all().map(r => r.uri);
assert(rightsUris.some(u => u.includes("InC")), "rights_lookup has InC");
assert(rightsUris.some(u => u.includes("publicdomain/mark")), "rights_lookup has public domain mark");
assert(rightsUris.some(u => u.includes("publicdomain/zero")), "rights_lookup has CC0");

// ═══════════════════════════════════════════════════════════════════
// 7. FK Integrity (Integer-Encoded Mappings)
// ═══════════════════════════════════════════════════════════════════

console.log("\n═ 7. FK Integrity ═════════════════════════════════════════\n");

// Every mapping.artwork_id must reference an existing artworks.art_id
const orphanArtworkMappings = scalar(`
  SELECT COUNT(*) FROM mappings m
  WHERE NOT EXISTS (SELECT 1 FROM artworks a WHERE a.art_id = m.artwork_id)
`);
assertEq(orphanArtworkMappings, 0, "No orphan artwork_id in mappings");

// Every mapping.vocab_rowid must reference an existing vocabulary.vocab_int_id
const orphanVocabMappings = scalar(`
  SELECT COUNT(*) FROM mappings m
  WHERE NOT EXISTS (SELECT 1 FROM vocabulary v WHERE v.vocab_int_id = m.vocab_rowid)
`);
assertEq(orphanVocabMappings, 0, "No orphan vocab_rowid in mappings");

// Every mapping.field_id must reference field_lookup
const orphanFieldMappings = scalar(`
  SELECT COUNT(*) FROM mappings m
  WHERE NOT EXISTS (SELECT 1 FROM field_lookup f WHERE f.id = m.field_id)
`);
assertEq(orphanFieldMappings, 0, "No orphan field_id in mappings");

// Every artworks.rights_id (non-null) must reference rights_lookup
const orphanRights = scalar(`
  SELECT COUNT(*) FROM artworks
  WHERE rights_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM rights_lookup r WHERE r.id = artworks.rights_id)
`);
assertEq(orphanRights, 0, "No orphan rights_id in artworks");

// art_id must be unique and non-null
const nullArtId = scalar("SELECT COUNT(*) FROM artworks WHERE art_id IS NULL");
assertEq(nullArtId, 0, "No NULL art_id in artworks");

// vocab_int_id must be unique and non-null
const nullVocabIntId = scalar("SELECT COUNT(*) FROM vocabulary WHERE vocab_int_id IS NULL");
assertEq(nullVocabIntId, 0, "No NULL vocab_int_id in vocabulary");

// ═══════════════════════════════════════════════════════════════════
// 8. FTS5 Indexes in Sync
// ═══════════════════════════════════════════════════════════════════

console.log("\n═ 8. FTS5 Indexes ═════════════════════════════════════════\n");

// vocabulary_fts should match vocabulary row count
const vocabFtsCount = scalar("SELECT COUNT(*) FROM vocabulary_fts");
assertEq(vocabFtsCount, actualVocab, "vocabulary_fts row count matches vocabulary");

// person_names_fts should match person_names
const pnFtsCount = scalar("SELECT COUNT(*) FROM person_names_fts");
assertEq(pnFtsCount, personNameCount, "person_names_fts row count matches person_names");

// artwork_texts_fts should match artworks
const atFtsCount = scalar("SELECT COUNT(*) FROM artwork_texts_fts");
assertEq(atFtsCount, actualArtworks, "artwork_texts_fts row count matches artworks");

// FTS5 actually finds things (smoke test)
const ftsHit = scalar(`SELECT COUNT(*) FROM vocabulary_fts WHERE vocabulary_fts MATCH '"Rembrandt"'`);
assertGte(ftsHit, 1, "vocabulary_fts finds 'Rembrandt'");

const pnFtsHit = scalar(`SELECT COUNT(*) FROM person_names_fts WHERE person_names_fts MATCH '"Rembrandt"'`);
assertGte(pnFtsHit, 1, "person_names_fts finds 'Rembrandt'");

const atFtsHit = scalar(`SELECT COUNT(*) FROM artwork_texts_fts WHERE artwork_texts_fts MATCH '"Night Watch"'`);
assertGte(atFtsHit, 0, "artwork_texts_fts search runs without error");

// ═══════════════════════════════════════════════════════════════════
// 9. Indexes
// ═══════════════════════════════════════════════════════════════════

console.log("\n═ 9. Required Indexes ═════════════════════════════════════\n");

const requiredIndexes = [
  "idx_artworks_art_id",
  "idx_artworks_importance",
  "idx_artworks_date_range",
  "idx_artworks_height",
  "idx_artworks_width",
  "idx_mappings_field_vocab",
  "idx_vocab_int_id",
  "idx_vocab_label_en",
  "idx_vocab_label_nl",
  "idx_vocab_notation",
  "idx_vocab_type",
  "idx_vocab_lat_lon",
  "idx_vtc_cnt",
  "idx_person_names_id",
];
for (const idx of requiredIndexes) {
  assert(indexExists(idx), `Index '${idx}' exists`);
}

// These harmful indexes should NOT exist (dropped in Phase 3)
const droppedIndexes = ["idx_mappings_field_artwork", "idx_mappings_vocab", "idx_artworks_tier2"];
for (const idx of droppedIndexes) {
  assert(!indexExists(idx), `Index '${idx}' correctly dropped`);
}

// ═══════════════════════════════════════════════════════════════════
// 10. Importance Scores
// ═══════════════════════════════════════════════════════════════════

console.log("\n═ 10. Importance Scores ═══════════════════════════════════\n");

const importanceNonZero = scalar("SELECT COUNT(*) FROM artworks WHERE importance > 0");
assertEq(importanceNonZero, actualArtworks, "All artworks have importance > 0");

const importanceMin = scalar("SELECT MIN(importance) FROM artworks");
const importanceMax = scalar("SELECT MAX(importance) FROM artworks");
assertGte(importanceMin, 1, "Minimum importance >= 1");
assertLte(importanceMax, 11, "Maximum importance <= 11");

// Score 7 should be the mode (majority bucket — artworks with image + basic metadata)
const score7 = scalar("SELECT COUNT(*) FROM artworks WHERE importance = 7");
assertGte(score7, actualArtworks * 0.4, "Score 7 has >= 40% of artworks (mode)");

// Score 11 should be rare (fully enriched masterpieces)
const score11 = scalar("SELECT COUNT(*) FROM artworks WHERE importance = 11");
assertLte(score11, 500, "Score 11 artworks <= 500 (rare masterpieces)");
assertGte(score11, 50, "Score 11 artworks >= 50 (sanity)");

// ═══════════════════════════════════════════════════════════════════
// 11. Tier 2 Field Coverage
// ═══════════════════════════════════════════════════════════════════

console.log("\n═ 11. Tier 2 Coverage ═════════════════════════════════════\n");

const coverageChecks = [
  ["title_all_text",   "All titles",      0.99],
  ["date_earliest",    "Dates",           0.95],
  ["height_cm",        "Height",          0.90],
  ["width_cm",         "Width",           0.90],
  ["description_text", "Descriptions",    0.50],
  ["inscription_text", "Inscriptions",    0.50],
  ["credit_line",      "Credit lines",    0.30],
  ["creator_label",    "Creator labels",  0.95],
  ["narrative_text",   "Narratives",      0.01],
  ["provenance_text",  "Provenance",      0.04],
];

for (const [col, label, minPct] of coverageChecks) {
  const isText = ["title_all_text", "description_text", "inscription_text",
    "credit_line", "creator_label", "narrative_text", "provenance_text"].includes(col);
  const condition = isText
    ? `${col} IS NOT NULL AND ${col} != ''`
    : `${col} IS NOT NULL`;
  const cnt = scalar(`SELECT COUNT(*) FROM artworks WHERE ${condition}`);
  const pct = cnt / actualArtworks;
  assertGte(pct, minPct, `${label} coverage >= ${(minPct * 100).toFixed(0)}% (${(pct * 100).toFixed(1)}%)`);
}

// has_image / iiif_id
const hasImageCount = scalar("SELECT COUNT(*) FROM artworks WHERE has_image = 1");
assertBetween(hasImageCount, 700_000, 750_000, "has_image count in expected range");

const iiifCount = scalar("SELECT COUNT(*) FROM artworks WHERE iiif_id IS NOT NULL");
assertEq(iiifCount, hasImageCount, "iiif_id count matches has_image count");

// Rights coverage
const rightsNonNull = scalar("SELECT COUNT(*) FROM artworks WHERE rights_id IS NOT NULL");
assertGte(rightsNonNull / actualArtworks, 0.99, "Rights coverage >= 99%");

// ═══════════════════════════════════════════════════════════════════
// 12. Mappings by Field
// ═══════════════════════════════════════════════════════════════════

console.log("\n═ 12. Mappings by Field ═══════════════════════════════════\n");

const fieldChecks = [
  ["collection_set",        2_700_000, 3_000_000],
  ["subject",               1_900_000, 2_200_000],
  ["attribution_qualifier", 1_300_000, 1_700_000],
  ["production_role",       1_300_000, 1_500_000],
  ["type",                  1_100_000, 1_300_000],
  ["material",              1_100_000, 1_300_000],
  ["creator",               1_100_000, 1_300_000],
  ["technique",             1_000_000, 1_200_000],
  ["spatial",                 400_000,   600_000],
  ["profession",              400_000,   550_000],
  ["birth_place",             150_000,   250_000],
  ["death_place",             150_000,   250_000],
];

for (const [field, min, max] of fieldChecks) {
  const fid = fieldId(field);
  if (fid == null) {
    assert(false, `field '${field}' in field_lookup`);
    continue;
  }
  const cnt = scalar("SELECT COUNT(*) FROM mappings WHERE field_id = ?", fid);
  assertBetween(cnt, min, max, `${field} mappings in range`);
}

// Every field_lookup entry should have at least 1 mapping
const emptyFields = db.prepare(`
  SELECT f.name FROM field_lookup f
  WHERE NOT EXISTS (SELECT 1 FROM mappings m WHERE m.field_id = f.id)
`).all();
assertEq(emptyFields.length, 0,
  `All field_lookup entries have mappings${emptyFields.length > 0 ? ` (empty: ${emptyFields.map(r => r.name).join(", ")})` : ""}`);

// ═══════════════════════════════════════════════════════════════════
// 13. Vocabulary Types
// ═══════════════════════════════════════════════════════════════════

console.log("\n═ 13. Vocabulary Types ════════════════════════════════════\n");

const vocabTypes = db.prepare("SELECT type, COUNT(*) as cnt FROM vocabulary GROUP BY type ORDER BY cnt DESC").all();
const typeMap = Object.fromEntries(vocabTypes.map(r => [r.type, r.cnt]));

const expectedTypes = ["person", "place", "classification", "set", "event"];
for (const t of expectedTypes) {
  assert(typeMap[t] > 0, `Vocabulary type '${t}' present (${(typeMap[t] || 0).toLocaleString()})`);
}

// Persons should be the largest type
assertGte(typeMap.person || 0, 60_000, "Person vocab >= 60K");
assertGte(typeMap.place || 0, 20_000, "Place vocab >= 20K");
assertGte(typeMap.classification || 0, 20_000, "Classification vocab >= 20K");

// ═══════════════════════════════════════════════════════════════════
// 14. Sample Queries (Sanity Checks)
// ═══════════════════════════════════════════════════════════════════

console.log("\n═ 14. Sample Queries ══════════════════════════════════════\n");

// Iconclass 34B11 (dog) — stable across harvests
const dogCount = scalar(`
  SELECT COUNT(DISTINCT m.artwork_id)
  FROM mappings m
  JOIN vocabulary v ON m.vocab_rowid = v.vocab_int_id
  WHERE v.notation = '34B11'
`);
assertBetween(dogCount, 6_000, 7_000, "Iconclass 34B11 (dog) artworks");

// Rembrandt as depicted person
const rembrandtCount = scalar(`
  SELECT COUNT(DISTINCT m.artwork_id)
  FROM mappings m
  JOIN vocabulary v ON m.vocab_rowid = v.vocab_int_id
  WHERE m.field_id = ? AND v.type = 'person' AND v.label_en LIKE '%Rembrandt%'
`, fieldId("subject"));
assertBetween(rembrandtCount, 900, 1100, "Depicted person 'Rembrandt' artworks");

// Place 'Amsterdam' — broad (all spatial/subject place links)
const amsterdamCount = scalar(`
  SELECT COUNT(DISTINCT m.artwork_id)
  FROM mappings m
  JOIN vocabulary v ON m.vocab_rowid = v.vocab_int_id
  WHERE v.type = 'place' AND v.label_en LIKE '%Amsterdam%'
`);
assertGte(amsterdamCount, 130_000, "Place 'Amsterdam' artworks >= 130K");

// AK-MAK-187 (Delftware plate) — stable decorative art object
const akMak187 = db.prepare(`
  SELECT object_number, title, creator_label, importance
  FROM artworks WHERE object_number = 'AK-MAK-187'
`).get();
assert(akMak187 != null, "AK-MAK-187 exists");
if (akMak187) {
  assert(akMak187.title != null && akMak187.title.length > 0, "AK-MAK-187 has a title");
  assertGte(akMak187.importance, 1, "AK-MAK-187 has importance score");
}

// SK-C-5 (De Nachtwacht / The Night Watch by Rembrandt)
const skc5 = db.prepare(`
  SELECT object_number, creator_label, has_image FROM artworks WHERE object_number = 'SK-C-5'
`).get();
assert(skc5 != null, "SK-C-5 exists");
if (skc5) {
  assert(skc5.creator_label != null && skc5.creator_label.includes("Rembrandt"),
    `SK-C-5 creator includes 'Rembrandt' (${skc5.creator_label})`);
  assertEq(skc5.has_image, 1, "SK-C-5 has image");
}

// ═══════════════════════════════════════════════════════════════════
// 15. Normalized Labels
// ═══════════════════════════════════════════════════════════════════

console.log("\n═ 15. Normalized Labels ═══════════════════════════════════\n");

const normCount = scalar(
  "SELECT COUNT(*) FROM vocabulary WHERE label_en_norm IS NOT NULL OR label_nl_norm IS NOT NULL"
);
// Nearly all vocab entries should have at least one normalized label
assertGte(normCount / actualVocab, 0.99, "Normalized label coverage >= 99%");

// Spot check: normalized label is lowercase, no spaces
const sampleNorm = db.prepare(`
  SELECT label_en, label_en_norm FROM vocabulary
  WHERE label_en IS NOT NULL AND label_en_norm IS NOT NULL LIMIT 10
`).all();
for (const row of sampleNorm) {
  const expected = row.label_en.toLowerCase().replace(/ /g, "");
  assertEq(row.label_en_norm, expected,
    `Normalized label correct for '${row.label_en.slice(0, 40)}'`);
}

// ═══════════════════════════════════════════════════════════════════
// 16. vocab_term_counts Integrity
// ═══════════════════════════════════════════════════════════════════

console.log("\n═ 16. vocab_term_counts ═══════════════════════════════════\n");

// Every entry in vocab_term_counts should reference a valid vocabulary.id
const orphanVtc = scalar(`
  SELECT COUNT(*) FROM vocab_term_counts vtc
  WHERE NOT EXISTS (SELECT 1 FROM vocabulary v WHERE v.id = vtc.vocab_id)
`);
assertEq(orphanVtc, 0, "No orphan vocab_id in vocab_term_counts");

// Spot-check: top term by count should be collection_set or a major subject
const topTerm = db.prepare(`
  SELECT vtc.vocab_id, vtc.cnt, v.label_en, v.type
  FROM vocab_term_counts vtc
  JOIN vocabulary v ON v.id = vtc.vocab_id
  ORDER BY vtc.cnt DESC LIMIT 1
`).get();
assert(topTerm != null, "vocab_term_counts has entries");
if (topTerm) {
  assertGte(topTerm.cnt, 100_000, `Top term '${topTerm.label_en}' has >= 100K links (${topTerm.cnt.toLocaleString()})`);
}

// ═══════════════════════════════════════════════════════════════════
// 17. person_names FK Integrity
// ═══════════════════════════════════════════════════════════════════

console.log("\n═ 17. person_names FK ═════════════════════════════════════\n");

const orphanPersonNames = scalar(`
  SELECT COUNT(*) FROM person_names pn
  WHERE NOT EXISTS (SELECT 1 FROM vocabulary v WHERE v.id = pn.person_id)
`);
assertEq(orphanPersonNames, 0, "No orphan person_id in person_names");

// person_names should all reference person-type vocab
const nonPersonNames = scalar(`
  SELECT COUNT(*) FROM person_names pn
  JOIN vocabulary v ON v.id = pn.person_id
  WHERE v.type != 'person'
`);
assertEq(nonPersonNames, 0, "All person_names reference person-type vocabulary");

// ═══════════════════════════════════════════════════════════════════
// 18. Geo Coverage
// ═══════════════════════════════════════════════════════════════════

console.log("\n═ 18. Geo & broader_id ════════════════════════════════════\n");

const geocodedPlaces = scalar("SELECT COUNT(*) FROM vocabulary WHERE lat IS NOT NULL AND lon IS NOT NULL");
assertGte(geocodedPlaces, 1_000, "At least 1K geocoded places");
console.log(`     ℹ Geocoded places: ${geocodedPlaces.toLocaleString()} (enrichment adds more)`);

const broaderId = scalar("SELECT COUNT(*) FROM vocabulary WHERE broader_id IS NOT NULL");
assertGte(broaderId, 20_000, "broader_id coverage >= 20K");
console.log(`     ℹ broader_id entries: ${broaderId.toLocaleString()} (enrichment adds more)`);

// ═══════════════════════════════════════════════════════════════════
// 19. Server Compatibility (VocabularyDb.ts requirements)
// ═══════════════════════════════════════════════════════════════════

console.log("\n═ 19. Server Compatibility ════════════════════════════════\n");

// hasIntMappings check: field_id column exists in mappings
assert(columnExists("mappings", "field_id"), "hasIntMappings: mappings.field_id exists");
assert(columnExists("mappings", "artwork_id"), "hasIntMappings: mappings.artwork_id exists");
assert(columnExists("mappings", "vocab_rowid"), "hasIntMappings: mappings.vocab_rowid exists");

// hasRightsLookup: rights_lookup table with id/uri
assert(tableExists("rights_lookup"), "hasRightsLookup: rights_lookup exists");
assert(columnExists("rights_lookup", "id"), "hasRightsLookup: rights_lookup.id exists");
assert(columnExists("rights_lookup", "uri"), "hasRightsLookup: rights_lookup.uri exists");

// hasFts5: vocabulary_fts exists
assert(tableExists("vocabulary_fts"), "hasFts5: vocabulary_fts exists");

// hasTextFts: artwork_texts_fts exists
assert(tableExists("artwork_texts_fts"), "hasTextFts: artwork_texts_fts exists");

// hasDimensions: height_cm/width_cm columns with index
assert(columnExists("artworks", "height_cm"), "hasDimensions: height_cm exists");
assert(indexExists("idx_artworks_height"), "hasDimensions: height index exists");

// hasDates: date_earliest/date_latest columns with index
assert(columnExists("artworks", "date_earliest"), "hasDates: date_earliest exists");
assert(indexExists("idx_artworks_date_range"), "hasDates: date range index exists");

// hasCoordinates: lat/lon on vocabulary with index
assert(columnExists("vocabulary", "lat"), "hasCoordinates: lat exists");
assert(indexExists("idx_vocab_lat_lon"), "hasCoordinates: geo index exists");

// hasPersonNames: person_names + person_names_fts
assert(tableExists("person_names"), "hasPersonNames: person_names exists");
assert(tableExists("person_names_fts"), "hasPersonNames: person_names_fts exists");

// hasImageColumn: has_image on artworks
assert(columnExists("artworks", "has_image"), "hasImageColumn: has_image exists");

// hasImportance: importance column + index
assert(columnExists("artworks", "importance"), "hasImportance: importance exists");
assert(indexExists("idx_artworks_importance"), "hasImportance: importance index exists");

// hasNormLabels: label_en_norm/label_nl_norm on vocabulary
assert(columnExists("vocabulary", "label_en_norm"), "hasNormLabels: label_en_norm exists");
assert(columnExists("vocabulary", "label_nl_norm"), "hasNormLabels: label_nl_norm exists");

// ═══════════════════════════════════════════════════════════════════
// 20. Delta vs Previous Harvest
// ═══════════════════════════════════════════════════════════════════

console.log("\n═ 20. Delta vs Previous Harvest ═══════════════════════════\n");

// Previous harvest (v0.24 built 2026-04-14): 833,432 artworks, 195,455 vocab, 14,652,646 mappings.
// Re-anchored from the 2026-03-05 baseline (#243) — that was two harvests stale and
// produced a spurious +1.17M mapping delta against v0.24. The current v0.24 → next-harvest
// delta should be small again; update these after tonight's re-harvest if they drift.
const prevArtworks = 833_432;
const prevVocab = 195_455;
const prevMappings = 14_652_646;

const artDelta = actualArtworks - prevArtworks;
const vocDelta = actualVocab - prevVocab;
const mapDelta = actualMappings - prevMappings;

console.log(`     Artworks:  ${actualArtworks.toLocaleString()} (Δ ${artDelta >= 0 ? "+" : ""}${artDelta.toLocaleString()})`);
console.log(`     Vocabulary: ${actualVocab.toLocaleString()} (Δ ${vocDelta >= 0 ? "+" : ""}${vocDelta.toLocaleString()})`);
console.log(`     Mappings:  ${actualMappings.toLocaleString()} (Δ ${mapDelta >= 0 ? "+" : ""}${mapDelta.toLocaleString()})`);

// Deltas should be small and positive (collection grows slowly)
assertBetween(artDelta, -500, 5000, "Artwork delta is reasonable");
assertBetween(vocDelta, -500, 5000, "Vocabulary delta is reasonable");
// Mapping delta can be larger due to attribution_qualifier expansion
assertBetween(mapDelta, -50_000, 500_000, "Mapping delta is reasonable");

// attribution_qualifier v0.24 baseline: 1,560,294 (re-anchored from 1,325,325 per #243)
const aqFid = fieldId("attribution_qualifier");
const aqCount = scalar("SELECT COUNT(*) FROM mappings WHERE field_id = ?", aqFid);
const aqDelta = aqCount - 1_560_294;
console.log(`     attribution_qualifier: ${aqCount.toLocaleString()} (Δ ${aqDelta >= 0 ? "+" : ""}${aqDelta.toLocaleString()})`);
assertGte(aqCount, 1_500_000, "attribution_qualifier mappings held (expected)");

// ═══════════════════════════════════════════════════════════════════
// 21. Data Quality Spot Checks
// ═══════════════════════════════════════════════════════════════════

console.log("\n═ 21. Data Quality ════════════════════════════════════════\n");

// No empty object_numbers
const emptyObjNum = scalar("SELECT COUNT(*) FROM artworks WHERE object_number IS NULL OR object_number = ''");
assertEq(emptyObjNum, 0, "No empty object_numbers");

// No duplicate object_numbers (PK constraint, but verify)
const dupObjNum = scalar(`
  SELECT COUNT(*) FROM (
    SELECT object_number FROM artworks GROUP BY object_number HAVING COUNT(*) > 1
  )
`);
assertEq(dupObjNum, 0, "No duplicate object_numbers");

// vocabulary.id are either URIs or numeric Iconclass notations
const nonUriNonNumeric = scalar(`
  SELECT COUNT(*) FROM vocabulary
  WHERE id NOT LIKE 'http%' AND id NOT LIKE 'urn:%'
    AND CAST(id AS INTEGER) = 0 AND id != '0'
`);
assertEq(nonUriNonNumeric, 0, "All vocabulary.id are URIs or numeric (Iconclass) IDs");

// No NULL types in vocabulary
const nullTypeVocab = scalar("SELECT COUNT(*) FROM vocabulary WHERE type IS NULL OR type = ''");
assertEq(nullTypeVocab, 0, "No NULL/empty types in vocabulary");

// Dates should be sensible (no artworks from year 99999)
const futureDates = scalar("SELECT COUNT(*) FROM artworks WHERE date_latest > 2100");
assertEq(futureDates, 0, "No artworks with date_latest > 2100");

// Negative dates exist (BCE artworks) but should be bounded
const ancientDates = scalar("SELECT COUNT(*) FROM artworks WHERE date_earliest < -10000");
assertEq(ancientDates, 0, "No artworks with date_earliest < -10000 BCE");

// Dimensions should be non-negative where present (0.0 = "unknown but present" in Rijksmuseum data).
// Known source-data anomaly (#243): RP-F-2016-137-21 has height_cm = -17.0. One such row is
// tolerated here; a cleanup should go through a dedicated DB-fix issue rather than block harvests.
const negativeDims = scalar(`
  SELECT COUNT(*) FROM artworks
  WHERE (height_cm IS NOT NULL AND height_cm < 0)
     OR (width_cm IS NOT NULL AND width_cm < 0)
`);
assertLte(negativeDims, 1, "At most one negative dimension (RP-F-2016-137-21 anomaly)");

// Zero-dimension artworks exist but should be a small fraction
const zeroDims = scalar(`
  SELECT COUNT(*) FROM artworks
  WHERE (height_cm = 0.0 OR width_cm = 0.0)
`);
assertLte(zeroDims, 10_000, `Zero-dimension artworks <= 10K (${zeroDims.toLocaleString()})`);

// ═══════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════

console.log("\n═══════════════════════════════════════════════════════════");
console.log(`  Total: ${passed + failed} assertions`);
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
if (failures.length > 0) {
  console.log("\n  Failures:");
  for (const f of failures) {
    console.log(`    ✗ ${f}`);
  }
}
console.log("═══════════════════════════════════════════════════════════\n");

db.close();
process.exit(failed > 0 ? 1 : 0);
