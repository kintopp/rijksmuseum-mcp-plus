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
 *   --input PATH     Classification JSON (default: data/audit-type-classification-2026-03-22.json)
 *   --min-confidence N  Minimum confidence threshold (default: 0.7)
 */

import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { TRANSFER_TYPE_TO_CATEGORY } from "../dist/provenance.js";

// ─── CLI args ───────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const dbIdx = args.indexOf("--db");
const dbPath = dbIdx >= 0 ? args[dbIdx + 1] : "data/vocabulary.db";
const inputIdx = args.indexOf("--input");
const inputPath = inputIdx >= 0 ? args[inputIdx + 1] : "data/audit-type-classification-2026-03-22.json";
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
  const { artwork_id } = result.data;
  for (const cls of result.data.classifications) {
    allClassifications.push({ artwork_id, ...cls });
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

const updateStmt = db.prepare(`
  UPDATE provenance_events
  SET transfer_type = ?, transfer_category = ?, category_method = 'llm_enrichment'
  WHERE artwork_id = ? AND sequence = ? AND transfer_type = 'unknown'
`);

let updated = 0;
let notFound = 0;

const writeBatch = db.transaction((rows) => {
  for (const row of rows) {
    const category = TRANSFER_TYPE_TO_CATEGORY[row.transfer_type] ?? null;
    const result = updateStmt.run(
      row.transfer_type,
      category,
      row.artwork_id,
      row.event_sequence
    );
    if (result.changes > 0) {
      updated++;
    } else {
      notFound++;
      console.warn(`  WARN: No unknown event at artwork_id=${row.artwork_id} seq=${row.event_sequence}`);
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
console.log(`  Not found: ${notFound} (already reclassified or missing)`);
console.log(`  Version info updated.`);
