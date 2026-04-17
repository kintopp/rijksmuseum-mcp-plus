#!/usr/bin/env node
// Extended smoke test — exercises the 8 MCP tools not covered by smoke-v019.mjs.
// Issue #244. Mirrors smoke-v019.mjs pattern.
//
// Tools covered: search_provenance, find_similar, list_curated_sets, browse_set,
//                get_recent_changes, collection_stats, get_artwork_image, inspect_artwork_image.
//
// Requires a v0.24+ vocabulary DB at data/vocabulary.db and a built server at dist/index.js.
// Network needed for inspect_artwork_image (iiif.micr.io). Set SKIP_NETWORK=1 to skip it.
//
// Intended use: run once pre-swap (baseline) and once post-swap (regression). Diff the output.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  cwd: process.cwd(),
  env: { ...process.env, STRUCTURED_CONTENT: "true", ENABLE_FIND_SIMILAR: "true" },
});

const client = new Client({ name: "smoke-v024-extended", version: "1.0" });
await client.connect(transport);
console.log("Connected\n");

let passed = 0, failed = 0, skipped = 0;
function check(label, cond) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.log(`  ✗ ${label}`); failed++; }
}
function skip(label, reason) {
  console.log(`  ⊘ ${label} (${reason})`);
  skipped++;
}

async function call(name, args) {
  try {
    const r = await client.callTool({ name, arguments: args });
    const sc = r.structuredContent ?? (r.content?.[0]?.text ? tryJson(r.content[0].text) : null);
    return { sc, raw: r, isError: r.isError === true };
  } catch (e) {
    return { _error: e.message };
  }
}
function tryJson(s) { try { return JSON.parse(s); } catch { return null; } }

// Pre-fetch tool list so we can skip conditionally-registered tools gracefully
const toolList = (await client.listTools()).tools.map(t => t.name);
console.log(`Registered tools: ${toolList.length}`);
console.log(`  ${toolList.join(", ")}\n`);

// ─── 1. list_curated_sets ────────────────────────────────────────────────
console.log("1. list_curated_sets");
let r = await call("list_curated_sets", {});
check("Returns sets", r.sc?.totalSets > 0);
check("Each set has setSpec + name", r.sc?.sets?.every(s => s.setSpec && s.name));
const setSample = r.sc?.sets?.[0];
if (setSample) console.log(`    → ${r.sc.totalSets} sets; first: ${setSample.setSpec} "${setSample.name?.slice(0,50)}"`);

r = await call("list_curated_sets", { query: "painting" });
check("Filter query narrows result", r.sc?.totalSets > 0 && r.sc?.totalSets < 5000);
check("Filter preserves filteredFrom field", r.sc?.filteredFrom > r.sc?.totalSets);
console.log(`    → query='painting': ${r.sc?.totalSets}/${r.sc?.filteredFrom} sets`);

// Capture one working setSpec for the next test
const setSpecForBrowse = r.sc?.sets?.[0]?.setSpec ?? setSample?.setSpec;

// ─── 2. browse_set ───────────────────────────────────────────────────────
console.log("\n2. browse_set");
if (setSpecForBrowse) {
  r = await call("browse_set", { setSpec: setSpecForBrowse, maxResults: 5 });
  check("Returns records", (r.sc?.records?.length ?? 0) > 0);
  check("Records have objectNumber", r.sc?.records?.every(rec => rec.objectNumber));
  check("Has totalInSet", typeof r.sc?.totalInSet === "number");
  console.log(`    → set=${setSpecForBrowse}: ${r.sc?.records?.length}/${r.sc?.totalInSet} records`);

  // Missing args: should return structured error
  r = await call("browse_set", {});
  check("Empty args returns structured error", r.isError === true || r.sc?.error);
} else {
  skip("browse_set", "no setSpec available from list_curated_sets");
}

