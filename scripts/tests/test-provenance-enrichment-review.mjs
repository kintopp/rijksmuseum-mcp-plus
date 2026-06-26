/**
 * Channel-parity test for search_provenance's enrichment-review affordance.
 *
 * Before the fix, the REVIEW_URL / REVIEW_FILE link (and its count) lived ONLY in
 * the prose text channel — a structuredContent-reading model would lose the
 * mandatory-to-surface review link entirely. The fix mirrors it into
 * structuredContent.enrichmentReview { count, url? | file? }. This test asserts
 * both channels agree.
 *
 * In stdio mode there is no HTTP port, so resolvePublicUrl() returns undefined and
 * the tool writes a REVIEW_FILE (the .file branch). The .url branch is symmetric.
 *
 * Run:  node scripts/tests/test-provenance-enrichment-review.mjs
 * Needs: built dist/ + data/vocabulary.db (an LLM-enriched artwork).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// An artwork whose provenance carries an LLM-enriched event (category_method =
// llm_enrichment). If a future re-parse reverts this, swap in any object_number
// from: SELECT a.object_number FROM provenance_events e JOIN artworks a
//   ON a.art_id = e.artwork_id WHERE e.category_method LIKE 'llm%' LIMIT 1;
const ENRICHED_OBJECT = "SK-A-4878";

let passed = 0;
let failed = 0;
const failures = [];
function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; failures.push(msg); console.log(`  ✗ ${msg}`); }
}

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  cwd: PROJECT_DIR,
  env: { ...process.env, STRUCTURED_CONTENT: "true" },
});
const client = new Client({ name: "test-provenance-enrichment-review", version: "0.1" });
await client.connect(transport);
console.log("Connected to server via stdio\n");

console.log(`--- search_provenance(objectNumber: ${ENRICHED_OBJECT}) — enrichmentReview parity ---`);
const res = await client.callTool({
  name: "search_provenance",
  arguments: { objectNumber: ENRICHED_OBJECT, compact: false },
});

const sc = res.structuredContent;
const text = res.content?.find(c => c.type === "text")?.text ?? "";

assert(sc != null, "structuredContent present");
const er = sc?.enrichmentReview;
assert(er != null, "structuredContent.enrichmentReview present (was prose-only before the fix)");
assert(typeof er?.count === "number" && er.count >= 1, `enrichmentReview.count >= 1 (got ${er?.count})`);

// stdio → file branch.
assert(typeof er?.file === "string" && er.file.length > 0, "enrichmentReview.file present (stdio/file branch)");
assert(er?.url === undefined, "enrichmentReview.url absent in stdio mode (no HTTP base URL)");

// Cross-channel agreement: the structured file path must equal the REVIEW_FILE the
// prose mandates the model surface verbatim.
assert(text.includes("REVIEW_FILE:"), "text channel still carries the REVIEW_FILE line");
if (er?.file) {
  assert(text.includes(er.file), "structuredContent.enrichmentReview.file === the REVIEW_FILE path in prose");
}
// Count agreement: the "ENRICHMENT REVIEW: N LLM-assisted result(s)" line matches.
const m = text.match(/ENRICHMENT REVIEW:\s*(\d+)\s+LLM-assisted/);
assert(m != null, "text channel carries the ENRICHMENT REVIEW count line");
if (m) assert(Number(m[1]) === er?.count, `prose count (${m?.[1]}) === structured count (${er?.count})`);

console.log(`\n${"═".repeat(60)}`);
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
if (failures.length) { console.log("\n  Failures:"); for (const f of failures) console.log(`   ✗ ${f}`); }
console.log(`${"═".repeat(60)}`);

await client.close();
process.exit(failed === 0 ? 0 : 1);
