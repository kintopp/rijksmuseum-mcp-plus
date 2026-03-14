/**
 * Tests for find_similar tool — validates HTML comparison page generation
 * across all signal modes (Visual, Description, Iconclass, Lineage, Pooled).
 *
 * Run: ENABLE_FIND_SIMILAR=true node scripts/tests/test-find-similar.mjs
 *
 * Requires: vocab DB, embeddings DB (with description vectors), iconclass DB.
 * Visual signal requires internet access (Rijksmuseum website API).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import assert from "node:assert/strict";
import fs from "node:fs";

let passed = 0;
let failed = 0;
function ok(condition, msg) {
  try {
    assert.ok(condition, msg);
    passed++;
    console.log(`  ✓ ${msg}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${msg}`);
    console.log(`    ${e.message}`);
  }
}

if (process.env.ENABLE_FIND_SIMILAR !== "true") {
  console.error("Set ENABLE_FIND_SIMILAR=true to run these tests.");
  process.exit(1);
}

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...process.env, ENABLE_FIND_SIMILAR: "true" },
  cwd: process.cwd(),
});
const client = new Client({ name: "test", version: "1.0" });
await client.connect(transport);

// ── Section 1: Tool registration ─────────────────────────────────
console.log("\n════════════════════════════════════════════════════════════");
console.log("  Section 1: Tool registration");
console.log("════════════════════════════════════════════════════════════");

const tools = await client.listTools();
const findSimilar = tools.tools.find(t => t.name === "find_similar");
ok(findSimilar, "find_similar tool registered");
ok(findSimilar.inputSchema.properties.objectNumber, "objectNumber param exists");
ok(findSimilar.inputSchema.properties.maxResults, "maxResults param exists");
ok(!findSimilar.inputSchema.properties.mode, "old mode param removed");

// ── Section 2: The Milkmaid — rich artwork with multiple signals ──
console.log("\n════════════════════════════════════════════════════════════");
console.log("  Section 2: The Milkmaid (SK-A-2344) — multi-signal");
console.log("════════════════════════════════════════════════════════════");

const r1 = await client.callTool({
  name: "find_similar",
  arguments: { objectNumber: "SK-A-2344", maxResults: 5 },
});
ok(!r1.isError, "no error");

const text1 = r1.content?.[0]?.text ?? "";
ok(text1.includes("SK-A-2344"), "text mentions query objectNumber");
ok(text1.includes("Milkmaid"), "text mentions artwork title");

// Extract file path from response
const pathMatch = text1.match(/\/(var|tmp)\S+\.html/);
ok(pathMatch, "response contains HTML file path");
const htmlPath1 = pathMatch?.[0];

if (htmlPath1) {
  const html1 = fs.readFileSync(htmlPath1, "utf-8");
  ok(html1.includes("<!DOCTYPE html>"), "valid HTML document");
  ok(html1.includes("The Milkmaid"), "HTML contains artwork title");
  ok(html1.includes("SK-A-2344"), "HTML contains objectNumber");

  // Header metadata
  ok(html1.includes("meta-section-label description"), "header has description section");
  ok(html1.includes("meta-section-label iconclass") || !html1.includes("Iconclass: 0"), "header has iconclass section (if codes exist)");

  // Signal rows
  ok(html1.includes("signal-row"), "HTML has signal rows");
  ok(html1.includes("cards-strip"), "HTML has horizontal card strips");

  // Description signal (should always be present for well-described artworks)
  ok(html1.includes("Description"), "has Description signal");
  ok(text1.includes("Description:"), "text summary includes Description count");

  // Iconclass codes should be linked
  if (html1.includes("iconclass.org/")) {
    ok(true, "Iconclass notations are linked to iconclass.org");
  } else {
    ok(!text1.includes("Iconclass: 0"), "Iconclass linked (or no Iconclass for this artwork)");
  }

  // Pooled row
  ok(html1.includes("Pooled"), "has Pooled row");
  ok(text1.includes("Pooled"), "text summary includes Pooled count");

  // Footer
  ok(html1.includes("rijksmuseum-mcp+"), "footer mentions rijksmuseum-mcp+");
  ok(html1.includes("github.com/kintopp/rijksmuseum-mcp-plus"), "footer links to GitHub repo");

  // Artwork thumbnails via IIIF
  ok(html1.includes("iiif.micr.io"), "uses IIIF thumbnails");

  // Cards have per-card metadata
  ok(html1.includes("card-detail"), "cards have per-card metadata");
}

// ── Section 3: Visual signal (Rijksmuseum API) ───────────────────
console.log("\n════════════════════════════════════════════════════════════");
console.log("  Section 3: Visual signal (Rijksmuseum API)");
console.log("════════════════════════════════════════════════════════════");

if (text1.includes("Visual:")) {
  ok(true, "Visual signal present in summary");
  if (htmlPath1) {
    const html1 = fs.readFileSync(htmlPath1, "utf-8");
    ok(html1.includes("Visual"), "Visual row in HTML");
    ok(html1.includes("see-all-card") || html1.includes("rijksmuseum.nl"), "has see-all link to rijksmuseum.nl");
    ok(html1.includes("visual/search"), "visual search URL in see-all link");
  }
} else {
  console.log("  (Visual signal not available — Rijksmuseum API may be unreachable)");
  ok(true, "Visual signal gracefully absent");
}

// ── Section 4: Lineage qualifiers linked to Getty AAT ────────────
console.log("\n════════════════════════════════════════════════════════════");
console.log("  Section 4: Lineage with Getty AAT links");
console.log("════════════════════════════════════════════════════════════");

// Use a print after Rembrandt — known to have lineage qualifiers
const r2 = await client.callTool({
  name: "find_similar",
  arguments: { objectNumber: "RP-P-OB-613", maxResults: 5 },
});
ok(!r2.isError, "no error for RP-P-OB-613");
const text2 = r2.content?.[0]?.text ?? "";
const pathMatch2 = text2.match(/\/(var|tmp)\S+\.html/);

if (pathMatch2) {
  const html2 = fs.readFileSync(pathMatch2[0], "utf-8");
  if (text2.includes("Lineage:") && !text2.includes("Lineage: 0")) {
    ok(html2.includes("Lineage"), "Lineage row present");
    ok(html2.includes("vocab.getty.edu/aat"), "qualifier linked to Getty AAT");
    ok(html2.includes("qualifier"), "qualifier badge present");
  } else {
    ok(true, "No lineage results (artwork has primary attribution only)");
  }
}

// ── Section 5: Artwork with no image ─────────────────────────────
console.log("\n════════════════════════════════════════════════════════════");
console.log("  Section 5: Artwork without image");
console.log("════════════════════════════════════════════════════════════");

const r3 = await client.callTool({
  name: "find_similar",
  arguments: { objectNumber: "RP-P-1943-126", maxResults: 3 },
});
ok(!r3.isError, "no error for no-image artwork");
const text3 = r3.content?.[0]?.text ?? "";
const pathMatch3 = text3.match(/\/(var|tmp)\S+\.html/);

if (pathMatch3) {
  const html3 = fs.readFileSync(pathMatch3[0], "utf-8");
  ok(html3.includes("No image"), "shows no-image placeholder in header");
  // Should still have results from at least description signal
  ok(html3.includes("signal-row"), "has signal rows despite no image");
}

// ── Section 6: Nonexistent artwork ───────────────────────────────
console.log("\n════════════════════════════════════════════════════════════");
console.log("  Section 6: Nonexistent artwork");
console.log("════════════════════════════════════════════════════════════");

const r4 = await client.callTool({
  name: "find_similar",
  arguments: { objectNumber: "NONEXISTENT-999" },
});
ok(r4.isError, "returns error for nonexistent artwork");
ok(r4.content?.[0]?.text?.includes("not found"), "error message mentions not found");

// ── Section 7: maxResults respected ──────────────────────────────
console.log("\n════════════════════════════════════════════════════════════");
console.log("  Section 7: maxResults constraint");
console.log("════════════════════════════════════════════════════════════");

const r5 = await client.callTool({
  name: "find_similar",
  arguments: { objectNumber: "SK-A-1718", maxResults: 3 },
});
ok(!r5.isError, "no error for SK-A-1718");
const text5 = r5.content?.[0]?.text ?? "";
// Check that no signal exceeds maxResults
const countMatches = text5.matchAll(/(?:Visual|Description|Iconclass|Lineage): (\d+)/g);
for (const m of countMatches) {
  const count = parseInt(m[1]);
  ok(count <= 3, `${m[0]} respects maxResults (${count} ≤ 3)`);
}

// ── Section 8: HTML layout structure ─────────────────────────────
console.log("\n════════════════════════════════════════════════════════════");
console.log("  Section 8: HTML layout structure");
console.log("════════════════════════════════════════════════════════════");

const pathMatch5 = text5.match(/\/(var|tmp)\S+\.html/);
if (pathMatch5) {
  const html5 = fs.readFileSync(pathMatch5[0], "utf-8");
  ok(html5.includes("signal-rows"), "uses signal-rows container");
  ok(html5.includes("strip-container"), "uses strip-container for scroll");
  ok(!html5.includes("columns-grid"), "old columns-grid layout removed");
  ok(html5.includes("query-header"), "has query header");
  ok(html5.includes("query-metadata"), "has query metadata section");

  // Row order: Visual (if present) should appear before Description in HTML
  const visualPos = html5.indexOf('"Visual"') > -1 ? html5.indexOf('"Visual"') : Infinity;
  const descPos = html5.indexOf('"Description"');
  const iconPos = html5.indexOf('"Iconclass"');
  const linePos = html5.indexOf('"Lineage"');
  const poolPos = html5.indexOf('"Pooled"');

  if (descPos > -1) {
    ok(descPos < iconPos || iconPos === -1, "Description before Iconclass");
    ok(descPos < poolPos, "Description before Pooled");
  }
  if (iconPos > -1 && linePos > -1) {
    ok(iconPos < linePos, "Iconclass before Lineage");
  }
  if (poolPos > -1) {
    ok(poolPos > descPos, "Pooled is last");
  }
}

// ── Summary ──────────────────────────────────────────────────────
console.log("\n════════════════════════════════════════════════════════════");
console.log(`  Passed: ${passed}  Failed: ${failed}`);
console.log("════════════════════════════════════════════════════════════");

await client.close();
process.exit(failed > 0 ? 1 : 0);
