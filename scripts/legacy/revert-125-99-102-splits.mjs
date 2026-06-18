/**
 * revert-125-99-102-splits.mjs  (issue #397 / ledger #408, follow-up)
 *
 * Un-splits 44 of the 64 multi_transfer(#125)/gap_bridge(#99)/catalogue_fragment(#102)
 * splits. Audit (Opus 4.8, 2026-06-18; dump data/audit/split-audit-dump-2026-06-18.txt):
 *   R1 clear mechanical (6): 4 fabricated "Mendelssohn Bank acquired from the Mannheimer
 *      estate" intermediates that exist nowhere in the raw text (AK-RBK-17525, BK-16863-A,
 *      BK-16919, BK-17315) + 2 forward-duplicates folding the existing "transferred to the
 *      museum, 1960" event into the 1952 DRVK loan (SK-A-3993 #99, SK-A-4008).
 *   R2 Mannheimer Führermuseum reification (34, Arno-approved 2026-06-18): the forced-sale
 *      template split into [sale to Dienststelle Mühlmann] + a standalone [transfer "to
 *      Hitler's Führermuseum, Linz, 1940"]; every chain's NEXT event is "war recuperation,
 *      1945" → the Linz transfer never completed → revert to the single PEG sale (the
 *      "for the Führermuseum" purpose stays in the sale text — lossless).
 *   R3 borderline over-splits (4): RP-T-1948-398 (one sale split into from/to halves),
 *      SK-A-3467 (dealer "for the museum" reify), SK-C-1349 seq6 ("taken to Paris" transport
 *      reified), BK-KOG-760 (fabricated bracketed "[to his brother-in-law]" inheritance).
 *
 * The 20 genuine splits are NOT listed (incl. SK-A-4717's 6-way parser-merge fix and
 * SK-C-1349 seq7). SK-C-1349 has two splits → children matched per-split by segment text.
 *
 * Mechanism (inverse of the split, same as #117): for each split, re-parse the artwork for
 * the PEG parent at original_sequence, delete the split's child events (+parties), re-insert
 * the PEG parent in the lowest child slot, delete the split store row. periods are
 * PEG-derived and untouched by the split writeback → left as-is. Sequence holes are tolerated.
 *
 * Usage:
 *   node scripts/legacy/revert-125-99-102-splits.mjs            # dry-run (default)
 *   node scripts/legacy/revert-125-99-102-splits.mjs --apply
 */

import Database from "better-sqlite3";
import fs from "node:fs";
import { parseProvenanceRaw } from "../../dist/provenance-peg.js";
import { inferPosition, TRANSFER_TYPE_TO_CATEGORY } from "../../dist/provenance.js";
import * as M from "../lib/provenance-enrichment-methods.mjs";

const apply = process.argv.includes("--apply");
const db = new Database("data/vocabulary.db");

// issue → { event correction_method, store split method }
const ISSUE = {
  "#125": { ev: "llm_structural:#125", store: "llm_structural:multi_transfer" },
  "#99":  { ev: "llm_structural:#99",  store: "llm_structural:gap_bridge" },
  "#102": { ev: "llm_structural:#102", store: "llm_structural:catalogue_fragment" },
};

// [object_number, original_sequence, issue]
const REVERT = [
  // R1 — fabricated inferred intermediate (4)
  ["AK-RBK-17525", 2, "#125"], ["BK-16863-A", 2, "#125"], ["BK-16919", 3, "#125"], ["BK-17315", 2, "#125"],
  // R1 — forward-duplicate of the existing 1960 transfer (2)
  ["SK-A-3993", 5, "#99"], ["SK-A-4008", 5, "#125"],
  // R2 — Mannheimer Führermuseum reification (34)
  ["BK-16677", 2, "#125"], ["BK-16853", 2, "#125"], ["BK-16859", 2, "#125"], ["BK-16885", 3, "#125"],
  ["BK-16885-12", 3, "#125"], ["BK-16885-14", 3, "#125"], ["BK-16885-60", 3, "#125"], ["BK-16885-79", 3, "#125"],
  ["BK-16885-8", 3, "#125"], ["BK-16918", 3, "#125"], ["BK-16925-B", 4, "#125"], ["BK-16929", 2, "#125"],
  ["BK-16937", 6, "#125"], ["BK-16965-A", 2, "#125"], ["BK-16974", 3, "#125"], ["BK-17048", 3, "#125"],
  ["BK-17063", 3, "#125"], ["BK-17065", 3, "#125"], ["BK-17073", 3, "#125"], ["BK-17083", 4, "#125"],
  ["BK-17096-1", 3, "#125"], ["BK-17131", 2, "#125"], ["BK-17216", 4, "#125"], ["BK-17281", 2, "#125"],
  ["BK-17297", 3, "#125"], ["BK-17355-2", 3, "#125"], ["BK-17366-B", 2, "#125"], ["BK-17366-D", 2, "#125"],
  ["BK-17382-A", 3, "#125"], ["BK-17401-A", 4, "#125"], ["BK-17428-A", 3, "#125"], ["BK-17436", 2, "#125"],
  ["BK-17502-A", 2, "#125"], ["BK-17506-A", 3, "#125"],
  // R3 — borderline over-splits (4)
  ["RP-T-1948-398", 3, "#125"], ["SK-A-3467", 3, "#125"], ["SK-C-1349", 6, "#125"], ["BK-KOG-760", 7, "#125"],
];

