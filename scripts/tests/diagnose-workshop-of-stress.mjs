#!/usr/bin/env node
/**
 * Stress-test the EXISTS→IN-subquery rewrite across qualifier frequencies and
 * creator breadth, to confirm the driving-subquery plan holds (doesn't flip back
 * to the importance-index walk #372-style) as the match set grows.
 */
import Database from "better-sqlite3";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = new Database(resolve(__dirname, "../../data/vocabulary.db"), { readonly: true });
db.pragma("mmap_size=1073741824");

function creatorIdsFor(prefix) {
  return db.prepare(
    `SELECT DISTINCT id FROM vocabulary WHERE type IN ('person','organisation')
       AND (label_en LIKE ? OR label_nl LIKE ?)`
  ).all(prefix + "%", prefix + "%").map(r => r.id);
}
function qualIdsFor(labelEn) {
  return db.prepare(
    `SELECT DISTINCT ap.qualifier_id AS id FROM assignment_pairs ap
       JOIN vocabulary v ON ap.qualifier_id = v.id WHERE v.label_en = ?`
  ).all(labelEn).map(r => r.id);
}

const SELECT = "SELECT a.object_number, a.title, a.creator_label FROM artworks a";

function run(label, qualIds, creatorIds) {
  const cPh = creatorIds.map(() => "?").join(",");
  const qPh = qualIds.map(() => "?").join(",");
  const matchCount = db.prepare(
    `SELECT COUNT(DISTINCT artwork_id) n FROM assignment_pairs
       WHERE qualifier_id IN (${qPh}) AND creator_id IN (${cPh})`
  ).get(...qualIds, ...creatorIds).n;

  const existsSql = `${SELECT} WHERE EXISTS (SELECT 1 FROM assignment_pairs ap ` +
    `WHERE ap.artwork_id = a.art_id AND ap.creator_id IN (${cPh}) AND ap.qualifier_id IN (${qPh})) ` +
    `ORDER BY a.importance DESC, a.art_id ASC LIMIT ?`;
  const inSql = `${SELECT} WHERE a.art_id IN (SELECT ap.artwork_id FROM assignment_pairs ap ` +
    `WHERE ap.qualifier_id IN (${qPh}) AND ap.creator_id IN (${cPh})) ` +
    `ORDER BY a.importance DESC, a.art_id ASC LIMIT ?`;

  const time = (sql, binds) => {
    let rows, ms;
    for (let i = 0; i < 2; i++) {
      const t = process.hrtime.bigint();
      rows = db.prepare(sql).all(...binds);
      ms = Number(process.hrtime.bigint() - t) / 1e6;
    }
    return { n: rows.length, ms };
  };
  const planLead = (sql, binds) =>
    db.prepare("EXPLAIN QUERY PLAN " + sql).all(...binds)[0]?.detail ?? "(none)";

  const e = time(existsSql, [...creatorIds, ...qualIds, 25]);
  const i = time(inSql, [...qualIds, ...creatorIds, 25]);
  console.log(`\n### ${label}  (creators=${creatorIds.length}, qualPairs match=${matchCount})`);
  console.log(`  EXISTS  lead=[${planLead(existsSql, [...creatorIds, ...qualIds, 25])}]`);
  console.log(`          rows=${e.n}  ${e.ms.toFixed(1)}ms`);
  console.log(`  IN-sub  lead=[${planLead(inSql, [...qualIds, ...creatorIds, 25])}]`);
  console.log(`          rows=${i.n}  ${i.ms.toFixed(1)}ms`);
  console.log(`  speedup: ${(e.ms / Math.max(i.ms, 0.01)).toFixed(0)}x`);
}

run("workshop of + Rembrandt",  qualIdsFor("workshop of"),  creatorIdsFor("Rembrandt"));
run("after + Rembrandt (common qual)", qualIdsFor("after"),  creatorIdsFor("Rembrandt"));
run("attributed to + Rembrandt", qualIdsFor("attributed to"), creatorIdsFor("Rembrandt"));
run("after + van (very broad creator)", qualIdsFor("after"), creatorIdsFor("van"));

db.close();
