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
 *   5. the mirror doc reproduces each live description verbatim
 *
 * It cannot catch SEMANTIC drift — a doc and a schema can agree with each
 * other and both be wrong about behaviour. Those need a human or a DB check.
 *
 * Runs against the synthetic fixture vocabulary DB, not data/: tool
 * registration is gated on DB availability, so without it CI would see a
 * partial registry and report every unregistered tool as a doc phantom.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { buildFixture } from "./build-fixture-vocab-db.mjs";
import { resolveDbPath } from "../../dist/utils/db.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PARAM_DOC = join(ROOT, "docs", "mcp-tool-parameters.md");
const MIRROR_DOC = join(ROOT, "docs", "mcp-server+tool-descriptions.md");

// Sub-object keys documented with a "↳" continuation row rather than as
// top-level params. Listing them explicitly keeps the check honest.
const NESTED_KEYS = new Set(["action", "region", "relativeTo", "relativeToSize"]);

// No fixture stands in for the embeddings DB (834K vectors + an ONNX model), so
// these tools are absent wherever it is, and their doc sections go unverified.
// Gated on the backend actually being missing: a tool that fails to register
// WITH its backend present is a real fault, not an environment gap.
const OPTIONAL_BACKEND_TOOLS = new Map([
  ["semantic_search", {
    backend: "embeddings DB + embedding model",
    absent: () => resolveDbPath("EMBEDDINGS_DB_PATH", "embeddings.db") === null,
  }],
]);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(ROOT, "dist", "index.js")],
  env: {
    ...process.env,
    MCP_SKIP_STARTUP_WARM: "1",
    ENABLE_FIND_SIMILAR: "true",
    VOCAB_DB_PATH: buildFixture("fixture-docs-drift.db"),
  },
  stderr: "ignore",
});
const client = new Client({ name: "docs-drift-test", version: "0.0.0" });
await client.connect(transport);

let failures = 0;
let unverified = 0;
const fail = (msg) => { failures++; console.error(`  FAIL: ${msg}`); };
const note = (msg) => { unverified++; console.log(`  NOTE: ${msg}`); };

// `String.split` on a one-capture-group regex yields [pre, name, body, name, body…].
const sectionsOf = (text, headingRe) => {
  const parts = text.split(headingRe);
  const out = new Map();
  for (let i = 1; i < parts.length; i += 2) out.set(parts[i], parts[i + 1]);
  return out;
};

const { tools } = await client.listTools();
const registered = new Map(tools.map((t) => [t.name, t]));

// App-only helpers are hidden from agents; the reference deliberately omits them.
const hidden = new Set(
  tools.filter((t) => t._meta?.["ui/visibility"]?.includes("app")
                   || t._meta?.ui?.visibility?.includes("app")).map((t) => t.name)
);

const doc = readFileSync(PARAM_DOC, "utf8");
const sections = sectionsOf(doc, /\n## ([a-z_][a-z0-9_]*)\n/);

// Documented but unregistered: a phantom, unless the tool's backend is absent.
const phantomCheck = (name, docFile) => {
  const gate = OPTIONAL_BACKEND_TOOLS.get(name);
  if (gate?.absent()) {
    note(`'${name}' not registered (no ${gate.backend}) — its ${docFile} section went unverified`);
  } else {
    fail(`${docFile} documents '${name}', which is not a registered tool`);
  }
};

// ── 1 + 2: tool inventory, both directions ──────────────────────────────────
for (const name of registered.keys()) {
  if (hidden.has(name)) continue;
  if (!sections.has(name)) fail(`registered tool '${name}' has no section in docs/mcp-tool-parameters.md`);
}
for (const name of sections.keys()) {
  if (!registered.has(name)) phantomCheck(name, "docs/mcp-tool-parameters.md");
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
// Asserted unconditionally: gating this on the doc sentence would silently turn
// the check into a no-op the moment that sentence is reworded.
if (promptCount > 0) {
  fail(`server registers ${promptCount} prompt(s); docs/ describes none — document them or drop them`);
}
const claimsNoPrompts = /registers no MCP prompts/.test(
  readFileSync(join(ROOT, "docs", "technical-guide.md"), "utf8")
);
if (!claimsNoPrompts) {
  fail("technical-guide.md no longer says 'registers no MCP prompts' — if prompts are now documented, update this check");
}

// ── 5: the mirror doc reproduces the live server verbatim ───────────────────
// Regenerate with: node scripts/sync-tool-descriptions.mjs
const mirror = readFileSync(MIRROR_DOC, "utf8");
const squash = (s) => s.replace(/\s+/g, " ").trim();
const staleMirror = (what) =>
  fail(`${what}: docs/mcp-server+tool-descriptions.md no longer mirrors the live server — run scripts/sync-tool-descriptions.mjs`);

// The instructions block is hand-written prose with no other owner, so it is
// the part of the mirror most prone to silent drift.
const quotedBlock = /## Server Description\n\n([\s\S]*?)\n\n---/.exec(mirror)?.[1] ?? "";
const quotedInstructions = quotedBlock.split("\n").map((l) => l.replace(/^> ?/, "")).join("\n");
if (squash(quotedInstructions) !== squash(client.getInstructions() ?? "")) staleMirror("server instructions");

// Headings may carry an annotation suffix, e.g. '*(app tool — user-facing)*'.
const mirrored = sectionsOf(mirror, /\n### \d+\. `([a-z_]+)`.*\n/);
for (const [name, tool] of registered) {
  const section = mirrored.get(name);
  if (section === undefined) {
    fail(`docs/mcp-server+tool-descriptions.md has no section for registered tool '${name}'`);
  } else if (squash(section.split(/\n## /)[0]) !== squash(tool.description ?? "")) {
    staleMirror(name);
  }
}
for (const name of mirrored.keys()) {
  if (!registered.has(name)) phantomCheck(name, "docs/mcp-server+tool-descriptions.md");
}

await client.close();

const visible = [...registered.keys()].filter((n) => !hidden.has(n)).length;
if (failures) {
  console.error(`\ndocs-drift: ${failures} failure(s)`);
  process.exit(1);
}
const skipped = unverified ? `; ${unverified} section(s) unverified` : "";
console.log(`docs-drift: ${visible} visible tools (+${hidden.size} hidden) match docs/, mirror in sync, no phantom prompts${skipped}`);
