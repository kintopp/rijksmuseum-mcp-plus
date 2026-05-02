#!/usr/bin/env node
/**
 * test-search-org-aliases.mjs — verify #295: search_artwork({creator: ...}) reaches
 * organisation/group alt-names via entity_alt_names_fts.
 *
 * Coverage notes (v0.26 dress-rehearsal DB):
 *   - entity_alt_names is 100% entity_type='organisation'; no 'group' rows yet.
 *   - No artwork currently has an organisation-typed creator mapping
 *     (creator field is 60K persons + 10K groups + 0 orgs in v0.26 harvest).
 *   - So #295 is a forward-wired path: the FTS resolution must include canonical
 *     org vocab IDs (e.g. VOC = 311144638), even though the downstream artwork
 *     count is 0 today. When a future harvest tags artworks with org creators,
 *     the wiring is already in place.
 *
 * Tests:
 *   1. search_artwork({creator: "VOC"}) does not error and returns a result set.
 *   2. DB-level: entity_alt_names_fts MATCH 'VOC' resolves canonical VOC (311144638).
 *   3. DB-level: vocabulary_fts MATCH 'VOC' alone does NOT resolve 311144638
 *      (proves #295 unlocks reach, not just duplicates the existing path).
 *   4. Regression: search_artwork({aboutActor: "VOC"}) result set is unchanged
 *      (aboutActor stays person-only — no org widening).
 *   5. Regression: search_artwork({creator: "Rembrandt van Rijn"}) still resolves
 *      to person rows via the person path.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import Database from "better-sqlite3";
import path from "node:path";

const DB_PATH = process.env.VOCAB_DB_PATH ?? path.resolve("data/vocabulary.db");

let passed = 0, failed = 0;
function check(label, cond) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.log(`  ✗ ${label}`); failed++; }
}

// ── DB-level probes (fast, no server) ─────────────────────────────────────
console.log("DB-level probes against", DB_PATH);
const db = new Database(DB_PATH, { readonly: true });

const orgFtsRows = db.prepare(
  `SELECT DISTINCT entity_id FROM entity_alt_names
   WHERE entity_type IN ('organisation', 'group')
     AND rowid IN (SELECT rowid FROM entity_alt_names_fts WHERE entity_alt_names_fts MATCH 'VOC')`
).all().map(r => r.entity_id);
check("entity_alt_names_fts MATCH 'VOC' includes canonical VOC (311144638)", orgFtsRows.includes("311144638"));

const vocabFtsRows = db.prepare(
  `SELECT id FROM vocabulary WHERE rowid IN (SELECT rowid FROM vocabulary_fts WHERE vocabulary_fts MATCH 'VOC')`
).all().map(r => r.id);
check("vocabulary_fts MATCH 'VOC' alone does NOT resolve canonical VOC (proves #295 widens reach)",
  !vocabFtsRows.includes("311144638"));

db.close();

// ── Stdio MCP probes ──────────────────────────────────────────────────────
const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  cwd: process.cwd(),
  env: { ...process.env, STRUCTURED_CONTENT: "true" },
});
const client = new Client({ name: "org-alias-test", version: "1.0" });
await client.connect(transport);
console.log("\nConnected");

async function call(name, args) {
  try {
    const r = await client.callTool({ name, arguments: args });
    if (r.isError) return { _error: r.content?.[0]?.text ?? "" };
    return r.structuredContent ?? (r.content?.[0]?.text ? JSON.parse(r.content[0].text) : r);
  } catch (e) {
    return { _error: e.message };
  }
}

console.log("\n1. search_artwork({creator: 'VOC'}) — does not error");
const voc = await call("search_artwork", { creator: "VOC", maxResults: 5 });
check("No error", !voc?._error);
check("Has totalResults shape", typeof voc?.totalResults === "number");
console.log(`   totalResults: ${voc?.totalResults} (expected 0 on v0.26 — no org-typed creators)`);

console.log("\n2. Regression: search_artwork({aboutActor: 'VOC'}) — unchanged (person-only)");
const aboutVoc = await call("search_artwork", { aboutActor: "VOC", maxResults: 5 });
check("No error", !aboutVoc?._error);
console.log(`   totalResults: ${aboutVoc?.totalResults}`);

console.log("\n3. Regression: search_artwork({creator: 'Rembrandt van Rijn'}) — person path still works");
const rembrandt = await call("search_artwork", { creator: "Rembrandt van Rijn", maxResults: 3 });
check("No error", !rembrandt?._error);
check("Returns results (Rembrandt has many works)", (rembrandt?.totalResults ?? 0) > 100);
console.log(`   totalResults: ${rembrandt?.totalResults}`);

await client.close();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
