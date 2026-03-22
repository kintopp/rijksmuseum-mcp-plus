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
import { inferPosition, TRANSFER_TYPE_TO_CATEGORY } from "../dist/provenance.js";

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
  transfer_category TEXT,
  category_method TEXT,
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
  `CREATE INDEX IF NOT EXISTS idx_prov_category ON provenance_events(transfer_category) WHERE transfer_category IS NOT NULL`,
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

const PARTIES_SCHEMA = `
CREATE TABLE IF NOT EXISTS provenance_parties (
  artwork_id   INTEGER NOT NULL,
  sequence     INTEGER NOT NULL,
  party_idx    INTEGER NOT NULL,
  party_name   TEXT    NOT NULL,
  party_dates  TEXT,
  party_role   TEXT,
  party_position TEXT,
  position_method TEXT,
  uncertain    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (artwork_id, sequence, party_idx)
) WITHOUT ROWID;
`;

const PARTIES_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_party_name ON provenance_parties(party_name)`,
  `CREATE INDEX IF NOT EXISTS idx_party_position ON provenance_parties(party_position) WHERE party_position IS NOT NULL`,
];

// ─── Main ───────────────────────────────────────────────────────────

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

// Drop and recreate tables (schema may have changed — new columns like party_position, transfer_category)
if (!dryRun) {
  db.exec("DROP TABLE IF EXISTS provenance_events");
  db.exec("DROP TABLE IF EXISTS provenance_parties");
  if (!layer1Only) db.exec("DROP TABLE IF EXISTS provenance_periods");
  db.exec(EVENTS_SCHEMA);
  for (const idx of EVENTS_INDEXES) db.exec(idx);
  db.exec(PARTIES_SCHEMA);
  for (const idx of PARTIES_INDEXES) db.exec(idx);
  if (!layer1Only) {
    db.exec(PERIODS_SCHEMA);
    for (const idx of PERIODS_INDEXES) db.exec(idx);
  }
}

// Prepare statements
const insertEvent = dryRun ? null : db.prepare(`
  INSERT INTO provenance_events (
    artwork_id, sequence, raw_text, gap, transfer_type,
    transfer_category, category_method, uncertain,
    parties, date_expression, date_year, date_qualifier,
    location, price_amount, price_currency, sale_details, citations,
    is_cross_ref, cross_ref_target, parse_method
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertParty = dryRun ? null : db.prepare(`
  INSERT INTO provenance_parties (
    artwork_id, sequence, party_idx, party_name, party_dates, party_role,
    party_position, position_method, uncertain
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertPeriod = (dryRun || layer1Only) ? null : db.prepare(`
  INSERT INTO provenance_periods (
    artwork_id, sequence, owner_name, owner_dates, location,
    acquisition_method, acquisition_from,
    begin_year, begin_year_latest, end_year,
    derivation, uncertain, citations, source_events
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// Fetch artworks with provenance
// Using .all() not .iterate() — better-sqlite3 iterators hold an open cursor that
// conflicts with transactions. 48K rows × short text ≈ 20MB, well within budget.
const query = limit
  ? `SELECT art_id, provenance_text FROM artworks WHERE provenance_text IS NOT NULL AND provenance_text != '' LIMIT ?`
  : `SELECT art_id, provenance_text FROM artworks WHERE provenance_text IS NOT NULL AND provenance_text != ''`;
const rows = limit ? db.prepare(query).all(limit) : db.prepare(query).all();

console.log(`Found ${rows.length} artworks with provenance text\n`);

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
      const category = TRANSFER_TYPE_TO_CATEGORY[e.transferType] ?? null;
      // Enrich parties with position before serializing to JSON column
      const enrichedParties = e.parties.map(p => ({
        ...p,
        position: inferPosition(p.role, e.transferType),
      }));
      insertEvent.run(
        artId, e.sequence, e.rawText, e.gap ? 1 : 0, e.transferType,
        category, category ? "type_mapping" : null, e.uncertain ? 1 : 0,
        JSON.stringify(enrichedParties), e.dateExpression, e.dateYear, e.dateQualifier,
        e.location, e.price?.amount ?? null, e.price?.currency ?? null, e.saleDetails,
        JSON.stringify(e.citations),
        e.isCrossRef ? 1 : 0, e.crossRefTarget, e.parseMethod
      );
      // Insert normalized parties
      if (insertParty && e.parties) {
        for (let i = 0; i < e.parties.length; i++) {
          const p = e.parties[i];
          const pos = inferPosition(p.role, e.transferType);
          insertParty.run(
            artId, e.sequence, i,
            p.name, p.dates ?? null, p.role ?? null,
            pos, pos ? "role_mapping" : null, p.uncertain ? 1 : 0
          );
        }
      }
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
      console.log(`  ${processed}/${rows.length} (${elapsed}s)`);
    }
  }
}

