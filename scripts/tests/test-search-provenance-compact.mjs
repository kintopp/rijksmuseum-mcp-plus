/**
 * Test for search_provenance compact mode (#386).
 *
 * Compact mode omits the full per-event/period arrays and instead returns a
 * fixed-size `summary` rollup plus lean `matchedEvents` one-liners, so a single
 * call can compare a dealer/collector across many works (full mode overflows the
 * tool-result cap past ~1 artwork). Verifies:
 *  - compact results carry summary + matchedEvents and NO events array
 *  - full mode (no compact) is unchanged — events array still present
 *  - compact mode is materially smaller per artwork than full mode
 *  - the ≥1-filter guard still rejects a compact-only call (compact is a modifier)
 *
 * Run:  node scripts/tests/test-search-provenance-compact.mjs
 * Requires: npm run build first + local data/vocabulary.db.
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

/** Rough channel size = structuredContent JSON + text channel, in characters. */
function channelSize({ text, structured }) {
  return (text?.length ?? 0) + (structured ? JSON.stringify(structured).length : 0);
}

const DEALER = "Goudstikker";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  cwd: PROJECT_DIR,
  env: { ...process.env, STRUCTURED_CONTENT: "true" },
});
const client = new Client({ name: "test-search-provenance-compact", version: "0.1" });
await client.connect(transport);
console.log("Connected to server via stdio\n");

// ══════════════════════════════════════════════════════════════════
//  1. Compact mode shape — summary + matchedEvents, no events array
// ══════════════════════════════════════════════════════════════════
section("1. Compact mode shape");

const compactRes = await call("search_provenance", { party: DEALER, compact: true, maxResults: 5 });
{
  assert(!compactRes.isError, "compact call returns no error");
  const results = compactRes.structured?.results ?? [];
  assert(results.length > 0, `compact returns at least one artwork (got ${results.length})`);
  assert(results.every(r => r.summary && typeof r.summary === "object"),
    "every compact result has a summary object");
  assert(results.every(r => Array.isArray(r.matchedEvents)),
    "every compact result has a matchedEvents array");
  assert(results.every(r => r.events === undefined),
    "compact results omit the full events array");
  assert(results.every(r => r.periods === undefined),
    "compact results omit the full periods array");
  const s = results[0].summary;
  assert(Array.isArray(s.yearSpan) && s.yearSpan.length === 2,
    "summary.yearSpan is a 2-element [earliest, latest] array");
  assert(Array.isArray(s.transferTypes), "summary.transferTypes is an array");
  assert(typeof s.eventCount === "number" && typeof s.matchedEventCount === "number",
    "summary carries eventCount + matchedEventCount");
  assert(typeof s.hasGap === "boolean" && typeof s.hasPrice === "boolean",
    "summary carries hasGap + hasPrice booleans");
  // matchedEvents must be the lean shape: party names are plain strings, no nested objects
  const me = results.flatMap(r => r.matchedEvents);
  assert(me.every(e => e.parties.every(p => typeof p === "string")),
    "matchedEvents parties are name strings only");
  assert(me.every(e => typeof e.rawText === "string"),
    "matchedEvents carry a rawText 'why it matched' phrase");
}

// ══════════════════════════════════════════════════════════════════
//  2. Full mode unchanged — events array still present
// ══════════════════════════════════════════════════════════════════
section("2. Full mode unchanged");

const fullRes = await call("search_provenance", { party: DEALER, maxResults: 1 });
{
  assert(!fullRes.isError, "full call returns no error");
  const results = fullRes.structured?.results ?? [];
  assert(results.length > 0, "full returns at least one artwork");
  assert(Array.isArray(results[0].events) && results[0].events.length > 0,
    "full-mode result carries the full events array");
  assert(results[0].summary === undefined && results[0].matchedEvents === undefined,
    "full-mode result has NO compact-only summary/matchedEvents fields");
}

// SK-A-2344 (rich chain) — the plan's explicit full-mode-unchanged check.
{
  const r = await call("search_provenance", { objectNumber: "SK-A-2344" });
  const ev = r.structured?.results?.[0]?.events;
  assert(Array.isArray(ev) && ev.length > 0,
    `objectNumber SK-A-2344 still returns a full events chain (got ${ev?.length ?? 0})`);
}

// ══════════════════════════════════════════════════════════════════
//  3. Size win — compact is materially smaller per artwork
// ══════════════════════════════════════════════════════════════════
section("3. Size win");
{
  const compactSize = channelSize(compactRes);                       // 5 artworks
  const fullSize = channelSize(fullRes);                             // 1 artwork
  const compactPerArtwork = compactSize / (compactRes.structured?.results?.length || 1);
  const fullPerArtwork = fullSize / (fullRes.structured?.results?.length || 1);
  console.log(`  compact: ${compactSize} chars / ${compactRes.structured?.results?.length} works = ${Math.round(compactPerArtwork)} per work`);
  console.log(`  full:    ${fullSize} chars / ${fullRes.structured?.results?.length} work  = ${Math.round(fullPerArtwork)} per work`);
  assert(compactPerArtwork < fullPerArtwork,
    "compact mode is smaller per artwork than full mode");
}

// ══════════════════════════════════════════════════════════════════
//  4. compact is a modifier — cannot satisfy the ≥1-filter guard alone
// ══════════════════════════════════════════════════════════════════
section("4. compact-only is rejected by the filter guard");
{
  const r = await call("search_provenance", { compact: true });
  assert(r.isError || /at least one search filter/i.test(r.text),
    "compact:true with no real filter is rejected (modifier, not a filter)");
}

// ── Summary ──────────────────────────────────────────────────────
console.log(`\n${"═".repeat(60)}\n  RESULTS\n${"═".repeat(60)}\n`);
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
if (failures.length) {
  console.log("\n  Failures:");
  for (const f of failures) console.log(`    - ${f}`);
}

await client.close();
process.exit(failed > 0 ? 1 : 0);
