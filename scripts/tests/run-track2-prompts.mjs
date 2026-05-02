/**
 * Executes the 9 v0.25 test prompts against a local stdio MCP server.
 * Each prompt is reduced to its concrete tool calls; the script reports
 * what the server actually returned so the user can compare to the
 * "expected" indicators in the prompt sheet.
 *
 * Run:  node scripts/tests/run-track2-prompts.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function header(title) {
  console.log(`\n${"━".repeat(72)}`);
  console.log(`  ${title}`);
  console.log("━".repeat(72));
}
function unwrap(r) {
  if (r.structuredContent) return r.structuredContent;
  const text = r.content?.[0]?.text ?? "";
  try { return JSON.parse(text); } catch { return { _text: text }; }
}
function call(client, tool, args) {
  return client.callTool({ name: tool, arguments: args }).then(unwrap);
}

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  cwd: PROJECT_DIR,
  env: { ...process.env, STRUCTURED_CONTENT: "true" },
});
const client = new Client({ name: "run-track2-prompts", version: "0.1" });
await client.connect(transport);

// ────────────────────────────────────────────────────────────────────────
header("Test 1 — Task A · titles[] (Night Watch)");
// ────────────────────────────────────────────────────────────────────────
const t1 = await call(client, "get_artwork_details", { objectNumber: "SK-C-5" });
console.log(`titles[] count: ${t1.titles.length}`);
for (const t of t1.titles) {
  const trim = t.title.length > 70 ? t.title.slice(0, 67) + "…" : t.title;
  console.log(`  [${t.language}/${t.qualifier.padEnd(7)}] ${trim}`);
}
const qSet = new Set(t1.titles.map(t => t.qualifier));
const lSet = new Set(t1.titles.map(t => t.language));
console.log(`distinct qualifiers: ${[...qSet].sort().join(", ")}`);
console.log(`distinct languages : ${[...lSet].sort().join(", ")}`);

// ────────────────────────────────────────────────────────────────────────
header("Test 2a — Task B · child→parent link (BI-1898-1748A-1(R))");
// ────────────────────────────────────────────────────────────────────────
const t2a = await call(client, "get_artwork_details", { objectNumber: "BI-1898-1748A-1(R)" });
console.log(`parents.length     : ${t2a.parents.length}`);
for (const p of t2a.parents) {
  const trim = p.title.length > 70 ? p.title.slice(0, 67) + "…" : p.title;
  console.log(`  ↪ ${p.objectNumber} | ${trim}`);
}
console.log(`childCount of self : ${t2a.childCount}`);

// And the parent's childCount, to mirror the "how many other folios" prompt
const parentDetail = await call(client, "get_artwork_details", { objectNumber: "BI-1898-1748A" });
console.log(`parent's childCount: ${parentDetail.childCount}`);

// ────────────────────────────────────────────────────────────────────────
header("Test 2b — Task B · parent's children preview + cap (BI-1898-1748A)");
// ────────────────────────────────────────────────────────────────────────
console.log(`childCount         : ${parentDetail.childCount}`);
console.log(`children.length    : ${parentDetail.children.length} (preview, capped at 25)`);
console.log("first 10 children:");
for (const c of parentDetail.children.slice(0, 10)) {
  const trim = c.title.length > 60 ? c.title.slice(0, 57) + "…" : c.title;
  console.log(`  · ${c.objectNumber.padEnd(22)} ${trim}`);
}
console.log(`(${parentDetail.childCount - parentDetail.children.length} more not shown in preview)`);

// ────────────────────────────────────────────────────────────────────────
header("Test 3 — Task B · groupBy=parent (creator='Schedel')");
// ────────────────────────────────────────────────────────────────────────
const t3raw = await call(client, "search_artwork", {
  creator: "Schedel", maxResults: 50,
});
const t3grp = await call(client, "search_artwork", {
  creator: "Schedel", maxResults: 50, groupBy: "parent",
});
console.log(`raw count            : ${t3raw.results.length} of ${t3raw.totalResults}`);
console.log(`grouped count        : ${t3grp.results.length}`);
console.log(`children collapsed   : ${t3raw.results.length - t3grp.results.length}`);
const absorbing = t3grp.results.filter(r => r.groupedChildCount != null);
console.log(`parents that absorbed:`);
for (const p of absorbing) {
  console.log(`  · ${p.objectNumber} → ${p.groupedChildCount} children | "${p.title.slice(0,50)}…"`);
}
console.log(`warnings:`);
for (const w of (t3grp.warnings ?? [])) console.log(`  ⚠ ${w}`);

// ────────────────────────────────────────────────────────────────────────
header("Test 4 — Task C · relatedObjects[] (Night Watch)");
// ────────────────────────────────────────────────────────────────────────
console.log(`relatedObjectsTotalCount: ${t1.relatedObjectsTotalCount}`);
const byType = new Map();
for (const r of t1.relatedObjects) {
  if (!byType.has(r.relationship)) byType.set(r.relationship, []);
  byType.get(r.relationship).push(r);
}
for (const [type, rows] of byType) {
  console.log(`  [${type}] (${rows.length}):`);
  for (const r of rows.slice(0, 3)) {
    console.log(`    · ${r.objectNumber ?? "(unresolved)"} | ${(r.title ?? "(no title)").slice(0,55)}`);
  }
  if (rows.length > 3) console.log(`    … +${rows.length - 3} more`);
}

// ────────────────────────────────────────────────────────────────────────
header("Test 4b — Task C · multi-type relations (SK-A-1115)");
// ────────────────────────────────────────────────────────────────────────
const t4b = await call(client, "get_artwork_details", { objectNumber: "SK-A-1115" });
console.log(`relatedObjectsTotalCount: ${t4b.relatedObjectsTotalCount}`);
const t4bTypes = new Set(t4b.relatedObjects.map(r => r.relationship));
console.log(`distinct relationship types: ${[...t4bTypes].sort().join(", ")}`);
const recto = t4b.relatedObjects.find(r => r.relationship === "recto | verso");
if (recto) {
  console.log(`recto/verso peer: ${recto.objectNumber} | "${(recto.title ?? "").slice(0,60)}"`);
} else {
  console.log("(no 'recto | verso' peer on SK-A-1115)");
}

// ────────────────────────────────────────────────────────────────────────
header("Test 7 — is_areal · nearPlace excludes Holy Roman Empire centroid");
// ────────────────────────────────────────────────────────────────────────
const t7holy = await call(client, "search_artwork", {
  nearLat: 50.0, nearLon: 10.0, nearPlaceRadius: 50, maxResults: 5,
});
const t7frank = await call(client, "search_artwork", {
  nearPlace: "Frankfurt am Main", nearPlaceRadius: 50, maxResults: 5,
});
console.log(`(50.0, 10.0) r=50km   : ${t7holy.results.length} results, total=${t7holy.totalResults}`);
console.log(`  warnings: ${(t7holy.warnings ?? []).join("; ") || "(none)"}`);
console.log(`Frankfurt r=50km      : ${t7frank.results.length} results, total=${t7frank.totalResults}`);
console.log(`  refPlace: ${t7frank.referencePlace ?? "(n/a)"}`);
console.log(`  first results' nearestPlace:`);
for (const r of t7frank.results.slice(0, 3)) {
  console.log(`    · ${r.objectNumber}  near=${r.nearestPlace} (${r.distance_km?.toFixed(1)} km)`);
}

// ────────────────────────────────────────────────────────────────────────
header("Test 8 — is_areal · collection_stats depictedPlace top-10");
// ────────────────────────────────────────────────────────────────────────
// collection_stats returns only a text-mode response; parse the leading 10 entries from it.
const t8raw = await client.callTool({
  name: "collection_stats", arguments: { dimension: "depictedPlace", topN: 10 },
});
const t8text = t8raw.content?.[0]?.text ?? "";
console.log(t8text.split("\n").slice(0, 14).join("\n"));
const regionish = ["Netherlands", "France", "Dutch East Indies", "Suriname", "Italy", "Germany", "Belgium", "United Kingdom", "Spain"];
const found = regionish.filter(r => new RegExp(`^\\s*\\d+\\.\\s+${r}\\b`, "m").test(t8text));
console.log(`\ncountry/region labels in top-10 (should be empty): ${found.length === 0 ? "(none ✓)" : found.join(", ")}`);

// ────────────────────────────────────────────────────────────────────────
header("Test 9 — Negative control · standalone print (RP-P-2010-222-3315)");
// ────────────────────────────────────────────────────────────────────────
const t9 = await call(client, "get_artwork_details", { objectNumber: "RP-P-2010-222-3315" });
console.log(`titles[].length              : ${t9.titles.length}`);
console.log(`parents.length               : ${t9.parents.length}`);
console.log(`childCount                   : ${t9.childCount}`);
console.log(`relatedObjectsTotalCount     : ${t9.relatedObjectsTotalCount}`);

await client.close();
console.log("\n" + "━".repeat(72));
console.log("  Done.");
console.log("━".repeat(72));
