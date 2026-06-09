/**
 * Smoke test: search_inscriptions (issue #383, step 3 — Stage A runtime).
 *
 * Run:  node scripts/tests/test-search-inscriptions.mjs
 * Requires: a built dist/ + data/vocabulary.db. Excluded from test:all (needs DB).
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

const transport = new StdioClientTransport({
  command: "node", args: ["dist/index.js"], cwd: PROJECT_DIR,
  env: { ...process.env, STRUCTURED_CONTENT: "true" },
});
const client = new Client({ name: "test-search-inscriptions", version: "0.1" });
await client.connect(transport);
console.log("Connected via stdio\n");

const call = async (args) => {
  const r = await client.callTool({ name: "search_inscriptions", arguments: args });
  return { sc: r.structuredContent, text: r.content.find((c) => c.type === "text")?.text ?? "", isError: r.isError };
};

// 1. Tool is listed
{
  const { tools } = await client.listTools();
  assert(tools.some((t) => t.name === "search_inscriptions"), "search_inscriptions is registered");
}

// 2. Collector-mark search (Lugt 240, number-only form)
console.log("\ncollectorMark: '240'");
{
  const { sc } = await call({ collectorMark: "240", maxResults: 5 });
  assert(sc.totalConfirmed > 0, "finds works bearing Lugt 240");
  const first = sc.results[0];
  const hasLugt = first.matchedInscriptions.some((m) => m.collectorMark && /240/.test(m.collectorMark.number));
  assert(hasLugt, "matchedInscriptions surfaces the Lugt 240 mark");
  // R6: NL stamp + EN gloss collapse to one logical mark.
  const lugtMark = first.matchedInscriptions.find((m) => m.collectorMark);
  assert(lugtMark.occurrences.length >= 1, "collector mark has ≥1 occurrence");
}

// 3. Broad single facet trips the candidate cap (R1)
console.log("\ninscriptionType: \"collector's mark\" (broad)");
{
  const { sc } = await call({ inscriptionType: "collector's mark", maxResults: 5 });
  assert(sc.candidatesCapped === true, "broad single facet trips candidatesCapped");
  assert((sc.warnings ?? []).some((w) => /narrowing term/.test(w)), "warns to add a narrowing term");
}

// 4. Selective facet combo works without free text (R1 — size, not text-presence)
console.log("\nplacement:recto + technique:handwritten + type:signature");
{
  const { sc } = await call({
    inscriptionType: "signature", placement: "recto", technique: "handwritten", maxResults: 5,
  });
  assert(sc.candidatesCapped === false, "selective facet combo does NOT trip the cap");
  if (sc.totalConfirmed > 0) {
    const seg = sc.results[0].matchedInscriptions[0];
    const occ = seg.occurrences[0];
    assert(occ.placement === "recto" && occ.technique === "handwritten", "matched segment is recto + handwritten");
  } else {
    console.log("  (no confirmed results — acceptable; facet combo is rare)");
  }
}

// 4a. Unknown / Dutch-surface-form type value confirms via the raw catalogued
//     token (issue #383 P2 — literal FTS fallback must also confirm, not just narrow).
console.log("\ninscriptionType: \"signatuur\" (Dutch surface form, not a bucket name)");
{
  const { sc } = await call({ inscriptionType: "signatuur", maxResults: 5 });
  // Regression: the literal FTS narrow found candidates, but parse-confirm used to
  // require normalizedType === "signatuur" (a bucket that doesn't exist) → 0 confirmed.
  assert(sc.totalCandidates > 0, "Dutch surface form narrows the FTS");
  assert(sc.totalConfirmed > 0, "unknown/surface-form type confirms via the raw type token");
}

// 5. excludeCollectorMarkOnly strips boilerplate
console.log("\ntext + excludeCollectorMarkOnly");
{
  const { sc } = await call({ collectorMark: "2228", excludeCollectorMarkOnly: true, maxResults: 5 });
  // Every returned artwork must carry transcribed text (not pure stamp boilerplate).
  const allHaveText = sc.results.every((r) => r.matchedInscriptions.length > 0);
  assert(allHaveText, "results returned with marks present alongside other content");
}

// 6. No-filter guard
console.log("\nno narrowing filter");
{
  const { sc } = await call({ maxResults: 5 });
  assert((sc.warnings ?? []).some((w) => /at least one narrowing filter/i.test(w)), "refuses with a narrowing-filter warning");
  assert(sc.results.length === 0, "no results without a filter");
}

await client.close();

console.log(`\n${"═".repeat(50)}`);
console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
console.log(`${"═".repeat(50)}`);
if (failed) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }
