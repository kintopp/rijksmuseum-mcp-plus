/**
 * search_provenance's two passes (SQL admits artworks, per-event flags mark what matched)
 * must agree, and a page past the end must not read as "nothing matched".
 *
 * Failure modes:
 *  - a non-LLM positionMethod admits artworks whose events are never flagged
 *  - hasGap plus another event filter requires both on one event, flagging none
 *  - party admission matches role words and dates in the JSON, not just names
 *  - an offset past the end reports totalArtworks 0, in events and periods alike
 *  - the past-end warning fires when nothing matched at all
 *
 * Run:  node scripts/tests/test-provenance-filter-consistency.mjs
 * Requires: npm run build (imports from dist/).
 */
import { strict as assert } from "node:assert";
import Database from "better-sqlite3";
import { buildFixture } from "./build-fixture-vocab-db.mjs";

const dbPath = buildFixture("fixture-provenance-filters.db");
const raw = new Database(dbPath);
raw.transaction(() => {
  const event = raw.prepare(`INSERT INTO provenance_events
    (artwork_id, sequence, raw_text, gap, transfer_type, parties, date_year, category_method)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`);
  const party = raw.prepare(`INSERT INTO provenance_parties
    (artwork_id, sequence, party_idx, party_name, party_role, party_position, position_method, enrichment_reasoning)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const period = raw.prepare(`INSERT INTO provenance_periods
    (artwork_id, sequence, owner_name, acquisition_method, begin_year, end_year)
    VALUES (?, 1, ?, 'sale', ?, ?)`);

  event.run(1, 1, "sale, Jan Six to Pieter de Graeff, 1702", 0, "sale",
    JSON.stringify([{ name: "Jan Six", role: "seller" }, { name: "Pieter de Graeff", role: "buyer" }]), 1702);
  event.run(1, 2, "Anna Collector, 1850", 1, "collection", JSON.stringify([{ name: "Anna Collector", role: null }]), 1850);
  party.run(1, 1, 0, "Jan Six", "seller", "sender", "role_mapping", null);
  party.run(1, 1, 1, "Pieter de Graeff", "buyer", "receiver", "role_mapping", null);
  party.run(1, 2, 0, "Anna Collector", null, "receiver", "llm_enrichment", "fixture reasoning");

  for (const [art, name, year] of [[2, "Dealer Two", 1800], [3, "Dealer Three", 1801], [4, "Dealer Four", 1802], [5, "Dealer Five", 1803]]) {
    event.run(art, 1, `sale, ${name}, ${year}`, 0, "sale", JSON.stringify([{ name, role: "seller" }]), year);
    party.run(art, 1, 0, name, "seller", "sender", "type_mapping", null);
  }
  for (const art of [1, 2, 3, 4, 5]) period.run(art, `Owner ${art}`, 1700 + art, 1750 + art);
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
const fx1 = (r) => {
  const hit = r.results.find((a) => a.objectNumber === "FX-1");
  assert.ok(hit, `FX-1 missing from ${r.results.map((a) => a.objectNumber)}`);
  return hit;
};
const PAST_END = "offset 100 is past the last matching artwork (5 total)";

console.log("\nProvenance filter consistency\n");

check("positionMethod role_mapping flags the event it admitted", () => {
  const hit = fx1(db.searchProvenance({ positionMethod: "role_mapping" }));
  assert.equal(hit.matchedEventCount, 1);
  assert.equal(hit.events.find((e) => e.sequence === 1).matched, true);
});

check("positionMethod llm_enrichment flags its event", () => {
  assert.equal(fx1(db.searchProvenance({ positionMethod: "llm_enrichment" })).matchedEventCount, 1);
});

check("positionMethod type_mapping admits 4, each with one flagged event", () => {
  const r = db.searchProvenance({ positionMethod: "type_mapping" });
  assert.equal(r.totalArtworks, 4);
  assert.deepEqual(r.results.map((a) => a.matchedEventCount), [1, 1, 1, 1]);
});

check("party and role_mapping flag the same party row", () => {
  assert.equal(fx1(db.searchProvenance({ party: "Six", positionMethod: "role_mapping" })).matchedEventCount, 1);
});

check("party matches a name", () => {
  assert.equal(fx1(db.searchProvenance({ party: "Graeff" })).matchedEventCount, 1);
});

check("party does not match a role word", () => {
  const r = db.searchProvenance({ party: "buyer" });
  assert.equal(r.totalArtworks, 0);
  assert.equal(r.results.length, 0);
});

check("hasGap plus transferType flags the sale in the gapped artwork", () => {
  const r = db.searchProvenance({ hasGap: true, transferType: "sale" });
  assert.equal(r.totalArtworks, 1);
  assert.equal(fx1(r).matchedEventCount, 1);
});

check("hasGap alone highlights only the gap event", () => {
  const hit = fx1(db.searchProvenance({ hasGap: true }));
  assert.equal(hit.matchedEventCount, 1);
  assert.deepEqual(hit.events.filter((e) => e.matched).map((e) => e.sequence), [2]);
});

check("events offset past the end reports the true total", () => {
  const r = db.searchProvenance({ transferType: "sale", offset: 100 });
  assert.equal(r.results.length, 0);
  assert.equal(r.totalArtworks, 5);
  assert.ok(r.warnings?.includes(PAST_END), `warnings: ${r.warnings}`);
});

check("periods offset past the end reports the true total", () => {
  const r = db.searchProvenancePeriods({ acquisitionMethod: "sale", offset: 100 });
  assert.equal(r.results.length, 0);
  assert.equal(r.totalArtworks, 5);
  assert.ok(r.warnings?.includes(PAST_END), `warnings: ${r.warnings}`);
});

check("offset on an empty match set gives no past-end warning", () => {
  const r = db.searchProvenance({ party: "nobody", offset: 100 });
  assert.equal(r.totalArtworks, 0);
  assert.ok(!(r.warnings ?? []).some((w) => w.includes("offset")), `warnings: ${r.warnings}`);
});

console.log(`\n${failed === 0 ? "All passed" : `${failed} failed`}\n`);
process.exit(failed > 0 ? 1 : 0);
