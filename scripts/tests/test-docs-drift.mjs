#!/usr/bin/env node
/**
 * test-docs-drift.mjs — docs/ vs live-schema inventory gate.
 *
 * The hand-maintained references under docs/ mirror the registered tools and
 * their inputSchemas. Nothing kept them honest, and they rotted: a whole
 * section documenting two MCP prompts that were never registered, 22 missing
 * collection_stats params, 9 missing dimension enum members, an undocumented
 * search_artwork filter.
 *
 * This gate catches EXISTENCE drift in both directions:
 *   1. every registered tool has a doc section
 *   2. every documented tool is registered
 *   3. per tool, every schema param is documented and vice versa
 *   4. docs claim no MCP prompts while the server registers none
 *
 * It cannot catch SEMANTIC drift — a doc and a schema can agree with each
 * other and both be wrong about behaviour. Those need a human or a DB check.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PARAM_DOC = join(ROOT, "docs", "mcp-tool-parameters.md");

// Sub-object keys documented with a "↳" continuation row rather than as
// top-level params. Listing them explicitly keeps the check honest.
const NESTED_KEYS = new Set(["action", "region", "relativeTo", "relativeToSize"]);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(ROOT, "dist", "index.js")],
  env: { ...process.env, MCP_SKIP_STARTUP_WARM: "1", ENABLE_FIND_SIMILAR: "true" },
  stderr: "ignore",
});
const client = new Client({ name: "docs-drift-test", version: "0.0.0" });
await client.connect(transport);

let failures = 0;
const fail = (msg) => { failures++; console.error(`  FAIL: ${msg}`); };

const { tools } = await client.listTools();
const registered = new Map(tools.map((t) => [t.name, t]));

// App-only helpers are hidden from agents; the reference deliberately omits them.
const hidden = new Set(
  tools.filter((t) => t._meta?.["ui/visibility"]?.includes("app")
                   || t._meta?.ui?.visibility?.includes("app")).map((t) => t.name)
);

const doc = readFileSync(PARAM_DOC, "utf8");
const parts = doc.split(/\n## ([a-z_][a-z0-9_]*)\n/);
const sections = new Map();
for (let i = 1; i < parts.length; i += 2) sections.set(parts[i], parts[i + 1]);

// ── 1 + 2: tool inventory, both directions ──────────────────────────────────
for (const name of registered.keys()) {
  if (hidden.has(name)) continue;
  if (!sections.has(name)) fail(`registered tool '${name}' has no section in docs/mcp-tool-parameters.md`);
}
for (const name of sections.keys()) {
  if (!registered.has(name)) fail(`docs/mcp-tool-parameters.md documents '${name}', which is not a registered tool`);
}

// ── 3: per-tool parameter inventory ─────────────────────────────────────────
for (const [name, body] of sections) {
  const tool = registered.get(name);
  if (!tool) continue;
  const schemaParams = new Set(Object.keys(tool.inputSchema?.properties ?? {}));

  // A row may name more than one param, e.g. "| `nearLat` / `nearLon` | …".
  const documented = new Set();
  for (const line of body.split("\n")) {
    const m = /^\|\s*(?:↳\s*)?((?:`[A-Za-z][A-Za-z0-9]*`\s*(?:\/\s*)?)+)\|/.exec(line);
    if (m) for (const g of m[1].matchAll(/`([A-Za-z][A-Za-z0-9]*)`/g)) documented.add(g[1]);
  }

  for (const p of schemaParams) {
    if (!documented.has(p)) fail(`${name}: schema param '${p}' is not documented`);
  }
  for (const p of documented) {
    if (!schemaParams.has(p) && !NESTED_KEYS.has(p)) {
      fail(`${name}: doc lists '${p}', which is not in the inputSchema (a strict-schema call would be rejected)`);
    }
  }
}

// ── 4: no phantom prompts ───────────────────────────────────────────────────
let promptCount = 0;
try {
  promptCount = (await client.listPrompts()).prompts.length;
} catch {
  promptCount = 0; // capability not advertised — the expected state
}
const claimsNoPrompts = /registers no MCP prompts/.test(
  readFileSync(join(ROOT, "docs", "technical-guide.md"), "utf8")
);
if (promptCount > 0 && claimsNoPrompts) {
  fail(`server registers ${promptCount} prompt(s) but technical-guide.md says it registers none`);
}

await client.close();

const visible = [...registered.keys()].filter((n) => !hidden.has(n)).length;
if (failures) {
  console.error(`\ndocs-drift: ${failures} failure(s)`);
  process.exit(1);
}
console.log(`docs-drift: ${visible} visible tools (+${hidden.size} hidden) match docs/mcp-tool-parameters.md; no phantom prompts`);