const norm = s => (s || "").replace(/\{[^{}]*\}/g, " ").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const toks = s => new Set(norm(s).split(/\s+/).filter(w => w.length > 2));
function jaccard(a, b) { const A = toks(a), B = toks(b); if (!A.size && !B.size) return 1; if (!A.size || !B.size) return 0; let i = 0; for (const t of A) if (B.has(t)) i++; return i / (A.size + B.size - i); }

const pegCache = new Map();
function peg(obj) {
  if (pegCache.has(obj)) return pegCache.get(obj);
  const a = db.prepare("SELECT art_id, provenance_text FROM artworks WHERE object_number=?").get(obj);
  const r = { artId: a?.art_id, events: a ? parseProvenanceRaw(a.provenance_text).events : [] };
  pegCache.set(obj, r); return r;
}

console.log(`#397/#408 — revert 44 #125/#99/#102 splits — ${apply ? "APPLY" : "DRY-RUN"}\n`);

const plan = [];
let bad = 0;
for (const [obj, seq, issue] of REVERT) {
  const { ev: evMethod, store: storeMethod } = ISSUE[issue];
  const { artId, events } = peg(obj);
  if (!artId) { console.error(`!! ${obj}: artwork not found`); bad++; continue; }
  const parent = events.find(e => e.sequence === seq);
  if (!parent) { console.error(`!! ${obj}#${seq}: no PEG parent at original_sequence`); bad++; continue; }

  // store row for THIS split (match original_sequence inside payload)
  const storeRows = db.prepare(
    "SELECT object_number, raw_text_hash, dup_ordinal, field, party_idx, payload FROM provenance_enrichments WHERE object_number=? AND field='event.split' AND method=?"
  ).all(obj, storeMethod);
  const store = storeRows.find(r => JSON.parse(r.payload).original_sequence === seq);
  if (!store) { console.error(`!! ${obj}#${seq}: no split store row`); bad++; continue; }
  const segs = (JSON.parse(store.payload).replacement_events || []).map(r => r.raw_text_segment || "");
  const multiSplit = storeRows.length > 1;

  // applied children stamped with this issue's correction_method
  const allKids = db.prepare(
    "SELECT sequence, raw_text, transfer_type FROM provenance_events WHERE artwork_id=? AND correction_method=? ORDER BY sequence"
  ).all(artId, evMethod);

  let kids;
  if (!multiSplit) {
    kids = allKids; // single split → all its children
  } else {
    // multi-split artwork: pick the children whose text best matches THIS split's segments
    kids = segs.map(seg => {
      const ranked = allKids.map(k => ({ k, s: jaccard(k.raw_text, seg) })).sort((a, b) => b.s - a.s);
      return ranked[0]?.s > 0.4 ? ranked[0].k : null;
    }).filter(Boolean);
    kids = [...new Map(kids.map(k => [k.sequence, k])).values()].sort((a, b) => a.sequence - b.sequence);
  }
  if (kids.length !== segs.length) {
    console.error(`!! ${obj}#${seq}: matched ${kids.length} children, expected ${segs.length}${multiSplit ? " (multi-split)" : ""}`);
    bad++; continue;
  }
  const insertSeq = kids[0].sequence;
  plan.push({ obj, artId, seq, issue, parent, kids, insertSeq, store });
  console.log(`${obj.padEnd(15)} #${issue} origSeq=${seq} → restore [${parent.transferType}] @${insertSeq}; del child seq ${kids.map(k => k.sequence).join(",")}${multiSplit ? "  (multi-split, text-matched)" : ""}`);
  console.log(`   parent: ${parent.rawText.replace(/\{[^{}]*\}/g, "{C}").slice(0, 95)}`);
  kids.forEach(k => console.log(`   del @${k.sequence} [${k.transfer_type}]: ${k.raw_text.replace(/\{[^{}]*\}/g, "{C}").slice(0, 80)}`));
}

