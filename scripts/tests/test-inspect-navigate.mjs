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
// Channel parity: title/creator from the caption must also ride structuredContent.
assert((r2a.structuredContent?.title?.length ?? 0) > 0, "structuredContent carries artwork title (caption parity)");
assert("creator" in (r2a.structuredContent ?? {}), "structuredContent carries artwork creator key (caption parity)");

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
// Channel parity: the recovery payload (clampedTo/validRange) the prose dumps must
// also be structured so a structuredContent reader can self-correct without parsing prose.
const oobInspectRecovery = r2cOob.structuredContent?.regionRecovery;
assert(oobInspectRecovery != null, "inspect OOB exposes structured regionRecovery");
assert((oobInspectRecovery?.clampedTo?.length ?? 0) > 0, "inspect regionRecovery.clampedTo present");
assert((oobInspectRecovery?.validRange?.length ?? 0) > 0, "inspect regionRecovery.validRange present");

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
  assert(typeof sc.cropPixelWidth === "number" && sc.cropPixelWidth > 0, `structuredContent.cropPixelWidth (${sc.cropPixelWidth})`);
  assert(typeof sc.cropPixelHeight === "number" && sc.cropPixelHeight > 0, `structuredContent.cropPixelHeight (${sc.cropPixelHeight})`);
  assert(sc.cropRegion === "full", `structuredContent.cropRegion (${sc.cropRegion})`);
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

// 4a. Valid navigate/zoom commands
console.log("\n--- 4a: navigate (zoom) commands ---");
const r4a = await client.callTool({
  name: "navigate_viewer",
  arguments: {
    viewUUID: viewUUID1,
    commands: [
      { action: "navigate", region: "full" },
      { action: "navigate", region: "pct:38,22,28,22" },
    ],
  },
});
const nav1 = r4a.structuredContent ?? JSON.parse(r4a.content[0].text);
assert(nav1.queued === 2, `Queued 2 commands (got ${nav1.queued})`);
assert(nav1.viewUUID === viewUUID1, `viewUUID echoed back`);
assert(!nav1.error, "No error");
assert(!r4a.isError, "Not marked as error");
// The reverse-overlay direction is removed: the response no longer carries
// overlays[] / currentOverlays / verificationRegion, and the text is a plain
// delivery/queue line.
assert(nav1.overlays === undefined && nav1.currentOverlays === undefined,
  "navigate_viewer no longer returns overlay entries");
const navText1 = r4a.content?.find(c => c.type === "text")?.text ?? "";
assert(!/show_overlays|verificationRegion|add_overlay/.test(navText1),
  "navigate_viewer text no longer nudges toward overlay verification");

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
console.log("\n--- 4c: Invalid region in navigate ---");
const r4c = await client.callTool({
  name: "navigate_viewer",
  arguments: {
    viewUUID: viewUUID1,
    commands: [
      { action: "navigate", region: "not-valid" },
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
      { action: "navigate", region: "pct:10,10,20,20" },
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
      { action: "navigate", region: "pct:20,20,60,60" },
    ],
  },
});
const nav4e = r4e.structuredContent ?? JSON.parse(r4e.content[0].text);
assert(nav4e.queued === 2, `Second viewer: queued 2 commands`);

// 4f. relativeTo projection (crop-local → full-image, applied before queueing)
console.log("\n--- 4f: relativeTo projection ---");
const r4f = await client.callTool({
  name: "navigate_viewer",
  arguments: {
    viewUUID: viewUUID1,
    commands: [
      { action: "navigate", region: "pct:50,50,20,20", relativeTo: "pct:50,0,50,100" },
    ],
  },
});
const nav4f = r4f.structuredContent ?? JSON.parse(r4f.content[0].text);
assert(!r4f.isError, "relativeTo accepted");
assert(nav4f.queued === 1, "1 command queued");
// pct:50,50,20,20 relative to pct:50,0,50,100 → pct:75,50,10,20 — the projected
// region is applied to the queued command and verified via poll in section 5.