// ─── 3. get_recent_changes ───────────────────────────────────────────────
console.log("\n3. get_recent_changes");
r = await call("get_recent_changes", { from: "2020-01-01", maxResults: 5 });
check("Returns without error", !r._error && !r.isError);
check("Has totalChanges", typeof r.sc?.totalChanges === "number");
console.log(`    → since 2020-01-01: ${r.sc?.totalChanges ?? "?"} changes, ${r.sc?.records?.length ?? 0} shown`);

// Wide future window should return 0 cleanly
r = await call("get_recent_changes", { from: "2030-01-01", maxResults: 5 });
check("Future date returns 0 without error", !r._error && !r.isError);
console.log(`    → since 2030-01-01: ${r.sc?.totalChanges ?? "?"} changes (expected 0)`);

// identifiersOnly path
r = await call("get_recent_changes", { from: "2020-01-01", identifiersOnly: true, maxResults: 5 });
check("identifiersOnly returns without error", !r._error && !r.isError);

// ─── 4. collection_stats ─────────────────────────────────────────────────
console.log("\n4. collection_stats");
r = await call("collection_stats", { dimension: "type", topN: 5 });
// Text-only output by design — content[0].text carries the table
const text4 = r.raw?.content?.[0]?.text ?? "";
check("Returns text output", text4.length > 0);
check("Text mentions 'type distribution'", /type distribution/.test(text4));
check("Text mentions 'Total artworks'", /Total artworks:/.test(text4));
console.log(`    → ${text4.split("\n")[1] ?? "(no second line)"}`);

r = await call("collection_stats", { dimension: "material", type: "painting", topN: 5 });
const text4b = r.raw?.content?.[0]?.text ?? "";
check("Filter=type=painting: returns text", text4b.length > 0);
check("Text notes the filter", /type=painting/.test(text4b));

r = await call("collection_stats", { dimension: "creator", topN: 3 });
const text4c = r.raw?.content?.[0]?.text ?? "";
check("dimension=creator returns text", text4c.length > 0);

// ─── 5. get_artwork_image ────────────────────────────────────────────────
console.log("\n5. get_artwork_image");
r = await call("get_artwork_image", { objectNumber: "SK-C-5" });
check("Known artwork returns iiifInfoUrl", !!r.sc?.iiifInfoUrl);
check("Known artwork returns viewUUID", !!r.sc?.viewUUID);
check("Known artwork returns viewerUrl or fullUrl", !!(r.sc?.viewerUrl || r.sc?.fullUrl));
// Per memory note: fullUrl must NOT appear in the text channel (avoids claude.ai auto-thumbnail).
const text5 = r.raw?.content?.[0]?.text ?? "";
check("Text channel does not include fullUrl", !/fullUrl/i.test(text5));
const capturedViewUUID = r.sc?.viewUUID;
console.log(`    → SK-C-5 iiifInfoUrl: ${r.sc?.iiifInfoUrl?.slice(0,60)}, viewUUID: ${capturedViewUUID?.slice(0,8)}…`);

// Artwork without iiif_id — should return a structured "no image" error, not crash
r = await call("get_artwork_image", { objectNumber: "KOG-MP-1-1620B" });
check("No-image artwork returns structured error", r.isError === true || !!r.sc?.error);
console.log(`    → KOG-MP-1-1620B (no iiif_id): error='${(r.sc?.error ?? "").slice(0,80)}'`);

