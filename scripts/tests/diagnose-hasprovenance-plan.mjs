#!/usr/bin/env node
/**
 * diagnose-hasprovenance-plan.mjs — audit the `hasProvenance:true` correlated
 * EXISTS (#375 follow-up) for the same importance-walk pathology that bc9ac8b
 * fixed for the same-row attribution path.
 *
 * buildVocabConditions() emits, for hasProvenance:true:
 *     EXISTS (SELECT 1 FROM provenance_events WHERE artwork_id = a.art_id)
 * feeding searchInternal's `ORDER BY a.importance DESC, a.art_id ASC LIMIT N`.
 *
 * #375 flags this as "lower risk (~48K artworks, not rare, can't be used alone),
 * but combined with another rare filter + ORDER BY importance it could surface
 * the same walk." This script tests that empirically with BOUND params (the
 * sqlite3 CLI inlines literals and picks the good plan — see #372), comparing the
 * current correlated EXISTS against a driving `a.art_id IN (SELECT ...)` form.
 *
 * Scenarios (all under ORDER BY a.importance DESC, a.art_id ASC LIMIT 25):
 *   A  hasProvenance alone                          (baseline; 5.8% → early-terminates)
 *   B  hasProvenance + rare creator (mappings IN)   (co-filter brings a driving subquery)
 *   C  hasProvenance + narrow date range            (only artworks-column predicates)
 *   D  hasProvenance + rare type (mappings IN)       (second driving-subquery case)
 */
import Database from "better-sqlite3";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB = resolve(__dirname, "../../data/vocabulary.db");
const db = new Database(DB, { readonly: true });
db.pragma("mmap_size=1073741824");

const TOTAL = db.prepare("SELECT COUNT(*) n FROM artworks").get().n;
const PROV = db.prepare("SELECT COUNT(DISTINCT artwork_id) n FROM provenance_events").get().n;
console.log(`artworks=${TOTAL}  artworks-with-provenance=${PROV} (${(PROV / TOTAL * 100).toFixed(1)}%)\n`);

// hasProvenance, two forms
const EXISTS_PROV = "EXISTS (SELECT 1 FROM provenance_events WHERE artwork_id = a.art_id)";
const IN_PROV = "a.art_id IN (SELECT artwork_id FROM provenance_events)";

const SELECT = "SELECT a.object_number, a.title, a.creator_label FROM artworks a";
const TAIL = "ORDER BY a.importance DESC, a.art_id ASC LIMIT ?";

// ── resolve a rare creator (person vocab) that overlaps provenance, combined <25 ──
function fieldIdFor(name) {
  const r = db.prepare("SELECT id FROM field_lookup WHERE name = ?").get(name);
  return r ? r.id : null;
}
const creatorFieldId = fieldIdFor("creator") ?? fieldIdFor("creators") ?? fieldIdFor("attribution");
const typeFieldId = fieldIdFor("type") ?? fieldIdFor("types") ?? fieldIdFor("object_type");
console.log("field ids:", { creatorFieldId, typeFieldId });

// Find a rare person whose (creator ∩ provenance) count is in (0, 25).
function rareVocabRowid(fieldId) {
  if (fieldId == null) return null;
  // sample vocab rowids used by this field, joined to provenance, count overlap
  const rows = db.prepare(`
    SELECT m.vocab_rowid AS rowid, COUNT(DISTINCT m.artwork_id) AS overlap
    FROM mappings m
    WHERE +m.field_id = ?
      AND m.artwork_id IN (SELECT artwork_id FROM provenance_events)
    GROUP BY m.vocab_rowid
    HAVING overlap BETWEEN 3 AND 24
    ORDER BY overlap DESC
    LIMIT 1
  `).get(fieldId);
  return rows ? { rowid: rows.rowid, overlap: rows.overlap } : null;
}

// ── find a narrow date window with (date-overlap ∩ provenance) in (0, 25) ──
function rareDateWindow() {
  for (let start = 1350; start <= 1500; start += 10) {
    const lo = start, hi = start + 9;
    const cnt = db.prepare(`
      SELECT COUNT(*) n FROM artworks a
      WHERE a.date_earliest IS NOT NULL AND a.date_latest >= ? AND a.date_earliest <= ?
        AND ${EXISTS_PROV}
    `).get(lo, hi).n;
    if (cnt > 0 && cnt < 25) return { lo, hi, cnt };
  }
  return null;
}

const rareCreator = rareVocabRowid(creatorFieldId);
const rareType = rareVocabRowid(typeFieldId);
const dateWin = rareDateWindow();
console.log("rare creator:", rareCreator, " rare type:", rareType, " date window:", dateWin, "\n");

function mappingsIn(fieldId, rowid) {
  // Mirrors mappingFilterDirect → buildFieldClause(fields) with noFieldIndex=false:
  // plain `m.field_id = ?` so the planner can seek idx_mappings_field_vocab(field_id, vocab_rowid).
  return {
    sql: `a.art_id IN (SELECT m.artwork_id FROM mappings m WHERE m.field_id = ? AND m.vocab_rowid IN (?))`,
    binds: [fieldId, rowid],
  };
}

const scenarios = [];
scenarios.push({ tag: "A", desc: "hasProvenance alone", extra: null });
if (rareCreator) scenarios.push({ tag: "B", desc: `hasProvenance + rare creator (overlap=${rareCreator.overlap})`, extra: mappingsIn(creatorFieldId, rareCreator.rowid) });
if (dateWin) scenarios.push({ tag: "C", desc: `hasProvenance + date ${dateWin.lo}-${dateWin.hi} (overlap=${dateWin.cnt})`, extra: { sql: "a.date_earliest IS NOT NULL AND a.date_latest >= ? AND a.date_earliest <= ?", binds: [dateWin.lo, dateWin.hi] } });
if (rareType) scenarios.push({ tag: "D", desc: `hasProvenance + rare type (overlap=${rareType.overlap})`, extra: mappingsIn(typeFieldId, rareType.rowid) });

function run(label, where, binds) {
  const sql = `${SELECT} WHERE ${where} ${TAIL}`;
  const fullBinds = [...binds, 25];
  const plan = db.prepare("EXPLAIN QUERY PLAN " + sql).all(...fullBinds);
  let rows, ms;
  for (let i = 0; i < 3; i++) {
    const t = process.hrtime.bigint();
    rows = db.prepare(sql).all(...fullBinds);
    ms = Number(process.hrtime.bigint() - t) / 1e6;
  }
  const walksImportance = plan.some(p => /idx_artworks_importance/.test(p.detail));
  console.log(`  ${label}`);
  for (const p of plan) console.log(`     PLAN: ${p.detail}`);
  console.log(`     ROWS=${rows.length}  TIME(warm)=${ms.toFixed(1)}ms  ${walksImportance ? "⚠️  WALKS idx_artworks_importance" : "✓ does not walk importance"}\n`);
  return { ms, walksImportance };
}

for (const s of scenarios) {
  console.log("=".repeat(78));
  console.log(`Scenario ${s.tag}: ${s.desc}`);
  const extraSql = s.extra ? ` AND ${s.extra.sql}` : "";
  const extraBinds = s.extra ? s.extra.binds : [];
  // current (correlated EXISTS) vs proposed (driving IN)
  run("CURRENT  EXISTS-provenance", `${EXISTS_PROV}${extraSql}`, [...extraBinds]);
  run("PROPOSED IN-provenance", `${IN_PROV}${extraSql}`, [...extraBinds]);
}

db.close();
