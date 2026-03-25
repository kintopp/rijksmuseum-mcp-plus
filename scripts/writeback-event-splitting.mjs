/**
 * Write back LLM event splits to provenance_events/provenance_parties.
 *
 * For each split:
 *   1. Read all events + parties for the artwork
 *   2. Replace the original event with the LLM's replacement events
 *   3. Delete all events + parties, re-insert with clean sequences
 *   4. Update provenance_periods.source_events with new sequence numbers
 *
 * Usage:
 *   node scripts/writeback-event-splitting.mjs --input <path> [options]
 *
 * Options:
 *   --dry-run        Report what would change, don't write
 *   --db PATH        Vocab DB path (default: data/vocabulary.db)
 *   --input PATH     Audit JSON from --mode event-splitting
 *   --min-confidence N  Minimum confidence threshold (default: 0.7)
 */

import Database from "better-sqlite3";
import { readFileSync } from "node:fs";

// ─── CLI args ───────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const dbIdx = args.indexOf("--db");
const dbPath = dbIdx >= 0 ? args[dbIdx + 1] : "data/vocabulary.db";
const inputIdx = args.indexOf("--input");
const inputPath = inputIdx >= 0 ? args[inputIdx + 1] : null;
const confIdx = args.indexOf("--min-confidence");
const minConfidence = confIdx >= 0 ? parseFloat(args[confIdx + 1]) : 0.7;

if (!inputPath) {
  console.error("Usage: node scripts/writeback-event-splitting.mjs --input <path> [--dry-run] [--db PATH]");
  process.exit(1);
}

// ─── Load splits ────────────────────────────────────────────────────

const data = JSON.parse(readFileSync(inputPath, "utf-8"));
console.log(`Event splitting write-back`);
console.log(`  Input:          ${inputPath}`);
console.log(`  DB:             ${dbPath}`);
console.log(`  Dry run:        ${dryRun}`);
console.log(`  Min confidence: ${minConfidence}`);
console.log();

const ISSUE_TO_METHOD = {
  multi_transfer: "llm_structural:#125",
  bequest_chain: "llm_structural:#117",
  gap_bridge: "llm_structural:#99",
  catalogue_fragment: "llm_structural:#102",
};

// Flatten and filter splits, group by artwork
const splitsByArtwork = new Map();
for (const result of data.results) {
  if (result.error || !result.data?.splits) continue;
  const { artwork_id, object_number } = result.data;
  for (const s of result.data.splits) {
    if (s.confidence < minConfidence) continue;
    if (!s.replacement_events || s.replacement_events.length < 2) {
      console.warn(`  WARN: Split at ${object_number} seq ${s.original_sequence} has < 2 replacement events, skipping`);
      continue;
    }
    if (!splitsByArtwork.has(artwork_id)) {
      splitsByArtwork.set(artwork_id, { object_number, splits: [] });
    }
    splitsByArtwork.get(artwork_id).splits.push(s);
  }
}

let totalSplits = 0;
let totalNewEvents = 0;
for (const [, { splits }] of splitsByArtwork) {
  totalSplits += splits.length;
  for (const s of splits) totalNewEvents += s.replacement_events.length;
}

console.log(`Splits: ${totalSplits} across ${splitsByArtwork.size} artworks`);
console.log(`  New events: ${totalNewEvents} (net +${totalNewEvents - totalSplits})`);
console.log();

if (dryRun) {
  console.log("Dry run — no changes written.");
  for (const [artId, { object_number, splits }] of splitsByArtwork) {
    for (const s of splits) {
      console.log(`  ${object_number} seq ${s.original_sequence} [${s.issue_type}] → ${s.replacement_events.length} events (${(s.confidence * 100).toFixed(0)}%)`);
      for (const re of s.replacement_events) {
        console.log(`    - ${re.transfer_type}: "${(re.raw_text_segment || "").slice(0, 80)}"`);
      }
    }
  }
  process.exit(0);
}

// ─── Write to DB ────────────────────────────────────────────────────

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

