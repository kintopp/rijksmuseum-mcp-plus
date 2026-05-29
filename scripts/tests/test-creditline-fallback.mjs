/**
 * Smoke test for the search_provenance credit-line fallback (creditLineQuery).
 *
 * Verifies:
 *   1. creditLineQuery returns creditLineResults (not results), all event-less.
 *   2. Token-AND matching ("Waller Amsterdam") works order-independently.
 *   3. Structured search_provenance (party) is unchanged — no creditLineResults.
 *   4. Combining creditLineQuery with a structured filter warns + ignores it.
 *
 * Run:  node scripts/tests/test-creditline-fallback.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

let passed = 0, failed = 0;
const failures = [];
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; failures.push(msg); console.log(`  ✗ ${msg}`); }
}
function section(n) { console.log(`\n${"═".repeat(60)}\n  ${n}\n${"═".repeat(60)}`); }
const sc = (r) => r.structuredContent ?? {};

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  cwd: PROJECT_DIR,
  env: { ...process.env, STRUCTURED_CONTENT: "true" },
});
const client = new Client({ name: "test-creditline-fallback", version: "0.1" });
await client.connect(transport);
console.log("Connected to server via stdio\n");

// ── 1. creditLineQuery returns creditLineResults ──
section("1. creditLineQuery → creditLineResults");
const r1 = await client.callTool({ name: "search_provenance", arguments: { creditLineQuery: "Vosmaer", maxResults: 5 } });
const d1 = sc(r1);
assert(Array.isArray(d1.creditLineResults), "creditLineResults present");
assert(d1.creditLineResults?.length > 0, `creditLineResults non-empty (${d1.creditLineResults?.length})`);
assert((d1.results?.length ?? 0) === 0, "results[] is empty for credit-line mode");
assert(d1.creditLineResults?.every(r => typeof r.creditLine === "string" && r.creditLine.length > 0), "every row has a creditLine string");
assert(d1.creditLineResults?.every(r => /vosmaer/i.test(r.creditLine)), "every creditLine matches the query term");
assert(/unstructured/i.test(r1.content?.[0]?.text ?? ""), "text channel flags UNSTRUCTURED source");

// ── 2. token-AND order independence ──
section("2. token-AND matching");
const r2 = await client.callTool({ name: "search_provenance", arguments: { creditLineQuery: "Waller Amsterdam", maxResults: 5 } });
const d2 = sc(r2);
assert(d2.creditLineResults?.length > 0, `'Waller Amsterdam' matched (${d2.creditLineResults?.length})`);
assert(d2.creditLineResults?.every(r => /waller/i.test(r.creditLine) && /amsterdam/i.test(r.creditLine)), "every match contains both tokens");

// ── 3. structured search unaffected ──
section("3. structured party search unchanged");
const r3 = await client.callTool({ name: "search_provenance", arguments: { party: "Six", maxResults: 2 } });
const d3 = sc(r3);
assert(d3.creditLineResults === undefined, "no creditLineResults on a structured search");
assert(Array.isArray(d3.results), "results[] present on structured search");
assert(d3.results?.every(a => Array.isArray(a.events)), "structured results carry events");

// ── 4. creditLineQuery + structured filter → warn + ignore ──
section("4. creditLineQuery + structured filter");
const r4 = await client.callTool({ name: "search_provenance", arguments: { creditLineQuery: "Waller", party: "Six", transferType: "gift" } });
const d4 = sc(r4);
assert(Array.isArray(d4.creditLineResults), "credit-line mode still runs");
assert((d4.warnings ?? []).some(w => /ignored/i.test(w) && /party/.test(w)), "warns that structured filters were ignored");

console.log(`\n${"═".repeat(60)}\n  ${passed} passed, ${failed} failed`);
if (failures.length) { console.log("\nFailures:"); failures.forEach(f => console.log(`  ✗ ${f}`)); }
await client.close();
process.exit(failed ? 1 : 0);