// Final batch
if (batch.length > 0) {
  processed += batch.length;
  insertBatch(batch);
}

// ─── Credit-line enrichment (#121) ──────────────────────────────────
// Infer transfer_type for bare-name unknowns from the artwork's credit_line.
// Only applies when: (a) the unknown event is the last or second-to-last,
// (b) if second-to-last, the last event is a museum acquisition (sale/gift/bequest/loan/transfer),
// (c) the credit_line contains a recognizable transfer keyword.

const CREDIT_LINE_RULES = [
  [/Gift|Schenking|geschonken/i, "gift"],
  [/urchas|Aankoop|ekocht|aangekocht|verworven/i, "purchase"],
  [/loan|Bruikleen/i, "loan"],
  [/equest|Legaat/i, "bequest"],
  [/Transfer|Overdracht/i, "transfer"],
];
const MUSEUM_ACQUISITION_TYPES = new Set(["sale", "gift", "bequest", "loan", "transfer", "purchase"]);

let creditLineEnriched = 0;

if (!dryRun) {
  // Find unknowns eligible for credit_line inference
  const candidates = db.prepare(`
    WITH ranked AS (
      SELECT e.artwork_id, e.sequence, e.transfer_type, e.is_cross_ref, e.parties, e.raw_text,
        ROW_NUMBER() OVER (PARTITION BY e.artwork_id ORDER BY e.sequence DESC) AS rn
      FROM provenance_events e
    )
    SELECT r.artwork_id, r.sequence, r.rn, r.raw_text, a.credit_line,
      (SELECT r2.transfer_type FROM ranked r2 WHERE r2.artwork_id = r.artwork_id AND r2.rn = 1) AS last_type
    FROM ranked r
    JOIN artworks a ON a.art_id = r.artwork_id
    WHERE r.transfer_type = 'unknown' AND r.is_cross_ref = 0
      AND r.parties IS NOT NULL AND r.parties <> '[]'
      AND r.rn <= 2
      AND a.credit_line IS NOT NULL AND a.credit_line <> ''
  `).all();
  const UNSOLD_RE = /\b(?:unsold|bought\s+in|withdrawn|invendu|ingetrokken)\b/i;

  const updateTypeAndMethod = db.prepare(
    `UPDATE provenance_events SET transfer_type = ?, transfer_category = ?, category_method = 'type_mapping', parse_method = 'credit_line' WHERE artwork_id = ? AND sequence = ?`
  );

  const enrichBatch = db.transaction((rows) => {
    for (const row of rows) {
      // If second-to-last, only infer if last event is a museum acquisition
      if (row.rn === 2 && !MUSEUM_ACQUISITION_TYPES.has(row.last_type)) continue;
      // Skip events deliberately classified as unknown due to unsold detection
      if (UNSOLD_RE.test(row.raw_text)) continue;

      // Match credit_line against rules
      for (const [re, type] of CREDIT_LINE_RULES) {
        if (re.test(row.credit_line)) {
          updateTypeAndMethod.run(type, TRANSFER_TYPE_TO_CATEGORY[type] ?? null, row.artwork_id, row.sequence);
          creditLineEnriched++;
          // Update stats
          transferCounts["unknown"]--;
          transferCounts[type] = (transferCounts[type] || 0) + 1;
          break;
        }
      }
    }
  });

  enrichBatch(candidates);
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
console.log(`  Artworks:      ${rows.length}`);
console.log(`  Cross-refs:    ${crossRefs}`);
console.log(`  Total events:  ${totalEvents}`);
console.log(`  PEG parsed:    ${pegEvents} (${(100 * pegEvents / totalEvents).toFixed(1)}%)`);
console.log(`  Regex fallback: ${fallbackEvents} (${(100 * fallbackEvents / totalEvents).toFixed(1)}%)`);
if (!layer1Only) {
  console.log(`  Total periods: ${totalPeriods}`);
}
if (creditLineEnriched > 0) {
  console.log(`  Credit-line enriched: ${creditLineEnriched}`);
}
console.log(`\n  Transfer type distribution:`);
const sorted = Object.entries(transferCounts).sort((a, b) => b[1] - a[1]);
for (const [type, count] of sorted) {
  console.log(`    ${type.padEnd(15)} ${String(count).padStart(7)} (${(100 * count / totalEvents).toFixed(1)}%)`);
}

db.close();
console.log(`\nDone.${dryRun ? " (dry run — no changes written)" : ""}`);
