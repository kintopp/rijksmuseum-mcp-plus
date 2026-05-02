#!/usr/bin/env node
/**
 * test-new-filters.mjs — verify v0.27 cluster B additions (#292):
 *   theme · sourceType · modifiedAfter / modifiedBefore filters on search_artwork,
 *   plus theme + sourceType participation in collection_stats and facets.
 *
 * (Pre-v0.27 this file tested creatorGender / creatorBornAfter / creatorBornBefore /
 * expandPlaceHierarchy. Those filters are removed in #305 and replaced by
 * search_persons; see test-search-persons.mjs and test-removed-demographic-filters.mjs.)
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
    if (r.isError) return { _error: r.content?.[0]?.text ?? "" };
    return r.structuredContent ?? (r.content?.[0]?.text ? JSON.parse(r.content[0].text) : r);
  } catch (e) {
    return { _error: e.message };
  }
}

async function callText(name, args) {
  try {
    const r = await client.callTool({ name, arguments: args });
    if (r.isError) return { _error: r.content?.[0]?.text ?? "" };
    return { text: r.content?.[0]?.text ?? "" };
  } catch (e) {
    return { _error: e.message };
  }
}

// ── 1. theme filter ───────────────────────────────────────────────────────
console.log("1. theme filter — 'militaire geschiedenis'");
let r = await call("search_artwork", { theme: "militaire geschiedenis", maxResults: 3 });
check("No error", !r?._error);
check("Returns ≥1 result", (r?.totalResults ?? 0) >= 1);
console.log(`   totalResults: ${r?.totalResults}`);

// ── 2. sourceType filter ──────────────────────────────────────────────────
console.log("\n2. sourceType filter — 'drawings'");
r = await call("search_artwork", { sourceType: "drawings", maxResults: 3 });
check("No error", !r?._error);
check("Returns ≥1 drawing", (r?.totalResults ?? 0) >= 1);
console.log(`   totalResults: ${r?.totalResults}`);

console.log("\n3. sourceType filter — 'paintings' total ≈ 46K (sanity bound)");
r = await call("search_artwork", { sourceType: "paintings", maxResults: 1 });
check("Returns 30K–60K paintings", (r?.totalResults ?? 0) > 30_000 && (r?.totalResults ?? 0) < 60_000);
console.log(`   totalResults: ${r?.totalResults}`);

// ── 3. modifiedAfter / modifiedBefore ─────────────────────────────────────
console.log("\n4. modifiedAfter — '2024-01-01' combined with type='painting'");
r = await call("search_artwork", { type: "painting", modifiedAfter: "2024-01-01", maxResults: 1 });
check("No error", !r?._error);
const totalRecent = r?.totalResults ?? 0;
console.log(`   totalResults: ${totalRecent}`);

console.log("\n5. modifiedBefore — '2024-01-01' combined with type='painting'");
r = await call("search_artwork", { type: "painting", modifiedBefore: "2024-01-01", maxResults: 1 });
check("No error", !r?._error);
const totalOlder = r?.totalResults ?? 0;
console.log(`   totalResults: ${totalOlder}`);

console.log("\n6. modifiedAfter alone (modifier guard — should be rejected)");
r = await call("search_artwork", { modifiedAfter: "2024-01-01" });
check("Rejected as standalone", !!r?._error || !!r?.error);
console.log(`   → ${r?._error || "rejected"}`);

// ── 4. Facets include theme + sourceType ──────────────────────────────────
console.log("\n7. Facets — theme + sourceType for type='painting'");
r = await call("search_artwork", {
  type: "painting", maxResults: 1, facets: ["theme", "sourceType"], facetLimit: 5,
});
check("No error", !r?._error);
check("theme facet present", Array.isArray(r?.facets?.theme) && r.facets.theme.length > 0);
check("sourceType facet present", Array.isArray(r?.facets?.sourceType) && r.facets.sourceType.length > 0);
if (r?.facets?.sourceType) {
  console.log("   sourceType breakdown:", r.facets.sourceType.map(f => `${f.label}:${f.count}`).join(", "));
}

// ── 5. collection_stats accepts theme + sourceType dimensions ─────────────
//   collection_stats returns formatted text only — no structuredContent.
console.log("\n8. collection_stats({dimension: 'sourceType'}) — top 6 source-types");
let rt = await callText("collection_stats", { dimension: "sourceType", topN: 6 });
check("No error", !rt?._error);
check("Contains 'designs' (largest source-type)", /designs\s+\d/.test(rt?.text ?? ""));
check("Contains 'paintings'", /paintings\s+\d/.test(rt?.text ?? ""));

console.log("\n9. collection_stats({dimension: 'theme'}) — top 5 themes");
rt = await callText("collection_stats", { dimension: "theme", topN: 5 });
check("No error", !rt?._error);
check("theme distribution header present", /theme distribution/.test(rt?.text ?? ""));
check("Contains at least one entry row (numeric count)", /\d+\s+\(\d/.test(rt?.text ?? ""));

await client.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
