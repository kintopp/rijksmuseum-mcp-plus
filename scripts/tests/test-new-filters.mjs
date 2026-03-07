#!/usr/bin/env node
/**
 * Tests for v0.20 filters: creatorGender, creatorBornAfter/Before, expandPlaceHierarchy.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  cwd: process.cwd(),
  env: { ...process.env, STRUCTURED_CONTENT: "true" },
});

const client = new Client({ name: "new-filters-test", version: "1.0" });
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
    return r.structuredContent ?? (r.content?.[0]?.text ? JSON.parse(r.content[0].text) : r);
  } catch (e) {
    return { _error: e.message };
  }
}

// ═══════════════════════════════════════════════════════════
//  1. creatorGender
// ═══════════════════════════════════════════════════════════
console.log("1. creatorGender — female painters");
let sc = await call("search_artwork", { type: "painting", creatorGender: "female", maxResults: 5 });
check("Returns results", sc?.results?.length > 0);
check("No error", !sc?._error);
const femaleCount = sc?.totalResults ?? sc?.results?.length ?? 0;
console.log(`    → ${femaleCount} results`);

console.log("\n2. creatorGender — male vs female count (maxResults: 50 to compare)");
let scFemale50 = await call("search_artwork", { type: "painting", creatorGender: "female", maxResults: 50 });
let scMale50 = await call("search_artwork", { type: "painting", creatorGender: "male", maxResults: 50 });
const female50 = scFemale50?.results?.length ?? 0;
const male50 = scMale50?.results?.length ?? 0;
check("Male >= female at maxResults 50 (demographic skew)", male50 >= female50);
console.log(`    → male: ${male50}, female: ${female50}`);

console.log("\n3. creatorGender alone (modifier guard)");
sc = await call("search_artwork", { creatorGender: "female" });
check("Rejected as standalone", sc?.content?.[0]?.text?.includes("At least one") || sc?._error || sc?.error);
console.log(`    → ${sc?._error || sc?.content?.[0]?.text?.slice(0, 80) || "rejected"}`);

// ═══════════════════════════════════════════════════════════
//  4. creatorBornAfter / creatorBornBefore
// ═══════════════════════════════════════════════════════════
console.log("\n4. creatorBornAfter — 19th century painters");
sc = await call("search_artwork", { type: "painting", creatorBornAfter: 1800, creatorBornBefore: 1900, maxResults: 5 });
check("Returns results", sc?.results?.length > 0);
const c19Count = sc?.totalResults ?? sc?.results?.length ?? 0;
console.log(`    → ${c19Count} results`);

console.log("\n5. creatorBornAfter narrower than type alone");
const allPaintings = await call("search_artwork", { type: "painting", maxResults: 5 });
const allCount = allPaintings?.totalResults ?? allPaintings?.results?.length ?? 0;
check("Born 1800-1900 < all paintings", c19Count < allCount);
console.log(`    → born 1800-1900: ${c19Count}, all paintings: ${allCount}`);

console.log("\n6. creatorBornBefore — medieval creators");
sc = await call("search_artwork", { type: "painting", creatorBornBefore: 1400, maxResults: 5 });
check("Returns results (may be few)", sc?.results?.length >= 0 && !sc?._error);
console.log(`    → ${sc?.totalResults ?? sc?.results?.length ?? 0} results`);

console.log("\n7. creatorGender + creatorBornAfter combined");
sc = await call("search_artwork", { type: "painting", creatorGender: "female", creatorBornAfter: 1850, maxResults: 50 });
const combinedCount = sc?.results?.length ?? 0;
check("Returns results", combinedCount > 0);
check("Narrower than gender alone", combinedCount < female50);
console.log(`    → ${combinedCount} results (female painters born after 1850) vs ${female50} (all female)`);

// ═══════════════════════════════════════════════════════════
//  8. expandPlaceHierarchy
// ═══════════════════════════════════════════════════════════
console.log("\n8. expandPlaceHierarchy — productionPlace");
const noExpand = await call("search_artwork", { productionPlace: "Noord-Holland", maxResults: 5, compact: true });
const withExpand = await call("search_artwork", { productionPlace: "Noord-Holland", expandPlaceHierarchy: true, maxResults: 5, compact: true });
const noExpandCount = noExpand?.totalResults ?? noExpand?.ids?.length ?? 0;
const withExpandCount = withExpand?.totalResults ?? withExpand?.ids?.length ?? 0;
check("Expanded >= non-expanded", withExpandCount >= noExpandCount);
check("Expansion warning present", withExpand?.warnings?.some(w => w.includes("hierarchy")));
console.log(`    → without: ${noExpandCount}, with hierarchy: ${withExpandCount}`);

console.log("\n9. expandPlaceHierarchy — depictedPlace");
const noExpDep = await call("search_artwork", { depictedPlace: "Noord-Holland", maxResults: 5, compact: true });
const withExpDep = await call("search_artwork", { depictedPlace: "Noord-Holland", expandPlaceHierarchy: true, maxResults: 5, compact: true });
const noExpDepCount = noExpDep?.totalResults ?? noExpDep?.ids?.length ?? 0;
const withExpDepCount = withExpDep?.totalResults ?? withExpDep?.ids?.length ?? 0;
check("Expanded >= non-expanded (depicted)", withExpDepCount >= noExpDepCount);
console.log(`    → without: ${noExpDepCount}, with hierarchy: ${withExpDepCount}`);

console.log("\n10. expandPlaceHierarchy alone (modifier guard)");
sc = await call("search_artwork", { expandPlaceHierarchy: true });
check("Rejected as standalone", sc?.content?.[0]?.text?.includes("At least one") || sc?._error || sc?.error);

// ═══════════════════════════════════════════════════════════
//  11. Schema surface — new params present
// ═══════════════════════════════════════════════════════════
console.log("\n11. Schema — new params in inputSchema");
const tools = await client.listTools();
const searchTool = tools.tools.find(t => t.name === "search_artwork");
const props = searchTool?.inputSchema?.properties ?? {};
check("creatorGender in schema", "creatorGender" in props);
check("creatorBornAfter in schema", "creatorBornAfter" in props);
check("creatorBornBefore in schema", "creatorBornBefore" in props);
check("expandPlaceHierarchy in schema", "expandPlaceHierarchy" in props);
check("No $ref in new params", !JSON.stringify(props.creatorGender).includes("$ref"));

// ═══════════════════════════════════════════════════════════
//  12. JSON null acceptance for new params
// ═══════════════════════════════════════════════════════════
console.log("\n12. JSON null acceptance");
sc = await call("search_artwork", { type: "painting", creatorGender: null, creatorBornAfter: null, maxResults: 3 });
check("Null new params don't break search", sc?.results?.length > 0);

console.log(`\n═══════════════════════════════════════`);
console.log(`  Passed: ${passed}  Failed: ${failed}`);
console.log(`═══════════════════════════════════════\n`);

await client.close();
process.exit(failed > 0 ? 1 : 0);
