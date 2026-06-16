// Test plan 021: unused person filter (A), extentText opt-in (B), productionPlace recall (C).
// Model: smoke-collection-stats-party.mjs — StdioClientTransport, env STRUCTURED_CONTENT=true.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const t = new StdioClientTransport({
  command: "node", args: ["dist/index.js"], cwd: PROJECT_DIR,
  env: { ...process.env, STRUCTURED_CONTENT: "true" },
});
const c = new Client({ name: "test-runtime-additions", version: "0.1" });
await c.connect(t);

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); failures++; } else { console.log("PASS:", msg); }
}

// ── PART A: unused person filter ──────────────────────────────────────────────

// A1: unused:true returns persons with no artworkCount
const rUnused = await c.callTool({ name: "search_persons", arguments: { unused: true, maxResults: 5 } });
const unusedSC = rUnused.structuredContent;
assert(unusedSC?.persons?.length > 0, "A1: unused:true returns ≥1 person");
for (const p of (unusedSC?.persons ?? [])) {
  assert(p.artworkCount == null, `A1: person ${p.vocabId} has no artworkCount (unused)`);
}

// A2: totalResults for unused:true ≈ 181,378 (true-orphan count: persons with
// no creator AND no subject mapping). We verify it's in the right ballpark.
const totalUnused = unusedSC?.totalResults ?? 0;
assert(totalUnused > 150000 && totalUnused < 210000, `A2: totalResults ${totalUnused} ≈ 181378 (in 150k-210k range)`);

// A3: exact parity with the SQL count. Tightened to exclude depicted-only
// persons (used as subject, not creator) — those are legitimate terms, not
// orphaned maker names. Reverting the subject exclusion regresses this to 230753.
assert(totalUnused === 181378, `A3: totalResults ${totalUnused} === 181378 (exact SQL parity, true orphans)`);

// A4: unused:true, name:"Rembrandt" returns 0 (Rembrandt is a creator)
const rUnusedRembrandt = await c.callTool({ name: "search_persons", arguments: { unused: true, name: "Rembrandt van Rijn" } });
const unusedRembrandtSC = rUnusedRembrandt.structuredContent;
assert((unusedRembrandtSC?.totalResults ?? 0) === 0, `A4: unused:true + name:Rembrandt van Rijn returns 0`);

// A5: regression — hasArtworks:true still returns creators (artworkCount present)
const rCreators = await c.callTool({ name: "search_persons", arguments: { hasArtworks: true, maxResults: 5 } });
const creatorsSC = rCreators.structuredContent;
assert(creatorsSC?.persons?.length > 0, "A5: hasArtworks:true returns ≥1 person");
for (const p of (creatorsSC?.persons ?? [])) {
  assert(p.artworkCount != null, `A5: person ${p.vocabId} has artworkCount (creator)`);
}

// ── PART B: extentText opt-in ──────────────────────────────────────────────────

// B1: browse_set default — no extentText in records
const BROWSE_SET_SPEC = "261221"; // "varia" set
const rBrowseDefault = await c.callTool({ name: "browse_set", arguments: { setSpec: BROWSE_SET_SPEC, maxResults: 5 } });
const browseDefaultSC = rBrowseDefault.structuredContent;
assert(browseDefaultSC?.records?.length > 0, "B1a: browse_set default returns records");
const defaultHasExtent = (browseDefaultSC?.records ?? []).some(r => r.extentText != null);
assert(!defaultHasExtent, "B1b: browse_set default records have no extentText");

// B2: browse_set with includeExtentText:true — at least some records have extentText
// (not all records may have extent_text; we just need the gate to work)
const rBrowseExtent = await c.callTool({ name: "browse_set", arguments: { setSpec: BROWSE_SET_SPEC, maxResults: 20, includeExtentText: true } });
const browseExtentSC = rBrowseExtent.structuredContent;
assert(browseExtentSC?.records?.length > 0, "B2a: browse_set includeExtentText:true returns records");
// Gate passes if at least one record has extentText (the flag must allow it through)
const extentHasExtent = (browseExtentSC?.records ?? []).some(r => r.extentText != null);
assert(extentHasExtent, "B2b: browse_set includeExtentText:true includes extentText for ≥1 record");

// B3: get_artwork_details default — extentText is null
const rDetailDefault = await c.callTool({ name: "get_artwork_details", arguments: { objectNumber: "SK-C-5" } });
const detailDefaultSC = rDetailDefault.structuredContent;
assert("extentText" in (detailDefaultSC ?? {}), "B3a: get_artwork_details has extentText key");
assert(detailDefaultSC?.extentText === null, `B3b: get_artwork_details default extentText is null (got: ${JSON.stringify(detailDefaultSC?.extentText)})`);

// B4: get_artwork_details verboseExtent:true — extentText is populated (SK-C-5 has extent)
const rDetailVerbose = await c.callTool({ name: "get_artwork_details", arguments: { objectNumber: "SK-C-5", verboseExtent: true } });
const detailVerboseSC = rDetailVerbose.structuredContent;
assert(detailVerboseSC?.extentText != null, `B4: get_artwork_details verboseExtent:true extentText is non-null (got: ${JSON.stringify(detailVerboseSC?.extentText)})`);

// ── PART C: productionPlace recall fix ───────────────────────────────────────

// C1: productionPlace:"Haarlem" returns results (was already indexed in spatial)
const rHaarlem = await c.callTool({ name: "search_artwork", arguments: { productionPlace: "Haarlem", maxResults: 5 } });
const haarlemSC = rHaarlem.structuredContent;
assert((haarlemSC?.results?.length ?? 0) > 0, "C1: productionPlace:Haarlem returns results");

// C2: productionPlace:"Amsterdam" returns results (both fields covered)
const rAmsterdam = await c.callTool({ name: "search_artwork", arguments: { productionPlace: "Amsterdam", maxResults: 5 } });
const amsterdamSC = rAmsterdam.structuredContent;
assert((amsterdamSC?.results?.length ?? 0) > 0, "C2: productionPlace:Amsterdam returns results");

// C3: depictedPlace still works (no regression from touching productionPlace)
const rDepicted = await c.callTool({ name: "search_artwork", arguments: { depictedPlace: "Amsterdam", maxResults: 5 } });
const depictedSC = rDepicted.structuredContent;
assert((depictedSC?.results?.length ?? 0) > 0, "C3: depictedPlace:Amsterdam still works (regression)");

// C4: collection_stats productionPlace dimension also works
const rStats = await c.callTool({ name: "collection_stats", arguments: { dimension: "productionPlace", topN: 5 } });
const statsSC = rStats.structuredContent;
assert((statsSC?.entries?.length ?? 0) > 0, "C4: collection_stats productionPlace dimension returns entries");
// The top entry should be a recognisable place (Amsterdam / Netherlands / Paris)
const topPlace = statsSC?.entries?.[0]?.label ?? "";
assert(topPlace.length > 0, `C4b: top productionPlace entry has a label (got: ${JSON.stringify(topPlace)})`);

await c.close();

if (failures > 0) {
  console.error(`\n${failures} test(s) FAILED`);
  process.exit(1);
}
console.log("\nAll tests passed.");
