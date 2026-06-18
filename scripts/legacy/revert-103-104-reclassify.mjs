/**
 * revert-103-104-reclassify.mjs  (issue #397, follow-up to the #87 revert)
 *
 * Audits found the #103 (alternative_acquisition) and #104 (location_as_event)
 * reclassify families deleted 5 genuine events (merge actions). This restores
 * them and repairs two clobbered target locations. ONE #104 merge is correct
 * and left intact: SK-A-372 seq 7 ("Prince's room, Prinsenhof" — a real room
 * label), whose store row is KEPT.
 *
 * periods were never touched by the reclassify writeback (PEG-derived), so the
 * deleted events' periods still exist — we only restore events + parties.
 *
 * Per case:
 *   SK-A-4753  restore seq2 by_descent (Ernest Hoeufft); clear seq1 #103 stamp
 *   SK-A-800   restore seq4 sale (Mechelen friars, uncertain dispersal)
 *   SK-A-372   restore seq4 inventory (1625); fix seq3 loc -> "Haarlem"; clear stamp
 *   SK-C-243   restore seq6 loan (City of Amsterdam -> museum, 1885)
 *   SK-A-4265  restore seq1 collection (council chamber, Tholen); fix seq2 loc -> "The Hague"; clear stamp
 *
 * Deletes 5 wrong event.reclassify store rows; KEEPS SK-A-372 seq7's.
 *
 * Usage: node scripts/legacy/revert-103-104-reclassify.mjs [--apply]
 */

import Database from "better-sqlite3";
import { parseProvenanceRaw } from "../../dist/provenance-peg.js";
import { inferPosition, TRANSFER_TYPE_TO_CATEGORY } from "../../dist/provenance.js";
import * as M from "../lib/provenance-enrichment-methods.mjs";

const apply = process.argv.includes("--apply");
const db = new Database("data/vocabulary.db");

// pegSeq = the deleted event's sequence in a fresh PEG parse; insertSeq = where to put it back.
const RESTORES = [
  { obj: "SK-A-4753", pegSeq: 2, insertSeq: 2, undo: { seq: 1, clearCM: true } },
  { obj: "SK-A-800",  pegSeq: 4, insertSeq: 4, undo: null },
  { obj: "SK-A-372",  pegSeq: 4, insertSeq: 4, undo: { seq: 3, location: "Haarlem", clearCM: true } },
  { obj: "SK-C-243",  pegSeq: 6, insertSeq: 6, undo: null },
  { obj: "SK-A-4265", pegSeq: 1, insertSeq: 1, undo: { seq: 2, location: "The Hague", clearCM: true } },
];
// store rows to delete: object -> issue match. SK-A-372 keeps event_sequence 7.
const STORE_DELETE = {
  "SK-A-4753": { method: "llm_structural:alternative_acquisition" },
  "SK-A-800":  { method: "llm_structural:alternative_acquisition" },
  "SK-A-372":  { method: "llm_structural:location_as_event", payloadSeq: 4 }, // keep seq7
  "SK-C-243":  { method: "llm_structural:location_as_event" },
  "SK-A-4265": { method: "llm_structural:location_as_event" },
};

function artOf(obj) { return db.prepare("SELECT art_id, provenance_text FROM artworks WHERE object_number=?").get(obj); }
function pegEvent(obj, seq) {
  const a = artOf(obj);
  const r = parseProvenanceRaw(a.provenance_text);
  return { artId: a.art_id, ev: r.events.find(e => e.sequence === seq) };
}

