/**
 * migrate-enrichments-to-store.mjs
 *
 * Migrates existing LLM enrichments and manual CSV corrections from the
 * vocabulary DB into the content-addressed provenance_enrichments store.
 *
 * Usage:
 *   node scripts/migrate-enrichments-to-store.mjs [--value] [--manual] [--dry-run]
 *     [--db PATH] [--csv PATH]
 *
 * Modes (additive, run together in one transaction):
 *   --value     Migrate DB-resident LLM enrichments (event.type + event.parties)
 *   --manual    Migrate manual CSV corrections
 *   --structural  → error: not implemented in Phase 1
 *
 * Options:
 *   --dry-run   Read + print summary, write nothing
 *   --db PATH   Vocab DB path (default: data/vocabulary.db)
 *   --csv PATH  Manual corrections CSV (default: scripts/manual-corrections-2026-03-23.csv)
 */

import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rawTextHash, buildDupOrdinals, dupKey } from "./lib/raw-text-hash.mjs";
import * as M from "./lib/provenance-enrichment-methods.mjs";

// ─── Exported schema ──────────────────────────────────────────────────────────

export const ENRICHMENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS provenance_enrichments (
  object_number  TEXT    NOT NULL,
  raw_text_hash  TEXT    NOT NULL,
  dup_ordinal    INTEGER NOT NULL DEFAULT 0,
  dup_count      INTEGER NOT NULL DEFAULT 1,
  field          TEXT    NOT NULL,
  party_idx      INTEGER NOT NULL DEFAULT -1,
  op_kind        TEXT    NOT NULL,
  payload        TEXT    NOT NULL,
  method         TEXT    NOT NULL,
  reasoning      TEXT,
  confidence     REAL,
  source         TEXT,
  PRIMARY KEY (object_number, raw_text_hash, dup_ordinal, field, party_idx)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_prov_enr_obj ON provenance_enrichments(object_number);
CREATE INDEX IF NOT EXISTS idx_prov_enr_kind ON provenance_enrichments(op_kind);
`.trim();

// ─── Apply schema ────────────────────────────────────────────────────────────

/**
 * Create provenance_enrichments table + indexes in the given DB.
 * @param {import("better-sqlite3").Database} db
 */
export function applyEnrichmentsSchema(db) {
  for (const stmt of ENRICHMENTS_SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) {
    db.exec(stmt + ";");
  }
}

// ─── CSV parser ──────────────────────────────────────────────────────────────

/**
 * Pure CSV text parser for manual corrections format.
 * Returns array of row objects with string values.
 * @param {string} text
 * @returns {Array<{table:string,artwork_id:string,sequence:string,party_idx:string,field:string,old_value:string,new_value:string,reasoning:string}>}
 */
export function parseManualCsvText(text) {
  const lines = text.split(/\r?\n/);
  if (lines.length === 0) return [];
  const header = lines[0].split(",");
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    // Simple CSV parse — values may not be quoted in this format
    const parts = line.split(",");
    const row = {};
    for (let j = 0; j < header.length; j++) {
      row[header[j]] = parts[j] !== undefined ? parts[j] : "";
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Read and parse a manual corrections CSV file.
 * @param {string} csvPath
 */
export function parseManualCsv(csvPath) {
  const text = readFileSync(csvPath, "utf-8");
  return parseManualCsvText(text);
}

// ─── Shared party-snapshot helper ────────────────────────────────────────────

/**
 * Build and insert (or dedupe) a party snapshot enrichment row.
 * @param {import("better-sqlite3").Statement} insertStmt
 * @param {Set<string>} seenPK
 * @param {object} opts
 * @param {string} opts.objectNumber
 * @param {number} opts.artworkId
 * @param {number} opts.sequence
 * @param {string} opts.rawText
 * @param {Map<string,number[]>} opts.groups
 * @param {string} opts.source
 * @param {object[]} opts.parties  full relational party rows for this event (sorted asc by party_idx)
 * @returns {boolean} true if row emitted (not deduped)
 */
function emitPartySnapshotRow(insertStmt, seenPK, { objectNumber, sequence, rawText, groups, source, parties }) {
  const h = rawTextHash(rawText);
  const { dup_ordinal, dup_count } = dupKey(groups, h, sequence);
  const field = "event.parties";
  const party_idx = -1;
  const pk = `${objectNumber}|${h}|${dup_ordinal}|${field}|${party_idx}`;
  if (seenPK.has(pk)) return false; // dedupe silently for snapshots
  seenPK.add(pk);

  const payload = JSON.stringify({
    parties: parties.map((p) => ({
      party_idx: p.party_idx,
      party_name: p.party_name,
      party_dates: p.party_dates ?? null,
      party_role: p.party_role ?? null,
      party_position: p.party_position ?? null,
      position_method: p.position_method ?? null,
      uncertain: p.uncertain ?? 0,
      enrichment_reasoning: p.enrichment_reasoning ?? null,
    })),
  });

  insertStmt.run({
    object_number: objectNumber,
    raw_text_hash: h,
    dup_ordinal,
    dup_count,
    field,
    party_idx,
    op_kind: "parties",
    payload,
    method: "snapshot",
    reasoning: null,
    confidence: null,
    source,
  });
  return true;
}

// ─── Core value extractor (--value mode) ─────────────────────────────────────

/**
 * Scan the DB for LLM enrichments and emit store rows.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ dryRun: boolean }} opts
 * @returns {{ event_type: number, party_snapshot: number }}
 */
export function runValueExtractor(db, { dryRun, seenPK = new Set() }) {
  const counts = { event_type: 0, party_snapshot: 0 };

  // Collect all distinct artwork_ids that have enriched events or LLM parties
  const artworkIds = db.prepare(`
    SELECT DISTINCT artwork_id FROM provenance_events
    WHERE category_method = ?
    UNION
    SELECT DISTINCT artwork_id FROM provenance_parties
    WHERE position_method IN (?, ?)
  `).all(M.LLM_ENRICHMENT, M.LLM_ENRICHMENT, M.LLM_DISAMBIGUATION).map((r) => r.artwork_id);

  if (artworkIds.length === 0) return counts;

  const getObjectNumber = db.prepare("SELECT object_number FROM artworks WHERE art_id = ?");
  const getEvents = db.prepare(`
    SELECT sequence, raw_text, transfer_type, transfer_category, category_method,
           enrichment_reasoning, correction_method
    FROM provenance_events WHERE artwork_id = ? ORDER BY sequence
  `);
  const getParties = db.prepare(`
    SELECT party_idx, party_name, party_dates, party_role, party_position,
           position_method, uncertain, enrichment_reasoning
    FROM provenance_parties WHERE artwork_id = ? AND sequence = ?
    ORDER BY party_idx
  `);

  // Prepare insert statement (only used when not dry-run)
  const insertStmt = dryRun ? null : db.prepare(`
    INSERT INTO provenance_enrichments
      (object_number, raw_text_hash, dup_ordinal, dup_count, field, party_idx,
       op_kind, payload, method, reasoning, confidence, source)
    VALUES
      (@object_number, @raw_text_hash, @dup_ordinal, @dup_count, @field, @party_idx,
       @op_kind, @payload, @method, @reasoning, @confidence, @source)
  `);

  for (const artworkId of artworkIds) {
    const objRow = getObjectNumber.get(artworkId);
    if (!objRow) {
      throw new Error(`runValueExtractor: artwork_id ${artworkId} has no object_number in artworks table`);
    }
    const objectNumber = objRow.object_number;

    const events = getEvents.all(artworkId);
    const groups = buildDupOrdinals(events);

    for (const evt of events) {
      const isStructural = evt.correction_method != null &&
        String(evt.correction_method).startsWith(M.LLM_STRUCTURAL_PREFIX);

      // A. event.type enrichment
      if (evt.category_method === M.LLM_ENRICHMENT) {
        const h = rawTextHash(evt.raw_text);
        const { dup_ordinal, dup_count } = dupKey(groups, h, evt.sequence);
        const field = "event.type";
        const pk = `${objectNumber}|${h}|${dup_ordinal}|${field}|-1`;
        if (seenPK.has(pk)) {
          throw new Error(
            `runValueExtractor: duplicate PK for ${objectNumber} seq=${evt.sequence} field=event.type — raw_text hash collision not separated by dup_ordinal`
          );
        }
        seenPK.add(pk);
        counts.event_type++;
        if (!dryRun) {
          insertStmt.run({
            object_number: objectNumber,
            raw_text_hash: h,
            dup_ordinal,
            dup_count,
            field,
            party_idx: -1,
            op_kind: "value",
            payload: JSON.stringify({
              transfer_type: evt.transfer_type,
              transfer_category: evt.transfer_category,
            }),
            method: M.LLM_ENRICHMENT,
            reasoning: evt.enrichment_reasoning ?? null,
            confidence: null,
            source: "migration:db",
          });
        }
      }

      // B. event.parties snapshot (non-structural events with LLM parties)
      if (!isStructural) {
        const parties = getParties.all(artworkId, evt.sequence);
        const hasLlmParty = parties.some(
          (p) => p.position_method === M.LLM_ENRICHMENT || p.position_method === M.LLM_DISAMBIGUATION
        );
        if (hasLlmParty) {
          const emitted = dryRun
            ? !seenPK.has(`${objectNumber}|${rawTextHash(evt.raw_text)}|${dupKey(groups, rawTextHash(evt.raw_text), evt.sequence).dup_ordinal}|event.parties|-1`)
            : emitPartySnapshotRow(insertStmt, seenPK, {
                objectNumber,
                artworkId,
                sequence: evt.sequence,
                rawText: evt.raw_text,
                groups,
                source: "migration:db",
                parties,
              });
          if (emitted) counts.party_snapshot++;
          // For dryRun, still mark seenPK to count correctly
          if (dryRun && emitted) {
            const h = rawTextHash(evt.raw_text);
            const { dup_ordinal } = dupKey(groups, h, evt.sequence);
            seenPK.add(`${objectNumber}|${h}|${dup_ordinal}|event.parties|-1`);
          }
        }
      }
    }
  }

  return counts;
}

// ─── Manual CSV extractor (--manual mode) ────────────────────────────────────

/**
 * Scan the manual corrections CSV and emit store rows.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ dryRun: boolean, csvPath: string }} opts
 * @returns {{ event_manual: number, period_manual: number, party_snapshot: number }}
 */
export function runManualExtractor(db, { dryRun, csvPath, seenPK = new Set() }) {
  const counts = { event_manual: 0, period_manual: 0, party_snapshot: 0 };

  const rows = parseManualCsv(csvPath);
  if (rows.length === 0) return counts;

  const getObjectNumber = db.prepare("SELECT object_number FROM artworks WHERE art_id = ?");
  const getEvent = db.prepare(
    "SELECT sequence, raw_text FROM provenance_events WHERE artwork_id = ? AND sequence = ?"
  );
  const getAllEvents = db.prepare(
    "SELECT sequence, raw_text FROM provenance_events WHERE artwork_id = ? ORDER BY sequence"
  );
  const getParties = db.prepare(`
    SELECT party_idx, party_name, party_dates, party_role, party_position,
           position_method, uncertain, enrichment_reasoning
    FROM provenance_parties WHERE artwork_id = ? AND sequence = ?
    ORDER BY party_idx
  `);

  const insertStmt = dryRun ? null : db.prepare(`
    INSERT INTO provenance_enrichments
      (object_number, raw_text_hash, dup_ordinal, dup_count, field, party_idx,
       op_kind, payload, method, reasoning, confidence, source)
    VALUES
      (@object_number, @raw_text_hash, @dup_ordinal, @dup_count, @field, @party_idx,
       @op_kind, @payload, @method, @reasoning, @confidence, @source)
  `);

  // Group rows by (table, artwork_id, sequence)
  const groups = new Map();
  for (const row of rows) {
    const table = row.table;
    const artworkId = parseInt(row.artwork_id, 10);
    const sequence = parseInt(row.sequence, 10);
    const key = `${table}|${artworkId}|${sequence}`;
    if (!groups.has(key)) groups.set(key, { table, artworkId, sequence, csvRows: [] });
    groups.get(key).csvRows.push(row);
  }

  for (const [, group] of groups) {
    const { table, artworkId, sequence, csvRows } = group;

    // Validate table
    const validTables = new Set(["provenance_events", "provenance_parties", "provenance_periods"]);
    if (!validTables.has(table)) {
      throw new Error(`runManualExtractor: unknown table "${table}" in CSV — expected one of: ${[...validTables].join(", ")}`);
    }

    // Resolve artwork_id → object_number
    const objRow = getObjectNumber.get(artworkId);
    if (!objRow) {
      throw new Error(`runManualExtractor: artwork_id ${artworkId} not found in artworks table`);
    }
    const objectNumber = objRow.object_number;

    // Resolve event
    const evtRow = getEvent.get(artworkId, sequence);
    if (!evtRow) {
      throw new Error(`runManualExtractor: no provenance_event for artwork_id=${artworkId} sequence=${sequence}`);
    }

    // Build dup ordinals for this artwork
    const allEvents = getAllEvents.all(artworkId);
    const dupGroups = buildDupOrdinals(allEvents);

    const h = rawTextHash(evtRow.raw_text);
    const { dup_ordinal, dup_count } = dupKey(dupGroups, h, sequence);

    if (table === "provenance_parties") {
      // Route to party snapshot — field=DELETE means capture current (desired) party list
      const parties = getParties.all(artworkId, sequence);
      const emitted = dryRun
        ? !seenPK.has(`${objectNumber}|${h}|${dup_ordinal}|event.parties|-1`)
        : emitPartySnapshotRow(insertStmt, seenPK, {
            objectNumber,
            artworkId,
            sequence,
            rawText: evtRow.raw_text,
            groups: dupGroups,
            source: "manual-csv",
            parties,
          });
      if (emitted) counts.party_snapshot++;
      if (dryRun && emitted) seenPK.add(`${objectNumber}|${h}|${dup_ordinal}|event.parties|-1`);
    } else if (table === "provenance_events") {
      // Merge group rows into payload
      const payload = {};
      let reasoning = null;
      for (const csvRow of csvRows) {
        const val = csvRow.new_value === "" ? null : csvRow.new_value;
        payload[csvRow.field] = val;
        if (csvRow.reasoning) reasoning = csvRow.reasoning;
      }

      const field = "event.manual";
      const pk = `${objectNumber}|${h}|${dup_ordinal}|${field}|-1`;
      if (!seenPK.has(pk)) {
        seenPK.add(pk);
        counts.event_manual++;
        if (!dryRun) {
          insertStmt.run({
            object_number: objectNumber,
            raw_text_hash: h,
            dup_ordinal,
            dup_count,
            field,
            party_idx: -1,
            op_kind: "value",
            payload: JSON.stringify(payload),
            method: M.MANUAL,
            reasoning: reasoning ?? null,
            confidence: null,
            source: "manual-csv",
          });
        }
      }
    } else if (table === "provenance_periods") {
      // Merge group rows into payload
      const payload = { period_sequence: sequence };
      let reasoning = null;
      for (const csvRow of csvRows) {
        const val = csvRow.new_value === "" ? null : csvRow.new_value;
        payload[csvRow.field] = val;
        if (csvRow.reasoning) reasoning = csvRow.reasoning;
      }

      const field = "period.manual";
      const pk = `${objectNumber}|${h}|${dup_ordinal}|${field}|-1`;
      if (!seenPK.has(pk)) {
        seenPK.add(pk);
        counts.period_manual++;
        if (!dryRun) {
          insertStmt.run({
            object_number: objectNumber,
            raw_text_hash: h,
            dup_ordinal,
            dup_count,
            field,
            party_idx: -1,
            op_kind: "value",
            payload: JSON.stringify(payload),
            method: M.MANUAL,
            reasoning: reasoning ?? null,
            confidence: null,
            source: "manual-csv",
          });
        }
      }
    }
  }

  return counts;
}

// ─── Top-level migrate (wraps extractors in one transaction) ──────────────────

/**
 * Run the migration in a single transaction.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ value?: boolean, manual?: boolean, dryRun?: boolean, csvPath?: string }} opts
 * @returns {{ event_type?: number, party_snapshot: number, event_manual?: number, period_manual?: number }}
 */
export function migrate(db, { value = false, manual = false, dryRun = false, csvPath } = {}) {
  applyEnrichmentsSchema(db);

  const allCounts = { party_snapshot: 0 };
  const seenPK = new Set();

  const run = db.transaction(() => {
    if (!dryRun) {
      // Idempotent: clear previous migration rows before re-inserting
      db.prepare(
        "DELETE FROM provenance_enrichments WHERE source IN ('migration:db', 'manual-csv')"
      ).run();
    }

    if (value) {
      const c = runValueExtractor(db, { dryRun, seenPK });
      allCounts.event_type = (allCounts.event_type ?? 0) + c.event_type;
      allCounts.party_snapshot += c.party_snapshot;
    }

    if (manual) {
      if (!csvPath) throw new Error("migrate: --manual requires a csvPath");
      const c = runManualExtractor(db, { dryRun, csvPath, seenPK });
      allCounts.event_manual = (allCounts.event_manual ?? 0) + c.event_manual;
      allCounts.period_manual = (allCounts.period_manual ?? 0) + c.period_manual;
      allCounts.party_snapshot += c.party_snapshot;
    }

    return allCounts;
  });

  return run();
}

// ─── isMain guard ─────────────────────────────────────────────────────────────

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const args = process.argv.slice(2);

  if (args.includes("--structural")) {
    console.error("--structural: not implemented in Phase 1");
    process.exit(1);
  }

  const wantValue = args.includes("--value");
  const wantManual = args.includes("--manual");
  if (!wantValue && !wantManual) {
    console.error("Usage: migrate-enrichments-to-store.mjs [--value] [--manual] [--dry-run] [--db PATH] [--csv PATH]");
    process.exit(1);
  }

  const dryRun = args.includes("--dry-run");
  const dbIdx = args.indexOf("--db");
  const dbPath = dbIdx >= 0 ? args[dbIdx + 1] : "data/vocabulary.db";
  const csvIdx = args.indexOf("--csv");
  const defaultCsvPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "manual-corrections-2026-03-23.csv"
  );
  const csvPath = csvIdx >= 0 ? args[csvIdx + 1] : defaultCsvPath;

  console.log("Provenance enrichment migration");
  console.log(`  DB:      ${dbPath}`);
  console.log(`  Dry run: ${dryRun}`);
  if (wantManual) console.log(`  CSV:     ${csvPath}`);
  console.log();

  let db;
  try {
    db = new Database(dbPath);
    const counts = migrate(db, { value: wantValue, manual: wantManual, dryRun, csvPath });
    console.log("Results:");
    for (const [k, v] of Object.entries(counts)) {
      console.log(`  ${k}: ${v}`);
    }
    if (dryRun) console.log("\n(dry-run — no writes)");
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  } finally {
    db?.close();
  }
}