// Verify correction_method column exists
try {
  db.prepare("SELECT correction_method FROM provenance_events LIMIT 0").run();
} catch {
  console.error("ERROR: correction_method column missing. Re-parse the DB with the updated schema first.");
  process.exit(1);
}

const getEvents = db.prepare(
  `SELECT * FROM provenance_events WHERE artwork_id = ? ORDER BY sequence`
);

const getParties = db.prepare(
  `SELECT * FROM provenance_parties WHERE artwork_id = ? ORDER BY sequence, party_idx`
);

const getPeriods = db.prepare(
  `SELECT * FROM provenance_periods WHERE artwork_id = ? ORDER BY sequence`
);

const deleteAllEvents = db.prepare(
  `DELETE FROM provenance_events WHERE artwork_id = ?`
);

const deleteAllParties = db.prepare(
  `DELETE FROM provenance_parties WHERE artwork_id = ?`
);

const insertEvent = db.prepare(`
  INSERT INTO provenance_events (
    artwork_id, sequence, raw_text, gap, transfer_type, unsold, batch_price,
    transfer_category, category_method, uncertain, parties,
    date_expression, date_year, date_qualifier, location,
    price_amount, price_currency, sale_details, citations,
    is_cross_ref, cross_ref_target, parse_method, correction_method, enrichment_reasoning
  ) VALUES (
    ?, ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?,
    ?, ?, ?, ?,
    ?, ?, ?, ?,
    ?, ?, ?, ?, ?
  )
`);

