/**
 * Batch parse provenance records from vocab DB into structured tables.
 *
 * Reads artworks.provenance_text, runs Layer 1 (PEG parser) + Layer 2
 * (interpretation), and populates provenance_events + provenance_periods.
 *
 * Usage:
 *   node scripts/batch-parse-provenance.mjs [options]
 *
 * Options:
 *   --dry-run        Parse but don't write to DB (report stats only)
 *   --limit N        Only process first N artworks
 *   --layer1-only    Skip Layer 2 interpretation (fast grammar iteration)
 *   --db PATH        Vocab DB path (default: data/vocabulary.db)
 */

import Database from "better-sqlite3";
import { parseProvenanceRaw } from "../dist/provenance-peg.js";
import { interpretPeriods } from "../dist/provenance-interpret.js";

// ─── CLI args ───────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const layer1Only = args.includes("--layer1-only");
const limitIdx = args.indexOf("--limit");
const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : 0;
const dbIdx = args.indexOf("--db");
const dbPath = dbIdx >= 0 ? args[dbIdx + 1] : "data/vocabulary.db";

console.log(`Batch provenance parser`);
console.log(`  DB:         ${dbPath}`);
console.log(`  Dry run:    ${dryRun}`);
console.log(`  Layer 1:    always`);
console.log(`  Layer 2:    ${layer1Only ? "SKIPPED" : "yes"}`);
console.log(`  Limit:      ${limit || "none"}`);
console.log();

// ─── Schema ─────────────────────────────────────────────────────────

const EVENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS provenance_events (
  artwork_id     INTEGER NOT NULL,
  sequence       INTEGER NOT NULL,
  raw_text       TEXT    NOT NULL,
  gap            INTEGER NOT NULL DEFAULT 0,
  transfer_type  TEXT    NOT NULL,
  uncertain      INTEGER NOT NULL DEFAULT 0,
  parties        TEXT,
  date_expression TEXT,
  date_year      INTEGER,
  date_qualifier TEXT,
  location       TEXT,
  price_amount   REAL,
  price_currency TEXT,
  sale_details   TEXT,
  citations      TEXT,
  is_cross_ref     INTEGER NOT NULL DEFAULT 0,
  cross_ref_target TEXT,
  parse_method   TEXT NOT NULL DEFAULT 'peg',
  PRIMARY KEY (artwork_id, sequence)
) WITHOUT ROWID;
`;

const EVENTS_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_prov_transfer ON provenance_events(transfer_type)`,
  `CREATE INDEX IF NOT EXISTS idx_prov_year ON provenance_events(date_year) WHERE date_year IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_prov_location ON provenance_events(location) WHERE location IS NOT NULL`,
];

const PERIODS_SCHEMA = `
CREATE TABLE IF NOT EXISTS provenance_periods (
  artwork_id          INTEGER NOT NULL,
  sequence            INTEGER NOT NULL,
  owner_name          TEXT,
  owner_dates         TEXT,
  location            TEXT,
  acquisition_method  TEXT,
  acquisition_from    TEXT,
  begin_year          INTEGER,
  begin_year_latest   INTEGER,
  end_year            INTEGER,
  derivation          TEXT,
  uncertain           INTEGER NOT NULL DEFAULT 0,
  citations           TEXT,
  source_events       TEXT,
  PRIMARY KEY (artwork_id, sequence)
) WITHOUT ROWID;
`;

