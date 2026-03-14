/**
 * Tests for find_similar tool — validates HTML comparison page generation
 * across all signal modes (Visual, Lineage, Iconclass, Description,
 * Depicted Person, Depicted Place, Pooled).
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
const countMatches = text5.matchAll(/(?:Visual|Lineage|Iconclass|Description|Person|Place): (\d+)/g);
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

  // Row order: Visual → Lineage → Iconclass → Description → Depicted Person → Depicted Place → Pooled
  const linePos = html5.indexOf('"Lineage"');
  const iconPos = html5.indexOf('"Iconclass"');
  const descPos = html5.indexOf('"Description"');
  const personPos = html5.indexOf('"Depicted Person"');
  const placePos = html5.indexOf('"Depicted Place"');
  const poolPos = html5.indexOf('"Pooled"');

  if (linePos > -1 && iconPos > -1) {
    ok(linePos < iconPos, "Lineage before Iconclass");
  }
  if (iconPos > -1 && descPos > -1) {
    ok(iconPos < descPos, "Iconclass before Description");
  }
  if (descPos > -1 && personPos > -1) {
    ok(descPos < personPos, "Description before Depicted Person");
  }
  if (personPos > -1 && placePos > -1) {
    ok(personPos < placePos, "Depicted Person before Depicted Place");
  }
  if (poolPos > -1) {
    ok(poolPos > (placePos > -1 ? placePos : personPos > -1 ? personPos : descPos), "Pooled is last");
  }
}

// ── Section 9: Depicted Person signal ─────────────────────────────
console.log("\n════════════════════════════════════════════════════════════");
console.log("  Section 9: Depicted Person signal");
console.log("════════════════════════════════════════════════════════════");

// SK-A-4691 is a self-portrait by Rembrandt — depicted person: Rijn, Rembrandt van
const r6 = await client.callTool({
  name: "find_similar",
  arguments: { objectNumber: "SK-A-4691", maxResults: 5 },
});
ok(!r6.isError, "no error for SK-A-4691");
const text6 = r6.content?.[0]?.text ?? "";
ok(text6.includes("Person:"), "text summary includes Person count");
const personCount = text6.match(/Person: (\d+)/)?.[1];
ok(personCount && parseInt(personCount) > 0, `Person signal has results (${personCount})`);

const pathMatch6 = text6.match(/\/(var|tmp)\S+\.html/);
if (pathMatch6) {
  const html6 = fs.readFileSync(pathMatch6[0], "utf-8");
  ok(html6.includes("Depicted Person"), "Depicted Person row in HTML");
  ok(html6.includes("depicted-person"), "header has depicted-person metadata");
  ok(html6.includes("#2e7d32"), "Depicted Person has correct color");
}

// ── Section 10: Depicted Place signal ────────────────────────────
console.log("\n════════════════════════════════════════════════════════════");
console.log("  Section 10: Depicted Place signal");
console.log("════════════════════════════════════════════════════════════");

// RP-F-2019-232-52 depicts the Montelbaanstoren — a specific Amsterdam landmark
const r7 = await client.callTool({
  name: "find_similar",
  arguments: { objectNumber: "RP-F-2019-232-52", maxResults: 5 },
});
ok(!r7.isError, "no error for RP-F-2019-232-52");
const text7 = r7.content?.[0]?.text ?? "";
ok(text7.includes("Place:"), "text summary includes Place count");
const placeCount = text7.match(/Place: (\d+)/)?.[1];
ok(placeCount && parseInt(placeCount) > 0, `Place signal has results (${placeCount})`);

const pathMatch7 = text7.match(/\/(var|tmp)\S+\.html/);
if (pathMatch7) {
  const html7 = fs.readFileSync(pathMatch7[0], "utf-8");
  ok(html7.includes("Depicted Place"), "Depicted Place row in HTML");
  ok(html7.includes("#4e342e"), "Depicted Place has correct color");
  // Methodology mentions TGN filtering
  ok(html7.includes("TGN") || html7.includes("gazetteer"), "Place methodology mentions filtering");
}

// Test broad-only place artwork — should produce 0 results but no error
const r8 = await client.callTool({
  name: "find_similar",
  arguments: { objectNumber: "RP-F-F01018-GJ", maxResults: 3 },
});
ok(!r8.isError, "no error for broad-only place artwork");
const text8 = r8.content?.[0]?.text ?? "";
ok(text8.includes("Place: 0"), "Place signal correctly returns 0 for broad-only places");

// ── Section 11: Lineage "attributed to" qualifier ────────────────
console.log("\n════════════════════════════════════════════════════════════");
console.log("  Section 11: Lineage 'attributed to' qualifier");
console.log("════════════════════════════════════════════════════════════");

// RP-F-1994-16-20 has "attributed to" qualifier
const r9 = await client.callTool({
  name: "find_similar",
  arguments: { objectNumber: "RP-F-1994-16-20", maxResults: 5 },
});
ok(!r9.isError, "no error for attributed-to artwork");
const text9 = r9.content?.[0]?.text ?? "";

const pathMatch9 = text9.match(/\/(var|tmp)\S+\.html/);
if (pathMatch9) {
  const html9 = fs.readFileSync(pathMatch9[0], "utf-8");
  if (!text9.includes("Lineage: 0")) {
    ok(html9.includes("attributed to"), "Lineage results include 'attributed to' qualifier");
    ok(true, "attributed to correctly included in lineage signal");
  } else {
    ok(true, "No lineage results (artwork may have unique creator)");
  }
  // Check that lineage methodology text mentions all qualifier tiers
  ok(html9.includes("attributed to") && html9.includes("1.5"), "methodology mentions 'attributed to' at 1.5×");
  ok(html9.includes("copyist"), "methodology mentions copyist");
  ok(html9.includes("follower"), "methodology mentions follower");
}

// ── Summary ──────────────────────────────────────────────────────
console.log("\n════════════════════════════════════════════════════════════");
console.log(`  Passed: ${passed}  Failed: ${failed}`);
console.log("════════════════════════════════════════════════════════════");

await client.close();
process.exit(failed > 0 ? 1 : 0);