// 4g. relativeTo with non-pct region → error
console.log("\n--- 4g: relativeTo with pixel region → error ---");
const r4g = await client.callTool({
  name: "navigate_viewer",
  arguments: {
    viewUUID: viewUUID1,
    commands: [
      { action: "navigate", region: "100,100,200,200", relativeTo: "pct:50,0,50,100" },
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
      { action: "navigate", region: "pct:10,10,20,20", relativeTo: "not-valid" },
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
      { action: "navigate", region: "pct:10,10,20,20", relativeTo: "full" },
    ],
  },
});
assert(r4i.isError === true, "relativeTo 'full' → error (must be pct:)");

// Uses a fresh viewUUID dedicated to these checks so the queue-accounting
// in section 5 (which expects exact command counts on viewUUID1 and
// viewUUID2) is not perturbed.
console.log("\n--- 4j/4k: deliveryState transitions ---");
{
  const fresh = await client.callTool({
    name: "get_artwork_image",
    arguments: { objectNumber: "SK-A-2344" },
  });
  const freshSc = fresh.structuredContent ?? JSON.parse(fresh.content[0].text);
  const stateUuid = freshSc.viewUUID;

  // 4j: navigate before any poll → no_live_viewer_seen
  const r4j = await client.callTool({
    name: "navigate_viewer",
    arguments: {
      viewUUID: stateUuid,
      commands: [{ action: "navigate", region: "full" }],
    },
  });
  const nav4j = r4j.structuredContent ?? JSON.parse(r4j.content[0].text);
  assert(nav4j.deliveryState === "no_live_viewer_seen",
    `deliveryState = no_live_viewer_seen (got ${nav4j.deliveryState})`);
  assert(nav4j.recentlyPolledByViewer === false,
    `recentlyPolledByViewer false when never polled`);
  assert(nav4j.lastPolledAt === undefined,
    `lastPolledAt absent when never polled`);
  assert(typeof nav4j.pendingCommandCount === "number",
    `pendingCommandCount populated (${nav4j.pendingCommandCount})`);
  const text4j = r4j.content?.[0]?.text ?? "";
  assert(text4j.includes("no viewer has connected yet"),
    `text-channel narration matches state ("${text4j.slice(0, 80)}")`);
  assert(!text4j.includes("not connected"),
    `text no longer uses misleading "not connected" wording`);

  // 4k: poll, then navigate → delivered_recently
  await client.callTool({
    name: "poll_viewer_commands",
    arguments: { viewUUID: stateUuid },
  });
  const r4k = await client.callTool({
    name: "navigate_viewer",
    arguments: {
      viewUUID: stateUuid,
      commands: [{ action: "navigate", region: "full" }],
    },
  });
  const nav4k = r4k.structuredContent ?? JSON.parse(r4k.content[0].text);
  assert(nav4k.deliveryState === "delivered_recently",
    `deliveryState = delivered_recently (got ${nav4k.deliveryState})`);
  assert(nav4k.recentlyPolledByViewer === true,
    `recentlyPolledByViewer true after fresh poll`);
  assert(typeof nav4k.lastPolledAt === "string" && nav4k.lastPolledAt.includes("T"),
    `lastPolledAt is ISO timestamp ("${nav4k.lastPolledAt}")`);
  const text4k = r4k.content?.[0]?.text ?? "";
  assert(text4k.startsWith("Delivered"),
    `text-channel narration leads with "Delivered" ("${text4k.slice(0, 60)}")`);
}

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