const PERIODS_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_period_owner ON provenance_periods(owner_name) WHERE owner_name IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_period_begin ON provenance_periods(begin_year) WHERE begin_year IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_period_end ON provenance_periods(end_year) WHERE end_year IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_period_method ON provenance_periods(acquisition_method)`,
];

// ─── Main ───────────────────────────────────────────────────────────

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

// Create tables
if (!dryRun) {
  db.exec(EVENTS_SCHEMA);
  for (const idx of EVENTS_INDEXES) db.exec(idx);
  if (!layer1Only) {
    db.exec(PERIODS_SCHEMA);
    for (const idx of PERIODS_INDEXES) db.exec(idx);
  }
  // Clear existing data
  db.exec("DELETE FROM provenance_events");
  if (!layer1Only) {
    try { db.exec("DELETE FROM provenance_periods"); } catch { /* table may not exist */ }
  }
}

// Prepare statements
const insertEvent = dryRun ? null : db.prepare(`
  INSERT INTO provenance_events (
    artwork_id, sequence, raw_text, gap, transfer_type, uncertain,
    parties, date_expression, date_year, date_qualifier,
    location, price_amount, price_currency, sale_details, citations,
    is_cross_ref, cross_ref_target, parse_method
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertPeriod = (dryRun || layer1Only) ? null : db.prepare(`
  INSERT INTO provenance_periods (
    artwork_id, sequence, owner_name, owner_dates, location,
    acquisition_method, acquisition_from,
    begin_year, begin_year_latest, end_year,
    derivation, uncertain, citations, source_events
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// Fetch artworks with provenance (count for progress, iterate for memory efficiency)
const countQuery = limit
  ? `SELECT COUNT(*) AS cnt FROM artworks WHERE provenance_text IS NOT NULL AND provenance_text != '' LIMIT ?`
  : `SELECT COUNT(*) AS cnt FROM artworks WHERE provenance_text IS NOT NULL AND provenance_text != ''`;
const totalRows = limit
  ? db.prepare(countQuery).get(limit).cnt
  : db.prepare(countQuery).get().cnt;

const dataQuery = limit
  ? `SELECT art_id, provenance_text FROM artworks WHERE provenance_text IS NOT NULL AND provenance_text != '' LIMIT ?`
  : `SELECT art_id, provenance_text FROM artworks WHERE provenance_text IS NOT NULL AND provenance_text != ''`;
const rows = limit ? db.prepare(dataQuery).iterate(limit) : db.prepare(dataQuery).iterate();

console.log(`Found ${totalRows} artworks with provenance text\n`);

// Stats
let totalEvents = 0;
let pegEvents = 0;
let fallbackEvents = 0;
let crossRefs = 0;
let totalPeriods = 0;
const transferCounts = {};
const BATCH_SIZE = 500;

const startTime = Date.now();

// Process in batches
const insertBatch = dryRun ? () => {} : db.transaction((batch) => {
  for (const { artId, events, periods } of batch) {
    for (const e of events) {
      insertEvent.run(
        artId, e.sequence, e.rawText, e.gap ? 1 : 0, e.transferType, e.uncertain ? 1 : 0,
        JSON.stringify(e.parties), e.dateExpression, e.dateYear, e.dateQualifier,
        e.location, e.price?.amount ?? null, e.price?.currency ?? null, e.saleDetails,
        JSON.stringify(e.citations),
        e.isCrossRef ? 1 : 0, e.crossRefTarget, e.parseMethod
      );
    }
    if (insertPeriod && periods) {
      for (const p of periods) {
        insertPeriod.run(
          artId, p.sequence, p.owner?.name ?? null, p.owner?.dates ?? null, p.location,
          p.acquisitionMethod, p.acquisitionFrom?.name ?? null,
          p.beginYear, p.beginYearLatest, p.endYear,
          JSON.stringify(p.derivation), p.uncertain ? 1 : 0,
          JSON.stringify(p.citations), JSON.stringify(p.sourceEvents)
        );
      }
    }
  }
});

let batch = [];
let processed = 0;

for (const row of rows) {
  const result = parseProvenanceRaw(row.provenance_text);

  totalEvents += result.events.length;
  pegEvents += result.stats.peg;
  fallbackEvents += result.stats.fallback;
  if (result.isCrossRef) crossRefs++;

  for (const e of result.events) {
    transferCounts[e.transferType] = (transferCounts[e.transferType] || 0) + 1;
  }

  let periods = null;
  if (!layer1Only && !result.isCrossRef) {
    periods = interpretPeriods(result.events);
    totalPeriods += periods.length;
  }

  batch.push({ artId: row.art_id, events: result.events, periods });

  if (batch.length >= BATCH_SIZE) {
    processed += batch.length;
    insertBatch(batch);
    batch = [];
    if (processed % 5000 < BATCH_SIZE) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`  ${processed}/${totalRows} (${elapsed}s)`);
    }
  }
}

// Final batch
if (batch.length > 0) {
  processed += batch.length;
  insertBatch(batch);
}

// Update version_info
if (!dryRun) {
  db.exec(`CREATE TABLE IF NOT EXISTS version_info (key TEXT PRIMARY KEY, value TEXT)`);
  db.prepare(`INSERT OR REPLACE INTO version_info (key, value) VALUES ('provenance_parsed_at', ?)`)
    .run(new Date().toISOString());
}

const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

// ─── Report ─────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(60)}`);
console.log(`  Batch parse complete (${elapsed}s)`);
console.log(`${"═".repeat(60)}`);
console.log(`  Artworks:      ${processed}`);
console.log(`  Cross-refs:    ${crossRefs}`);
console.log(`  Total events:  ${totalEvents}`);
console.log(`  PEG parsed:    ${pegEvents} (${(100 * pegEvents / totalEvents).toFixed(1)}%)`);
console.log(`  Regex fallback: ${fallbackEvents} (${(100 * fallbackEvents / totalEvents).toFixed(1)}%)`);
if (!layer1Only) {
  console.log(`  Total periods: ${totalPeriods}`);
}
console.log(`\n  Transfer type distribution:`);
const sorted = Object.entries(transferCounts).sort((a, b) => b[1] - a[1]);
for (const [type, count] of sorted) {
  console.log(`    ${type.padEnd(15)} ${String(count).padStart(7)} (${(100 * count / totalEvents).toFixed(1)}%)`);
}

db.close();
console.log(`\nDone.${dryRun ? " (dry run — no changes written)" : ""}`);
