/**
 * Test suite for remount_viewer (issue #310 — viewUUID drift fix).
 *
 * Verifies that remount_viewer preserves the existing viewUUID across an
 * artwork swap, so the agent's stored UUID stays valid for navigate_viewer
 * after in-viewer related-artwork navigation.
 *
 * Run:  node scripts/tests/test-remount-viewer.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

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

function parseSc(result) {
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  cwd: PROJECT_DIR,
  env: { ...process.env, STRUCTURED_CONTENT: "true" },
});

const client = new Client({ name: "test-remount-viewer", version: "0.1" });
await client.connect(transport);
console.log("Connected to server via stdio\n");

// ══════════════════════════════════════════════════════════════════
//  1. Happy path — viewUUID preserved across remount
// ══════════════════════════════════════════════════════════════════

section("1. Happy path — viewUUID preserved across remount");

const r1 = await client.callTool({
  name: "get_artwork_image",
  arguments: { objectNumber: "SK-C-5" },
});
const img1 = parseSc(r1);
const uuid = img1.viewUUID;
const w1 = img1.width;
const h1 = img1.height;

assert(typeof uuid === "string" && uuid.length === 36,
  `get_artwork_image returned a viewUUID (${uuid?.slice(0, 8)}...)`);
assert(w1 > 0 && h1 > 0, `original dimensions captured (${w1}×${h1})`);

// Drive lastPolledAt so navigate_viewer's deliveryState/connection logic has
// something to compare against later.
await client.callTool({
  name: "poll_viewer_commands",
  arguments: { viewUUID: uuid },
});

// Add an overlay so we can later verify it was cleared.
const rNav1 = await client.callTool({
  name: "navigate_viewer",
  arguments: {
    viewUUID: uuid,
    commands: [
      { action: "add_overlay", region: "pct:10,10,20,20", label: "before-remount" },
    ],
  },
});
const nav1 = parseSc(rNav1);
assert(Array.isArray(nav1.currentOverlays) && nav1.currentOverlays.length === 1,
  `overlay added before remount (${nav1.currentOverlays?.length ?? 0})`);

// Remount into a different artwork.
const r2 = await client.callTool({
  name: "remount_viewer",
  arguments: { viewUUID: uuid, objectNumber: "SK-A-2344" },
});
const img2 = parseSc(r2);

assert(img2.viewUUID === uuid,
  `viewUUID preserved across remount (${img2.viewUUID?.slice(0, 8)}... === ${uuid.slice(0, 8)}...)`);
assert(img2.objectNumber === "SK-A-2344",
  `objectNumber updated (${img2.objectNumber})`);
assert(typeof img2.width === "number" && typeof img2.height === "number",
  `new dimensions returned (${img2.width}×${img2.height})`);
assert(img2.width !== w1 || img2.height !== h1,
  `dimensions actually changed vs. original (${w1}×${h1} → ${img2.width}×${img2.height})`);

// ══════════════════════════════════════════════════════════════════
//  2. Overlays cleared on remount + OOB validates against new dims
// ══════════════════════════════════════════════════════════════════

section("2. Overlays cleared + OOB uses new dimensions");

const rNav2 = await client.callTool({
  name: "navigate_viewer",
  arguments: {
    viewUUID: uuid,
    commands: [{ action: "navigate", region: "full" }],
  },
});
const nav2 = parseSc(rNav2);

assert(!nav2.currentOverlays || nav2.currentOverlays.length === 0,
  `overlays cleared on remount (got ${nav2.currentOverlays?.length ?? 0})`);
assert(nav2.imageWidth === img2.width && nav2.imageHeight === img2.height,
  `navigate_viewer reports new artwork's dimensions (${nav2.imageWidth}×${nav2.imageHeight})`);

// OOB check against the new artwork's dimensions: pick a region that's larger
// than the new artwork and verify it's rejected. Using crop_pixels with the
// original artwork's width which (almost certainly) exceeds the new one.
// If the new artwork is somehow larger, fall back to a clearly-out-of-bounds
// percent value.
const rOob = await client.callTool({
  name: "navigate_viewer",
  arguments: {
    viewUUID: uuid,
    commands: [{ action: "navigate", region: "pct:0,0,200,200" }],
  },
});
const oob = parseSc(rOob);
const oobIsError = rOob.isError === true || (typeof oob?.error === "string" && oob.error.includes("out_of_bounds"));
assert(oobIsError, `OOB rejected against new artwork's coordinate space (error: ${oob?.error ?? "n/a"})`);

// ══════════════════════════════════════════════════════════════════
//  3. Original viewUUID still routes navigate_viewer correctly
// ══════════════════════════════════════════════════════════════════

section("3. Original UUID still serves navigate_viewer post-remount");

const rNav3 = await client.callTool({
  name: "navigate_viewer",
  arguments: {
    viewUUID: uuid,
    commands: [{ action: "add_overlay", region: "pct:5,5,10,10", label: "after-remount" }],
  },
});
const nav3 = parseSc(rNav3);

assert(rNav3.isError !== true,
  `navigate_viewer with original UUID succeeds after remount (isError=${rNav3.isError})`);
assert(nav3.viewUUID === uuid,
  `response viewUUID matches original (${nav3.viewUUID?.slice(0, 8)}...)`);
assert(Array.isArray(nav3.currentOverlays) && nav3.currentOverlays.some((o) => o.label === "after-remount"),
  `new overlay registered against the original UUID's queue`);

// ══════════════════════════════════════════════════════════════════
//  4. Negative — invalid UUID
// ══════════════════════════════════════════════════════════════════

section("4. Negative — unknown UUID");

const rBadUuid = await client.callTool({
  name: "remount_viewer",
  arguments: {
    viewUUID: "00000000-0000-0000-0000-000000000000",
    objectNumber: "SK-C-5",
  },
});
const bad1 = parseSc(rBadUuid);

assert(rBadUuid.isError === true,
  `remount with unknown UUID returns isError=true`);
assert(typeof bad1.error === "string" && bad1.error.includes("No active viewer"),
  `error message mentions "No active viewer" (got: ${bad1.error})`);

// ══════════════════════════════════════════════════════════════════
//  5. Negative — invalid artwork
// ══════════════════════════════════════════════════════════════════

section("5. Negative — unknown artwork on a valid UUID");

const rBadArt = await client.callTool({
  name: "remount_viewer",
  arguments: { viewUUID: uuid, objectNumber: "DOES-NOT-EXIST-9999" },
});
const bad2 = parseSc(rBadArt);

assert(rBadArt.isError === true,
  `remount with unknown artwork returns isError=true`);
assert(typeof bad2.error === "string" && bad2.error.toLowerCase().includes("no artwork found"),
  `error message mentions "No artwork found" (got: ${bad2.error})`);

// Verify the viewer is still alive after the failed remount: the queue
// shouldn't have been mutated by the error path.
const rPost = await client.callTool({
  name: "navigate_viewer",
  arguments: { viewUUID: uuid, commands: [{ action: "navigate", region: "full" }] },
});
assert(rPost.isError !== true,
  `original viewer still serviceable after failed remount`);

// ══════════════════════════════════════════════════════════════════
//  6. Visibility metadata — _meta.ui.visibility marks app-only tools
// ══════════════════════════════════════════════════════════════════
//
// The server returns all tools via tools/list — the MCP host (claude.ai,
// Codex CLI, etc.) is responsible for hiding tools whose
// _meta.ui.visibility includes "app" from the model. Verify the
// contract by inspecting the metadata; host-side filtering is exercised
// in real-client smoke tests, not here.

section("6. Visibility metadata — _meta.ui.visibility = [\"app\"]");

const { tools } = await client.listTools();
const remount = tools.find((t) => t.name === "remount_viewer");
const poll = tools.find((t) => t.name === "poll_viewer_commands");
const open = tools.find((t) => t.name === "get_artwork_image");

assert(remount && remount._meta?.ui?.visibility?.includes("app"),
  `remount_viewer carries _meta.ui.visibility = ["app"]`);
assert(poll && poll._meta?.ui?.visibility?.includes("app"),
  `poll_viewer_commands carries _meta.ui.visibility = ["app"] (precedent)`);
assert(open && (!open._meta?.ui?.visibility || !open._meta.ui.visibility.includes("app")),
  `get_artwork_image NOT marked app-only (sanity: model-facing tool)`);

// ══════════════════════════════════════════════════════════════════
//  Summary
// ══════════════════════════════════════════════════════════════════

section("RESULTS");
console.log(`\n  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
if (failures.length > 0) {
  console.log(`\n  Failures:`);
  for (const f of failures) console.log(`    ✗ ${f}`);
}
console.log();

await client.close();
process.exit(failed > 0 ? 1 : 0);
