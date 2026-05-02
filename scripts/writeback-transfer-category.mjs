/**
 * Deterministic write-back: reclassify transfer_category from 'ambiguous' to 'ownership'
 * for all transfer-type events.
 *
 * Rationale: all 6,233 transfer/ambiguous events in the Rijksmuseum corpus are permanent
 * institutional transfers ("transferred to the museum", "transferred from Ministerie van Marine",
 * etc.). Verified via pilot LLM batch (50 records, 57/57 → ownership) and keyword analysis
 * (30 apparent custody matches were all inside bibliographic citations).
 *
 * Usage:
 *   node scripts/writeback-transfer-category.mjs [--dry-run] [--db PATH]
 */

import Database from "better-sqlite3";
import * as M from "./provenance-enrichment-methods.mjs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const dbIdx = args.indexOf("--db");
const dbPath = dbIdx >= 0 ? args[dbIdx + 1] : "data/vocabulary.db";

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

// Count before
const before = db.prepare(`
  SELECT transfer_type, COUNT(*) as cnt
  FROM provenance_events
  WHERE transfer_category = 'ambiguous' AND is_cross_ref = 0
  GROUP BY 1 ORDER BY 2 DESC
`).all();

console.log(`Transfer category write-back (ambiguous → ownership)`);
console.log(`  DB:       ${dbPath}`);
console.log(`  Dry run:  ${dryRun}`);
console.log();
console.log(`Before:`);
for (const row of before) {
  console.log(`  ${row.transfer_type}: ${row.cnt} ambiguous events`);
}

if (dryRun) {
  console.log(`\nDry run — no changes written.`);
  db.close();
  process.exit(0);
}

// Only reclassify transfer-type events (not unknown — those are unsold/#91)
const result = db.prepare(`
  UPDATE provenance_events
  SET transfer_category = 'ownership', category_method = '${M.RULE_TRANSFER_IS_OWNERSHIP}'
  WHERE transfer_type = 'transfer' AND transfer_category = 'ambiguous' AND is_cross_ref = 0
`).run();

console.log(`\nUpdated: ${result.changes} events (transfer → ownership)`);

// Update version_info
db.prepare(`INSERT OR REPLACE INTO version_info (key, value) VALUES ('transfer_category_rule_at', ?)`)
  .run(new Date().toISOString());

// Count after
const after = db.prepare(`
  SELECT transfer_category, COUNT(*) as cnt
  FROM provenance_events
  WHERE transfer_type = 'transfer' AND is_cross_ref = 0
  GROUP BY 1 ORDER BY 2 DESC
`).all();

console.log(`\nAfter (transfer-type events):`);
for (const row of after) {
  console.log(`  ${row.transfer_category}: ${row.cnt}`);
}

db.close();
