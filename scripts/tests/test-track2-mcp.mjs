/**
 * End-to-end MCP-protocol smoke test for the Track-2 wirings landed in this
 * session: title_variants, artwork_parent + groupBy=parent, related_objects,
 * examinations, conservationHistory.
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

// Task C: relatedObjects
assert(Array.isArray(nw.relatedObjects),
  "relatedObjects[] returned as array");
assert(typeof nw.relatedObjectsTotalCount === "number",
  "relatedObjectsTotalCount is a number");
assert(nw.relatedObjectsTotalCount === 14,
  `Night Watch carries 14 related entries (got ${nw.relatedObjectsTotalCount})`);
const relRow = nw.relatedObjects[0];
assert(typeof relRow?.relationship === "string" && relRow.relationship.length > 0,
  "first relatedObject has relationship label");
assert(typeof relRow?.objectUri === "string" && relRow.objectUri.startsWith("https://"),
  "first relatedObject carries objectUri");

// Task D + E: examinations / conservationHistory (Night Watch has none)
assert(Array.isArray(nw.examinations) && nw.examinations.length === 0,
  "Night Watch has no examinations");
assert(nw.examinationsTotalCount === 0, "examinationsTotalCount=0");
assert(Array.isArray(nw.conservationHistory) && nw.conservationHistory.length === 0,
  "Night Watch has no conservationHistory");

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
section("5. get_artwork_details(SK-A-110) — examinations + conservation");
// ══════════════════════════════════════════════════════════════════

const r5 = await client.callTool({
  name: "get_artwork_details",
  arguments: { objectNumber: "SK-A-110" },
});
const heavy = unwrap(r5);

assert(heavy.examinationsTotalCount === 15,
  `SK-A-110 has 15 examinations (got ${heavy.examinationsTotalCount})`);
assert(heavy.examinations.length === 15, "all 15 fit under 25-cap");
const exam = heavy.examinations[0];
assert(typeof exam.examiner === "string", "examiner field present");
assert(typeof exam.reportTypeId === "string" && exam.reportTypeId.startsWith("https://"),
  "reportTypeId is a Linked Art URI");
assert(exam.reportTypeLabel === null,
  "reportTypeLabel is null in v0.24 (harvest gap, documented)");
assert(typeof exam.dateBegin === "string" && exam.dateBegin.length > 0,
  "dateBegin populated");

assert(heavy.conservationHistoryTotalCount === 5,
  `SK-A-110 has 5 conservation events (got ${heavy.conservationHistoryTotalCount})`);
const cons = heavy.conservationHistory[0];
assert(typeof cons.description === "string" && cons.description.length > 0,
  "conservation event has description");

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
