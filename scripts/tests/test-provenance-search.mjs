/**
 * Integration test for search_provenance tool.
 *
 * Tests structured provenance search: party lookup, transfer type filters,
 * date ranges, objectNumber fast path, cross-references, and parse audit.
 *
 * Run:  node scripts/tests/test-provenance-search.mjs
 * Requires: npm run build first, vocabulary.db with provenance_events table
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// ── Test helpers ──────────────────────────────────────────────────

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

async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? "";
  const sc = r.structuredContent ?? null;
  return { text, sc, isError: !!r.isError };
}

// ── Connect ───────────────────────────────────────────────────────

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  cwd: PROJECT_DIR,
  env: { ...process.env, STRUCTURED_CONTENT: "true" },
});

const client = new Client({ name: "test-provenance-search", version: "0.1" });
await client.connect(transport);
console.log("Connected to server via stdio\n");

// ══════════════════════════════════════════════════════════════════
//  1. Tool listing & schema validation
// ══════════════════════════════════════════════════════════════════

section("1. Tool listing & schema");

const { tools } = await client.listTools();
const tool = tools.find(t => t.name === "search_provenance");
assert(!!tool, "search_provenance is listed in tools");

if (tool) {
  const inputStr = JSON.stringify(tool.inputSchema);
  assert(!inputStr.includes('"$ref"'), "No $ref in inputSchema");

  if (tool.outputSchema) {
    const outputStr = JSON.stringify(tool.outputSchema);
    assert(!outputStr.includes('"$ref"'), "No $ref in outputSchema");
  } else {
    assert(false, "outputSchema should be present");
  }
}

// ══════════════════════════════════════════════════════════════════
//  2. No filter → error
// ══════════════════════════════════════════════════════════════════

section("2. No filter → error");

{
  const { isError } = await call("search_provenance", {});
  assert(isError, "Empty args returns isError");
}

// ══════════════════════════════════════════════════════════════════
//  3. objectNumber fast path
// ══════════════════════════════════════════════════════════════════

section("3. objectNumber fast path");

{
  // SK-A-4050 = Rembrandt Self-portrait as Apostle Paul (rich provenance)
  const { sc, isError } = await call("search_provenance", { objectNumber: "SK-A-4050" });
  assert(!isError, "No error for valid objectNumber");
  assert(sc?.totalArtworks === 1, "totalArtworks === 1");
  assert(sc?.results?.length === 1, "One artwork in results");

  const artwork = sc?.results?.[0];
  assert(artwork?.objectNumber === "SK-A-4050", "Correct objectNumber returned");
  assert(artwork?.events?.length > 0, "Has events");
  assert(artwork?.eventCount === artwork?.events?.length, "eventCount matches events.length");

  // All events should be matched (objectNumber fast path)
  const allMatched = artwork?.events?.every(e => e.matched === true);
  assert(allMatched, "All events matched: true (objectNumber fast path)");
}

{
  // Non-existent artwork
  const { sc, isError } = await call("search_provenance", { objectNumber: "NONEXISTENT-999" });
  assert(!isError, "No error for missing objectNumber");
  assert(sc?.totalArtworks === 0, "totalArtworks === 0 for missing artwork");
  assert(sc?.results?.length === 0, "Empty results for missing artwork");
}

// ══════════════════════════════════════════════════════════════════
//  4. Party search
// ══════════════════════════════════════════════════════════════════

section("4. Party search");

{
  const { sc, isError } = await call("search_provenance", { party: "Six" });
  assert(!isError, "No error for party search");
  assert(sc?.totalArtworks >= 1, `totalArtworks >= 1 (got ${sc?.totalArtworks})`);

  // At least one matched event should contain "Six" in parties
  const hasMatchedSix = sc?.results?.some(a =>
    a.events.some(e => e.matched && e.parties.some(p => p.name.includes("Six")))
  );
  assert(hasMatchedSix, "At least one matched event has party containing 'Six'");

  // Full chain: some events should not match
  const hasUnmatchedEvent = sc?.results?.some(a =>
    a.events.some(e => !e.matched)
  );
  assert(hasUnmatchedEvent, "Full chain includes unmatched events");
}

// ══════════════════════════════════════════════════════════════════
//  5. Transfer type filter
// ══════════════════════════════════════════════════════════════════

section("5. Transfer type filter");

{
  const { sc, isError } = await call("search_provenance", { transferType: "confiscation" });
  assert(!isError, "No error for transferType search");
  assert(sc?.totalArtworks >= 1, `totalArtworks >= 1 (got ${sc?.totalArtworks})`);

  // All matched events must be confiscation
  const matchedEvents = sc?.results?.flatMap(a => a.events.filter(e => e.matched)) ?? [];
  const allCorrectType = matchedEvents.every(e => e.transferType === "confiscation");
  assert(allCorrectType, "All matched events have transferType 'confiscation'");
}

// ══════════════════════════════════════════════════════════════════
//  6. Date range
// ══════════════════════════════════════════════════════════════════

section("6. Date range");

{
  const { sc, isError } = await call("search_provenance", { dateFrom: 1940, dateTo: 1945 });
  assert(!isError, "No error for date range search");
  assert(sc?.totalArtworks >= 1, `totalArtworks >= 1 (got ${sc?.totalArtworks})`);

  const matchedEvents = sc?.results?.flatMap(a => a.events.filter(e => e.matched)) ?? [];
  const allInRange = matchedEvents.every(e =>
    e.dateYear != null && e.dateYear >= 1940 && e.dateYear <= 1945
  );
  assert(allInRange, "All matched events have dateYear in 1940–1945");
}

// ══════════════════════════════════════════════════════════════════
//  7. Combined filters
// ══════════════════════════════════════════════════════════════════

section("7. Combined filters (location + transferType)");

{
  const { sc, isError } = await call("search_provenance", {
    location: "Amsterdam",
    transferType: "sale",
    maxResults: 3,
  });
  assert(!isError, "No error for combined filter");
  assert(sc?.results?.length <= 3, `maxResults respected (got ${sc?.results?.length})`);

  const matchedEvents = sc?.results?.flatMap(a => a.events.filter(e => e.matched)) ?? [];
  const allCorrect = matchedEvents.every(e =>
    e.transferType === "sale" && e.location?.includes("Amsterdam")
  );
  assert(allCorrect, "All matched events are sales in Amsterdam");
}

// ══════════════════════════════════════════════════════════════════
//  8. hasPrice filter
// ══════════════════════════════════════════════════════════════════

section("8. hasPrice filter");

{
  const { sc, isError } = await call("search_provenance", { hasPrice: true, maxResults: 5 });
  assert(!isError, "No error for hasPrice search");

  const matchedEvents = sc?.results?.flatMap(a => a.events.filter(e => e.matched)) ?? [];
  const allHavePrice = matchedEvents.every(e => e.price != null);
  assert(allHavePrice, "All matched events have price data");

  // Check price structure
  const firstPrice = matchedEvents[0]?.price;
  if (firstPrice) {
    assert(typeof firstPrice.amount === "number", "price.amount is a number");
    assert(typeof firstPrice.currency === "string", "price.currency is a string");
  }
}

// ══════════════════════════════════════════════════════════════════
//  9. relatedTo (reverse cross-ref)
// ══════════════════════════════════════════════════════════════════

section("9. relatedTo (reverse cross-ref)");

{
  // SK-A-4753 is known to be cross-referenced by SK-A-4754
  const { sc, isError } = await call("search_provenance", { relatedTo: "SK-A-4753" });
  assert(!isError, "No error for relatedTo search");
  assert(sc?.totalArtworks >= 1, `totalArtworks >= 1 (got ${sc?.totalArtworks})`);

  // The result should include artworks whose provenance cross-references SK-A-4753
  const matchedEvents = sc?.results?.flatMap(a => a.events.filter(e => e.matched)) ?? [];
  const allCrossRef = matchedEvents.every(e => e.crossRefTarget === "SK-A-4753");
  assert(allCrossRef, "All matched events have crossRefTarget 'SK-A-4753'");
}

// ══════════════════════════════════════════════════════════════════
//  10. Creator filter
// ══════════════════════════════════════════════════════════════════

section("10. Creator filter");

{
  const { sc, isError } = await call("search_provenance", {
    creator: "Rembrandt",
    transferType: "sale",
    maxResults: 3,
  });
  assert(!isError, "No error for creator + transferType");
  assert(sc?.totalArtworks >= 1, `totalArtworks >= 1 (got ${sc?.totalArtworks})`);

  const allRembrandt = sc?.results?.every(a =>
    a.creator.toLowerCase().includes("rembrandt")
  );
  assert(allRembrandt, "All results have creator containing 'Rembrandt'");
}

// ══════════════════════════════════════════════════════════════════
//  11. parseMethod present (parse audit)
// ══════════════════════════════════════════════════════════════════

section("11. parseMethod (parse audit)");

{
  const { sc } = await call("search_provenance", { objectNumber: "SK-A-2344" }); // Milkmaid
  const validMethods = new Set(["peg", "regex_fallback", "cross_ref"]);
  const allValid = sc?.results?.[0]?.events?.every(e => validMethods.has(e.parseMethod));
  assert(allValid, "All events have valid parseMethod");
}

// ══════════════════════════════════════════════════════════════════
//  12. Cross-ref forward detection
// ══════════════════════════════════════════════════════════════════

section("12. Cross-ref forward");

{
  // SK-A-4754 has "See the provenance for SK-A-4753" as its only event
  const { sc } = await call("search_provenance", { objectNumber: "SK-A-4754" });
  const crossRefEvent = sc?.results?.[0]?.events?.find(e => e.isCrossRef);
  assert(crossRefEvent != null, "Found a cross-ref event");
  assert(typeof crossRefEvent?.crossRefTarget === "string", "crossRefTarget is a string");
  assert(crossRefEvent?.parseMethod === "cross_ref", "parseMethod is 'cross_ref'");
}

// ══════════════════════════════════════════════════════════════════
//  13. Dual-channel response
// ══════════════════════════════════════════════════════════════════

section("13. Dual-channel response");

{
  const r = await client.callTool({
    name: "search_provenance",
    arguments: { objectNumber: "SK-A-4050" },
  });
  const text = r.content?.[0]?.text ?? "";
  assert(text.length > 0, "Text channel has content");
  assert(r.structuredContent != null, "structuredContent is present");
  assert(text.includes("SK-A-4050"), "Text channel mentions the objectNumber");
  assert(text.includes(">>>"), "Text channel has >>> markers for matched events");
}

// ══════════════════════════════════════════════════════════════════
//  14. Currency filter
// ══════════════════════════════════════════════════════════════════

section("14. Currency filter");

{
  const { sc, isError } = await call("search_provenance", { currency: "guilders", maxResults: 3 });
  assert(!isError, "No error for currency filter");

  const matchedEvents = sc?.results?.flatMap(a => a.events.filter(e => e.matched)) ?? [];
  const allGuilders = matchedEvents.every(e => e.price?.currency === "guilders");
  assert(allGuilders, "All matched events have price in guilders");
}

// ══════════════════════════════════════════════════════════════════
//  15. hasGap filter (provenance gaps)
// ══════════════════════════════════════════════════════════════════

section("15. hasGap filter");

{
  const { sc, isError } = await call("search_provenance", { hasGap: true, maxResults: 5 });
  assert(!isError, "No error for hasGap search");
  assert(sc?.totalArtworks >= 1, `totalArtworks >= 1 (got ${sc?.totalArtworks})`);

  // Each artwork should have at least one gap event
  const allHaveGap = sc?.results?.every(a =>
    a.events.some(e => e.gap === true)
  );
  assert(allHaveGap, "Every artwork has at least one gap event");

  // Matched events should be the gap events specifically
  const matchedEvents = sc?.results?.flatMap(a => a.events.filter(e => e.matched)) ?? [];
  const allMatchedAreGaps = matchedEvents.every(e => e.gap === true);
  assert(allMatchedAreGaps, "All matched events are gap events");
}

// ══════════════════════════════════════════════════════════════════
//  16. Multi-value transferType
// ══════════════════════════════════════════════════════════════════

section("16. Multi-value transferType");

{
  const { sc, isError } = await call("search_provenance", {
    transferType: ["sale", "gift"],
    maxResults: 3,
  });
  assert(!isError, "No error for multi-value transferType");
  assert(sc?.totalArtworks >= 1, `totalArtworks >= 1 (got ${sc?.totalArtworks})`);

  const matchedEvents = sc?.results?.flatMap(a => a.events.filter(e => e.matched)) ?? [];
  const allCorrectType = matchedEvents.every(e => e.transferType === "sale" || e.transferType === "gift");
  assert(allCorrectType, "All matched events are sale or gift");
}

// ══════════════════════════════════════════════════════════════════
//  17. excludeTransferType
// ══════════════════════════════════════════════════════════════════

section("17. excludeTransferType");

{
  const { sc, isError } = await call("search_provenance", {
    transferType: "confiscation",
    excludeTransferType: "restitution",
    maxResults: 3,
  });
  assert(!isError, "No error for excludeTransferType");

  // Every artwork should have confiscation but no restitution
  for (const a of (sc?.results ?? [])) {
    const hasConfiscation = a.events.some(e => e.transferType === "confiscation");
    assert(hasConfiscation, `${a.objectNumber} has confiscation event`);
    const hasRestitution = a.events.some(e => e.transferType === "restitution");
    assert(!hasRestitution, `${a.objectNumber} has no restitution event`);
  }
}

// ══════════════════════════════════════════════════════════════════
//  18. sortBy price
// ══════════════════════════════════════════════════════════════════

section("18. sortBy price");

{
  const { sc, isError } = await call("search_provenance", {
    hasPrice: true,
    sortBy: "price",
    sortOrder: "desc",
    maxResults: 5,
  });
  assert(!isError, "No error for sortBy=price");
  assert(sc?.results?.length >= 2, `At least 2 results for price sort (got ${sc?.results?.length})`);

  // Verify descending: max price of each artwork should be >= next
  const maxPrices = (sc?.results ?? []).map(a => {
    const prices = a.events.filter(e => e.price != null).map(e => e.price.amount);
    return prices.length > 0 ? Math.max(...prices) : 0;
  });
  let isSorted = true;
  for (let i = 1; i < maxPrices.length; i++) {
    if (maxPrices[i] > maxPrices[i - 1]) { isSorted = false; break; }
  }
  assert(isSorted, "Results sorted by price descending");
}

// ══════════════════════════════════════════════════════════════════
//  19. offset (pagination)
// ══════════════════════════════════════════════════════════════════

section("19. offset (pagination)");

{
  const { sc: page1 } = await call("search_provenance", {
    transferType: "sale",
    location: "Amsterdam",
    maxResults: 3,
    offset: 0,
  });
  const { sc: page2 } = await call("search_provenance", {
    transferType: "sale",
    location: "Amsterdam",
    maxResults: 3,
    offset: 3,
  });

  const ids1 = new Set((page1?.results ?? []).map(a => a.objectNumber));
  const ids2 = new Set((page2?.results ?? []).map(a => a.objectNumber));

  // Pages should not overlap
  let hasOverlap = false;
  for (const id of ids2) {
    if (ids1.has(id)) { hasOverlap = true; break; }
  }
  assert(!hasOverlap, "Page 1 and page 2 have no overlapping artworks");
  assert(page1?.totalArtworks === page2?.totalArtworks, "totalArtworks consistent across pages");
}

// ══════════════════════════════════════════════════════════════════
//  20. Layer 2 periods (basic)
// ══════════════════════════════════════════════════════════════════

section("20. Layer 2 periods (basic)");

{
  // objectNumber fast path for periods
  const { sc, isError } = await call("search_provenance", {
    layer: "periods",
    objectNumber: "SK-A-4050",
  });
  assert(!isError, "No error for periods objectNumber fast path");

  if (sc?.results?.length > 0) {
    const artwork = sc.results[0];
    assert(artwork.objectNumber === "SK-A-4050", "Correct objectNumber returned");
    assert(Array.isArray(artwork.periods), "periods array present");
    assert(artwork.periods.length > 0, `Has periods (got ${artwork.periods?.length})`);

    // Check period structure
    const p = artwork.periods[0];
    assert(typeof p.sequence === "number", "period.sequence is number");
    assert("ownerName" in p, "period has ownerName");
    assert("beginYear" in p, "period has beginYear");
    assert("duration" in p, "period has duration");
    assert(typeof p.matched === "boolean", "period.matched is boolean");
  } else {
    // periods table might not exist in test DB
    assert(sc?.warnings?.length > 0, "Warning about missing periods table");
  }
}

// ══════════════════════════════════════════════════════════════════
//  21. Layer 2 periods — ownerName search
// ══════════════════════════════════════════════════════════════════

section("21. Layer 2 periods — ownerName search");

{
  const { sc, isError } = await call("search_provenance", {
    layer: "periods",
    ownerName: "Rothschild",
    maxResults: 3,
  });
  assert(!isError, "No error for ownerName search");

  if (sc?.results?.length > 0) {
    // At least one matched period should contain Rothschild
    const hasMatch = sc.results.some(a =>
      (a.periods ?? []).some(p => p.matched && (p.ownerName ?? "").includes("Rothschild"))
    );
    assert(hasMatch, "At least one matched period has ownerName containing 'Rothschild'");
  }
}

// ══════════════════════════════════════════════════════════════════
//  22. Layer 2 periods — minDuration
// ══════════════════════════════════════════════════════════════════

section("22. Layer 2 periods — minDuration");

{
  const { sc, isError } = await call("search_provenance", {
    layer: "periods",
    minDuration: 100,
    maxResults: 5,
  });
  assert(!isError, "No error for minDuration search");

  if (sc?.results?.length > 0) {
    const matchedPeriods = sc.results.flatMap(a => (a.periods ?? []).filter(p => p.matched));
    const allLongEnough = matchedPeriods.every(p => p.duration != null && p.duration >= 100);
    assert(allLongEnough, "All matched periods have duration >= 100 years");
  }
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
