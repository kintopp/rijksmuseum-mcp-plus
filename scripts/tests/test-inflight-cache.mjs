#!/usr/bin/env node
/**
 * test-inflight-cache.mjs — unit test for getOrComputeWithInflight (#378 Step 4),
 * the cache + in-flight de-dup behind semantic_search. Verifies: cache hit skips
 * recompute, concurrent identical calls coalesce to ONE compute, a different key
 * (e.g. a DB build-id change) misses, and a rejection is neither cached nor left
 * poisoning the in-flight slot.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { ResponseCache } = await import(path.join(PROJECT_DIR, "dist/utils/ResponseCache.js"));
const { getOrComputeWithInflight } = await import(path.join(PROJECT_DIR, "dist/utils/inflightCache.js"));

let passed = 0, failed = 0;
const check = (label, cond) => { if (cond) { console.log(`  ✓ ${label}`); passed++; } else { console.log(`  ✗ ${label}`); failed++; } };
const flush = () => new Promise(r => setTimeout(r, 5)); // drain microtasks (.finally clears in-flight)

const cache = new ResponseCache(100, 60_000);
const inflight = new Map();

console.log("── 1. miss computes once, then hit skips recompute ──");
{
  let calls = 0;
  const compute = () => { calls++; return Promise.resolve("v1"); };
  const r1 = await getOrComputeWithInflight(cache, inflight, "key:A", compute);
  await flush();
  const r2 = await getOrComputeWithInflight(cache, inflight, "key:A", compute);
  check("first call computed", r1 === "v1");
  check("second call returned cached value", r2 === "v1");
  check("compute ran exactly once (2nd was a cache hit)", calls === 1);
  check("in-flight slot freed", inflight.size === 0);
}

console.log("\n── 2. concurrent identical calls coalesce to ONE compute ──");
{
  let calls = 0;
  const compute = () => { calls++; return new Promise(res => setTimeout(() => res("v2"), 10)); };
  const [a, b, c] = await Promise.all([
    getOrComputeWithInflight(cache, inflight, "key:B", compute),
    getOrComputeWithInflight(cache, inflight, "key:B", compute),
    getOrComputeWithInflight(cache, inflight, "key:B", compute),
  ]);
  check("all three callers got the same result", a === "v2" && b === "v2" && c === "v2");
  check("compute ran once for 3 concurrent identical calls", calls === 1);
}

console.log("\n── 3. different key (e.g. DB build-id change) → fresh compute ──");
{
  let calls = 0;
  const compute = () => { calls++; return Promise.resolve(`v-${calls}`); };
  await getOrComputeWithInflight(cache, inflight, "build1|q", compute);
  await flush();
  await getOrComputeWithInflight(cache, inflight, "build2|q", compute); // build-id changed
  check("key change bypassed the cache (recomputed)", calls === 2);
}

console.log("\n── 4. rejection is not cached and frees the in-flight slot ──");
{
  let calls = 0;
  const failOnce = () => { calls++; return calls === 1 ? Promise.reject(new Error("boom")) : Promise.resolve("ok"); };
  let threw = false;
  try { await getOrComputeWithInflight(cache, inflight, "key:E", failOnce); } catch { threw = true; }
  await flush();
  check("rejection propagated to caller", threw);
  check("in-flight slot cleared after rejection", inflight.size === 0);
  const r = await getOrComputeWithInflight(cache, inflight, "key:E", failOnce);
  check("retry recomputed (failure was not cached)", r === "ok" && calls === 2);
}

console.log(`\n${passed} passed${failed ? `, ${failed} failed` : ""}`);
process.exit(failed ? 1 : 0);
