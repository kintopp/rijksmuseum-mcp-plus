#!/usr/bin/env node
/**
 * test-collection-stats-attribution.mjs — verify #352:
 *   collection_stats gains attributionQualifier + productionRole + sameRowMatching,
 *   wired through the same applySameRowIntercepts path used by search_artwork.
 *
 * Ground truth comes from the offline/explorations/rembrandt-direct-sql-bypass.html
 * SQL run against the local v0.40 vocabulary.db:
 *   - Rembrandt autograph paintings (painter + sameRowMatching) → 25
 *   - Rembrandt autograph drawings (draughtsman + sameRowMatching) → 65
 *   - Rembrandt + attributionQualifier='workshop of' → 16
 *   - Rembrandt + attributionQualifier='primary' → emits priority-level warning
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  cwd: process.cwd(),
  env: { ...process.env, STRUCTURED_CONTENT: "true" },
});
const client = new Client({ name: "collection-stats-attribution-test", version: "1.0" });
await client.connect(transport);
console.log("Connected\n");

let passed = 0, failed = 0;
function check(label, cond, detail) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}

async function call(name, args) {
  try {
    const r = await client.callTool({ name, arguments: args });
    if (r.isError) return { _error: r.content?.[0]?.text ?? "" };
    return r.structuredContent ?? (r.content?.[0]?.text ? JSON.parse(r.content[0].text) : r);
  } catch (e) {
    return { _zodError: e.message ?? String(e) };
  }
}

// ── 1. Schema exposure ─────────────────────────────────────────────────
console.log("1. Schema exposes the three new params");
{
  const { tools } = await client.listTools();
  const cs = tools.find(t => t.name === "collection_stats");
  const props = Object.keys(cs.inputSchema.properties);
  check("collection_stats lists attributionQualifier", props.includes("attributionQualifier"));
  check("collection_stats lists productionRole", props.includes("productionRole"));
  check("collection_stats lists sameRowMatching", props.includes("sameRowMatching"));
  check("sameRowMatching typed as boolean",
    cs.inputSchema.properties.sameRowMatching?.type === "boolean");
}

// ── 2. Autograph narrowing matches SQL ground truth ────────────────────
console.log("\n2. Autograph type breakdown for Rembrandt — production_role_pairs same-row");
{
  const r = await call("collection_stats", {
    dimension: "type",
    creator: "Rembrandt van Rijn",
    productionRole: "painter",
    sameRowMatching: true,
    topN: 5,
  });
  check("no error", !r._error, r._error);
  // Ground truth: 25 autograph paintings (refined definition, school-of excluded).
  // Without school-of exclusion the production_role_pairs raw count is 28; the SQL
  // ground truth applies an EXCEPT against school-of qualifiers. The intercept here
  // does NOT subtract school-of (that's an additional filter the caller adds via
  // search_artwork-side logic). So we expect 28 here, not 25.
  // The 25-vs-28 split is documented in the explorations HTML.
  const total = r?.total ?? 0;
  check(`total in [25, 35] (got ${total}) — autograph paintings`, total >= 25 && total <= 35);
  console.log(`     total: ${total}`);
}

console.log("\n3. Same query without sameRowMatching → inflated (cross-row matching)");
{
  const r = await call("collection_stats", {
    dimension: "type",
    creator: "Rembrandt van Rijn",
    productionRole: "painter",
    topN: 5,
  });
  check("no error", !r._error, r._error);
  // Without sameRowMatching, productionRole matches across any production row.
  // Should still be modest for paintings (few reproductive paintings of Rembrandt),
  // but the print-maker test below shows the bigger divergence.
  console.log(`     total: ${r?.total}`);
}

console.log("\n4. print maker + sameRowMatching → autograph etchings count");
{
  const r = await call("collection_stats", {
    dimension: "type",
    creator: "Rembrandt van Rijn",
    productionRole: "print maker",
    sameRowMatching: true,
    topN: 5,
  });
  check("no error", !r._error, r._error);
  // Ground truth from explorations HTML: 1,301 autograph prints. The
  // production_role_pairs raw count is 1,401 (no school-of exclusion).
  // We expect to land between 1,200 and 1,500.
  const total = r?.total ?? 0;
  check(`total in [1200, 1500] (got ${total}) — autograph prints`, total >= 1200 && total <= 1500);
  console.log(`     total: ${total}`);
}

console.log("\n5. print maker WITHOUT sameRowMatching → inflated count (~3,200)");
{
  const r = await call("collection_stats", {
    dimension: "type",
    creator: "Rembrandt van Rijn",
    productionRole: "print maker",
    topN: 5,
  });
  check("no error", !r._error, r._error);
  const total = r?.total ?? 0;
  // Without sameRowMatching, the reproductive-print universe is included.
  // Production transcript reported 3,221 for this exact shape via search_artwork.
  check(`total in [3000, 3500] (got ${total}) — cross-row inflated`, total >= 3000 && total <= 3500);
  console.log(`     total: ${total}`);
  // The divergence between (4) and (5) IS the bug #349/#357 fixed for search_artwork
  // and now reaches collection_stats.
}

console.log("\n6. attributionQualifier='workshop of' + Rembrandt → 16 (auto same-row)");
{
  const r = await call("collection_stats", {
    dimension: "type",
    creator: "Rembrandt van Rijn",
    attributionQualifier: "workshop of",
    topN: 5,
  });
  check("no error", !r._error, r._error);
  const total = r?.total ?? 0;
  // Ground truth: 16 from explorations HTML.
  check(`total in [12, 22] (got ${total}) — workshop of Rembrandt`, total >= 12 && total <= 22);
  console.log(`     total: ${total}`);
}

console.log("\n7. attributionQualifier='primary' + Rembrandt → fall-through warning");
{
  const r = await call("collection_stats", {
    dimension: "type",
    creator: "Rembrandt van Rijn",
    attributionQualifier: "primary",
    topN: 5,
  });
  check("no error", !r._error, r._error);
  // Priority-level qualifiers ('primary' / 'secondary' / 'undetermined') don't enforce
  // same-row matching — the intercept emits a warning and falls through to the default loop.
  const warnings = r?.warnings ?? [];
  const hasWarning = warnings.some(w => /priority|primary/i.test(w));
  check("warning mentions priority/primary fall-through", hasWarning,
    `warnings: ${JSON.stringify(warnings).slice(0, 200)}`);
}

// ── 3. Part 2 path: after-Rembrandt works counted via productionRole alone ────
console.log("\n8. productionRole='after painting by' + Rembrandt (no sameRowMatching) — works as before");
{
  const r = await call("collection_stats", {
    dimension: "creator",
    creator: "Rembrandt van Rijn",
    productionRole: "after painting by",
    topN: 5,
  });
  check("no error", !r._error, r._error);
  // Reproductive: Rembrandt as source-artist, primary maker on a different row.
  // No sameRowMatching here because we DO want the cross-row independence.
  const total = r?.total ?? 0;
  check(`total > 600 (got ${total}) — after-painting-by-Rembrandt`, total > 600);
  console.log(`     total: ${total}`);
}

await client.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
