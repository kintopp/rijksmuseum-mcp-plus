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
  return { text, isError: !!r.isError, structured: r.structuredContent };
}

// (no separate raw-request helper needed — the SDK surfaces server-side Zod rejections
// either as a thrown error or as { isError: true } on the tool result; both shapes are
// caught in section 12 below.)

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
//  6. Structured output: material (multi-valued vocab dim)
// ══════════════════════════════════════════════════════════════════
section("6. Structured output: material (multi-valued)");

{
  const { isError, structured, text } = await call("collection_stats", { dimension: "material", topN: 10 });
  assert(!isError, "material returns no error");
  assert(!!structured, "structuredContent present");
  if (structured) {
    assert(structured.dimension === "material", `dimension === "material" (got ${structured.dimension})`);
    assert(structured.denominatorScope === "artwork", `denominatorScope === "artwork" (got ${structured.denominatorScope})`);
    assert(structured.multiValued === true, `multiValued === true (got ${structured.multiValued})`);
    assert(structured.groupingKey === "label", `groupingKey === "label" (got ${structured.groupingKey})`);
    assert(structured.ordering === "count_desc", `ordering === "count_desc" (got ${structured.ordering})`);
    assert(typeof structured.totalBuckets === "number" && structured.totalBuckets > 0, `totalBuckets > 0 (got ${structured.totalBuckets})`);
    assert(structured.coverage.withBucket + structured.coverage.withoutBucket === structured.total,
      `coverage withBucket+withoutBucket === total (${structured.coverage.withBucket}+${structured.coverage.withoutBucket} vs ${structured.total})`);
    assert(structured.bucketUnit === undefined, `bucketUnit absent for vocab dim (got ${structured.bucketUnit})`);
    assert(structured.entries.length === 10, `entries.length === topN (got ${structured.entries.length})`);
  }
  assert(text.includes("multi-valued"), "Text channel includes multi-valued hint");
}

// ══════════════════════════════════════════════════════════════════
//  7. Structured output: decade (single-valued ordinal) + sortBy override
// ══════════════════════════════════════════════════════════════════
section("7. Structured output: decade + sortBy override");

{
  const { isError, structured } = await call("collection_stats", { dimension: "decade", topN: 10 });
  assert(!isError, "decade default returns no error");
  if (structured) {
    assert(structured.multiValued === false, `multiValued === false (got ${structured.multiValued})`);
    assert(structured.groupingKey === "computed_bucket", `groupingKey === "computed_bucket" (got ${structured.groupingKey})`);
    assert(structured.ordering === "label_asc", `default ordering === "label_asc" (got ${structured.ordering})`);
    assert(structured.bucketUnit === "year", `bucketUnit === "year" (got ${structured.bucketUnit})`);
    assert(structured.bucketWidth === 10, `bucketWidth === 10 (got ${structured.bucketWidth})`);
    // Ascending label order
    const labels = structured.entries.map(e => Number(e.label));
    let ascending = true;
    for (let i = 1; i < labels.length; i++) if (labels[i] < labels[i - 1]) { ascending = false; break; }
    assert(ascending, `Default entries ascend by label: ${labels.slice(0, 5).join(", ")}`);
  }
}

{
  const { isError, structured } = await call("collection_stats", { dimension: "decade", topN: 10, sortBy: "count" });
  assert(!isError, "decade sortBy=count returns no error");
  if (structured) {
    assert(structured.ordering === "count_desc", `sortBy override → ordering === "count_desc" (got ${structured.ordering})`);
    const counts = structured.entries.map(e => e.count);
    let descending = true;
    for (let i = 1; i < counts.length; i++) if (counts[i] > counts[i - 1]) { descending = false; break; }
    assert(descending, `sortBy=count: entries descend by count: ${counts.slice(0, 5).join(", ")}`);
  }
}

// ══════════════════════════════════════════════════════════════════
//  8. Structured output: exhibition (entity grouping)
// ══════════════════════════════════════════════════════════════════
section("8. Structured output: exhibition (groupingKey=entity)");

{
  const { isError, structured } = await call("collection_stats", { dimension: "exhibition", topN: 5 });
  assert(!isError, "exhibition returns no error");
  if (structured) {
    assert(structured.groupingKey === "entity", `groupingKey === "entity" (got ${structured.groupingKey})`);
    assert(structured.multiValued === true, `multiValued === true (got ${structured.multiValued})`);
  }
}

