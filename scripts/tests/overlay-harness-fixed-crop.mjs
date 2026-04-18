/**
 * Phase A overlay-accuracy harness — fixed crop, direct Anthropic API.
 * Tests pure coordinate-estimation accuracy under different prompt formats.
 *
 * Exports (built across Tasks 5–7):
 *   - computeCropRegion    (this task)
 *   - formatPctRegion      (this task)
 *   - openMcpClient        (this task)
 *   - fetchCrop            (this task)
 *   - loadAnthropicKey     (Task 6)
 *   - promptAnthropic      (Task 6)
 *   - parseLlmCoords       (Task 6)
 *   - cropPixelsToLocalPct (Task 6)
 *   - runFixedCropHarness  (Task 7)
 *   - writeResults         (Task 7)
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { access } from "node:fs/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { imageSize } from "image-size";

import { clampToImage } from "./overlay-scoring.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(HERE, "../..");

/** Compute a crop region in full-image pct, containing a feature, expanded by factor. */
export function computeCropRegion(bbox_pct, expandFactor) {
  const [x, y, w, h] = bbox_pct;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const cw = w * expandFactor;
  const ch = h * expandFactor;
  const raw = [cx - cw / 2, cy - ch / 2, cw, ch];
  const { bbox } = clampToImage(raw, 100);
  return bbox;
}

/** Format a pct bbox as an IIIF pct: region string with 2-dp precision. */
export function formatPctRegion(bbox) {
  const r = (n) => Math.round(n * 100) / 100;
  return `pct:${r(bbox[0])},${r(bbox[1])},${r(bbox[2])},${r(bbox[3])}`;
}

/** Spawn the MCP server over stdio and return a connected client + transport. */
export async function openMcpClient() {
  const distPath = path.join(PROJECT_DIR, "dist/index.js");
  try {
    await access(distPath);
  } catch {
    throw new Error(`dist/index.js not found at ${distPath} — run \`npm run build\` first`);
  }
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    cwd: PROJECT_DIR,
    env: { ...process.env, STRUCTURED_CONTENT: "true" },
  });
  const client = new Client({ name: "overlay-harness", version: "0.1" });
  await client.connect(transport);
  return { client, transport };
}

/**
 * Fetch a crop from the MCP server.
 * @returns {Promise<{ base64:string, mimeType:string, widthPx:number, heightPx:number, nativeWidth:number|undefined, nativeHeight:number|undefined, regionUsed:string }>}
 *   - widthPx/heightPx: the returned CROP's pixel dimensions (measured from the image bytes)
 *   - nativeWidth/nativeHeight: the FULL image's pixel dimensions (from MCP structuredContent)
 */
export async function fetchCrop(client, objectNumber, regionPct) {
  const result = await client.callTool({
    name: "inspect_artwork_image",
    arguments: { objectNumber, region: regionPct, size: 1200 },
  });
  if (!Array.isArray(result?.content)) {
    throw new Error(`inspect_artwork_image returned no content for ${objectNumber} @ ${regionPct}`);
  }
  if (result.isError) {
    const errText = result.content.find((c) => c.type === "text")?.text ?? "unknown error";
    throw new Error(`inspect_artwork_image error for ${objectNumber} @ ${regionPct}: ${errText}`);
  }
  const imgBlock = result.content.find((c) => c.type === "image");
  if (!imgBlock) throw new Error(`No image in inspect_artwork_image response for ${regionPct}`);

  const buf = Buffer.from(imgBlock.data, "base64");
  const dims = imageSize(buf);

  const sc = result.structuredContent ?? {};
  const nativeWidth = typeof sc.nativeWidth === "number" ? sc.nativeWidth : undefined;
  const nativeHeight = typeof sc.nativeHeight === "number" ? sc.nativeHeight : undefined;

  return {
    base64: imgBlock.data,
    mimeType: imgBlock.mimeType,
    widthPx: dims.width,
    heightPx: dims.height,
    nativeWidth,
    nativeHeight,
    regionUsed: regionPct,
  };
}
