/**
 * Proximity search returns the nearest artworks, in compact and full mode alike.
 *
 * Failure modes:
 *  - compact skips the distance step and returns importance order
 *  - full mode sorts only the top rows by importance, so near low-importance works are never seen
 *  - a misordered binding between the distance list, field ids and filters
 *  - sortBy loses its own ordering path when geo is active
 *
 * Run:  node scripts/tests/test-geo-proximity-fixture.mjs
 * Requires: npm run build (imports from dist/).
 */
import { strict as assert } from "node:assert";
import Database from "better-sqlite3";
import { buildFixture } from "./build-fixture-vocab-db.mjs";

const FAR_COUNT = 2050;
const NEAR_COUNT = 50;
const SUBJECT_FIELD_ID = 12;

const dbPath = buildFixture("fixture-geo.db");
const raw = new Database(dbPath);
const near = new Set();
const far = new Set();
raw.transaction(() => {
  const place = raw.prepare(`INSERT INTO vocabulary
    (id, type, label_en, label_nl, label_en_norm, label_nl_norm, lat, lon, vocab_int_id)
    VALUES (?, 'place', ?, ?, ?, ?, ?, ?, ?)`);
  place.run("v-geo-ref", "Geoville", "Geoville", "geoville", "geoville", 52.0, 5.0, 900);
  place.run("v-geo-near", "Nearby", "Nearby", "nearby", "nearby", 52.018, 5.0, 901);
  place.run("v-geo-far", "Farther", "Farther", "farther", "farther", 52.18, 5.0, 902);
  raw.prepare("INSERT INTO vocabulary_fts(vocabulary_fts) VALUES('rebuild')").run();

  const art = raw.prepare(`INSERT INTO artworks
    (object_number, art_id, title, title_all_text, creator_label, has_image, rights_id, importance)
    VALUES (?, ?, ?, ?, 'Anonymous', 0, 1, ?)`);
  const mapping = raw.prepare("INSERT INTO mappings (artwork_id, vocab_rowid, field_id) VALUES (?, ?, ?)");
  for (let n = 1; n <= FAR_COUNT + NEAR_COUNT; n++) {
    const objectNumber = `GEO-${String(n).padStart(4, "0")}`;
    const isNear = n > FAR_COUNT;
    (isNear ? near : far).add(objectNumber);
    art.run(objectNumber, 1000 + n, objectNumber, objectNumber, isNear ? 0 : 9);
    mapping.run(1000 + n, isNear ? 901 : 902, SUBJECT_FIELD_ID);
  }
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
const ids = (res) => res.results.map((r) => r.objectNumber);
const QUERY = { nearPlace: "Geoville", nearPlaceRadius: 50, maxResults: 25 };

console.log("\nGeo proximity order\n");

check("full mode returns the near artworks, by non-decreasing distance", () => {
  const { results } = db.search(QUERY);
  assert.equal(results.length, 25);
  for (const r of results) assert.ok(near.has(r.objectNumber), `${r.objectNumber} is not near`);
  for (let i = 1; i < results.length; i++) {
    assert.ok(results[i].distance_km >= results[i - 1].distance_km, `distance decreases at ${i}`);
  }
});

check("compact returns the same ids in the same order", () => {
  const compact = db.searchCompact(QUERY).ids;
  for (const o of compact) assert.ok(near.has(o), `${o} is not near`);
  assert.deepEqual(compact, ids(db.search(QUERY)));
});

check("offset pages from near into far", () => {
  const page = ids(db.search({ ...QUERY, offset: 40 }));
  assert.equal(page.length, 25);
  assert.ok(page.slice(0, 10).every((o) => near.has(o)), `first 10: ${page.slice(0, 10)}`);
  assert.ok(page.slice(10).every((o) => far.has(o)), `rest: ${page.slice(10)}`);
});

check("nearLat/nearLon gives the same ids as nearPlace", () => {
  const coords = db.search({ nearLat: 52.0, nearLon: 5.0, nearPlaceRadius: 50, maxResults: 25 });
  assert.deepEqual(ids(coords), ids(db.search(QUERY)));
});

check("totalResults counts every artwork in the radius", () => {
  assert.equal(db.search(QUERY).totalResults, FAR_COUNT + NEAR_COUNT);
});

check("sortBy keeps its own ordering path", () => {
  assert.equal(db.search({ ...QUERY, sortBy: "dateEarliest" }).results.length, 25);
});

console.log(`\n${failed === 0 ? "All passed" : `${failed} failed`}\n`);
process.exit(failed > 0 ? 1 : 0);
