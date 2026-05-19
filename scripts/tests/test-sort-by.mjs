#!/usr/bin/env node
/**
 * test-sort-by.mjs — verify #198 sort on search_artwork.
 *
 * Covers the five sort columns (height, width, dateEarliest, dateLatest,
 * recordModified) × asc/desc, plus pagination tiebreaker stability across
 * importance ties (#321 surfaced this — 65% of the collection sits at imp=7).
 *
 * As of the v0.50 schema-trim pass, the two-param sortBy + sortOrder shape
 * is consolidated into a single string `sort: "column[:asc|desc]"` (default desc).
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

// ── 1. sort: "height:desc" → should return tallest paintings first ───────
console.log("1. sort=height:desc (paintings)");
{
  const r = await call("search_artwork", {
    type: "painting", sort: "height:desc", maxResults: 5, compact: false,
  });
  check("no error", !r._error, r._error);
  check("got results", r?.results?.length > 0);
  if (r?.results?.length >= 2) {
    const a = await call("get_artwork_details", { objectNumber: r.results[0].objectNumber });
    const b = await call("get_artwork_details", { objectNumber: r.results[1].objectNumber });
    const ha = a?.dimensions?.find?.(d => d.type === "height")?.value;
    const hb = b?.dimensions?.find?.(d => d.type === "height")?.value;
    check(`first.height (${ha}) >= second.height (${hb})`, ha != null && hb != null && ha >= hb);
  }
}

// ── 2. sort: "dateEarliest:asc" → oldest works first ─────────────────────
console.log("\n2. sort=dateEarliest:asc (paintings)");
{
  const r = await call("search_artwork", {
    type: "painting", sort: "dateEarliest:asc", maxResults: 5, compact: false,
  });
  check("no error", !r._error, r._error);
  check("got results", r?.results?.length > 0);
  if (r?.results?.length >= 2) {
    const dates = r.results.map(x => x.date || "").slice(0, 5);
    console.log(`     dates: ${dates.join(" | ")}`);
  }
}

// ── 3. sort: "dateLatest:desc" → most-recent works first ─────────────────
console.log("\n3. sort=dateLatest:desc (paintings)");
{
  const r = await call("search_artwork", {
    type: "painting", sort: "dateLatest:desc", maxResults: 5, compact: false,
  });
  check("no error", !r._error, r._error);
  check("got results", r?.results?.length > 0);
  if (r?.results?.length >= 2) {
    const dates = r.results.map(x => x.date || "").slice(0, 5);
    console.log(`     dates: ${dates.join(" | ")}`);
  }
}

// ── 4. sort: "width:desc" on prints (compact) ────────────────────────────
console.log("\n4. sort=width:desc (compact, prints)");
{
  const r = await call("search_artwork", {
    type: "print", sort: "width:desc", maxResults: 5, compact: true,
  });
  check("no error", !r._error, r._error);
  check("got ids", Array.isArray(r?.ids) && r.ids.length > 0);
}

// ── 5. sort: "recordModified:desc" — most-recently catalogued first ──────
console.log("\n5. sort=recordModified:desc (paintings)");
{
  const r = await call("search_artwork", {
    type: "painting", sort: "recordModified:desc", maxResults: 5, compact: true,
  });
  check("no error", !r._error, r._error);
  check("got ids", Array.isArray(r?.ids) && r.ids.length > 0);
}

// ── 6. Pagination stability — same query, two pages, no overlap ──────────
console.log("\n6. Pagination stability across importance ties (compact)");
{
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

// ── 7. sort alone (no other filter) → rejected ───────────────────────────
console.log("\n7. sort alone (no filter) is rejected");
{
  const r = await call("search_artwork", { sort: "height", maxResults: 5 });
  check("returns error", !!r._error);
  check("error mentions filter requirement", r._error?.toLowerCase().includes("filter"));
}

// ── 8. sort default direction is desc ────────────────────────────────────
console.log("\n8. Default direction is desc (paintings, sort=height)");
{
  const rDefault = await call("search_artwork", {
    type: "painting", sort: "height", maxResults: 3, compact: true,
  });
  const rDesc = await call("search_artwork", {
    type: "painting", sort: "height:desc", maxResults: 3, compact: true,
  });
  check("default matches explicit desc", JSON.stringify(rDefault.ids) === JSON.stringify(rDesc.ids));
}

// ── 9. sort + nearPlace: filter still applied, ordering switched ─────────
console.log("\n9. sort overrides geo-proximity ordering");
{
  const rGeo = await call("search_artwork", {
    type: "painting", nearPlace: "Amsterdam", maxResults: 5, compact: true,
  });
  const rGeoSorted = await call("search_artwork", {
    type: "painting", nearPlace: "Amsterdam", sort: "height:desc", maxResults: 5, compact: true,
  });
  check("geo-only ok", !rGeo._error && rGeo.ids?.length > 0);
  check("geo + sort ok", !rGeoSorted._error && rGeoSorted.ids?.length > 0);
  if (rGeo.ids && rGeoSorted.ids && rGeo.ids.length === rGeoSorted.ids.length) {
    const same = JSON.stringify(rGeo.ids) === JSON.stringify(rGeoSorted.ids);
    check("geo ordering differs from sort ordering", !same);
  }
}

// ── 10. Invalid sort strings are rejected ────────────────────────────────
console.log("\n10. Invalid sort string is rejected");
{
  const r = await call("search_artwork", { type: "painting", sort: "bogus", maxResults: 1 });
  check("invalid column returns error", !!r._error);
}
{
  const r = await call("search_artwork", { type: "painting", sort: "height:sideways", maxResults: 1 });
  check("invalid direction returns error", !!r._error);
}

await client.close();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
