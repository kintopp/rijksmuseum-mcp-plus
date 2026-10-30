/**
 * Broad vocabulary id lists must not hit SQLite's bound-variable limit or get clipped.
 *
 * Failure modes:
 *  - too many bound variables: one `?` per id throws past 32,766 ids (creator:["van","de"])
 *  - a clipped person count: search_persons truncates candidates and under-reports totalResults
 *
 * Run:  node scripts/tests/test-vocabdb-id-lists.mjs
 * Requires: npm run build (imports from dist/).
 */
import { strict as assert } from "node:assert";
import Database from "better-sqlite3";
import { buildFixture } from "./build-fixture-vocab-db.mjs";

const BULK_PLACES = 40_000;
const PERSONS = 950;

const dbPath = buildFixture("fixture-id-lists.db");
const raw = new Database(dbPath);
raw.transaction(() => {
  const vocab = raw.prepare(
    "INSERT INTO vocabulary (id, type, label_en, vocab_int_id) VALUES (?, ?, ?, ?)"
  );
  for (let n = 0; n < BULK_PLACES; n++) vocab.run(`p-bulk-${n}`, "place", `Bulkplace ${n}`, 100_000 + n);

  const name = raw.prepare("INSERT INTO person_names (person_id, name) VALUES (?, ?)");
  const mapping = raw.prepare("INSERT INTO mappings (artwork_id, vocab_rowid, field_id) VALUES (1, ?, 4)");
  for (let n = 0; n < PERSONS; n++) {
    vocab.run(`pers-bulk-${n}`, "person", `Testperson ${n}`, 200_000 + n);
    name.run(`pers-bulk-${n}`, `Testperson ${n}`);
    mapping.run(200_000 + n);
  }
  raw.prepare("INSERT INTO person_names_fts(person_names_fts) VALUES('rebuild')").run();
})();
raw.close();

process.env.VOCAB_DB_PATH = dbPath;
const { VocabularyDb } = await import("../../dist/api/VocabularyDb.js");
const db = new VocabularyDb();

let failed = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}\n    ${err.message}`);
  }
};

console.log("\nVocabulary id lists\n");

check(`mappingFilterDirect binds ${BULK_PLACES} ids as one parameter`, () => {
  const ids = Array.from({ length: BULK_PLACES }, (_, n) => `p-bulk-${n}`);
  // Private method: no fixture-sized tool call can reach the variable limit.
  const { condition, bindings } = db["mappingFilterDirect"](["subject"], ids);
  assert.equal(bindings.length, 2);
  const ro = new Database(dbPath, { readonly: true });
  try {
    ro.prepare(`SELECT COUNT(*) AS n FROM artworks a WHERE ${condition}`).get(...bindings);
  } finally {
    ro.close();
  }
});

check(`searchPersons counts all ${PERSONS} candidates, with no clip warning`, () => {
  const res = db.searchPersons({ name: "Testperson" });
  assert.equal(res.totalResults, PERSONS);
  assert.ok(!(res.warnings ?? []).some((w) => w.includes("clipped")), `warnings: ${res.warnings}`);
});

console.log(`\n${failed === 0 ? "All passed" : `${failed} failed`}\n`);
process.exit(failed > 0 ? 1 : 0);
