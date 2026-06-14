/**
 * test-provenance-enrichment-store.mjs
 *
 * Hermetic tests for the content-addressed provenance enrichment store.
 * Uses in-memory SQLite — no real data/vocabulary.db required.
 *
 * Run: node scripts/tests/test-provenance-enrichment-store.mjs
 */

import Database from "better-sqlite3";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// Import shipped functions — test must NOT reimplement these
import {
  applyEnrichmentsSchema,
  migrate,
  runStructuralExtractor,
} from "../migrate-enrichments-to-store.mjs";
import { reapply } from "../reapply-enrichments-from-store.mjs";
import { rawTextHash, buildDupOrdinals } from "../lib/raw-text-hash.mjs";
import * as M from "../lib/provenance-enrichment-methods.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_CSV = path.join(__dirname, "fixtures", "manual-corrections-fixture.csv");

// ─── Test helpers ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, msg) {
  if (condition) {
    passed++;
    process.stdout.write(`  ✓ ${msg}\n`);
  } else {
    failed++;
    failures.push(msg);
    process.stdout.write(`  ✗ ${msg}\n`);
  }
}

function assertEq(actual, expected, msg) {
  const ok = actual === expected;
  assert(ok, ok ? msg : `${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertDeepEq(actual, expected, msg) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(ok, ok ? msg : `${msg}\n    expected: ${JSON.stringify(expected)}\n    got:      ${JSON.stringify(actual)}`);
}

function section(name) {
  process.stdout.write(`\n${"═".repeat(60)}\n  ${name}\n${"═".repeat(60)}\n`);
}

// ─── Fixture DB builder ───────────────────────────────────────────────────────

function makeDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE artworks (
      art_id        INTEGER PRIMARY KEY,
      object_number TEXT NOT NULL
    );

    CREATE TABLE provenance_events (
      artwork_id        INTEGER NOT NULL,
      sequence          INTEGER NOT NULL,
      raw_text          TEXT    NOT NULL,
      gap               INTEGER NOT NULL DEFAULT 0,
      transfer_type     TEXT    NOT NULL,
      unsold            INTEGER NOT NULL DEFAULT 0,
      batch_price       INTEGER NOT NULL DEFAULT 0,
      transfer_category TEXT,
      category_method   TEXT,
      uncertain         INTEGER NOT NULL DEFAULT 0,
      parties           TEXT,
      date_expression   TEXT,
      date_year         INTEGER,
      date_qualifier    TEXT,
      location          TEXT,
      price_amount      REAL,
      price_currency    TEXT,
      sale_details      TEXT,
      citations         TEXT,
      is_cross_ref      INTEGER NOT NULL DEFAULT 0,
      cross_ref_target  TEXT,
      parse_method      TEXT NOT NULL DEFAULT 'peg',
      correction_method TEXT,
      enrichment_reasoning TEXT,
      PRIMARY KEY (artwork_id, sequence)
    ) WITHOUT ROWID;

    CREATE TABLE provenance_parties (
      artwork_id          INTEGER NOT NULL,
      sequence            INTEGER NOT NULL,
      party_idx           INTEGER NOT NULL,
      party_name          TEXT    NOT NULL,
      party_dates         TEXT,
      party_role          TEXT,
      party_position      TEXT,
      position_method     TEXT,
      uncertain           INTEGER NOT NULL DEFAULT 0,
      enrichment_reasoning TEXT,
      PRIMARY KEY (artwork_id, sequence, party_idx)
    ) WITHOUT ROWID;

    CREATE TABLE provenance_periods (
      artwork_id         INTEGER NOT NULL,
      sequence           INTEGER NOT NULL,
      owner_name         TEXT,
      owner_dates        TEXT,
      location           TEXT,
      acquisition_method TEXT,
      acquisition_from   TEXT,
      begin_year         INTEGER,
      begin_year_latest  INTEGER,
      end_year           INTEGER,
      derivation         TEXT,
      uncertain          INTEGER NOT NULL DEFAULT 0,
      citations          TEXT,
      source_events      TEXT,
      PRIMARY KEY (artwork_id, sequence)
    ) WITHOUT ROWID;
  `);
  applyEnrichmentsSchema(db);
  return db;
}

// ─── DB query helpers ──────────────────────────────────────────────────────────

function storeCount(db, filter) {
  return db.prepare(
    `SELECT COUNT(*) as n FROM provenance_enrichments${filter ? " WHERE " + filter : ""}`
  ).get().n;
}

function getStore(db, field) {
  return db.prepare(`SELECT * FROM provenance_enrichments WHERE field = ? ORDER BY dup_ordinal`)
    .all(field);
}

function getEvent(db, artworkId, sequence) {
  return db.prepare(
    "SELECT * FROM provenance_events WHERE artwork_id = ? AND sequence = ?"
  ).get(artworkId, sequence);
}

function getParties(db, artworkId, sequence) {
  return db.prepare(
    "SELECT * FROM provenance_parties WHERE artwork_id = ? AND sequence = ? ORDER BY party_idx"
  ).all(artworkId, sequence);
}

function getAllEvents(db, artworkId) {
  return db.prepare(
    "SELECT * FROM provenance_events WHERE artwork_id = ? ORDER BY sequence"
  ).all(artworkId);
}

/**
 * Insert a synthetic op_kind='structural' store row directly (re-apply consumes
 * it). Cases 10–11 test re-apply, not the audit-reading extractor, so the split
 * payload is hand-crafted to match the splits[] shape applySplits expects.
 */
function insertStructuralRow(db, { objectNumber, parentRawText, dupOrdinal = 0, dupCount = 1, field, payload, method }) {
  const hash = rawTextHash(parentRawText);
  db.prepare(`
    INSERT INTO provenance_enrichments
      (object_number, raw_text_hash, dup_ordinal, dup_count, field, party_idx,
       op_kind, payload, method, reasoning, confidence, source)
    VALUES (?, ?, ?, ?, ?, -1, 'structural', ?, ?, ?, NULL, 'audit:test')
  `).run(
    objectNumber, hash, dupOrdinal, dupCount, field,
    JSON.stringify(payload), method, payload.reasoning ?? null
  );
}

/** The three hard POST-REPARSE-STEPS invariants for one artwork. */
function assertHardInvariants(db, artworkId, label) {
  const orphanParties = db.prepare(`
    SELECT COUNT(*) AS n FROM provenance_parties p
    WHERE p.artwork_id = ? AND NOT EXISTS (
      SELECT 1 FROM provenance_events e
      WHERE e.artwork_id = p.artwork_id AND e.sequence = p.sequence)
  `).get(artworkId).n;
  assertEq(orphanParties, 0, `${label}: 0 orphan parties`);

  const dupSeq = db.prepare(`
    SELECT COUNT(*) AS n FROM (
      SELECT sequence FROM provenance_events WHERE artwork_id = ?
      GROUP BY sequence HAVING COUNT(*) > 1)
  `).get(artworkId).n;
  assertEq(dupSeq, 0, `${label}: 0 duplicate (artwork_id, sequence)`);

  const correctedNoReasoning = db.prepare(`
    SELECT COUNT(*) AS n FROM provenance_events
    WHERE artwork_id = ? AND correction_method IS NOT NULL
      AND (enrichment_reasoning IS NULL OR TRIM(enrichment_reasoning) = '')
  `).get(artworkId).n;
  assertEq(correctedNoReasoning, 0, `${label}: 0 corrected events without enrichment_reasoning`);
}

