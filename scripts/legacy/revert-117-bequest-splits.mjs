/**
 * revert-117-bequest-splits.mjs  (issue #397, follow-up)
 *
 * Un-splits the 18 wrong #117 (bequest_chain) splits. Audit (Opus 4.8,
 * 2026-06-18) found 18 of 31 splits manufacture a duplicate of the prior
 * owner event (anaphor re-materialization) or fabricate/duplicate children;
 * 13 (citation-isolation + genuine 2-transfer splits) are kept.
 *
 * Each split replaced one PEG parent with 2 #117-stamped children (+renumber).
 * Un-split = delete both children (+parties), re-insert the original PEG parent
 * in their slot, delete the split's store row (so reapply never re-splits).
 * periods are PEG-derived and untouched by the split writeback -> left as-is.
 *
 * Usage: node scripts/legacy/revert-117-bequest-splits.mjs [--apply]
 */

import Database from "better-sqlite3";
import { parseProvenanceRaw } from "../../dist/provenance-peg.js";
import { inferPosition, TRANSFER_TYPE_TO_CATEGORY } from "../../dist/provenance.js";
import * as M from "../lib/provenance-enrichment-methods.mjs";

const apply = process.argv.includes("--apply");
const db = new Database("data/vocabulary.db");

// 18 wrong splits (Groups 1 + 2). G3 (citation) + G4 (legit) are NOT listed.
const WRONG = [
  "BK-14823-A","RP-P-1961-868","RP-T-1898-A-3991","RP-T-1898-A-4067","RP-T-1944-200(R)",
  "RP-T-1979-205","RP-T-2010-43-194","RP-T-2010-43-226","SK-A-3158","SK-A-3469","SK-A-3612",
  "SK-A-4854-J","SK-A-705",                                  // G1: duplicate owner
  "BK-2013-9-1","BK-2016-13","SK-A-3681","SK-A-3723","SK-C-243", // G2: dup/fabricated children
];

console.log(`#397 — un-split 18 wrong #117 splits — ${apply ? "APPLY" : "DRY-RUN"}\n`);

const plan = [];
let bad = 0;
for (const obj of WRONG) {
  const art = db.prepare("SELECT art_id, provenance_text FROM artworks WHERE object_number=?").get(obj);
  const store = db.prepare("SELECT raw_text_hash, dup_ordinal, field, party_idx, payload FROM provenance_enrichments WHERE object_number=? AND field='event.split' AND method='llm_structural:bequest_chain'").all(obj);
  if (store.length !== 1) { console.error(`!! ${obj}: expected 1 split store row, got ${store.length}`); bad++; continue; }
  const origSeq = JSON.parse(store[0].payload).original_sequence;
  const parent = parseProvenanceRaw(art.provenance_text).events.find(e => e.sequence === origSeq);
  if (!parent) { console.error(`!! ${obj}: no PEG parent at seq ${origSeq}`); bad++; continue; }
  const children = db.prepare("SELECT sequence, transfer_type, substr(raw_text,1,55) AS head FROM provenance_events WHERE artwork_id=? AND correction_method='llm_structural:#117' ORDER BY sequence").all(art.art_id);
  if (children.length !== 2) { console.error(`!! ${obj}: expected 2 #117 child events, got ${children.length}`); bad++; continue; }
  const insertSeq = children[0].sequence;
  plan.push({ obj, artId: art.art_id, origSeq, parent, children, insertSeq, store: store[0] });
  console.log(`${obj.padEnd(17)} origSeq=${origSeq} -> restore [${parent.transferType}] at seq ${insertSeq}; delete children seq ${children.map(c=>c.sequence).join(",")}`);
  console.log(`   parent: ${parent.rawText.replace(/\{[^{}]*\}/g,"{CIT}").slice(0,90)}`);
  children.forEach(c => console.log(`   del seq ${c.sequence} [${c.transfer_type}]: ${c.head.replace(/\{[^{}]*\}/g,"{CIT}")}`));
}

if (!apply) { console.log(`\nDry-run. ${bad?`!! ${bad} PROBLEM(S)`:`${plan.length}/18 ready`}. Re-run with --apply.`); db.close(); process.exit(bad?2:0); }
if (bad) { console.error(`\nABORT: ${bad} problem(s).`); db.close(); process.exit(2); }

const delEvent  = db.prepare("DELETE FROM provenance_events  WHERE artwork_id=? AND sequence=?");
const delParty  = db.prepare("DELETE FROM provenance_parties WHERE artwork_id=? AND sequence=?");
const insEvent  = db.prepare(`INSERT INTO provenance_events (artwork_id, sequence, raw_text, gap, transfer_type, unsold, batch_price, transfer_category, category_method, uncertain, parties, date_expression, date_year, date_qualifier, location, price_amount, price_currency, sale_details, citations, is_cross_ref, cross_ref_target, parse_method) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const insParty  = db.prepare(`INSERT INTO provenance_parties (artwork_id, sequence, party_idx, party_name, party_dates, party_role, party_position, position_method, uncertain) VALUES (?,?,?,?,?,?,?,?,?)`);
const delStore  = db.prepare("DELETE FROM provenance_enrichments WHERE object_number=? AND raw_text_hash=? AND dup_ordinal=? AND field=? AND party_idx=?");

let unsplit = 0, childrenDeleted = 0, storeDeleted = 0;
db.transaction(() => {
  for (const p of plan) {
    for (const c of p.children) { delParty.run(p.artId, c.sequence); delEvent.run(p.artId, c.sequence); childrenDeleted++; }
    const e = p.parent, category = TRANSFER_TYPE_TO_CATEGORY[e.transferType] ?? null;
    const enriched = e.parties.map(pt => ({ ...pt, position: inferPosition(pt.role, e.transferType) }));
    insEvent.run(p.artId, p.insertSeq, e.rawText, e.gap?1:0, e.transferType, e.unsold?1:0, e.batchPrice?1:0,
      category, category ? M.TYPE_MAPPING : null, e.uncertain?1:0, JSON.stringify(enriched),
      e.dateExpression, e.dateYear, e.dateQualifier, e.location, e.price?.amount ?? null, e.price?.currency ?? null,
      e.saleDetails, JSON.stringify(e.citations), e.isCrossRef?1:0, e.crossRefTarget, e.parseMethod);
    for (let i = 0; i < e.parties.length; i++) {
      const pt = e.parties[i], pos = inferPosition(pt.role, e.transferType);
      insParty.run(p.artId, p.insertSeq, i, pt.name, pt.dates ?? null, pt.role ?? null, pos, pos ? M.ROLE_MAPPING : null, pt.uncertain?1:0);
    }
    storeDeleted += delStore.run(p.store.object_number ?? p.obj, p.store.raw_text_hash, p.store.dup_ordinal, p.store.field, p.store.party_idx).changes;
    unsplit++;
  }
  db.prepare("INSERT OR REPLACE INTO version_info (key,value) VALUES ('revert_117_unsplit_at', ?)").run(new Date().toISOString());
  db.prepare("INSERT OR REPLACE INTO version_info (key,value) VALUES ('revert_117_unsplit_count', ?)").run(String(unsplit));
})();

console.log(`\nAPPLIED: splits reverted=${unsplit}  child events deleted=${childrenDeleted}  store rows deleted=${storeDeleted}`);
db.close();
