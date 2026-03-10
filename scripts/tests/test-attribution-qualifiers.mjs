#!/usr/bin/env node
/**
 * Test attribution qualifier extraction in get_artwork_details.
 * Verifies that the `attributionQualifier` field is populated from
 * Linked Art assigned_by[].classified_as.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { strict as assert } from "node:assert";

let passed = 0;
let failed = 0;
function ok(label, condition) {
  if (condition) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

const transport = new StdioClientTransport({ command: "node", args: ["dist/index.js"] });
const client = new Client({ name: "test-qualifiers", version: "1.0" });
await client.connect(transport);

async function getDetail(objectNumber) {
  const result = await client.callTool({ name: "get_artwork_details", arguments: { objectNumber } });
  // structuredContent is the typed output; text channel has the summary
  const structured = result.structuredContent ?? JSON.parse(result.content[0].text);
  const text = result.content?.[0]?.text ?? "";
  return { structured, text };
}

// ── 1. Night Watch (SK-C-5) — primary creator ────────────────────────
console.log("\n1. SK-C-5 — Night Watch (primary creator)");
const nw = await getDetail("SK-C-5");
const nwProd = nw.structured.production;
ok("has production entries", nwProd.length > 0);
ok("primary creator has attributionQualifier field", "attributionQualifier" in nwProd[0]);
// Primary creators get "primary" or null — either is acceptable
ok("primary qualifier is 'primary' or null",
  nwProd[0].attributionQualifier === "primary" || nwProd[0].attributionQualifier === null);
console.log(`  qualifier: ${JSON.stringify(nwProd[0].attributionQualifier)}`);

// ── 2. Find an "attributed to" artwork via search ────────────────────
console.log("\n2. search_artwork with attributionQualifier='attributed to'");
const searchResult = await client.callTool({
  name: "search_artwork",
  arguments: { attributionQualifier: "attributed to", type: "painting", maxResults: 3 }
});
const searchData = searchResult.structuredContent ?? JSON.parse(searchResult.content[0].text);
ok("search returns results", (searchData.results?.length ?? 0) > 0);
const attrObjNum = searchData.results?.[0]?.objectNumber;
console.log(`  first result: ${attrObjNum}`);

if (attrObjNum) {
  console.log(`\n3. get_artwork_details for ${attrObjNum} (should have 'attributed to')`);
  const attrDetail = await getDetail(attrObjNum);
  const attrProd = attrDetail.structured.production;
  ok("has production entries", attrProd.length > 0);

  // At least one production entry should have a rich qualifier
  const qualifiers = attrProd.map(p => p.attributionQualifier).filter(Boolean);
  console.log(`  qualifiers found: ${JSON.stringify(qualifiers)}`);
  ok("at least one qualifier present", qualifiers.length > 0);
  ok("qualifier includes 'attributed to'", qualifiers.some(q => q === "attributed to"));

  // Check text output includes qualifier
  ok("text summary includes qualifier phrasing",
    attrDetail.text.includes("attributed to") || attrDetail.text.includes("qualifier"));
}

// ── 4. Workshop of ───────────────────────────────────────────────────
console.log("\n4. search_artwork with attributionQualifier='workshop of'");
const wsResult = await client.callTool({
  name: "search_artwork",
  arguments: { attributionQualifier: "workshop of", type: "painting", maxResults: 3 }
});
const wsData = wsResult.structuredContent ?? JSON.parse(wsResult.content[0].text);
ok("workshop search returns results", (wsData.results?.length ?? 0) > 0);
const wsObjNum = wsData.results?.[0]?.objectNumber;

if (wsObjNum) {
  console.log(`\n5. get_artwork_details for ${wsObjNum} (should have 'workshop of')`);
  const wsDetail = await getDetail(wsObjNum);
  const wsProd = wsDetail.structured.production;
  const wsQualifiers = wsProd.map(p => p.attributionQualifier).filter(Boolean);
  console.log(`  qualifiers: ${JSON.stringify(wsQualifiers)}`);
  ok("at least one qualifier present", wsQualifiers.length > 0);
}

// ── 6. Schema check: attributionQualifier in all production entries ──
console.log("\n6. Schema validation");
const schemaResult = await client.callTool({ name: "get_artwork_details", arguments: { objectNumber: "SK-A-3262" } });
const schemaData = schemaResult.structuredContent ?? JSON.parse(schemaResult.content[0].text);
const allHaveField = schemaData.production.every(p => "attributionQualifier" in p);
ok("all production entries have attributionQualifier field", allHaveField);
const allNullableString = schemaData.production.every(p =>
  p.attributionQualifier === null || typeof p.attributionQualifier === "string"
);
ok("all attributionQualifier values are string|null", allNullableString);

console.log(`\n${"═".repeat(50)}`);
console.log(`  Passed: ${passed}  Failed: ${failed}`);
console.log(`${"═".repeat(50)}\n`);

await client.close();
process.exit(failed > 0 ? 1 : 0);
