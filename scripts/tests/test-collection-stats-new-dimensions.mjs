/**
 * Test for collection_stats new dimensions (#299, v0.27 cluster D):
 *  - theme (NL-labeled until #300 backfill)
 *  - exhibition (top exhibitions by member count)
 *  - decadeModified (record_modified bucketed by decade, clamped 1990–2030)
 *
 * Run:  node scripts/tests/test-collection-stats-new-dimensions.mjs
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
  return { text, isError: !!r.isError };
}

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  cwd: PROJECT_DIR,
  env: { ...process.env, STRUCTURED_CONTENT: "true" },
});
const client = new Client({ name: "test-collection-stats-new-dimensions", version: "0.1" });
await client.connect(transport);
console.log("Connected to server via stdio\n");

// ══════════════════════════════════════════════════════════════════
//  1. theme dimension
// ══════════════════════════════════════════════════════════════════
section("1. theme dimension");

{
  const { text, isError } = await call("collection_stats", { dimension: "theme", topN: 20 });
  assert(!isError, "theme dimension returns no error");
  // Expected NL-labeled top theme: 'overzeese geschiedenis'
  assert(text.includes("overzeese geschiedenis"),
    `Top theme 'overzeese geschiedenis' present (text head=${text.slice(0, 200)})`);
  // Should have ~20 entries — entries are indented "  LABEL  COUNT  (PCT%)" lines
  const entryLines = text.split("\n").filter(l => /^\s+\S.*\d+(,\d+)*\s+\(\d/.test(l));
  assert(entryLines.length >= 15 && entryLines.length <= 25,
    `Entry count plausible (~20, got ${entryLines.length})`);
}

// ══════════════════════════════════════════════════════════════════
//  2. exhibition dimension
// ══════════════════════════════════════════════════════════════════
section("2. exhibition dimension");

{
  const { text, isError } = await call("collection_stats", { dimension: "exhibition", topN: 10 });
  assert(!isError, "exhibition dimension returns no error");
  // Counts appear before "(PCT%)" — match digits with optional thousands separators
  const counts = [...text.matchAll(/(\d{1,3}(?:,\d{3})*)\s+\(\d/g)]
    .map(m => parseInt(m[1].replace(/,/g, ""), 10))
    .filter(n => !isNaN(n));
  assert(counts.length >= 5, `At least 5 exhibitions returned (got ${counts.length})`);
  // Sorted descending
  let descending = true;
  for (let i = 1; i < counts.length; i++) {
    if (counts[i] > counts[i - 1]) { descending = false; break; }
  }
  assert(descending, `Counts are non-increasing: ${counts.slice(0, 6).join(", ")}`);
}

// ══════════════════════════════════════════════════════════════════
//  3. decadeModified dimension — bounded to 1990–2030
// ══════════════════════════════════════════════════════════════════
section("3. decadeModified dimension");

{
  const { text, isError } = await call("collection_stats", { dimension: "decadeModified" });
  assert(!isError, "decadeModified dimension returns no error");
  // Decades appear at the start of each indented entry line: "  1990   1,202  (0.1%)"
  const decades = [...text.matchAll(/^\s+(\d{4})\s+\d/gm)].map(m => parseInt(m[1], 10));
  assert(decades.length >= 1, `At least one decade bucket (got ${decades.length})`);
  const allInRange = decades.every(d => d >= 1990 && d < 2030);
  assert(allInRange, `All decades within 1990–2030 (got ${decades.join(", ")})`);
}

// ══════════════════════════════════════════════════════════════════
//  4. Filter combination: exhibition + creator
// ══════════════════════════════════════════════════════════════════
section("4. Filter combination: exhibition + creator");

{
  const { text, isError } = await call("collection_stats", {
    dimension: "exhibition", creator: "Rembrandt", topN: 10,
  });
  assert(!isError, "exhibition + creator filter returns no error");
  // Same regex as #2: counts before "(PCT%)"
  const counts = [...text.matchAll(/(\d{1,3}(?:,\d{3})*)\s+\(\d/g)]
    .map(m => parseInt(m[1].replace(/,/g, ""), 10))
    .filter(n => !isNaN(n));
  if (counts.length > 0) {
    assert(counts.every(c => c > 0), `All counts > 0 (sample: ${counts.slice(0, 3).join(", ")})`);
  } else {
    assert(true, "No Rembrandt exhibitions in dataset (acceptable)");
  }
}

// ══════════════════════════════════════════════════════════════════
//  5. Regression: existing dimension (century) still works
// ══════════════════════════════════════════════════════════════════
section("5. Regression: century dimension");

{
  const { text, isError } = await call("collection_stats", { dimension: "century", topN: 5 });
  assert(!isError, "century dimension still works");
  assert(/^\s+\S.*\d+(,\d+)*\s+\(\d/m.test(text), "Returns formatted entries");
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