console.log(`\n${plan.length}/${REVERT.length} ready${bad ? `  !! ${bad} PROBLEM(S)` : ""}.`);
if (!apply) { console.log("\nDry-run. Re-run with --apply."); db.close(); process.exit(bad ? 2 : 0); }
if (bad) { console.error("\nABORT: problems above — refusing to guess."); db.close(); process.exit(2); }

// ── backup before write ──
const backup = plan.map(p => ({
  obj: p.obj, seq: p.seq, issue: p.issue, insertSeq: p.insertSeq,
  children: p.kids.map(k => ({
    event: db.prepare("SELECT * FROM provenance_events WHERE artwork_id=? AND sequence=?").get(p.artId, k.sequence),
    parties: db.prepare("SELECT * FROM provenance_parties WHERE artwork_id=? AND sequence=?").all(p.artId, k.sequence),
  })),
  store: p.store,
}));
fs.writeFileSync("data/audit/revert-125-99-102-backup-2026-06-18.json", JSON.stringify(backup, null, 2));

const delEvent = db.prepare("DELETE FROM provenance_events  WHERE artwork_id=? AND sequence=?");
const delParty = db.prepare("DELETE FROM provenance_parties WHERE artwork_id=? AND sequence=?");
const insEvent = db.prepare(`INSERT INTO provenance_events (artwork_id, sequence, raw_text, gap, transfer_type, unsold, batch_price, transfer_category, category_method, uncertain, parties, date_expression, date_year, date_qualifier, location, price_amount, price_currency, sale_details, citations, is_cross_ref, cross_ref_target, parse_method) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const insParty = db.prepare(`INSERT INTO provenance_parties (artwork_id, sequence, party_idx, party_name, party_dates, party_role, party_position, position_method, uncertain) VALUES (?,?,?,?,?,?,?,?,?)`);
const delStore = db.prepare("DELETE FROM provenance_enrichments WHERE object_number=? AND raw_text_hash=? AND dup_ordinal=? AND field=? AND party_idx=?");

let reverted = 0, childrenDeleted = 0, storeDeleted = 0;
db.transaction(() => {
  for (const p of plan) {
    for (const k of p.kids) { delParty.run(p.artId, k.sequence); delEvent.run(p.artId, k.sequence); childrenDeleted++; }
    const e = p.parent, category = TRANSFER_TYPE_TO_CATEGORY[e.transferType] ?? null;
    const enriched = e.parties.map(pt => ({ ...pt, position: inferPosition(pt.role, e.transferType) }));
    insEvent.run(p.artId, p.insertSeq, e.rawText, e.gap ? 1 : 0, e.transferType, e.unsold ? 1 : 0, e.batchPrice ? 1 : 0,
      category, category ? M.TYPE_MAPPING : null, e.uncertain ? 1 : 0, JSON.stringify(enriched),
      e.dateExpression, e.dateYear, e.dateQualifier, e.location, e.price?.amount ?? null, e.price?.currency ?? null,
      e.saleDetails, JSON.stringify(e.citations), e.isCrossRef ? 1 : 0, e.crossRefTarget, e.parseMethod);
    for (let i = 0; i < e.parties.length; i++) {
      const pt = e.parties[i], pos = inferPosition(pt.role, e.transferType);
      insParty.run(p.artId, p.insertSeq, i, pt.name, pt.dates ?? null, pt.role ?? null, pos, pos ? M.ROLE_MAPPING : null, pt.uncertain ? 1 : 0);
    }
    storeDeleted += delStore.run(p.store.object_number, p.store.raw_text_hash, p.store.dup_ordinal, p.store.field, p.store.party_idx).changes;
    reverted++;
  }
  db.prepare("INSERT OR REPLACE INTO version_info (key,value) VALUES ('revert_125_99_102_at', ?)").run(new Date().toISOString());
  db.prepare("INSERT OR REPLACE INTO version_info (key,value) VALUES ('revert_125_99_102_count', ?)").run(String(reverted));
})();
db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").run();

console.log(`\nAPPLIED: splits reverted=${reverted}  child events deleted=${childrenDeleted}  store rows deleted=${storeDeleted}`);
console.log("Backup: data/audit/revert-125-99-102-backup-2026-06-18.json");
db.close();
