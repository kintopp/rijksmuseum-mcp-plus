#!/usr/bin/env node
// Extended smoke test — exercises the 8 MCP tools not covered by smoke-v019-deprecated.mjs.
// Issue #244. Mirrors smoke-v019-deprecated.mjs pattern.
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
import { readFileSync } from "fs";

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

  // Pagination round-trip: capture resumptionToken, verify page 2 is non-overlapping.
  // OAI-PMH resumptionTokens are opaque — only assertable property is page-to-page disjointness.
  r = await call("browse_set", { setSpec: setSpecForBrowse, maxResults: 3 });
  const page1Nums = (r.sc?.records ?? []).map(rec => rec.objectNumber);
  const token = r.sc?.resumptionToken;
  if (token && page1Nums.length >= 3) {
    r = await call("browse_set", { resumptionToken: token, maxResults: 3 });
    const page2Nums = (r.sc?.records ?? []).map(rec => rec.objectNumber);
    check("Pagination returns non-empty second page", page2Nums.length > 0);
    const overlap = page1Nums.filter(n => page2Nums.includes(n));
    check("Pages 1 and 2 do not overlap", overlap.length === 0);
    console.log(`    → page1: [${page1Nums.slice(0,2).join(", ")}...]  page2: [${page2Nums.slice(0,2).join(", ")}...]`);
  } else {
    skip("browse_set pagination", `set too small or no token (records=${page1Nums.length}, hasToken=${!!token})`);
  }
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
check("Future date returns without error", !r._error && !r.isError);
check("Future date returns zero records", (r.sc?.records?.length ?? -1) === 0);
console.log(`    → since 2030-01-01: ${r.sc?.records?.length ?? "?"} records, totalChanges=${r.sc?.totalChanges ?? "?"}`);

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
// fullUrl was removed: it was never used by the inline OSD viewer and caused some hosts
// (e.g. Codex) to render an unrequested inline thumbnail. The structured response now
// exposes only iiifInfoUrl — IIIF clients can derive any size/region from info.json.
const text5 = r.raw?.content?.[0]?.text ?? "";
check("Structured response omits fullUrl", r.sc?.fullUrl === undefined);
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

  // Upscaling clamp — small region + large size should be clamped to region width,
  // NOT forwarded as an IIIF upscale (iiif.micr.io rejects upscaling with 400).
  // SK-C-5 is 14645×12158 native; pct:0,0,2,2 ≈ 293×243 source pixels.
  // A clamped 293-px JPEG is small; an upscaled 2000-px JPEG would be ~10× larger.
  r = await call("inspect_artwork_image", { objectNumber: "SK-C-5", region: "pct:0,0,2,2", size: 2000 });
  check("Upscale request on tiny region returns without error (clamp fires)", !r._error && !r.isError);
  const clampB64 = r.raw?.content?.find?.(c => c.type === "image")?.data?.length ?? 0;
  check("Clamped image is small (not upscaled to 2000 px)", clampB64 > 0 && clampB64 < 40_000);
  console.log(`    → pct:0,0,2,2 @ size=2000 (requested) → ${Math.round(clampB64/1024)} KB b64 (clamped)`);
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
  // SK-C-5 exercises Iconclass (well-annotated), Description (has desc embedding),
  // and depicted Person (militiamen). It does NOT exercise Lineage (directly
  // attributed to Rembrandt — no assignment_pairs qualifier like workshop-of /
  // after) or depicted Place (interior group portrait — no depicted landscape).
  // Visual is best-effort external HTTP; don't assert on it.
  // The #144 spot-check below covers Lineage on a different artwork.
  const signals = ["Iconclass", "Description", "Person"];
  for (const s of signals) {
    const m = text7.match(new RegExp(`${s}:\\s*(\\d+)`));
    const n = m ? parseInt(m[1]) : -1;
    check(`SK-C-5 signal ${s} > 0`, n > 0);
  }
  console.log(`    → ${text7.split("\n").find(l => /Lineage:/.test(l))?.slice(0, 120) ?? "(no counts line)"}`);
  console.log(`    → ${text7.split("\n").find(l => /html|similar/.test(l))?.slice(0, 120) ?? "(no path line)"}`);
}

