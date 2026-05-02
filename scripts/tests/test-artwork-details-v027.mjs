/**
 * v0.27 cluster A — get_artwork_details smoke test.
 *
 * Exercises the new fields landed in this cluster (#290 / #291 / #300 / #301)
 * against the local v0.26 DB:
 *   - new top-level fields: dateDisplay, extentText, recordCreated, recordModified,
 *     themes[], themesTotalCount, exhibitions[], exhibitionsTotalCount,
 *     attributionEvidence[], externalIds.{handle, other}, location (room struct)
 *   - extended dimensions[] union (height/width/depth/weight/diameter)
 *   - confirms removal: no personInfo.bio, no examinations, no conservationHistory
 *
 * Three fixtures:
 *   - SK-A-4969  (Portret van Jan Valckenburgh, 2026 hanging) — themes + exhibitions
 *                + attributionEvidence + externalIds.handle + on-display location
 *   - KOG-MP-2-2061-2 — small object with depth_cm dimension
 *   - SK-A-3953  (Portret van Ambrogio Spinola) — themes/exhibitions populated
 *                but current_location IS NULL → location: null
 *
 * Run:  node scripts/tests/test-artwork-details-v027.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

let passed = 0, failed = 0;
const fails = [];
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else      { failed++; fails.push(msg); console.log(`  ✗ ${msg}`); }
}
function section(name) {
  console.log(`\n${"═".repeat(60)}\n  ${name}\n${"═".repeat(60)}`);
}
function unwrap(r) {
  return r.structuredContent ?? JSON.parse(r.content[0].text);
}

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  cwd: PROJECT_DIR,
  env: { ...process.env, STRUCTURED_CONTENT: "true" },
});

const client = new Client({ name: "test-artwork-details-v027", version: "0.1" });
await client.connect(transport);
console.log("Connected to server via stdio");

// ══════════════════════════════════════════════════════════════════
section("1. SK-A-4969 — full v0.27 surface populated");
// ══════════════════════════════════════════════════════════════════

const r1 = await client.callTool({
  name: "get_artwork_details",
  arguments: { objectNumber: "SK-A-4969" },
});
const d1 = unwrap(r1);

assert(d1.objectNumber === "SK-A-4969", "objectNumber returned");

// Group D top-level fields
assert(typeof d1.dateDisplay === "string" && d1.dateDisplay.length > 0, "dateDisplay populated");
assert(typeof d1.extentText === "string" && d1.extentText.length > 0, "extentText populated");
assert(typeof d1.recordCreated === "string" && /^\d{4}-\d{2}-\d{2}/.test(d1.recordCreated),
  "recordCreated is ISO 8601");
assert(typeof d1.recordModified === "string" && /^\d{4}-\d{2}-\d{2}/.test(d1.recordModified),
  "recordModified is ISO 8601");

// Themes
assert(Array.isArray(d1.themes), "themes is array");
assert(d1.themesTotalCount >= 3, `themesTotalCount >= 3 (got ${d1.themesTotalCount})`);
assert(d1.themes.length === d1.themesTotalCount, "themes.length matches total (under cap)");
assert(d1.themes.every(t => typeof t.id === "string" && typeof t.label === "string"),
  "each theme has {id, label}");

// Exhibitions
assert(Array.isArray(d1.exhibitions), "exhibitions is array");
assert(d1.exhibitionsTotalCount >= 1, `exhibitionsTotalCount >= 1 (got ${d1.exhibitionsTotalCount})`);
const ex0 = d1.exhibitions[0];
assert(typeof ex0?.exhibitionId === "number", "exhibition has numeric exhibitionId");
assert("titleEn" in ex0 && "titleNl" in ex0 && "dateStart" in ex0 && "dateEnd" in ex0,
  "exhibition row carries titleEn/titleNl/dateStart/dateEnd");

// Attribution evidence (artwork-level array, NOT per-production)
assert(Array.isArray(d1.attributionEvidence), "attributionEvidence is array");
assert(d1.attributionEvidence.length >= 1, "attributionEvidence has at least one entry");
const aev = d1.attributionEvidence[0];
assert(typeof aev.partIndex === "number" && aev.partIndex >= 0, "evidence has numeric partIndex");
assert("evidenceTypeAat" in aev && "carriedByUri" in aev && "labelText" in aev,
  "evidence row carries evidenceTypeAat / carriedByUri / labelText");
// Crucially, attributionEvidence is NOT inside production[]
assert(!d1.production.some(p => "attributionEvidence" in p),
  "attributionEvidence is NOT nested inside production[] entries (artwork-level per revision 2026-05-01)");

// External IDs (struct, not record)
assert(typeof d1.externalIds === "object" && d1.externalIds !== null,
  "externalIds is an object");
assert("handle" in d1.externalIds && "other" in d1.externalIds,
  "externalIds carries {handle, other}");
assert(typeof d1.externalIds.handle === "string" && d1.externalIds.handle.startsWith("http"),
  "externalIds.handle is a URI");
assert(Array.isArray(d1.externalIds.other), "externalIds.other is an array");

// Location (museum_rooms struct)
assert(d1.location !== null && typeof d1.location === "object",
  "location is non-null object");
assert(d1.location.roomId === "2.9",
  `location.roomId='2.9' (got '${d1.location.roomId}')`);
assert("floor" in d1.location && "roomName" in d1.location,
  "location carries floor + roomName");

// Removed fields (#290 / #301)
assert(!("examinations" in d1), "examinations field removed (#301)");
assert(!("examinationsTotalCount" in d1), "examinationsTotalCount field removed (#301)");
assert(!("conservationHistory" in d1), "conservationHistory field removed (#301)");
assert(!("conservationHistoryTotalCount" in d1), "conservationHistoryTotalCount field removed (#301)");
assert(d1.production.every(p => !p.personInfo || !("bio" in p.personInfo)),
  "personInfo.bio removed from all production entries (#290)");

// ══════════════════════════════════════════════════════════════════
section("2. KOG-MP-2-2061-2 — small object with depth_cm");
// ══════════════════════════════════════════════════════════════════

const r2 = await client.callTool({
  name: "get_artwork_details",
  arguments: { objectNumber: "KOG-MP-2-2061-2" },
});
const d2 = unwrap(r2);

assert(d2.objectNumber === "KOG-MP-2-2061-2", "objectNumber returned");
const depthRow = d2.dimensions.find(x => x.type === "depth");
assert(depthRow != null, "dimensions[] includes a depth entry");
assert(depthRow.unit === "cm" && typeof depthRow.value === "number" && depthRow.value > 0,
  `depth has cm unit and positive value (got ${JSON.stringify(depthRow)})`);

// ══════════════════════════════════════════════════════════════════
section("3. SK-A-3953 — themes populated but current_location IS NULL → location: null");
// ══════════════════════════════════════════════════════════════════

const r3 = await client.callTool({
  name: "get_artwork_details",
  arguments: { objectNumber: "SK-A-3953" },
});
const d3 = unwrap(r3);

assert(d3.objectNumber === "SK-A-3953", "objectNumber returned");
assert(d3.location === null,
  `location is null when current_location IS NULL (got ${JSON.stringify(d3.location)})`);
assert(d3.themesTotalCount >= 2, "still has themes populated");
assert(d3.attributionEvidence.length >= 1, "still has attributionEvidence populated");

// ══════════════════════════════════════════════════════════════════
section("4. outputSchema $ref-free verification");
// ══════════════════════════════════════════════════════════════════

const tools = await client.listTools();
const detail = tools.tools.find(t => t.name === "get_artwork_details");
const schemaJson = JSON.stringify(detail.outputSchema ?? {});
assert(!/"\$ref"/.test(schemaJson),
  "get_artwork_details outputSchema has no $ref (claude.ai compatibility)");

// ══════════════════════════════════════════════════════════════════
console.log(`\n${"═".repeat(60)}\n  Passed: ${passed}  Failed: ${failed}\n${"═".repeat(60)}`);
await client.close();
if (failed > 0) {
  console.log("\nFailures:");
  for (const m of fails) console.log(`  - ${m}`);
  process.exit(1);
}
