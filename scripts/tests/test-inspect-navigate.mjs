/**
 * Comprehensive test suite for inspect_artwork_image, navigate_viewer,
 * and poll_viewer_commands (feature/crop-artwork-image branch).
 *
 * Tests the full workflow as observed in a real claude.ai diagnostic trace:
 *   search → get_artwork_image → inspect_artwork_image → navigate_viewer → poll_viewer_commands
 *
 * Run:  node scripts/tests/test-inspect-navigate.mjs
 * Uses: @modelcontextprotocol/sdk Client + StdioClientTransport (stdio mode)
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

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

// ── Connect ───────────────────────────────────────────────────────

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  cwd: PROJECT_DIR,
  env: { ...process.env, STRUCTURED_CONTENT: "true" },
});

const client = new Client({ name: "test-inspect-navigate", version: "0.1" });
await client.connect(transport);
console.log("Connected to server via stdio\n");

// ══════════════════════════════════════════════════════════════════
//  1. get_artwork_image — viewUUID generation
// ══════════════════════════════════════════════════════════════════

section("1. get_artwork_image — viewUUID generation");

const r1 = await client.callTool({
  name: "get_artwork_image",
  arguments: { objectNumber: "SK-C-5" },
});

const img1 = r1.structuredContent ?? JSON.parse(r1.content[0].text);
const viewUUID1 = img1.viewUUID;

assert(typeof viewUUID1 === "string" && viewUUID1.length === 36,
  `viewUUID returned (${viewUUID1?.slice(0, 8)}...)`);
assert(img1.objectNumber === "SK-C-5",
  `objectNumber matches (${img1.objectNumber})`);
assert(typeof img1.width === "number" && img1.width > 0,
  `width present (${img1.width})`);
assert(typeof img1.height === "number" && img1.height > 0,
  `height present (${img1.height})`);
assert(typeof img1.title === "string" && img1.title.length > 0,
  `title present ("${img1.title?.slice(0, 40)}...")`);

// Get a second artwork to test independent viewers
const r1b = await client.callTool({
  name: "get_artwork_image",
  arguments: { objectNumber: "RP-P-OB-1117" },
});
const img1b = r1b.structuredContent ?? JSON.parse(r1b.content[0].text);
const viewUUID2 = img1b.viewUUID;

assert(viewUUID2 !== viewUUID1,
  `Second viewUUID is distinct (${viewUUID2?.slice(0, 8)}...)`);

// ══════════════════════════════════════════════════════════════════
//  2. inspect_artwork_image — basic functionality
// ══════════════════════════════════════════════════════════════════

section("2. inspect_artwork_image — basic tests");

// 2a. Full image, small size
console.log("\n--- 2a: Full image (SK-C-5, 400px) ---");
const r2a = await client.callTool({
  name: "inspect_artwork_image",
  arguments: { objectNumber: "SK-C-5", region: "full", size: 400 },
});
const imageContent = r2a.content.find(c => c.type === "image");
const textContent = r2a.content.find(c => c.type === "text");
assert(imageContent != null, "Image content returned");
assert(imageContent?.mimeType === "image/jpeg", `mimeType is image/jpeg`);
assert(imageContent?.data?.length > 1000, `base64 data present (~${Math.round((imageContent?.data?.length ?? 0) * 0.75 / 1024)} KB)`);
assert(textContent?.text?.includes("SK-C-5"), "Caption includes object number");
assert(!r2a.isError, "Not marked as error");

// 2b. Percentage region
console.log("\n--- 2b: pct region (SK-C-5, pct:0,0,50,50, 400px) ---");
const r2b = await client.callTool({
  name: "inspect_artwork_image",
  arguments: { objectNumber: "SK-C-5", region: "pct:0,0,50,50", size: 400 },
});
const img2b = r2b.content.find(c => c.type === "image");
assert(img2b != null, "pct region returns image");
assert(r2b.content.find(c => c.type === "text")?.text?.includes("pct:0,0,50,50"),
  "Caption mentions region");

// 2c. Pixel region
console.log("\n--- 2c: Pixel region (SK-C-5, 1000,800,500,500, 500px) ---");
const r2c = await client.callTool({
  name: "inspect_artwork_image",
  arguments: { objectNumber: "SK-C-5", region: "1000,800,500,500", size: 500 },
});
assert(r2c.content.find(c => c.type === "image") != null, "Pixel region returns image");

// 2d. Square region
console.log("\n--- 2d: Square region (SK-C-5, 600px) ---");
const r2d = await client.callTool({
  name: "inspect_artwork_image",
  arguments: { objectNumber: "SK-C-5", region: "square", size: 600 },
});
assert(r2d.content.find(c => c.type === "image") != null, "Square region returns image");

// 2e. Rotation
console.log("\n--- 2e: Rotation (SK-C-5, 90°) ---");
const r2e = await client.callTool({
  name: "inspect_artwork_image",
  arguments: { objectNumber: "SK-C-5", region: "full", size: 400, rotation: 90 },
});
assert(r2e.content.find(c => c.type === "image") != null, "90° rotation returns image");

// 2f. Gray quality
console.log("\n--- 2f: Gray quality (SK-C-5) ---");
const r2f = await client.callTool({
  name: "inspect_artwork_image",
  arguments: { objectNumber: "SK-C-5", region: "full", size: 400, quality: "gray" },
});
assert(r2f.content.find(c => c.type === "image") != null, "Gray quality returns image");

// 2g. structuredContent returned
console.log("\n--- 2g: structuredContent ---");
const sc = r2a.structuredContent;
if (sc) {
  assert(sc.objectNumber === "SK-C-5", `structuredContent.objectNumber (${sc.objectNumber})`);
  assert(typeof sc.nativeWidth === "number", `structuredContent.nativeWidth (${sc.nativeWidth})`);
  assert(typeof sc.nativeHeight === "number", `structuredContent.nativeHeight (${sc.nativeHeight})`);
  assert(sc.region === "full", `structuredContent.region (${sc.region})`);
} else {
  assert(false, "structuredContent not returned (STRUCTURED_CONTENT=true)");
}

// ══════════════════════════════════════════════════════════════════
//  3. inspect_artwork_image — error handling
// ══════════════════════════════════════════════════════════════════

section("3. inspect_artwork_image — error handling");

// 3a. Invalid region (Zod validation)
console.log("\n--- 3a: Invalid region ---");
try {
  const r3a = await client.callTool({
    name: "inspect_artwork_image",
    arguments: { objectNumber: "SK-C-5", region: "banana" },
  });
  // Zod .refine() should cause an MCP validation error
  assert(r3a.isError === true, "Invalid region marked as error");
} catch (e) {
  // Zod rejection comes as an MCP error (thrown by SDK client)
  assert(true, `Invalid region rejected: ${e.message?.slice(0, 80)}`);
}

// 3b. Non-existent artwork (triggers "No object found" error)
console.log("\n--- 3b: Non-existent artwork ---");
const r3b = await client.callTool({
  name: "inspect_artwork_image",
  arguments: { objectNumber: "NONEXISTENT-12345" },
});
assert(r3b.isError === true, "Non-existent artwork marked as isError");
const errText = r3b.content.find(c => c.type === "text")?.text ?? "";
assert(errText.toLowerCase().includes("no object found") || errText.toLowerCase().includes("error"),
  `Error message present (${errText.slice(0, 60)})`);

// 3c. Size clamping (request 2000px on a small pct region)
console.log("\n--- 3c: Size clamping ---");
const r3c = await client.callTool({
  name: "inspect_artwork_image",
  arguments: { objectNumber: "SK-C-5", region: "pct:0,0,10,10", size: 2000 },
});
const caption3c = r3c.content.find(c => c.type === "text")?.text ?? "";
assert(caption3c.includes("clamped"), `Caption mentions clamping: "${caption3c.slice(0, 80)}"`);
assert(r3c.content.find(c => c.type === "image") != null, "Clamped request still returns image");

// ══════════════════════════════════════════════════════════════════
//  4. navigate_viewer — command queuing
// ══════════════════════════════════════════════════════════════════

section("4. navigate_viewer — command queuing");

// 4a. Valid commands (matching diagnostic trace pattern)
console.log("\n--- 4a: Clear + navigate + overlays ---");
const r4a = await client.callTool({
  name: "navigate_viewer",
  arguments: {
    viewUUID: viewUUID1,
    commands: [
      { action: "clear_overlays" },
      { action: "navigate", region: "full" },
      { action: "add_overlay", region: "pct:38,22,28,22", label: "Test overlay 1", color: "orange" },
      { action: "add_overlay", region: "pct:50,50,30,30", label: "Test overlay 2", color: "steelblue" },
    ],
  },
});
const nav1 = r4a.structuredContent ?? JSON.parse(r4a.content[0].text);
assert(nav1.queued === 4, `Queued 4 commands (got ${nav1.queued})`);
assert(nav1.viewUUID === viewUUID1, `viewUUID echoed back`);
assert(!nav1.error, "No error");
assert(!r4a.isError, "Not marked as error");

// 4b. Invalid viewUUID
console.log("\n--- 4b: Invalid viewUUID ---");
const r4b = await client.callTool({
  name: "navigate_viewer",
  arguments: {
    viewUUID: "00000000-0000-0000-0000-000000000000",
    commands: [{ action: "navigate", region: "full" }],
  },
});
assert(r4b.isError === true, "Invalid viewUUID → isError");
const nav4b = r4b.structuredContent ?? JSON.parse(r4b.content[0].text);
assert(nav4b.error?.includes("No active viewer"), `Error message: "${nav4b.error?.slice(0, 50)}"`);

// 4c. Invalid region in command
console.log("\n--- 4c: Invalid region in add_overlay ---");
const r4c = await client.callTool({
  name: "navigate_viewer",
  arguments: {
    viewUUID: viewUUID1,
    commands: [
      { action: "add_overlay", region: "not-valid", label: "Bad" },
    ],
  },
});
assert(r4c.isError === true, "Invalid region → isError");

// 4d. Queue a second batch to same viewer
console.log("\n--- 4d: Second batch to same viewer ---");
const r4d = await client.callTool({
  name: "navigate_viewer",
  arguments: {
    viewUUID: viewUUID1,
    commands: [
      { action: "add_overlay", region: "pct:10,10,20,20", label: "Third overlay" },
    ],
  },
});
const nav4d = r4d.structuredContent ?? JSON.parse(r4d.content[0].text);
assert(nav4d.queued === 1, `Second batch queued 1 command`);

// 4e. Queue commands to the second viewer (independent)
console.log("\n--- 4e: Commands to second viewer ---");
const r4e = await client.callTool({
  name: "navigate_viewer",
  arguments: {
    viewUUID: viewUUID2,
    commands: [
      { action: "navigate", region: "pct:0,0,100,100" },
      { action: "add_overlay", region: "pct:20,20,60,60", label: "Engraving detail" },
    ],
  },
});
const nav4e = r4e.structuredContent ?? JSON.parse(r4e.content[0].text);
assert(nav4e.queued === 2, `Second viewer: queued 2 commands`);

// ══════════════════════════════════════════════════════════════════
//  5. poll_viewer_commands — queue draining
// ══════════════════════════════════════════════════════════════════

section("5. poll_viewer_commands — queue draining");

// 5a. Poll viewer 1 — should have accumulated commands from 4a (4) + 4d (1) = 5
// Note: 4a commands + 4d command = 5 total (4c was rejected, not queued)
console.log("\n--- 5a: Poll viewer 1 (should drain 5 commands) ---");
const r5a = await client.callTool({
  name: "poll_viewer_commands",
  arguments: { viewUUID: viewUUID1 },
});
const poll1 = r5a.structuredContent ?? JSON.parse(r5a.content[0].text);
assert(Array.isArray(poll1.commands), "commands is an array");
assert(poll1.commands.length === 5, `Drained 5 commands (got ${poll1.commands.length})`);

// Verify command structure
const clearCmd = poll1.commands.find(c => c.action === "clear_overlays");
assert(clearCmd != null, "Includes clear_overlays command");
const overlayCmd = poll1.commands.find(c => c.action === "add_overlay" && c.label === "Test overlay 1");
assert(overlayCmd?.color === "orange", "Overlay preserves color");
assert(overlayCmd?.region === "pct:38,22,28,22", "Overlay preserves region");

// 5b. Poll again — queue should be empty now
console.log("\n--- 5b: Poll again (should be empty) ---");
const r5b = await client.callTool({
  name: "poll_viewer_commands",
  arguments: { viewUUID: viewUUID1 },
});
const poll2 = r5b.structuredContent ?? JSON.parse(r5b.content[0].text);
assert(poll2.commands.length === 0, `Queue drained (${poll2.commands.length} remaining)`);

// 5c. Poll viewer 2 — should have 2 commands from 4e
console.log("\n--- 5c: Poll viewer 2 ---");
const r5c = await client.callTool({
  name: "poll_viewer_commands",
  arguments: { viewUUID: viewUUID2 },
});
const poll3 = r5c.structuredContent ?? JSON.parse(r5c.content[0].text);
assert(poll3.commands.length === 2, `Viewer 2: drained 2 commands (got ${poll3.commands.length})`);

// 5d. Poll non-existent viewer — should return empty commands
console.log("\n--- 5d: Poll non-existent viewer ---");
const r5d = await client.callTool({
  name: "poll_viewer_commands",
  arguments: { viewUUID: "00000000-0000-0000-0000-000000000000" },
});
const poll4 = r5d.structuredContent ?? JSON.parse(r5d.content[0].text);
assert(poll4.commands.length === 0, `Non-existent viewer returns empty (${poll4.commands.length})`);

// ══════════════════════════════════════════════════════════════════
//  6. Full workflow (matching diagnostic trace pattern)
// ══════════════════════════════════════════════════════════════════

section("6. Full workflow — search → image → inspect → navigate → poll");

// 6a. Search for annunciations (as in diagnostic trace Turn 1)
console.log("\n--- 6a: Search for Annunciation subject ---");
const r6a = await client.callTool({
  name: "search_artwork",
  arguments: { subject: "Annunciation", maxResults: 5 },
});
const searchSc = r6a.structuredContent ?? JSON.parse(r6a.content[0].text);
const results = searchSc.results ?? searchSc;
assert(Array.isArray(results) && results.length > 0, `Search returned results (${results.length})`);

// Pick the first result
const firstHit = results[0];
const testObjectNumber = firstHit.objectNumber;
console.log(`  Using: ${testObjectNumber} "${firstHit.title}"`);

// 6b. Get artwork image (opens viewer, gets viewUUID)
console.log("\n--- 6b: get_artwork_image ---");
const r6b = await client.callTool({
  name: "get_artwork_image",
  arguments: { objectNumber: testObjectNumber },
});
const imgInfo = r6b.structuredContent ?? JSON.parse(r6b.content[0].text);
const wfViewUUID = imgInfo.viewUUID;
assert(typeof wfViewUUID === "string" && wfViewUUID.length === 36,
  `viewUUID obtained (${wfViewUUID.slice(0, 8)}...)`);

// 6c. Inspect full image
console.log("\n--- 6c: inspect_artwork_image (full, 800px) ---");
const r6c = await client.callTool({
  name: "inspect_artwork_image",
  arguments: { objectNumber: testObjectNumber, region: "full", size: 800 },
});
const inspectOk = r6c.content.find(c => c.type === "image") != null;
assert(inspectOk, "Full inspection returned image");

// 6d. Navigate viewer with overlays (as in diagnostic trace Turn 3)
console.log("\n--- 6d: navigate_viewer with overlays ---");
const r6d = await client.callTool({
  name: "navigate_viewer",
  arguments: {
    viewUUID: wfViewUUID,
    commands: [
      { action: "clear_overlays" },
      { action: "navigate", region: "full" },
      { action: "add_overlay", region: "pct:10,20,30,40", label: "Test region A", color: "gold" },
      { action: "add_overlay", region: "pct:50,30,40,40", label: "Test region B", color: "crimson" },
    ],
  },
});
const navWf = r6d.structuredContent ?? JSON.parse(r6d.content[0].text);
assert(navWf.queued === 4, `Queued 4 workflow commands`);

// 6e. Poll to verify
console.log("\n--- 6e: poll_viewer_commands ---");
const r6e = await client.callTool({
  name: "poll_viewer_commands",
  arguments: { viewUUID: wfViewUUID },
});
const pollWf = r6e.structuredContent ?? JSON.parse(r6e.content[0].text);
assert(pollWf.commands.length === 4, `Polled 4 commands (got ${pollWf.commands.length})`);

// Verify ordering preserved (clear → navigate → overlay → overlay)
assert(pollWf.commands[0].action === "clear_overlays", "First command is clear_overlays");
assert(pollWf.commands[1].action === "navigate", "Second command is navigate");
assert(pollWf.commands[2].action === "add_overlay", "Third command is add_overlay");
assert(pollWf.commands[3].action === "add_overlay", "Fourth command is add_overlay");
assert(pollWf.commands[3].label === "Test region B", "Last overlay label preserved");
assert(pollWf.commands[3].color === "crimson", "Last overlay color preserved");

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
