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
assert(/\d+ms/.test(textContent?.text ?? ""), "Caption includes fetch timing");
assert(!r2a.isError, "Not marked as error");

// 2b. Percentage region
console.log("\n--- 2b: pct region (SK-C-5, pct:0,0,50,50, 400px) ---");
const r2b = await client.callTool({
  name: "inspect_artwork_image",
  arguments: { objectNumber: "SK-C-5", region: "pct:0,0,50,50", size: 400, navigateViewer: false },
});
const img2b = r2b.content.find(c => c.type === "image");
assert(img2b != null, "pct region returns image");
assert(r2b.content.find(c => c.type === "text")?.text?.includes("pct:0,0,50,50"),
  "Caption mentions region");

// 2c. Pixel region
console.log("\n--- 2c: Pixel region (SK-C-5, 1000,800,500,500, 500px) ---");
const r2c = await client.callTool({
  name: "inspect_artwork_image",
  arguments: { objectNumber: "SK-C-5", region: "1000,800,500,500", size: 500, navigateViewer: false },
});
assert(r2c.content.find(c => c.type === "image") != null, "Pixel region returns image");

// 2c-bis. crop_pixels: region — same coords, prefixed form must be stripped before IIIF fetch
console.log("\n--- 2c-bis: crop_pixels region (SK-C-5, crop_pixels:1000,800,500,500, 500px) ---");
const r2cCp = await client.callTool({
  name: "inspect_artwork_image",
  arguments: { objectNumber: "SK-C-5", region: "crop_pixels:1000,800,500,500", size: 500, navigateViewer: false },
});
assert(!r2cCp.isError, "crop_pixels region does not error");
assert(r2cCp.content.find(c => c.type === "image") != null, "crop_pixels region returns image");
const caption2cCp = r2cCp.content.find(c => c.type === "text")?.text ?? "";
assert(/native \d+×\d+px/.test(caption2cCp), `caption echoes native dimensions (${caption2cCp.slice(0, 120)}…)`);

// 2c-ter. inspect with OOB pct is rejected with structured warning (#247, symmetric with navigate_viewer)
console.log("\n--- 2c-ter: inspect OOB pct (y=325) rejected with structured warning ---");
const r2cOob = await client.callTool({
  name: "inspect_artwork_image",
  arguments: { objectNumber: "SK-C-5", region: "pct:10,325,20,20", size: 400, navigateViewer: false },
});
assert(r2cOob.isError === true, "inspect OOB pct returns isError");
const oobInspectText = r2cOob.content?.find(c => c.type === "text")?.text ?? "";
assert(oobInspectText.includes("overlay_region_out_of_bounds"), "inspect error text includes warning code");
assert(oobInspectText.includes("y=325 outside 0–100"), "inspect error text identifies y=325 issue");
assert(oobInspectText.includes("please re-examine"), "inspect error text carries retry cue");

