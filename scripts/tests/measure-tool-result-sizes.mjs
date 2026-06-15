/**
 * Size audit: do any tools exceed the documented per-result ceilings at MAX limits?
 *   - claude.ai / Claude Desktop: ~150,000 characters per tool result
 *   - Claude Code: ~25,000 tokens (~100,000 chars), configurable
 *
 * Measures, per tool, the CURRENT result shape (human text + structuredContent):
 *   textChars   = sum of content[].text lengths (what text-reading hosts feed the model)
 *   structChars = JSON.stringify(structuredContent).length
 *   totalChars  = JSON.stringify(whole result).length (closest to what the host meters)
 *   proj+json   = textChars + structChars  (projected text channel IF MCP_TEXT_JSON_COMPAT were ON)
 *
 * Run: node scripts/tests/measure-tool-result-sizes.mjs   (requires built dist/ + local DBs)
 * Excludes the viewer/image tools (inspect_artwork_image returns base64 image bytes by design,
 * not structured JSON; get_artwork_image / navigate_viewer / poll / remount are session tools).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CEILING = 150_000;   // claude.ai / Desktop
const CC = 100_000;        // Claude Code ~25k tokens ≈ 100k chars
const WARN = 120_000;      // plan 023 SAFE_RESULT_BUDGET

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  cwd: PROJECT_DIR,
  env: { ...process.env, MCP_SKIP_STARTUP_WARM: "1", STRUCTURED_CONTENT: "true", ENABLE_FIND_SIMILAR: "true" },
});
const client = new Client({ name: "size-audit", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);
console.log("Connected. Resolving a curated setSpec…");

let setSpec = "26121";
try {
  const sets = await client.callTool({ name: "list_curated_sets", arguments: {} }, undefined, { timeout: 120_000 });
  const arr = sets.structuredContent?.sets ?? [];           // read structured list, not the prose
  const top = [...arr].sort((a, b) => (b.memberCount || 0) - (a.memberCount || 0))[0];  // largest set = heaviest browse
  if (top?.setSpec) setSpec = String(top.setSpec);
} catch (e) {
  console.log(`  (list_curated_sets failed, using fallback setSpec ${setSpec}: ${e.message || e})`);
}

const from = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);

// Each call is shaped to MAXIMIZE result size at the tool's documented max limit.
const CALLS = [
  ["get_artwork_details", { objectNumber: "SK-C-5" }],                                  // richest single artwork
  ["search_artwork", { type: "print", maxResults: 50 }],                                // 50 rows + facets
  ["search_persons", { profession: "schilder", maxResults: 100 }],                      // 100 persons
  ["semantic_search", { query: "landscape", maxResults: 50 }],                          // 50 × reconstructed sourceText
  ["search_provenance", { location: "Amsterdam", maxResults: 50 }],                     // 50 × full provenance chain
  ["search_inscriptions", { inscriptionType: "signature", maxResults: 100 }],          // 100 × inscription segments
  ["browse_set", { setSpec, maxResults: 50, includeExtentText: true }],                // 50 EDM records w/ descriptions
  ["get_recent_changes", { from, maxResults: 50 }],                                     // 50 full EDM/OAI records
  ["find_similar", { objectNumber: "SK-C-5", maxResults: 50 }],                         // 9 channels × up to 50
  ["collection_stats", { dimension: "creator", topN: 500 }],                            // 500-row distribution
];

const rows = [];
for (const [name, args] of CALLS) {
  process.stdout.write(`  calling ${name} … `);
  try {
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
    const textChars = (r.content || []).filter((c) => c.type === "text").reduce((s, c) => s + (c.text?.length || 0), 0);
    const structChars = r.structuredContent ? JSON.stringify(r.structuredContent).length : 0;
    const totalChars = JSON.stringify(r).length;
    rows.push({ name, isError: !!r.isError, textChars, structChars, totalChars, projJson: textChars + structChars });
    console.log(`ok (total ${totalChars.toLocaleString()} chars${r.isError ? ", isError" : ""})`);
  } catch (e) {
    rows.push({ name, error: String(e.message || e) });
    console.log(`ERROR: ${e.message || e}`);
  }
}
await client.close();

const flag = (n) => (n >= CEILING ? "⛔EXCEEDS-150k" : n >= WARN ? "⚠near-150k" : n >= CC ? "△>100k(CC)" : "");
const pad = (s, w) => String(s).padEnd(w);
const num = (n, w) => String(n.toLocaleString()).padStart(w);

console.log("\n" + "═".repeat(96));
console.log("  Tool result sizes at MAX limits (chars)");
console.log("═".repeat(96));
console.log(`  ${pad("tool", 22)} ${pad("text", 10)} ${pad("structured", 11)} ${pad("TOTAL", 10)} ${pad("proj+json", 10)} flags`);
console.log("  " + "─".repeat(92));
rows.sort((a, b) => (b.totalChars || 0) - (a.totalChars || 0));
for (const r of rows) {
  if (r.error) { console.log(`  ${pad(r.name, 22)} ERROR: ${r.error}`); continue; }
  const f = [flag(r.textChars), flag(r.structChars), flag(r.totalChars)].filter(Boolean).join(" ");
  const projF = r.projJson >= CEILING ? " | proj+json⛔" : r.projJson >= WARN ? " | proj+json⚠" : "";
  console.log(`  ${pad(r.name, 22)} ${num(r.textChars, 10)} ${num(r.structChars, 11)} ${num(r.totalChars, 10)} ${num(r.projJson, 10)} ${f}${projF}`);
}
console.log("═".repeat(96));
const breaches = rows.filter((r) => !r.error && (r.textChars >= CEILING || r.structChars >= CEILING || r.totalChars >= CEILING));
console.log(`\n  ${breaches.length} tool(s) exceed the ~150k claude.ai/Desktop ceiling at max limits: ` +
  (breaches.length ? breaches.map((r) => r.name).join(", ") : "none"));
const projBreaches = rows.filter((r) => !r.error && r.projJson >= CEILING && r.totalChars < CEILING);
console.log(`  ${projBreaches.length} additional tool(s) would breach ONLY if MCP_TEXT_JSON_COMPAT were enabled: ` +
  (projBreaches.length ? projBreaches.map((r) => r.name).join(", ") : "none"));
