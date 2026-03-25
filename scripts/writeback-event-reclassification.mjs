/**
 * Write back LLM event reclassifications to provenance_events.
 *
 * Handles three actions:
 *   mark_non_provenance  — update transfer_type to non_provenance
 *   merge_with_adjacent  — update target event fields, delete source event + parties
 *   merge_alternatives   — set uncertain=true on target, delete alternative event + parties
 *
 * Usage:
 *   node scripts/writeback-event-reclassification.mjs --input <path> [options]
 *
 * Options:
 *   --dry-run        Report what would change, don't write
 *   --db PATH        Vocab DB path (default: data/vocabulary.db)
 *   --input PATH     Audit JSON from --mode event-reclassification
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
  console.error("Usage: node scripts/writeback-event-reclassification.mjs --input <path> [--dry-run] [--db PATH]");
  process.exit(1);
}

// ─── Load reclassifications ─────────────────────────────────────────

const data = JSON.parse(readFileSync(inputPath, "utf-8"));
console.log(`Event reclassification write-back`);
console.log(`  Input:          ${inputPath}`);
console.log(`  DB:             ${dbPath}`);
console.log(`  Dry run:        ${dryRun}`);
console.log(`  Min confidence: ${minConfidence}`);
console.log();

const allReclass = [];
for (const result of data.results) {
  if (result.error || !result.data?.reclassifications) continue;
  const { artwork_id, object_number } = result.data;
  for (const rc of result.data.reclassifications) {
    allReclass.push({ artwork_id, object_number, ...rc });
  }
}

const updates = allReclass.filter(rc => rc.confidence >= minConfidence);
const skipped = allReclass.length - updates.length;

console.log(`Reclassifications: ${allReclass.length} total`);
console.log(`  Applying:  ${updates.length}`);
console.log(`  Skipped:   ${skipped} (below ${minConfidence} confidence)`);

const actionCounts = {};
for (const u of updates) {
  actionCounts[u.action] = (actionCounts[u.action] || 0) + 1;
}
console.log(`\nBy action:`);
for (const [action, count] of Object.entries(actionCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${action.padEnd(22)} ${String(count).padStart(4)}`);
}
console.log();

if (dryRun) {
  console.log("Dry run — no changes written.");
  for (const u of updates.slice(0, 15)) {
    console.log(`  ${u.object_number} seq ${u.event_sequence} [${u.issue_type}]: ${u.action}${u.merge_target_sequence != null ? ` → seq ${u.merge_target_sequence}` : ""}`);
  }
  process.exit(0);
}

// ─── Write to DB ────────────────────────────────────────────────────

const ISSUE_TO_METHOD = {
  phantom_event: "llm_structural:#87",
  location_as_event: "llm_structural:#104",
  alternative_acquisition: "llm_structural:#103",
};

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

// Verify correction_method column exists
try {
  db.prepare("SELECT correction_method FROM provenance_events LIMIT 0").run();
} catch {
  console.error("ERROR: correction_method column missing. Re-parse the DB with the updated schema first.");
  process.exit(1);
}

const markNonProvStmt = db.prepare(`
  UPDATE provenance_events
  SET transfer_type = 'non_provenance', transfer_category = NULL,
      correction_method = ?, enrichment_reasoning = ?
  WHERE artwork_id = ? AND sequence = ?
`);

const deleteEventStmt = db.prepare(
  `DELETE FROM provenance_events WHERE artwork_id = ? AND sequence = ?`
);

const deletePartiesStmt = db.prepare(
  `DELETE FROM provenance_parties WHERE artwork_id = ? AND sequence = ?`
);

const updateTargetLocationStmt = db.prepare(`
  UPDATE provenance_events SET location = ?, correction_method = ?, enrichment_reasoning = ?
  WHERE artwork_id = ? AND sequence = ?
`);

const setUncertainStmt = db.prepare(`
  UPDATE provenance_events SET uncertain = 1, correction_method = ?, enrichment_reasoning = ?
  WHERE artwork_id = ? AND sequence = ?
`);

let marked = 0;
let merged = 0;
let deleted = 0;
let errors = 0;

const writeBatch = db.transaction((rows) => {
  for (const row of rows) {
    const method = ISSUE_TO_METHOD[row.issue_type] ?? `llm_structural:${row.issue_type}`;

    if (row.action === "mark_non_provenance") {
      const result = markNonProvStmt.run(method, row.reasoning, row.artwork_id, row.event_sequence);
      if (result.changes > 0) marked++;
      else { errors++; console.warn(`  WARN: No event at artwork_id=${row.artwork_id} seq=${row.event_sequence}`); }

    } else if (row.action === "merge_with_adjacent") {
      if (row.merge_target_sequence == null) {
        errors++;
        console.warn(`  WARN: merge_with_adjacent missing merge_target_sequence at artwork_id=${row.artwork_id} seq=${row.event_sequence}`);
        continue;
      }
      // Update target event if field updates provided
      if (row.merge_field_updates?.location) {
        updateTargetLocationStmt.run(row.merge_field_updates.location, method, row.reasoning, row.artwork_id, row.merge_target_sequence);
      }
      // Delete source event + its parties
      deletePartiesStmt.run(row.artwork_id, row.event_sequence);
      const result = deleteEventStmt.run(row.artwork_id, row.event_sequence);
      if (result.changes > 0) { merged++; deleted++; }
      else { errors++; console.warn(`  WARN: No event to delete at artwork_id=${row.artwork_id} seq=${row.event_sequence}`); }

    } else if (row.action === "merge_alternatives") {
      if (row.merge_target_sequence == null) {
        errors++;
        console.warn(`  WARN: merge_alternatives missing merge_target_sequence at artwork_id=${row.artwork_id} seq=${row.event_sequence}`);
        continue;
      }
      // Set uncertain on target
      setUncertainStmt.run(method, row.reasoning, row.artwork_id, row.merge_target_sequence);
      // Delete alternative event + its parties
      deletePartiesStmt.run(row.artwork_id, row.event_sequence);
      const result = deleteEventStmt.run(row.artwork_id, row.event_sequence);
      if (result.changes > 0) { merged++; deleted++; }
      else { errors++; console.warn(`  WARN: No event to delete at artwork_id=${row.artwork_id} seq=${row.event_sequence}`); }
    }
  }
});

writeBatch(updates);

// ─── Update version_info ────────────────────────────────────────────

db.prepare(`INSERT OR REPLACE INTO version_info (key, value) VALUES ('event_reclass_at', ?)`)
  .run(new Date().toISOString());
db.prepare(`INSERT OR REPLACE INTO version_info (key, value) VALUES ('event_reclass_batch', ?)`)
  .run(data.meta?.batchId ?? "manual");
db.prepare(`INSERT OR REPLACE INTO version_info (key, value) VALUES ('event_reclass_count', ?)`)
  .run(String(marked + merged));

db.close();

// ─── Report ─────────────────────────────────────────────────────────

console.log(`Results:`);
console.log(`  Marked non_provenance: ${marked}`);
console.log(`  Merged (deleted):      ${merged}`);
console.log(`  Events deleted:        ${deleted}`);
console.log(`  Errors:                ${errors}`);
console.log(`  Version info updated.`);
