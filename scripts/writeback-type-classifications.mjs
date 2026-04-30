/**
 * Write back LLM type classifications to provenance_events table.
 *
 * Reads audit-type-classification JSON, updates transfer_type + transfer_category
 * for events that were previously "unknown", using category_method = "llm_enrichment".
 *
 * Usage:
 *   node scripts/writeback-type-classifications.mjs [options]
 *
 * Options:
 *   --dry-run        Report what would change, don't write
 *   --db PATH        Vocab DB path (default: data/vocabulary.db)
 *   --input PATH     Classification JSON (default: data/audit/audit-type-classification-2026-03-22.json)
 *   --min-confidence N  Minimum confidence threshold (default: 0.7)
 *   --id-remap       Resolve object_number → art_id (use after re-harvest when artwork_ids change)
 */

import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { TRANSFER_TYPE_TO_CATEGORY } from "../dist/provenance.js";
import { parseIdRemapFlag, createIdResolver } from "./lib/id-remap.mjs";

// ─── CLI args ───────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const idRemap = parseIdRemapFlag(args);
const dbIdx = args.indexOf("--db");
const dbPath = dbIdx >= 0 ? args[dbIdx + 1] : "data/vocabulary.db";
const inputIdx = args.indexOf("--input");
const inputPath = inputIdx >= 0 ? args[inputIdx + 1] : "data/audit/audit-type-classification-2026-03-22.json";
const confIdx = args.indexOf("--min-confidence");
const minConfidence = confIdx >= 0 ? parseFloat(args[confIdx + 1]) : 0.7;

// ─── Types to skip (not real transfer events) ───────────────────────

const SKIP_TYPES = new Set(["non_provenance", "unknown"]);

// ─── Load classifications ───────────────────────────────────────────

const data = JSON.parse(readFileSync(inputPath, "utf-8"));
console.log(`LLM type classification write-back`);
console.log(`  Input:          ${inputPath}`);
console.log(`  DB:             ${dbPath}`);
console.log(`  Dry run:        ${dryRun}`);
console.log(`  Min confidence: ${minConfidence}`);
console.log(`  Model:          ${data.meta.model}`);
console.log(`  Source batch:   ${data.meta.batchId}`);
console.log();

// Flatten all classifications
const allClassifications = [];
for (const result of data.results) {
  const { artwork_id, object_number } = result.data;
  for (const cls of result.data.classifications) {
    allClassifications.push({ artwork_id, object_number, ...cls });
  }
}

// Filter
const skipped = { lowConfidence: 0, nonProvenance: 0, unknown: 0 };
const updates = [];
for (const cls of allClassifications) {
  if (cls.confidence < minConfidence) {
    skipped.lowConfidence++;
  } else if (SKIP_TYPES.has(cls.transfer_type)) {
    skipped[cls.transfer_type === "non_provenance" ? "nonProvenance" : "unknown"]++;
  } else {
    updates.push(cls);
  }
}

console.log(`Classifications: ${allClassifications.length} total`);
console.log(`  Updating:       ${updates.length}`);
console.log(`  Skipped:        ${skipped.lowConfidence} low confidence, ${skipped.nonProvenance} non_provenance, ${skipped.unknown} unknown`);
console.log();

// ─── Type distribution ──────────────────────────────────────────────

const typeCounts = {};
for (const u of updates) {
  typeCounts[u.transfer_type] = (typeCounts[u.transfer_type] || 0) + 1;
}
console.log(`Type distribution:`);
for (const [type, count] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
  const cat = TRANSFER_TYPE_TO_CATEGORY[type] ?? "null";
  console.log(`  ${type.padEnd(16)} ${String(count).padStart(4)}  (${cat})`);
}
console.log();

if (dryRun) {
  console.log(`Dry run — no changes written.`);
  process.exit(0);
}

// ─── Write to DB ────────────────────────────────────────────────────

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
const resolve = createIdResolver(db, idRemap);

// New rows (event was previously 'unknown' → set type, category, method, reasoning).
const updateStmt = db.prepare(`
  UPDATE provenance_events
  SET transfer_type = ?, transfer_category = ?, category_method = 'llm_enrichment',
      enrichment_reasoning = ?
  WHERE artwork_id = ? AND sequence = ? AND transfer_type = 'unknown'
`);

// Reasoning backfill (#285): for events already classified by this writeback in
// a prior run, fill enrichment_reasoning if still NULL and the type matches the
// audit JSON's claim (safety guard against subsequent reclassifications).
const backfillReasoning = db.prepare(`
  UPDATE provenance_events
  SET enrichment_reasoning = ?
  WHERE artwork_id = ? AND sequence = ?
    AND transfer_type = ? AND category_method = 'llm_enrichment'
    AND enrichment_reasoning IS NULL
`);

let updated = 0;
let notFound = 0;
let reasoningBackfilled = 0;

let skippedRemap = 0;

const writeBatch = db.transaction((rows) => {
  for (const row of rows) {
    const artworkId = resolve(row.artwork_id, row.object_number);
    if (artworkId == null) { skippedRemap++; continue; }
    const category = TRANSFER_TYPE_TO_CATEGORY[row.transfer_type] ?? null;
    const reasoning = row.reasoning ?? null;
    const result = updateStmt.run(
      row.transfer_type,
      category,
      reasoning,
      artworkId,
      row.event_sequence
    );
    if (result.changes > 0) {
      updated++;
    } else {
      // Try to backfill reasoning for already-classified events (#285).
      if (reasoning) {
        const bf = backfillReasoning.run(reasoning, artworkId, row.event_sequence, row.transfer_type);
        if (bf.changes > 0) {
          reasoningBackfilled++;
          continue;
        }
      }
      notFound++;
      console.warn(`  WARN: No unknown event at artwork_id=${artworkId} seq=${row.event_sequence}`);
    }
  }
});

writeBatch(updates);

// ─── Update version_info ────────────────────────────────────────────

db.prepare(`INSERT OR REPLACE INTO version_info (key, value) VALUES ('llm_enrichment_at', ?)`)
  .run(new Date().toISOString());
db.prepare(`INSERT OR REPLACE INTO version_info (key, value) VALUES ('llm_enrichment_batch', ?)`)
  .run(data.meta.batchId);
db.prepare(`INSERT OR REPLACE INTO version_info (key, value) VALUES ('llm_enrichment_count', ?)`)
  .run(String(updated));

db.close();

// ─── Report ─────────────────────────────────────────────────────────

console.log(`Results:`);
console.log(`  Updated:   ${updated}`);
if (reasoningBackfilled > 0) console.log(`  Reasoning backfilled on already-classified events: ${reasoningBackfilled} (#285)`);
console.log(`  Not found: ${notFound} (already reclassified or missing)`);
if (skippedRemap > 0) console.log(`  Skipped (id-remap): ${skippedRemap}`);
console.log(`  Version info updated.`);