// ─── 6. inspect_artwork_image ────────────────────────────────────────────
console.log("\n6. inspect_artwork_image");
if (process.env.SKIP_NETWORK === "1") {
  skip("inspect_artwork_image", "SKIP_NETWORK=1");
} else {
  r = await call("inspect_artwork_image", { objectNumber: "SK-C-5", region: "full", size: 800 });
  check("region=full returns without error", !r._error && !r.isError);
  // Response should include base64 image in content (type: "image")
  const hasImage = r.raw?.content?.some?.(c => c.type === "image" && typeof c.data === "string");
  check("Response contains image bytes", hasImage);
  check("structuredContent reports native dimensions", r.sc?.nativeWidth > 0 && r.sc?.nativeHeight > 0);
  const b64kb = Math.round((r.raw?.content?.find?.(c=>c.type==="image")?.data?.length ?? 0)/1024);
  console.log(`    → full @ 800px: native ${r.sc?.nativeWidth}×${r.sc?.nativeHeight}, ~${b64kb} KB b64`);

  r = await call("inspect_artwork_image", { objectNumber: "SK-C-5", region: "pct:0,0,10,10", size: 400 });
  check("pct-crop region returns without error", !r._error && !r.isError);

  // Upscaling clamp — request an absurdly large size; server should clamp, not 400
  r = await call("inspect_artwork_image", { objectNumber: "SK-C-5", region: "full", size: 2000 });
  check("Large size returns without error (clamp fires)", !r._error && !r.isError);
  console.log(`    → requested 2000px, native width: ${r.sc?.nativeWidth ?? "?"}`);
}

// ─── 7. find_similar ─────────────────────────────────────────────────────
console.log("\n7. find_similar");
if (!toolList.includes("find_similar")) {
  skip("find_similar", "tool not registered (ENABLE_FIND_SIMILAR=false?)");
} else {
  r = await call("find_similar", { objectNumber: "SK-C-5", maxResults: 5 });
  check("Call returns without error", !r._error && !r.isError);
  // In stdio mode the response text carries a tmp file path
  const text7 = r.raw?.content?.[0]?.text ?? "";
  check("Response mentions an html path or /similar/ URL",
        /\.html/.test(text7) || /\/similar\//.test(text7));
  console.log(`    → ${text7.split("\n").find(l => /html|similar/.test(l))?.slice(0, 120) ?? "(no path line)"}`);
}

// ─── 8. search_provenance ────────────────────────────────────────────────
console.log("\n8. search_provenance");
if (!toolList.includes("search_provenance")) {
  skip("search_provenance", "tool not registered (no provenance_events table — run POST-REPARSE-STEPS to populate)");
} else {
  r = await call("search_provenance", { party: "Cornelis Ploos van Amstel", maxResults: 3 });
  check("Party query returns without error", !r._error && !r.isError);
  check("Response has totalArtworks", typeof r.sc?.totalArtworks === "number");
  console.log(`    → party='Cornelis Ploos van Amstel': ${r.sc?.totalArtworks} artworks`);

  r = await call("search_provenance", { dateFrom: 1930, dateTo: 1945, transferType: "confiscation", maxResults: 3 });
  check("Date+transferType filter returns without error", !r._error && !r.isError);
  console.log(`    → 1930–1945 confiscations: ${r.sc?.totalArtworks ?? "?"} artworks`);

  // No-filter call should return a structured error (tool requires ≥1 filter)
  r = await call("search_provenance", {});
  check("No-filter call returns structured error", r.isError === true || !!r.sc?.error);

  // Check that expected event fields are present on results (enrichment restoration sanity)
  r = await call("search_provenance", { party: "Six", maxResults: 2 });
  const firstEvent = r.sc?.results?.[0]?.events?.[0];
  if (firstEvent) {
    check("Events carry parseMethod", typeof firstEvent.parseMethod === "string" || firstEvent.parseMethod === null);
    console.log(`    → first Six event: parseMethod=${firstEvent.parseMethod}, transferType=${firstEvent.transferType}`);
  } else {
    skip("event field sanity (parseMethod/party_position)", "no Six results");
  }
}

console.log(`\n═══════════════════════════════════════`);
console.log(`  Passed: ${passed}  Failed: ${failed}  Skipped: ${skipped}`);
console.log(`═══════════════════════════════════════\n`);

await client.close();
process.exit(failed > 0 ? 1 : 0);
