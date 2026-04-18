/**
 * P1 two-pass harness. Tests whether compositing the LLM's own overlay onto
 * the crop before a second call improves estimation accuracy.
 *
 * Design: for each (feature, run_idx), issue ONE shared first call (pixel
 * prompt). Then, for each condition, issue a second call — using either the
 * raw crop (baseline) or the crop with call-1's bbox composited as an orange
 * rectangle (p1-composite). Score call 2 for both conditions. Same call-1
 * seed lets us attribute condition-level differences purely to the composite.
 *
 * Usage:
 *   node scripts/tests/overlay-harness-p1.mjs <experiment-dir> [--pilot] [--yes] [--model MODEL]
 *
 * The experiment dir must contain a config.mjs exporting a schema compatible
 * with this file's expectations (see the p1-show-overlays experiment).
 */
import path from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";

import Anthropic from "@anthropic-ai/sdk";
import sharp from "sharp";

import {
  openMcpClient, fetchCrop, loadAnthropicKey, parseLlmCoords,
  cropPixelsToLocalPct, computeCropRegion, formatPctRegion,
} from "./overlay-harness-fixed-crop.mjs";
import {
  iou, centerOffsetPct, sizeRatio, projectLocalToFull, clampToImage,
} from "./overlay-scoring.mjs";

// ── Compositor ──────────────────────────────────────────────────────

/**
 * Overlay a stroke-only rectangle on a JPEG crop.
 * @param {Buffer} jpegBytes
 * @param {[number, number, number, number]} bbox_px  — [x, y, w, h] in pixels
 * @returns {Promise<Buffer>} JPEG
 */
export async function compositeOverlay(jpegBytes, bbox_px, { color = "#ff6b35", strokeWidth = 3 } = {}) {
  const image = sharp(jpegBytes);
  const meta = await image.metadata();
  const W = meta.width, H = meta.height;
  const [x, y, w, h] = bbox_px;
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${color}" stroke-width="${strokeWidth}"/></svg>`;
  return image
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 85 })
    .toBuffer();
}

// ── Helpers ─────────────────────────────────────────────────────────

function clampBboxToCrop(bbox_px, W, H) {
  let [x, y, w, h] = bbox_px;
  x = Math.max(0, Math.min(W, x));
  y = Math.max(0, Math.min(H, y));
  w = Math.max(0, Math.min(W - x, w));
  h = Math.max(0, Math.min(H - y, h));
  return [x, y, w, h];
}

function bboxPxFromLocal(parsed, cropPxSize) {
  if (!parsed) return null;
  if (parsed.format === "crop_pixels") return parsed.bbox;
  // pct → px
  const [px, py, pw, ph] = parsed.bbox;
  return [
    Math.round((px / 100) * cropPxSize.width),
    Math.round((py / 100) * cropPxSize.height),
    Math.round((pw / 100) * cropPxSize.width),
    Math.round((ph / 100) * cropPxSize.height),
  ];
}

async function callAnthropic({ anthropic, model, systemText, userText, imageBase64, mimeType }) {
  const resp = await anthropic.messages.create({
    model,
    max_tokens: 256,
    system: [{ type: "text", text: systemText, cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mimeType, data: imageBase64 }, cache_control: { type: "ephemeral" } },
          { type: "text", text: userText },
        ],
      },
    ],
  });
  const textBlock = resp.content.find((b) => b.type === "text");
  return { raw: textBlock?.text ?? "", usage: resp.usage };
}

function scoreInFullPct(parsedLocal, cropPxSize, regionBbox, groundTruthPct, imageAspect) {
  if (!parsedLocal) return { scores: null, full: null, clamped: null, oob: null };
  const localPct = parsedLocal.format === "pct"
    ? parsedLocal.bbox
    : cropPixelsToLocalPct(parsedLocal.bbox, cropPxSize);
  const full = projectLocalToFull(localPct, regionBbox);
  const clampResult = clampToImage(full, 100);
  const clamped = clampResult.bbox;
  return {
    full,
    clamped,
    oob: clampResult.clamped,
    scores: {
      iou: iou(clamped, groundTruthPct),
      center_offset_pct: centerOffsetPct(clamped, groundTruthPct, imageAspect),
      size_ratio: sizeRatio(clamped, groundTruthPct),
    },
  };
}

