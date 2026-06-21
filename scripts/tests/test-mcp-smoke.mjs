/**
 * End-to-end MCP smoke test — lists every registered tool and exercises one
 * representative call per tool family over the official MCP SDK stdio client.
 *
 * Uses: @modelcontextprotocol/sdk Client + StdioClientTransport (the canonical
 * harness, same as test-inspect-navigate.mjs) — no third-party test SDK.
 *
 * Requires:  npm run build  (spawns dist/index.js) + the real DBs in data/.
 * Run:       node scripts/tests/test-mcp-smoke.mjs   (or `npm run test:mcp`)
 *
 * Excluded from `npm test` / `test:ci` / `test:all` — it needs dist/ + the full
 * DBs and hits live IIIF, mirroring test-cli.mjs / test-inspect-navigate.mjs.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// ── Test helpers ──────────────────────────────────────────────────

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
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ${name}`);
  console.log(`${"═".repeat(60)}`);
}

/** Concatenate the text channel of a tool result. */
const textOf = (r) => (r?.content ?? []).map((c) => c.text ?? "").join("\n");

// ── Connect ───────────────────────────────────────────────────────

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  cwd: PROJECT_DIR,
  env: { ...process.env, STRUCTURED_CONTENT: "true", ENABLE_FIND_SIMILAR: "true" },
});

const client = new Client({ name: "test-mcp-smoke", version: "0.1" });
await client.connect(transport);
console.log("Connected to server via stdio\n");

