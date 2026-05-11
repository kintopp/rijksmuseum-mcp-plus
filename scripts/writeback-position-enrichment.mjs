/**
 * Write back position enrichment results to provenance_parties and provenance_events.
 *
 * From audit-position-enrichment JSON:
 * - 258 real position assignments → provenance_parties.party_position
 * - 36 category updates → provenance_events.transfer_category
 * Skips null/None positions (parser artifacts — handled by disambiguation script).
 *
 * Usage:
 *   node scripts/writeback-position-enrichment.mjs [--dry-run] [--db PATH] [--input PATH] [--id-remap]
 */

import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { parseIdRemapFlag, createIdResolver } from "./lib/id-remap.mjs";
import * as M from "./lib/provenance-enrichment-methods.mjs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const idRemap = parseIdRemapFlag(args);
const dbPath = args.includes("--db") ? args[args.indexOf("--db") + 1] : "data/vocabulary.db";
const inputPath = args.includes("--input") ? args[args.indexOf("--input") + 1] : "data/audit-position-enrichment-2026-03-22.json";

const data = JSON.parse(readFileSync(inputPath, "utf-8"));

console.log(`Position enrichment write-back`);
console.log(`  Input:    ${inputPath}`);
console.log(`  DB:       ${dbPath}`);
console.log(`  Dry run:  ${dryRun}`);
console.log();

// ─── Extract updates ────────────────────────────────────────────────

const positionUpdates = [];
const categoryUpdates = [];

for (const r of data.results) {
  if (r.error) continue;
  const { artwork_id, object_number } = r.data;

  for (const enr of r.data.enrichments || []) {
    const seq = enr.event_sequence;

    for (const pu of enr.party_updates || []) {
      const pos = pu.position;
      // Skip null/None — these are parser artifacts handled by disambiguation
      if (pos == null || pos === "null" || pos === "None") continue;
      if (!["sender", "receiver", "agent"].includes(pos)) {
        console.warn(`  WARN: Unexpected position "${pos}" for artwork ${artwork_id} seq ${seq} idx ${pu.party_idx} — skipping`);
        continue;
      }
      positionUpdates.push({
        artwork_id, object_number,
        sequence: seq,
        party_idx: pu.party_idx,
        position: pos,
        confidence: pu.confidence,
        reasoning: pu.reasoning ?? null,
      });
    }

    if (enr.category_update) {
      const cu = enr.category_update;
      if (!["ownership", "custody"].includes(cu.category)) {
        console.warn(`  WARN: Unexpected category "${cu.category}" for artwork ${artwork_id} seq ${seq} — skipping`);
        continue;
      }
      categoryUpdates.push({
        artwork_id, object_number,
        sequence: seq,
        category: cu.category,
        confidence: cu.confidence,
        reasoning: cu.reasoning ?? null,
      });
    }
  }
}

// Stats
const posDist = {};
for (const u of positionUpdates) posDist[u.position] = (posDist[u.position] || 0) + 1;
const catDist = {};
for (const u of categoryUpdates) catDist[u.category] = (catDist[u.category] || 0) + 1;

console.log(`Position updates: ${positionUpdates.length}`);
for (const [pos, count] of Object.entries(posDist)) console.log(`  ${pos}: ${count}`);
console.log(`Category updates: ${categoryUpdates.length}`);
for (const [cat, count] of Object.entries(catDist)) console.log(`  ${cat}: ${count}`);
console.log();

if (dryRun) {
  console.log(`Dry run — no changes written.`);
  process.exit(0);
}

// ─── Write to DB ────────────────────────────────────────────────────

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
const resolve = createIdResolver(db, idRemap);

// New rows (party_position was NULL → fill position + method + reasoning).
const updatePosition = db.prepare(`
  UPDATE provenance_parties
  SET party_position = ?, position_method = '${M.LLM_ENRICHMENT}', enrichment_reasoning = ?
  WHERE artwork_id = ? AND sequence = ? AND party_idx = ?
    AND party_position IS NULL
`);

// Reasoning backfill (#285): for parties already positioned by this writeback in
// a prior run, fill enrichment_reasoning if still NULL and the position matches
// what the audit JSON now claims (safety guard against stale audit / model drift).
const backfillPositionReasoning = db.prepare(`
  UPDATE provenance_parties
  SET enrichment_reasoning = ?
  WHERE artwork_id = ? AND sequence = ? AND party_idx = ?
    AND party_position = ?
    AND position_method = '${M.LLM_ENRICHMENT}'
    AND enrichment_reasoning IS NULL
`);

const updateCategory = db.prepare(`
  UPDATE provenance_events
  SET transfer_category = ?, category_method = '${M.LLM_ENRICHMENT}', enrichment_reasoning = ?
  WHERE artwork_id = ? AND sequence = ?
    AND transfer_category = 'ambiguous'
`);

const backfillCategoryReasoning = db.prepare(`
  UPDATE provenance_events
  SET enrichment_reasoning = ?
  WHERE artwork_id = ? AND sequence = ?
    AND transfer_category = ?
    AND category_method = '${M.LLM_ENRICHMENT}'
    AND enrichment_reasoning IS NULL
`);

let posUpdated = 0, posSkipped = 0, skippedRemap = 0;
let posReasoningBackfilled = 0;
let catUpdated = 0, catSkipped = 0;
let catReasoningBackfilled = 0;

const writeBatch = db.transaction(() => {
  for (const u of positionUpdates) {
    const artworkId = resolve(u.artwork_id, u.object_number);
    if (artworkId == null) { skippedRemap++; continue; }
    const result = updatePosition.run(u.position, u.reasoning, artworkId, u.sequence, u.party_idx);
    if (result.changes > 0) {
      posUpdated++;
    } else {
      posSkipped++;
      // Try to backfill reasoning for already-positioned rows where it's still NULL.
      if (u.reasoning) {
        const bf = backfillPositionReasoning.run(u.reasoning, artworkId, u.sequence, u.party_idx, u.position);
        if (bf.changes > 0) posReasoningBackfilled++;
      }
    }
  }

  for (const u of categoryUpdates) {
    const artworkId = resolve(u.artwork_id, u.object_number);
    if (artworkId == null) { skippedRemap++; continue; }
    const result = updateCategory.run(u.category, u.reasoning, artworkId, u.sequence);
    if (result.changes > 0) {
      catUpdated++;
    } else {
      catSkipped++;
      if (u.reasoning) {
        const bf = backfillCategoryReasoning.run(u.reasoning, artworkId, u.sequence, u.category);
        if (bf.changes > 0) catReasoningBackfilled++;
      }
    }
  }
});

writeBatch();

// Version info
db.prepare(`INSERT OR REPLACE INTO version_info (key, value) VALUES ('position_enrichment_at', ?)`)
  .run(new Date().toISOString());
db.prepare(`INSERT OR REPLACE INTO version_info (key, value) VALUES ('position_enrichment_batch', ?)`)
  .run(data.meta.batchId);

db.close();

console.log(`Results:`);
console.log(`  Positions: ${posUpdated} updated, ${posSkipped} skipped (already set or missing)`);
if (posReasoningBackfilled > 0) console.log(`             ${posReasoningBackfilled} reasoning backfilled on already-positioned parties (#285)`);
console.log(`  Categories: ${catUpdated} updated, ${catSkipped} skipped`);
if (catReasoningBackfilled > 0) console.log(`              ${catReasoningBackfilled} reasoning backfilled on already-categorised events (#285)`);
if (skippedRemap > 0) console.log(`  Skipped (id-remap): ${skippedRemap}`);
