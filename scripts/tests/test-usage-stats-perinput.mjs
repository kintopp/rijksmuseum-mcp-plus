#!/usr/bin/env node
/**
 * test-usage-stats-perinput.mjs — unit test for the #378 slow-query
 * instrumentation added to UsageStats: per-(tool, canonical input) histogram
 * percentiles + repeat counts, per-(tool, phase) timings, and the bounded
 * (LRU-capped) per-tool input map. In-memory only; nothing is persisted.
 */
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { UsageStats } = await import(path.join(PROJECT_DIR, "dist/utils/UsageStats.js"));

let passed = 0, failed = 0;
function check(label, cond) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.log(`  ✗ ${label}`); failed++; }
}

// Isolate from the real data/usage-stats.json — flush() is never called here anyway.
const stats = new UsageStats(path.join(os.tmpdir(), `usage-stats-test-${process.pid}.json`));

console.log("── 1. recordInput histogram percentiles + repeats ──");
{
  // 85 fast (5ms) + 15 slow (5000ms): p50 in the 5ms bucket, p90 in the 5000ms bucket.
  for (let i = 0; i < 85; i++) stats.recordInput("collection_stats", "dimension=\"type\"", 5);
  for (let i = 0; i < 15; i++) stats.recordInput("collection_stats", "dimension=\"type\"", 5000);
  const snap = stats.slowQueries(1000);
  const row = snap.perInput["collection_stats"].find(r => r.input === 'dimension="type"');
  check("count == 100", row.count === 100);
  check("repeats == 99", row.repeats === 99);
  check("p50 == 5 (bucketed)", row.p50 === 5);
  check("p90 == 5000 (bucketed)", row.p90 === 5000);
  check("max == 5000", row.max === 5000);
}

console.log("\n── 2. overflow bucket reports exact max ──");
{
  stats.recordInput("semantic_search", "query=\"x\"", 45000); // > top bucket (30000)
  const row = stats.slowQueries(1000).perInput["semantic_search"].find(r => r.input === 'query="x"');
  check("p50 == 45000 (exact max for overflow)", row.p50 === 45000);
  check("max == 45000", row.max === 45000);
}

console.log("\n── 3. per-tool input map is LRU-capped at 200 ──");
{
  for (let i = 0; i < 250; i++) stats.recordInput("lru_tool", `k${i}`, 10);
  const rows = stats.slowQueries(1000).perInput["lru_tool"];
  const inputs = new Set(rows.map(r => r.input));
  check("retains exactly 200 inputs (cap)", rows.length === 200);
  check("evicted oldest (k0 absent)", !inputs.has("k0"));
  check("evicted k49 (absent)", !inputs.has("k49"));
  check("kept k50 (present)", inputs.has("k50"));
  check("kept newest k249 (present)", inputs.has("k249"));
}

console.log("\n── 4. recordPhase aggregates per (tool, phase) ──");
{
  for (let i = 0; i < 10; i++) stats.recordPhase("search_artwork", "main", 100);
  for (let i = 0; i < 10; i++) stats.recordPhase("search_artwork", "facets", 5000);
  const ph = stats.slowQueries().phases["search_artwork"];
  check("main phase recorded", ph.main.count === 10 && ph.main.p50 === 100);
  check("facets phase recorded", ph.facets.count === 10 && ph.facets.p50 === 5000);
  check("facets dominates main (p50)", ph.facets.p50 > ph.main.p50);
}

console.log("\n── 5. topPerTool keeps the slowest inputs ──");
{
  // Record the slowest inputs first so insertion order can't stand in for the sort.
  for (let i = 0; i < 20; i++) stats.recordInput("top_tool", `t${i}`, 1000 - i * 10);
  const top = stats.slowQueries(5).perInput["top_tool"].map(r => r.input);
  check("top_tool sliced to the 5 slowest, slowest first",
    JSON.stringify(top) === JSON.stringify(["t0", "t1", "t2", "t3", "t4"]));
  for (let i = 0; i < 20; i++) stats.recordInput("rev_tool", `r${i}`, 10 + i * 10);
  const rev = stats.slowQueries(3).perInput["rev_tool"].map(r => r.input);
  check("slowest-first holds when the slowest arrive last",
    JSON.stringify(rev) === JSON.stringify(["r19", "r18", "r17"]));
}

console.log(`\n${passed} passed${failed ? `, ${failed} failed` : ""}`);
process.exit(failed ? 1 : 0);