try {

// ══════════════════════════════════════════════════════════════════
//  1. Tool listing
// ══════════════════════════════════════════════════════════════════

section("1. Tool listing");

const toolsResult = await client.listTools();
const toolNames = toolsResult.tools.map((t) => t.name).sort();
console.log(`  Found ${toolNames.length} tools: ${toolNames.join(", ")}`);

// All 18 tools registered with ENABLE_FIND_SIMILAR=true: 15 standard
// (incl. find_similar + search_inscriptions + get_conservation_history + get_artwork_bibliography) + 3 app (get_artwork_image,
// remount_viewer, poll_viewer_commands).
const expectedTools = [
  "browse_set",
  "collection_stats",
  "find_similar",
  "get_artwork_bibliography",
  "get_artwork_details",
  "get_artwork_image",
  "get_conservation_history",
  "get_recent_changes",
  "inspect_artwork_image",
  "list_curated_sets",
  "navigate_viewer",
  "poll_viewer_commands",
  "remount_viewer",
  "search_artwork",
  "search_inscriptions",
  "search_persons",
  "search_provenance",
  "semantic_search",
].sort();

assert(toolNames.length === expectedTools.length, `Tool count is ${expectedTools.length} (got ${toolNames.length})`);
for (const name of expectedTools) {
  assert(toolNames.includes(name), `Tool "${name}" is registered`);
}

// ══════════════════════════════════════════════════════════════════
//  2. search_artwork — title (query) search
// ══════════════════════════════════════════════════════════════════

section("2. search_artwork — title search");

const searchResult = await client.callTool({
  name: "search_artwork",
  arguments: { query: "Nachtwacht" },
});
const searchText = textOf(searchResult);
assert(!searchResult.isError, "search_artwork succeeded");
assert(searchText.includes("Nachtwacht") || searchText.includes("Night Watch"), "Found Nachtwacht/Night Watch");

// ══════════════════════════════════════════════════════════════════
//  3. search_artwork — type filter
// ══════════════════════════════════════════════════════════════════

section("3. search_artwork — type filter");

const typeResult = await client.callTool({
  name: "search_artwork",
  arguments: { type: "painting", creator: "Rembrandt" },
});
const typeText = textOf(typeResult);
assert(!typeResult.isError, "search_artwork with filters succeeded");
assert(typeText.toLowerCase().includes("rembrandt"), "Results mention Rembrandt");

// ══════════════════════════════════════════════════════════════════
//  4. get_artwork_details
// ══════════════════════════════════════════════════════════════════

section("4. get_artwork_details");

const detailResult = await client.callTool({
  name: "get_artwork_details",
  arguments: { objectNumber: "SK-C-5" },
});
const detailText = textOf(detailResult);
assert(!detailResult.isError, "get_artwork_details succeeded");
assert(detailText.includes("Nachtwacht") || detailText.includes("Night Watch"), "Details include title");
assert(detailText.includes("Rembrandt"), "Details include creator");

// ══════════════════════════════════════════════════════════════════
//  5. collection_stats — type dimension
// ══════════════════════════════════════════════════════════════════

section("5. collection_stats — type dimension");

const statsResult = await client.callTool({
  name: "collection_stats",
  arguments: { dimension: "type" },
});
const statsText = textOf(statsResult);
assert(!statsResult.isError, "collection_stats succeeded");
assert(statsText.includes("painting") || statsText.includes("print"), "Stats include known types");

// ══════════════════════════════════════════════════════════════════
//  6. collection_stats — filtered
// ══════════════════════════════════════════════════════════════════

section("6. collection_stats — filtered by type");

const statsFiltered = await client.callTool({
  name: "collection_stats",
  arguments: { dimension: "creator", type: "painting", topN: 5 },
});
const statsFilteredText = textOf(statsFiltered);
assert(!statsFiltered.isError, "collection_stats with type filter succeeded");
assert(statsFilteredText.length > 20, "Filtered stats returned results");

// ══════════════════════════════════════════════════════════════════
//  7. list_curated_sets
// ══════════════════════════════════════════════════════════════════

section("7. list_curated_sets");

const setsResult = await client.callTool({ name: "list_curated_sets", arguments: {} });
const setsText = textOf(setsResult);
assert(!setsResult.isError, "list_curated_sets succeeded");
assert(setsText.includes("set") || setsText.includes("Set"), "Response mentions sets");

// ══════════════════════════════════════════════════════════════════
//  8. browse_set
// ══════════════════════════════════════════════════════════════════

section("8. browse_set");

// Extract a setSpec from list_curated_sets output
const specMatch = setsText.match(/(\d{3,6})/);  // set IDs are numeric
const setSpec = specMatch?.[1] ?? "26121";       // fallback to a known set

const browseResult = await client.callTool({
  name: "browse_set",
  arguments: { setSpec, maxResults: 3 },
});
assert(!browseResult.isError, `browse_set(setSpec="${setSpec}") succeeded`);

// ══════════════════════════════════════════════════════════════════
//  9. semantic_search
// ══════════════════════════════════════════════════════════════════

section("9. semantic_search");

const semResult = await client.callTool({
  name: "semantic_search",
  arguments: { query: "winter landscape with ice skaters" },
});
const semText = textOf(semResult);
assert(!semResult.isError, "semantic_search succeeded");
assert(semText.length > 50, "semantic_search returned substantial results");

// ══════════════════════════════════════════════════════════════════
//  10. search_provenance
// ══════════════════════════════════════════════════════════════════

section("10. search_provenance");

const provResult = await client.callTool({
  name: "search_provenance",
  arguments: { party: "Goudstikker" },
});
const provText = textOf(provResult);
assert(!provResult.isError, "search_provenance succeeded");
assert(provText.toLowerCase().includes("goudstikker"), "Provenance results mention Goudstikker");

// ══════════════════════════════════════════════════════════════════
//  11. search_inscriptions
// ══════════════════════════════════════════════════════════════════

section("11. search_inscriptions");

const inscrResult = await client.callTool({
  name: "search_inscriptions",
  arguments: { transcribedText: "Rembrandt" },
});
assert(!inscrResult.isError, "search_inscriptions succeeded");
assert(textOf(inscrResult).length > 20, "search_inscriptions returned content");

// ══════════════════════════════════════════════════════════════════
//  12. get_artwork_image (app tool)
// ══════════════════════════════════════════════════════════════════

section("12. get_artwork_image");

const imageResult = await client.callTool({
  name: "get_artwork_image",
  arguments: { objectNumber: "SK-C-5" },
});
const imageText = textOf(imageResult);
assert(!imageResult.isError, "get_artwork_image succeeded");
assert(imageText.includes("viewUUID") || imageText.includes("viewer"), "Response contains viewer reference");

// ══════════════════════════════════════════════════════════════════
//  13. get_recent_changes
// ══════════════════════════════════════════════════════════════════

section("13. get_recent_changes");

const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
const changesResult = await client.callTool({
  name: "get_recent_changes",
  arguments: { from: thirtyDaysAgo, maxResults: 3 },
});
const changesText = textOf(changesResult);
assert(!changesResult.isError, "get_recent_changes succeeded");
assert(changesText.length > 20, "get_recent_changes returned content");

// ══════════════════════════════════════════════════════════════════
//  14. search_artwork — invalid params rejected (strict schemas)
// ══════════════════════════════════════════════════════════════════

section("14. Strict schema validation");

// The official SDK rejects the promise with an McpError (-32602) when the
// server's strict Zod schema refuses an unknown key — unlike a tool that
// returns isError:true. Accept either signal.
let rejected = false;
try {
  const badResult = await client.callTool({
    name: "search_artwork",
    arguments: { query: "test", bogusParam: "should be rejected" },
  });
  rejected = badResult?.isError === true;
} catch {
  rejected = true;
}
assert(rejected, "Unknown param 'bogusParam' is rejected by strict schema");

// ══════════════════════════════════════════════════════════════════
//  Summary
// ══════════════════════════════════════════════════════════════════

} finally {
  await client.close();
}

console.log(`\n${"═".repeat(60)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log(`\n  Failures:`);
  for (const f of failures) console.log(`    ✗ ${f}`);
}
console.log(`${"═".repeat(60)}\n`);

process.exit(failed > 0 ? 1 : 0);