// 2d. Square region
console.log("\n--- 2d: Square region (SK-C-5, 600px) ---");
const r2d = await client.callTool({
  name: "inspect_artwork_image",
  arguments: { objectNumber: "SK-C-5", region: "square", size: 600, navigateViewer: false },
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
  assert(typeof sc.fetchTimeMs === "number" && sc.fetchTimeMs > 0, `structuredContent.fetchTimeMs (${sc.fetchTimeMs}ms)`);
} else {
  assert(false, "structuredContent not returned (STRUCTURED_CONTENT=true)");
}

// 2h. viewUUID returned when viewer is open
console.log("\n--- 2h: viewUUID in structuredContent ---");
const sc2h = r2b.structuredContent;
if (sc2h) {
  assert(sc2h.viewUUID === viewUUID1, `structuredContent.viewUUID matches viewer (${sc2h.viewUUID?.slice(0, 8)})`);
} else {
  assert(false, "structuredContent not returned for 2b");
}

// 2i. auto-navigate queues command for non-full region
console.log("\n--- 2i: auto-navigate (navigateViewer: true) ---");
const r2i = await client.callTool({
  name: "inspect_artwork_image",
  arguments: { objectNumber: "SK-C-5", region: "pct:20,30,40,40", size: 400, navigateViewer: true },
});
const sc2i = r2i.structuredContent;
assert(sc2i?.viewerNavigated === true, "viewerNavigated is true");
// Drain the auto-navigate command so it doesn't affect later tests
const r2i_poll = await client.callTool({
  name: "poll_viewer_commands",
  arguments: { viewUUID: viewUUID1 },
});
const poll2i = r2i_poll.structuredContent ?? JSON.parse(r2i_poll.content[0].text);
assert(poll2i.commands.length === 1, `Auto-navigate produced 1 command (got ${poll2i.commands.length})`);
assert(poll2i.commands[0].action === "navigate", "Auto-navigate command is 'navigate'");
assert(poll2i.commands[0].region === "pct:20,30,40,40", `Auto-navigate region matches (${poll2i.commands[0].region})`);

// 2j. auto-navigate skipped for 'full' region
console.log("\n--- 2j: auto-navigate skipped for 'full' ---");
const r2j = await client.callTool({
  name: "inspect_artwork_image",
  arguments: { objectNumber: "SK-C-5", region: "full", size: 400, navigateViewer: true },
});
const sc2j = r2j.structuredContent;
assert(!sc2j?.viewerNavigated, "viewerNavigated not set for full region");

// 2k. auto-navigate skipped when navigateViewer: false
console.log("\n--- 2k: navigateViewer: false suppresses auto-navigate ---");
const r2k = await client.callTool({
  name: "inspect_artwork_image",
  arguments: { objectNumber: "SK-C-5", region: "pct:10,10,20,20", size: 400, navigateViewer: false },
});
const sc2k = r2k.structuredContent;
assert(!sc2k?.viewerNavigated, "viewerNavigated not set when disabled");

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
assert(errText.toLowerCase().includes("no object found") || errText.toLowerCase().includes("no artwork found") || errText.toLowerCase().includes("error"),
  `Error message present (${errText.slice(0, 60)})`);

// 3c. Size clamping (request 2000px on a small pct region)
console.log("\n--- 3c: Size clamping ---");
const r3c = await client.callTool({
  name: "inspect_artwork_image",
  arguments: { objectNumber: "SK-C-5", region: "pct:0,0,10,10", size: 2000, navigateViewer: false },
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

// 4f. relativeTo projection
console.log("\n--- 4f: relativeTo projection ---");
const r4f = await client.callTool({
  name: "navigate_viewer",
  arguments: {
    viewUUID: viewUUID1,
    commands: [
      { action: "add_overlay", region: "pct:50,50,20,20", relativeTo: "pct:50,0,50,100", label: "Projected" },
    ],
  },
});
const nav4f = r4f.structuredContent ?? JSON.parse(r4f.content[0].text);
assert(!r4f.isError, "relativeTo accepted");
assert(nav4f.queued === 1, "1 command queued");
// Verify the projected region in currentOverlays
// pct:50,50,20,20 relative to pct:50,0,50,100 → pct:75,50,10,20
const projected = nav4f.currentOverlays?.find(o => o.label === "Projected");
assert(projected, "Projected overlay in currentOverlays");
assert(projected.region === "pct:75,50,10,20", `Projected region correct: ${projected.region}`);

// 4g. relativeTo with non-pct region → error
console.log("\n--- 4g: relativeTo with pixel region → error ---");
const r4g = await client.callTool({
  name: "navigate_viewer",
  arguments: {
    viewUUID: viewUUID1,
    commands: [
      { action: "add_overlay", region: "100,100,200,200", relativeTo: "pct:50,0,50,100", label: "Bad" },
    ],
  },
});
assert(r4g.isError === true, "relativeTo with pixel region → error");

// 4h. invalid relativeTo format → error
console.log("\n--- 4h: invalid relativeTo format → error ---");
const r4h = await client.callTool({
  name: "navigate_viewer",
  arguments: {
    viewUUID: viewUUID1,
    commands: [
      { action: "add_overlay", region: "pct:10,10,20,20", relativeTo: "not-valid", label: "Bad" },
    ],
  },
});
assert(r4h.isError === true, "Invalid relativeTo format → error");

// 4i. relativeTo with non-pct IIIF format → error (must be pct:, not full/square/pixels)
console.log("\n--- 4i: relativeTo 'full' → error (pct: required) ---");
const r4i = await client.callTool({
  name: "navigate_viewer",
  arguments: {
    viewUUID: viewUUID1,
    commands: [
      { action: "add_overlay", region: "pct:10,10,20,20", relativeTo: "full", label: "Bad" },
    ],
  },
});
assert(r4i.isError === true, "relativeTo 'full' → error (must be pct:)");

// ══════════════════════════════════════════════════════════════════
//  4bis. navigate_viewer — crop_pixels format + OOB rejection (#247)
// ══════════════════════════════════════════════════════════════════

section("4bis. crop_pixels format + OOB rejection (#247)");

// Open a fresh viewer to keep queue counts in later sections stable.
const r4bis0 = await client.callTool({
  name: "get_artwork_image",
  arguments: { objectNumber: "SK-A-2152" },
});
const img4bis = r4bis0.structuredContent ?? JSON.parse(r4bis0.content[0].text);
const viewUUIDcp = img4bis.viewUUID;
assert(typeof viewUUIDcp === "string" && viewUUIDcp.length === 36,
  `Fresh viewUUID for crop_pixels tests (${viewUUIDcp?.slice(0, 8)}...)`);

// 4bis-a. add_overlay with crop_pixels: format succeeds; prefix stripped before forwarding
console.log("\n--- 4bis-a: crop_pixels format accepted ---");
const r4bisA = await client.callTool({
  name: "navigate_viewer",
  arguments: {
    viewUUID: viewUUIDcp,
    commands: [
      { action: "add_overlay", region: "crop_pixels:100,200,300,400", label: "cp-test" },
    ],
  },
});
assert(!r4bisA.isError, "crop_pixels add_overlay should succeed");
const polledA = await client.callTool({
  name: "poll_viewer_commands",
  arguments: { viewUUID: viewUUIDcp },
});
const pollA = polledA.structuredContent ?? JSON.parse(polledA.content[0].text);
const cpOverlay = pollA.commands?.find((c) => c.action === "add_overlay" && c.label === "cp-test");
assert(cpOverlay != null, "cp-test overlay is in queue");
assert(cpOverlay?.region === "100,200,300,400", `crop_pixels: prefix stripped (got "${cpOverlay?.region}")`);

// 4bis-b. add_overlay with OOB pct returns structured warning + isError
console.log("\n--- 4bis-b: OOB pct (y=325) rejected with structured warning ---");
const r4bisB = await client.callTool({
  name: "navigate_viewer",
  arguments: {
    viewUUID: viewUUIDcp,
    commands: [
      { action: "add_overlay", region: "pct:36,325,35,30", label: "oob-pct" },
    ],
  },
});
assert(r4bisB.isError === true, "OOB pct returns isError");
const oobText = r4bisB.content?.[0]?.text ?? "";
assert(oobText.includes("overlay_region_out_of_bounds"), "error text includes warning code");
assert(oobText.includes("y=325 outside 0–100"), "error text identifies y=325 issue");
assert(oobText.includes("clamped_to"), "error text includes clamped_to preview");
assert(oobText.includes("please re-examine the image"), "error text carries retry cue");

// 4bis-c. add_overlay with x+w > 100 rejected
console.log("\n--- 4bis-c: OOB pct (x+w=110) rejected ---");
const r4bisC = await client.callTool({
  name: "navigate_viewer",
  arguments: {
    viewUUID: viewUUIDcp,
    commands: [
      { action: "add_overlay", region: "pct:80,10,30,20", label: "oob-width" },
    ],
  },
});
assert(r4bisC.isError === true, "OOB x+w=110 returns isError");
const oobCText = r4bisC.content?.[0]?.text ?? "";
assert(oobCText.includes("x+w=110"), "error text identifies x+w overflow");

// 4bis-d. OOB call does not mutate queue
console.log("\n--- 4bis-d: OOB rejection does not queue commands ---");
// First queue a known-good overlay
await client.callTool({
  name: "navigate_viewer",
  arguments: {
    viewUUID: viewUUIDcp,
    commands: [{ action: "add_overlay", region: "pct:0,0,50,50", label: "ok" }],
  },
});
// Drain, record baseline
const drained1 = await client.callTool({
  name: "poll_viewer_commands",
  arguments: { viewUUID: viewUUIDcp },
});
const drainedCmds = drained1.structuredContent?.commands ?? JSON.parse(drained1.content[0].text).commands;
assert(drainedCmds.length === 1, `One ok command drained (got ${drainedCmds.length})`);
// Now send an OOB call — should reject, queue should remain empty
const r4bisD = await client.callTool({
  name: "navigate_viewer",
  arguments: {
    viewUUID: viewUUIDcp,
    commands: [{ action: "add_overlay", region: "pct:10,10,0,50", label: "bad-w" }],
  },
});
assert(r4bisD.isError === true, "Zero-width region rejected");
const afterBad = await client.callTool({
  name: "poll_viewer_commands",
  arguments: { viewUUID: viewUUIDcp },
});
const afterBadCmds = afterBad.structuredContent?.commands ?? JSON.parse(afterBad.content[0].text).commands;
assert(afterBadCmds.length === 0, `OOB call did not queue commands (got ${afterBadCmds.length})`);

// 4bis-e. crop_pixels OOB against known image dims is rejected with structured warning
// Uses a deliberately oversized x (50000) that no real IIIF image will match. The viewer
// queue carries imageWidth/imageHeight from the prior get_artwork_image call.
console.log("\n--- 4bis-e: crop_pixels OOB with known dims rejected ---");
const r4bisE = await client.callTool({
  name: "navigate_viewer",
  arguments: {
    viewUUID: viewUUIDcp,
    commands: [
      { action: "add_overlay", region: "crop_pixels:50000,0,100,100", label: "oob-cp" },
    ],
  },
});
assert(r4bisE.isError === true, "crop_pixels OOB returns isError");
const oobCpText = r4bisE.content?.[0]?.text ?? "";
assert(oobCpText.includes("overlay_region_out_of_bounds"), "crop_pixels OOB text includes warning code");
assert(/exceeds imageWidth/.test(oobCpText), "crop_pixels OOB text identifies imageWidth overflow");
assert(oobCpText.includes("please re-examine the image"), "crop_pixels OOB carries retry cue");

// ══════════════════════════════════════════════════════════════════
//  4ter. inspect_artwork_image show_overlays (P1, #247)
// ══════════════════════════════════════════════════════════════════

section("4ter. inspect show_overlays compositing (#247)");

// Fresh viewer so activeOverlays state is deterministic.
const r4ter0 = await client.callTool({
  name: "get_artwork_image",
  arguments: { objectNumber: "SK-A-2152" },
});
const img4ter = r4ter0.structuredContent ?? JSON.parse(r4ter0.content[0].text);
const viewUUIDov = img4ter.viewUUID;

// Queue one known-good overlay.
await client.callTool({
  name: "navigate_viewer",
  arguments: {
    viewUUID: viewUUIDov,
    commands: [
      { action: "add_overlay", region: "pct:10,10,20,20", label: "p1-target", color: "red" },
    ],
  },
});

// Baseline: show_overlays=false returns a plain crop.
console.log("\n--- 4ter-a: show_overlays=false → plain crop ---");
const r4terA = await client.callTool({
  name: "inspect_artwork_image",
  arguments: {
    objectNumber: "SK-A-2152",
    region: "full",
    size: 448,
    navigateViewer: false,
    show_overlays: false,
    viewUUID: viewUUIDov,
  },
});
assert(!r4terA.isError, "plain inspect succeeds");
const plainSC = r4terA.structuredContent ?? JSON.parse(r4terA.content.find(c => c.type === "text").text);
assert(plainSC.overlaysRendered == null, "plain response omits overlaysRendered");
const plainImage = r4terA.content.find(c => c.type === "image");
assert(plainImage != null, "plain response has image");

// Composite: show_overlays=true composites the queued overlay.
console.log("\n--- 4ter-b: show_overlays=true → composited crop ---");
const r4terB = await client.callTool({
  name: "inspect_artwork_image",
  arguments: {
    objectNumber: "SK-A-2152",
    region: "full",
    size: 448,
    navigateViewer: false,
    show_overlays: true,
    viewUUID: viewUUIDov,
  },
});
assert(!r4terB.isError, "composite inspect succeeds");
const compSC = r4terB.structuredContent ?? JSON.parse(r4terB.content.find(c => c.type === "text").text);
assert(compSC.overlaysRendered >= 1, `overlaysRendered ≥ 1 (got ${compSC.overlaysRendered})`);
assert(compSC.overlaysSkipped === 0, `overlaysSkipped == 0 (got ${compSC.overlaysSkipped})`);
assert(compSC.requestedSize === 448, `requestedSize clamped to 448 (got ${compSC.requestedSize})`);
const compImage = r4terB.content.find(c => c.type === "image");
assert(compImage != null, "composite response has image");
assert(compImage.data !== plainImage.data, "composite bytes differ from plain bytes");

// Size clamp: passing size=1200 with show_overlays=true still clamps to 448.
console.log("\n--- 4ter-c: size=1200 force-clamped to 448 when show_overlays=true ---");
const r4terC = await client.callTool({
  name: "inspect_artwork_image",
  arguments: {
    objectNumber: "SK-A-2152",
    region: "full",
    size: 1200,
    navigateViewer: false,
    show_overlays: true,
    viewUUID: viewUUIDov,
  },
});
const clampSC = r4terC.structuredContent ?? JSON.parse(r4terC.content.find(c => c.type === "text").text);
assert(clampSC.requestedSize === 448, `size=1200 clamped to 448 when show_overlays=true (got ${clampSC.requestedSize})`);

// ══════════════════════════════════════════════════════════════════
//  5. poll_viewer_commands — queue draining
// ══════════════════════════════════════════════════════════════════

section("5. poll_viewer_commands — queue draining");

// 5a. Poll viewer 1 — should have accumulated commands from 4a (4) + 4d (1) + 4f (1) = 6
// Note: 4c/4g/4h were rejected, not queued
console.log("\n--- 5a: Poll viewer 1 (should drain 6 commands) ---");
const r5a = await client.callTool({
  name: "poll_viewer_commands",
  arguments: { viewUUID: viewUUID1 },
});
const poll1 = r5a.structuredContent ?? JSON.parse(r5a.content[0].text);
assert(Array.isArray(poll1.commands), "commands is an array");
assert(poll1.commands.length === 6, `Drained 6 commands (got ${poll1.commands.length})`);

// Verify command structure
const clearCmd = poll1.commands.find(c => c.action === "clear_overlays");
assert(clearCmd != null, "Includes clear_overlays command");
const overlayCmd = poll1.commands.find(c => c.action === "add_overlay" && c.label === "Test overlay 1");
assert(overlayCmd?.color === "orange", "Overlay preserves color");
assert(overlayCmd?.region === "pct:38,22,28,22", "Overlay preserves region");

// Verify projected command has full-image region and no relativeTo
const projCmd = poll1.commands.find(c => c.label === "Projected");
assert(projCmd?.region === "pct:75,50,10,20", `Polled projected region: ${projCmd?.region}`);
assert(projCmd?.relativeTo === undefined, "relativeTo stripped from polled command");

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
//  7. Filter guard & coerceNull — client misbehaviour tests
// ══════════════════════════════════════════════════════════════════

section("7. Filter guard & coerceNull");

// Helper: extract text, structured content, and total result count from a tool result.
// totalResults is parsed from text header ("N results of M total") as a reliable fallback
// since structuredContent may omit totalResults in some code paths.
function parseResult(r) {
  const text = r.content?.[0]?.text ?? "";
  const sc = r.structuredContent ?? (text.startsWith("{") ? JSON.parse(text) : null);
  // Parse "N results of M total" or "N results" from compact text header
  const totalMatch = text.match(/(\d+) results? of (\d+) total/);
  const countMatch = text.match(/^(\d+) results?/);
  const totalResults = sc?.totalResults
    ?? (totalMatch ? parseInt(totalMatch[2], 10) : null)
    ?? (countMatch ? parseInt(countMatch[1], 10) : null);
  return { text, sc, totalResults, isError: !!r.isError };
}

// 7a. imageAvailable: true alone → rejected
console.log("\n--- 7a: imageAvailable alone (should be rejected) ---");
{
  const r = await client.callTool({
    name: "search_artwork",
    arguments: { imageAvailable: true, maxResults: 5 },
  });
  const { isError, text } = parseResult(r);
  assert(isError, "imageAvailable alone is rejected");
  assert(text.includes("At least one search filter"), "Error mentions filter requirement");
}

// 7b. imageAvailable: true + "null" strings → rejected (null strings stripped)
console.log("\n--- 7b: imageAvailable + null strings (should be rejected) ---");
{
  const r = await client.callTool({
    name: "search_artwork",
    arguments: { imageAvailable: true, productionPlace: "null", subject: "null", maxResults: 5 },
  });
  const { isError } = parseResult(r);
  assert(isError, "imageAvailable + null-string filters is rejected");
}

// 7c. imageAvailable: false alone → rejected
console.log("\n--- 7c: imageAvailable false alone (should be rejected) ---");
{
  const r = await client.callTool({
    name: "search_artwork",
    arguments: { imageAvailable: false },
  });
  const { isError } = parseResult(r);
  assert(isError, "imageAvailable false alone is rejected");
}

// 7d. Empty args → rejected
console.log("\n--- 7d: empty args (should be rejected) ---");
{
  const r = await client.callTool({
    name: "search_artwork",
    arguments: {},
  });
  const { isError } = parseResult(r);
  assert(isError, "Empty args is rejected");
}

// 7e. All "null" strings → rejected (all stripped to undefined)
console.log("\n--- 7e: all null strings (should be rejected) ---");
{
  const r = await client.callTool({
    name: "search_artwork",
    arguments: { productionPlace: "null", subject: "null", creator: "null" },
  });
  const { isError } = parseResult(r);
  assert(isError, "All null-string filters is rejected");
}

// 7f. Real filter + imageAvailable → works, returns narrowed results
console.log("\n--- 7f: real filter + imageAvailable (should work) ---");
{
  const r = await client.callTool({
    name: "search_artwork",
    arguments: { productionPlace: "Japan", imageAvailable: true, maxResults: 5 },
  });
  const { isError, totalResults } = parseResult(r);
  assert(!isError, "productionPlace Japan + imageAvailable succeeds");
  assert(totalResults > 0 && totalResults < 50000, `Result count is narrowed (${totalResults}), not 725K`);
}

// 7g. "null" string for one filter + real value for another → works with real filter only
console.log("\n--- 7g: mixed null + real filter (should work) ---");
{
  const r = await client.callTool({
    name: "search_artwork",
    arguments: { subject: "null", creator: "Rembrandt van Rijn", maxResults: 5 },
  });
  const { isError, totalResults } = parseResult(r);
  assert(!isError, "Null subject + real creator succeeds");
  assert(totalResults > 0 && totalResults < 5000, `Rembrandt results are narrowed (${totalResults})`);
}

// 7h. Empty string filter → treated as no filter (coerceNull strips it)
console.log("\n--- 7h: empty string filter (should be rejected) ---");
{
  const r = await client.callTool({
    name: "search_artwork",
    arguments: { productionPlace: "", subject: "" },
  });
  const { isError } = parseResult(r);
  assert(isError, "Empty string filters are rejected");
}

// 7i. Result count sanity: known queries should not return 700K+
console.log("\n--- 7i: result count sanity checks ---");
{
  const queries = [
    { args: { productionPlace: "Japan" }, label: "Japan", maxExpected: 20000 },
    { args: { creator: "Rembrandt van Rijn", type: "painting" }, label: "Rembrandt paintings", maxExpected: 1000 },
    { args: { subject: "vanitas", type: "painting" }, label: "vanitas paintings", maxExpected: 5000 },
  ];
  for (const { args, label, maxExpected } of queries) {
    const r = await client.callTool({
      name: "search_artwork",
      arguments: { ...args, maxResults: 5 },
    });
    const { totalResults } = parseResult(r);
    assert(totalResults > 0, `${label}: has results (${totalResults})`);
    assert(totalResults <= maxExpected, `${label}: result count ${totalResults} <= ${maxExpected} (not unfiltered)`);
  }
}

// ══════════════════════════════════════════════════════════════════
//  8. Schema surface — no $ref pointers
// ══════════════════════════════════════════════════════════════════

section("8. Schema surface — no $ref");

{
  const { tools } = await client.listTools();
  assert(tools.length >= 12, `Server exposes >= 12 tools (got ${tools.length})`);

  for (const tool of tools) {
    const schemaStr = JSON.stringify(tool.inputSchema);
    assert(
      !schemaStr.includes('"$ref"'),
      `${tool.name}: no $ref in inputSchema`
    );
    if (tool.outputSchema) {
      const outStr = JSON.stringify(tool.outputSchema);
      assert(
        !outStr.includes('"$ref"'),
        `${tool.name}: no $ref in outputSchema`
      );
    }
  }

  // Verify string params are inlined (not shared) — spot-check search_artwork
  const searchTool = tools.find((t) => t.name === "search_artwork");
  if (searchTool) {
    const props = searchTool.inputSchema.properties ?? {};
    const stringFields = ["creator", "subject", "type", "material", "technique"]
      .filter((f) => f in props);
    for (const f of stringFields) {
      const fieldSchema = JSON.stringify(props[f]);
      assert(
        !fieldSchema.includes('"$ref"'),
        `search_artwork.${f} has inline schema (not $ref)`
      );
      // Must be either type:"string" or anyOf:[string, array] — both are valid inlined forms
      assert(
        props[f].type === "string" || Array.isArray(props[f].anyOf),
        `search_artwork.${f} has recognized schema shape`
      );
    }
  }
}

// ══════════════════════════════════════════════════════════════════
//  9. JSON null acceptance — claude.ai sends null for omitted params
// ══════════════════════════════════════════════════════════════════

section("9. JSON null acceptance");

// 9a. Actual JSON null for string params → stripped, real filter works
console.log("\n--- 9a: JSON null + real filter (should succeed) ---");
{
  const r = await client.callTool({
    name: "search_artwork",
    arguments: { subject: null, creator: "Rembrandt van Rijn", maxResults: 5 },
  });
  const { isError, totalResults } = parseResult(r);
  assert(!isError, "JSON null subject + real creator succeeds");
  assert(totalResults > 0, `Has results (${totalResults})`);
}

// 9b. Multiple JSON nulls + real filter → stripped, search works
console.log("\n--- 9b: multiple JSON nulls + real filter ---");
{
  const r = await client.callTool({
    name: "search_artwork",
    arguments: {
      subject: null,
      productionPlace: null,
      depictedPlace: null,
      type: "painting",
      creator: "Vermeer",
      maxResults: 5,
    },
  });
  const { isError, totalResults } = parseResult(r);
  assert(!isError, "Multiple null params + real filters succeeds");
  assert(totalResults > 0, `Has results (${totalResults})`);
}

// 9c. All JSON nulls → stripped to empty, rejected by filter guard
console.log("\n--- 9c: all JSON nulls (should be rejected) ---");
{
  const r = await client.callTool({
    name: "search_artwork",
    arguments: { subject: null, creator: null, type: null },
  });
  const { isError } = parseResult(r);
  assert(isError, "All JSON null filters is rejected by filter guard");
}

// 9d. JSON null on navigate_viewer command fields
console.log("\n--- 9d: JSON null on navigate_viewer command fields ---");
{
  // navigate_viewer commands use optStr() for region, label, color —
  // verify null values don't cause validation errors
  const r = await client.callTool({
    name: "navigate_viewer",
    arguments: {
      viewUUID: "00000000-0000-0000-0000-000000000000",
      commands: [{ action: "navigate", region: "full", label: null, color: null }],
    },
  });
  // Will fail with "unknown viewer" but should NOT fail with validation error
  const { text } = parseResult(r);
  assert(
    !text.includes("Input validation error") && !text.includes("invalid_type"),
    "navigate_viewer accepts null label/color without validation error"
  );
}

// 9e. JSON null on semantic_search filter params
console.log("\n--- 9e: JSON null on semantic_search filters ---");
{
  const r = await client.callTool({
    name: "semantic_search",
    arguments: { query: "winter landscape", type: null, creator: null, maxResults: 5 },
  });
  const { isError } = parseResult(r);
  assert(!isError, "semantic_search accepts null filter params");
}

// ══════════════════════════════════════════════════════════════════
//  10. provenanceChain in structuredContent — schema conformance
// ══════════════════════════════════════════════════════════════════

section("10. provenanceChain structuredContent validation");

// provenanceChain is intentionally excluded from structuredContent (too large
// for some clients). The text channel includes a provenance summary, and
// search_provenance provides full structured provenance data.
console.log("\n--- 10a: get_artwork_details — provenance in text, not structuredContent ---");
{
  const r = await client.callTool({
    name: "get_artwork_details",
    arguments: { objectNumber: "SK-A-2344" },
  });
  const { sc, isError } = parseResult(r);
  assert(!isError, "get_artwork_details succeeds for SK-A-2344");
  assert(sc != null, "structuredContent present");
  assert(sc?.provenanceChain === undefined, "provenanceChain excluded from structuredContent");
  assert(sc?.provenance != null, "provenance raw text present in structuredContent");
  // Verify provenance summary is in the text channel
  const text = r.content?.find(c => c.type === "text")?.text ?? "";
  assert(text.includes("[Provenance parsed]"), "text channel includes provenance summary");
}

// 10b. Artwork without provenance
console.log("\n--- 10b: artwork without provenance ---");
{
  const r = await client.callTool({
    name: "get_artwork_details",
    arguments: { objectNumber: "BK-NM-1010" },
  });
  const { sc, isError } = parseResult(r);
  if (!isError && sc) {
    assert(sc.provenanceChain === undefined, "provenanceChain excluded from structuredContent");
  } else {
    assert(true, "skipped — artwork not found");
  }
}

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
