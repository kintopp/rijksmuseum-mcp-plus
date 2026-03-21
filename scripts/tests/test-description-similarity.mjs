#!/usr/bin/env node
/**
 * Smoke test for find_similar description signal.
 * Verifies that the Description column is populated in the generated HTML page.
 * Requires ENABLE_FIND_SIMILAR=true.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "fs";

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

// ── Test 1: find_similar returns a comparison page with description results ──

console.log("\n--- 1: find_similar basic (SK-A-1718) ---");
const r1 = await client.callTool({
  name: "find_similar",
  arguments: { objectNumber: "SK-A-1718", maxResults: 10 },
});
assert(!r1.isError, "call succeeds");
const text1 = r1.content[0].text;
assert(text1.includes("Description:"), "text summary includes Description signal count");
assert(text1.includes("Lineage:"), "text summary includes Lineage signal count");
assert(text1.includes("Iconclass:"), "text summary includes Iconclass signal count");
assert(text1.includes("Pooled"), "text summary includes Pooled count");

// In stdio mode, the page is written to a temp file — verify it exists and has content
const lines = text1.split("\n");
const pagePath = lines[lines.length - 1].trim();
assert(pagePath.includes("rijksmuseum-similar-"), "output contains temp file path");

let html = "";
try {
  html = readFileSync(pagePath, "utf-8");
  assert(html.length > 1000, `HTML page has content (${html.length} bytes)`);
} catch {
  assert(false, `could not read HTML page at ${pagePath}`);
}

// Verify the HTML page contains a Description column
if (html) {
  assert(html.includes("Description"), "HTML page contains Description column");
}

// ── Test 2: Nonexistent artwork returns error ──

console.log("\n--- 2: Nonexistent artwork ---");
const r2 = await client.callTool({
  name: "find_similar",
  arguments: { objectNumber: "NONEXISTENT-12345" },
});
assert(r2.isError === true, "error for nonexistent artwork");

// ── Test 3: Well-known painting (Night Watch) ──

console.log("\n--- 3: Night Watch (SK-C-5) ---");
const r3 = await client.callTool({
  name: "find_similar",
  arguments: { objectNumber: "SK-C-5", maxResults: 5 },
});
if (r3.isError) {
  assert(false, `SK-C-5 should succeed: ${r3.content[0].text}`);
} else {
  const text3 = r3.content[0].text;
  assert(text3.includes("Night Watch") || text3.includes("SK-C-5"), "response references the artwork");
  assert(text3.includes("Description:"), "Night Watch has description results");
  console.log(`    ${text3.split("\n")[1]}`);
}

// ── Summary ──

console.log(`\n${"═".repeat(60)}`);
console.log(`  Passed: ${passed}  Failed: ${failed}`);
console.log(`${"═".repeat(60)}`);

await client.close();
process.exit(failed > 0 ? 1 : 0);
