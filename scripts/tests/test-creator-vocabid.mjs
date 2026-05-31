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

  // #366: collection_stats must honour the same creator=<vocabId> handoff.
  // Before the fix the stats path FTS-matched the numeric id as a label → total 0.
  const statsById = await call("collection_stats", { dimension: "century", creator: vocabId, topN: 5 });
  const statsByLabel = await call("collection_stats", { dimension: "century", creator: label, topN: 5 });
  console.log(`   collection_stats creator=<vocabId> → total ${statsById?.total}`);
  console.log(`   collection_stats creator=<label>  → total ${statsByLabel?.total}`);
  check("stats vocabId path is non-zero (was 0 before #366 fix)", (statsById?.total ?? 0) > 0);
  check("stats vocabId path reconciles with artworkCount", statsById?.total === artworkCount);
  // Label path stays label-based (may span multiple same-named people, like the
  // search_artwork case above) — only assert it resolves, not that it equals the id path.
  check("stats label path still works", (statsByLabel?.total ?? 0) > 0);
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

// #367: a creator ARRAY is AND-combined (works jointly crediting ALL listed
// creators), NOT an OR cohort. Two distinct solo painters share ~no joint works,
// so the array result is ≤ the smaller single result — never the union (≥ max).
// This is why passing a demographic cohort as one creator=[…] array was wrong
// (skill guidance corrected in SKILL.md v0.46).
console.log("\ncreator array is AND, not OR (#367 cohort trap)");
const dou = (await call("search_persons", { name: "Gerrit Dou", maxResults: 1 }))?.persons?.[0];
const mieris = (await call("search_persons", { name: "Frans van Mieris", maxResults: 1 }))?.persons?.[0];
check("both persons resolved", !!dou?.vocabId && !!mieris?.vocabId);
if (dou?.vocabId && mieris?.vocabId) {
  const a = await call("search_artwork", { creator: dou.vocabId, compact: true });
  const b = await call("search_artwork", { creator: mieris.vocabId, compact: true });
  const both = await call("search_artwork", { creator: [dou.vocabId, mieris.vocabId], compact: true });
  const lo = Math.min(a?.totalResults ?? 0, b?.totalResults ?? 0);
  const hi = Math.max(a?.totalResults ?? 0, b?.totalResults ?? 0);
  console.log(`   ${dou.label}=${a?.totalResults}, ${mieris.label}=${b?.totalResults}, [both]=${both?.totalResults}`);
  check("each single creator is non-zero", (a?.totalResults ?? 0) > 0 && (b?.totalResults ?? 0) > 0);
  check("array result ≤ min single (AND ⊆ each set)", (both?.totalResults ?? 0) <= lo);
  check("array result is NOT the OR union (≥ max)", (both?.totalResults ?? 0) < hi);
}

console.log(`\n${passed} passed, ${failed} failed`);
await client.close();
process.exit(failed === 0 ? 0 : 1);
