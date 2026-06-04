#!/usr/bin/env node
/**
 * diagnose-stats-provenance-plan.mjs — audit the collection_stats provenance
 * EXISTS clauses (VocabularyDb.ts:4274/4277/4294) for the correlated-vs-driving
 * question, in the FULL-SCAN context (no ORDER BY importance, no LIMIT).
 *
 * collection_stats builds `CREATE TEMP TABLE _stats AS SELECT a.art_id FROM
 * artworks a WHERE <conds>` then COUNTs it. Unlike searchInternal there is no
 * LIMIT, so the importance-walk cliff cannot fire — but a correlated EXISTS over
 * hasProvenance:true still forces a 834K-row scan probing the PK per row, whereas
 * a driving `a.art_id IN (SELECT artwork_id FROM provenance_events)` could let the
 * planner scan the 48K provenance set instead. This measures whether that helps,
 * and crucially whether it regresses the combined (rare-vocab) case.
 *
 * BOUND params (the CLI inlines literals — see #372).
 */
import Database from "better-sqlite3";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB = resolve(__dirname, "../../data/vocabulary.db");
const db = new Database(DB, { readonly: true });
db.pragma("mmap_size=1073741824");

const EXISTS_PROV = "EXISTS (SELECT 1 FROM provenance_events WHERE artwork_id = a.art_id)";
const IN_PROV = "a.art_id IN (SELECT artwork_id FROM provenance_events)";

// A non-rare co-filter (type:"print") and a rare-ish one (rare creator) to mirror
// the collection_stats "dimension over a filtered subset" usage.
const creatorFieldId = db.prepare("SELECT id FROM field_lookup WHERE name='creator'").get().id;
const typeFieldId = db.prepare("SELECT id FROM field_lookup WHERE name='type'").get().id;
// Broad type vocab_rowid (most rows) and a rare creator vocab_rowid.
const broadType = db.prepare(`
  SELECT vocab_rowid AS rowid, COUNT(*) c FROM mappings WHERE field_id=? GROUP BY vocab_rowid ORDER BY c DESC LIMIT 1
`).get(typeFieldId);
const rareCreator = db.prepare(`
  SELECT m.vocab_rowid AS rowid, COUNT(DISTINCT m.artwork_id) AS c
  FROM mappings m WHERE m.field_id=? AND m.artwork_id IN (SELECT artwork_id FROM provenance_events)
  GROUP BY m.vocab_rowid HAVING c BETWEEN 3 AND 24 ORDER BY c DESC LIMIT 1
`).get(creatorFieldId);
console.log("broad type rowid/count:", broadType, " rare creator rowid/overlap:", rareCreator, "\n");

function mappingsIn(fieldId, rowid) {
  return { sql: `a.art_id IN (SELECT m.artwork_id FROM mappings m WHERE m.field_id = ? AND m.vocab_rowid IN (?))`, binds: [fieldId, rowid] };
}

const scenarios = [
  { tag: "A", desc: "hasProvenance alone", extra: null },
  { tag: "B", desc: "hasProvenance + broad type:print", extra: mappingsIn(typeFieldId, broadType.rowid) },
  { tag: "C", desc: `hasProvenance + rare creator (overlap=${rareCreator?.c})`, extra: rareCreator ? mappingsIn(creatorFieldId, rareCreator.rowid) : null },
].filter(s => s.extra !== undefined || s.tag === "A");

function run(label, where, binds) {
  // Mirror collection_stats: CREATE TEMP TABLE AS SELECT ... WHERE, then COUNT.
  const buildSql = `CREATE TEMP TABLE _t AS SELECT a.art_id FROM artworks a WHERE ${where}`;
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT a.art_id FROM artworks a WHERE " + where).all(...binds);
  let cnt, ms;
  for (let i = 0; i < 3; i++) {
    db.exec("DROP TABLE IF EXISTS _t");
    const t = process.hrtime.bigint();
    db.prepare(buildSql).run(...binds);
    cnt = db.prepare("SELECT COUNT(*) n FROM _t").get().n;
    ms = Number(process.hrtime.bigint() - t) / 1e6;
  }
  db.exec("DROP TABLE IF EXISTS _t");
  console.log(`  ${label}`);
  for (const p of plan) console.log(`     PLAN: ${p.detail}`);
  console.log(`     COUNT=${cnt}  TIME(warm build+count)=${ms.toFixed(1)}ms\n`);
  return ms;
}

for (const s of scenarios) {
  console.log("=".repeat(78));
  console.log(`Scenario ${s.tag}: ${s.desc}`);
  const extraSql = s.extra ? ` AND ${s.extra.sql}` : "";
  const extraBinds = s.extra ? s.extra.binds : [];
  const e = run("CURRENT  EXISTS-provenance", `${EXISTS_PROV}${extraSql}`, [...extraBinds]);
  const i = run("PROPOSED IN-provenance", `${IN_PROV}${extraSql}`, [...extraBinds]);
  console.log(`  → EXISTS ${e.toFixed(1)}ms vs IN ${i.toFixed(1)}ms  (${e > i ? "IN faster by " + (e / i).toFixed(1) + "×" : "EXISTS faster by " + (i / e).toFixed(1) + "×"})\n`);
}

db.close();