// ─── Temp CSV helper ──────────────────────────────────────────────────────────

function writeTmpCsv(content) {
  const p = path.join(os.tmpdir(), `prov-test-${process.pid}-${Date.now()}.csv`);
  fs.writeFileSync(p, content, "utf-8");
  return p;
}

function cleanTmp(p) {
  try { fs.unlinkSync(p); } catch (_) {}
}

function writeTmpJson(content) {
  const p = path.join(os.tmpdir(), `prov-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, content, "utf-8");
  return p;
}

// ═══════════════════════════════════════════════════════════════════════════════
// All tests run inside an async IIFE so we can write a single clean entry point.
// Cases 1–8 are synchronous by nature; case 9 + addendum D use tmpfiles.
// ═══════════════════════════════════════════════════════════════════════════════

(async function run() {
  // ── Case 1: Sequence-drift survival (event.type) ────────────────────────────
  section("Case 1: Sequence-drift survival (event.type)");
  {
    const db = makeDb();
    db.exec(`
      INSERT INTO artworks VALUES (1, 'SK-A-0001');
      INSERT INTO provenance_events VALUES
        (1,1,'Sold at auction 1900',0,'sale',0,0,'auction','${M.LLM_ENRICHMENT}',0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,'peg',NULL,'test reasoning');
      INSERT INTO provenance_events VALUES
        (1,2,'Gifted to museum 1910',0,'gift',0,0,NULL,NULL,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,'peg',NULL,NULL);
    `);

    migrate(db, { value: true });

    // Re-parse: new event inserted before the enriched one → seq 1→3
    db.exec(`
      DELETE FROM provenance_events;
      INSERT INTO provenance_events VALUES
        (1,1,'New preamble event',0,'unknown',0,0,NULL,NULL,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,'peg',NULL,NULL);
      INSERT INTO provenance_events VALUES
        (1,2,'Gifted to museum 1910',0,'gift',0,0,NULL,NULL,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,'peg',NULL,NULL);
      INSERT INTO provenance_events VALUES
        (1,3,'Sold at auction 1900',0,'sale',0,0,NULL,NULL,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,'peg',NULL,NULL);
    `);

    const result = reapply(db);

    assertEq(result.applied.event_type, 1, "case1: event_type applied=1");
    assertEq(result.unmatched.text_changed, 0, "case1: no text_changed");

    const hit = getEvent(db, 1, 3);
    assertEq(hit?.category_method, M.LLM_ENRICHMENT, "case1: enrichment lands on drifted seq=3");
    assertEq(hit?.transfer_category, "auction", "case1: transfer_category correct");

    const miss = getEvent(db, 1, 1);
    assertEq(miss?.category_method, null, "case1: preamble event NOT touched");
  }

  // ── Case 2: Collision tie-break (dup_ordinal) ──────────────────────────────
  section("Case 2: Collision tie-break (dup_ordinal)");
  {
    const db = makeDb();
    const dup = "Acquired at auction 1800";
    db.exec(`
      INSERT INTO artworks VALUES (2, 'SK-A-0002');
      INSERT INTO provenance_events VALUES
        (2,1,'${dup}',0,'sale',0,0,'auction_a','${M.LLM_ENRICHMENT}',0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,'peg',NULL,'reasoning A');
      INSERT INTO provenance_events VALUES
        (2,2,'${dup}',0,'sale',0,0,'auction_b','${M.LLM_ENRICHMENT}',0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,'peg',NULL,'reasoning B');
    `);

    migrate(db, { value: true });

    const rows = getStore(db, "event.type");
    assertEq(rows.length, 2, "case2: 2 store rows for 2 dup-text events");
    assertEq(rows[0].dup_ordinal, 0, "case2: first row dup_ordinal=0");
    assertEq(rows[1].dup_ordinal, 1, "case2: second row dup_ordinal=1");
    const pa = JSON.parse(rows[0].payload);
    const pb = JSON.parse(rows[1].payload);
    assert(pa.transfer_category !== pb.transfer_category, "case2: distinguishing column differs");

    // Reset and re-apply — both ordinals should land on correct seq
    db.exec("UPDATE provenance_events SET category_method=NULL, transfer_category=NULL;");
    const result = reapply(db);
    assertEq(result.applied.event_type, 2, "case2: both ordinals re-applied");
    assertEq(getEvent(db, 2, 1)?.transfer_category, "auction_a", "case2: seq=1 → auction_a");
    assertEq(getEvent(db, 2, 2)?.transfer_category, "auction_b", "case2: seq=2 → auction_b");
  }

  // ── Case 3: Unmatched text → skip, not mis-write ───────────────────────────
  section("Case 3: Unmatched text — skip, no mis-write");
  {
    const db = makeDb();
    db.exec(`
      INSERT INTO artworks VALUES (3, 'SK-A-0003');
      INSERT INTO provenance_events VALUES
        (3,1,'Original text for event',0,'sale',0,0,'sale','${M.LLM_ENRICHMENT}',0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,'peg',NULL,'r');
    `);

    migrate(db, { value: true });

    db.exec(`
      DELETE FROM provenance_events;
      INSERT INTO provenance_events VALUES
        (3,1,'Completely different text',0,'unknown',0,0,NULL,NULL,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,'peg',NULL,NULL);
    `);

    const result = reapply(db);
    assertEq(result.unmatched.text_changed, 1, "case3: text_changed=1");
    assertEq(getEvent(db, 3, 1)?.category_method, null, "case3: event NOT touched");
    assertEq(getEvent(db, 3, 1)?.transfer_type, "unknown", "case3: transfer_type unchanged");
  }

  // ── Case 4: dup-cardinality guard ─────────────────────────────────────────
  section("Case 4: dup-cardinality guard");
  {
    const db = makeDb();
    const dup = "Shared text event";
    db.exec(`
      INSERT INTO artworks VALUES (4, 'SK-A-0004');
      INSERT INTO provenance_events VALUES
        (4,1,'${dup}',0,'sale',0,0,'auction','${M.LLM_ENRICHMENT}',0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,'peg',NULL,'r');
      INSERT INTO provenance_events VALUES
        (4,2,'${dup}',0,'sale',0,0,'private_sale','${M.LLM_ENRICHMENT}',0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,'peg',NULL,'r');
    `);

    migrate(db, { value: true });
    assertEq(storeCount(db, "field='event.type'"), 2, "case4: 2 store rows (dup_count=2)");

    // Re-parse: group collapses to 1
    db.exec(`
      DELETE FROM provenance_events;
      INSERT INTO provenance_events VALUES
        (4,1,'${dup}',0,'sale',0,0,NULL,NULL,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,'peg',NULL,NULL);
    `);

    const result = reapply(db);
    assertEq(result.unmatched.dup_cardinality_changed, 2, "case4: both rows rejected (dup_cardinality_changed=2)");
    assertEq(result.applied.event_type, 0, "case4: 0 applied");
    assertEq(getEvent(db, 4, 1)?.category_method, null, "case4: event NOT written");

    // Mirror: group stays 2→2 → both re-apply
    const db2 = makeDb();
    db2.exec(`
      INSERT INTO artworks VALUES (4, 'SK-A-0004');
      INSERT INTO provenance_events VALUES
        (4,1,'${dup}',0,'sale',0,0,'auction','${M.LLM_ENRICHMENT}',0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,'peg',NULL,'r');
      INSERT INTO provenance_events VALUES
        (4,2,'${dup}',0,'sale',0,0,'private_sale','${M.LLM_ENRICHMENT}',0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,'peg',NULL,'r');
    `);
    migrate(db2, { value: true });
    db2.exec("UPDATE provenance_events SET category_method=NULL, transfer_category=NULL;");
    const result2 = reapply(db2);
    assertEq(result2.applied.event_type, 2, "case4-mirror: group 2→2 → both ordinals re-apply");
  }

  // ── Case 5: Idempotence ────────────────────────────────────────────────────
  section("Case 5: Idempotence");
  {
    const db = makeDb();
    db.exec(`
      INSERT INTO artworks VALUES (5, 'SK-A-0005');
      INSERT INTO provenance_events VALUES
        (5,1,'Event text alpha',0,'sale',0,0,'auction','${M.LLM_ENRICHMENT}',0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,'peg',NULL,'r');
    `);

    migrate(db, { value: true });
    const c1 = storeCount(db);
    migrate(db, { value: true });
    const c2 = storeCount(db);
    assertEq(c1, c2, "case5: migrate twice → same store count");

    reapply(db);
    const r1 = reapply(db);
    reapply(db);
    const r2 = reapply(db);
    assertDeepEq(r1, r2, "case5: reapply twice → identical reconcile object");
  }

  // ── Case 6: Party snapshot survives drift ──────────────────────────────────
  section("Case 6: Party snapshot survives drift");
  {
    const db = makeDb();
    db.exec(`
      INSERT INTO artworks VALUES (6, 'SK-A-0006');
      INSERT INTO provenance_events VALUES
        (6,1,'Preamble',0,'unknown',0,0,NULL,NULL,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,'peg',NULL,NULL);
      INSERT INTO provenance_events VALUES
        (6,2,'Auction Christie 1900',0,'sale',0,0,NULL,NULL,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,'peg',NULL,NULL);
      INSERT INTO provenance_parties VALUES
        (6,2,0,'Christie and Co',NULL,'seller','London','${M.LLM_ENRICHMENT}',0,'enriched');
      INSERT INTO provenance_parties VALUES
        (6,2,1,'Private Buyer',NULL,'buyer','Amsterdam','${M.LLM_DISAMBIGUATION}',0,'disambiguated');
    `);

    migrate(db, { value: true });

    // Re-parse: seq 2→3, baseline has only 1 party
    db.exec(`
      DELETE FROM provenance_events;
      DELETE FROM provenance_parties;
      INSERT INTO provenance_events VALUES
        (6,1,'Preamble',0,'unknown',0,0,NULL,NULL,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,'peg',NULL,NULL);
      INSERT INTO provenance_events VALUES
        (6,2,'New middle event',0,'unknown',0,0,NULL,NULL,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,'peg',NULL,NULL);
      INSERT INTO provenance_events VALUES
        (6,3,'Auction Christie 1900',0,'sale',0,0,NULL,NULL,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,'peg',NULL,NULL);
      INSERT INTO provenance_parties VALUES
        (6,3,0,'Only Baseline Party',NULL,'buyer',NULL,NULL,0,NULL);
    `);

    const result = reapply(db);
    assertEq(result.applied.parties, 1, "case6: party snapshot re-applied");
    assertEq(result.unmatched.text_changed, 0, "case6: no text_changed");

    const parties = getParties(db, 6, 3);
    assertEq(parties.length, 2, "case6: 2 parties restored from snapshot on seq=3");
    assertEq(parties[0].party_name, "Christie and Co", "case6: party 0 name correct");
    assertEq(parties[0].party_position, "London", "case6: party 0 position correct");
    assertEq(parties[1].party_name, "Private Buyer", "case6: party 1 name correct");
    assertEq(parties[1].position_method, M.LLM_DISAMBIGUATION, "case6: party 1 position_method preserved");
  }

  // ── Case 7: Snapshot delete — omitted party removed ────────────────────────
  section("Case 7: Snapshot delete — omitted party removed");
  {
    const db = makeDb();
    db.exec(`
      INSERT INTO artworks VALUES (7, 'SK-A-0007');
      INSERT INTO provenance_events VALUES
        (7,1,'Sale event text here',0,'sale',0,0,NULL,NULL,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,'peg',NULL,NULL);
      INSERT INTO provenance_parties VALUES
        (7,1,0,'Buyer Alpha',NULL,'buyer',NULL,'${M.LLM_ENRICHMENT}',0,NULL);
      INSERT INTO provenance_parties VALUES
        (7,1,1,'Extra Party',NULL,'unknown',NULL,'${M.LLM_ENRICHMENT}',0,NULL);
    `);

    // Snapshot captures 2 parties (the desired final state)
    migrate(db, { value: true });

    // Re-parse adds a spurious 3rd party
    db.exec(`
      INSERT INTO provenance_parties VALUES
        (7,1,2,'Spurious Party',NULL,'unknown',NULL,NULL,0,NULL);
    `);
    assertEq(getParties(db, 7, 1).length, 3, "case7 setup: 3 parties before re-apply");

    reapply(db);

    const parties = getParties(db, 7, 1);
    assertEq(parties.length, 2, "case7: spurious party removed after re-apply");
    assertEq(parties[0].party_name, "Buyer Alpha", "case7: party 0 preserved");
    assertEq(parties[1].party_name, "Extra Party", "case7: party 1 preserved");
  }

  // ── Case 8: JSON mirror (§H) rebuilt correctly ─────────────────────────────
  section("Case 8: JSON mirror (parties column) rebuilt");
  {
    const db = makeDb();
    const staleJson = JSON.stringify([
      { name: "STALE", dates: null, uncertain: false, role: null, position: null }
    ]);
    // Escape the JSON for SQLite string literal
    const staleEsc = staleJson.replace(/'/g, "''");
    db.exec(`
      INSERT INTO artworks VALUES (8, 'SK-A-0008');
      INSERT INTO provenance_events VALUES
        (8,1,'Mirror test event text',0,'sale',0,0,NULL,NULL,0,'${staleEsc}',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,'peg',NULL,NULL);
      INSERT INTO provenance_parties VALUES
        (8,1,0,'Correct Seller',NULL,'seller','Paris','${M.LLM_ENRICHMENT}',0,'enriched');
    `);

    migrate(db, { value: true });

    // Confirm stale JSON is there
    const before = getEvent(db, 8, 1);
    assertEq(JSON.parse(before.parties)[0].name, "STALE", "case8 setup: stale JSON present");

    // Reset stale JSON and re-apply
    db.prepare("UPDATE provenance_events SET parties = ? WHERE artwork_id = 8 AND sequence = 1")
      .run(staleJson);

    reapply(db);

    const after = getEvent(db, 8, 1);
    const mirror = JSON.parse(after.parties);
    assertEq(mirror.length, 1, "case8: JSON mirror has 1 entry");
    assertEq(mirror[0].name, "Correct Seller", "case8: stale value overwritten in JSON mirror");
    assertEq(mirror[0].position, "Paris", "case8: position in JSON mirror");
  }

  // ── Case 9: period.manual re-apply ────────────────────────────────────────
  section("Case 9: period.manual re-apply");
  {
    const db = makeDb();
    db.exec(`
      INSERT INTO artworks VALUES (91, 'SK-A-0091');
      INSERT INTO provenance_events VALUES
        (91,1,'Period event raw text',0,'sale',0,0,NULL,NULL,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,'peg',NULL,NULL);
      INSERT INTO provenance_periods VALUES
        (91,1,'Owner Name',NULL,NULL,NULL,NULL,1346,NULL,NULL,NULL,0,NULL,'[1]');
    `);

    const csvText = [
      "table,artwork_id,object_number,sequence,party_idx,field,old_value,new_value,reasoning",
      "provenance_periods,91,SK-A-0091,1,,begin_year,1346,,Lot number parsed as year",
    ].join("\n");
    const tmpPath = writeTmpCsv(csvText);
    try {
      migrate(db, { manual: true, csvPath: tmpPath });
      assertEq(getStore(db, "period.manual").length, 1, "case9: 1 period.manual store row");

      const result = reapply(db);
      assertEq(result.applied.period_manual, 1, "case9: period_manual applied=1");

      const period = db.prepare(
        "SELECT begin_year FROM provenance_periods WHERE artwork_id=91 AND sequence=1"
      ).get();
      assertEq(period?.begin_year, null, "case9: begin_year cleared to null");
    } finally {
      cleanTmp(tmpPath);
    }

    // Sub-case: no matching period → unmatched.period_not_found
    const db2 = makeDb();
    db2.exec(`
      INSERT INTO artworks VALUES (92, 'SK-A-0092');
      INSERT INTO provenance_events VALUES
        (92,1,'Another period event',0,'sale',0,0,NULL,NULL,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,'peg',NULL,NULL);
    `);
    const csvText2 = [
      "table,artwork_id,object_number,sequence,party_idx,field,old_value,new_value,reasoning",
      "provenance_periods,92,SK-A-0092,1,,begin_year,1346,,",
    ].join("\n");
    const tmpPath2 = writeTmpCsv(csvText2);
    try {
      migrate(db2, { manual: true, csvPath: tmpPath2 });
      const result2 = reapply(db2);
      assertEq(result2.unmatched.period_not_found, 1, "case9: period_not_found=1 when period missing");
      assertEq(
        result2.unmatched_object_numbers[0],
        "SK-A-0092",
        "case9: unmatched object_number reported"
      );
    } finally {
      cleanTmp(tmpPath2);
    }
  }

  // ── Addendum D1: Manual CSV — all tables, merge, DELETE→snapshot ───────────
  section("Addendum D1: Manual CSV — all tables + merge + DELETE→snapshot");
  {
    const db = makeDb();
    db.exec(`
      INSERT INTO artworks VALUES (101, 'SK-A-0101');
      INSERT INTO artworks VALUES (102, 'SK-A-0102');
      INSERT INTO artworks VALUES (103, 'SK-A-0103');
      INSERT INTO provenance_events VALUES
        (101,1,'Lot number event text',0,'sale',0,0,NULL,NULL,0,NULL,1346,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,'peg',NULL,NULL);
      INSERT INTO provenance_events VALUES
        (102,1,'Period event text here',0,'sale',0,0,NULL,NULL,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,'peg',NULL,NULL);
      INSERT INTO provenance_periods VALUES
        (102,1,'Owner',NULL,NULL,NULL,NULL,1346,NULL,NULL,NULL,0,NULL,'[1]');
      INSERT INTO provenance_events VALUES
        (103,2,'Party event raw text',0,'sale',0,0,NULL,NULL,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,'peg',NULL,NULL);
      INSERT INTO provenance_parties VALUES
        (103,2,0,'Party Alice',NULL,'buyer','London','${M.LLM_ENRICHMENT}',0,NULL);
    `);

    migrate(db, { manual: true, csvPath: FIXTURE_CSV });

    // Two CSV rows for artwork 101 seq 1 (provenance_events) → merged into ONE event.manual row
    const evtRows = getStore(db, "event.manual");
    assertEq(evtRows.length, 1, "D1: 1 event.manual row (two CSV rows merged)");
    const evtPayload = JSON.parse(evtRows[0].payload);
    assertEq(evtPayload.date_year, null, "D1: date_year=null (empty new_value)");
    assertEq(evtPayload.date_expression, null, "D1: date_expression=null (empty new_value)");

    // Artwork 102 seq 1 (provenance_periods) → 1 period.manual row
    const periodRows = getStore(db, "period.manual");
    assertEq(periodRows.length, 1, "D1: 1 period.manual row");
    const periodPayload = JSON.parse(periodRows[0].payload);
    assertEq(periodPayload.period_sequence, 1, "D1: period_sequence=1 in payload");
    assertEq(periodPayload.begin_year, null, "D1: begin_year=null");

    // Artwork 103 seq 2 (provenance_parties, field=DELETE) → event.parties snapshot
    const partyRows = getStore(db, "event.parties");
    assertEq(partyRows.length, 1, "D1: 1 event.parties snapshot (DELETE→snapshot, not SET DELETE)");
    const partyPayload = JSON.parse(partyRows[0].payload);
    assertEq(partyPayload.parties.length, 1, "D1: snapshot has 1 current party");
    assertEq(partyPayload.parties[0].party_name, "Party Alice", "D1: snapshot party name correct");
  }

  // ── Addendum D2: STOP condition — unknown table throws ────────────────────
  section("Addendum D2: STOP condition — unknown table value throws");
  {
    const db = makeDb();
    db.exec(`
      INSERT INTO artworks VALUES (200, 'SK-A-0200');
      INSERT INTO provenance_events VALUES
        (200,1,'Some event text',0,'sale',0,0,NULL,NULL,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,'peg',NULL,NULL);
    `);

    const badCsv = [
      "table,artwork_id,object_number,sequence,party_idx,field,old_value,new_value,reasoning",
      "bad_table,200,SK-A-0200,1,,some_col,old,new,reason",
    ].join("\n");
    const tmpPath = writeTmpCsv(badCsv);
    let threw = false;
    let throwMsg = "";
    try {
      migrate(db, { manual: true, csvPath: tmpPath });
    } catch (e) {
      threw = true;
      throwMsg = e.message;
    } finally {
      cleanTmp(tmpPath);
    }
    assert(threw, "D2: unknown table causes migrate to throw");
    assert(throwMsg.includes("bad_table"), `D2: error mentions bad_table — got: ${throwMsg}`);
  }

  // ── Addendum D3: STOP condition — unresolvable artwork_id throws ──────────
  section("Addendum D3: STOP condition — unresolvable artwork_id throws");
  {
    const db = makeDb();
    // No artworks seeded

    const csv = [
      "table,artwork_id,object_number,sequence,party_idx,field,old_value,new_value,reasoning",
      "provenance_events,9999,SK-A-9999,1,,transfer_type,unknown,sale,",
    ].join("\n");
    const tmpPath = writeTmpCsv(csv);
    let threw = false;
    let throwMsg = "";
    try {
      migrate(db, { manual: true, csvPath: tmpPath });
    } catch (e) {
      threw = true;
      throwMsg = e.message;
    } finally {
      cleanTmp(tmpPath);
    }
    assert(threw, "D3: unresolvable artwork_id causes migrate to throw");
    assert(throwMsg.includes("9999"), `D3: error mentions object_number 9999 — got: ${throwMsg}`);
  }

  // ── Addendum E1: overlap event (LLM party + CSV DELETE) deduped via shared seenPK ──
  section("Addendum E1: value+manual overlap on one event → single snapshot, no PK throw");
  {
    const db = makeDb();
    db.exec(`
      INSERT INTO artworks VALUES (300, 'SK-A-0300');
      INSERT INTO provenance_events VALUES
        (300,1,'Overlap event raw text',0,'sale',0,0,NULL,NULL,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,'peg',NULL,NULL);
      INSERT INTO provenance_parties VALUES
        (300,1,0,'Real Buyer',NULL,'buyer','London','${M.LLM_ENRICHMENT}',0,'enriched');
    `);
    // CSV: a provenance_parties DELETE row targeting the SAME (artwork,seq) → manual snapshot
    const csv = [
      "table,artwork_id,object_number,sequence,party_idx,field,old_value,new_value,reasoning",
      "provenance_parties,300,SK-A-0300,1,*,DELETE,,,Charter-room cleanup",
    ].join("\n");
    const tmp = writeTmpCsv(csv);
    let threw = false;
    try {
      migrate(db, { value: true, manual: true, csvPath: tmp });
    } catch (e) {
      threw = true;
    } finally {
      cleanTmp(tmp);
    }
    assert(!threw, "E1: value+manual on the same event does NOT throw (shared seenPK dedupes)");
    const snaps = getStore(db, "event.parties");
    assertEq(snaps.length, 1, "E1: exactly one event.parties row (deduped, not double-inserted)");
  }

  // ── Addendum E2: period.manual dry-run is accurate (reads, no writes) ──
  section("Addendum E2: period.manual dry-run surfaces period_not_found and writes nothing");
  {
    // B1: missing period → dry-run must report period_not_found (was hidden before)
    const db = makeDb();
    db.exec(`
      INSERT INTO artworks VALUES (301, 'SK-A-0301');
      INSERT INTO provenance_events VALUES
        (301,1,'Periodless event text',0,'sale',0,0,NULL,NULL,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,'peg',NULL,NULL);
    `);
    const csv = [
      "table,artwork_id,object_number,sequence,party_idx,field,old_value,new_value,reasoning",
      "provenance_periods,301,SK-A-0301,1,,begin_year,1346,,",
    ].join("\n");
    const tmp = writeTmpCsv(csv);
    try {
      migrate(db, { manual: true, csvPath: tmp });
      const dry = reapply(db, { dryRun: true });
      assertEq(dry.unmatched.period_not_found, 1, "E2: dry-run reports period_not_found=1");
      assertEq(dry.applied.period_manual, 0, "E2: dry-run applied.period_manual=0 when period missing");
    } finally {
      cleanTmp(tmp);
    }

    // B2: present period → dry-run counts applied but does NOT mutate the row
    const db2 = makeDb();
    db2.exec(`
      INSERT INTO artworks VALUES (302, 'SK-A-0302');
      INSERT INTO provenance_events VALUES
        (302,1,'Period present event',0,'sale',0,0,NULL,NULL,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,'peg',NULL,NULL);
      INSERT INTO provenance_periods VALUES
        (302,1,'Owner',NULL,NULL,NULL,NULL,1346,NULL,NULL,NULL,0,NULL,'[1]');
    `);
    const csv2 = [
      "table,artwork_id,object_number,sequence,party_idx,field,old_value,new_value,reasoning",
      "provenance_periods,302,SK-A-0302,1,,begin_year,1346,,",
    ].join("\n");
    const tmp2 = writeTmpCsv(csv2);
    try {
      migrate(db2, { manual: true, csvPath: tmp2 });
      const dry = reapply(db2, { dryRun: true });
      assertEq(dry.applied.period_manual, 1, "E2: dry-run counts applied.period_manual=1 when period present");
      const row = db2.prepare("SELECT begin_year FROM provenance_periods WHERE artwork_id=302 AND sequence=1").get();
      assertEq(row.begin_year, 1346, "E2: dry-run did NOT write (begin_year still 1346)");
    } finally {
      cleanTmp(tmp2);
    }
  }

  // ── Case 10: Split survives renumber (structural) ──────────────────────────
  section("Case 10: Split survives renumber (structural)");
  {
    const db = makeDb();
    const parentText = "Sold at auction 1900 then bequeathed 1910";
    // Migrate-time state: parent split target sits at sequence 2.
    db.exec(`
      INSERT INTO artworks VALUES (10, 'SK-A-0010');
      INSERT INTO provenance_events VALUES
        (10,1,'Preamble event text',0,'unknown',0,0,NULL,NULL,0,'[]',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,'peg',NULL,NULL);
      INSERT INTO provenance_events VALUES
        (10,2,'${parentText}',0,'sale',0,0,NULL,NULL,0,'[]',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,'peg',NULL,NULL);
      INSERT INTO provenance_periods VALUES
        (10,1,'Owner',NULL,NULL,NULL,NULL,1900,NULL,NULL,NULL,0,NULL,'[2]');
    `);

    // Synthetic split payload (splits[] entry shape applySplits consumes).
    const splitPayload = {
      original_sequence: 2, // audit value — re-apply overrides with the located seq
      issue_type: "multi_transfer",
      confidence: 0.95,
      reasoning: "Two distinct transfers in one segment",
      replacement_events: [
        {
          raw_text_segment: "Sold at auction 1900",
          transfer_type: "sale",
          transfer_category: "auction",
          date_year: 1900,
          date_qualifier: null,
          location: "London",
          gap: false,
          parties: [{ name: "Auction House", role: "seller", position: "London" }],
        },
        {
          raw_text_segment: "bequeathed 1910",
          transfer_type: "bequest",
          transfer_category: "inheritance",
          date_year: 1910,
          date_qualifier: null,
          location: null,
          gap: false,
          parties: [{ name: "Heir Family", role: "buyer", position: "Amsterdam" }],
        },
      ],
    };
    insertStructuralRow(db, {
      objectNumber: "SK-A-0010",
      parentRawText: parentText,
      field: "event.split",
      payload: splitPayload,
      method: `${M.LLM_STRUCTURAL_PREFIX}#125`,
    });

    // Simulate re-parse: a new event inserted before the parent → parent 2→3.
    // A fresh re-parse re-derives periods, so the period's source_events now
    // references the parent's CURRENT sequence (3), not the stale 2.
    db.exec(`
      DELETE FROM provenance_events;
      DELETE FROM provenance_parties;
      DELETE FROM provenance_periods;
      INSERT INTO provenance_events VALUES
        (10,1,'Preamble event text',0,'unknown',0,0,NULL,NULL,0,'[]',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,'peg',NULL,NULL);
      INSERT INTO provenance_events VALUES
        (10,2,'New middle event',0,'unknown',0,0,NULL,NULL,0,'[]',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,'peg',NULL,NULL);
      INSERT INTO provenance_events VALUES
        (10,3,'${parentText}',0,'sale',0,0,NULL,NULL,0,'[]',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,'peg',NULL,NULL);
      INSERT INTO provenance_periods VALUES
        (10,1,'Owner',NULL,NULL,NULL,NULL,1900,NULL,NULL,NULL,0,NULL,'[3]');
    `);

    const result = reapply(db);
    assertEq(result.applied.event_split, 1, "case10: 1 split applied");
    assertEq(result.unmatched.structural_text_changed, 0, "case10: no structural_text_changed");

    // Whole artwork was rebuilt: 1 preamble + 1 middle + 2 children = 4 events.
    const events = getAllEvents(db, 10);
    assertEq(events.length, 4, "case10: 4 events after split (2 kept + 2 children)");

    // Sequences contiguous 0..3
    const seqs = events.map((e) => e.sequence);
    assertDeepEq(seqs, [0, 1, 2, 3], "case10: sequences contiguous 0..3");

    // The two children carry the right transfer_type
    const child0 = events.find((e) => e.raw_text === "Sold at auction 1900");
    const child1 = events.find((e) => e.raw_text === "bequeathed 1910");
    assert(child0 != null, "case10: child 0 present");
    assert(child1 != null, "case10: child 1 present");
    assertEq(child0.transfer_type, "sale", "case10: child 0 transfer_type=sale");
    assertEq(child1.transfer_type, "bequest", "case10: child 1 transfer_type=bequest");

    // Children parties
    const p0 = getParties(db, 10, child0.sequence);
    const p1 = getParties(db, 10, child1.sequence);
    assertEq(p0.length, 1, "case10: child 0 has 1 party");
    assertEq(p0[0].party_name, "Auction House", "case10: child 0 party name");
    assertEq(p1.length, 1, "case10: child 1 has 1 party");
    assertEq(p1[0].party_name, "Heir Family", "case10: child 1 party name");

    // period source_events remapped: old [2] (the parent) → children's new seqs.
    const period = db.prepare("SELECT source_events FROM provenance_periods WHERE artwork_id=10 AND sequence=1").get();
    const srcEvents = JSON.parse(period.source_events);
    assertDeepEq(srcEvents, [child0.sequence, child1.sequence], "case10: period source_events remapped to child seqs");

    // The three hard POST-REPARSE-STEPS invariants
    assertHardInvariants(db, 10, "case10");
  }

  // ── Case 11: Split parent text changed → unmatched, no change ──────────────
  section("Case 11: Split parent text changed → unmatched");
  {
    const db = makeDb();
    const parentText = "Original parent segment text 1850";
    db.exec(`
      INSERT INTO artworks VALUES (11, 'SK-A-0011');
      INSERT INTO provenance_events VALUES
        (11,1,'${parentText}',0,'sale',0,0,NULL,NULL,0,'[]',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,'peg',NULL,NULL);
    `);

    insertStructuralRow(db, {
      objectNumber: "SK-A-0011",
      parentRawText: parentText,
      field: "event.split",
      payload: {
        original_sequence: 1,
        issue_type: "multi_transfer",
        reasoning: "should not apply — text changed",
        replacement_events: [
          { raw_text_segment: "frag A", transfer_type: "sale", transfer_category: null, parties: [] },
          { raw_text_segment: "frag B", transfer_type: "gift", transfer_category: null, parties: [] },
        ],
      },
      method: `${M.LLM_STRUCTURAL_PREFIX}#125`,
    });

    // Re-parse changed the parent's text → its hash no longer matches.
    db.exec(`
      DELETE FROM provenance_events;
      INSERT INTO provenance_events VALUES
        (11,1,'Completely re-segmented different text',0,'sale',0,0,NULL,NULL,0,'[]',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,'peg',NULL,NULL);
    `);

    const before = getAllEvents(db, 11);
    const result = reapply(db);

    assertEq(result.applied.event_split, 0, "case11: 0 splits applied");
    assertEq(result.unmatched.structural_text_changed, 1, "case11: structural_text_changed=1");
    assert(
      result.unmatched_object_numbers.includes("SK-A-0011"),
      "case11: SK-A-0011 reported unmatched"
    );

    // The single event is byte-unchanged (no split, no renumber).
    const after = getAllEvents(db, 11);
    assertEq(after.length, 1, "case11: still exactly 1 event (no children created)");
    assertEq(after[0].raw_text, before[0].raw_text, "case11: event raw_text unchanged");
    assertEq(after[0].correction_method, null, "case11: no correction_method stamped");
  }

  // ── Case 12: Malformed double-encoded reclassification string ──────────────
  // Regression for the 2026-06-14 real-data finding: 3 of 200 reclassification
  // values are double-encoded STRINGS that are a valid leading JSON array followed
  // by literal trailing garbage — `<parameter name="no_reclassification_needed">…`
  // markup (BK-NM-1214, BK-NM-12006-8) or a bare trailing comma (NG-1990-1-2). A
  // bare JSON.parse throws on all three and — because migrate() runs in one
  // transaction — rolls back the WHOLE migration. The balanced-array-prefix
  // recovery (Finding B) must RECOVER these real shapes; a genuinely-unrecoverable
  // string lands in structural_unparseable WITHOUT throwing.
  section("Case 12: Malformed double-encoded reclassification string");
  {
    const db = makeDb();
    const reclassPath = writeTmpJson(JSON.stringify({
      meta: { batchId: "audit:case12" },
      results: [
        {
          // Real shape #1: array + `<parameter …>` markup (BK-NM-1214 shape).
          data: {
            object_number: "SK-A-9001",
            reclassifications:
              '[{"event_sequence":2,"issue_type":"phantom_event","action":"mark_non_provenance","reasoning":"x","confidence":0.9}],\n<parameter name="no_reclassification_needed">[]',
          },
        },
        {
          // Real shape #2: array + trailing comma only (NG-1990-1-2 shape).
          data: {
            object_number: "SK-A-9002",
            reclassifications:
              '[{"event_sequence":2,"issue_type":"phantom_event","action":"mark_non_provenance","reasoning":"y","confidence":0.9}],\n',
          },
        },
        {
          // Deliberately UNrecoverable: no JSON array at all.
          data: {
            object_number: "SK-A-9004",
            reclassifications: "totally not json",
          },
        },
        {
          // Normal shape: a real array (sanity — must still emit a row).
          data: {
            object_number: "SK-A-9003",
            reclassifications: [
              { event_sequence: 2, issue_type: "phantom_event", action: "mark_non_provenance", reasoning: "z", confidence: 0.9 },
            ],
          },
        },
      ],
    }), "utf-8");

    // Synthetic oracle resolving each object's sequence-2 parent event.
    const byObjSeq = new Map();
    const groupsByObj = new Map();
    for (const obj of ["SK-A-9001", "SK-A-9002", "SK-A-9003", "SK-A-9004"]) {
      const rawText = `Parent event text for ${obj} seq 2`;
      byObjSeq.set(`${obj}|2`, rawText);
      groupsByObj.set(obj, buildDupOrdinals([{ sequence: 2, raw_text: rawText }]));
    }
    const oracle = { byObjSeq, groupsByObj };

    let threw = false;
    let counts;
    try {
      counts = runStructuralExtractor(db, {
        dryRun: false,
        seenPK: new Set(),
        auditFiles: {
          split: "/nonexistent/split.json",
          reclassify: reclassPath,
          fieldcorrection: "/nonexistent/fieldcorrection.json",
        },
        oracle,
      });
    } catch (e) {
      threw = true;
      failures.push(`case12: runStructuralExtractor threw: ${e.message}`);
    } finally {
      cleanTmp(reclassPath);
    }

    assert(!threw, "case12: runStructuralExtractor does NOT throw on malformed strings");
    if (counts) {
      // 4 results: 2 recoverable-malformed + 1 normal array all RECOVER (3 rows),
      // 1 genuinely-unrecoverable counts as structural_unparseable.
      assertEq(
        counts.event_reclassify + counts.structural_unparseable,
        4,
        "case12: all 4 results accounted for (recovered or counted, never silently lost)"
      );
      assertEq(
        counts.event_reclassify,
        3,
        "case12: both real markup/comma shapes recovered + the normal array (3 rows)"
      );
      assertEq(
        counts.structural_unparseable,
        1,
        "case12: exactly the unrecoverable 'totally not json' string counted unparseable"
      );
      // Each recoverable object got exactly one event.reclassify store row.
      for (const obj of ["SK-A-9001", "SK-A-9002", "SK-A-9003"]) {
        const n = db.prepare(
          "SELECT COUNT(*) AS n FROM provenance_enrichments WHERE object_number = ? AND field = 'event.reclassify'"
        ).get(obj).n;
        assertEq(n, 1, `case12: ${obj} recovered → exactly 1 store row`);
      }
      // The unrecoverable object produced NO store row.
      const badRow = db.prepare(
        "SELECT COUNT(*) AS n FROM provenance_enrichments WHERE object_number = ? AND field = 'event.reclassify'"
      ).get("SK-A-9004").n;
      assertEq(badRow, 0, "case12: unrecoverable result emitted no store row");
    }
  }

  // ── Case 13: Multiple field-corrections on one event don't collide ─────────
  // Regression for the 2026-06-14 PK-collision finding (Finding A): an event with
  // TWO field-corrections (a location fix AND a missing_receiver party insert)
  // resolves both to the SAME parent → the SAME store PK. The extractor must GROUP
  // them into ONE event.fieldcorrection row with a 2-element corrections payload
  // (no seenPK throw); re-apply must iterate and apply BOTH.
  section("Case 13: Multiple field-corrections on one event don't collide");
  {
    const db = makeDb();
    const parentText = "by whom bequeathed to the City in 1880 at the Old Hall";
    // Seed the event with an existing party (so maxPartyIdx works) and the
    // location current_value the location-correction guards on.
    db.exec(`
      INSERT INTO artworks VALUES (13, 'RP-T-1980-52');
      INSERT INTO provenance_events VALUES
        (13,3,'${parentText}',0,'bequest',0,0,NULL,NULL,0,
         '[{"name":"Original Owner","role":"seller","position":"Amsterdam"}]',
         NULL,NULL,NULL,'Old Hal',NULL,NULL,NULL,NULL,0,NULL,'peg',NULL,NULL);
      INSERT INTO provenance_parties VALUES
        (13,3,0,'Original Owner',NULL,'seller','Amsterdam','peg',0,NULL);
    `);

    // Synthetic field-correction audit: ONE result, TWO corrections on event 3.
    const fieldPath = writeTmpJson(JSON.stringify({
      meta: { batchId: "audit:case13" },
      results: [
        {
          data: {
            object_number: "RP-T-1980-52",
            corrections: [
              {
                event_sequence: 3,
                issue_type: "truncated_location",
                field: "location",
                current_value: "Old Hal",
                corrected_value: "Old Hall",
                reasoning: "location truncated",
                confidence: 0.95,
              },
              {
                event_sequence: 3,
                issue_type: "missing_receiver",
                field: "parties",
                new_party: { name: "City of Amsterdam", role: "buyer", position: "Amsterdam" },
                reasoning: "receiver omitted by parser",
                confidence: 0.92,
              },
            ],
          },
        },
      ],
    }), "utf-8");

    // Oracle resolves event 3's parent to the seeded raw_text.
    const byObjSeq = new Map([["RP-T-1980-52|3", parentText]]);
    const groupsByObj = new Map([
      ["RP-T-1980-52", buildDupOrdinals([{ sequence: 3, raw_text: parentText }])],
    ]);
    const oracle = { byObjSeq, groupsByObj };

    let threw = false;
    let counts;
    try {
      counts = runStructuralExtractor(db, {
        dryRun: false,
        seenPK: new Set(),
        auditFiles: {
          split: "/nonexistent/split.json",
          reclassify: "/nonexistent/reclassify.json",
          fieldcorrection: fieldPath,
        },
        oracle,
      });
    } catch (e) {
      threw = true;
      failures.push(`case13: runStructuralExtractor threw: ${e.message}`);
    } finally {
      cleanTmp(fieldPath);
    }

    assert(!threw, "case13: runStructuralExtractor does NOT throw (no seenPK collision)");

    // Exactly ONE event.fieldcorrection store row, with a 2-element payload.
    const fcRows = db.prepare(
      "SELECT * FROM provenance_enrichments WHERE object_number = ? AND field = 'event.fieldcorrection'"
    ).all("RP-T-1980-52");
    assertEq(fcRows.length, 1, "case13: exactly ONE event.fieldcorrection store row");
    if (counts) assertEq(counts.event_fieldcorrection, 1, "case13: extractor counts 1 fieldcorrection row");
    if (fcRows.length === 1) {
      const payload = JSON.parse(fcRows[0].payload);
      assertEq(payload.corrections.length, 2, "case13: payload.corrections has length 2");
    }

    // Re-apply (event still at seq 3, content-matched).
    const result = reapply(db);
    assert(result.applied.event_fieldcorrection >= 2, "case13: both corrections applied (count ≥ 2)");

    // Effect 1: location column updated to corrected value.
    const evt = getEvent(db, 13, 3);
    assertEq(evt.location, "Old Hall", "case13: location updated to corrected value");

    // Effect 2: new party present in provenance_parties.
    const parties = getParties(db, 13, 3);
    const newParty = parties.find((p) => p.party_name === "City of Amsterdam");
    assert(newParty != null, "case13: new missing_receiver party inserted into provenance_parties");
    assertEq(newParty?.party_position, "Amsterdam", "case13: new party position set");

    // Effect 3: new party present in the event's parties JSON mirror (§H).
    let jsonParties;
    try { jsonParties = JSON.parse(evt.parties || "[]"); } catch { jsonParties = []; }
    const jsonNew = jsonParties.find((p) => p.name === "City of Amsterdam");
    assert(jsonNew != null, "case13: new party mirrored into event.parties JSON");
  }

  // ── Case 14: Structural confidence/length filter ──────────────────────────
  // Regression for the 2026-06-14 Phase-3.2 dress-rehearsal finding: the migrate
  // extractor MUST mirror the writebacks' gate (writeback-event-splitting:
  // confidence >= 0.7 AND replacement_events.length >= 2; -reclassification and
  // -field-corrections: confidence >= 0.7). Without it the store over-captures
  // sub-threshold / degenerate audit ops the deployed data never applied, and the
  // cutover silently changes the data. See
  // plans/provenance-enrichment-structural-confidence-leak.md.
  section("Case 14: structural confidence/length filter mirrors the writebacks");
  {
    const db = makeDb();
    const re2 = [
      { raw_text_segment: "frag A", transfer_type: "sale", transfer_category: null, parties: [] },
      { raw_text_segment: "frag B", transfer_type: "gift", transfer_category: null, parties: [] },
    ];
    const splitPath = writeTmpJson(JSON.stringify({
      meta: { batchId: "audit:case14-split" },
      results: [{ data: { object_number: "SK-A-9101", splits: [
        { original_sequence: 1, issue_type: "multi_transfer", confidence: 0.9, reasoning: "keep", replacement_events: re2 },
        { original_sequence: 2, issue_type: "multi_transfer", confidence: 0.5, reasoning: "skip: low conf", replacement_events: re2 },
        { original_sequence: 3, issue_type: "bequest_chain", confidence: 0.95, reasoning: "skip: degenerate", replacement_events: [re2[0]] },
      ] } }],
    }), "utf-8");
    const reclassPath = writeTmpJson(JSON.stringify({
      meta: { batchId: "audit:case14-reclass" },
      results: [{ data: { object_number: "SK-A-9102", reclassifications: [
        { event_sequence: 1, issue_type: "phantom_event", action: "mark_non_provenance", confidence: 0.9, reasoning: "keep" },
        { event_sequence: 2, issue_type: "phantom_event", action: "mark_non_provenance", confidence: 0.5, reasoning: "skip: low conf" },
        { event_sequence: 3, issue_type: "phantom_event", action: "mark_non_provenance", reasoning: "skip: undefined conf" },
      ] } }],
    }), "utf-8");
    const fieldPath = writeTmpJson(JSON.stringify({
      meta: { batchId: "audit:case14-field" },
      results: [
        { data: { object_number: "SK-A-9103", corrections: [
          { event_sequence: 1, field: "location", current_value: "X", corrected_value: "Y", confidence: 0.9, issue_type: "truncated_location", reasoning: "keep" },
          { event_sequence: 1, field: "location", current_value: "Y", corrected_value: "Z", confidence: 0.4, issue_type: "wrong_location", reasoning: "skip: low conf" },
        ] } },
        { data: { object_number: "SK-A-9104", corrections: [
          { event_sequence: 1, field: "location", current_value: "P", corrected_value: "Q", confidence: 0.5, issue_type: "truncated_location", reasoning: "skip: low conf" },
        ] } },
      ],
    }), "utf-8");

    const byObjSeq = new Map();
    const groupsByObj = new Map();
    for (const [obj, seq] of [["SK-A-9101", 1], ["SK-A-9102", 1], ["SK-A-9103", 1]]) {
      const rawText = `Parent event text for ${obj} seq ${seq}`;
      byObjSeq.set(`${obj}|${seq}`, rawText);
      groupsByObj.set(obj, buildDupOrdinals([{ sequence: seq, raw_text: rawText }]));
    }
    const oracle = { byObjSeq, groupsByObj };

    let counts, threw = false;
    try {
      counts = runStructuralExtractor(db, {
        dryRun: false, seenPK: new Set(),
        auditFiles: { split: splitPath, reclassify: reclassPath, fieldcorrection: fieldPath },
        oracle,
      });
    } catch (e) {
      threw = true; failures.push(`case14: runStructuralExtractor threw: ${e.message}`);
    } finally {
      cleanTmp(splitPath); cleanTmp(reclassPath); cleanTmp(fieldPath);
    }
    assert(!threw, "case14: runStructuralExtractor does NOT throw");
    if (counts) {
      assertEq(counts.event_split, 1, "case14: only the >=0.7 + >=2-replacement split captured (low-conf + degenerate skipped)");
      assertEq(counts.event_reclassify, 1, "case14: only the >=0.7 reclassification captured (low-conf + undefined skipped)");
      assertEq(counts.event_fieldcorrection, 1, "case14: only the event with a >=0.7 correction captured (all-low-conf event skipped)");
      const fcRow = db.prepare("SELECT payload FROM provenance_enrichments WHERE object_number='SK-A-9103' AND field='event.fieldcorrection'").get();
      assert(fcRow != null, "case14: SK-A-9103 fieldcorrection row present");
      if (fcRow) assertEq(JSON.parse(fcRow.payload).corrections.length, 1, "case14: sub-threshold sibling correction filtered from payload");
      const n9104 = db.prepare("SELECT COUNT(*) AS n FROM provenance_enrichments WHERE object_number='SK-A-9104'").get().n;
      assertEq(n9104, 0, "case14: SK-A-9104 (all sub-threshold) produced no store row");
    }
  }

  // ─── Summary ───────────────────────────────────────────────────────────────
  process.stdout.write(`\n${"═".repeat(60)}\n`);
  process.stdout.write(`  Results: ${passed} passed, ${failed} failed\n`);
  if (failures.length > 0) {
    process.stdout.write(`\nFailed cases:\n`);
    for (const f of failures) process.stdout.write(`  ✗ ${f}\n`);
    process.stdout.write(`\n${failed} failed\n`);
    process.exit(1);
  } else {
    process.stdout.write(`\n0 failed\n`);
  }
})().catch((e) => {
  console.error("Unexpected error:", e);
  process.exit(2);
});
