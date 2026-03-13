/**
 * Smoke test: totalResults always present + selective facets + compact facets.
 * Runs against the vocab DB directly (no MCP transport needed).
 */
import { VocabularyDb } from "../../dist/api/VocabularyDb.js";

const ALL_FACETS = ["type", "material", "technique", "century", "creatorGender", "rights", "imageAvailable"];

const vocabDb = new VocabularyDb();
let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

// --- 1. totalResults always present ---
console.log("\n1. totalResults always present (multi-filter queries)");

const r1 = vocabDb.search({ type: "sculpture", creationDate: "190*", maxResults: 50 });
assert(r1.totalResults != null, `type+date: totalResults=${r1.totalResults} (not null/undefined)`);

const r2 = vocabDb.search({ creatorGender: "male", creationDate: "190*", maxResults: 50 });
assert(r2.totalResults != null, `gender+date: totalResults=${r2.totalResults}`);
assert(r2.totalResults > 50, `gender+date: totalResults > 50 (was ${r2.totalResults})`);

const r3 = vocabDb.search({ type: "painting", creationDate: "16*", maxResults: 50 });
assert(r3.totalResults != null, `painting+17thc: totalResults=${r3.totalResults}`);

// --- 2. totalResults in compact mode ---
console.log("\n2. totalResults in compact mode");

const c1 = vocabDb.searchCompact({ type: "sculpture", creationDate: "190*", maxResults: 50 });
assert(c1.totalResults != null, `compact type+date: totalResults=${c1.totalResults}`);

const c2 = vocabDb.searchCompact({ creatorGender: "female", creationDate: "190*", maxResults: 50 });
assert(c2.totalResults != null, `compact gender+date: totalResults=${c2.totalResults}`);

// --- 3. All facets (pass full array) ---
console.log("\n3. All facets via array");

const r4 = vocabDb.search({ type: "painting", creationDate: "17*", facets: ALL_FACETS, maxResults: 50 });
assert(r4.facets != null, `facets present when truncated`);
assert(r4.facets?.creatorGender != null, `creatorGender facet present`);
assert(r4.facets?.rights != null, `rights facet present`);
assert(r4.facets?.imageAvailable != null, `imageAvailable facet present`);
// type is filtered, should be excluded
assert(!r4.facets?.type, `type facet excluded (already filtered)`);
// century is filtered (creationDate), should be excluded
assert(!r4.facets?.century, `century facet excluded (creationDate filtered)`);
if (r4.facets?.creatorGender) {
  console.log(`    Gender: ${r4.facets.creatorGender.map(f => `${f.label}(${f.count})`).join(", ")}`);
}
if (r4.facets?.rights) {
  console.log(`    Rights: ${r4.facets.rights.map(f => `${f.label}(${f.count})`).join(", ")}`);
}
if (r4.facets?.imageAvailable) {
  console.log(`    Image: ${r4.facets.imageAvailable.map(f => `${f.label}(${f.count})`).join(", ")}`);
}

// --- 4. Selective facets (only requested dimensions computed) ---
console.log("\n4. Selective facets");

const r5 = vocabDb.search({ creationDate: "17*", facets: ["creatorGender"], maxResults: 50 });
assert(r5.facets?.creatorGender != null, `requested creatorGender: present`);
assert(!r5.facets?.type, `unrequested type: absent`);
assert(!r5.facets?.material, `unrequested material: absent`);
assert(!r5.facets?.rights, `unrequested rights: absent`);

const r6 = vocabDb.search({ creationDate: "17*", facets: ["rights", "imageAvailable"], maxResults: 50 });
assert(r6.facets?.rights != null, `requested rights: present`);
assert(r6.facets?.imageAvailable != null, `requested imageAvailable: present`);
assert(!r6.facets?.creatorGender, `unrequested creatorGender: absent`);
assert(!r6.facets?.material, `unrequested material: absent`);

// --- 5. Filtered dimensions excluded ---
console.log("\n5. Filtered dimensions excluded");

const r7 = vocabDb.search({ creatorGender: "female", type: "painting", facets: ALL_FACETS, maxResults: 50 });
assert(!r7.facets?.creatorGender, `creatorGender excluded when creatorGender filtered`);
assert(!r7.facets?.type, `type excluded when type filtered`);

const r8 = vocabDb.search({ type: "painting", imageAvailable: true, facets: ["imageAvailable", "rights"], maxResults: 50 });
assert(!r8.facets?.imageAvailable, `imageAvailable excluded when imageAvailable filtered`);

