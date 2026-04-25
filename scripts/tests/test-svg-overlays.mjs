/**
 * Visual test for SVG overlay rendering.
 *
 * Opens a viewer for The Night Watch, then adds various overlay shapes.
 * Run:  node scripts/tests/test-svg-overlays.mjs
 * Uses: stdio mode (MCP SDK Client)
 *
 * After running, open the viewer URL printed to the console.
 * The viewer will show overlays after ~2 seconds of polling.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  cwd: PROJECT_DIR,
  env: { ...process.env, STRUCTURED_CONTENT: "true" },
});

const client = new Client({ name: "test-svg-overlays", version: "0.1" });
await client.connect(transport);
console.log("Connected to server via stdio\n");

// 1. Open viewer for The Night Watch
console.log("Opening viewer for SK-C-5 (The Night Watch)...");
const r1 = await client.callTool({
  name: "get_artwork_image",
  arguments: { objectNumber: "SK-C-5" },
});
const text1 = r1.content.find(b => b.type === "text")?.text ?? "";
const viewUUID = text1.match(/viewUUID['":\s]+([a-f0-9-]+)/)?.[1];
if (!viewUUID) {
  console.error("Failed to get viewUUID. Response:", text1.slice(0, 200));
  process.exit(1);
}
console.log(`viewUUID: ${viewUUID}`);

// 2. Wait a moment, then add various overlay shapes
console.log("Adding overlays in 2 seconds...");
await new Promise(r => setTimeout(r, 2000));

// Rectangle overlay (backward compat add_overlay)
console.log("  → add_overlay: rect around Banninck Cocq (captain)");
const r2 = await client.callTool({
  name: "navigate_viewer",
  arguments: {
    viewUUID,
    commands: [
      { action: "navigate", region: "pct:20,15,40,75" },
      {
        action: "add_overlay",
        region: "pct:33,20,14,55",
        label: "Captain Banninck Cocq",
        color: "rgba(255,100,0,0.8)",
      },
    ],
  },
});
console.log(`  Queued: ${JSON.parse(r2.content.find(b => b.type === "text")?.text ?? "{}").queued ?? "?"} commands`);

await new Promise(r => setTimeout(r, 1000));

// Ellipse (add_shape)
console.log("  → add_shape ellipse: face detail");
await client.callTool({
  name: "navigate_viewer",
  arguments: {
    viewUUID,
    commands: [{
      action: "add_shape",
      shape: "ellipse",
      cx: 1950,
      cy: 1050,
      rx: 120,
      ry: 150,
      label: "Face",
      color: "rgba(59,130,246,0.8)",
    }],
  },
});

await new Promise(r => setTimeout(r, 500));

// Line (add_shape)
console.log("  → add_shape line: compositional diagonal");
await client.callTool({
  name: "navigate_viewer",
  arguments: {
    viewUUID,
    commands: [{
      action: "add_shape",
      shape: "line",
      from: [800, 400],
      to: [3500, 2800],
      color: "rgba(220,50,50,0.6)",
      strokeWidth: 4,
      strokeDash: "20,10",
      label: "Diagonal",
    }],
  },
});

await new Promise(r => setTimeout(r, 500));

// Polygon (add_shape)
console.log("  → add_shape polygon: highlight area");
await client.callTool({
  name: "navigate_viewer",
  arguments: {
    viewUUID,
    commands: [{
      action: "add_shape",
      shape: "polygon",
      points: [[2400, 600], [2900, 600], [2900, 1400], [2600, 1600], [2400, 1400]],
      label: "Lt. van Ruytenburch",
      color: "rgba(16,185,129,0.7)",
      fill: "rgba(16,185,129,0.08)",
    }],
  },
});

await new Promise(r => setTimeout(r, 500));

// Rect via add_shape (new syntax)
console.log("  → add_shape rect: dashed highlight");
await client.callTool({
  name: "navigate_viewer",
  arguments: {
    viewUUID,
    commands: [{
      action: "add_shape",
      shape: "rect",
      region: "pct:55,40,15,25",
      label: "Girl in gold",
      color: "rgba(234,179,8,0.8)",
      strokeDash: "10,5",
    }],
  },
});

console.log("\n✓ All overlays sent.");
console.log("  The viewer should show: orange rect, blue ellipse, red dashed diagonal,");
console.log("  green polygon, and yellow dashed rect — each with a label.");
console.log("\n  Press Ctrl+C to exit.\n");

// Keep alive so the viewer can poll
await new Promise(r => setTimeout(r, 120_000));
await client.close();
