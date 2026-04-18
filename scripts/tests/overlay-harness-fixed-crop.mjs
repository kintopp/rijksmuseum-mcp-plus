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
import { access, readFile } from "node:fs/promises";

import Anthropic from "@anthropic-ai/sdk";

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

const ANTHROPIC_MAX_RETRIES = 3;
const ANTHROPIC_BASE_DELAY_MS = 1000;

/** Read ANTHROPIC_API_KEY from env or ~/.env (handles the quoted-value case). */
export async function loadAnthropicKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const envPath = path.join(process.env.HOME, ".env");
  try {
    const txt = await readFile(envPath, "utf8");
    const m = txt.match(/^\s*ANTHROPIC_API_KEY\s*=\s*["']?([^"'\n]+)["']?\s*$/m);
    if (m) return m[1].trim();
  } catch (_) { /* missing → fall through */ }
  throw new Error("ANTHROPIC_API_KEY not found in env or ~/.env");
}

/**
 * Call the Anthropic API with the crop image + prompt.
 * Retries on 429/5xx with exponential backoff.
 */
export async function promptAnthropic({ anthropic, model, image, prompt }) {
  let lastError = null;
  for (let attempt = 0; attempt < ANTHROPIC_MAX_RETRIES; attempt++) {
    try {
      const resp = await anthropic.messages.create({
        model,
        max_tokens: 256,
        system: [{ type: "text", text: prompt.system, cache_control: { type: "ephemeral" } }],
        messages: [{
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: image.mimeType, data: image.base64 },
              cache_control: { type: "ephemeral" },
            },
            { type: "text", text: prompt.user },
          ],
        }],
      });
      const textBlock = resp.content.find((b) => b.type === "text");
      return { text: textBlock?.text ?? "", usage: resp.usage };
    } catch (err) {
      lastError = err;
      const status = err?.status ?? err?.response?.status;
      if (status && status < 500 && status !== 429) break;
      const delay = ANTHROPIC_BASE_DELAY_MS * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError ?? new Error("Anthropic API failed after retries");
}

/**
 * Parse coordinate output. Accepts `{"region":"pct:..."}` or `{"region":"crop_pixels:..."}`.
 * Returns { format, bbox: [x,y,w,h] } or null.
 */
export function parseLlmCoords(text) {
  const jsonMatch = text.match(/\{[^{}]*"region"\s*:\s*"([^"]+)"[^{}]*\}/);
  if (!jsonMatch) return null;
  const regionStr = jsonMatch[1].trim();

  const pctM = regionStr.match(/^pct:\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*$/);
  if (pctM) return { format: "pct", bbox: pctM.slice(1, 5).map(Number) };

  const pxM = regionStr.match(/^crop_pixels:\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*$/);
  if (pxM) return { format: "crop_pixels", bbox: pxM.slice(1, 5).map(Number) };

  return null;
}

/** Convert crop_pixels (absolute px within crop) to crop-local pct (0..100). */
export function cropPixelsToLocalPct(bbox_px, cropPxSize) {
  const [x, y, w, h] = bbox_px;
  return [
    (x / cropPxSize.width) * 100,
    (y / cropPxSize.height) * 100,
    (w / cropPxSize.width) * 100,
    (h / cropPxSize.height) * 100,
  ];
}