// 4bis-a. navigate with crop_pixels: format succeeds; prefix stripped before forwarding
console.log("\n--- 4bis-a: crop_pixels format accepted ---");
const r4bisA = await client.callTool({
  name: "navigate_viewer",
  arguments: {
    viewUUID: viewUUIDcp,
    commands: [
      { action: "navigate", region: "crop_pixels:100,200,300,400" },
    ],
  },
});
assert(!r4bisA.isError, "crop_pixels navigate should succeed");
const polledA = await client.callTool({
  name: "poll_viewer_commands",
  arguments: { viewUUID: viewUUIDcp },
});
const pollA = polledA.structuredContent ?? JSON.parse(polledA.content[0].text);
const cpOverlay = pollA.commands?.find((c) => c.action === "navigate" && c.region === "100,200,300,400");
assert(cpOverlay != null, `crop_pixels: prefix stripped and command queued (got "${pollA.commands?.[0]?.region}")`);

// 4bis-a2. crop_pixels with relativeTo is interpreted as crop-local rendered pixels.
console.log("\n--- 4bis-a2: crop-local crop_pixels via relativeToSize ---");
const r4bisA2 = await client.callTool({
  name: "navigate_viewer",
  arguments: {
    viewUUID: viewUUIDcp,
    commands: [
      {
        action: "navigate",
        region: "crop_pixels:600,300,240,120",
        relativeTo: "pct:50,50,50,50",
        relativeToSize: { width: 1200, height: 600 },
      },
    ],
  },
});
assert(!r4bisA2.isError, "crop-local crop_pixels navigate should succeed");
const navA2 = r4bisA2.structuredContent ?? JSON.parse(r4bisA2.content[0].text);
assert(navA2.queued === 1, "crop-local navigate queued 1 command");
const polledA2 = await client.callTool({
  name: "poll_viewer_commands",
  arguments: { viewUUID: viewUUIDcp },
});
const pollA2 = polledA2.structuredContent ?? JSON.parse(polledA2.content[0].text);
const cropLocalCmd = pollA2.commands?.find((c) => c.action === "navigate" && c.region === "pct:75,75,10,10");
assert(cropLocalCmd != null, "Polled crop-local command is projected full-image pct (pct:75,75,10,10)");

// 4bis-a3. crop-local pixels require the inspected crop dimensions.
console.log("\n--- 4bis-a3: crop-local crop_pixels requires relativeToSize ---");
const r4bisA3 = await client.callTool({
  name: "navigate_viewer",
  arguments: {
    viewUUID: viewUUIDcp,
    commands: [
      {
        action: "navigate",
        region: "crop_pixels:600,300,240,120",
        relativeTo: "pct:50,50,50,50",
      },
    ],
  },
});
assert(r4bisA3.isError === true, "relativeTo + crop_pixels without relativeToSize returns isError");
assert((r4bisA3.content?.[0]?.text ?? "").includes("relativeToSize"), "missing-size error mentions relativeToSize");

// 4bis-a4. crop-local pixels are bounds-checked against relativeToSize.
console.log("\n--- 4bis-a4: crop-local crop_pixels OOB rejected ---");
const r4bisA4 = await client.callTool({
  name: "navigate_viewer",
  arguments: {
    viewUUID: viewUUIDcp,
    commands: [
      {
        action: "navigate",
        region: "crop_pixels:1190,10,50,50",
        relativeTo: "pct:50,50,50,50",
        relativeToSize: { width: 1200, height: 600 },
      },
    ],
  },
});
assert(r4bisA4.isError === true, "crop-local OOB returns isError");
assert((r4bisA4.content?.[0]?.text ?? "").includes("inspected crop dimensions"), "crop-local OOB error mentions crop dimensions");