const insertParty = db.prepare(`
  INSERT INTO provenance_parties (
    artwork_id, sequence, party_idx, party_name, party_dates, party_role,
    party_position, position_method, uncertain, enrichment_reasoning
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const updatePeriodSourceEvents = db.prepare(`
  UPDATE provenance_periods SET source_events = ? WHERE artwork_id = ? AND sequence = ?
`);

let artworksProcessed = 0;
let eventsInserted = 0;
let errors = 0;

const processArtwork = db.transaction((artworkId, splits) => {
  // 1. Read current state
  const existingEvents = getEvents.all(artworkId);
  const existingParties = getParties.all(artworkId);
  const existingPeriods = getPeriods.all(artworkId);

  // Index parties by (sequence)
  const partiesBySeq = new Map();
  for (const p of existingParties) {
    if (!partiesBySeq.has(p.sequence)) partiesBySeq.set(p.sequence, []);
    partiesBySeq.get(p.sequence).push(p);
  }

  // Build sequence map for splits
  const splitSeqs = new Set(splits.map(s => s.original_sequence));

  // 2. Build new event list with clean sequences
  const newEvents = [];   // { event, parties[] }
  const seqMap = {};      // old_seq → [new_seq, ...]

  for (const evt of existingEvents) {
    if (splitSeqs.has(evt.sequence)) {
      // Replace with split events
      const split = splits.find(s => s.original_sequence === evt.sequence);
      const method = ISSUE_TO_METHOD[split.issue_type] ?? `llm_structural:${split.issue_type}`;
      const startIdx = newEvents.length;

      for (const re of split.replacement_events) {
        const newSeq = newEvents.length;
        const partiesJson = JSON.stringify((re.parties || []).map(p => ({
          name: p.name,
          role: p.role ?? null,
          position: p.position,
        })));

        newEvents.push({
          event: {
            artwork_id: artworkId,
            sequence: newSeq,
            raw_text: re.raw_text_segment,
            gap: re.gap ? 1 : 0,
            transfer_type: re.transfer_type,
            unsold: 0,
            batch_price: 0,
            transfer_category: re.transfer_category,
            category_method: null,
            uncertain: evt.uncertain,  // inherit from original
            parties: partiesJson,
            date_expression: null,
            date_year: re.date_year ?? null,
            date_qualifier: re.date_qualifier ?? null,
            location: re.location ?? null,
            price_amount: null,
            price_currency: null,
            sale_details: null,
            citations: evt.citations,  // inherit from original
            is_cross_ref: 0,
            cross_ref_target: null,
            parse_method: "llm_structural",
            correction_method: method,
            enrichment_reasoning: split.reasoning,
          },
          parties: (re.parties || []).map((p, i) => ({
            party_idx: i,
            party_name: p.name,
            party_dates: null,
            party_role: p.role ?? null,
            party_position: p.position,
            position_method: "llm_structural",
            uncertain: 0,
            enrichment_reasoning: split.reasoning,
          })),
        });
      }

      // Map old sequence to range of new sequences
      const endIdx = newEvents.length;
      seqMap[evt.sequence] = Array.from({ length: endIdx - startIdx }, (_, i) => startIdx + i);
    } else {
      // Keep as-is with new sequence number
      const newSeq = newEvents.length;
      seqMap[evt.sequence] = [newSeq];
      newEvents.push({
        event: { ...evt, sequence: newSeq },
        parties: (partiesBySeq.get(evt.sequence) || []).map(p => ({
          ...p,
          sequence: newSeq,
        })),
      });
    }
  }

  // 3. Delete all existing events + parties
  deleteAllEvents.run(artworkId);
  deleteAllParties.run(artworkId);

  // 4. Insert new events + parties
  for (const { event: e, parties } of newEvents) {
    insertEvent.run(
      e.artwork_id, e.sequence, e.raw_text, e.gap, e.transfer_type, e.unsold, e.batch_price,
      e.transfer_category, e.category_method, e.uncertain, e.parties,
      e.date_expression, e.date_year, e.date_qualifier, e.location,
      e.price_amount, e.price_currency, e.sale_details, e.citations,
      e.is_cross_ref, e.cross_ref_target, e.parse_method, e.correction_method, e.enrichment_reasoning
    );
    eventsInserted++;

    for (const p of parties) {
      insertParty.run(
        artworkId, e.sequence, p.party_idx, p.party_name, p.party_dates ?? null, p.party_role ?? null,
        p.party_position ?? null, p.position_method ?? null, p.uncertain ?? 0, p.enrichment_reasoning ?? null
      );
    }
  }

  // 5. Update provenance_periods source_events references
  for (const period of existingPeriods) {
    if (!period.source_events) continue;
    let sourceEvents;
    try { sourceEvents = JSON.parse(period.source_events); } catch { continue; }
    if (!Array.isArray(sourceEvents)) continue;

    const newSourceEvents = [];
    for (const oldSeq of sourceEvents) {
      const mapped = seqMap[oldSeq];
      if (mapped) newSourceEvents.push(...mapped);
      else newSourceEvents.push(oldSeq); // shouldn't happen but be safe
    }

    updatePeriodSourceEvents.run(
      JSON.stringify(newSourceEvents),
      artworkId,
      period.sequence
    );
  }
});

for (const [artworkId, { object_number, splits }] of splitsByArtwork) {
  try {
    processArtwork(artworkId, splits);
    artworksProcessed++;
    console.log(`  ✓ ${object_number}: ${splits.length} split(s) applied`);
  } catch (err) {
    errors++;
    console.error(`  ✗ ${object_number}: ${err.message}`);
  }
}

// ─── Update version_info ────────────────────────────────────────────

db.prepare(`INSERT OR REPLACE INTO version_info (key, value) VALUES ('event_splitting_at', ?)`)
  .run(new Date().toISOString());
db.prepare(`INSERT OR REPLACE INTO version_info (key, value) VALUES ('event_splitting_batch', ?)`)
  .run(data.meta?.batchId ?? "manual");
db.prepare(`INSERT OR REPLACE INTO version_info (key, value) VALUES ('event_splitting_count', ?)`)
  .run(String(totalSplits));

db.close();

// ─── Report ─────────────────────────────────────────────────────────

console.log();
console.log(`Results:`);
console.log(`  Artworks processed: ${artworksProcessed}`);
console.log(`  Events inserted:    ${eventsInserted}`);
console.log(`  Errors:             ${errors}`);
console.log(`  Version info updated.`);
