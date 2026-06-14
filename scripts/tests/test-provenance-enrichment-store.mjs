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
} from "../migrate-enrichments-to-store.mjs";
import { reapply } from "../reapply-enrichments-from-store.mjs";
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

// ─── Temp CSV helper ──────────────────────────────────────────────────────────

function writeTmpCsv(content) {
  const p = path.join(os.tmpdir(), `prov-test-${process.pid}-${Date.now()}.csv`);
  fs.writeFileSync(p, content, "utf-8");
  return p;
}

function cleanTmp(p) {
  try { fs.unlinkSync(p); } catch (_) {}
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
      "table,artwork_id,sequence,party_idx,field,old_value,new_value,reasoning",
      "provenance_periods,91,1,,begin_year,1346,,Lot number parsed as year",
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
      "table,artwork_id,sequence,party_idx,field,old_value,new_value,reasoning",
      "provenance_periods,92,1,,begin_year,1346,,",
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
      "table,artwork_id,sequence,party_idx,field,old_value,new_value,reasoning",
      "bad_table,200,1,,some_col,old,new,reason",
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
      "table,artwork_id,sequence,party_idx,field,old_value,new_value,reasoning",
      "provenance_events,9999,1,,transfer_type,unknown,sale,",
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
    assert(throwMsg.includes("9999"), `D3: error mentions artwork_id 9999 — got: ${throwMsg}`);
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
      "table,artwork_id,sequence,party_idx,field,old_value,new_value,reasoning",
      "provenance_parties,300,1,*,DELETE,,,Charter-room cleanup",
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
      "table,artwork_id,sequence,party_idx,field,old_value,new_value,reasoning",
      "provenance_periods,301,1,,begin_year,1346,,",
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
      "table,artwork_id,sequence,party_idx,field,old_value,new_value,reasoning",
      "provenance_periods,302,1,,begin_year,1346,,",
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
