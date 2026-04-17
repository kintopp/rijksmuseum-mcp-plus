#!/usr/bin/env node
// #246: Measure overlap between the Rijksmuseum Schema.org person dump and
// the vocabulary.db `person_names` table. Answers the question:
// "what fraction of the 181K dump persons are not already resolved via Phase 2?"
//
// Usage:
//   node scripts/tests/_probe-person-overlap.mjs

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const DUMP_DIR = path.join(
  process.env.HOME,
  'Downloads/rijksmuseum-data-dumps/person_extracted',
);
const DB_PATH = 'data/vocabulary.db';

if (!fs.existsSync(DUMP_DIR)) {
  console.error(`Dump dir missing: ${DUMP_DIR}`);
  process.exit(1);
}
if (!fs.existsSync(DB_PATH)) {
  console.error(`DB missing: ${DB_PATH}`);
  process.exit(1);
}

console.log(`Reading person dump from ${DUMP_DIR}...`);
const t0 = Date.now();
const dumpIds = new Set();
for (const entry of fs.readdirSync(DUMP_DIR)) {
  // Filenames are bare Rijksmuseum entity IDs (e.g. "3101000").
  dumpIds.add(entry);
}
console.log(`  ${dumpIds.size.toLocaleString()} person entries in dump (${Date.now() - t0}ms)`);

const db = new Database(DB_PATH, { readonly: true });

// Sanity check per #246 "binding gotcha": confirm person_id column is TEXT.
const pnTypeof = db.prepare(`SELECT typeof(person_id) AS t FROM person_names LIMIT 1`).get();
console.log(`  person_names.person_id typeof: ${pnTypeof.t}`);

const pnCount = db.prepare(`SELECT COUNT(*) AS c FROM person_names`).get().c;
const pnDistinct = db.prepare(`SELECT COUNT(DISTINCT person_id) AS c FROM person_names`).get().c;
console.log(`  person_names total rows:      ${pnCount.toLocaleString()}`);
console.log(`  distinct person_id values:    ${pnDistinct.toLocaleString()}`);

const pnSet = new Set(
  db
    .prepare(`SELECT DISTINCT person_id FROM person_names`)
    .all()
    .map((r) => String(r.person_id)),
);

let overlap = 0;
const onlyInDump = [];
for (const id of dumpIds) {
  if (pnSet.has(id)) {
    overlap++;
  } else if (onlyInDump.length < 10) {
    onlyInDump.push(id);
  }
}

const pct = (overlap / dumpIds.size * 100).toFixed(1);
const dumpOnly = dumpIds.size - overlap;
const dumpOnlyPct = (dumpOnly / dumpIds.size * 100).toFixed(1);

// Reverse angle: how many person_names IDs are NOT in the dump?
let pnOnly = 0;
for (const id of pnSet) {
  if (!dumpIds.has(id)) pnOnly++;
}
const pnOnlyPct = (pnOnly / pnSet.size * 100).toFixed(1);

console.log(`\nResults (#246):`);
console.log(`  dump ∩ person_names:          ${overlap.toLocaleString()}/${dumpIds.size.toLocaleString()} (${pct}% of dump)`);
console.log(`  dump-only (not in DB):        ${dumpOnly.toLocaleString()} (${dumpOnlyPct}% of dump)`);
console.log(`  person_names-only (not in dump): ${pnOnly.toLocaleString()} (${pnOnlyPct}% of DB distinct person_ids)`);

console.log(`\nSample dump-only IDs (first 10):`);
for (const id of onlyInDump) console.log(`  ${id}`);

// Cross-check: a handful of dump-only IDs — are they at least present in vocabulary at all?
console.log(`\nCross-check: how many of those 10 sample dump-only IDs exist in vocabulary?`);
const vocabLookup = db.prepare(`SELECT id, type, label_en, label_nl FROM vocabulary WHERE id = ?`);
for (const id of onlyInDump) {
  const row = vocabLookup.get(id);
  if (row) {
    console.log(`  ${id}: type=${row.type} label=${row.label_en || row.label_nl}`);
  } else {
    console.log(`  ${id}: NOT in vocabulary`);
  }
}

// Namespace analysis: are dump IDs (3xxx) and person_names IDs (2xxx) disjoint?
console.log(`\nNamespace prefix comparison:`);
console.log(`  dump IDs prefix histogram (top 3):`);
const dumpPrefixes = new Map();
for (const id of dumpIds) {
  const p = id.slice(0, 4);
  dumpPrefixes.set(p, (dumpPrefixes.get(p) || 0) + 1);
}
for (const [p, c] of [...dumpPrefixes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)) {
  console.log(`    ${p}*: ${c.toLocaleString()}`);
}
console.log(`  person_names IDs prefix histogram (top 3):`);
const pnPrefixes = new Map();
for (const id of pnSet) {
  const p = id.slice(0, 4);
  pnPrefixes.set(p, (pnPrefixes.get(p) || 0) + 1);
}
for (const [p, c] of [...pnPrefixes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)) {
  console.log(`    ${p}*: ${c.toLocaleString()}`);
}

// Vocabulary-level counts by namespace (no mappings scan — fast).
console.log(`\nVocabulary person records by namespace:`);
const vocabCount = db.prepare(`
  SELECT COUNT(*) AS c FROM vocabulary WHERE type = 'person' AND id LIKE ?
`);
for (const [label, like] of [['3xxx (Linked Art)', '3%'], ['2xxx (OAI-PMH)', '2%']]) {
  const row = vocabCount.get(like);
  console.log(`  ${label}: ${row.c.toLocaleString()} persons in vocabulary`);
}

db.close();
