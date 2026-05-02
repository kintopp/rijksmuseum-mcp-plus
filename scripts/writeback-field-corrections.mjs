/**
 * Write back LLM field corrections to provenance_events/provenance_parties.
 *
 * Handles three issue types:
 *   #149 truncated_location — update location field
 *   #119 wrong_location     — update location field
 *   #116 missing_receiver   — insert party + sync parties JSON
 *
 * Usage:
 *   node scripts/writeback-field-corrections.mjs --input <path> [options]
 *
 * Options:
 *   --dry-run        Report what would change, don't write
 *   --db PATH        Vocab DB path (default: data/vocabulary.db)
 *   --input PATH     Audit JSON from --mode field-correction
 *   --min-confidence N  Minimum confidence threshold (default: 0.7)
 *   --id-remap       Resolve object_number → art_id (use after re-harvest)
 */

import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { parseIdRemapFlag, createIdResolver } from "./lib/id-remap.mjs";
import * as M from "./provenance-enrichment-methods.mjs";

// ─── CLI args ───────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const idRemap = parseIdRemapFlag(args);
const dbIdx = args.indexOf("--db");
const dbPath = dbIdx >= 0 ? args[dbIdx + 1] : "data/vocabulary.db";
const inputIdx = args.indexOf("--input");
const inputPath = inputIdx >= 0 ? args[inputIdx + 1] : null;
const confIdx = args.indexOf("--min-confidence");
const minConfidence = confIdx >= 0 ? parseFloat(args[confIdx + 1]) : 0.7;

if (!inputPath) {
  console.error("Usage: node scripts/writeback-field-corrections.mjs --input <path> [--dry-run] [--db PATH]");
  process.exit(1);
}

// ─── Load corrections ───────────────────────────────────────────────

const data = JSON.parse(readFileSync(inputPath, "utf-8"));
console.log(`Field correction write-back`);
console.log(`  Input:          ${inputPath}`);
console.log(`  DB:             ${dbPath}`);
console.log(`  Dry run:        ${dryRun}`);
console.log(`  Min confidence: ${minConfidence}`);
console.log(`  Model:          ${data.meta?.model ?? "unknown"}`);
console.log(`  Source batch:   ${data.meta?.batchId ?? "unknown"}`);
console.log();

// Flatten all corrections
const allCorrections = [];
for (const result of data.results) {
  if (result.error || !result.data?.corrections) continue;
  const { artwork_id, object_number } = result.data;
  for (const c of result.data.corrections) {
    allCorrections.push({ artwork_id, object_number, ...c });
  }
}

// Filter by confidence
const updates = allCorrections.filter(c => c.confidence >= minConfidence);
const skipped = allCorrections.length - updates.length;

console.log(`Corrections: ${allCorrections.length} total`);
console.log(`  Applying:  ${updates.length}`);
console.log(`  Skipped:   ${skipped} (below ${minConfidence} confidence)`);

