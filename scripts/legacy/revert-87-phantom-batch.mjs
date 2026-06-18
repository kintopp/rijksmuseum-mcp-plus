/**
 * revert-87-phantom-batch.mjs  (issue #397)
 *
 * Reverts the ENTIRE llm_structural:#87 "phantom event" batch (2026-04-19).
 * Self-audit (Opus 4.8, 2026-06-18): all 60 mark_non_provenance suppressions
 * are genuine events (citation-only re-suppress test passes for ZERO of them);
 * plus 1 merge_with_adjacent that deleted a genuine event, and 2 never-applied
 * orphan suppressions. 63 phantom_event store rows total.
 *
 * Action (pure revert to genuine pre-#87 PEG state, durable):
 *   A. 60 mark_non_provenance events — re-parse each artwork, match by raw_text,
 *      restore transfer_type/category/category_method, clear #87 markers.
 *   B. BK-15316-B-1 — full single-artwork re-parse-replace (it has ONLY the merge
 *      enrichment), restoring the merge-deleted "transferred to the museum, 1940"
 *      event with its parties + periods.
 *   C. DELETE all 63 phantom_event rows from provenance_enrichments (so a future
 *      re-parse + reapply-from-store never re-applies the batch).
 *
 * Usage:
 *   node scripts/legacy/revert-87-phantom-batch.mjs            # dry-run
 *   node scripts/legacy/revert-87-phantom-batch.mjs --apply
 */

import Database from "better-sqlite3";
import { parseProvenanceRaw } from "../../dist/provenance-peg.js";
import { interpretPeriods } from "../../dist/provenance-interpret.js";
import { inferPosition, TRANSFER_TYPE_TO_CATEGORY } from "../../dist/provenance.js";
import * as M from "../lib/provenance-enrichment-methods.mjs";

const apply = process.argv.includes("--apply");
const db = new Database("data/vocabulary.db");

const MERGE_OBJ = "BK-15316-B-1"; // the merge_with_adjacent that deleted an event

// ── A. the 60 mark_non_provenance events ────────────────────────────
const events = db.prepare(`
  SELECT e.artwork_id, a.object_number, e.sequence, e.raw_text
  FROM provenance_events e JOIN artworks a ON a.art_id = e.artwork_id
  WHERE e.correction_method = 'llm_structural:#87'
  ORDER BY a.object_number, e.sequence
`).all();

const parseCache = new Map();
function pegEventsFor(artId, objectNumber) {
  if (parseCache.has(objectNumber)) return parseCache.get(objectNumber);
  const row = db.prepare("SELECT provenance_text FROM artworks WHERE art_id = ?").get(artId);
  const parsed = parseProvenanceRaw(row.provenance_text);
  parseCache.set(objectNumber, parsed.events);
  return parsed.events;
}

const plan = [];
for (const ev of events) {
  const peg = pegEventsFor(ev.artwork_id, ev.object_number).filter(pe => pe.rawText === ev.raw_text);
  const pegType = peg.length ? peg[0].transferType : null;
  const category = pegType ? (TRANSFER_TYPE_TO_CATEGORY[pegType] ?? null) : null;
  plan.push({ ...ev, pegType, category, matched: peg.length });
}
const unmatched = plan.filter(p => !p.matched);

// ── C. store rows to delete ─────────────────────────────────────────
const storeRows = db.prepare(
  "SELECT object_number, COUNT(*) c FROM provenance_enrichments WHERE field='event.reclassify' AND method='llm_structural:phantom_event' GROUP BY object_number"
).all();
const storeTotal = storeRows.reduce((n, r) => n + r.c, 0);

// ── Report ──────────────────────────────────────────────────────────
console.log(`#397 — revert whole #87 batch — ${apply ? "APPLY" : "DRY-RUN"}\n`);
console.log(`A. mark_non_provenance events: ${plan.length}  (unmatched raw_text: ${unmatched.length})`);
const byType = {};
for (const p of plan) byType[p.pegType] = (byType[p.pegType] || 0) + 1;
console.log(`   restore types:`, byType);
console.log(`B. merge re-insert: ${MERGE_OBJ} (restore deleted "transferred to the museum, 1940")`);
console.log(`C. phantom_event store rows to delete: ${storeTotal} across ${storeRows.length} objects`);
if (unmatched.length) console.log(`   !! UNMATCHED:`, unmatched.map(u => `${u.object_number}/${u.sequence}`));

if (!apply) { console.log("\nDry-run. Re-run with --apply."); db.close(); process.exit(0); }
if (unmatched.length) { console.error("\nABORT: unmatched events — refusing to guess."); db.close(); process.exit(2); }

