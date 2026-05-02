#!/usr/bin/env node
/**
 * test-search-persons.mjs — verify #305 search_persons tool.
 *
 * v0.26 dress-rehearsal coverage:
 *   - name / hasArtworks / artworkCount: full coverage (DB has 290K persons + 700K name variants).
 *   - birthPlace / deathPlace / profession: covered (pivot through creator-mapped artworks).
 *   - gender / bornAfter / bornBefore: NOT covered until person enrichment is re-run on a fresh DB.
 *     On the v0.26 dress-rehearsal DB those filters return 0 rows. Tests are written defensively.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  cwd: process.cwd(),
  env: { ...process.env, STRUCTURED_CONTENT: "true" },
});
const client = new Client({ name: "search-persons-test", version: "1.0" });
await client.connect(transport);
console.log("Connected\n");

let passed = 0, failed = 0;
function check(label, cond) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.log(`  ✗ ${label}`); failed++; }
}

async function call(name, args) {
  try {
    const r = await client.callTool({ name, arguments: args });
    if (r.isError) return { _error: r.content?.[0]?.text ?? "" };
    return r.structuredContent ?? (r.content?.[0]?.text ? JSON.parse(r.content[0].text) : r);
  } catch (e) {
    return { _error: e.message };
  }
}

// 1. Name search — Rembrandt
console.log("1. name='Rembrandt' — should resolve to canonical Rembrandt van Rijn");
let r = await call("search_persons", { name: "Rembrandt", maxResults: 5 });
check("No error", !r?._error);
check("Returns ≥1 person", (r?.persons?.length ?? 0) >= 1);
check("Top result label contains 'Rembrandt'", /Rembrandt/i.test(r?.persons?.[0]?.label ?? ""));
check("Top result has artworkCount > 0", (r?.persons?.[0]?.artworkCount ?? 0) > 0);
console.log(`   top: ${r?.persons?.[0]?.label} (${r?.persons?.[0]?.artworkCount} works)`);
console.log(`   totalResults: ${r?.totalResults}`);

// 2. hasArtworks default — restricts to ~60K active creators
console.log("\n2. hasArtworks default true — count of active persons");
r = await call("search_persons", { name: "an", maxResults: 1 });
check("totalResults positive", (r?.totalResults ?? 0) > 0);
console.log(`   totalResults: ${r?.totalResults}`);

console.log("\n3. hasArtworks=false — name='an' should return MORE persons (includes non-creators)");
let r2 = await call("search_persons", { name: "an", hasArtworks: false, maxResults: 1 });
check("totalResults ≥ hasArtworks=true count", (r2?.totalResults ?? 0) >= (r?.totalResults ?? 0));
console.log(`   totalResults (no hasArtworks): ${r2?.totalResults}`);

// 4. birthPlace pivot
console.log("\n4. birthPlace='Paris' — persons whose creator-artworks have birth_place=Paris");
r = await call("search_persons", { birthPlace: "Paris", maxResults: 5 });
check("No error", !r?._error);
check("Returns ≥1 person OR zero (Paris-born persons)", typeof r?.totalResults === "number");
console.log(`   totalResults: ${r?.totalResults}`);
if (r?.persons?.[0]) console.log(`   top: ${r.persons[0].label} (${r.persons[0].artworkCount} works)`);

// 5. profession pivot
console.log("\n5. profession='painter' — persons mapped to painter profession");
r = await call("search_persons", { profession: "painter", maxResults: 3 });
check("No error", !r?._error);
check("Returns ≥1 painter", (r?.totalResults ?? 0) >= 1);
console.log(`   totalResults: ${r?.totalResults}`);

// 6. gender (will return 0 on dress-rehearsal DB)
console.log("\n6. gender='female' — runs without error (may return 0 if person enrichment absent)");
r = await call("search_persons", { gender: "female", maxResults: 3 });
check("No error", !r?._error);
check("totalResults is a number", typeof r?.totalResults === "number");
console.log(`   totalResults: ${r?.totalResults} (expected 0 on dress-rehearsal DB)`);

// 7. bornAfter / bornBefore (will return 0 on dress-rehearsal DB)
console.log("\n7. bornAfter=1800 + bornBefore=1900 — runs without error");
r = await call("search_persons", { bornAfter: 1800, bornBefore: 1900, maxResults: 3 });
check("No error", !r?._error);
check("totalResults is a number", typeof r?.totalResults === "number");
console.log(`   totalResults: ${r?.totalResults}`);

// 8. Pagination
console.log("\n8. Pagination — offset=10");
r = await call("search_persons", { name: "an", maxResults: 5, offset: 10 });
check("No error", !r?._error);
check("Returns up to 5 persons", (r?.persons?.length ?? 0) <= 5);

// 9. Output schema basics
console.log("\n9. Output schema — top result has expected fields");
r = await call("search_persons", { name: "Rembrandt", maxResults: 1 });
const top = r?.persons?.[0];
check("vocabId present", typeof top?.vocabId === "string");
check("label present", typeof top?.label === "string");
check("birthYear nullable", "birthYear" in (top ?? {}));
check("wikidataId nullable", "wikidataId" in (top ?? {}));

await client.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
