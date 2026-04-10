/**
 * Recompute provenance_periods (Layer 2) from provenance_events (Layer 1).
 *
 * Use after Step 7 event splitting/reclassification changes the event
 * structure, making the existing periods stale. This script re-derives
 * ownership periods from the current event data using interpretPeriods().
 *
 * Usage:
 *   node scripts/recompute-periods.mjs [options]
 *
 * Options:
 *   --artwork-ids N,N,...  Recompute only these artwork IDs (comma-separated)
 *   --all                 Recompute for all artworks with provenance
 *   --dry-run             Report what would change, don't write
 *   --db PATH             Vocab DB path (default: data/vocabulary.db)
 *
 * At least one of --artwork-ids or --all is required.
 */

import Database from "better-sqlite3";
import { interpretPeriods } from "../dist/provenance-interpret.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const all = args.includes("--all");
const dbPath = args.includes("--db") ? args[args.indexOf("--db") + 1] : "data/vocabulary.db";
const artworkIdsArg = args.includes("--artwork-ids")
  ? args[args.indexOf("--artwork-ids") + 1].split(",").map(Number)
  : null;

if (!all && !artworkIdsArg) {
  console.error("ERROR: Provide --artwork-ids N,N,... or --all");
  process.exit(1);
}

// ─── DB setup ──────────────────────────────────────────────────────

const db = new Database(dbPath, dryRun ? { readonly: true } : undefined);
if (!dryRun) db.pragma("journal_mode = WAL");

// Verify provenance tables exist
try {
  db.prepare("SELECT 1 FROM provenance_events LIMIT 0").run();
  db.prepare("SELECT 1 FROM provenance_periods LIMIT 0").run();
} catch {
  console.error("ERROR: provenance_events or provenance_periods table missing.");
  process.exit(1);
}

// ─── Prepared statements ───────────────────────────────────────────

const getEvents = db.prepare(
  `SELECT * FROM provenance_events WHERE artwork_id = ? ORDER BY sequence`
);

const getCreationDates = db.prepare(
  `SELECT date_earliest, date_latest FROM artworks WHERE art_id = ?`
);

const deletePeriods = dryRun ? null : db.prepare(
  `DELETE FROM provenance_periods WHERE artwork_id = ?`
);

const insertPeriod = dryRun ? null : db.prepare(`
  INSERT INTO provenance_periods (
    artwork_id, sequence, owner_name, owner_dates, location,
    acquisition_method, acquisition_from,
    begin_year, begin_year_latest, end_year,
    derivation, uncertain, citations, source_events
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// ─── DB row → RawProvenanceEvent ───────────────────────────────────

function dbRowToEvent(row) {
  let parties;
  try { parties = JSON.parse(row.parties || "[]"); } catch { parties = []; }
  let citations;
  try { citations = JSON.parse(row.citations || "[]"); } catch { citations = []; }

  return {
    sequence: row.sequence,
    rawText: row.raw_text,
    gap: !!row.gap,
    transferType: row.transfer_type,
    unsold: !!row.unsold,
    batchPrice: !!row.batch_price,
    uncertain: !!row.uncertain,
    parties,
    dateExpression: row.date_expression,
    dateYear: row.date_year,
    dateQualifier: row.date_qualifier,
    location: row.location,
    price: row.price_amount != null
      ? { amount: row.price_amount, currency: row.price_currency, raw: null }
      : null,
    saleDetails: row.sale_details,
    citations,
    isCrossRef: !!row.is_cross_ref,
    crossRefTarget: row.cross_ref_target,
    parseMethod: row.parse_method,
  };
}

// ─── Shared processing ─────────────────────────────────────────────

function computePeriods(artworkId) {
  const eventRows = getEvents.all(artworkId);
  if (eventRows.length === 0) return null;
  const events = eventRows.map(dbRowToEvent);
  const dates = getCreationDates.get(artworkId);
  return interpretPeriods(events, {
    creationDateEarliest: dates?.date_earliest ?? null,
    creationDateLatest: dates?.date_latest ?? null,
  });
}

// ─── Get target artwork IDs ────────────────────────────────────────

let artworkIds;
if (all) {
  artworkIds = db.prepare(
    `SELECT DISTINCT artwork_id FROM provenance_events ORDER BY artwork_id`
  ).all().map(r => r.artwork_id);
} else {
  artworkIds = artworkIdsArg;
}

console.log(`Recompute provenance periods (Layer 2)`);
console.log(`  DB:          ${dbPath}`);
console.log(`  Artworks:    ${artworkIds.length}${all ? " (all)" : ""}`);
console.log(`  Dry run:     ${dryRun}`);
console.log();

// ─── Process ───────────────────────────────────────────────────────

let processed = 0;
let periodsDeleted = 0;
let periodsInserted = 0;
let skipped = 0;
let errors = 0;

function processArtwork(artworkId) {
  const periods = computePeriods(artworkId);
  if (periods == null) { skipped++; return; }

  if (!dryRun) {
    const deleted = deletePeriods.run(artworkId);
    periodsDeleted += deleted.changes;

    for (const p of periods) {
      insertPeriod.run(
        artworkId, p.sequence,
        p.owner?.name ?? null, p.owner?.dates ?? null,
        p.location,
        p.acquisitionMethod, p.acquisitionFrom?.name ?? null,
        p.beginYear, p.beginYearLatest, p.endYear,
        JSON.stringify(p.derivation), p.uncertain ? 1 : 0,
        p.citations ? JSON.stringify(p.citations) : null,
        p.sourceEvents ? JSON.stringify(p.sourceEvents) : null
      );
    }
  }
  periodsInserted += periods.length;
  processed++;
}

if (dryRun) {
  for (const artworkId of artworkIds) {
    processArtwork(artworkId);
  }
} else {
  const BATCH_SIZE = 1000;
  for (let i = 0; i < artworkIds.length; i += BATCH_SIZE) {
    const batch = artworkIds.slice(i, i + BATCH_SIZE);
    const runBatch = db.transaction(() => {
      for (const artworkId of batch) {
        try {
          processArtwork(artworkId);
        } catch (err) {
          errors++;
          console.error(`  ERROR artwork_id=${artworkId}: ${err.message}`);
        }
      }
    });
    runBatch();
    if ((i + BATCH_SIZE) % 5000 < BATCH_SIZE && artworkIds.length > 5000) {
      console.log(`  ${Math.min(i + BATCH_SIZE, artworkIds.length)}/${artworkIds.length}...`);
    }
  }
}

db.close();

// ─── Report ────────────────────────────────────────────────────────

console.log(`Results:`);
console.log(`  Artworks processed: ${processed}`);
console.log(`  Periods deleted:    ${dryRun ? "(dry run)" : periodsDeleted}`);
console.log(`  Periods inserted:   ${periodsInserted}`);
if (skipped > 0) console.log(`  Skipped (no events): ${skipped}`);
if (errors > 0) console.log(`  Errors:              ${errors}`);
if (dryRun) console.log(`\n(dry run — no changes written)`);