// ── APPLY ───────────────────────────────────────────────────────────
const updEvent = db.prepare(`
  UPDATE provenance_events
  SET transfer_type = ?, transfer_category = ?, category_method = ?,
      correction_method = NULL, enrichment_reasoning = NULL
  WHERE artwork_id = ? AND sequence = ?
`);
const delEvents  = db.prepare("DELETE FROM provenance_events  WHERE artwork_id = ?");
const delParties = db.prepare("DELETE FROM provenance_parties WHERE artwork_id = ?");
const delPeriods = db.prepare("DELETE FROM provenance_periods WHERE artwork_id = ?");
const insEvent = db.prepare(`
  INSERT INTO provenance_events (
    artwork_id, sequence, raw_text, gap, transfer_type, unsold, batch_price,
    transfer_category, category_method, uncertain,
    parties, date_expression, date_year, date_qualifier,
    location, price_amount, price_currency, sale_details, citations,
    is_cross_ref, cross_ref_target, parse_method
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const insParty = db.prepare(`
  INSERT INTO provenance_parties (
    artwork_id, sequence, party_idx, party_name, party_dates, party_role,
    party_position, position_method, uncertain
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const insPeriod = db.prepare(`
  INSERT INTO provenance_periods (
    artwork_id, sequence, owner_name, owner_dates, location,
    acquisition_method, acquisition_from,
    begin_year, begin_year_latest, end_year,
    derivation, uncertain, citations, source_events
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const delStoreAll = db.prepare(
  "DELETE FROM provenance_enrichments WHERE field='event.reclassify' AND method='llm_structural:phantom_event'");

function reinsertArtwork(artId) {
  const row = db.prepare("SELECT art_id, provenance_text, date_earliest, date_latest FROM artworks WHERE art_id = ?").get(artId);
  const result = parseProvenanceRaw(row.provenance_text);
  delPeriods.run(artId); delParties.run(artId); delEvents.run(artId);
  for (const e of result.events) {
    const category = TRANSFER_TYPE_TO_CATEGORY[e.transferType] ?? null;
    const enrichedParties = e.parties.map(p => ({ ...p, position: inferPosition(p.role, e.transferType) }));
    insEvent.run(
      artId, e.sequence, e.rawText, e.gap ? 1 : 0, e.transferType, e.unsold ? 1 : 0, e.batchPrice ? 1 : 0,
      category, category ? M.TYPE_MAPPING : null, e.uncertain ? 1 : 0,
      JSON.stringify(enrichedParties), e.dateExpression, e.dateYear, e.dateQualifier,
      e.location, e.price?.amount ?? null, e.price?.currency ?? null, e.saleDetails,
      JSON.stringify(e.citations), e.isCrossRef ? 1 : 0, e.crossRefTarget, e.parseMethod);
    for (let i = 0; i < e.parties.length; i++) {
      const p = e.parties[i]; const pos = inferPosition(p.role, e.transferType);
      insParty.run(artId, e.sequence, i, p.name, p.dates ?? null, p.role ?? null, pos, pos ? M.ROLE_MAPPING : null, p.uncertain ? 1 : 0);
    }
  }
  if (!result.isCrossRef) {
    const periods = interpretPeriods(result.events, { creationDateEarliest: row.date_earliest ?? null, creationDateLatest: row.date_latest ?? null });
    for (const p of periods) {
      insPeriod.run(artId, p.sequence, p.owner?.name ?? null, p.owner?.dates ?? null, p.location,
        p.acquisitionMethod, p.acquisitionFrom?.name ?? null, p.beginYear, p.beginYearLatest, p.endYear,
        JSON.stringify(p.derivation), p.uncertain ? 1 : 0, JSON.stringify(p.citations), JSON.stringify(p.sourceEvents));
    }
  }
  return result.events.length;
}

let restored = 0, reinserted = 0, storeDeleted = 0;
db.transaction(() => {
  for (const p of plan) {
    updEvent.run(p.pegType, p.category, p.category ? M.TYPE_MAPPING : null, p.artwork_id, p.sequence);
    restored++;
  }
  const mergeArt = db.prepare("SELECT art_id FROM artworks WHERE object_number = ?").get(MERGE_OBJ);
  reinserted = reinsertArtwork(mergeArt.art_id);
  storeDeleted = delStoreAll.run().changes;
  db.prepare("INSERT OR REPLACE INTO version_info (key,value) VALUES ('revert_87_phantom_at', ?)").run(new Date().toISOString());
  db.prepare("INSERT OR REPLACE INTO version_info (key,value) VALUES ('revert_87_phantom_count', ?)").run(String(restored + 1));
})();

console.log(`\nAPPLIED:`);
console.log(`  A. events restored in place: ${restored}`);
console.log(`  B. ${MERGE_OBJ} re-parsed → ${reinserted} events (deleted event restored)`);
console.log(`  C. store rows deleted:       ${storeDeleted}`);
db.close();