// Distribution
const issueCounts = {};
for (const u of updates) {
  issueCounts[u.issue_type] = (issueCounts[u.issue_type] || 0) + 1;
}
console.log(`\nBy issue type:`);
for (const [type, count] of Object.entries(issueCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${type.padEnd(22)} ${String(count).padStart(4)}`);
}
console.log();

if (dryRun) {
  console.log("Dry run — no changes written.");
  for (const u of updates.slice(0, 10)) {
    console.log(`  ${u.object_number} seq ${u.event_sequence} [${u.issue_type}]: "${u.current_value}" → "${u.corrected_value}"`);
  }
  process.exit(0);
}

// ─── Write to DB ────────────────────────────────────────────────────

const ISSUE_TO_METHOD = {
  truncated_location: "llm_structural:#149",
  wrong_location: "llm_structural:#119",
  missing_receiver: "llm_structural:#116",
};

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
const resolve = createIdResolver(db, idRemap);

// Verify correction_method column exists (added by batch-parse-provenance.mjs schema)
try {
  db.prepare("SELECT correction_method FROM provenance_events LIMIT 0").run();
} catch {
  console.error("ERROR: correction_method column missing. Re-parse the DB with the updated schema first.");
  process.exit(1);
}

const updateLocationStmt = db.prepare(`
  UPDATE provenance_events
  SET location = ?, correction_method = ?, enrichment_reasoning = ?
  WHERE artwork_id = ? AND sequence = ? AND location = ?
`);

const insertPartyStmt = db.prepare(`
  INSERT INTO provenance_parties (artwork_id, sequence, party_idx, party_name, party_role, party_position, position_method, enrichment_reasoning)
  VALUES (?, ?, ?, ?, ?, ?, '${M.LLM_STRUCTURAL}', ?)
`);

const getMaxPartyIdx = db.prepare(
  `SELECT COALESCE(MAX(party_idx), -1) AS max_idx FROM provenance_parties WHERE artwork_id = ? AND sequence = ?`
);

const getPartiesJson = db.prepare(
  `SELECT parties FROM provenance_events WHERE artwork_id = ? AND sequence = ?`
);

const updatePartiesJson = db.prepare(
  `UPDATE provenance_events SET parties = ?, correction_method = ?, enrichment_reasoning = ? WHERE artwork_id = ? AND sequence = ?`
);

let locationUpdated = 0;
let partyInserted = 0;
let notFound = 0;
let skippedRemap = 0;

const writeBatch = db.transaction((rows) => {
  for (const row of rows) {
    const artworkId = resolve(row.artwork_id, row.object_number);
    if (artworkId == null) { skippedRemap++; continue; }
    const method = ISSUE_TO_METHOD[row.issue_type] ?? `llm_structural:${row.issue_type}`;

    if (row.field === "location") {
      const result = updateLocationStmt.run(
        row.corrected_value,
        method,
        row.reasoning,
        artworkId,
        row.event_sequence,
        row.current_value  // safety: only update if current value matches
      );
      if (result.changes > 0) {
        locationUpdated++;
      } else {
        notFound++;
        console.warn(`  WARN: Location mismatch at artwork_id=${artworkId} seq=${row.event_sequence} (expected "${row.current_value}")`);
      }
    } else if (row.field === "parties" && row.new_party) {
      // Insert new party
      const { max_idx } = getMaxPartyIdx.get(artworkId, row.event_sequence);
      const newIdx = max_idx + 1;

      insertPartyStmt.run(
        artworkId,
        row.event_sequence,
        newIdx,
        row.new_party.name,
        row.new_party.role ?? null,
        row.new_party.position,
        row.reasoning
      );

      // Sync parties JSON on provenance_events
      const evtRow = getPartiesJson.get(artworkId, row.event_sequence);
      if (evtRow) {
        let parties;
        try { parties = JSON.parse(evtRow.parties || "[]"); } catch { parties = []; }
        parties.push({
          name: row.new_party.name,
          role: row.new_party.role ?? null,
          position: row.new_party.position,
        });
        updatePartiesJson.run(
          JSON.stringify(parties),
          method,
          row.reasoning,
          artworkId,
          row.event_sequence
        );
      }
      partyInserted++;
    }
  }
});

writeBatch(updates);

// ─── Update version_info ────────────────────────────────────────────

db.transaction(() => {
  db.prepare(`INSERT OR REPLACE INTO version_info (key, value) VALUES ('field_correction_at', ?)`)
    .run(new Date().toISOString());
  db.prepare(`INSERT OR REPLACE INTO version_info (key, value) VALUES ('field_correction_batch', ?)`)
    .run(data.meta?.batchId ?? "manual");
  db.prepare(`INSERT OR REPLACE INTO version_info (key, value) VALUES ('field_correction_count', ?)`)
    .run(String(locationUpdated + partyInserted));
})();

db.close();

// ─── Report ─────────────────────────────────────────────────────────

console.log(`Results:`);
console.log(`  Locations updated: ${locationUpdated}`);
console.log(`  Parties inserted:  ${partyInserted}`);
console.log(`  Not found/mismatch: ${notFound}`);
if (skippedRemap > 0) console.log(`  Skipped (id-remap): ${skippedRemap}`);
console.log(`  Version info updated.`);