// 4bis-b. navigate with OOB pct returns structured warning + isError
console.log("\n--- 4bis-b: OOB pct (y=325) rejected with structured warning ---");
const r4bisB = await client.callTool({
  name: "navigate_viewer",
  arguments: {
    viewUUID: viewUUIDcp,
    commands: [
      { action: "navigate", region: "pct:36,325,35,30" },
    ],
  },
});
assert(r4bisB.isError === true, "OOB pct returns isError");
const oobText = r4bisB.content?.[0]?.text ?? "";
assert(oobText.includes("overlay_region_out_of_bounds"), "error text includes warning code");
assert(oobText.includes("y=325 outside 0–100"), "error text identifies y=325 issue");
assert(oobText.includes("clamped_to"), "error text includes clamped_to preview");
assert(oobText.includes("please re-examine the image"), "error text carries retry cue");
// Channel parity: structured recovery payload + the artwork identity needed for the
// inspect_artwork_image verify-after step (both prose-only before the fix).
const navOobRecovery = r4bisB.structuredContent?.regionRecovery;
assert(navOobRecovery != null, "navigate OOB exposes structured regionRecovery");
assert((navOobRecovery?.clampedTo?.length ?? 0) > 0, "navigate regionRecovery.clampedTo present");
assert((r4bisB.structuredContent?.objectNumber?.length ?? 0) > 0, "navigate OOB carries objectNumber (verify-after identity)");

// 4bis-c. navigate with x+w > 100 rejected
console.log("\n--- 4bis-c: OOB pct (x+w=110) rejected ---");
const r4bisC = await client.callTool({
  name: "navigate_viewer",
  arguments: {
    viewUUID: viewUUIDcp,
    commands: [
      { action: "navigate", region: "pct:80,10,30,20" },
    ],
  },
});
assert(r4bisC.isError === true, "OOB x+w=110 returns isError");
const oobCText = r4bisC.content?.[0]?.text ?? "";
assert(oobCText.includes("x+w=110"), "error text identifies x+w overflow");

// 4bis-d. OOB call does not mutate queue
console.log("\n--- 4bis-d: OOB rejection does not queue commands ---");
// First queue a known-good command
await client.callTool({
  name: "navigate_viewer",
  arguments: {
    viewUUID: viewUUIDcp,
    commands: [{ action: "navigate", region: "pct:0,0,50,50" }],
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
    commands: [{ action: "navigate", region: "pct:10,10,0,50" }],
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
      { action: "navigate", region: "crop_pixels:50000,0,100,100" },
    ],
  },
});
assert(r4bisE.isError === true, "crop_pixels OOB returns isError");
const oobCpText = r4bisE.content?.[0]?.text ?? "";
assert(oobCpText.includes("overlay_region_out_of_bounds"), "crop_pixels OOB text includes warning code");
assert(/exceeds imageWidth/.test(oobCpText), "crop_pixels OOB text identifies imageWidth overflow");
assert(oobCpText.includes("please re-examine the image"), "crop_pixels OOB carries retry cue");

// ══════════════════════════════════════════════════════════════════
//  4ter. inspect_artwork_image auto-discovers the most-recent viewer
// ══════════════════════════════════════════════════════════════════
//
// (The former show_overlays compositing / self-verification path was removed
// with the LLM-overlay feature; only the recency tie-break on multi-viewer
// auto-discovery — shared with the kept auto-zoom path — survives.)

section("4ter. inspect auto-discovers most-recent viewer");

// Two viewers for the same artwork; inspect without an explicit viewUUID must
// resolve to the most recently accessed one (not collapse to 'ambiguous').
const r4terA0 = await client.callTool({
  name: "get_artwork_image",
  arguments: { objectNumber: "SK-A-2152" },
});
const viewUUIDov = (r4terA0.structuredContent ?? JSON.parse(r4terA0.content[0].text)).viewUUID;

const r4terE0 = await client.callTool({
  name: "get_artwork_image",
  arguments: { objectNumber: "SK-A-2152" },
});
const viewUUIDov2 = (r4terE0.structuredContent ?? JSON.parse(r4terE0.content[0].text)).viewUUID;
assert(viewUUIDov2 !== viewUUIDov, "second viewer has a distinct UUID");

// Touch the newer viewer so it is unambiguously most-recent.
await client.callTool({
  name: "navigate_viewer",
  arguments: {
    viewUUID: viewUUIDov2,
    commands: [{ action: "navigate", region: "pct:20,20,10,10" }],
  },
});

