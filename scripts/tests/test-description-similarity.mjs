#!/usr/bin/env node
/**
 * Smoke test for find_similar(mode="description").
 * Requires ENABLE_FIND_SIMILAR=true.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...process.env, ENABLE_FIND_SIMILAR: "true" },
});

const client = new Client({ name: "test-desc", version: "1.0" });
await client.connect(transport);

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

// ── Test 1: Description mode returns results with descriptions ──

console.log("\n--- 1: Description mode basic ---");
const r1 = await client.callTool({
  name: "find_similar",
  arguments: { objectNumber: "SK-A-1718", mode: "description", maxResults: 10 },
});
const d1 = r1.structuredContent ?? JSON.parse(r1.content[0].text);
assert(d1.mode === "description", "mode is 'description'");
assert(d1.queryObjectNumber === "SK-A-1718", "query object number correct");
assert(d1.queryTitle?.length > 0, "query title present");
assert(d1.queryDescription?.length > 0, "query description present");
assert(d1.rerankerNote?.includes("RE-RANKING"), "reranker note present");
assert(d1.returnedCount > 10, "over-fetches (3x) for re-ranking");
assert(d1.results.length > 0, "has results");

const first = d1.results[0];
assert(first.objectNumber?.length > 0, "result has objectNumber");
assert(typeof first.title === "string", "result has title field");
assert(first.score > 0 && first.score <= 1, "score is cosine similarity (0-1)");
assert(first.descriptionExcerpt?.length > 0, "result has descriptionExcerpt");
assert(first.url?.includes("rijksmuseum.nl"), "result has collection URL");

// Text channel should include descriptions
const text1 = r1.content[0].text;
assert(text1.includes("DESC:"), "text channel includes description excerpts");
assert(text1.includes("RE-RANKING"), "text channel includes reranker note");

// ── Test 2: Artwork without description ──

console.log("\n--- 2: Artwork with no description ---");
// Find an artwork likely without a description — use a very obscure object number
const r2 = await client.callTool({
  name: "find_similar",
  arguments: { objectNumber: "NONEXISTENT-12345", mode: "description" },
});
assert(r2.isError === true, "error for nonexistent artwork");

// ── Test 3: Results are sorted by similarity ──

console.log("\n--- 3: Results sorted by similarity ---");
if (d1.results.length >= 2) {
  const scores = d1.results.map(r => r.score);
  const sorted = [...scores].sort((a, b) => b - a);
  assert(JSON.stringify(scores) === JSON.stringify(sorted), "results sorted by descending similarity");
}

// ── Test 4: Description mode with a painting ──

console.log("\n--- 4: Description mode with a well-known painting ---");
const r4 = await client.callTool({
  name: "find_similar",
  arguments: { objectNumber: "SK-C-5", mode: "description", maxResults: 5 },
});
if (r4.isError) {
  assert(false, `SK-C-5 (Night Watch) should have a description: ${r4.content[0].text}`);
} else {
  const d4 = r4.structuredContent ?? JSON.parse(r4.content[0].text);
  assert(d4.results.length > 0, "Night Watch has description-similar results");
  assert(d4.queryDescription?.length > 0, "Night Watch description present");
  console.log(`    Query: "${d4.queryDescription?.slice(0, 80)}…"`);
  console.log(`    Top result: ${d4.results[0]?.objectNumber} (${d4.results[0]?.score}) — "${d4.results[0]?.title}"`);
}

// ── Summary ──

console.log(`\n${"═".repeat(60)}`);
console.log(`  Passed: ${passed}  Failed: ${failed}`);
console.log(`${"═".repeat(60)}`);

await client.close();
process.exit(failed > 0 ? 1 : 0);
