// Regression smoke for #347.
//
// search_provenance with `party` + `positionMethod` must enforce that the same
// provenance_parties row on the same event satisfies both filters — not a
// different party on the same event, or a different event on the same artwork.
//
// Bug shape (pre-fix): RP-T-1887-A-1390 event 1 has parties
//   - "Jan Danser Nijman"          | position_method = role_mapping
//   - "P. Fouquet Jr, Amsterdam"   | position_method = llm_enrichment
// Query `{ party: "Nijman", positionMethod: "llm_enrichment" }` should return
// zero matches (Nijman wasn't llm-enriched). Pre-fix it returns the event with
// matched=true because the two filters compose on different party rows.
//
// Run: node scripts/tests/smoke-search-provenance-party-conjunction.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const transport = new StdioClientTransport({
  command: "node", args: ["dist/index.js"], cwd: PROJECT_DIR,
  env: { ...process.env, STRUCTURED_CONTENT: "true" },
});
const client = new Client({ name: "smoke-347", version: "0.1" });
await client.connect(transport);

let passed = 0, failed = 0;
function check(msg, cond) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.log(`  ✗ ${msg}`); }
}

async function searchProv(args) {
  const r = await client.callTool({ name: "search_provenance", arguments: args });
  return r.structuredContent;
}

// ── Case 1: known artwork with mixed parties on the same event ──
// Sanity: party alone returns the artwork+event.
const partyOnly = await searchProv({ party: "Nijman", maxResults: 5 });
const nijmanArt = partyOnly?.results?.find(a => a.objectNumber === "RP-T-1887-A-1390");
check("party='Nijman' returns RP-T-1887-A-1390", !!nijmanArt);
const nijmanEvent = nijmanArt?.events?.find(e => e.sequence === 1);
check("party='Nijman' marks event 1 as matched", nijmanEvent?.matched === true);

// Bug demo: party='Nijman' + positionMethod='llm_enrichment' should NOT match.
// Nijman was enriched via role_mapping; only "P. Fouquet Jr, Amsterdam" carries llm_enrichment.
const conjunct = await searchProv({ party: "Nijman", positionMethod: "llm_enrichment", maxResults: 5 });
const conjunctArt = conjunct?.results?.find(a => a.objectNumber === "RP-T-1887-A-1390");
if (conjunctArt) {
  const e1 = conjunctArt.events?.find(e => e.sequence === 1);
  check("same-event different-party combo no longer matches", e1?.matched !== true);
} else {
  check("artwork pool excludes mixed-party event", true);
}

// ── Case 2: positive — Fouquet IS the llm-enriched party ──
const positiveCase = await searchProv({ party: "Fouquet", positionMethod: "llm_enrichment", maxResults: 5 });
const fouquetArt = positiveCase?.results?.find(a => a.objectNumber === "RP-T-1887-A-1390");
check("party='Fouquet' + positionMethod='llm_enrichment' matches RP-T-1887-A-1390", !!fouquetArt);
const fouquetEvent = fouquetArt?.events?.find(e => e.sequence === 1);
check("event 1 stays matched when filters compose on the same party row",
  fouquetEvent?.matched === true);

// ── Case 3: solo filters keep their existing semantics ──
const soloPosition = await searchProv({ positionMethod: "llm_enrichment", maxResults: 3 });
check("positionMethod alone still returns results", (soloPosition?.results?.length ?? 0) > 0);
const soloParty = await searchProv({ party: "Fouquet", maxResults: 3 });
check("party alone still returns results", (soloParty?.results?.length ?? 0) > 0);

await client.close();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
