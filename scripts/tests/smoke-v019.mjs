#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  cwd: process.cwd(),
  env: { ...process.env, STRUCTURED_CONTENT: "true" },
});

const client = new Client({ name: "smoke-test", version: "1.0" });
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

console.log("1. search_artwork — Rembrandt paintings");
let sc = await call("search_artwork", { creator: "Rembrandt", type: "painting", maxResults: 3 });
check("Returns results", sc?.results?.length > 0);
if (sc?.results?.[0]) console.log(`    → ${sc.results[0].objectNumber}: ${(sc.results[0].title||"").slice(0,60)}`);

console.log("\n2. search_artwork — compact");
sc = await call("search_artwork", { subject: "dog", compact: true });
check("Returns ids", sc?.ids?.length > 0);
check("Has totalResults", sc?.totalResults > 0);
console.log(`    → ${sc?.totalResults} results`);

console.log("\n3. search_artwork — aboutActor");
sc = await call("search_artwork", { aboutActor: "Vermeer", maxResults: 3 });
check("Returns results", (sc?.results?.length > 0 || sc?.ids?.length > 0));

console.log("\n4. search_artwork — imageAvailable");
sc = await call("search_artwork", { material: "canvas", imageAvailable: true, maxResults: 3 });
check("Returns results", sc?.results?.length > 0);

console.log("\n5. search_artwork — creator + material intersection");
sc = await call("search_artwork", { creator: "Rembrandt", material: "canvas", maxResults: 5 });
check("Returns results", (sc?.results?.length > 0 || sc?.ids?.length > 0));
console.log(`    → ${sc?.totalResults ?? sc?.results?.length ?? 0} results`);

console.log("\n6. lookup_iconclass");
sc = await call("lookup_iconclass", { query: "crucifixion" });
check("Returns results", sc?.results?.length > 0 || sc?.notations?.length > 0);
if (sc) console.log(`    → keys: ${Object.keys(sc).join(", ")}`);

console.log("\n7. get_artwork_details — Night Watch");
sc = await call("get_artwork_details", { objectNumber: "SK-C-5" });
check("Returns title", sc?.title != null);
check("Has creator info", sc?.creators?.length > 0 || sc?.creator != null || sc?.creatorLabel != null);
if (sc) console.log(`    → keys: ${Object.keys(sc).slice(0,8).join(", ")}`);

console.log("\n8. search_artwork — title + subject (BM25 FTS path)");
sc = await call("search_artwork", { title: "nachtwacht", subject: "historical persons", maxResults: 3 });
check("Returns results", sc?.results?.length > 0);

console.log("\n9. search_artwork — importance ordering");
sc = await call("search_artwork", { type: "painting", maxResults: 3 });
check("Returns results", sc?.results?.length > 0);
if (sc?.results?.[0]) console.log(`    → Top: ${sc.results[0].objectNumber} "${(sc.results[0].title||"").slice(0,50)}"`);

console.log("\n10. semantic_search");
sc = await call("semantic_search", { query: "vanitas still life with skull", maxResults: 3 });
check("Returns results", sc?.results?.length > 0);
const firstResult = sc?.results?.[0];
check("Has similarityScore", firstResult?.similarityScore != null);
if (firstResult) console.log(`    → keys: ${Object.keys(firstResult).join(", ")}`);

console.log("\n11. search_artwork — attributionQualifier");
sc = await call("search_artwork", { attributionQualifier: "workshop of", maxResults: 3 });
check("Returns results", sc?.results?.length > 0);
console.log(`    → ${sc?.totalResults ?? sc?.results?.length ?? 0} results`);

console.log("\n12. search_artwork — attributionQualifier + creator");
sc = await call("search_artwork", { attributionQualifier: "workshop of", creator: "Rembrandt", maxResults: 3 });
check("Returns results", sc?.results?.length > 0);
const workshopCount = sc?.totalResults ?? sc?.results?.length ?? 0;
console.log(`    → ${workshopCount} results`);

console.log("\n13. search_artwork — multi-value AND subject");
const landscapeSc = await call("search_artwork", { subject: "landscape", compact: true });
const landscapeCount = landscapeSc?.totalResults ?? landscapeSc?.ids?.length ?? 0;
sc = await call("search_artwork", { subject: ["landscape", "seascape"], compact: true });
const andCount = sc?.ids?.length ?? 0;
check("Returns results", andCount > 0);
check("AND is narrower than single", andCount < landscapeCount);
console.log(`    → landscape: ${landscapeCount}, landscape+seascape: ${andCount} ids`);

console.log("\n14. search_artwork — multi-value AND technique");
sc = await call("search_artwork", { technique: ["etching", "engraving"], compact: true });
check("Returns results", (sc?.ids?.length ?? 0) > 0);
console.log(`    → ${sc?.ids?.length ?? 0} ids`);

console.log("\n15. search_artwork — multi-value AND productionPlace");
sc = await call("search_artwork", { productionPlace: ["Amsterdam", "Paris"], compact: true });
// Very few artworks produced in BOTH cities — may be 0 or small number
check("Returns without error", sc?._error === undefined);
console.log(`    → ${sc?.ids?.length ?? 0} ids`);

console.log("\n16. search_artwork — facets on broad search");
sc = await call("search_artwork", { subject: "landscape", facets: true });
check("Has facets", sc?.facets != null);
if (sc?.facets) {
  const dims = Object.keys(sc.facets);
  check("All 4 dimensions present", dims.length === 4);
  check("Entries sorted descending", Object.values(sc.facets).every(
    entries => entries.every((e, i) => i === 0 || entries[i-1].count >= e.count)));
  console.log(`    → ${dims.join(", ")}: ${dims.map(d => sc.facets[d][0]?.label + " (" + sc.facets[d][0]?.count + ")").join(", ")}`);
}

console.log("\n17. search_artwork — facets exclude filtered dimensions");
sc = await call("search_artwork", { type: "painting", subject: "portrait", facets: true });
check("type facet excluded", !sc?.facets?.type);
check("Other facets present", sc?.facets?.material != null || sc?.facets?.century != null);

console.log("\n18. search_artwork — no facets when not truncated");
sc = await call("search_artwork", { creator: "Rembrandt", type: "painting", material: "canvas", subject: "self-portrait", facets: true, maxResults: 50 });
check("No facets (results fit)", sc?.facets === undefined);
console.log(`    → ${sc?.results?.length ?? 0} results (not truncated)`);

console.log(`\n═══════════════════════════════════════`);
console.log(`  Passed: ${passed}  Failed: ${failed}`);
console.log(`═══════════════════════════════════════\n`);

await client.close();
process.exit(failed > 0 ? 1 : 0);
