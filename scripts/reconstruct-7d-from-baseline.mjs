/**
 * reconstruct-7d-from-baseline.mjs
 *
 * Restore the Step-7d party-extraction enrichments that a fresh re-parse + the
 * POST-REPARSE writeback chain does NOT reproduce, because the 7d party-extraction
 * audit JSON was never saved to the repo (POST-REPARSE-STEPS.md Step 7d is
 * "ON-DEMAND: no static audit JSON exists" — generated via the API once, applied,
 * not persisted). The deployed/baseline DB is therefore the ONLY surviving record
 * of that batch's output.
 *
 * 7d output = events tagged correction_method 'llm_structural:missing_all_parties'
 * or 'llm_structural:missing_sender', each with parties the LLM extracted. In the
 * v0.40 baseline that is 199 events / 361 parties. A plain re-parse leaves those
 * events under-populated (the parser found no parties — that's WHY 7d ran).
 *
 * This script copies, for each baseline 7d event — keyed by the harvest-stable
 * (object_number, sequence) and GUARDED by exact raw_text equality — the event's
 *   • correction_method + enrichment_reasoning
 *   • denormalized provenance_events.parties JSON  (verbatim from baseline)
 *   • normalized provenance_parties rows           (verbatim from baseline)
 * into the target DB, making those events byte-faithful to baseline.
 *
 * SAFE BY CONSTRUCTION (verified against the v0.40 baseline 2026-06-14):
 *   - All 361 baseline 7d parties are position_method='llm_structural' (0 carry the
 *     missing-receiver/parseRest reasoning), so this does NOT re-introduce any
 *     pre-relabel 'llm_enrichment' labels that #185/Option-B removed.
 *   - All 199 baseline 7d events raw_text-match the target event exactly, so the
 *     (object_number, sequence) mapping never lands on a re-segmented/changed event.
 *   - Target events carry ~0 parties for this set (clean add), but the script
 *     DELETEs whatever parties the target currently has on each touched event and
 *     re-inserts the baseline set, so normalized + JSON are mutually consistent and
 *     the result is exact baseline parity for these specific events.
 *
 * Only correction_method, enrichment_reasoning, and the parties JSON are written on
 * the event row — transfer_type / category / date / price from the fresh parse are
 * left untouched (7d only ever added parties).
 *
 * READ-ONLY by default (dry-run): plans + reports, writes nothing. Pass --apply to
 * commit (single all-or-nothing transaction). Any raw_text mismatch / absent
 * object_number / pre-existing correction_method is reported and (for mismatch /
 * absent) skipped — never forced.
 *
 * Usage:
 *   node scripts/reconstruct-7d-from-baseline.mjs            # dry-run
 *   node scripts/reconstruct-7d-from-baseline.mjs --apply    # write
 *   node scripts/reconstruct-7d-from-baseline.mjs --db data/vocabulary.db \
 *        --base data/vocabulary.db.pre017-20260614 [--apply]
 */
import Database from "better-sqlite3";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const argVal = (f) => { const i = args.indexOf(f); return i >= 0 && i + 1 < args.length ? args[i + 1] : null; };
const dbPath = argVal("--db") ?? "data/vocabulary.db";
const basePath = argVal("--base") ?? "data/vocabulary.db.pre017-20260614";

const METHODS = ["llm_structural:missing_all_parties", "llm_structural:missing_sender"];

const db = new Database(dbPath);                 // target (opened rw; writes only inside the --apply txn)
const base = new Database(basePath, { readonly: true });

// ── baseline 7d events (source of truth) ───────────────────────────────────────
const baseEvents = base.prepare(`
  SELECT e.artwork_id AS base_art_id, a.object_number, e.sequence,
         e.correction_method, e.enrichment_reasoning, e.raw_text, e.parties AS parties_json
  FROM provenance_events e JOIN artworks a ON a.art_id = e.artwork_id
  WHERE e.correction_method IN (${METHODS.map(() => "?").join(",")})
  ORDER BY a.object_number, e.sequence
`).all(...METHODS);

const baseParties = base.prepare(`
  SELECT party_idx, party_name, party_dates, party_role, party_position,
         position_method, uncertain, enrichment_reasoning
  FROM provenance_parties WHERE artwork_id = ? AND sequence = ? ORDER BY party_idx
`);

