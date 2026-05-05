/**
 * Unit tests for lruGetOrCreate (issue #79).
 *
 * Run:  node scripts/tests/test-lru-cache.mjs
 * Requires: npm run build (imports from dist/)
 */
import { lruGetOrCreate } from "../../dist/api/VocabularyDb.js";

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

function assertEq(actual, expected, msg) {
  const ok = actual === expected;
  assert(ok, ok ? msg : `${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertDeepEq(actual, expected, msg) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(ok, ok ? msg : `${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

console.log("\n── lruGetOrCreate ────────────────────────────────────────────");

// 1. Miss invokes factory; subsequent hit does not.
{
  const map = new Map();
  let factoryCalls = 0;
  const v1 = lruGetOrCreate(map, "k", () => { factoryCalls++; return "v"; }, 10);
  assertEq(v1, "v", "miss returns factory output");
  assertEq(factoryCalls, 1, "factory called once on miss");
  const v2 = lruGetOrCreate(map, "k", () => { factoryCalls++; return "other"; }, 10);
  assertEq(v2, "v", "hit returns cached value");
  assertEq(factoryCalls, 1, "factory NOT called on hit");
}

// 2. Cache grows up to cap without eviction.
{
  const map = new Map();
  for (let i = 0; i < 5; i++) lruGetOrCreate(map, `k${i}`, () => i, 5);
  assertEq(map.size, 5, "cache fills exactly to cap");
  assertDeepEq([...map.keys()], ["k0", "k1", "k2", "k3", "k4"], "insertion order preserved");
}

// 3. Inserting beyond cap evicts the oldest (FIFO when nothing was touched).
{
  const map = new Map();
  for (let i = 0; i < 5; i++) lruGetOrCreate(map, `k${i}`, () => i, 5);
  lruGetOrCreate(map, "k5", () => 5, 5);
  assertEq(map.size, 5, "size stays at cap after one overflow insert");
  assert(!map.has("k0"), "oldest entry (k0) evicted");
  assert(map.has("k5"), "newest entry (k5) present");
  assertDeepEq([...map.keys()], ["k1", "k2", "k3", "k4", "k5"], "post-eviction order = oldest dropped");
}

// 4. Hit on an existing key bumps it to most-recent → it survives the next eviction.
{
  const map = new Map();
  for (let i = 0; i < 5; i++) lruGetOrCreate(map, `k${i}`, () => i, 5);
  // Touch k0 — it should move to most-recent.
  lruGetOrCreate(map, "k0", () => { throw new Error("factory must not run on hit"); }, 5);
  assertDeepEq([...map.keys()], ["k1", "k2", "k3", "k4", "k0"], "hit on k0 bumps it to tail");
  // Now overflow: k1 should be evicted (it's the oldest), not k0.
  lruGetOrCreate(map, "k5", () => 5, 5);
  assert(map.has("k0"), "recently-touched k0 survives eviction");
  assert(!map.has("k1"), "k1 (now-oldest) evicted instead");
  assertDeepEq([...map.keys()], ["k2", "k3", "k4", "k0", "k5"], "LRU order maintained");
}

// 5. Repeated overflow keeps size pinned at cap.
{
  const map = new Map();
  for (let i = 0; i < 1000; i++) lruGetOrCreate(map, `k${i}`, () => i, 256);
  assertEq(map.size, 256, "1000 inserts × cap=256 → size stays at 256");
  // Only the last 256 keys should remain.
  assert(map.has("k999"), "most recent insert present");
  assert(map.has("k744"), "boundary entry (k1000-256=k744) present");
  assert(!map.has("k743"), "k743 (one past boundary) evicted");
  assert(!map.has("k0"), "very first entry evicted");
}

// 6. Non-string keys work (Map preserves insertion order for any key type).
{
  const map = new Map();
  const k1 = { id: 1 }, k2 = { id: 2 }, k3 = { id: 3 };
  lruGetOrCreate(map, k1, () => "a", 2);
  lruGetOrCreate(map, k2, () => "b", 2);
  lruGetOrCreate(map, k3, () => "c", 2);
  assertEq(map.size, 2, "object keys honour cap");
  assert(!map.has(k1), "first object key evicted");
  assert(map.has(k2) && map.has(k3), "newer object keys retained");
}

// 7. cap=0 evicts immediately (degenerate but well-defined).
{
  const map = new Map();
  lruGetOrCreate(map, "x", () => 1, 0);
  assertEq(map.size, 0, "cap=0 evicts on every insert");
}

// ── Summary ───────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
