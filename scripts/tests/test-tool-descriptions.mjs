/**
 * Tool-description regression test (cluster E / #297; front-loading / #392).
 *
 * Boots the server in stdio mode, lists tools, and asserts each description:
 *   - Front-loads a self-contained summary (no "Use …" boilerplate prefix,
 *     and the clipped ~70-char catalogue prefix doesn't restate the title) —
 *     so deferred-loading clients that show only name + clipped prefix can
 *     still discriminate the tool. See #392.
 *   - Cross-links to the alternative tools by name.
 *   - Doesn't reference filters that were dropped in clusters A or B.
 *   - For find_similar: mentions all 9 channel names.
 *   - For list_curated_sets: mentions the category heuristic.
 *
 * Substring matches deliberately, so incidental wording tweaks don't break
 * the suite — only structural drift does.
 *
 * Run:  node scripts/tests/test-tool-descriptions.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, msg) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}

function section(name) {
  console.log(`\n${"═".repeat(60)}\n  ${name}\n${"═".repeat(60)}`);
}

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  cwd: PROJECT_DIR,
  env: { ...process.env, STRUCTURED_CONTENT: "true" },
});
const client = new Client({ name: "test-tool-descriptions", version: "0.1" });
await client.connect(transport);
console.log("Connected to server via stdio\n");

const { tools } = await client.listTools();
const byName = new Map(tools.map((t) => [t.name, t]));

function expect(name) {
  const tool = byName.get(name);
  if (!tool) throw new Error(`Tool not registered: ${name}`);
  return tool;
}

function descOf(name) {
  return expect(name).description ?? "";
}

// ══════════════════════════════════════════════════════════════════
//  Front-loaded, title-independent leads for every model-visible tool (#392)
//
//  Deferred-loading clients present only the tool name + a clipped prefix
//  (~70–90 chars) of the description. Guard the two robust invariants:
//    (a) no "Use …" boilerplate consuming the leading budget;
//    (b) the clipped prefix doesn't merely restate the title the client
//        already shows.
//  (The "char 70 falls inside a word" heuristic from the issue is left out:
//   clients clip anywhere in a range, every summary completes before the cut,
//   and a fixed-offset boundary check rejects good descriptions.)
// ══════════════════════════════════════════════════════════════════

section("Front-loaded, title-independent leads (#392)");

// App-only internal tools (visibility ["app"]) are hidden from the model and
// intentionally terse ("Internal: …") — out of scope per #392.
const MODEL_VISIBLE = tools
  .map((t) => t.name)
  .filter((n) => n !== "remount_viewer" && n !== "poll_viewer_commands");

for (const name of MODEL_VISIBLE) {
  const tool = expect(name);
  const desc = tool.description ?? "";
  const clip = desc.slice(0, 70);
  assert(!desc.startsWith("Use "),
    `${name}: description does not open with "Use …" boilerplate`);
  assert(!(tool.title && clip.includes(tool.title)),
    `${name}: clipped 70-char prefix does not restate the title verbatim`);
}

const sa = descOf("search_artwork");
const ss = descOf("semantic_search");
const fs = descOf("find_similar");

// ══════════════════════════════════════════════════════════════════
//  Cross-links between the three core retrieval tools
// ══════════════════════════════════════════════════════════════════

section("Cross-links between retrieval tools");

assert(sa.includes("semantic_search") && sa.includes("find_similar") && sa.includes("search_persons"),
  "search_artwork cross-links to semantic_search, find_similar, search_persons");

assert(ss.includes("search_artwork") && ss.includes("find_similar"),
  "semantic_search cross-links to search_artwork and find_similar");

assert(fs.includes("semantic_search") && fs.includes("search_artwork"),
  "find_similar cross-links to semantic_search and search_artwork");

// ══════════════════════════════════════════════════════════════════
//  find_similar: 9 channels
// ══════════════════════════════════════════════════════════════════

section("find_similar: 9 channel names");

const channels = ["Visual", "Related Variant", "Related Object", "Lineage", "Iconclass", "Description", "Theme", "Depicted Person", "Depicted Place"];
for (const ch of channels) {
  assert(fs.includes(ch), `find_similar mentions "${ch}" channel`);
}

// ══════════════════════════════════════════════════════════════════
//  list_curated_sets: category heuristic + cluster D enrichments
// ══════════════════════════════════════════════════════════════════

section("list_curated_sets enrichments");

const lcs = descOf("list_curated_sets");
assert(lcs.includes("category") && lcs.includes("memberCount") && lcs.includes("dominantTypes"),
  "list_curated_sets mentions category heuristic + memberCount + dominantTypes");
assert(/object_type|iconographic|umbrella/.test(lcs),
  "list_curated_sets lists the category-heuristic vocabulary");

// ══════════════════════════════════════════════════════════════════
//  browse_set: DB-backed performance note
// ══════════════════════════════════════════════════════════════════

section("browse_set DB-backed note");

const bs = descOf("browse_set");
assert(/DB-backed|DB-direct/.test(bs), "browse_set mentions DB-backed/DB-direct");

// ══════════════════════════════════════════════════════════════════
//  search_persons: lead-in + two-step pattern
// ══════════════════════════════════════════════════════════════════

section("search_persons");

const sp = descOf("search_persons");
assert(/^Demographic\/structural lookup of persons/.test(sp),
  "search_persons: front-loaded 'Demographic/structural lookup of persons' lead");
assert(sp.includes("search_artwork") && sp.includes("vocabId"),
  "search_persons cross-links to search_artwork({creator: vocabId})");

// ══════════════════════════════════════════════════════════════════
//  collection_stats: new dimensions
// ══════════════════════════════════════════════════════════════════

section("collection_stats new dimensions");

const cs = descOf("collection_stats");
assert(cs.includes("theme") && cs.includes("sourceType") && cs.includes("decadeModified"),
  "collection_stats lists theme / sourceType / decadeModified dimensions");

// ══════════════════════════════════════════════════════════════════
//  search_provenance: periodLocation
// ══════════════════════════════════════════════════════════════════

section("search_provenance periodLocation");

const spv = descOf("search_provenance");
assert(spv.includes("periodLocation"), "search_provenance mentions periodLocation");

// ══════════════════════════════════════════════════════════════════
//  navigate_viewer: deliveryState contract (#287/2)
// ══════════════════════════════════════════════════════════════════

section("navigate_viewer deliveryState contract");

const nv = descOf("navigate_viewer");
assert(nv.includes("deliveryState"),
  "navigate_viewer description mentions deliveryState (response field contract)");
assert(nv.includes("queued_waiting_for_viewer"),
  "navigate_viewer description names the queued_waiting_for_viewer state");
assert(nv.includes("do not narrate") && nv.toLowerCase().includes("failure"),
  "navigate_viewer description tells the model not to narrate the queued state as a failure");

// ══════════════════════════════════════════════════════════════════
//  navigate_viewer / inspect_artwork_image: overlay verify-and-adjust loop (#337)
// ══════════════════════════════════════════════════════════════════

section("Overlay verify-and-adjust loop affordances (#337)");

assert(/append-only/i.test(nv) && nv.includes("clear_overlays") && nv.includes("re-add"),
  "navigate_viewer description spells out the append-only / clear_overlays-then-re-add model");
assert(nv.includes("verificationRegion"),
  "navigate_viewer description mentions the per-overlay verificationRegion");
assert(nv.includes("distinct") && nv.includes("color"),
  "navigate_viewer description recommends distinct colors for multiple overlays");

const inspect = expect("inspect_artwork_image");
const inspectDesc = inspect.description ?? "";
assert(inspectDesc.includes("verificationRegion"),
  "inspect_artwork_image description references verificationRegion (from navigate_viewer)");
assert(/clear_overlays/.test(inspectDesc) && /re-add ALL/.test(inspectDesc),
  "inspect_artwork_image description spells out clear_overlays + re-add ALL repositioning model");

const showOverlaysDesc =
  inspect.inputSchema?.properties?.show_overlays?.description ?? "";
assert(/verification/i.test(showOverlaysDesc),
  "show_overlays param description names its verification purpose");
assert(/non-'?full/i.test(showOverlaysDesc) || /not 'full/i.test(showOverlaysDesc),
  "show_overlays param description requires a non-'full' region");
assert(/448/.test(showOverlaysDesc),
  "show_overlays param description retains the 448 px clamp note");

// ══════════════════════════════════════════════════════════════════
//  No references to dropped filters (scoped to the affected tools)
// ══════════════════════════════════════════════════════════════════

section("No stale references to dropped filters");

// search_artwork lost: provenance (text), creatorGender, creatorBornAfter,
// creatorBornBefore, birthPlace, deathPlace, profession.
// Note: "search_provenance" contains the substring "provenance", so we test
// for the parameter form `provenance` (a `provenance:` arg or sentence about
// the dropped filter) rather than the bare word.
const droppedSearchArtworkFilters = [
  "creatorGender", "creatorBornAfter", "creatorBornBefore",
];
for (const f of droppedSearchArtworkFilters) {
  assert(!sa.includes(f), `search_artwork description does not reference dropped filter "${f}"`);
}

// get_artwork_details lost: examinations, conservationHistory, bio.
const gad = descOf("get_artwork_details");
const droppedDetailsFields = ["examinations", "conservationHistory"];
for (const f of droppedDetailsFields) {
  assert(!gad.includes(f), `get_artwork_details description does not reference dropped field "${f}"`);
}

// ══════════════════════════════════════════════════════════════════
//  Summary
// ══════════════════════════════════════════════════════════════════

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
}

await client.close();
process.exit(failed > 0 ? 1 : 0);
