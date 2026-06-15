/**
 * test-provenance-change-report.mjs
 *
 * Fixture-based unit tests for provenance-change-report.mjs's pure diff function.
 * Uses in-memory better-sqlite3 — no real data/vocabulary.db required.
 *
 * Run: node scripts/tests/test-provenance-change-report.mjs
 */

import Database from "better-sqlite3";
import { computeDiff } from "../provenance-change-report.mjs";

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

function section(name) {
  process.stdout.write(`\n${"═".repeat(60)}\n  ${name}\n${"═".repeat(60)}\n`);
}

// ─── Fixture DB builder ───────────────────────────────────────────────────────

/**
 * Build a tiny in-memory DB with a provenance_enrichments table
 * so computeDiff can cross-reference it.
 */
function makeDb(enrichedObjectNumbers = []) {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE provenance_enrichments (
      id INTEGER PRIMARY KEY,
      object_number TEXT NOT NULL
    );
  `);
  const insert = db.prepare("INSERT INTO provenance_enrichments (object_number) VALUES (?)");
  for (const objNum of enrichedObjectNumbers) insert.run(objNum);
  return db;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

section("Basic partition — unchanged / modified / added / removed");
{
  const db = makeDb();

  const currentMap = new Map([
    ["SK-A-0001", "hash_aaa"], // unchanged
    ["SK-A-0002", "hash_bbb"], // modified (hash changed)
    ["SK-A-0003", "hash_ccc"], // new (not in baseline)
  ]);

  const baselineMap = new Map([
    ["SK-A-0001", "hash_aaa"], // unchanged
    ["SK-A-0002", "hash_old"], // modified
    ["SK-A-0004", "hash_ddd"], // removed (not in current)
  ]);

  const { unchanged, modified, added, removed, withEnrichment } = computeDiff({
    db,
    currentMap,
    baselineMap,
  });

  assertEq(unchanged.length, 1, "unchanged: 1 artwork");
  assert(unchanged.includes("SK-A-0001"), "unchanged contains SK-A-0001");

  assertEq(modified.length, 1, "modified: 1 artwork");
  assert(modified.includes("SK-A-0002"), "modified contains SK-A-0002");

  assertEq(added.length, 1, "added: 1 artwork");
  assert(added.includes("SK-A-0003"), "added contains SK-A-0003");

  assertEq(removed.length, 1, "removed: 1 artwork");
  assert(removed.includes("SK-A-0004"), "removed contains SK-A-0004");

  assertEq(withEnrichment.size, 0, "withEnrichment empty (no store rows)");
}

section("Store cross-reference — modified with enrichment vs without");
{
  // SK-A-0002 is modified AND has a store entry → re-enrichment candidate
  // SK-A-0003 is modified but has NO store entry → not a candidate
  const db = makeDb(["SK-A-0002"]);

  const currentMap = new Map([
    ["SK-A-0002", "hash_new_b"],
    ["SK-A-0003", "hash_new_c"],
  ]);

  const baselineMap = new Map([
    ["SK-A-0002", "hash_old_b"],
    ["SK-A-0003", "hash_old_c"],
  ]);

  const { modified, withEnrichment, modifiedWithEnrichment } = computeDiff({ db, currentMap, baselineMap });

  assertEq(modified.length, 2, "2 modified artworks");
  assert(withEnrichment.has("SK-A-0002"), "SK-A-0002 flagged as has-enrichment");
  assert(!withEnrichment.has("SK-A-0003"), "SK-A-0003 NOT flagged (no store row)");
  assertEq(modifiedWithEnrichment, 1, "1 modified artwork is a re-enrichment candidate");
}

section("Added artwork with enrichment — flagged as candidate");
{
  const db = makeDb(["SK-A-0010"]);

  const currentMap = new Map([["SK-A-0010", "hash_10"]]);
  const baselineMap = new Map(); // Not in baseline → "added"

  const { added, withEnrichment, addedWithEnrichment } = computeDiff({ db, currentMap, baselineMap });

  assertEq(added.length, 1, "1 added artwork");
  assert(withEnrichment.has("SK-A-0010"), "added artwork flagged as has-enrichment");
  assertEq(addedWithEnrichment, 1, "1 added artwork is a re-enrichment candidate");
}

section("Removed artwork — no impact on current, enrichment flag still works");
{
  const db = makeDb(["SK-A-0099"]);

  const currentMap = new Map(); // Removed from harvest
  const baselineMap = new Map([["SK-A-0099", "hash_99"]]);

  const { unchanged, modified, added, removed, withEnrichment, removedWithEnrichment } = computeDiff({
    db,
    currentMap,
    baselineMap,
  });

  assertEq(removed.length, 1, "1 removed artwork");
  assert(removed.includes("SK-A-0099"), "removed contains SK-A-0099");
  assert(withEnrichment.has("SK-A-0099"), "removed artwork has enrichment flagged");
  assertEq(removedWithEnrichment, 1, "1 removed artwork is a re-enrichment candidate");
  assertEq(unchanged.length, 0, "0 unchanged");
  assertEq(modified.length, 0, "0 modified");
  assertEq(added.length, 0, "0 added");
}

section("All unchanged — zero in all change sets");
{
  const db = makeDb();

  const currentMap = new Map([
    ["SK-A-1000", "hash_1000"],
    ["SK-A-1001", "hash_1001"],
  ]);

  const baselineMap = new Map([
    ["SK-A-1000", "hash_1000"],
    ["SK-A-1001", "hash_1001"],
  ]);

  const { unchanged, modified, added, removed } = computeDiff({ db, currentMap, baselineMap });

  assertEq(unchanged.length, 2, "2 unchanged artworks");
  assertEq(modified.length, 0, "0 modified");
  assertEq(added.length, 0, "0 added");
  assertEq(removed.length, 0, "0 removed");
}

section("Baseline-absent fallback — empty baseline produces all-added");
{
  // The no-baseline-table case is handled by the CLI (isMain guard), not computeDiff.
  // computeDiff gets an empty baselineMap when no state exists, so all current artworks
  // appear as "added". Verify that invariant.
  const db = makeDb();

  const currentMap = new Map([
    ["SK-C-5",   "hash_nightwatch"],
    ["SK-A-179", "hash_selfportrait"],
  ]);

  const baselineMap = new Map(); // First run: no baseline

  const { unchanged, modified, added, removed } = computeDiff({ db, currentMap, baselineMap });

  assertEq(added.length, 2, "all current artworks appear as added when baseline is empty");
  assertEq(unchanged.length, 0, "0 unchanged");
  assertEq(modified.length, 0, "0 modified");
  assertEq(removed.length, 0, "0 removed");
}

section("No provenance_enrichments table — withEnrichment is empty, no crash");
{
  // DB with NO provenance_enrichments table at all — computeDiff must not throw
  // (a throw would crash this run and fail the suite loudly).
  const db = new Database(":memory:");

  const currentMap = new Map([["SK-A-0050", "hash_50"]]);
  const baselineMap = new Map([["SK-A-0050", "hash_old_50"]]);

  const result = computeDiff({ db, currentMap, baselineMap });

  assertEq(result.withEnrichment.size, 0, "withEnrichment is empty when table absent");
  assertEq(result.modified.length, 1, "modified still computed correctly");
}

// ─── Result ───────────────────────────────────────────────────────────────────

process.stdout.write(`\n${passed + failed} checks: ${passed} passed, ${failed} failed\n`);

if (failures.length > 0) {
  process.stdout.write("\nFailures:\n");
  for (const f of failures) process.stdout.write(`  ✗ ${f}\n`);
  process.exit(1);
}

process.stdout.write("All provenance-change-report checks passed.\n");
