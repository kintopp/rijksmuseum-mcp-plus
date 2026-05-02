/**
 * Test for search_provenance periodLocation filter (#298, v0.27 cluster D).
 *
 * Verifies:
 *  - periodLocation filters provenance_periods.location at layer="periods"
 *  - location at periods layer continues to work (regression)
 *  - AND-combination of location + periodLocation narrows results
 *  - periodLocation is rejected at layer="events"
 *
 * Run:  node scripts/tests/test-search-provenance-period-location.mjs
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
const client = new Client({ name: "test-search-provenance-period-location", version: "0.1" });
await client.connect(transport);
console.log("Connected to server via stdio\n");

// ══════════════════════════════════════════════════════════════════
//  1. periodLocation filters at layer="periods"
// ══════════════════════════════════════════════════════════════════
section("1. periodLocation at layer=periods");

let baseTotal = 0;
{
  const { sc, isError, text } = await call("search_provenance", {
    layer: "periods", periodLocation: "Amsterdam", maxResults: 5,
  });
  assert(!isError, `periodLocation="Amsterdam" returns no error (text=${text.slice(0, 120)})`);
  assert((sc?.totalArtworks ?? 0) >= 1, `Total artworks >= 1 (got ${sc?.totalArtworks})`);
  baseTotal = sc?.totalArtworks ?? 0;
  // Spot-check: at least one matched period in returned results has location containing 'Amsterdam'
  const periods = (sc?.results ?? []).flatMap(a => a.periods ?? []);
  const matchedPeriods = periods.filter(p => p.matched);
  const hasAmsterdam = matchedPeriods.some(p => (p.location ?? "").toLowerCase().includes("amsterdam"));
  assert(hasAmsterdam, `At least one matched period has location containing 'Amsterdam' (matched=${matchedPeriods.length})`);
}

// ══════════════════════════════════════════════════════════════════
//  2. location at layer=periods still works (regression)
// ══════════════════════════════════════════════════════════════════
section("2. location at layer=periods (regression)");

{
  const { sc, isError } = await call("search_provenance", {
    layer: "periods", location: "Amsterdam", maxResults: 5,
  });
  assert(!isError, "location='Amsterdam' at periods layer returns no error");
  assert((sc?.totalArtworks ?? 0) >= 1, `Total artworks >= 1 (got ${sc?.totalArtworks})`);
  // Should match the same total as periodLocation since both filter pp.location.
  assert(sc?.totalArtworks === baseTotal,
    `location and periodLocation produce same totalArtworks (location=${sc?.totalArtworks}, periodLocation=${baseTotal})`);
}

// ══════════════════════════════════════════════════════════════════
//  3. AND-combination
// ══════════════════════════════════════════════════════════════════
section("3. AND-combination of location + periodLocation");

{
  // Both filter pp.location, so combining with disjoint values should yield 0.
  const { sc, isError } = await call("search_provenance", {
    layer: "periods", location: "Paris", periodLocation: "Amsterdam", maxResults: 5,
  });
  assert(!isError, "location='Paris' + periodLocation='Amsterdam' returns no error");
  assert((sc?.totalArtworks ?? 0) === 0,
    `Disjoint AND yields 0 results (got ${sc?.totalArtworks})`);
}

{
  // Same value on both sides equals the singleton query.
  const { sc, isError } = await call("search_provenance", {
    layer: "periods", location: "Amsterdam", periodLocation: "Amsterdam", maxResults: 5,
  });
  assert(!isError, "Same value on both filters returns no error");
  assert(sc?.totalArtworks === baseTotal,
    `Same-value AND equals singleton (got ${sc?.totalArtworks}, expected ${baseTotal})`);
}

// ══════════════════════════════════════════════════════════════════
//  4. periodLocation is rejected at layer="events"
// ══════════════════════════════════════════════════════════════════
section("4. periodLocation rejected at layer=events");

{
  const { isError, text } = await call("search_provenance", {
    layer: "events", periodLocation: "Amsterdam",
  });
  assert(isError, "periodLocation at layer=events returns isError");
  assert(text.includes("periodLocation"), `Error message mentions periodLocation (text=${text.slice(0, 200)})`);
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