const r4terE = await client.callTool({
  name: "inspect_artwork_image",
  arguments: {
    objectNumber: "SK-A-2152",
    region: "pct:0,0,50,50",
    size: 448,
    navigateViewer: false,
  },
});
const recentSC = r4terE.structuredContent ?? JSON.parse(r4terE.content.find(c => c.type === "text").text);
assert(recentSC.viewUUID === viewUUIDov2, `auto-discovered most recent viewer (expected ${viewUUIDov2?.slice(0, 8)}, got ${recentSC.viewUUID?.slice(0, 8)})`);

// ══════════════════════════════════════════════════════════════════
//  5. poll_viewer_commands — queue draining
// ══════════════════════════════════════════════════════════════════

section("5. poll_viewer_commands — queue draining");

// 5a. Poll viewer 1 — accumulated from 4a (2) + 4d (1) + 4f (1) = 4
// Note: 4c/4g/4h/4i were rejected, not queued.
console.log("\n--- 5a: Poll viewer 1 (should drain 4 commands) ---");
const r5a = await client.callTool({
  name: "poll_viewer_commands",
  arguments: { viewUUID: viewUUID1 },
});
const poll1 = r5a.structuredContent ?? JSON.parse(r5a.content[0].text);
assert(Array.isArray(poll1.commands), "commands is an array");
assert(poll1.commands.length === 4, `Drained 4 commands (got ${poll1.commands.length})`);

// Every queued command is a zoom/pan navigate now.
assert(poll1.commands.every(c => c.action === "navigate"), "all polled commands are navigate");
const regionCmd = poll1.commands.find(c => c.region === "pct:38,22,28,22");
assert(regionCmd != null, "navigate command preserves region");

// The projected relativeTo command carries a full-image region and no relativeTo.
const projCmd = poll1.commands.find(c => c.region === "pct:75,50,10,20");
assert(projCmd != null, `projected relativeTo command present (${poll1.commands.map(c => c.region).join(", ")})`);
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

// 6d. Navigate viewer (zoom) — diagnostic trace Turn 3, now zoom/pan only
console.log("\n--- 6d: navigate_viewer zoom ---");
const r6d = await client.callTool({
  name: "navigate_viewer",
  arguments: {
    viewUUID: wfViewUUID,
    commands: [
      { action: "navigate", region: "full" },
      { action: "navigate", region: "pct:10,20,30,40" },
    ],
  },
});
const navWf = r6d.structuredContent ?? JSON.parse(r6d.content[0].text);
assert(navWf.queued === 2, `Queued 2 workflow commands`);

// 6e. Poll to verify
console.log("\n--- 6e: poll_viewer_commands ---");
const r6e = await client.callTool({
  name: "poll_viewer_commands",
  arguments: { viewUUID: wfViewUUID },
});
const pollWf = r6e.structuredContent ?? JSON.parse(r6e.content[0].text);
assert(pollWf.commands.length === 2, `Polled 2 commands (got ${pollWf.commands.length})`);

// Verify ordering preserved (navigate full → navigate region)
assert(pollWf.commands[0].action === "navigate" && pollWf.commands[0].region === "full",
  "First command is navigate full");
