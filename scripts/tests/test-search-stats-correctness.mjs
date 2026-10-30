/**
 * Numbers a model reads as facts about the collection must be true.
 *
 * Failure modes:
 *  - wrong denominator: a facet percentage is a share of the listed entries, not of the result
 *  - midpoint falling between bins: an odd date sum (1649–1650) lands in no decade
 *  - ignored false: hasProvenance:false is accepted and echoed but never applied
 *
 * Run:  node scripts/tests/test-search-stats-correctness.mjs
 * Requires: npm run build (imports from dist/).
 */
import { strict as assert } from "node:assert";
import Database from "better-sqlite3";
import { buildFixture } from "./build-fixture-vocab-db.mjs";
import { connectFixtureClient } from "./fixture-client.mjs";
import { addPercentages } from "../../dist/registration/helpers.js";

let failed = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}\n    ${err.message}`);
  }
};
const objs = (res) => res.results.map((r) => r.objectNumber).sort();

console.log("\nSearch and stats correctness\n");

await check("addPercentages uses the denominator, not the sum of entries", () => {
  const facets = { type: [{ label: "a", count: 50 }, { label: "b", count: 30 }] };
  addPercentages(facets, 1000);
  assert.deepEqual(facets.type.map((e) => e.percentage), [5, 3]);
});

await check("addPercentages leaves percentage undefined without a denominator", () => {
  for (const denominator of [undefined, 0]) {
    const facets = { type: [{ label: "a", count: 50 }] };
    addPercentages(facets, denominator);
    assert.equal(facets.type[0].percentage, undefined);
  }
});

const client = await connectFixtureClient("search-stats");
await check("search_artwork facet percentage is a share of totalResults", async () => {
  const res = await client.callTool({
    name: "search_artwork",
    arguments: { type: "painting", facets: ["century"], maxResults: 1 },
  });
  const { totalResults, facets } = res.structuredContent;
  assert.equal(totalResults, 5);
  const entry = facets.century.find((e) => e.label === "17th century");
  assert.equal(entry.count, 4);
  assert.equal(entry.percentage, 80);
});
await client.close();

const dbPath = buildFixture("fixture-search-stats.db");
const raw = new Database(dbPath);
raw.prepare(`INSERT INTO artworks
  (object_number, art_id, title, title_all_text, creator_label, description_text,
   inscription_text, narrative_text, height_cm, width_cm, date_earliest, date_latest,
   has_image, rights_id, iiif_id)
  VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, 0, 1, NULL)`)
  .run("FX-101", 101, "Bin-edge drawing", "Bin-edge drawing", "Anonymous", 1649, 1650);
raw.prepare(`INSERT INTO provenance_events (artwork_id, sequence, raw_text, transfer_type)
  VALUES (1, 1, 'Jan Six, Amsterdam', 'collection')`).run();
raw.close();

process.env.VOCAB_DB_PATH = dbPath;
const { VocabularyDb } = await import("../../dist/api/VocabularyDb.js");
const db = new VocabularyDb();

await check("midpoint 1649.5 belongs to the 164* bin, not to neither", () => {
  assert.deepEqual(objs(db.search({ creationDate: "164*", dateMatch: "midpoint" })), ["FX-1", "FX-101"]);
  assert.deepEqual(objs(db.search({ creationDate: "165*", dateMatch: "midpoint" })), ["FX-5"]);
});

await check("midpoint decades put each artwork in exactly one bin", () => {
  const seen = [];
  for (let decade = 160; decade <= 189; decade++) {
    seen.push(...objs(db.search({ creationDate: `${decade}*`, dateMatch: "midpoint", maxResults: 50 })));
  }
  assert.equal(new Set(seen).size, seen.length, `duplicates in ${seen}`);
  assert.ok(seen.includes("FX-101"));
});

await check("search hasProvenance:true is the artwork with events", () => {
  assert.deepEqual(objs(db.search({ type: ["painting"], hasProvenance: true })), ["FX-1"]);
});

await check("search hasProvenance:false is the paintings without events", () => {
  assert.deepEqual(objs(db.search({ type: ["painting"], hasProvenance: false })), ["FX-2", "FX-4", "FX-6", "FX-7"]);
});

await check("collection_stats hasProvenance:true counts 1", () => {
  assert.equal(db.computeCollectionStats({ dimension: "type", hasProvenance: true }).total, 1);
});

await check("collection_stats hasProvenance:false counts the other 9", () => {
  assert.equal(db.computeCollectionStats({ dimension: "type", hasProvenance: false }).total, 9);
});

await check("collection_stats warns when hasProvenance:false meets a provenance filter", () => {
  const stats = db.computeCollectionStats({ dimension: "type", hasProvenance: false, transferType: "collection" });
  assert.ok(
    stats.warnings?.includes("hasProvenance=false contradicts the provenance filters (they require provenance), so no artworks match."),
    `warnings: ${stats.warnings}`,
  );
  assert.equal(stats.total, 0);
});

console.log(`\n${failed === 0 ? "All passed" : `${failed} failed`}\n`);
process.exit(failed > 0 ? 1 : 0);
