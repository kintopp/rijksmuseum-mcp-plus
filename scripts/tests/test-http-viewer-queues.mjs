#!/usr/bin/env node
/**
 * HTTP cross-request test for viewerQueues persistence.
 *
 * Validates that viewUUID created in one HTTP request is reachable from
 * a subsequent independent request — the core invariant that makes
 * navigate_viewer + poll_viewer_commands work on claude.ai.
 *
 * Uses two independent MCP clients (separate StreamableHTTPClientTransport
 * instances) to simulate separate claude.ai turns hitting the stateless
 * HTTP endpoint. Each client.connect() triggers a fresh initialize handshake;
 * each callTool() is a separate POST /mcp that creates a new McpServer +
 * transport on the server side. viewerQueues must survive across all of these.
 *
 * Run:
 *   # Terminal 1: start HTTP server
 *   PORT=3000 node dist/index.js
 *
 *   # Terminal 2: run test
 *   node scripts/tests/test-http-viewer-queues.mjs [--url http://localhost:3000/mcp]
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.argv.includes("--url")
  ? process.argv[process.argv.indexOf("--url") + 1]
  : "http://localhost:3000/mcp";

// ── Test helpers ──────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, msg) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}

function section(name) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ${name}`);
  console.log(`${"═".repeat(60)}`);
}

async function makeClient(label) {
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client({ name: `test-http-${label}`, version: "0.1" });
  await client.connect(transport);
  return client;
}

// ══════════════════════════════════════════════════════════════════

console.log(`Testing against ${url}\n`);

// ── Client A: get_artwork_image → viewUUID ──────────────────────

section("1. Client A — get_artwork_image (creates viewerQueue entry)");

const clientA = await makeClient("A");

const r1 = await clientA.callTool({
  name: "get_artwork_image",
  arguments: { objectNumber: "SK-C-5" },
});
const img1 = r1.structuredContent ?? JSON.parse(r1.content[0].text);
const viewUUID = img1.viewUUID;

assert(typeof viewUUID === "string" && viewUUID.length === 36,
  `viewUUID created (${viewUUID.slice(0, 8)}...)`);
assert(img1.objectNumber === "SK-C-5", `objectNumber correct`);

await clientA.close();
console.log("  Client A closed.\n");

// ── Client B: navigate_viewer with viewUUID from Client A ───────

section("2. Client B — navigate_viewer (cross-request queue access)");

const clientB = await makeClient("B");

const r2 = await clientB.callTool({
  name: "navigate_viewer",
  arguments: {
    viewUUID,
    commands: [
      { action: "clear_overlays" },
      { action: "navigate", region: "full" },
      { action: "add_overlay", region: "pct:25,25,50,50", label: "Cross-request overlay", color: "orange" },
    ],
  },
});
const nav = r2.structuredContent ?? JSON.parse(r2.content[0].text);

assert(!r2.isError, "Not an error (queue found)");
assert(nav.queued === 3, `Queued 3 commands (got ${nav.queued})`);
assert(nav.viewUUID === viewUUID, "viewUUID echoed back");
assert(!nav.error, "No error message");

await clientB.close();
console.log("  Client B closed.\n");

// ── Client C: poll_viewer_commands (drains queue from Client B) ─

section("3. Client C — poll_viewer_commands (cross-request drain)");

const clientC = await makeClient("C");

const r3 = await clientC.callTool({
  name: "poll_viewer_commands",
  arguments: { viewUUID },
});
const poll = r3.structuredContent ?? JSON.parse(r3.content[0].text);

assert(Array.isArray(poll.commands), "commands is an array");
assert(poll.commands.length === 3, `Drained 3 commands (got ${poll.commands.length})`);
assert(poll.commands[0].action === "clear_overlays", "First: clear_overlays");
assert(poll.commands[1].action === "navigate", "Second: navigate");
assert(poll.commands[2].action === "add_overlay", "Third: add_overlay");
assert(poll.commands[2].label === "Cross-request overlay", "Label preserved across requests");
assert(poll.commands[2].color === "orange", "Color preserved across requests");

// Poll again — should be empty
const r4 = await clientC.callTool({
  name: "poll_viewer_commands",
  arguments: { viewUUID },
});
const poll2 = r4.structuredContent ?? JSON.parse(r4.content[0].text);
assert(poll2.commands.length === 0, "Second poll returns empty (queue drained)");

await clientC.close();
console.log("  Client C closed.\n");

// ── Client D: navigate_viewer with stale UUID (negative test) ───

section("4. Client D — stale viewUUID (negative test)");

const clientD = await makeClient("D");

const r5 = await clientD.callTool({
  name: "navigate_viewer",
  arguments: {
    viewUUID: "00000000-0000-0000-0000-000000000000",
    commands: [{ action: "navigate", region: "full" }],
  },
});

assert(r5.isError === true, "Stale UUID → isError");
const nav5 = r5.structuredContent ?? JSON.parse(r5.content[0].text);
assert(nav5.error?.includes("No active viewer"), `Error: "${nav5.error?.slice(0, 40)}"`);

await clientD.close();
console.log("  Client D closed.\n");

// ── Summary ─────────────────────────────────────────────────────

section("RESULTS");
console.log(`\n  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
if (failures.length > 0) {
  console.log(`\n  Failures:`);
  for (const f of failures) console.log(`    ✗ ${f}`);
}
console.log();

process.exit(failed > 0 ? 1 : 0);