// ══════════════════════════════════════════════════════════════════
//  9. Structured output: decadeModified bucketDomain + clamp residual
// ══════════════════════════════════════════════════════════════════
section("9. Structured output: decadeModified bucketDomain");

{
  const { isError, structured, text } = await call("collection_stats", { dimension: "decadeModified" });
  assert(!isError, "decadeModified returns no error");
  if (structured) {
    assert(structured.bucketDomain?.min === 1990, `bucketDomain.min === 1990 (got ${structured.bucketDomain?.min})`);
    assert(structured.bucketDomain?.maxExclusive === 2030, `bucketDomain.maxExclusive === 2030 (got ${structured.bucketDomain?.maxExclusive})`);
    // Residual should be >0 since ~318K artworks have NULL record_modified (verified against local DB)
    assert(structured.coverage.withoutBucket > 0,
      `coverage.withoutBucket > 0 (got ${structured.coverage.withoutBucket})`);
  }
  assert(/window: 1990–2029/.test(text), "Text channel includes window note");
}

// ══════════════════════════════════════════════════════════════════
//  10. appliedFilters round-trip
// ══════════════════════════════════════════════════════════════════
section("10. appliedFilters round-trip");

{
  const { isError, structured } = await call("collection_stats", {
    dimension: "century", type: "painting", creator: "Rembrandt", topN: 3,
  });
  assert(!isError, "filtered query returns no error");
  if (structured) {
    assert(structured.appliedFilters?.type === "painting", `appliedFilters.type echoed (got ${structured.appliedFilters?.type})`);
    assert(structured.appliedFilters?.creator === "Rembrandt", `appliedFilters.creator echoed (got ${structured.appliedFilters?.creator})`);
    assert(structured.appliedFilters?.topN === undefined, `appliedFilters does NOT include control param topN`);
  }
}

// ══════════════════════════════════════════════════════════════════
//  11. Party-conjunction fix (reviewer Finding 1 on #346)
//  Pre-fix: total could include artworks with party-match on one pp row
//  and positionMethod-match on a different pp row, contributing 0 buckets.
//  Post-fix: total === artworks with both filters on the SAME pp row.
//  Structural invariant always-true: total === withBucket + withoutBucket.
// ══════════════════════════════════════════════════════════════════
section("11. Party-conjunction regression");

{
  const { isError, structured } = await call("collection_stats", {
    dimension: "party", party: "Bredius", positionMethod: "llm_enrichment", topN: 5,
  });
  assert(!isError, "party + positionMethod returns no error");
  if (structured) {
    assert(structured.total === structured.coverage.withBucket + structured.coverage.withoutBucket,
      `total === withBucket + withoutBucket (${structured.total} vs ${structured.coverage.withBucket}+${structured.coverage.withoutBucket})`);
    // For party dimension, withBucket is "artworks with ≥1 matching pp row" — same shape as total
    // post-fix (because filters ARE the same-row conjunction). withoutBucket should be 0.
    assert(structured.coverage.withoutBucket === 0,
      `withoutBucket === 0 for party dim with same-row filters (got ${structured.coverage.withoutBucket})`);
  }
}

// ══════════════════════════════════════════════════════════════════
//  12. Rename rejection — old names removed by Zod .strict()
// ══════════════════════════════════════════════════════════════════
section("12. Rename rejection: dateFrom/dateTo/location no longer accepted");

for (const oldArg of [{ dateFrom: 1700 }, { dateTo: 1800 }, { location: "Amsterdam" }]) {
  const argName = Object.keys(oldArg)[0];
  // The SDK's Zod-strict server-side validation surfaces in one of two shapes:
  //  - thrown error on client.callTool (when the server returns a JSON-RPC error)
  //  - { isError: true } tool result with the error in the content text
  let rejected = false;
  let detail = "";
  try {
    const r = await client.callTool({ name: "collection_stats", arguments: { dimension: "century", ...oldArg } });
    if (r.isError) {
      rejected = true;
      detail = `isError result: ${r.content?.[0]?.text?.slice(0, 80) ?? ""}`;
    }
  } catch (err) {
    rejected = /Unrecognized key|unknown|invalid|strict/i.test(String(err.message ?? err));
    detail = String(err.message ?? err).slice(0, 100);
  }
  assert(rejected, `Old arg "${argName}" rejected (${detail})`);
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
