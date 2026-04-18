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
import { access, readFile, writeFile, mkdir } from "node:fs/promises";

import Anthropic from "@anthropic-ai/sdk";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { imageSize } from "image-size";

import { clampToImage, iou, centerOffsetPct, sizeRatio, projectLocalToFull } from "./overlay-scoring.mjs";

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

const ANTHROPIC_MAX_ATTEMPTS = 3;    // total attempts including the first try
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
  for (let attempt = 0; attempt < ANTHROPIC_MAX_ATTEMPTS; attempt++) {
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
      if (attempt < ANTHROPIC_MAX_ATTEMPTS - 1) {
        const delay = ANTHROPIC_BASE_DELAY_MS * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastError ?? new Error("Anthropic API failed after retries");
}

/**
 * Parse coordinate output. Accepts `{"region":"pct:..."}` or `{"region":"crop_pixels:..."}`.
 * Returns { format, bbox: [x,y,w,h] } or null.
 */
export function parseLlmCoords(text) {
  // Note: [^{}] excludes nested braces — if the LLM emits a nested object alongside
  // `region` (e.g. `{"region":"pct:...", "confidence":{"level":"high"}}`), this
  // regex returns null and the caller logs a parse_error. The system prompt asks
  // for a flat object, so nested output is off-policy.
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

/** Run the full Phase A sweep. Returns the aggregate results object. */
export async function runFixedCropHarness({ experiment, groundTruth, featureSubset, runsOverride, onProgress }) {
  const started_at = new Date().toISOString();
  const runs = runsOverride ?? experiment.runsPerCondition;
  const features = featureSubset ?? groundTruth.features.filter((f) => f.label);

  const anthropic = new Anthropic({ apiKey: await loadAnthropicKey() });
  const { client, transport } = await openMcpClient();

  const records = [];
  const crops = new Map();

  try {
    // Pre-fetch one crop per feature (reused across conditions + runs)
    for (const f of features) {
      const regionBbox = computeCropRegion(f.bbox_pct, experiment.cropExpandFactor);
      const region = formatPctRegion(regionBbox);
      const crop = await fetchCrop(client, experiment.case.objectNumber, region);
      crops.set(f.id, {
        regionUsed: crop.regionUsed,
        regionBbox,
        image: { base64: crop.base64, mimeType: crop.mimeType },
        cropPxSize: { width: crop.widthPx, height: crop.heightPx },
        nativeWidth: crop.nativeWidth,
        nativeHeight: crop.nativeHeight,
      });
      onProgress?.({ phase: "crop-fetched", featureId: f.id, region });
    }

    // Run conditions × features × N
    for (const f of features) {
      const c = crops.get(f.id);
      for (const cond of experiment.conditions) {
        for (let runIdx = 0; runIdx < runs; runIdx++) {
          const rec = await singleRun({
            anthropic, model: experiment.model,
            feature: f, condition: cond, crop: c, runIdx,
          });
          records.push(rec);
          onProgress?.({ phase: "run-done", rec });
        }
      }
    }
  } finally {
    await transport.close();
  }

  return {
    experiment_id: experiment.id,
    started_at,
    model: experiment.model,
    case_id: experiment.case.id,
    runs_per_condition: runs,
    crop_expand_factor: experiment.cropExpandFactor,
    runs: records,
    aggregates: aggregate(records, experiment.conditions),
  };
}

async function singleRun({ anthropic, model, feature, condition, crop, runIdx }) {
  const prompt = condition.promptTemplate({ feature, crop: crop.cropPxSize });
  const imageAspect = (crop.nativeWidth && crop.nativeHeight)
    ? crop.nativeWidth / crop.nativeHeight
    : 1;
  const t0 = Date.now();
  let apiResult, parseResult, predictedLocal, predictedFull, scores;
  let oobClamped = false, predictedFullClamped;
  let error = null;
  try {
    apiResult = await promptAnthropic({ anthropic, model, image: crop.image, prompt });
    parseResult = parseLlmCoords(apiResult.text);
    if (!parseResult) {
      error = { type: "parse_error", raw: apiResult.text };
    } else {
      predictedLocal = parseResult.format === "pct"
        ? parseResult.bbox
        : cropPixelsToLocalPct(parseResult.bbox, crop.cropPxSize);
      predictedFull = projectLocalToFull(predictedLocal, crop.regionBbox);
      const clampResult = clampToImage(predictedFull, 100);
      oobClamped = clampResult.clamped;
      predictedFullClamped = clampResult.bbox;
      scores = {
        iou: iou(predictedFullClamped, feature.bbox_pct),
        center_offset_pct: centerOffsetPct(predictedFullClamped, feature.bbox_pct, imageAspect),
        size_ratio: sizeRatio(predictedFullClamped, feature.bbox_pct),
      };
    }
  } catch (err) {
    error = { type: "api_error", message: err?.message ?? String(err) };
  }
  return {
    feature_id: feature.id,
    feature_label: feature.label,
    condition: condition.id,
    run_idx: runIdx,
    crop_region: crop.regionUsed,
    crop_px_size: crop.cropPxSize,
    image_aspect: imageAspect,
    llm_raw: apiResult?.text,
    predicted_local: predictedLocal,
    predicted_full_pct: predictedFull,
    predicted_full_pct_clamped: predictedFullClamped,
    oob_clamped: oobClamped ?? false,
    ground_truth_pct: feature.bbox_pct,
    scores,
    error,
    elapsed_ms: Date.now() - t0,
    usage: apiResult?.usage,
  };
}

function aggregate(records, conditions) {
  const out = {};
  for (const cond of conditions) {
    const ok = records.filter((r) => r.condition === cond.id && r.scores);
    if (ok.length === 0) { out[cond.id] = { n: 0 }; continue; }
    const iouVals = ok.map((r) => r.scores.iou).sort((a, b) => a - b);
    const coVals  = ok.map((r) => r.scores.center_offset_pct).sort((a, b) => a - b);
    const srVals  = ok.map((r) => r.scores.size_ratio).sort((a, b) => a - b);
    out[cond.id] = {
      n: ok.length,
      iou: { median: median(iouVals), mean: mean(iouVals), p25: quantile(iouVals, 0.25), p75: quantile(iouVals, 0.75) },
      center_offset_pct: { median: median(coVals), mean: mean(coVals), p25: quantile(coVals, 0.25), p75: quantile(coVals, 0.75) },
      size_ratio: { median: median(srVals), mean: mean(srVals), p25: quantile(srVals, 0.25), p75: quantile(srVals, 0.75) },
      parse_errors: records.filter((r) => r.condition === cond.id && r.error?.type === "parse_error").length,
      api_errors:   records.filter((r) => r.condition === cond.id && r.error?.type === "api_error").length,
    };
  }
  return out;
}

// Upper-median for even n. Both conditions see the same bias, so condition-to-condition deltas are unaffected.
function median(a) { return a.length ? a[Math.floor(a.length / 2)] : NaN; }
function mean(a)   { return a.reduce((s, x) => s + x, 0) / (a.length || 1); }
function quantile(a, q) {
  if (!a.length) return NaN;
  const i = Math.min(a.length - 1, Math.floor(q * a.length));
  return a[i];
}

/** Write results JSON + markdown summary to `<outDir>/<ts>-<model>.{json,md}`. */
export async function writeResults(outDir, results) {
  await mkdir(outDir, { recursive: true });
  const ts = results.started_at.replace(/[:.]/g, "-");
  const base = path.join(outDir, `${ts}-${results.model}`);
  await writeFile(`${base}.json`, JSON.stringify(results, null, 2) + "\n");
  await writeFile(`${base}.md`, renderMarkdown(results));
  return { json: `${base}.json`, md: `${base}.md` };
}

function renderMarkdown(r) {
  const lines = [];
  lines.push(`# Experiment: ${r.experiment_id}`);
  lines.push(`- Model: \`${r.model}\``);
  lines.push(`- Case: \`${r.case_id}\``);
  lines.push(`- Runs per condition: ${r.runs_per_condition}`);
  lines.push(`- Crop expand factor: ${r.crop_expand_factor}`);
  lines.push(`- Started: ${r.started_at}`);
  lines.push("");
  lines.push("## Aggregates");
  lines.push("");
  lines.push("| Condition | n | IoU median | Center offset median (%) | Size ratio median | Parse err | API err |");
  lines.push("|-----------|---|-----------:|--------------------------:|------------------:|----------:|--------:|");
  for (const [cond, a] of Object.entries(r.aggregates)) {
    lines.push(`| ${cond} | ${a.n ?? 0} | ${fmt(a.iou?.median)} | ${fmt(a.center_offset_pct?.median)} | ${fmt(a.size_ratio?.median)} | ${a.parse_errors ?? 0} | ${a.api_errors ?? 0} |`);
  }
  lines.push("");
  lines.push("## Per-run detail");
  lines.push("");
  lines.push("| Feature | Cond | Run | IoU | Offset | Size ratio |");
  lines.push("|---------|------|-----|----:|-------:|-----------:|");
  for (const rec of r.runs) {
    const s = rec.scores ?? {};
    lines.push(`| ${rec.feature_label ?? rec.feature_id} | ${rec.condition} | ${rec.run_idx} | ${fmt(s.iou)} | ${fmt(s.center_offset_pct)} | ${fmt(s.size_ratio)} |`);
  }
  lines.push("");
  return lines.join("\n");
}
function fmt(n) { return typeof n === "number" ? n.toFixed(3) : "—"; }