// ── CLI ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.length === 0 || args.includes("--help")) {
  console.error("usage: overlay-harness-p1.mjs <experiment-dir> [--pilot] [--yes] [--model MODEL]");
  process.exit(2);
}
const expDir = path.resolve(args[0]);
const skipConfirm = args.includes("--yes");
const isPilot = args.includes("--pilot");
const modelFlag = (() => {
  const i = args.indexOf("--model");
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : null;
})();

// ── Load config + case ──────────────────────────────────────────────

const configPath = path.join(expDir, "config.mjs");
const configMod = await import(pathToFileURL(configPath).href);
const config = { ...configMod.default };
if (modelFlag) config.model = modelFlag;

const caseFile = path.resolve(expDir, config.case);
const caseMod = await import(pathToFileURL(caseFile).href);
const caseData = caseMod.default;
const gtPath = path.resolve(path.dirname(caseFile), caseData.groundTruthFile);
const gt = JSON.parse(await readFile(gtPath, "utf8"));

const featuresAll = gt.features.filter((f) => f.label || f.layer);
const features = isPilot ? featuresAll.slice(0, config.pilot?.features ?? 3) : featuresAll;
const runsPerFeature = isPilot
  ? (config.pilot?.runsPerFeature ?? 2)
  : (config.runsPerFeature ?? 3);

const totalCalls = features.length * runsPerFeature * (1 + config.conditions.length);
const perCall = config.model.includes("opus") ? 0.05 : 0.008;
const est = totalCalls * perCall;

console.log(`Experiment: ${config.id}${isPilot ? " (PILOT)" : ""}`);
console.log(`  Model: ${config.model}`);
console.log(`  Features: ${features.length} | Conditions: ${config.conditions.length} | Runs/feature: ${runsPerFeature}`);
console.log(`  Total API calls: ${totalCalls} (${features.length * runsPerFeature} first-calls + ${features.length * runsPerFeature * config.conditions.length} second-calls)`);
console.log(`  Est. cost: ~$${est.toFixed(2)}`);

if (!skipConfirm) {
  const yes = await askYesNo("Proceed? [y/N] ");
  if (!yes) { console.log("aborted."); process.exit(0); }
}

// ── Run ────────────────────────────────────────────────────────────

const anthropic = new Anthropic({ apiKey: await loadAnthropicKey() });
const { client, transport } = await openMcpClient();
const startedAt = new Date().toISOString();

const records = [];

