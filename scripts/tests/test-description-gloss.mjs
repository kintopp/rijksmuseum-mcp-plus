#!/usr/bin/env node
/**
 * test-description-gloss.mjs — tool-description lead budget gate.
 *
 * Clients truncate the tool-list gloss by CHARACTER count; the binding budget
 * is the deferred-tool catalogue's 79-char cut (claude.ai's direct roster
 * allows ~118-120, but 79 is the floor that survives everywhere). Each visible
 * tool's first sentence must be semantically complete within 79 code points.
 * Hidden app-only tools (_meta.ui.visibility: ["app"]) are exempt — their
 * gloss is never shown. Also guards the server `instructions` block against
 * the ~2048-char per-server cut (measured: RIJKS+ was truncated at char 2048).
 *
 * Runs against the synthetic fixture vocabulary DB, not data/: tool
 * registration is gated on DB availability, and this gate can only budget the
 * descriptions of tools that registered.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildFixture } from "./build-fixture-vocab-db.mjs";
import { resolveDbPath } from "../../dist/utils/db.js";

const GLOSS_BUDGET = 79;
const INSTRUCTIONS_BUDGET = 2048;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Bump when a tool is added. The docs-side roster is gated by test-docs-drift;
// this count exists so a SHRINKING roster can't quietly shrink the gate with it.
const TOOL_COUNT = 19;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(ROOT, "dist", "index.js")],
  env: {
    ...process.env,
    MCP_SKIP_STARTUP_WARM: "1",
    ENABLE_FIND_SIMILAR: "true",
    VOCAB_DB_PATH: buildFixture("fixture-gloss.db"),
  },
  stderr: "ignore",
});
const client = new Client({ name: "gloss-test", version: "0.0.0" });
await client.connect(transport);

let failures = 0;
function fail(msg) {
  failures++;
  console.error(`  FAIL: ${msg}`);
}

const instructions = client.getInstructions() ?? "";
const instrLen = [...instructions].length;
if (instrLen >= INSTRUCTIONS_BUDGET) {
  fail(`server instructions are ${instrLen} chars (budget < ${INSTRUCTIONS_BUDGET}) — the tail gets cut`);
} else {
  console.log(`  ok: server instructions ${instrLen}/${INSTRUCTIONS_BUDGET} chars`);
}

const { tools } = await client.listTools();
// No fixture stands in for the embeddings DB, so semantic_search is absent
// wherever it is. Every other tool must be present: a partial roster would
// silently drop the longest descriptions from this budget check.
const expected = resolveDbPath("EMBEDDINGS_DB_PATH", "embeddings.db") ? TOOL_COUNT : TOOL_COUNT - 1;
if (tools.length !== expected) {
  fail(`tools/list returned ${tools.length} tools, expected ${expected} — the gloss budget went unchecked for the rest`);
}

for (const tool of tools) {
  const visibility = tool._meta?.ui?.visibility;
  if (Array.isArray(visibility) && visibility.includes("app") && visibility.length === 1) {
    console.log(`  skip: ${tool.name} (app-only, gloss never shown)`);
    continue;
  }
  const desc = tool.description ?? "";
  const sentenceMatch = /^[\s\S]*?\.(?=\s|$)/.exec(desc);
  const lead = (sentenceMatch ? sentenceMatch[0] : desc).trim();
  const leadLen = [...lead].length;
  if (leadLen > GLOSS_BUDGET) {
    fail(`${tool.name}: first sentence is ${leadLen} chars (budget ${GLOSS_BUDGET}): "${lead}"`);
  } else if (leadLen === 0) {
    fail(`${tool.name}: empty description`);
  } else {
    console.log(`  ok: ${tool.name} lead ${leadLen}/${GLOSS_BUDGET}`);
  }
}

await client.close();

if (failures > 0) {
  console.error(`description-gloss: ${failures} check(s) failed`);
  process.exit(1);
}
console.log(`description-gloss: all ${tools.length} tools within budget`);
