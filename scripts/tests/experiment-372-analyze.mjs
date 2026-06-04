#!/usr/bin/env node
/**
 * experiment-372-analyze.mjs — does ANALYZE regress the #372 FTS-drive guard?
 *
 * #372: search_artwork with a textQuery (FTS) + a broad vocab filter (type:print
 * ≈ 369K artworks) hung for minutes because the planner drove from the vocab
 * `a.art_id IN (…)` and probed the FTS per row. The fix is a unary-`+` rewrite
 * (searchInternal) that strips index-usability so FTS must drive. That guard is
 * structural — but ANALYZE could still perturb the plan. This captures the REAL
 * emitted search SQL, EXPLAINs it on the stat-free DB and the ANALYZEd copy, and
 * checks FTS still drives on both. It also times the real query end-to-end.
 *
 * Usage: VOCAB_DB_PATH=<db> node experiment-372-analyze.mjs <stat-free.db> <analyzed.db>
 *   (VOCAB_DB_PATH selects the DB the VocabularyDb instance runs/times against.)
 */
import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { captureSql } from "./query-plan-utils.mjs";

const [, , FREE_DB, ANALYZED_DB] = process.argv;
const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { VocabularyDb } = await import(path.join(PROJECT_DIR, "dist/api/VocabularyDb.js"));

const db = new VocabularyDb();
const QUERY = { textQuery: { should: [{ field: "description", any: ["zee", "schip"] }] }, type: "print", maxResults: 25 };

// Capture the real emitted search SQL + time the end-to-end query (guard applies).
const t0 = process.hrtime.bigint();
let sqls;
const result = (() => {
  let r;
  sqls = captureSql(() => { r = db.searchCompact(QUERY); });
  return r;
})();
const liveMs = Number(process.hrtime.bigint() - t0) / 1e6;
console.log(`live searchCompact against VOCAB_DB_PATH: ${result.totalResults ?? result.ids.length} hits, ${liveMs.toFixed(0)}ms\n`);

// The outer search query: joins the FTS rank table and has the unary-+ guarded conditions.
const searchSql = sqls.find((s) => /FROM artworks a/.test(s) && /MATCH/.test(s) && /ORDER BY/.test(s));
if (!searchSql) {
  console.error("could not capture the FTS search SQL (shape changed?)");
  process.exit(1);
}
console.log("unary-+ guard present in emitted SQL?", /\+a\.art_id IN \(/.test(searchSql) ? "YES" : "NO");

// EXPLAIN on both DBs. Substitute MATCH ? with a literal, other ? with 1.
const explainable = searchSql.replace(/MATCH \?/g, "MATCH '\"zee\"'").replace(/\?/g, "1");
for (const [name, file] of [["stat-free", FREE_DB], ["ANALYZED ", ANALYZED_DB]]) {
  const xdb = new Database(file, { readonly: true });
  xdb.function("haversine_km", () => 0);
  const plan = xdb.prepare("EXPLAIN QUERY PLAN " + explainable).all();
  xdb.close();
  const firstOp = plan[0]?.detail ?? "?";
  console.log(`\n${name}: first op → ${firstOp}`);
  console.log(`  FTS appears to drive? ${/fts/i.test(firstOp) || /MATCH|VIRTUAL/.test(firstOp) ? "YES (first op is FTS)" : "check full plan ↓"}`);
  for (const r of plan) console.log(`    ${r.detail}`);
}
