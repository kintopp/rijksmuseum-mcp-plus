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
 *   --value       Migrate DB-resident LLM enrichments (event.type + event.parties)
 *   --manual      Migrate manual CSV corrections
 *   --structural  Migrate event-count structural ops (splits / reclassify /
 *                 field-correction) from the audit JSONs, keyed on the parent
 *                 event's raw_text via the deterministic-parent oracle (Phase 2).
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
import { buildOracle } from "./emit-deterministic-parents.mjs";
import { TRANSFER_TYPE_TO_CATEGORY } from "../dist/provenance.js";

// Structural audit ops are gated at this confidence in the original writeback
// scripts (writeback-event-splitting / -event-reclassification / -field-corrections
// all default --min-confidence 0.7, and POST-REPARSE-STEPS 7a/7b/7c invoke them with
// no override). The store MUST mirror that gate so the content-addressed re-apply
// reproduces exactly what the writebacks applied — not the sub-threshold /
// degenerate audit entries they discard. (See
// plans/provenance-enrichment-structural-confidence-leak.md.)
export const MIN_STRUCTURAL_CONFIDENCE = 0.7;

// The 1a LLM type-classification audit. The value extractor reads it to capture
// event.type enrichments whose category_method='llm_enrichment' marker was later
// overwritten by the rule writeback 1b (transfer-category) → otherwise invisible to
// a category_method-only DB scan. Mirror 1a's gate: confidence>=0.7, skip the
// no-op types. (plans/provenance-enrichment-value-recategorize-leak.md)
export const TYPE_CLASSIFICATION_AUDIT = "data/audit/audit-type-classification-2026-03-22.json";
const MIN_TYPE_CONFIDENCE = 0.7;
const TYPE_SKIP = new Set(["non_provenance", "unknown"]);

/**
 * Normalize typographic quotes/apostrophes to ASCII. The v0.24 type-classification
 * audit captured raw_text with straight quotes; later harvests render the same events
 * with curly quotes (U+2018/2019/201C/201D…). Same event, different bytes — used only
 * as a content-match FALLBACK in the 1a recovery, never for store keys.
 */
