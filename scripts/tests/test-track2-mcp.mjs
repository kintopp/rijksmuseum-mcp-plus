/**
 * End-to-end MCP-protocol smoke test for the Track-2 wirings landed in this
 * session: title_variants, artwork_parent + groupBy=parent, related_objects.
 *
 * Boots the local dist/index.js as a stdio MCP server and exercises each
 * surface through the JSON-RPC protocol — i.e. exactly the path a real
 * claude.ai or Claude Desktop client would take.
 *
 * Run:  node scripts/tests/test-track2-mcp.mjs
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
function textOf(r) {
  return r.content?.[0]?.text ?? "";
}

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  cwd: PROJECT_DIR,
  env: { ...process.env, STRUCTURED_CONTENT: "true" },
});

const client = new Client({ name: "test-track2-mcp", version: "0.1" });
await client.connect(transport);
console.log("Connected to server via stdio");

// ══════════════════════════════════════════════════════════════════
section("1. tools/list includes the new fields' parent tools");
// ══════════════════════════════════════════════════════════════════

const tools = await client.listTools();
const toolNames = tools.tools.map(t => t.name);
assert(toolNames.includes("get_artwork_details"), "get_artwork_details registered");
assert(toolNames.includes("search_artwork"), "search_artwork registered");

const detailTool = tools.tools.find(t => t.name === "get_artwork_details");
const detailDesc = detailTool.description;
assert(/titles \(primary plus the full set of variants/.test(detailDesc),
  "get_artwork_details description mentions title variants");

const searchTool = tools.tools.find(t => t.name === "search_artwork");
const groupByProp = searchTool.inputSchema?.properties?.groupBy;
assert(groupByProp != null, "search_artwork inputSchema declares groupBy");
assert(Array.isArray(groupByProp?.enum) && groupByProp.enum.includes("parent"),
  "groupBy enum includes 'parent'");

// ══════════════════════════════════════════════════════════════════
section("2. get_artwork_details(SK-C-5) — Night Watch surfaces");
// ══════════════════════════════════════════════════════════════════

const r2 = await client.callTool({
  name: "get_artwork_details",
  arguments: { objectNumber: "SK-C-5" },
});
const nw = unwrap(r2);

assert(nw.objectNumber === "SK-C-5", "Night Watch objectNumber returned");

// Task A: titles[]
assert(Array.isArray(nw.titles) && nw.titles.length === 6,
  `titles[] has 6 variants (got ${nw.titles?.length})`);
const qualifiers = new Set(nw.titles.map(t => t.qualifier));
assert(qualifiers.has("brief") && qualifiers.has("full") &&
       qualifiers.has("display") && qualifiers.has("former"),
  "qualifiers cover brief/full/display/former");
const langs = new Set(nw.titles.map(t => t.language));
assert(langs.has("en") && langs.has("nl"),
  "languages cover en + nl");

// Task B: parents/children
assert(Array.isArray(nw.parents) && nw.parents.length === 0,
  "Night Watch has no parents (top-level object)");
assert(typeof nw.childCount === "number" && nw.childCount === 0,
  "Night Watch has no children (childCount=0)");

// Task C: relatedObjects (post-cluster-E: co-production-only — Night Watch has none)
assert(Array.isArray(nw.relatedObjects),
  "relatedObjects[] returned as array");
assert(typeof nw.relatedObjectsTotalCount === "number",
  "relatedObjectsTotalCount is a number");
assert(nw.relatedObjectsTotalCount === 0,
  `Night Watch has 0 co-production peers (got ${nw.relatedObjectsTotalCount})`);

// ══════════════════════════════════════════════════════════════════
section("3. get_artwork_details(BI-1898-1748A) — sketchbook parent (#28)");
// ══════════════════════════════════════════════════════════════════

const r3 = await client.callTool({
  name: "get_artwork_details",
  arguments: { objectNumber: "BI-1898-1748A" },
});
const book = unwrap(r3);

assert(book.parents.length === 0, "sketchbook has no further parent");
assert(book.childCount === 51,
  `sketchbook has 51 folio sides (got ${book.childCount})`);
assert(book.children.length === 25,
  `children preview capped at 25 (got ${book.children.length})`);
const allOrdered = book.children.every((c, i) =>
  i === 0 || book.children[i-1].objectNumber <= c.objectNumber);
assert(allOrdered, "children sorted by objectNumber ascending");

// ══════════════════════════════════════════════════════════════════
section("4. get_artwork_details(BI-1898-1748A-1(R)) — folio child");
// ══════════════════════════════════════════════════════════════════

const r4 = await client.callTool({
  name: "get_artwork_details",
  arguments: { objectNumber: "BI-1898-1748A-1(R)" },
});
const folio = unwrap(r4);

assert(folio.parents.length === 1, "folio has one parent");
assert(folio.parents[0].objectNumber === "BI-1898-1748A",
  "folio's parent is the sketchbook");
assert(typeof folio.parents[0].title === "string" && folio.parents[0].title.length > 0,
  "parent record carries a resolved title");
assert(folio.childCount === 0, "folio is a leaf (no children)");

// ══════════════════════════════════════════════════════════════════
section("5. get_artwork_details(RP-P-1997-361) — co-production peers");
// ══════════════════════════════════════════════════════════════════
// Cluster E narrowed relatedObjects[] to the 3 co-production labels
// ('different example' / 'production stadia' / 'pendant'). RP-P-1997-361
// carries 7 such entries across 2 distinct labels.

const r5 = await client.callTool({
  name: "get_artwork_details",
  arguments: { objectNumber: "RP-P-1997-361" },
});
const rp = unwrap(r5);

assert(rp.relatedObjectsTotalCount === 7,
  `RP-P-1997-361 carries 7 co-production entries (got ${rp.relatedObjectsTotalCount})`);
assert(rp.relatedObjects.length === 7,
  `relatedObjects[] returns all 7 (got ${rp.relatedObjects.length})`);
const rpDistinct = new Set(rp.relatedObjects.map(r => r.relationship));
assert(rpDistinct.size === 2,
  `2 distinct relationship labels (got ${rpDistinct.size})`);
assert(rpDistinct.has("different example") && rpDistinct.has("production stadia"),
  "covers both 'different example' and 'production stadia'");
const firstRow = rp.relatedObjects[0];
assert(typeof firstRow?.relationship === "string" && firstRow.relationship.length > 0,
  "first relatedObject has relationship label");
assert(typeof firstRow?.objectUri === "string" && firstRow.objectUri.startsWith("https://"),
  "first relatedObject carries objectUri");

// ══════════════════════════════════════════════════════════════════
section("6. search_artwork(creator='Schedel') — default behaviour");
// ══════════════════════════════════════════════════════════════════

const r6 = await client.callTool({
  name: "search_artwork",
  arguments: { creator: "Schedel", maxResults: 50 },
});
const sched = unwrap(r6);

assert(Array.isArray(sched.results) && sched.results.length === 50,
  `default returns 50 raw results (got ${sched.results?.length})`);
const sketchbookFolios = sched.results.filter(r =>
  r.objectNumber.startsWith("BI-1962-1073")).length;
assert(sketchbookFolios > 1, "sketchbook folios present in default result");
assert(sched.results.every(r => r.groupedChildCount == null),
  "no groupedChildCount on results when groupBy is not set");

// ══════════════════════════════════════════════════════════════════
section("7. search_artwork(creator='Schedel', groupBy='parent') — collapsed");
// ══════════════════════════════════════════════════════════════════

const r7 = await client.callTool({
  name: "search_artwork",
  arguments: { creator: "Schedel", maxResults: 50, groupBy: "parent" },
});
const grouped = unwrap(r7);

assert(grouped.results.length < sched.results.length,
  `grouped result count (${grouped.results.length}) < raw (${sched.results.length})`);

const parents = grouped.results.filter(r => r.groupedChildCount != null);
assert(parents.length >= 1, "at least one parent absorbs children");

const collapsed = sched.results.length - grouped.results.length;
assert(parents.reduce((sum, p) => sum + p.groupedChildCount, 0) === collapsed,
  `groupedChildCount sums match dropped rows (${collapsed} dropped)`);

assert(Array.isArray(grouped.warnings) &&
  grouped.warnings.some(w => w.includes("groupBy=parent collapsed")),
  "warning string explains the grouping");

const stillFolios = grouped.results.filter(r =>
  r.objectNumber !== "BI-1962-1073" &&
  r.objectNumber.startsWith("BI-1962-1073")).length;
assert(stillFolios === 0, "no folios remain when their parent is in the result");

// ══════════════════════════════════════════════════════════════════
section("8. Text-channel sentinels — get_artwork_details (Track A–E)");
// ══════════════════════════════════════════════════════════════════
// Issue #277: text formatter must emit sentinel markers when the matching
// structuredContent fields are non-empty. Catches the entire bug class
// where outputSchema gains a field but formatDetailSummary stays silent.

const nwText = textOf(r2);
assert(nwText.includes("[Titles]"),
  "[Titles] section rendered when titles[].length > 0");
assert(/\(\d+ variants\)/.test(nwText),
  "[Titles] header includes variant count");

const bookText = textOf(r3);
assert(bookText.includes("[Children]"),
  "[Children] section rendered when childCount > 0");
assert(/\[Children\] \(51\)/.test(bookText),
  "[Children] header carries the full childCount (not preview length)");

const folioText = textOf(r4);
assert(folioText.includes("[Parent]"),
  "[Parent] section rendered when parents[].length > 0");
assert(folioText.includes("BI-1898-1748A"),
  "[Parent] line names the parent objectNumber");

const rpText = textOf(r5);
assert(rpText.includes("[Co-productions]"),
  "[Co-productions] section rendered when relatedObjectsTotalCount > 0");

// ══════════════════════════════════════════════════════════════════
section("9. Text-channel sentinels — search_artwork groupedChildCount (#277 High)");
// ══════════════════════════════════════════════════════════════════

const groupedText = textOf(r7);
assert(/\(\+\d+ children collapsed\)/.test(groupedText),
  "formatSearchLine renders '(+N children collapsed)' suffix on parent rows");
const collapseMatches = groupedText.match(/\(\+(\d+) children collapsed\)/g) ?? [];
assert(collapseMatches.length === parents.length,
  `collapse suffix appears once per absorbing parent (text=${collapseMatches.length}, structured=${parents.length})`);

// ══════════════════════════════════════════════════════════════════
section("10. Text-channel sentinels — get_artwork_image license (#277 Low-Medium)");
// ══════════════════════════════════════════════════════════════════

const r10 = await client.callTool({
  name: "get_artwork_image",
  arguments: { objectNumber: "SK-C-5" },
});
const img = unwrap(r10);
const imgText = textOf(r10);
if (img.license) {
  assert(imgText.includes(`[${img.license}]`),
    "image text includes [license] tag when license is present in structuredContent");
} else {
  assert(true, "no license in structuredContent — text omits tag (vacuous pass)");
}
assert(imgText.includes("viewUUID:"),
  "image text still carries viewUUID handle (no regression)");

// ══════════════════════════════════════════════════════════════════
section("11. Text-channel sentinels — list_curated_sets lodUri (#277 Low)");
// ══════════════════════════════════════════════════════════════════

const r11 = await client.callTool({
  name: "list_curated_sets",
  arguments: {},
});
const sets = unwrap(r11);
const setsText = textOf(r11);
const firstWithLod = sets.sets.find(s => s.lodUri);
if (firstWithLod) {
  assert(setsText.includes(firstWithLod.lodUri),
    `formatSetLine renders lodUri (verified: ${firstWithLod.lodUri.slice(0, 50)}…)`);
} else {
  assert(true, "no curated set carries lodUri — text omits column (vacuous pass)");
}

// ══════════════════════════════════════════════════════════════════
section("12. Text-channel sentinels — search_provenance event metadata (#277 Medium)");
// ══════════════════════════════════════════════════════════════════
// Pick an artwork known to have LLM-enriched events so we exercise the
// non-trivial metadata suffix branches. SK-C-5 (Night Watch) provenance is
// PEG-parsed with transferCategory set on most events.

const r12 = await client.callTool({
  name: "search_provenance",
  arguments: { objectNumber: "SK-C-5" },
});
const prov = unwrap(r12);
const provText = textOf(r12);

const evCount = prov.results?.[0]?.events?.length ?? 0;
assert(evCount > 0, `SK-C-5 has provenance events (got ${evCount})`);

// Look for at least one event that *should* render a [meta: …] suffix
const evWithMeta = (prov.results?.[0]?.events ?? []).find(e =>
  e.transferCategory ||
  (e.parseMethod && e.parseMethod !== "peg") ||
  e.correctionMethod ||
  e.parties?.some(p => p.positionMethod && p.positionMethod !== "role_mapping")
);

if (evWithMeta) {
  assert(/\[(parse=|cat=|fix=|pos:)/.test(provText),
    "[meta: …] suffix rendered when event carries non-default classification metadata");
  if (evWithMeta.transferCategory) {
    assert(provText.includes(`cat=${evWithMeta.transferCategory}`),
      `cat=${evWithMeta.transferCategory} appears in text channel`);
  }
} else {
  assert(true, "no events with non-default metadata in SK-C-5 (vacuous pass — extend fixture if needed)");
}

// ══════════════════════════════════════════════════════════════════
section("Summary");
// ══════════════════════════════════════════════════════════════════
console.log(`\nPassed: ${passed}`);
console.log(`Failed: ${failed}`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const f of fails) console.log(`  - ${f}`);
}

await client.close();
process.exit(failed === 0 ? 0 : 1);