try {
  // Pre-fetch one crop per feature
  const crops = new Map();
  for (const f of features) {
    const regionBbox = computeCropRegion(f.bbox_pct, config.cropExpandFactor ?? 3);
    const region = formatPctRegion(regionBbox);
    const crop = await fetchCrop(client, caseData.objectNumber, region);
    crops.set(f.id, { ...crop, regionBbox });
    console.error(`  crop fetched: #${f.id} ${region} (${crop.widthPx}×${crop.heightPx})`);
  }

  for (const f of features) {
    const c = crops.get(f.id);
    const cropPxSize = { width: c.widthPx, height: c.heightPx };
    const imageAspect = c.nativeWidth && c.nativeHeight ? c.nativeWidth / c.nativeHeight : 1;

    for (let runIdx = 0; runIdx < runsPerFeature; runIdx++) {
      // Call 1 — shared across both conditions
      const firstPrompt = config.firstPromptTemplate({ feature: f, crop: cropPxSize });
      let call1Raw, call1Parsed, call1BboxPx, call1Score;
      try {
        const r1 = await callAnthropic({
          anthropic, model: config.model,
          systemText: firstPrompt.system, userText: firstPrompt.user,
          imageBase64: c.base64, mimeType: c.mimeType,
        });
        call1Raw = r1.raw;
      } catch (err) {
        records.push({ feature_id: f.id, run_idx: runIdx, call1_error: err?.message ?? String(err) });
        continue;
      }
      call1Parsed = parseLlmCoords(call1Raw);
      call1BboxPx = bboxPxFromLocal(call1Parsed, cropPxSize);
      call1Score = scoreInFullPct(call1Parsed, cropPxSize, c.regionBbox, f.bbox_pct, imageAspect);

      // For each condition, run call 2
      for (const cond of config.conditions) {
        let call2Base64;
        let composited = false;
        if (cond.composite && call1BboxPx) {
          const clampedBbox = clampBboxToCrop(call1BboxPx, c.widthPx, c.heightPx);
          try {
            const jpg = await compositeOverlay(Buffer.from(c.base64, "base64"), clampedBbox);
            call2Base64 = jpg.toString("base64");
            composited = true;
          } catch (err) {
            call2Base64 = c.base64; // fall back
            composited = false;
          }
        } else {
          call2Base64 = c.base64;
        }

        const secondPrompt = cond.secondPromptTemplate({ feature: f, crop: cropPxSize, firstRaw: call1Raw });

        let call2Raw;
        try {
          const r2 = await callAnthropic({
            anthropic, model: config.model,
            systemText: secondPrompt.system, userText: secondPrompt.user,
            imageBase64: call2Base64, mimeType: c.mimeType,
          });
          call2Raw = r2.raw;
        } catch (err) {
          records.push({
            feature_id: f.id, feature_label: f.label, feature_layer: f.layer,
            condition: cond.id, run_idx: runIdx,
            call1_raw: call1Raw, call1_scores: call1Score.scores, call1_oob: call1Score.oob,
            composited, call2_error: err?.message ?? String(err),
          });
          continue;
        }
        const call2Parsed = parseLlmCoords(call2Raw);
        const call2Score = scoreInFullPct(call2Parsed, cropPxSize, c.regionBbox, f.bbox_pct, imageAspect);

        const rec = {
          feature_id: f.id,
          feature_label: f.label,
          feature_layer: f.layer,
          condition: cond.id,
          run_idx: runIdx,
          composited,
          call1_raw: call1Raw,
          call1_full_pct: call1Score.full,
          call1_clamped: call1Score.clamped,
          call1_oob: call1Score.oob,
          call1_scores: call1Score.scores,
          call2_raw: call2Raw,
          call2_full_pct: call2Score.full,
          call2_clamped: call2Score.clamped,
          call2_oob: call2Score.oob,
          call2_scores: call2Score.scores,
          iou_delta: call1Score.scores && call2Score.scores
            ? round3(call2Score.scores.iou - call1Score.scores.iou)
            : null,
          offset_delta: call1Score.scores && call2Score.scores
            ? round3(call2Score.scores.center_offset_pct - call1Score.scores.center_offset_pct)
            : null,
          ground_truth_pct: f.bbox_pct,
          image_aspect: imageAspect,
        };
        records.push(rec);
        const c1 = call1Score.scores, c2 = call2Score.scores;
        console.error(
          `  [${f.id}] ${cond.id}#${runIdx}` +
          ` call1 IoU=${fmt(c1?.iou)} off=${fmt(c1?.center_offset_pct)}` +
          ` → call2 IoU=${fmt(c2?.iou)} off=${fmt(c2?.center_offset_pct)}` +
          ` Δ=${fmt(rec.iou_delta)}/${fmt(rec.offset_delta)}`
        );
      }
    }
  }
} finally {
  await transport.close();
}

// ── Aggregate + persist ────────────────────────────────────────────

const aggregates = summarize(records, config.conditions);
const results = {
  experiment_id: config.id,
  phase: "p1-two-pass",
  started_at: startedAt,
  model: config.model,
  case_id: caseData.id,
  runs_per_feature: runsPerFeature,
  crop_expand_factor: config.cropExpandFactor ?? 3,
  pilot: isPilot || undefined,
  records,
  aggregates,
};

const outDir = path.join(expDir, "results");
await mkdir(outDir, { recursive: true });
const ts = startedAt.replace(/[:.]/g, "-");
const base = path.join(outDir, `${ts}-p1-${config.model}`);
await writeFile(`${base}.json`, JSON.stringify(results, null, 2) + "\n");
await writeFile(`${base}.md`, renderMarkdown(results));
console.log(`\nResults written:\n  ${base}.json\n  ${base}.md`);

// ── Aggregation + rendering ────────────────────────────────────────