function normalizeQuotes(s) {
  return String(s)
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"');
}

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
 * @returns {Array<{table:string,artwork_id:string,object_number:string,sequence:string,party_idx:string,field:string,old_value:string,new_value:string,reasoning:string}>}
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
export function runValueExtractor(db, { dryRun, seenPK = new Set(), typeAuditFile = TYPE_CLASSIFICATION_AUDIT }) {
  const counts = { event_type: 0, party_snapshot: 0, event_type_recovered: 0, type_unresolved: 0 };

  // Collect all distinct artwork_ids that have enriched events or LLM parties
  const artworkIds = db.prepare(`
    SELECT DISTINCT artwork_id FROM provenance_events
    WHERE category_method = ?
    UNION
    SELECT DISTINCT artwork_id FROM provenance_parties
    WHERE position_method IN (?, ?)
  `).all(M.LLM_ENRICHMENT, M.LLM_ENRICHMENT, M.LLM_DISAMBIGUATION).map((r) => r.artwork_id);

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

  // ── 1a type-classification audit recovery (option A; finding #2) ──────────────
  // The DB-scan above keys event.type on category_method='llm_enrichment'. But the
  // rule writeback 1b (transfer-category) overwrites that marker to
  // 'rule:transfer_is_ownership' on events 1a (LLM) classified, hiding them from a
  // category_method-only scan. The 1a audit is authoritative: capture every
  // classification it applied (mirroring 1a's confidence>=0.7 + skip non_provenance/
  // unknown), content-addressed by the audit's OWN raw_text (no oracle needed — the
  // type audit carries raw_text inline). Dedup via seenPK keeps the DB-scan's row for
  // events still tagged llm_enrichment, so this only ADDS the recategorized ones.
  // Derive transfer_category exactly as 1a does (TRANSFER_TYPE_TO_CATEGORY), so the
  // store row + reapply + a re-run of 1b reproduce the original final state.
  const typeAudit = typeAuditFile ? loadAuditJson(typeAuditFile) : null;
  if (typeAudit) {
    const getArtByObj = db.prepare("SELECT art_id FROM artworks WHERE object_number = ?");
    for (const result of typeAudit.results ?? []) {
      const objectNumber = result.data?.object_number;
      if (!objectNumber) continue;
      const art = getArtByObj.get(objectNumber);
      if (!art) continue;
      const evts = getEvents.all(art.art_id);
      const groups = buildDupOrdinals(evts);
      for (const cls of result.data?.classifications ?? []) {
        if ((cls.confidence ?? 0) < MIN_TYPE_CONFIDENCE) continue;
        if (TYPE_SKIP.has(cls.transfer_type)) continue;
        if (cls.raw_text == null) continue;
        // Resolve the CURRENT event this 1a classification applies to. Prefer an exact
        // content match; fall back to a quote-normalized UNIQUE match (audit straight
        // quotes vs current curly). Key the store row on the CURRENT event's raw_text
        // hash either way, so the content-addressed re-apply finds it.
        let curRaw = null, curSeq = null;
        const seqs = groups.get(rawTextHash(cls.raw_text));
        if (seqs && seqs.length > 0) {
          curSeq = seqs.includes(cls.event_sequence) ? cls.event_sequence : seqs[0];
          curRaw = evts.find((e) => e.sequence === curSeq)?.raw_text ?? null;
        } else {
          const target = normalizeQuotes(cls.raw_text);
          const cands = evts.filter((e) => normalizeQuotes(e.raw_text) === target);
          if (cands.length === 1) { curRaw = cands[0].raw_text; curSeq = cands[0].sequence; }
        }
        if (curRaw == null) { counts.type_unresolved++; continue; } // re-segmented / genuinely changed
        const h = rawTextHash(curRaw);
        const { dup_ordinal, dup_count } = dupKey(groups, h, curSeq);
        const field = "event.type";
        const pk = `${objectNumber}|${h}|${dup_ordinal}|${field}|-1`;
        if (seenPK.has(pk)) continue; // already captured by the DB-scan
        seenPK.add(pk);
        counts.event_type++;
        counts.event_type_recovered++;
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
              transfer_type: cls.transfer_type,
              transfer_category: TRANSFER_TYPE_TO_CATEGORY[cls.transfer_type] ?? null,
            }),
            method: M.LLM_ENRICHMENT,
            reasoning: cls.reasoning ?? null,
            confidence: null,
            source: "audit:type-classification",
          });
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

  const getArtId = db.prepare("SELECT art_id FROM artworks WHERE object_number = ?");
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

  // Group rows by (table, object_number, sequence)
  const groups = new Map();
  for (const row of rows) {
    const table = row.table;
    const objectNumber = row.object_number;
    const sequence = parseInt(row.sequence, 10);
    const key = `${table}|${objectNumber}|${sequence}`;
    if (!groups.has(key)) groups.set(key, { table, objectNumber, sequence, csvRows: [] });
    groups.get(key).csvRows.push(row);
  }

  for (const [, group] of groups) {
    const { table, objectNumber, sequence, csvRows } = group;

    // Validate table
    const validTables = new Set(["provenance_events", "provenance_parties", "provenance_periods"]);
    if (!validTables.has(table)) {
      throw new Error(`runManualExtractor: unknown table "${table}" in CSV — expected one of: ${[...validTables].join(", ")}`);
    }

    // Resolve object_number → art_id
    const aidRow = getArtId.get(objectNumber);
    if (!aidRow) {
      throw new Error(`runManualExtractor: object_number ${objectNumber} not found in artworks table`);
    }
    const artworkId = aidRow.art_id;

    // Resolve event
    const evtRow = getEvent.get(artworkId, sequence);
    if (!evtRow) {
      throw new Error(`runManualExtractor: no provenance_event for object_number=${objectNumber} sequence=${sequence}`);
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

// ─── Structural extractor (--structural mode) ────────────────────────────────

/**
 * Default audit JSON paths (resolved relative to data/audit/).
 * These files are gitignored and absent from a fresh worktree — the extractor
 * reads them only at real-DB migrate time (Phase 3, maintainer).
 */
export const STRUCTURAL_AUDIT_FILES = {
  split: "data/audit/audit-event-splitting-v0.24-2026-04-19.json",
  reclassify: "data/audit/audit-event-reclassification-v0.24-2026-04-19.json",
  fieldcorrection: "data/audit/audit-field-correction-v0.24-2026-04-19.json",
};

/**
 * Resolve a parent event's (raw_text, dup_ordinal, dup_count) from the oracle.
 * Returns null when the object/sequence has no parent in the clean re-parse.
 *
 * @param {{byObjSeq: Map<string,string>, groupsByObj: Map<string,Map<string,number[]>>}} oracle
 * @param {string} objectNumber
 * @param {number} sequence
 */
function resolveParent(oracle, objectNumber, sequence) {
  const rawText = oracle.byObjSeq.get(`${objectNumber}|${sequence}`);
  if (rawText == null || String(rawText).trim() === "") return null;
  const groups = oracle.groupsByObj.get(objectNumber);
  if (!groups) return null;
  const h = rawTextHash(rawText);
  const { dup_ordinal, dup_count } = dupKey(groups, h, sequence);
  return { rawText, hash: h, dup_ordinal, dup_count };
}

/**
 * Extract the leading top-level JSON array from a string that begins with a valid
 * array but carries trailing garbage (Finding B). Scans from the first `[`,
 * tracking bracket depth while RESPECTING string literals — `[`/`]` inside a
 * "…" string (honouring `\"` escapes) are ignored, because the inner
 * raw_text_quote can contain `{`,`}`, and brackets. Returns the substring from
 * the first `[` through the matching `]` that returns depth to 0. Throws if no
 * balanced array prefix exists (caller catches → structural_unparseable).
 *
 * @param {string} str
 * @returns {string} the balanced leading `[…]` substring
 */
function extractLeadingJsonArray(str) {
  const start = str.indexOf("[");
  if (start < 0) throw new Error("extractLeadingJsonArray: no '[' found");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < str.length; i++) {
    const ch = str[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "[") {
      depth++;
    } else if (ch === "]") {
      depth--;
      if (depth === 0) return str.slice(start, i + 1);
    }
  }
  throw new Error("extractLeadingJsonArray: unbalanced array — no matching ']'");
}

/**
 * Scan the structural audit JSONs and emit op_kind='structural' store rows,
 * keyed on the deterministic parent event's raw_text (via the oracle).
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ dryRun: boolean, seenPK?: Set<string>, auditFiles?: object, oracle?: object }} opts
 * @returns {{ event_split: number, event_reclassify: number, event_fieldcorrection: number, unresolved: number, structural_unparseable: number }}
 */
export function runStructuralExtractor(db, { dryRun, seenPK = new Set(), auditFiles = STRUCTURAL_AUDIT_FILES, oracle } = {}) {
  const counts = { event_split: 0, event_reclassify: 0, event_fieldcorrection: 0, unresolved: 0, structural_unparseable: 0 };

  // Build the parent-text oracle from a clean deterministic re-parse, unless one
  // was supplied (tests pass a synthetic oracle).
  const orc = oracle ?? buildOracle(db);

  const insertStmt = dryRun ? null : db.prepare(`
    INSERT INTO provenance_enrichments
      (object_number, raw_text_hash, dup_ordinal, dup_count, field, party_idx,
       op_kind, payload, method, reasoning, confidence, source)
    VALUES
      (@object_number, @raw_text_hash, @dup_ordinal, @dup_count, @field, @party_idx,
       @op_kind, @payload, @method, @reasoning, @confidence, @source)
  `);

  /** Emit one structural row. Returns true if emitted (not deduped). */
  function emitStructural({ objectNumber, sequence, field, payload, issueType, reasoning, confidence, batchId, countKey }) {
    const parent = resolveParent(orc, objectNumber, sequence);
    if (!parent) {
      counts.unresolved++;
      return false;
    }
    const pk = `${objectNumber}|${parent.hash}|${parent.dup_ordinal}|${field}|-1`;
    if (seenPK.has(pk)) {
      throw new Error(
        `runStructuralExtractor: duplicate PK for ${objectNumber} seq=${sequence} field=${field} — parent raw_text hash collision not separated by dup_ordinal`
      );
    }
    seenPK.add(pk);
    // method literal from the centralised set — never hardcode the prefix string.
    const method = issueType ? `${M.LLM_STRUCTURAL_PREFIX}${issueType}` : M.LLM_STRUCTURAL;
    if (!dryRun) {
      insertStmt.run({
        object_number: objectNumber,
        raw_text_hash: parent.hash,
        dup_ordinal: parent.dup_ordinal,
        dup_count: parent.dup_count,
        field,
        party_idx: -1,
        op_kind: "structural",
        payload: JSON.stringify(payload),
        method,
        reasoning: reasoning ?? null,
        confidence: confidence ?? null,
        source: batchId ?? "audit",
      });
    }
    counts[countKey]++;
    return true;
  }

  // ── A. event splitting ──────────────────────────────────────────────────────
  const splitData = loadAuditJson(auditFiles.split);
  if (splitData) {
    const batchId = splitData.meta?.batchId ?? "audit";
    for (const result of splitData.results ?? []) {
      if (result.error || !result.data?.splits) continue;
      const objectNumber = result.data.object_number;
      for (const s of result.data.splits) {
        // Mirror writeback-event-splitting's two filters exactly: sub-threshold
        // confidence (undefined kept, since `undefined < N` is false — matches the
        // writeback's `if (s.confidence < minConfidence) continue`) and degenerate
        // splits (< 2 replacement events are not real splits).
        if (s.confidence < MIN_STRUCTURAL_CONFIDENCE) continue;
        if (!s.replacement_events || s.replacement_events.length < 2) continue;
        emitStructural({
          objectNumber,
          sequence: s.original_sequence,
          field: "event.split",
          payload: s, // verbatim splits[] entry
          issueType: s.issue_type,
          reasoning: s.reasoning ?? null,
          confidence: s.confidence ?? null,
          batchId,
          countKey: "event_split",
        });
      }
    }
  }

  // ── B. event reclassification ───────────────────────────────────────────────
  const reclassData = loadAuditJson(auditFiles.reclassify);
  if (reclassData) {
    const batchId = reclassData.meta?.batchId ?? "audit";
    for (const result of reclassData.results ?? []) {
      if (result.error) continue;
      const rc = result.data?.reclassifications;
      if (rc == null) continue;
      const objectNumber = result.data?.object_number;
      // JSON-shape gotcha (Step 2.2): usually a real array (197/200), occasionally a
      // *malformed* double-encoded string (3/200) — a JSON array followed by trailing
      // sibling-key / comma garbage (the LLM object lost its wrapping braces). A bare
      // JSON.parse THROWS on all three, and since migrate() runs in ONE transaction,
      // that single throw rolls back the WHOLE migration. Parse robustly, and guard
      // the whole per-result parse so one bad record never aborts the transaction.
      let recs;
      if (Array.isArray(rc)) {
        recs = rc; // 197 normal cases
      } else if (typeof rc === "string") {
        try {
          recs = JSON.parse(rc); // clean strings parse directly
        } catch {
          try {
            // The 3 malformed strings are a valid leading JSON array followed by
            // literal trailing garbage (`<parameter …>` markup, a sibling key, or
            // a bare comma — real bytes verified 2026-06-14). A bare JSON.parse
            // fails with "Extra data" AFTER the array, proving the leading [...] is
            // valid on its own. Extract that balanced array prefix (string-aware).
            recs = JSON.parse(extractLeadingJsonArray(rc));
          } catch {
            counts.structural_unparseable++;
            console.warn(`runStructuralExtractor: unparseable reclassifications for ${objectNumber}`);
            continue;
          }
        }
      } else {
        counts.structural_unparseable++;
        console.warn(`runStructuralExtractor: unparseable reclassifications for ${objectNumber}`);
        continue;
      }
      if (!Array.isArray(recs)) {
        counts.structural_unparseable++;
        console.warn(`runStructuralExtractor: unparseable reclassifications for ${objectNumber}`);
        continue;
      }
      for (const r of recs) {
        // Mirror writeback-event-reclassification: keep only confidence >= 0.7
        // (its `.filter(rc => rc.confidence >= minConfidence)` drops undefined).
        if (!(r.confidence >= MIN_STRUCTURAL_CONFIDENCE)) continue;
        emitStructural({
          objectNumber,
          sequence: r.event_sequence,
          field: "event.reclassify",
          payload: r, // verbatim reclassifications[] entry
          issueType: r.issue_type,
          reasoning: r.reasoning ?? null,
          confidence: r.confidence ?? null,
          batchId,
          countKey: "event_reclassify",
        });
      }
    }
  }

  // ── C. field correction ─────────────────────────────────────────────────────
  // GROUP per event (Finding A, real-data 2026-06-14): 17 events carry TWO
  // corrections[] entries (14× location+parties, 3× location+location). Both
  // resolve to the SAME parent → the SAME store PK, so one row PER correction
  // trips the seenPK STOP and aborts the whole transaction. Emit ONE
  // event.fieldcorrection row per (object, event) whose payload is
  // {corrections:[…]} (the full verbatim list); re-apply iterates and applies each.
  const fieldData = loadAuditJson(auditFiles.fieldcorrection);
  if (fieldData) {
    const batchId = fieldData.meta?.batchId ?? "audit";
    for (const result of fieldData.results ?? []) {
      if (result.error || !result.data?.corrections) continue;
      const objectNumber = result.data.object_number;
      // Group this result's corrections by event_sequence (an event = one parent).
      const byEvent = new Map();
      for (const c of result.data.corrections) {
        // Mirror writeback-field-corrections: keep only confidence >= 0.7
        // (its `.filter(c => c.confidence >= minConfidence)` drops undefined).
        if (!(c.confidence >= MIN_STRUCTURAL_CONFIDENCE)) continue;
        const seq = c.event_sequence;
        if (!byEvent.has(seq)) byEvent.set(seq, []);
        byEvent.get(seq).push(c);
      }
      for (const [sequence, corrections] of byEvent) {
        const first = corrections[0];
        emitStructural({
          objectNumber,
          sequence,
          field: "event.fieldcorrection",
          payload: { corrections }, // full verbatim list for this event
          // method/reasoning/confidence ride the FIRST correction; re-apply
          // derives the per-correction method from each entry's issue_type, so
          // the store row's single method column is not load-bearing.
          issueType: first.issue_type,
          reasoning: first.reasoning ?? null,
          confidence: first.confidence ?? null,
          batchId,
          countKey: "event_fieldcorrection",
        });
      }
    }
  }

  return counts;
}

/** Read + parse an audit JSON; returns null if the file is absent. */
function loadAuditJson(filePath) {
  if (!filePath) return null;
  let text;
  try {
    text = readFileSync(filePath, "utf-8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
  return JSON.parse(text);
}

// ─── Top-level migrate (wraps extractors in one transaction) ──────────────────

/**
 * Run the migration in a single transaction.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ value?: boolean, manual?: boolean, structural?: boolean, dryRun?: boolean, csvPath?: string, auditFiles?: object, oracle?: object }} opts
 * @returns {{ event_type?: number, party_snapshot: number, event_manual?: number, period_manual?: number, event_split?: number, event_reclassify?: number, event_fieldcorrection?: number, structural_unresolved?: number }}
 */
export function migrate(db, { value = false, manual = false, structural = false, dryRun = false, csvPath, auditFiles, oracle, typeAuditFile } = {}) {
  applyEnrichmentsSchema(db);

  const allCounts = { party_snapshot: 0 };
  const seenPK = new Set();

  const run = db.transaction(() => {
    if (!dryRun) {
      // Idempotent: clear previous value/manual migration rows before re-inserting.
      // 'audit:type-classification' is the 1a-recovery source (option A) — must be
      // cleared too, else a re-run collides on its PKs.
      db.prepare(
        "DELETE FROM provenance_enrichments WHERE source IN ('migration:db', 'manual-csv', 'audit:type-classification')"
      ).run();
      // Structural rows carry the audit batchId as source, so clear them by op_kind.
      if (structural) {
        db.prepare(
          "DELETE FROM provenance_enrichments WHERE op_kind = 'structural'"
        ).run();
      }
    }

    if (value) {
      const c = runValueExtractor(db, { dryRun, seenPK, ...(typeAuditFile !== undefined ? { typeAuditFile } : {}) });
      allCounts.event_type = (allCounts.event_type ?? 0) + c.event_type;
      allCounts.party_snapshot += c.party_snapshot;
      allCounts.event_type_recovered = (allCounts.event_type_recovered ?? 0) + c.event_type_recovered;
      allCounts.type_unresolved = (allCounts.type_unresolved ?? 0) + c.type_unresolved;
    }

    if (manual) {
      if (!csvPath) throw new Error("migrate: --manual requires a csvPath");
      const c = runManualExtractor(db, { dryRun, csvPath, seenPK });
      allCounts.event_manual = (allCounts.event_manual ?? 0) + c.event_manual;
      allCounts.period_manual = (allCounts.period_manual ?? 0) + c.period_manual;
      allCounts.party_snapshot += c.party_snapshot;
    }

    if (structural) {
      const c = runStructuralExtractor(db, { dryRun, seenPK, auditFiles, oracle });
      allCounts.event_split = (allCounts.event_split ?? 0) + c.event_split;
      allCounts.event_reclassify = (allCounts.event_reclassify ?? 0) + c.event_reclassify;
      allCounts.event_fieldcorrection = (allCounts.event_fieldcorrection ?? 0) + c.event_fieldcorrection;
      allCounts.structural_unresolved = (allCounts.structural_unresolved ?? 0) + c.unresolved;
      allCounts.structural_unparseable = (allCounts.structural_unparseable ?? 0) + c.structural_unparseable;
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

  const wantValue = args.includes("--value");
  const wantManual = args.includes("--manual");
  const wantStructural = args.includes("--structural");
  if (!wantValue && !wantManual && !wantStructural) {
    console.error("Usage: migrate-enrichments-to-store.mjs [--value] [--manual] [--structural] [--dry-run] [--db PATH] [--csv PATH]");
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
    const counts = migrate(db, { value: wantValue, manual: wantManual, structural: wantStructural, dryRun, csvPath });
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
