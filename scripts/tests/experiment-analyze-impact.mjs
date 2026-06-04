#!/usr/bin/env node
/**
 * experiment-analyze-impact.mjs — does shipping ANALYZE (sqlite_stat1) let the
 * planner pick the right provenance driver on its own, removing the need for the
 * hand-coded `conditions.length === 0` IN-vs-EXISTS heuristic at
 * VocabularyDb.ts:4286? And does it regress the rare-co-filter case?
 *
 * Compares a stat-free DB against an ANALYZEd copy across the collection_stats
 * temp-table build (no LIMIT). For each co-filter, runs BOTH the correlated
 * EXISTS form (what the code emits when any co-filter is present) and the driving
 * IN form, on both DBs, with EXPLAIN + warm timing.
 *
 * Key questions:
 *   (a) On the ANALYZEd DB, does the EXISTS form for +imageAvailable / +broad now
 *       drive from the 48K provenance set on its own (i.e. ANALYZE fixes the bug)?
 *   (b) Does the EXISTS form for +rare-creator still stay fast (no regression)?
 *   (c) Do EXISTS and IN converge on the ANALYZEd DB (→ heuristic removable)?
 *
 * Usage: node scripts/tests/experiment-analyze-impact.mjs <stat-free.db> <analyzed.db>
 */
import Database from "better-sqlite3";

const [, , FREE_DB, ANALYZED_DB] = process.argv;
if (!FREE_DB || !ANALYZED_DB) {
  console.error("Usage: experiment-analyze-impact.mjs <stat-free.db> <analyzed.db>");
  process.exit(1);
}

const free = new Database(FREE_DB, { readonly: true });
const ana = new Database(ANALYZED_DB, { readonly: true });
for (const d of [free, ana]) d.pragma("mmap_size=1073741824");

const EXISTS_PROV = "EXISTS (SELECT 1 FROM provenance_events WHERE artwork_id = a.art_id)";
const IN_PROV = "a.art_id IN (SELECT artwork_id FROM provenance_events)";

const creatorFieldId = free.prepare("SELECT id FROM field_lookup WHERE name='creator'").get().id;
const typeFieldId = free.prepare("SELECT id FROM field_lookup WHERE name='type'").get().id;
const broadType = free.prepare(
  "SELECT vocab_rowid AS rowid, COUNT(*) c FROM mappings WHERE field_id=? GROUP BY vocab_rowid ORDER BY c DESC LIMIT 1",
).get(typeFieldId);
const rareCreator = free.prepare(
  `SELECT m.vocab_rowid AS rowid, COUNT(DISTINCT m.artwork_id) AS c
   FROM mappings m WHERE m.field_id=? AND m.artwork_id IN (SELECT artwork_id FROM provenance_events)
   GROUP BY m.vocab_rowid HAVING c BETWEEN 3 AND 24 ORDER BY c DESC LIMIT 1`,
).get(creatorFieldId);

const mappingsIn = (fid, rid) => ({
  sql: " AND a.art_id IN (SELECT m.artwork_id FROM mappings m WHERE m.field_id = ? AND m.vocab_rowid IN (?))",
  binds: [fid, rid],
});

const SCENARIOS = [
  { tag: "alone", co: { sql: "", binds: [] } },
  { tag: "+imageAvailable (has_image=1, ~87.5%)", co: { sql: " AND a.has_image = 1", binds: [] } },
  { tag: `+broad type:print (~${broadType.c.toLocaleString()})`, co: mappingsIn(typeFieldId, broadType.rowid) },
  { tag: `+rare creator (overlap ${rareCreator?.c ?? "n/a"})`, co: rareCreator ? mappingsIn(creatorFieldId, rareCreator.rowid) : null },
];

/** Build+count the temp table 3× warm; return ms of the last run. */
function timeBuild(db, where, binds) {
  let ms = 0;
  for (let i = 0; i < 3; i++) {
    db.exec("DROP TABLE IF EXISTS _t");
    const t = process.hrtime.bigint();
    db.prepare(`CREATE TEMP TABLE _t AS SELECT a.art_id FROM artworks a WHERE ${where}`).run(...binds);
    db.prepare("SELECT COUNT(*) n FROM _t").get();
    ms = Number(process.hrtime.bigint() - t) / 1e6;
  }
  db.exec("DROP TABLE IF EXISTS _t");
  return ms;
}

/** One-line summary of the plan's driver: the first SCAN/SEARCH on a real table. */
function driver(plan) {
  const line = plan.map((r) => r.detail).find((d) => /\b(SCAN|SEARCH)\b/.test(d) && !/SUBQUERY|BLOOM/.test(d));
  return (line || plan[0]?.detail || "?").replace(/USING /, "");
}

function probe(db, where, binds) {
  const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT a.art_id FROM artworks a WHERE ${where}`).all(...binds);
  return { ms: timeBuild(db, where, binds), driver: driver(plan), plan };
}

console.log(`stat-free : ${FREE_DB}`);
console.log(`ANALYZEd  : ${ANALYZED_DB}\n`);

for (const s of SCENARIOS) {
  if (!s.co) { console.log(`### ${s.tag} — skipped (no rare creator found)\n`); continue; }
  console.log("=".repeat(80));
  console.log(`### Scenario: hasProvenance ${s.tag}`);
  const cells = {};
  for (const [dbName, db] of [["stat-free", free], ["ANALYZED ", ana]]) {
    for (const [form, frag] of [["EXISTS", EXISTS_PROV], ["IN    ", IN_PROV]]) {
      const r = probe(db, frag + s.co.sql, s.co.binds);
      cells[`${dbName}|${form}`] = r;
      console.log(`  ${dbName}  ${form}:  ${r.ms.toFixed(1).padStart(7)}ms   ${r.driver}`);
    }
  }
  // Verdict: on the ANALYZED DB, does the EXISTS form (what the code emits with a
  // co-filter) match or beat the best stat-free choice?
  const anaExists = cells["ANALYZED |EXISTS"].ms;
  const anaIn = cells["ANALYZED |IN    "].ms;
  const freeBest = Math.min(cells["stat-free|EXISTS"].ms, cells["stat-free|IN    "].ms);
  const converged = Math.abs(anaExists - anaIn) / Math.max(anaExists, anaIn) < 0.5;
  console.log(
    `  → ANALYZED EXISTS=${anaExists.toFixed(0)}ms IN=${anaIn.toFixed(0)}ms ` +
    `(stat-free best=${freeBest.toFixed(0)}ms); EXISTS≈IN? ${converged ? "YES — planner self-corrects" : "NO — form still matters"}\n`,
  );
}

free.close();
ana.close();
