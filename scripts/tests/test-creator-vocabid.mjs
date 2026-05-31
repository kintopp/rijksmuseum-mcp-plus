#!/usr/bin/env node
/**
 * test-creator-vocabid.mjs — #364 regression.
 *
 * The documented handoff is search_persons → search_artwork({creator: <vocabId>}).
 * Before the fix, passing the numeric vocabId to `creator` returned 0 (it was
 * FTS-matched as a label and missed); only the person's label composed. This
 * verifies the vocabId path now resolves exactly and reconciles with artworkCount,
 * that the label path still works, and that a non-id name input is unaffected.
 *
 * Needs the local vocab DB + a built dist (`npm run build`).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  cwd: process.cwd(),
  env: { ...process.env, STRUCTURED_CONTENT: "true" },
});
const client = new Client({ name: "creator-vocabid-test", version: "1.0" });
await client.connect(transport);
console.log("Connected\n");

let passed = 0, failed = 0;
function check(label, cond) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.log(`  ✗ ${label}`); failed++; }
}

async function call(name, args) {
  try {
    const r = await client.callTool({ name, arguments: args });
    if (r.isError) return { _error: r.content?.[0]?.text ?? "" };
    return r.structuredContent ?? (r.content?.[0]?.text ? JSON.parse(r.content[0].text) : r);
  } catch (e) {
    return { _error: e.message };
  }
}

// Resolve a person, then check id-path === artworkCount === label-path.
async function reconcile(name) {
  console.log(`\n${name}: search_persons → search_artwork({creator})`);
  const p = await call("search_persons", { name, maxResults: 1 });
  const person = p?.persons?.[0];
  check("person resolved", !!person?.vocabId);
  if (!person?.vocabId) return;
  const { vocabId, label, artworkCount } = person;
  console.log(`   ${label} — vocabId ${vocabId}, artworkCount ${artworkCount}`);

  const byId = await call("search_artwork", { creator: vocabId, compact: true });
  const byLabel = await call("search_artwork", { creator: label, compact: true });
  console.log(`   creator=<vocabId> → totalResults ${byId?.totalResults}`);
  console.log(`   creator=<label>  → totalResults ${byLabel?.totalResults}`);

  check("vocabId path is non-zero (was 0 before #364 fix)", (byId?.totalResults ?? 0) > 0);
  check("vocabId path reconciles exactly with artworkCount", byId?.totalResults === artworkCount);
  check("label path still works", (byLabel?.totalResults ?? 0) > 0);
}

await reconcile("Gerrit Dou");          // unique label — both paths agree
await reconcile("Frans van Mieris");    // disambiguated family — id is the exact handle

// A non-id name input must be unaffected by the numeric fast-path.
console.log("\nName input unaffected: creator='Rembrandt van Rijn'");
const r = await call("search_artwork", { creator: "Rembrandt van Rijn", compact: true });
check("name still resolves to many works", (r?.totalResults ?? 0) > 100);
console.log(`   totalResults ${r?.totalResults}`);

// A bare-numeric value that is not a vocab id falls through to FTS (→ 0, no crash).
console.log("\nUnknown numeric id: creator='999999999999' → graceful 0");
const r2 = await call("search_artwork", { creator: "999999999999", compact: true });
check("no error, zero results", !r2?._error && (r2?.totalResults ?? 0) === 0);

console.log(`\n${passed} passed, ${failed} failed`);
await client.close();
process.exit(failed === 0 ? 0 : 1);