function summarize(recs, conditions) {
  const out = {};
  for (const cond of conditions) {
    const ok = recs.filter((r) => r.condition === cond.id && r.call1_scores && r.call2_scores);
    if (ok.length === 0) { out[cond.id] = { n: 0 }; continue; }
    const call1IoU = ok.map((r) => r.call1_scores.iou).sort((a, b) => a - b);
    const call2IoU = ok.map((r) => r.call2_scores.iou).sort((a, b) => a - b);
    const call1Off = ok.map((r) => r.call1_scores.center_offset_pct).sort((a, b) => a - b);
    const call2Off = ok.map((r) => r.call2_scores.center_offset_pct).sort((a, b) => a - b);
    const iouDeltas = ok.map((r) => r.iou_delta).filter((x) => x != null).sort((a, b) => a - b);
    const offDeltas = ok.map((r) => r.offset_delta).filter((x) => x != null).sort((a, b) => a - b);
    out[cond.id] = {
      n: ok.length,
      call1_iou_median: median(call1IoU),
      call2_iou_median: median(call2IoU),
      call1_offset_median_pct: median(call1Off),
      call2_offset_median_pct: median(call2Off),
      iou_delta_median: median(iouDeltas),
      offset_delta_median_pp: median(offDeltas),
      iou_improved: ok.filter((r) => r.iou_delta != null && r.iou_delta > 0).length,
      offset_improved: ok.filter((r) => r.offset_delta != null && r.offset_delta < 0).length,
      call2_parse_errors: recs.filter((r) => r.condition === cond.id && !r.call2_scores && !r.call2_error).length,
      call2_api_errors: recs.filter((r) => r.condition === cond.id && r.call2_error).length,
    };
  }
  return out;
}

function median(a) { return a.length ? a[Math.floor(a.length / 2)] : NaN; }
function round3(n) { return Math.round(n * 1000) / 1000; }
function fmt(n) { return typeof n === "number" ? n.toFixed(3) : "—"; }

function renderMarkdown(r) {
  const lines = [];
  lines.push(`# P1 two-pass — ${r.experiment_id}`);
  lines.push(`- Model: \`${r.model}\``);
  lines.push(`- Case: \`${r.case_id}\``);
  lines.push(`- Runs per feature: ${r.runs_per_feature}`);
  lines.push(`- Crop expand factor: ${r.crop_expand_factor}`);
  lines.push(`- Started: ${r.started_at}`);
  if (r.pilot) lines.push(`- Pilot run (subset)`);
  lines.push("");
  lines.push("## Aggregates (per condition)");
  lines.push("");
  lines.push("| condition | n | call1 IoU | call2 IoU | Δ IoU | call1 off | call2 off | Δ off (pp) | IoU↑ | off↑ |");
  lines.push("|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|");
  for (const [cond, a] of Object.entries(r.aggregates)) {
    lines.push(
      `| ${cond} | ${a.n ?? 0} | ${fmt(a.call1_iou_median)} | ${fmt(a.call2_iou_median)} ` +
      `| ${fmt(a.iou_delta_median)} | ${fmt(a.call1_offset_median_pct)} | ${fmt(a.call2_offset_median_pct)} ` +
      `| ${fmt(a.offset_delta_median_pp)} | ${a.iou_improved ?? 0}/${a.n ?? 0} | ${a.offset_improved ?? 0}/${a.n ?? 0} |`
    );
  }
  lines.push("");
  lines.push("## Per-run detail");
  lines.push("");
  lines.push("| feature | cond | run | composited | call1 IoU | call2 IoU | Δ IoU | Δ off (pp) |");
  lines.push("|---|---|--:|--:|--:|--:|--:|--:|");
  for (const rec of r.records) {
    const c1 = rec.call1_scores ?? {}, c2 = rec.call2_scores ?? {};
    lines.push(
      `| ${rec.feature_id} | ${rec.condition} | ${rec.run_idx} | ${rec.composited ? "yes" : "no"} ` +
      `| ${fmt(c1.iou)} | ${fmt(c2.iou)} | ${fmt(rec.iou_delta)} | ${fmt(rec.offset_delta)} |`
    );
  }
  lines.push("");
  return lines.join("\n");
}

function askYesNo(prompt) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}