// ── target statements ──────────────────────────────────────────────────────────
const getArt   = db.prepare(`SELECT art_id FROM artworks WHERE object_number = ?`);
const getEvt   = db.prepare(`SELECT raw_text, correction_method FROM provenance_events WHERE artwork_id = ? AND sequence = ?`);
const cntParty = db.prepare(`SELECT COUNT(*) AS c FROM provenance_parties WHERE artwork_id = ? AND sequence = ?`);
const delParty = db.prepare(`DELETE FROM provenance_parties WHERE artwork_id = ? AND sequence = ?`);
const insParty = db.prepare(`INSERT INTO provenance_parties
  (artwork_id, sequence, party_idx, party_name, party_dates, party_role,
   party_position, position_method, uncertain, enrichment_reasoning)
  VALUES (?,?,?,?,?,?,?,?,?,?)`);
const updEvt   = db.prepare(`UPDATE provenance_events
  SET correction_method = ?, enrichment_reasoning = ?, parties = ?
  WHERE artwork_id = ? AND sequence = ?`);

let planned = 0, partiesIns = 0, deletedExisting = 0, skippedRaw = 0, skippedNoArt = 0, overlap = 0;
const skips = [], overlaps = [], byMethod = {};

const run = () => {
  for (const be of baseEvents) {
    const art = getArt.get(be.object_number);
    if (!art) { skippedNoArt++; skips.push(`${be.object_number} seq ${be.sequence}: object_number absent in target`); continue; }
    const ne = getEvt.get(art.art_id, be.sequence);
    if (!ne) { skippedRaw++; skips.push(`${be.object_number} seq ${be.sequence}: no target event at this sequence`); continue; }
    if (ne.raw_text !== be.raw_text) { skippedRaw++; skips.push(`${be.object_number} seq ${be.sequence}: raw_text differs (re-segmented?) — MANUAL REVIEW`); continue; }
    if (ne.correction_method) { overlap++; overlaps.push(`${be.object_number} seq ${be.sequence}: target already has correction_method='${ne.correction_method}' (will be overwritten with '${be.correction_method}')`); }

    const parties = baseParties.all(be.base_art_id, be.sequence);
    const existing = cntParty.get(art.art_id, be.sequence).c;
    planned++;
    partiesIns += parties.length;
    deletedExisting += existing;
    byMethod[be.correction_method] = (byMethod[be.correction_method] || 0) + 1;

    if (apply) {
      delParty.run(art.art_id, be.sequence);
      for (const p of parties) {
        insParty.run(art.art_id, be.sequence, p.party_idx, p.party_name, p.party_dates,
          p.party_role, p.party_position, p.position_method, p.uncertain, p.enrichment_reasoning);
      }
      updEvt.run(be.correction_method, be.enrichment_reasoning, be.parties_json, art.art_id, be.sequence);
    }
  }
};

if (apply) db.transaction(run)(); else run();

// ── report ───────────────────────────────────────────────────────────────────
console.log(`reconstruct-7d-from-baseline  [${apply ? "APPLY" : "DRY-RUN"}]`);
console.log(`  target: ${dbPath}`);
console.log(`  base:   ${basePath}`);
console.log(`  baseline 7d events found: ${baseEvents.length}`);
console.log();
console.log(`  events reconstructed:     ${planned}`);
for (const [m, c] of Object.entries(byMethod)) console.log(`      ${m}: ${c}`);
console.log(`  parties (re)inserted:     ${partiesIns}`);
console.log(`  existing target parties deleted on touched events: ${deletedExisting}`);
console.log(`  skipped (raw_text/absent event): ${skippedRaw}`);
console.log(`  skipped (object_number absent):  ${skippedNoArt}`);
console.log(`  pre-existing correction_method (overwritten): ${overlap}`);
if (overlaps.length) { console.log(`\n  -- overlap detail --`); overlaps.forEach((s) => console.log(`     ${s}`)); }
if (skips.length)    { console.log(`\n  -- skip detail (NOT applied — review) --`); skips.forEach((s) => console.log(`     ${s}`)); }
console.log();
console.log(apply
  ? `APPLIED. Verify: structural dist should regain missing_all_parties + missing_sender; parties += ~${partiesIns}.`
  : `DRY-RUN — no writes. Re-run with --apply to commit.`);

db.close();
base.close();
