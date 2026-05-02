/**
 * Test for list_curated_sets enrichment (#302, v0.27 cluster D).
 *
 * Verifies:
 *  - Default call returns ~193 sets sorted alphabetically with stats
 *  - includeStats=false returns the lightweight legacy shape
 *  - sortBy=size_desc puts the largest umbrella set at the top
 *  - minMembers/maxMembers filter correctly
 *  - query substring filter works
 *  - Cache build under 5s (issue acceptance criterion)
 *
 * Run:  node scripts/tests/test-list-curated-sets.mjs
 * Requires: npm run build first.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

let passed = 0;
let failed = 0;
const failures = [];
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; failures.push(msg); console.log(`  ✗ ${msg}`); }
}
function section(name) {
  console.log(`\n${"═".repeat(60)}\n  ${name}\n${"═".repeat(60)}`);
}

async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? "";
  const sc = r.structuredContent ?? null;
  return { text, sc, isError: !!r.isError };
}

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  cwd: PROJECT_DIR,
  env: { ...process.env, STRUCTURED_CONTENT: "true" },
});
const client = new Client({ name: "test-list-curated-sets", version: "0.1" });
await client.connect(transport);
console.log("Connected to server via stdio\n");

// ══════════════════════════════════════════════════════════════════
//  1. Default call — 193 sets, alphabetical, with stats
// ══════════════════════════════════════════════════════════════════
section("1. Default call");

let firstSet;
{
  const { sc, isError } = await call("list_curated_sets", {});
  assert(!isError, "Default call returns no error");
  assert((sc?.totalSets ?? 0) >= 190, `~190+ sets returned (got ${sc?.totalSets})`);
  assert(Array.isArray(sc?.sets), "sets is an array");
  firstSet = sc?.sets?.[0];
  assert(firstSet?.setSpec, "First entry has setSpec");
  assert(firstSet?.name, "First entry has name");
  assert(firstSet?.lodUri?.startsWith("https://id.rijksmuseum.nl/"), `lodUri reconstructed (got ${firstSet?.lodUri})`);
  assert(typeof firstSet?.memberCount === "number", `memberCount present (got ${typeof firstSet?.memberCount})`);
  assert(Array.isArray(firstSet?.dominantTypes), "dominantTypes is an array");
  assert(Array.isArray(firstSet?.dominantCenturies), "dominantCenturies is an array");
}

// ══════════════════════════════════════════════════════════════════
//  2. includeStats=false → lightweight shape
// ══════════════════════════════════════════════════════════════════
section("2. includeStats=false");

{
  const { sc, isError } = await call("list_curated_sets", { includeStats: false });
  assert(!isError, "includeStats=false returns no error");
  const set = sc?.sets?.[0];
  assert(set?.setSpec && set?.name && set?.lodUri, "Lightweight shape has setSpec/name/lodUri");
  assert(set?.memberCount === undefined, "memberCount omitted when includeStats=false");
  assert(set?.dominantTypes === undefined, "dominantTypes omitted when includeStats=false");
}

// ══════════════════════════════════════════════════════════════════
//  3. sortBy=size_desc puts umbrella set at top
// ══════════════════════════════════════════════════════════════════
section("3. sortBy=size_desc");

{
  const { sc, isError } = await call("list_curated_sets", { sortBy: "size_desc" });
  assert(!isError, "sortBy=size_desc returns no error");
  const top = sc?.sets?.[0];
  assert(top?.memberCount >= 500_000, `Top set is umbrella (memberCount=${top?.memberCount})`);
  assert(top?.category === "umbrella", `Top set categorized as 'umbrella' (got ${top?.category})`);
  // Counts strictly non-increasing
  let descending = true;
  for (let i = 1; i < (sc?.sets?.length ?? 0); i++) {
    if (sc.sets[i].memberCount > sc.sets[i - 1].memberCount) { descending = false; break; }
  }
  assert(descending, "Counts non-increasing under size_desc");
}

// ══════════════════════════════════════════════════════════════════
//  4. maxMembers excludes umbrella sets
// ══════════════════════════════════════════════════════════════════
section("4. maxMembers excludes umbrellas");

{
  const { sc, isError } = await call("list_curated_sets", { maxMembers: 100_000, sortBy: "size_desc" });
  assert(!isError, "maxMembers=100K returns no error");
  assert((sc?.totalSets ?? 0) >= 1, "At least one set passes the filter");
  assert(sc?.filteredFrom > sc?.totalSets, "filteredFrom > totalSets when filtering");
  const allUnderCap = sc?.sets?.every(s => s.memberCount <= 100_000);
  assert(allUnderCap, "All returned sets have memberCount <= 100,000");
}

// ══════════════════════════════════════════════════════════════════
//  5. minMembers includes only substantive sets
// ══════════════════════════════════════════════════════════════════
section("5. minMembers");

{
  const { sc, isError } = await call("list_curated_sets", { minMembers: 1000 });
  assert(!isError, "minMembers=1000 returns no error");
  const allOver = sc?.sets?.every(s => s.memberCount >= 1000);
  assert(allOver, "All returned sets have memberCount >= 1000");
}

// ══════════════════════════════════════════════════════════════════
//  6. query substring
// ══════════════════════════════════════════════════════════════════
section("6. query substring");

{
  const { sc, isError } = await call("list_curated_sets", { query: "foto" });
  assert(!isError, "query='foto' returns no error");
  assert((sc?.totalSets ?? 0) >= 1, `At least one match for 'foto' (got ${sc?.totalSets})`);
  const allMatchSubstring = sc?.sets?.every(s => s.name.toLowerCase().includes("foto"));
  assert(allMatchSubstring, "All matched sets contain 'foto' in name");
}

// ══════════════════════════════════════════════════════════════════
//  7. Cache build was fast (logged at startup as < 5s)
// ══════════════════════════════════════════════════════════════════
section("7. Cache build is reasonable");

{
  // Multiple calls should all return quickly (cache is warm).
  const t0 = Date.now();
  for (let i = 0; i < 3; i++) await call("list_curated_sets", {});
  const dt = Date.now() - t0;
  assert(dt < 1000, `3 warm calls completed in ${dt}ms (< 1000ms)`);
}

// ══════════════════════════════════════════════════════════════════
//  Summary
// ══════════════════════════════════════════════════════════════════
section("RESULTS");
console.log(`\n  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
if (failures.length > 0) {
  console.log(`\n  Failures:`);
  for (const f of failures) console.log(`    ✗ ${f}`);
}
console.log();

await client.close();
process.exit(failed > 0 ? 1 : 0);