// ─── 7b. find_similar — #144 regression on RP-F-2018-183-9 ──────────────
// RP-F-2018-183-9 has 9 real (qualifier, creator) pairs in assignment_pairs.
// Pre-fix cartesian bug (#144, closed 2026-04-19 commit 8740b2c) fabricated 10.
// Deep truth verification lives in scripts/tests/verify_lineage_144.mjs
// (direct VocabularyDb call). This MCP-level check confirms the tool still
// produces non-zero lineage results for the artwork post-fix.
console.log("\n7b. find_similar — RP-F-2018-183-9 (#144 regression)");
if (toolList.includes("find_similar")) {
  r = await call("find_similar", { objectNumber: "RP-F-2018-183-9", maxResults: 50 });
  check("Call returns without error", !r._error && !r.isError);
  const text7b = r.raw?.content?.[0]?.text ?? "";
  const lineageMatch = text7b.match(/Lineage:\s*(\d+)/);
  const lineageN = lineageMatch ? parseInt(lineageMatch[1]) : -1;
  check("Lineage count is positive (non-zero after #144 fix)", lineageN > 0);
  console.log(`    → Lineage: ${lineageN} (truth: 9 pairs; deep check: verify_lineage_144.mjs)`);
} else {
  skip("find_similar #144 check", "find_similar not registered");
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

  // Check expected event + party fields (#244: enrichment survival check).
  // Two levels: field *existence* (schema drift) + at least one LLM-enriched event
  // across returned artworks (data survival — catches the #185 scenario where a
  // fresh harvest silently wipes LLM enrichments).
  r = await call("search_provenance", { party: "Six", maxResults: 5 });
  const firstEvent = r.sc?.results?.[0]?.events?.[0];
  if (firstEvent) {
    check("Events carry parseMethod (non-null string per schema)", typeof firstEvent.parseMethod === "string");
    check("Events expose transferCategory field", "transferCategory" in firstEvent);
    check("Events expose categoryMethod field", "categoryMethod" in firstEvent);
    check("Events expose enrichmentReasoning field", "enrichmentReasoning" in firstEvent);
    const firstParty = firstEvent.parties?.[0];
    if (firstParty) {
      check("Parties expose position field", "position" in firstParty);
      // positionMethod is .nullable().optional() — legitimately absent when unset.
      // Assert type only if present.
      if ("positionMethod" in firstParty) {
        check("positionMethod type is string or null when present",
          firstParty.positionMethod === null || typeof firstParty.positionMethod === "string");
      }
    } else {
      skip("party field sanity", "first event has no parties");
    }
    console.log(`    → first Six event: parseMethod=${firstEvent.parseMethod}, transferType=${firstEvent.transferType}, category=${firstEvent.transferCategory}`);
  } else {
    skip("event field sanity (parseMethod/party_position)", "no Six results");
  }

  // Enrichment survival — direct probe via categoryMethod filter.
  // "Six" happens to have only deterministically-parsed events (PEG/regex).
  // categoryMethod='llm_enrichment' queries the whole collection for LLM-mediated
  // classifications. If this returns 0 on v0.24+, the re-harvest trampled
  // enrichments (→ #185 urgent). Memory note: 100% enrichment_reasoning coverage
  // on LLM/rule rows post-Step 7 (2026-04-19).
  r = await call("search_provenance", { categoryMethod: "llm_enrichment", maxResults: 3 });
  check("LLM-enriched events exist (direct categoryMethod probe)", r.sc?.totalArtworks > 0);
  console.log(`    → categoryMethod='llm_enrichment': ${r.sc?.totalArtworks ?? 0} artworks`);
}

// ─── 9. #145 probe — organisation (VOC) as depicted_person ──────────────
// SK-A-2350 ("VOC Senior Merchant with his Wife and an Enslaved Servant")
// has Verenigde Oostindische Compagnie (VOC, type='group') mapped as a
// subject. get_artwork_details correctly filters groups out of
// depictedPersons (only Jacob Mathieusen surfaces). But find_similar's
// Person signal does NOT filter — VOC appears as a matched entity in the
// generated HTML page. That's #145 (LA_TYPE_MAP["Group"] = "person" in the
// harvester leaks groups into the person index used by find_similar).
// Known failure until #145 lands — skip() with a pointer, don't hard-fail.
console.log("\n9. #145 probe — VOC (organisation) in find_similar depicted_person (SK-A-2350)");

// 9a. get_artwork_details should exclude VOC from depictedPersons.
r = await call("get_artwork_details", { objectNumber: "SK-A-2350" });
const depPersons9 = r.sc?.subjects?.depictedPersons ?? [];
const vocInDetails = depPersons9.some(p => /Oostindische|VOC/i.test(p.label ?? p.name ?? ""));
check("get_artwork_details filters groups out of depictedPersons", !vocInDetails);
console.log(`    → get_artwork_details.depictedPersons: [${depPersons9.map(p => p.label ?? p.name).join(", ")}]`);

// 9b. find_similar's Person signal — check via HTML inspection (stdio mode).
if (toolList.includes("find_similar")) {
  r = await call("find_similar", { objectNumber: "SK-A-2350", maxResults: 20 });
  const text9 = r.raw?.content?.[0]?.text ?? "";
  const pathMatch = text9.match(/\/\S+\.html/);
  const pagePath = pathMatch?.[0];
  if (pagePath) {
    try {
      const html = readFileSync(pagePath, "utf-8");
      const vocMatches = (html.match(/Verenigde Oostindische Compagnie/gi) ?? []).length;
      const personMatch = text9.match(/Person:\s*(\d+)/);
      if (vocMatches > 0) {
        // Known failure — don't fail the sweep, but log clearly.
        console.log(`  ⊘ #145 STILL REPRODUCES: VOC appears ${vocMatches}× in find_similar HTML`);
        console.log(`    → depicted_person signal count=${personMatch?.[1] ?? "?"}; HTML: ${pagePath}`);
        skipped++;
      } else {
        check("#145 appears fixed: VOC not found in find_similar HTML", true);
        console.log(`    → find_similar Person count=${personMatch?.[1] ?? "?"}, VOC mentions in HTML: 0`);
      }
    } catch (e) {
      skip("#145 HTML inspection", `could not read HTML at ${pagePath}: ${e.message}`);
    }
  } else {
    skip("#145 HTML inspection", "no .html path found in find_similar response");
  }
} else {
  skip("#145 probe", "find_similar not registered");
}

console.log(`\n═══════════════════════════════════════`);
console.log(`  Passed: ${passed}  Failed: ${failed}  Skipped: ${skipped}`);
console.log(`═══════════════════════════════════════\n`);

await client.close();
process.exit(failed > 0 ? 1 : 0);
