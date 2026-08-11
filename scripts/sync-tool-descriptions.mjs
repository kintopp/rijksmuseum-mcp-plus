#!/usr/bin/env node
/**
 * sync-tool-descriptions.mjs — regenerate docs/mcp-server+tool-descriptions.md
 * from the live server.
 *
 * That file is defined as a verbatim mirror of the server `instructions` block
 * and every tool `description`, so keeping it in sync by hand is a losing game:
 * a lead-sentence rewrite across the tool roster left 16 of 19 sections stale.
 *
 * Preserved from the existing file: the title and the prose above
 * "## Server Description". Everything else — the instructions blockquote, the
 * tool-count roster line, and every heading + description — is regenerated.
 *
 * Drift is caught by test-docs-drift.mjs (check 5), which runs in the gate
 * suite; this script is the fixer, not the detector.
 *
 * Run:  node scripts/sync-tool-descriptions.mjs
 * Requires: npm run build, plus data/ (all 19 tools must register).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOC = join(ROOT, "docs", "mcp-server+tool-descriptions.md");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(ROOT, "dist", "index.js")],
  env: { ...process.env, MCP_SKIP_STARTUP_WARM: "1", ENABLE_FIND_SIMILAR: "true" },
  stderr: "ignore",
});
const client = new Client({ name: "docs-sync", version: "0.0.0" });
await client.connect(transport);
const instructions = client.getInstructions() ?? "";
const { tools } = await client.listTools();
await client.close();

// A partial registry would silently delete sections for the unregistered tools.
if (tools.length < 19) {
  console.error(`✗ only ${tools.length} tools registered — run with data/ present so the full roster is visible`);
  process.exit(2);
}

const existing = readFileSync(DOC, "utf8");

// App tools are the ones the viewer bridge uses: the render tool carries a
// resource URI, its helpers are hidden from agents entirely.
const isHidden = (t) => t._meta?.["ui/visibility"]?.includes("app") || t._meta?.ui?.visibility?.includes("app");
const isRender = (t) => Boolean(t._meta?.["ui/resourceUri"] ?? t._meta?.ui?.resourceUri);
const annotate = (t) => (isHidden(t) ? " *(app tool — internal)*" : isRender(t) ? " *(app tool — user-facing)*" : "");

const appTools = tools.filter((t) => isHidden(t) || isRender(t));
const roster =
  `${tools.length} tools total: ${tools.length - appTools.length} standard tools + ${appTools.length} app tools ` +
  `(${tools.filter(isRender).map((t) => `\`${t.name}\``).join(", ")} user-facing; ` +
  `${tools.filter(isHidden).map((t) => `\`${t.name}\``).join(" and ")} internal viewer plumbing). ` +
  "Listed in registration order — this is the order the SDK surfaces them in `tools/list`.";

const [preamble] = existing.split(/\n### 1\. /);
const quoted = instructions
  .split("\n\n")
  .map((p) => `> ${p}`)
  .join("\n>\n");
const head = preamble
  .replace(/(## Server Description\n\n)[\s\S]*?(\n\n---)/, `$1${quoted}$2`)
  .replace(/^\d+ tools total:.*$/m, roster)
  .replace(/\n+$/, "");

const sections = tools.map((t, i) =>
  `### ${i + 1}. \`${t.name}\`${annotate(t)}\n\n${(t.description ?? "").trim()}\n`
);

const next = `${head}\n\n${sections.join("\n")}`;

if (next === existing) {
  console.log(`✓ ${DOC} is in sync (${tools.length} tools)`);
  process.exit(0);
}
writeFileSync(DOC, next);
console.log(`✓ rewrote ${DOC} from the live server (${tools.length} tools)`);
