/**
 * Content-addressed backfill of provenance enrichments from v0.23.1 DB.
 *
 * Keys:
 *   - Events: (object_number, raw_text) — exact match
 *   - Parties: (object_number, event.raw_text, party_name) — exact match
 *
 * Backfills (only where current is NULL/unknown and source has better data):
 *   - events.transfer_type, transfer_category, category_method, enrichment_reasoning
 *     when current type = 'unknown' and source type != 'unknown'
 *   - parties.party_position, position_method, enrichment_reasoning
 *     when current party_position IS NULL and source has a position
 *
 * Does NOT:
 *   - Insert new events (structural splits remain un-applied)
 *   - Delete events
 *   - Touch correction_method (column doesn't exist in v0.23.1)
 *
 * Usage:
 *   node scripts/backfill-from-v23.1.mjs --dry-run
 *   node scripts/backfill-from-v23.1.mjs
 */

import Database from "better-sqlite3";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const dbPath = "data/vocabulary.db";
const srcPath = "data/backup/v23.1/vocabulary.db";

console.log(`v0.23.1 → v0.24 enrichment backfill`);
console.log(`  Target DB:  ${dbPath}`);
console.log(`  Source DB:  ${srcPath}`);
console.log(`  Dry run:    ${dryRun}`);
console.log();

const target = new Database(dbPath);
const source = new Database(srcPath, { readonly: true });

// ─── Load v0.23.1 enrichments into memory-indexed maps ────────────────
console.log("Loading v0.23.1 events...");
const srcEvents = new Map(); // key: object_number|raw_text → enriched fields
for (const r of source.prepare(`
  SELECT a.object_number, e.raw_text, e.transfer_type, e.transfer_category,
         e.category_method, e.enrichment_reasoning
  FROM provenance_events e JOIN artworks a ON a.art_id = e.artwork_id
`).all()) {
  srcEvents.set(`${r.object_number}\t${r.raw_text}`, r);
}
console.log(`  ${srcEvents.size.toLocaleString()} source events indexed`);

console.log("Loading v0.23.1 parties...");
const srcParties = new Map(); // key: object_number|raw_text|party_name → enriched fields
for (const r of source.prepare(`
  SELECT a.object_number, e.raw_text, p.party_name,
         p.party_position, p.position_method, p.enrichment_reasoning
  FROM provenance_parties p
  JOIN provenance_events e ON e.artwork_id = p.artwork_id AND e.sequence = p.sequence
  JOIN artworks a ON a.art_id = p.artwork_id
  WHERE p.party_position IS NOT NULL
`).all()) {
  srcParties.set(`${r.object_number}\t${r.raw_text}\t${r.party_name}`, r);
}
console.log(`  ${srcParties.size.toLocaleString()} source parties indexed`);

// ─── Backfill events ──────────────────────────────────────────────────
console.log("\n─── A. Backfill events (current unknown → source has type) ───");

const updEvent = target.prepare(`
  UPDATE provenance_events
  SET transfer_type = ?, transfer_category = ?, category_method = ?,
      enrichment_reasoning = COALESCE(?, enrichment_reasoning)
  WHERE artwork_id = ? AND sequence = ?
`);

const eventCandidates = target.prepare(`
  SELECT a.object_number, e.artwork_id, e.sequence, e.raw_text
  FROM provenance_events e JOIN artworks a ON a.art_id = e.artwork_id
  WHERE e.transfer_type = 'unknown' AND e.is_cross_ref = 0
`).all();

let eMatched = 0, eUpdated = 0, eSkipped = 0;
const applyEvents = target.transaction((rows) => {
  for (const r of rows) {
    const src = srcEvents.get(`${r.object_number}\t${r.raw_text}`);
    if (!src) { eSkipped++; continue; }
    if (src.transfer_type === 'unknown') { eSkipped++; continue; }
    eMatched++;
    if (!dryRun) {
      updEvent.run(
        src.transfer_type,
        src.transfer_category,
        src.category_method || 'backfill_v23.1',
        src.enrichment_reasoning,
        r.artwork_id,
        r.sequence,
      );
      eUpdated++;
    }
  }
});
applyEvents(eventCandidates);

console.log(`  Candidates:      ${eventCandidates.length}`);
console.log(`  Matched (src):   ${eMatched}`);
console.log(`  Updated:         ${eUpdated} ${dryRun ? '(dry-run)' : ''}`);
console.log(`  Skipped:         ${eSkipped}`);

// ─── Backfill parties ─────────────────────────────────────────────────
console.log("\n─── B. Backfill parties (current NULL position → source has position) ───");

const updParty = target.prepare(`
  UPDATE provenance_parties
  SET party_position = ?, position_method = ?,
      enrichment_reasoning = COALESCE(?, enrichment_reasoning)
  WHERE artwork_id = ? AND sequence = ? AND party_idx = ?
`);

const partyCandidates = target.prepare(`
  SELECT a.object_number, e.raw_text, p.artwork_id, p.sequence, p.party_idx, p.party_name
  FROM provenance_parties p
  JOIN provenance_events e ON e.artwork_id = p.artwork_id AND e.sequence = p.sequence
  JOIN artworks a ON a.art_id = p.artwork_id
  WHERE p.party_position IS NULL AND p.position_method IS NULL
`).all();

let pMatched = 0, pUpdated = 0, pSkipped = 0;
const applyParties = target.transaction((rows) => {
  for (const r of rows) {
    const src = srcParties.get(`${r.object_number}\t${r.raw_text}\t${r.party_name}`);
    if (!src) { pSkipped++; continue; }
    pMatched++;
    if (!dryRun) {
      updParty.run(
        src.party_position,
        src.position_method || 'backfill_v23.1',
        src.enrichment_reasoning,
        r.artwork_id,
        r.sequence,
        r.party_idx,
      );
      pUpdated++;
    }
  }
});
applyParties(partyCandidates);

console.log(`  Candidates:      ${partyCandidates.length}`);
console.log(`  Matched (src):   ${pMatched}`);
console.log(`  Updated:         ${pUpdated} ${dryRun ? '(dry-run)' : ''}`);
console.log(`  Skipped:         ${pSkipped}`);

// ─── Summary ──────────────────────────────────────────────────────────
console.log("\n═══ Summary ═══");
console.log(`Events backfilled:  ${eUpdated} (of ${eventCandidates.length} candidates)`);
console.log(`Parties backfilled: ${pUpdated} (of ${partyCandidates.length} candidates)`);

if (!dryRun) {
  // Update version_info
  target.prepare(`INSERT OR REPLACE INTO version_info (key, value) VALUES (?, ?)`).run(
    'backfill_from_v23.1_at', new Date().toISOString(),
  );
  target.prepare(`INSERT OR REPLACE INTO version_info (key, value) VALUES (?, ?)`).run(
    'backfill_from_v23.1_events', String(eUpdated),
  );
  target.prepare(`INSERT OR REPLACE INTO version_info (key, value) VALUES (?, ?)`).run(
    'backfill_from_v23.1_parties', String(pUpdated),
  );
  console.log(`Version info updated.`);
}

target.close();
source.close();
