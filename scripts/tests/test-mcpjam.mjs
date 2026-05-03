/**
 * MCP server tests using @mcpjam/sdk.
 *
 * Run:  node scripts/tests/test-mcpjam.mjs
 * Requires: npm run build (uses dist/index.js via stdio)
 */
import { MCPClientManager } from "@mcpjam/sdk";

const SERVER_ID = "rijksmuseum";
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

// ── Connect ───────────────────────────────────────────────────────

const manager = new MCPClientManager();
await manager.connectToServer(SERVER_ID, {
  command: "node",
  args: ["dist/index.js"],
  env: { ...process.env, STRUCTURED_CONTENT: "true", ENABLE_FIND_SIMILAR: "true" },
});
console.log("Connected to server via mcpjam MCPClientManager\n");

try {

// ══════════════════════════════════════════════════════════════════
//  1. Tool listing
// ══════════════════════════════════════════════════════════════════

section("1. Tool listing");

const toolsResult = await manager.listTools(SERVER_ID);
const toolNames = toolsResult.tools.map(t => t.name).sort();
console.log(`  Found ${toolNames.length} tools: ${toolNames.join(", ")}`);

const expectedTools = [
  "browse_set",
  "collection_stats",
  "find_similar",
  "get_artwork_details",
  "get_artwork_image",
  "get_recent_changes",
  "inspect_artwork_image",
  "list_curated_sets",
  "navigate_viewer",
  "poll_viewer_commands",
  "remount_viewer",
  "search_artwork",
  "search_persons",
  "search_provenance",
  "semantic_search",
].sort();

assert(toolNames.length === expectedTools.length, `Tool count is ${expectedTools.length} (got ${toolNames.length})`);
for (const name of expectedTools) {
  assert(toolNames.includes(name), `Tool "${name}" is registered`);
}

// ══════════════════════════════════════════════════════════════════
//  2. Prompts listing
// ══════════════════════════════════════════════════════════════════

section("2. Prompt listing");

const promptsResult = await manager.listPrompts(SERVER_ID);
const promptNames = promptsResult.prompts.map(p => p.name).sort();
console.log(`  Found ${promptNames.length} prompts: ${promptNames.join(", ")}`);
assert(promptNames.length >= 2, `At least 2 prompts registered (got ${promptNames.length})`);

// ══════════════════════════════════════════════════════════════════
//  3. search_artwork — basic keyword search
// ══════════════════════════════════════════════════════════════════

section("3. search_artwork — keyword search");

const searchResult = await manager.executeTool(SERVER_ID, "search_artwork", {
  title: "Nachtwacht",
});
const searchText = searchResult.content?.[0]?.text ?? "";
assert(!searchResult.isError, "search_artwork succeeded");
assert(searchText.includes("Nachtwacht") || searchText.includes("Night Watch"), "Found Nachtwacht/Night Watch");

// ══════════════════════════════════════════════════════════════════
//  4. search_artwork — type filter
// ══════════════════════════════════════════════════════════════════

section("4. search_artwork — type filter");

const typeResult = await manager.executeTool(SERVER_ID, "search_artwork", {
  type: "painting",
  creator: "Rembrandt",
});
const typeText = typeResult.content?.[0]?.text ?? "";
assert(!typeResult.isError, "search_artwork with filters succeeded");
assert(typeText.toLowerCase().includes("rembrandt"), "Results mention Rembrandt");

// ══════════════════════════════════════════════════════════════════
//  5. get_artwork_details
// ══════════════════════════════════════════════════════════════════

section("5. get_artwork_details");

const detailResult = await manager.executeTool(SERVER_ID, "get_artwork_details", {
  objectNumber: "SK-C-5",
});
const detailText = detailResult.content?.[0]?.text ?? "";
assert(!detailResult.isError, "get_artwork_details succeeded");
assert(detailText.includes("Nachtwacht") || detailText.includes("Night Watch"), "Details include title");
assert(detailText.includes("Rembrandt"), "Details include creator");

// ══════════════════════════════════════════════════════════════════
//  6. collection_stats — type dimension
// ══════════════════════════════════════════════════════════════════

section("6. collection_stats — type dimension");

const statsResult = await manager.executeTool(SERVER_ID, "collection_stats", {
  dimension: "type",
});
const statsText = statsResult.content?.[0]?.text ?? "";
assert(!statsResult.isError, "collection_stats succeeded");
assert(statsText.includes("painting") || statsText.includes("print"), "Stats include known types");

// ══════════════════════════════════════════════════════════════════
//  7. collection_stats — filtered
// ══════════════════════════════════════════════════════════════════

section("7. collection_stats — filtered by type");

const statsFiltered = await manager.executeTool(SERVER_ID, "collection_stats", {
  dimension: "creator",
  type: "painting",
  topN: 5,
});
const statsFilteredText = statsFiltered.content?.[0]?.text ?? "";
assert(!statsFiltered.isError, "collection_stats with type filter succeeded");
assert(statsFilteredText.length > 20, "Filtered stats returned results");

// ══════════════════════════════════════════════════════════════════
//  8. list_curated_sets
// ══════════════════════════════════════════════════════════════════

section("8. list_curated_sets");

const setsResult = await manager.executeTool(SERVER_ID, "list_curated_sets", {});
const setsText = setsResult.content?.[0]?.text ?? "";
assert(!setsResult.isError, "list_curated_sets succeeded");
assert(setsText.includes("set") || setsText.includes("Set"), "Response mentions sets");

// ══════════════════════════════════════════════════════════════════
//  9. browse_set
// ══════════════════════════════════════════════════════════════════

section("9. browse_set");

// Extract a setSpec from list_curated_sets output
const specMatch = setsText.match(/(\d{3,6})/);  // set IDs are numeric
const setSpec = specMatch?.[1] ?? "26121";       // fallback to a known set

const browseResult = await manager.executeTool(SERVER_ID, "browse_set", {
  setSpec,
  maxResults: 3,
});
assert(!browseResult.isError, `browse_set(setSpec="${setSpec}") succeeded`);

// ══════════════════════════════════════════════════════════════════
//  10. semantic_search
// ══════════════════════════════════════════════════════════════════

section("10. semantic_search");

const semResult = await manager.executeTool(SERVER_ID, "semantic_search", {
  query: "winter landscape with ice skaters",
});
const semText = semResult.content?.[0]?.text ?? "";
assert(!semResult.isError, "semantic_search succeeded");
assert(semText.length > 50, "semantic_search returned substantial results");

// ══════════════════════════════════════════════════════════════════
//  11. search_provenance
// ══════════════════════════════════════════════════════════════════

section("11. search_provenance");

const provResult = await manager.executeTool(SERVER_ID, "search_provenance", {
  party: "Goudstikker",
});
const provText = provResult.content?.[0]?.text ?? "";
assert(!provResult.isError, "search_provenance succeeded");
assert(provText.toLowerCase().includes("goudstikker"), "Provenance results mention Goudstikker");

// ══════════════════════════════════════════════════════════════════
//  12. get_artwork_image (app tool)
// ══════════════════════════════════════════════════════════════════

section("12. get_artwork_image");

const imageResult = await manager.executeTool(SERVER_ID, "get_artwork_image", {
  objectNumber: "SK-C-5",
});
const imageText = imageResult.content?.[0]?.text ?? "";
assert(!imageResult.isError, "get_artwork_image succeeded");
assert(imageText.includes("viewUUID") || imageText.includes("viewer"), "Response contains viewer reference");

// ══════════════════════════════════════════════════════════════════
//  13. get_recent_changes
// ══════════════════════════════════════════════════════════════════

section("13. get_recent_changes");

const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
const changesResult = await manager.executeTool(SERVER_ID, "get_recent_changes", {
  from: thirtyDaysAgo,
  maxResults: 3,
});
const changesText = changesResult.content?.[0]?.text ?? "";
assert(!changesResult.isError, "get_recent_changes succeeded");
assert(changesText.length > 20, "get_recent_changes returned content");

// ══════════════════════════════════════════════════════════════════
//  14. search_artwork — invalid params rejected (strict schemas)
// ══════════════════════════════════════════════════════════════════

section("14. Strict schema validation");

const badResult = await manager.executeTool(SERVER_ID, "search_artwork", {
  title: "test",
  bogusParam: "should be rejected",
});
assert(badResult.isError === true, "Unknown param 'bogusParam' is rejected by strict schema");

// ══════════════════════════════════════════════════════════════════
//  Summary
// ══════════════════════════════════════════════════════════════════

} finally {
  await manager.disconnectServer(SERVER_ID);
}

console.log(`\n${"═".repeat(60)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log(`\n  Failures:`);
  for (const f of failures) console.log(`    ✗ ${f}`);
}
console.log(`${"═".repeat(60)}\n`);

process.exit(failed > 0 ? 1 : 0);
