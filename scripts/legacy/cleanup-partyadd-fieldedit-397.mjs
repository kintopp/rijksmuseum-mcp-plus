/**
 * cleanup-partyadd-fieldedit-397.mjs  (issue #397 / ledger #408, follow-up)
 *
 * The party-add / field-edit families (missing_all_parties, missing_sender,
 * #116 missing_receiver, #119 wrong_location, #149 truncated_location) audited
 * ~98% sound (Opus 4.8, 2026-06-18; dumps data/audit/{fieldedit,partyadd}-audit-*).
 * This removes the small defect tail (11 items):
 *
 *   A. 10 stray llm-added receiver parties:
 *      - 6 "Adolf Hitler's Führermuseum" receivers (party-level twin of the
 *        reverted MANN_A reification — the Führermuseum never received the works);
 *      - 4 duplicates of an existing rule-mapped party (same name+position).
 *      Each: delete the provenance_parties row (the llm-added one), drop it from
 *      the denormalized events.parties JSON, and — for the 7 whose source
 *      fieldcorrection store row carries a re-addable `new_party` — strip that
 *      correction so reapply-from-store never re-adds it.
 *   B. 1 wrong location: BK-17110-B#3 location "Linz" -> restore "The Hague"
 *      (Linz was the intended museum, not the transaction site) + delete the
 *      seq3 "The Hague"->"Linz" fieldcorrection store row.
 *
 * Everything else in these families is left untouched (no fabrications found;
 * all 361 llm-added parties in the big families are grounded in event text).
 *
 * Usage:
 *   node scripts/legacy/cleanup-partyadd-fieldedit-397.mjs            # dry-run
 *   node scripts/legacy/cleanup-partyadd-fieldedit-397.mjs --apply
 */

import Database from "better-sqlite3";
import fs from "node:fs";

const apply = process.argv.includes("--apply");
const db = new Database("data/vocabulary.db");

// [object, sequence, name_fragment] — resolves to the single llm-added receiver matching the fragment.
const PARTY_TARGETS = [
  ["RP-T-1953-196", 4, "Führermuseum"], ["BK-17158", 3, "Führermuseum"], ["BK-17139", 3, "Führermuseum"],
  ["BK-17198", 3, "Führermuseum"], ["SK-A-4130", 2, "Führermuseum"], ["AK-RBK-17520-A", 2, "Führermuseum"],
  ["RP-T-1901-A-4520(V)", 3, "Thibaudeau"], ["RP-T-1899-A-4296", 3, "Knowles"],
  ["SK-A-4053", 2, "museum"], ["NG-47", 3, "museum"],
];
const LOCATION_FIX = { obj: "BK-17110-B", seq: 3, from: "Linz", to: "The Hague" };

const norm = s => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

console.log(`#397/#408 — party-add/field-edit cleanup — ${apply ? "APPLY" : "DRY-RUN"}\n`);