console.log(`#397 — revert #103/#104 reclassify — ${apply ? "APPLY" : "DRY-RUN"}\n`);
const toInsert = [];
for (const r of RESTORES) {
  const { artId, ev } = pegEvent(r.obj, r.pegSeq);
  if (!ev) { console.error(`!! ${r.obj}: no PEG event at seq ${r.pegSeq}`); process.exit(2); }
  const exists = db.prepare("SELECT 1 FROM provenance_events WHERE artwork_id=? AND sequence=?").get(artId, r.insertSeq);
  toInsert.push({ ...r, artId, ev, exists: !!exists });
  console.log(`${r.obj}: restore seq ${r.insertSeq} = ${ev.transferType} (parties=${ev.parties.length})${exists ? "  !! HOLE OCCUPIED" : ""}`);
  console.log(`   :: ${ev.rawText.replace(/\{[^{}]*\}/g, "{CIT}").slice(0, 100)}`);
  if (r.undo) console.log(`   undo target seq ${r.undo.seq}: ${r.undo.location ? `location -> "${r.undo.location}"  ` : ""}${r.undo.clearCM ? "clear correction_method" : ""}`);
}
const occupied = toInsert.filter(t => t.exists);
console.log(`\nStore rows to delete:`);
const storePlan = [];
for (const [obj, spec] of Object.entries(STORE_DELETE)) {
  const rows = db.prepare("SELECT rowid_alias.* FROM (SELECT object_number, raw_text_hash, dup_ordinal, field, party_idx, payload FROM provenance_enrichments WHERE object_number=? AND field='event.reclassify' AND method=?) rowid_alias").all(obj, spec.method);
  for (const row of rows) {
    const pseq = JSON.parse(row.payload).event_sequence;
    if (spec.payloadSeq != null && pseq !== spec.payloadSeq) { console.log(`   KEEP ${obj} event_seq=${pseq}`); continue; }
    storePlan.push(row);
    console.log(`   DELETE ${obj} (${spec.method.split(":")[1]}) event_seq=${pseq}`);
  }
}

if (!apply) { console.log(`\nDry-run. ${occupied.length ? "ABORT-RISK: occupied holes!" : "Holes clear."} Re-run with --apply.`); db.close(); process.exit(0); }
if (occupied.length) { console.error("\nABORT: target sequence already occupied."); db.close(); process.exit(2); }

const insEvent = db.prepare(`INSERT INTO provenance_events (artwork_id, sequence, raw_text, gap, transfer_type, unsold, batch_price, transfer_category, category_method, uncertain, parties, date_expression, date_year, date_qualifier, location, price_amount, price_currency, sale_details, citations, is_cross_ref, cross_ref_target, parse_method) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const insParty = db.prepare(`INSERT INTO provenance_parties (artwork_id, sequence, party_idx, party_name, party_dates, party_role, party_position, position_method, uncertain) VALUES (?,?,?,?,?,?,?,?,?)`);
const undoLoc = db.prepare(`UPDATE provenance_events SET location=?, correction_method=NULL WHERE artwork_id=? AND sequence=?`);
const clearCM = db.prepare(`UPDATE provenance_events SET correction_method=NULL WHERE artwork_id=? AND sequence=?`);
const delStore = db.prepare(`DELETE FROM provenance_enrichments WHERE object_number=? AND raw_text_hash=? AND dup_ordinal=? AND field=? AND party_idx=?`);

let inserted = 0, undos = 0, storeDeleted = 0;
db.transaction(() => {
  for (const t of toInsert) {
    const e = t.ev, category = TRANSFER_TYPE_TO_CATEGORY[e.transferType] ?? null;
    const enriched = e.parties.map(p => ({ ...p, position: inferPosition(p.role, e.transferType) }));
    insEvent.run(t.artId, t.insertSeq, e.rawText, e.gap ? 1 : 0, e.transferType, e.unsold ? 1 : 0, e.batchPrice ? 1 : 0,
      category, category ? M.TYPE_MAPPING : null, e.uncertain ? 1 : 0, JSON.stringify(enriched),
      e.dateExpression, e.dateYear, e.dateQualifier, e.location, e.price?.amount ?? null, e.price?.currency ?? null,
      e.saleDetails, JSON.stringify(e.citations), e.isCrossRef ? 1 : 0, e.crossRefTarget, e.parseMethod);
    for (let i = 0; i < e.parties.length; i++) {
      const p = e.parties[i], pos = inferPosition(p.role, e.transferType);
      insParty.run(t.artId, t.insertSeq, i, p.name, p.dates ?? null, p.role ?? null, pos, pos ? M.ROLE_MAPPING : null, p.uncertain ? 1 : 0);
    }
    inserted++;
    if (t.undo) {
      if (t.undo.location != null) undoLoc.run(t.undo.location, t.artId, t.undo.seq);
      else if (t.undo.clearCM) clearCM.run(t.artId, t.undo.seq);
      undos++;
    }
  }
  for (const row of storePlan) storeDeleted += delStore.run(row.object_number, row.raw_text_hash, row.dup_ordinal, row.field, row.party_idx).changes;
  db.prepare("INSERT OR REPLACE INTO version_info (key,value) VALUES ('revert_103_104_at', ?)").run(new Date().toISOString());
})();

console.log(`\nAPPLIED: events restored=${inserted}  target-undos=${undos}  store rows deleted=${storeDeleted}`);
db.close();
