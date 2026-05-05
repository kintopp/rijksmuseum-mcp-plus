#!/usr/bin/env node
/**
 * test-sort-by.mjs — verify #198 sortBy/sortOrder on search_artwork.
 *
 * Covers the five enum values (height, width, dateEarliest, dateLatest,
 * recordModified) × asc/desc, plus pagination tiebreaker stability across
 * importance ties (#321 surfaced this — 65% of the collection sits at imp=7).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  cwd: process.cwd(),
  env: { ...process.env, STRUCTURED_CONTENT: "true" },
});
const client = new Client({ name: "sort-by-test", version: "1.0" });
await client.connect(transport);
console.log("Connected\n");

let passed = 0, failed = 0;
function check(label, cond, detail) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}

async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) return { _error: r.content?.[0]?.text ?? "" };
  return r.structuredContent ?? (r.content?.[0]?.text ? JSON.parse(r.content[0].text) : r);
}

// ── 1. sortBy: height, desc → should return tallest paintings first ──────
console.log("1. sortBy=height, sortOrder=desc (paintings)");
{
  const r = await call("search_artwork", {
    type: "painting", sortBy: "height", sortOrder: "desc", maxResults: 5, compact: false,
  });
  check("no error", !r._error, r._error);
  check("got results", r?.results?.length > 0);
  // Each result has dimensions in the formatted string; we don't get raw cm here, so we
  // just check ordering via get_artwork_details on the first two results. The dimensions
  // field is an array of {type, value, unit, note} entries.
  if (r?.results?.length >= 2) {
    const a = await call("get_artwork_details", { objectNumber: r.results[0].objectNumber });
    const b = await call("get_artwork_details", { objectNumber: r.results[1].objectNumber });
    const ha = a?.dimensions?.find?.(d => d.type === "height")?.value;
    const hb = b?.dimensions?.find?.(d => d.type === "height")?.value;
    check(`first.height (${ha}) >= second.height (${hb})`, ha != null && hb != null && ha >= hb);
  }
}

// ── 2. sortBy: dateEarliest, asc → oldest works first ────────────────────
console.log("\n2. sortBy=dateEarliest, sortOrder=asc (paintings)");
{
  const r = await call("search_artwork", {
    type: "painting", sortBy: "dateEarliest", sortOrder: "asc", maxResults: 5, compact: false,
  });
  check("no error", !r._error, r._error);
  check("got results", r?.results?.length > 0);
  // Date is in `date` string for full results. Just check the field order looks ascending.
  if (r?.results?.length >= 2) {
    const dates = r.results.map(x => x.date || "").slice(0, 5);
    console.log(`     dates: ${dates.join(" | ")}`);
  }
}

// ── 3. sortBy: dateLatest, desc → most-recent works first ────────────────
console.log("\n3. sortBy=dateLatest, sortOrder=desc (paintings)");
{
  const r = await call("search_artwork", {
    type: "painting", sortBy: "dateLatest", sortOrder: "desc", maxResults: 5, compact: false,
  });
  check("no error", !r._error, r._error);
  check("got results", r?.results?.length > 0);
  if (r?.results?.length >= 2) {
    const dates = r.results.map(x => x.date || "").slice(0, 5);
    console.log(`     dates: ${dates.join(" | ")}`);
  }
}

// ── 4. sortBy: width, desc on prints (compact) ───────────────────────────
console.log("\n4. sortBy=width, sortOrder=desc (compact, prints)");
{
  const r = await call("search_artwork", {
    type: "print", sortBy: "width", sortOrder: "desc", maxResults: 5, compact: true,
  });
  check("no error", !r._error, r._error);
  check("got ids", Array.isArray(r?.ids) && r.ids.length > 0);
}

// ── 5. sortBy: recordModified, desc — most-recently catalogued first ─────
console.log("\n5. sortBy=recordModified, sortOrder=desc (paintings)");
{
  const r = await call("search_artwork", {
    type: "painting", sortBy: "recordModified", sortOrder: "desc", maxResults: 5, compact: true,
  });
  check("no error", !r._error, r._error);
  check("got ids", Array.isArray(r?.ids) && r.ids.length > 0);
}

// ── 6. Pagination stability — same query, two pages, no overlap ──────────
console.log("\n6. Pagination stability across importance ties (compact)");
{
  // Use a broad filter that hits the imp=7 cliff. Type=painting alone yields ~3.5k.
  const page1 = await call("search_artwork", {
    type: "painting", maxResults: 25, offset: 0, compact: true,
  });
  const page2 = await call("search_artwork", {
    type: "painting", maxResults: 25, offset: 25, compact: true,
  });
  check("page1 ok", !page1._error && Array.isArray(page1.ids), page1._error);
  check("page2 ok", !page2._error && Array.isArray(page2.ids), page2._error);
  if (page1.ids && page2.ids) {
    const overlap = page1.ids.filter(id => page2.ids.includes(id));
    check(`no overlap between page 1 and page 2 (overlap=${overlap.length})`, overlap.length === 0);
  }
}

// ── 7. sortBy alone (no other filter) → rejected ─────────────────────────
console.log("\n7. sortBy alone (no filter) is rejected");
{
  const r = await call("search_artwork", { sortBy: "height", maxResults: 5 });
  check("returns error", !!r._error);
  check("error mentions filter requirement", r._error?.toLowerCase().includes("filter"));
}

// ── 8. sortBy default direction is desc ──────────────────────────────────
console.log("\n8. Default sortOrder is desc (paintings, sortBy=height)");
{
  const rDefault = await call("search_artwork", {
    type: "painting", sortBy: "height", maxResults: 3, compact: true,
  });
  const rDesc = await call("search_artwork", {
    type: "painting", sortBy: "height", sortOrder: "desc", maxResults: 3, compact: true,
  });
  check("default matches explicit desc", JSON.stringify(rDefault.ids) === JSON.stringify(rDesc.ids));
}

// ── 9. sortBy + nearPlace: filter still applied, ordering switched ───────
console.log("\n9. sortBy overrides geo-proximity ordering");
{
  // Without sortBy, results sort by distance. With sortBy, they sort by height.
  // We just check that both queries succeed and return results — full ordering
  // verification would require coordinate data.
  const rGeo = await call("search_artwork", {
    type: "painting", nearPlace: "Amsterdam", maxResults: 5, compact: true,
  });
  const rGeoSorted = await call("search_artwork", {
    type: "painting", nearPlace: "Amsterdam", sortBy: "height", sortOrder: "desc", maxResults: 5, compact: true,
  });
  check("geo-only ok", !rGeo._error && rGeo.ids?.length > 0);
  check("geo + sortBy ok", !rGeoSorted._error && rGeoSorted.ids?.length > 0);
  // The two should generally differ in ordering when both have results.
  if (rGeo.ids && rGeoSorted.ids && rGeo.ids.length === rGeoSorted.ids.length) {
    const same = JSON.stringify(rGeo.ids) === JSON.stringify(rGeoSorted.ids);
    check("geo ordering differs from sortBy ordering", !same);
  }
}

await client.close();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