// ── resolve party targets ──
const plan = [];
let bad = 0;
for (const [obj, seq, frag] of PARTY_TARGETS) {
  const a = db.prepare("SELECT art_id FROM artworks WHERE object_number=?").get(obj);
  if (!a) { console.error(`!! ${obj}: not found`); bad++; continue; }
  const cands = db.prepare(
    "SELECT party_idx, party_name, party_position, position_method FROM provenance_parties WHERE artwork_id=? AND sequence=? AND position_method LIKE 'llm%' AND party_name LIKE ?"
  ).all(a.art_id, seq, `%${frag}%`);
  if (cands.length !== 1) { console.error(`!! ${obj}#${seq} "${frag}": expected 1 llm party, got ${cands.length}`); bad++; continue; }
  const p = cands[0];
  // events.parties JSON — find the entry index to splice (match name+position; tolerate name/party_name + position/party_position)
  const evt = db.prepare("SELECT parties FROM provenance_events WHERE artwork_id=? AND sequence=?").get(a.art_id, seq);
  let json = []; try { json = JSON.parse(evt?.parties || "[]"); } catch { json = []; }
  const jIdx = json.findIndex(e => (e.name ?? e.party_name) === p.party_name && (e.position ?? e.party_position) === p.party_position);
  // store correction carrying a re-addable new_party for this party
  const fcRows = db.prepare("SELECT raw_text_hash, dup_ordinal, party_idx, field, method, payload FROM provenance_enrichments WHERE object_number=? AND field='event.fieldcorrection'").all(obj);
  let storeHit = null;
  for (const r of fcRows) {
    const pl = JSON.parse(r.payload);
    const keep = (pl.corrections || []).filter(c => !(c.event_sequence === seq && c.field === "parties" && c.new_party && (norm(c.new_party.name) === norm(p.party_name) || norm(c.new_party.name).includes(norm(frag)))));
    if (keep.length !== (pl.corrections || []).length) { storeHit = { row: r, keep }; break; }
  }
  plan.push({ obj, artId: a.art_id, seq, party: p, jIdx, jsonLen: json.length, storeHit });
  const kind = frag === "Führermuseum" ? "Führermuseum" : "duplicate";
  console.log(`${obj.padEnd(20)} #${seq} idx${p.party_idx} [${kind}] "${p.party_name}" (${p.position_method})`);
  console.log(`   JSON entry ${jIdx >= 0 ? `@${jIdx}/${json.length}` : "NOT FOUND (warn)"}; store ${storeHit ? `strip new_party from ${storeHit.row.method.split(":")[1]} (${storeHit.keep.length} corrections remain${storeHit.keep.length ? "" : " -> delete row"})` : "no re-addable new_party"}`);
  if (jIdx < 0) console.log(`   !! JSON entry not found — table delete only`);
}

// ── resolve location fix ──
const la = db.prepare("SELECT art_id FROM artworks WHERE object_number=?").get(LOCATION_FIX.obj);
const lev = la && db.prepare("SELECT location, correction_method FROM provenance_events WHERE artwork_id=? AND sequence=?").get(la.art_id, LOCATION_FIX.seq);
const locRows = la ? db.prepare("SELECT raw_text_hash, dup_ordinal, party_idx, field, payload FROM provenance_enrichments WHERE object_number=? AND field='event.fieldcorrection'").all(LOCATION_FIX.obj) : [];
const locStoreRow = locRows.find(r => (JSON.parse(r.payload).corrections || []).some(c => c.event_sequence === LOCATION_FIX.seq && c.field === "location" && norm(c.corrected_value) === norm(LOCATION_FIX.from)));
console.log(`\n${LOCATION_FIX.obj} #${LOCATION_FIX.seq} location: ${JSON.stringify(lev?.location)} -> "${LOCATION_FIX.to}"; store row ${locStoreRow ? "found -> delete" : "NOT FOUND"}`);
if (!lev || norm(lev.location) !== norm(LOCATION_FIX.from)) { console.error(`!! ${LOCATION_FIX.obj}#${LOCATION_FIX.seq}: live location is ${JSON.stringify(lev?.location)}, expected "${LOCATION_FIX.from}"`); bad++; }
if (!locStoreRow) { console.error(`!! ${LOCATION_FIX.obj}#${LOCATION_FIX.seq}: no "${LOCATION_FIX.from}" location store row`); bad++; }

console.log(`\n${plan.length}/${PARTY_TARGETS.length} party targets + 1 location fix${bad ? `  !! ${bad} PROBLEM(S)` : ""}.`);
if (!apply) { console.log("\nDry-run. Re-run with --apply."); db.close(); process.exit(bad ? 2 : 0); }
if (bad) { console.error("\nABORT: problems above."); db.close(); process.exit(2); }