const r9 = vocabDb.search({ type: "painting", license: "publicdomain", facets: ["rights", "century"], maxResults: 50 });
assert(!r9.facets?.rights, `rights excluded when license filtered`);

// --- 6. Facets in compact mode ---
console.log("\n6. Facets in compact mode");

const c3 = vocabDb.searchCompact({ type: "painting", creationDate: "17*", facets: ["creatorGender", "rights"], maxResults: 50 });
assert(c3.facets?.creatorGender != null, `compact: creatorGender facet present`);
assert(c3.facets?.rights != null, `compact: rights facet present`);
assert(!c3.facets?.material, `compact: unrequested material absent`);

// --- 7. totalResults accuracy ---
console.log("\n7. totalResults accuracy (small result set fits in limit)");

const r10 = vocabDb.search({ type: "sculpture", creationDate: "199*", maxResults: 50 });
assert(r10.totalResults === r10.results.length, `totalResults=${r10.totalResults} equals results.length=${r10.results.length} when not truncated`);

// --- 8. No facets when results fit in limit ---
console.log("\n8. No facets when results fit in limit");

const r11 = vocabDb.search({ type: "sculpture", creationDate: "199*", facets: ALL_FACETS, maxResults: 50 });
assert(r11.facets == null, `no facets when results not truncated (${r11.totalResults} results)`);

// --- 9. dateMatch modes ---
console.log("\n9. dateMatch modes");

// Use sculpture 1900s — we know: overlap=165, contained=16 from benchmarks
const dOverlaps = vocabDb.search({ type: "sculpture", creationDate: "190*", maxResults: 50 });
const dWithin = vocabDb.search({ type: "sculpture", creationDate: "190*", dateMatch: "within", maxResults: 50 });
const dMidpoint = vocabDb.search({ type: "sculpture", creationDate: "190*", dateMatch: "midpoint", maxResults: 50 });

console.log(`    overlaps: ${dOverlaps.totalResults}, within: ${dWithin.totalResults}, midpoint: ${dMidpoint.totalResults}`);
assert(dOverlaps.totalResults > dWithin.totalResults, `overlaps (${dOverlaps.totalResults}) > within (${dWithin.totalResults})`);
assert(dMidpoint.totalResults >= dWithin.totalResults, `midpoint (${dMidpoint.totalResults}) >= within (${dWithin.totalResults})`);
assert(dMidpoint.totalResults <= dOverlaps.totalResults, `midpoint (${dMidpoint.totalResults}) <= overlaps (${dOverlaps.totalResults})`);

// Midpoint should produce additive bins: sum across decades ≈ single-query total
const decades = ["188*","189*","190*","191*","192*","193*","194*","195*","196*","197*","198*","199*"];
const midpointSum = decades.reduce((sum, d) => {
  const r = vocabDb.searchCompact({ type: "painting", creationDate: d, dateMatch: "midpoint", maxResults: 1 });
  return sum + (r.totalResults ?? 0);
}, 0);
const overlapSum = decades.reduce((sum, d) => {
  const r = vocabDb.searchCompact({ type: "painting", creationDate: d, dateMatch: "overlaps", maxResults: 1 });
  return sum + (r.totalResults ?? 0);
}, 0);
// Get the actual count of paintings in 1880-1999
const allPaintings = vocabDb.searchCompact({ type: "painting", creationDate: "1*", maxResults: 1 });
console.log(`    paintings 1880-1999: midpoint sum=${midpointSum}, overlap sum=${overlapSum}, all 1xxx=${allPaintings.totalResults}`);
assert(midpointSum <= (allPaintings.totalResults ?? 0), `midpoint sum (${midpointSum}) <= total paintings (${allPaintings.totalResults})`);
assert(overlapSum > midpointSum, `overlap sum (${overlapSum}) > midpoint sum (${midpointSum}) due to double-counting`);

// Default (no dateMatch) should behave like overlaps
const dDefault = vocabDb.search({ type: "sculpture", creationDate: "190*", maxResults: 50 });
assert(dDefault.totalResults === dOverlaps.totalResults, `default matches overlaps (${dDefault.totalResults} === ${dOverlaps.totalResults})`);

console.log(`\n${"═".repeat(60)}`);
console.log(`  Passed: ${passed}  Failed: ${failed}`);
console.log(`${"═".repeat(60)}`);
process.exit(failed > 0 ? 1 : 0);
