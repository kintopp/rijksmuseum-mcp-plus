#!/usr/bin/env node
/**
 * diagnose-workshop-of.mjs — Reproduce + diagnose the slow
 * `attributionQualifier:"workshop of" + creator:"Rembrandt"` query.
 *
 * Uses better-sqlite3 with BOUND parameters (the sqlite3 CLI inlines literals and
 * picks the good plan, so it cannot reproduce the runtime regression — see #372).
 *
 * Tests four query variants for the same selective same-row predicate:
 *   Q1  correlated EXISTS, ORDER BY a.importance DESC          (as generated today)
 *   Q2  correlated EXISTS, ORDER BY +a.importance DESC         (block importance index)
 *   Q3  a.art_id IN (subquery), ORDER BY a.importance DESC     (driving subquery)
 *   Q4  a.art_id IN (subquery), ORDER BY +a.importance DESC    (driving + block index)
 */
import Database from "better-sqlite3";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB = resolve(__dirname, "../../data/vocabulary.db");

const db = new Database(DB, { readonly: true });
db.pragma("mmap_size=1073741824");

// Resolve creator IDs for "Rembrandt" the way the runtime broadly would:
// person/org vocabulary whose label or alt-name matches. We approximate with a
// LIKE sweep over vocabulary labels + entity_alt_names (if present). The exact id
// set does not change the query PLAN; it only shifts the match-set size a little.
const creatorRows = db.prepare(
  `SELECT DISTINCT id FROM vocabulary
   WHERE type IN ('person','organisation')
     AND (label_en LIKE 'Rembrandt%' OR label_nl LIKE 'Rembrandt%')`
).all();
const creatorIds = creatorRows.map(r => r.id);

// "workshop of" qualifier IDs actually present in assignment_pairs.
const qualRows = db.prepare(
  `SELECT DISTINCT ap.qualifier_id AS id
   FROM assignment_pairs ap JOIN vocabulary v ON ap.qualifier_id = v.id
   WHERE v.label_en = 'workshop of'`
).all();
const qualIds = qualRows.map(r => r.id);

console.log("creatorIds:", creatorIds);
console.log("qualIds:", qualIds);

// Selectivity: how many distinct artworks actually match?
const cPh = creatorIds.map(() => "?").join(",");
const qPh = qualIds.map(() => "?").join(",");
const matchCount = db.prepare(
  `SELECT COUNT(DISTINCT artwork_id) n FROM assignment_pairs
   WHERE qualifier_id IN (${qPh}) AND creator_id IN (${cPh})`
).get(...qualIds, ...creatorIds).n;
console.log(`\nMatching artworks (true result-set size): ${matchCount}`);
console.log(`Out of 834,435 artworks → selectivity ${(matchCount / 834435 * 100).toFixed(4)}%\n`);

const SELECT = "SELECT a.object_number, a.title, a.creator_label FROM artworks a";
const EXISTS_WHERE =
  `WHERE EXISTS (SELECT 1 FROM assignment_pairs ap WHERE ap.artwork_id = a.art_id ` +
  `AND ap.creator_id IN (${cPh}) AND ap.qualifier_id IN (${qPh}))`;
const IN_WHERE =
  `WHERE a.art_id IN (SELECT ap.artwork_id FROM assignment_pairs ap ` +
  `WHERE ap.qualifier_id IN (${qPh}) AND ap.creator_id IN (${cPh}))`;

const variants = [
  { name: "Q1 EXISTS + ORDER BY a.importance DESC (as generated)",
    sql: `${SELECT} ${EXISTS_WHERE} ORDER BY a.importance DESC, a.art_id ASC LIMIT ?`,
    binds: [...creatorIds, ...qualIds, 25] },
  { name: "Q2 EXISTS + ORDER BY +a.importance DESC (block index)",
    sql: `${SELECT} ${EXISTS_WHERE} ORDER BY +a.importance DESC, a.art_id ASC LIMIT ?`,
    binds: [...creatorIds, ...qualIds, 25] },
  { name: "Q3 art_id IN (subquery) + ORDER BY a.importance DESC",
    sql: `${SELECT} ${IN_WHERE} ORDER BY a.importance DESC, a.art_id ASC LIMIT ?`,
    binds: [...qualIds, ...creatorIds, 25] },
  { name: "Q4 art_id IN (subquery) + ORDER BY +a.importance DESC",
    sql: `${SELECT} ${IN_WHERE} ORDER BY +a.importance DESC, a.art_id ASC LIMIT ?`,
    binds: [...qualIds, ...creatorIds, 25] },
];

for (const v of variants) {
  console.log("=".repeat(70));
  console.log(v.name);
  const plan = db.prepare("EXPLAIN QUERY PLAN " + v.sql).all(...v.binds);
  for (const p of plan) console.log("  PLAN:", p.detail);
  // time it (run twice; report second/warm)
  let rows;
  for (let i = 0; i < 2; i++) {
    const t = process.hrtime.bigint();
    rows = db.prepare(v.sql).all(...v.binds);
    var ms = Number(process.hrtime.bigint() - t) / 1e6;
  }
  console.log(`  ROWS: ${rows.length}   TIME(warm): ${ms.toFixed(1)}ms`);
}

db.close();