assert(pollWf.commands[1].action === "navigate" && pollWf.commands[1].region === "pct:10,20,30,40",
  "Second command is navigate to region");

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

  // 8b. MCP tool annotations present on every tool (issue #259).
  // Without these, destructiveHint defaults to true and read tools get mislabelled.
  // openWorldHint is false on every tool — per the spec example (memory = closed,
  // web search = open), the server's entire domain is the bounded Rijksmuseum corpus.
  const ANN_READ_CLOSED = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const ANN_VIEWER      = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
  const EXPECTED_ANNOTATIONS = {
    search_artwork:        ANN_READ_CLOSED,
    search_persons:        ANN_READ_CLOSED,
    get_artwork_details:   ANN_READ_CLOSED,
    collection_stats:      ANN_READ_CLOSED,
    semantic_search:       ANN_READ_CLOSED,
    find_similar:          ANN_READ_CLOSED,
    search_provenance:     ANN_READ_CLOSED,
    search_inscriptions:   ANN_READ_CLOSED,
    get_recent_changes:    ANN_READ_CLOSED,
    list_curated_sets:     ANN_READ_CLOSED,
    browse_set:            ANN_READ_CLOSED,
    get_conservation_history:         ANN_READ_CLOSED,
    get_artwork_bibliography:         ANN_READ_CLOSED,
    find_artworks_citing_publication: ANN_READ_CLOSED,
    inspect_artwork_image: ANN_READ_CLOSED,
    get_artwork_image:     ANN_VIEWER,
    remount_viewer:        ANN_VIEWER,
    navigate_viewer:       ANN_VIEWER,
    poll_viewer_commands:  ANN_VIEWER,
  };
  for (const tool of tools) {
    assert(tool.annotations, `${tool.name}: has annotations object`);
    const expected = EXPECTED_ANNOTATIONS[tool.name];
    if (expected) {
      for (const key of Object.keys(expected)) {
        assert(
          tool.annotations[key] === expected[key],
          `${tool.name}.annotations.${key} === ${expected[key]} (got ${tool.annotations[key]})`
        );
      }
    } else {
      // New tool — flag so the mapping is updated explicitly.
      assert(false, `${tool.name}: no annotations mapping in test (add it to EXPECTED_ANNOTATIONS)`);
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

// 9d. JSON null on navigate_viewer optional command field
console.log("\n--- 9d: JSON null on navigate_viewer command fields ---");
{
  // navigate_viewer commands use optStr() for region + relativeTo — verify a
  // null value on an optional field doesn't cause a validation error.
  const r = await client.callTool({
    name: "navigate_viewer",
    arguments: {
      viewUUID: "00000000-0000-0000-0000-000000000000",
      commands: [{ action: "navigate", region: "full", relativeTo: null }],
    },
  });
  // Will fail with "unknown viewer" but should NOT fail with validation error
  const { text } = parseResult(r);
  assert(
    !text.includes("Input validation error") && !text.includes("invalid_type"),
    "navigate_viewer accepts null relativeTo without validation error"
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

// provenanceChain is exposed in structuredContent as a parsed array of events
// (sequence, transferType, party, location, date, price, gap, uncertain) so
// clients reading only structuredContent — web app, agentic pipelines — don't
// have to re-parse the raw provenance string. The text channel renders a
// human-readable summary built from the same data. Null when no provenance
// text is available.
console.log("\n--- 10a: get_artwork_details — provenanceChain present in structuredContent ---");
{
  const r = await client.callTool({
    name: "get_artwork_details",
    arguments: { objectNumber: "SK-A-2344" },
  });
  const { sc, isError } = parseResult(r);
  assert(!isError, "get_artwork_details succeeds for SK-A-2344");
  assert(sc != null, "structuredContent present");
  assert(sc?.provenance != null, "provenance raw text present in structuredContent");
  assert(Array.isArray(sc?.provenanceChain), "provenanceChain is an array");
  assert((sc?.provenanceChain?.length ?? 0) > 0, "provenanceChain has at least one event");
  const ev = sc?.provenanceChain?.[0];
  assert(typeof ev?.sequence === "number" && typeof ev?.transferType === "string",
    "provenanceChain events carry sequence + transferType");
  assert(typeof ev?.gap === "boolean" && typeof ev?.uncertain === "boolean",
    "provenanceChain events carry gap + uncertain booleans");
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
    assert(sc.provenance == null, "provenance raw text is null when no provenance");
    assert(sc.provenanceChain === null, "provenanceChain is null (not undefined) when no provenance");
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
