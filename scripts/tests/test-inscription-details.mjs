/**
 * Smoke test: get_artwork_details surfaces parsedInscriptions + inscriptionSummary
 * (issue #383, step 2). Validates that the strict output schema accepts the parser
 * output and that both the structured and text channels carry the new data.
 *
 * Run:  node scripts/tests/test-inscription-details.mjs
 * Requires: a built dist/ + data/vocabulary.db. Excluded from test:all (needs DB).
 *
 * Uses the MCP SDK Client + StdioClientTransport per the project's smoke-test
 * convention (no shell pipes / hand-rolled JSON-RPC).
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
  command: "node",
  args: ["dist/index.js"],
  cwd: PROJECT_DIR,
  env: { ...process.env, STRUCTURED_CONTENT: "true" },
});
const client = new Client({ name: "test-inscription-details", version: "0.1" });
await client.connect(transport);
console.log("Connected via stdio\n");

async function detail(objectNumber) {
  const r = await client.callTool({ name: "get_artwork_details", arguments: { objectNumber } });
  const text = r.content.find((c) => c.type === "text")?.text ?? "";
  return { sc: r.structuredContent, text };
}

// ── Multi-mark record (name + Lugt + number; NL/EN glosses) ──────
console.log("RP-P-1906-2551 — multi-mark print");
{
  const { sc, text } = await detail("RP-P-1906-2551");
  assert(Array.isArray(sc.parsedInscriptions), "parsedInscriptions present in structuredContent");
  assert(sc.parsedInscriptions.length >= 2, "multiple parsed segments");
  assert(!!sc.inscriptionSummary, "inscriptionSummary present");
  const hasLugt = sc.inscriptionSummary.collectorMarks.some((m) => /Lugt/.test(m));
  assert(hasLugt, "summary surfaces a Lugt collector mark");
  assert(sc.inscriptionSummary.hasTranscribedText === true, "summary flags transcribed text present");
  // Every parsed entry carries the full contract shape.
  const shape = sc.parsedInscriptions[0];
  for (const k of ["sequence", "raw", "language", "type", "normalizedType", "placement",
    "normalizedPlacement", "technique", "normalizedTechnique", "value", "transcribedText",
    "collectorMarks", "unknownQualifiers", "isCollectorMark", "isPlaceholder"]) {
    assert(k in shape, `parsed entry has field: ${k}`);
  }
  assert(/\[Inscription notes\]/.test(text), "text channel carries [Inscription notes]");
}

// ── Collector-mark-only record ───────────────────────────────────
console.log("\nRP-T-1940-597 — collector-mark-only drawing");
{
  const { sc, text } = await detail("RP-T-1940-597");
  assert(sc.inscriptionSummary.hasCollectorMarkOnly === true, "flagged collector-mark only");
  assert(sc.inscriptionSummary.hasTranscribedText === false, "no transcribed text");
  assert(/collector's marks only/.test(text), "text notes 'collector's marks only'");
}

await client.close();

console.log(`\n${"═".repeat(50)}`);
console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
console.log(`${"═".repeat(50)}`);
if (failed) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }
