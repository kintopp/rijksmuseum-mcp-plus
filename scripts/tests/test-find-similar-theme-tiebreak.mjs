#!/usr/bin/env node
// Regression for #313 — Theme channel must apply the importance tie-break
// across the full candidate set, not an arbitrary pre-slice.
//
// Pre-fix behaviour: candidates were sorted by totalWeight only, sliced to
// maxResults*OVERFETCH (=40 at default page size), then importance was loaded
// for that subset. For seeds with high-DF themes, tie groups can exceed 40
// and high-importance peers outside the slice were silently dropped.
//
// Post-fix: importance is loaded for ALL candidates and used in a single
// global sort. This test asserts that the API's top-N art_ids match an
// oracle computed by replicating the algorithm with full-population
// importance ordering.

import path from "node:path";
import Database from "better-sqlite3";
import { VocabularyDb } from "../../dist/api/VocabularyDb.js";

const DB_PATH = path.resolve(process.cwd(), "data/vocabulary.db");
const SEED = "SK-A-1115"; // 3 themes incl. high-DF "military history"
const MAX_RESULTS = 10;
const THEME_FIELD_ID = 14;

let failures = 0;
function check(label, ok, why = "") {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok ? "" : ` — ${why}`}`);
  if (!ok) failures++;
}

const raw = new Database(DB_PATH, { readonly: true });

const seedRow = raw.prepare("SELECT art_id FROM artworks WHERE object_number = ?").get(SEED);
if (!seedRow) { console.error(`Seed ${SEED} not found`); process.exit(1); }
const seedArtId = seedRow.art_id;

const themeN = raw.prepare(
  "SELECT COUNT(DISTINCT artwork_id) AS n FROM mappings WHERE field_id = ?"
).get(THEME_FIELD_ID).n;

const seedThemes = raw.prepare(
  "SELECT vocab_rowid FROM mappings WHERE artwork_id = ? AND field_id = ?"
).all(seedArtId, THEME_FIELD_ID).map(r => r.vocab_rowid);

if (seedThemes.length < 2) {
  console.error(`Seed ${SEED} has <2 themes — pick a different seed`);
  process.exit(1);
}

// Oracle: aggregate totalWeight per candidate across ALL shared-theme matches,
// then sort globally by (totalWeight desc, importance desc).
const stmtPeers = raw.prepare(
  "SELECT artwork_id FROM mappings WHERE field_id = ? AND vocab_rowid = ?"
);
const dfStmt = raw.prepare(
  "SELECT COUNT(DISTINCT artwork_id) AS df FROM mappings WHERE field_id = ? AND vocab_rowid = ?"
);

const candidates = new Map(); // art_id → totalWeight
for (const themeId of seedThemes) {
  const df = dfStmt.get(THEME_FIELD_ID, themeId).df || 1;
  const idf = Math.log(themeN / df);
  for (const { artwork_id } of stmtPeers.all(THEME_FIELD_ID, themeId)) {
    if (artwork_id === seedArtId) continue;
    candidates.set(artwork_id, (candidates.get(artwork_id) ?? 0) + idf);
  }
}

const allArtIds = [...candidates.keys()];
const importance = new Map();
const CHUNK = 500;
for (let i = 0; i < allArtIds.length; i += CHUNK) {
  const chunk = allArtIds.slice(i, i + CHUNK);
  const placeholders = chunk.map(() => "?").join(",");
  const rows = raw.prepare(
    `SELECT art_id, importance FROM artworks WHERE art_id IN (${placeholders})`
  ).all(...chunk);
  for (const r of rows) importance.set(r.art_id, r.importance ?? 0);
}

const oracle = [...candidates.entries()]
  .sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return (importance.get(b[0]) ?? 0) - (importance.get(a[0]) ?? 0);
  })
  .slice(0, MAX_RESULTS)
  .map(([artId]) => artId);

const cutoffWeight = candidates.get(oracle[oracle.length - 1]);
const tieGroupSize = [...candidates.values()].filter(w => w === cutoffWeight).length;
console.log(`\n=== Theme tie-break regression (#313) ===`);
console.log(`  seed=${SEED} themes=${seedThemes.length} candidates=${candidates.size}`);
console.log(`  cutoff totalWeight=${cutoffWeight.toFixed(4)}, tie-group size at cutoff=${tieGroupSize}`);

// Validity guard: the test only exercises the bug if the candidate pool exceeds
// the pre-fix 40-slice. Assert that here so a future DB change doesn't silently
// neuter the regression.
check("candidate pool > 40 (pre-fix would have truncated)", candidates.size > 40,
  `candidate pool is only ${candidates.size}; this seed no longer exercises the bug`);

// Run the API.
const db = new VocabularyDb();
db.warmSimilarCaches();
const apiRes = db.findSimilarByTheme(SEED, MAX_RESULTS);
if (!apiRes) { console.error("findSimilarByTheme returned null"); process.exit(1); }

// Resolve API result objectNumbers → art_ids for comparison.
const apiObjs = apiRes.results.map(r => r.objectNumber);
const stmtArtId = raw.prepare("SELECT art_id FROM artworks WHERE object_number = ?");
const apiArtIds = apiObjs.map(on => stmtArtId.get(on).art_id);

// Set equality (order may vary at deepest importance ties — irrelevant to the bug).
const oracleSet = new Set(oracle);
const apiSet = new Set(apiArtIds);
const missing = oracle.filter(id => !apiSet.has(id));
const extra = apiArtIds.filter(id => !oracleSet.has(id));
check("API top-N set matches global-importance oracle",
  missing.length === 0 && extra.length === 0,
  `missing from API: ${JSON.stringify(missing)} | extra in API: ${JSON.stringify(extra)}`);

// Within the API result, verify (totalWeight desc, importance desc) is honoured.
const scores = apiRes.results.map(r => r.score);
check("API scores monotonically non-increasing",
  scores.every((s, i) => i === 0 || s <= scores[i - 1]),
  `scores: ${scores.join(",")}`);

const apiImportance = apiArtIds.map(id => importance.get(id) ?? 0);
let inversion = -1;
for (let i = 1; i < apiArtIds.length; i++) {
  if (scores[i] === scores[i - 1] && apiImportance[i] > apiImportance[i - 1]) {
    inversion = i;
    break;
  }
}
check("within tied score windows, importance is non-increasing",
  inversion === -1,
  `tie inversion at position ${inversion}: scores=${scores[inversion - 1]}/${scores[inversion]} importance=${apiImportance[inversion - 1]}/${apiImportance[inversion]}`);

raw.close();

console.log(`\n${failures === 0 ? "✓ all theme tie-break checks passed" : `✗ ${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