// ── backup ──
const backup = {
  parties: plan.map(p => ({ obj: p.obj, seq: p.seq,
    party: db.prepare("SELECT * FROM provenance_parties WHERE artwork_id=? AND sequence=? AND party_idx=?").get(p.artId, p.seq, p.party.party_idx),
    eventPartiesJson: db.prepare("SELECT parties FROM provenance_events WHERE artwork_id=? AND sequence=?").get(p.artId, p.seq)?.parties,
    storeRow: p.storeHit ? db.prepare("SELECT * FROM provenance_enrichments WHERE object_number=? AND raw_text_hash=? AND dup_ordinal=? AND field=? AND party_idx=?").get(p.storeHit.row.object_number ?? p.obj, p.storeHit.row.raw_text_hash, p.storeHit.row.dup_ordinal, p.storeHit.row.field, p.storeHit.row.party_idx) : null })),
  location: { obj: LOCATION_FIX.obj, seq: LOCATION_FIX.seq, before: lev,
    storeRow: db.prepare("SELECT * FROM provenance_enrichments WHERE object_number=? AND raw_text_hash=? AND dup_ordinal=? AND field=? AND party_idx=?").get(LOCATION_FIX.obj, locStoreRow.raw_text_hash, locStoreRow.dup_ordinal, locStoreRow.field, locStoreRow.party_idx) },
};
fs.writeFileSync("data/audit/cleanup-partyadd-fieldedit-backup-2026-06-18.json", JSON.stringify(backup, null, 2));

const delParty = db.prepare("DELETE FROM provenance_parties WHERE artwork_id=? AND sequence=? AND party_idx=?");
const setJson = db.prepare("UPDATE provenance_events SET parties=? WHERE artwork_id=? AND sequence=?");
const updStore = db.prepare("UPDATE provenance_enrichments SET payload=? WHERE object_number=? AND raw_text_hash=? AND dup_ordinal=? AND field=? AND party_idx=?");
const delStore = db.prepare("DELETE FROM provenance_enrichments WHERE object_number=? AND raw_text_hash=? AND dup_ordinal=? AND field=? AND party_idx=?");
const setLoc = db.prepare("UPDATE provenance_events SET location=?, correction_method=NULL WHERE artwork_id=? AND sequence=?");

let partiesDeleted = 0, jsonUpdated = 0, storeStripped = 0, storeDeleted = 0;
db.transaction(() => {
  for (const p of plan) {
    delParty.run(p.artId, p.seq, p.party.party_idx); partiesDeleted++;
    if (p.jIdx >= 0) {
      const evt = db.prepare("SELECT parties FROM provenance_events WHERE artwork_id=? AND sequence=?").get(p.artId, p.seq);
      const arr = JSON.parse(evt.parties); arr.splice(p.jIdx, 1);
      setJson.run(JSON.stringify(arr), p.artId, p.seq); jsonUpdated++;
    }
    if (p.storeHit) {
      const r = p.storeHit.row;
      if (p.storeHit.keep.length) {
        const pl = JSON.parse(r.payload); pl.corrections = p.storeHit.keep;
        updStore.run(JSON.stringify(pl), r.object_number ?? p.obj, r.raw_text_hash, r.dup_ordinal, r.field, r.party_idx); storeStripped++;
      } else {
        storeDeleted += delStore.run(r.object_number ?? p.obj, r.raw_text_hash, r.dup_ordinal, r.field, r.party_idx).changes;
      }
    }
  }
  setLoc.run(LOCATION_FIX.to, la.art_id, LOCATION_FIX.seq);
  storeDeleted += delStore.run(LOCATION_FIX.obj, locStoreRow.raw_text_hash, locStoreRow.dup_ordinal, locStoreRow.field, locStoreRow.party_idx).changes;
  db.prepare("INSERT OR REPLACE INTO version_info (key,value) VALUES ('cleanup_partyadd_fieldedit_at', ?)").run(new Date().toISOString());
})();
db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").run();

console.log(`\nAPPLIED: parties deleted=${partiesDeleted}  json updated=${jsonUpdated}  store corrections stripped=${storeStripped}  store rows deleted=${storeDeleted}  location fixed=1`);
console.log("Backup: data/audit/cleanup-partyadd-fieldedit-backup-2026-06-18.json");
db.close();
