/**
 * P7 replay harness — simulates P7's structured OOB-warning response by replaying
 * prior OOB runs with a synthesized warning and measuring whether the LLM recovers.
 *
 * Approach A from the P2 verdict follow-up:
 *   1. Load a prior results JSON.
 *   2. Filter to records with oob_clamped === true.
 *   3. Re-fetch each unique crop from the MCP server.
 *   4. For each OOB record, build a 3-message conversation (original user prompt
 *      with image → assistant's OOB response → user turn containing a simulated
 *      P7 warning + retry instruction), call Anthropic, parse, score.
 *   5. Compare retry scores against the prior-clamped scores for the same run.
 *
 * Usage:
 *   node scripts/tests/overlay-harness-p7-replay.mjs <prior-results-json> [--yes]
 *
 * Output: {expDir}/results/{ts}-p7-replay-{orig_model}.{json,md}.
 */
import path from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createInterface } from "node:readline";

import Anthropic from "@anthropic-ai/sdk";

import {
  openMcpClient, fetchCrop, loadAnthropicKey, parseLlmCoords,
  cropPixelsToLocalPct,
} from "./overlay-harness-fixed-crop.mjs";
import {
  iou, centerOffsetPct, sizeRatio, projectLocalToFull, clampToImage,
} from "./overlay-scoring.mjs";
import { loadExperiment } from "./overlay-config.mjs";

// ── CLI ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.length === 0 || args.includes("--help")) {
  console.error("usage: overlay-harness-p7-replay.mjs <prior-results-json> [--yes]");
  process.exit(2);
}
const priorPath = path.resolve(args[0]);
const skipConfirm = args.includes("--yes");

// ── Load prior + experiment ──────────────────────────────────────────

const prior = JSON.parse(await readFile(priorPath, "utf8"));
const oobRuns = prior.runs.filter((r) => r.oob_clamped);

if (oobRuns.length === 0) {
  console.error(`No OOB runs in ${priorPath}. Nothing to replay.`);
  process.exit(0);
}

// Find experiment dir relative to the prior results file.
// Layout: {expDir}/results/{ts}-{model}.json  →  expDir is 2 levels up.
const expDir = path.resolve(path.dirname(priorPath), "..");
const experiment = await loadExperiment(path.join(expDir, "config.mjs"));
if (experiment.case.id !== prior.case_id) {
  console.error(`case mismatch: prior.case_id=${prior.case_id} vs experiment.case.id=${experiment.case.id}`);
  process.exit(1);
}
const gt = JSON.parse(await readFile(experiment.case.groundTruthFile, "utf8"));
const featureById = new Map(gt.features.map((f) => [f.id, f]));

// ── Confirm ──────────────────────────────────────────────────────────

const perCall = prior.model.includes("opus") ? 0.05 : 0.008;
console.log(`Replaying ${oobRuns.length} OOB run(s) from ${path.basename(priorPath)}`);
console.log(`  Prior experiment: ${prior.experiment_id} (${prior.model})`);
console.log(`  OOB breakdown:`, countByCondition(oobRuns));
console.log(`  Est. cost: ~$${(oobRuns.length * perCall).toFixed(2)}`);

if (!skipConfirm) {
  const yes = await askYesNo("Proceed? [y/N] ");
  if (!yes) { console.log("aborted."); process.exit(0); }
}

// ── Fetch unique crops once ──────────────────────────────────────────

const anthropic = new Anthropic({ apiKey: await loadAnthropicKey() });
const { client, transport } = await openMcpClient();

const cropByRegion = new Map();
const records = [];
const startedAt = new Date().toISOString();

try {
  const uniqueRegions = [...new Set(oobRuns.map((r) => r.crop_region))];
  for (const region of uniqueRegions) {
    const crop = await fetchCrop(client, experiment.case.objectNumber, region);
    cropByRegion.set(region, crop);
  }

  // ── Replay each OOB record ─────────────────────────────────────────

  for (const oob of oobRuns) {
    const feature = featureById.get(oob.feature_id);
    if (!feature) {
      records.push({ ...oob, replay_error: `no feature with id ${oob.feature_id}` });
      continue;
    }
    const rec = await replayOne({ anthropic, model: prior.model, experiment, oob, feature, crop: cropByRegion.get(oob.crop_region) });
    records.push(rec);
    const s = rec.retry_scores ?? {};
    console.error(`  [${oob.feature_id}] ${oob.condition}#${oob.run_idx} retry: IoU=${fmt(s.iou)} off=${fmt(s.center_offset_pct)} recovered=${rec.recovered}`);
  }
} finally {
  await transport.close();
}

// ── Aggregate + persist ──────────────────────────────────────────────

const aggregate = summarize(records);
const results = {
  experiment_id: prior.experiment_id,
  phase: "p7-replay",
  started_at: startedAt,
  model: prior.model,
  prior_results_file: path.basename(priorPath),
  case_id: prior.case_id,
  total_oob_replayed: records.length,
  aggregate,
  records,
};

const outDir = path.join(expDir, "results");
await mkdir(outDir, { recursive: true });
const ts = startedAt.replace(/[:.]/g, "-");
const base = path.join(outDir, `${ts}-p7-replay-${prior.model}`);
await writeFile(`${base}.json`, JSON.stringify(results, null, 2) + "\n");
await writeFile(`${base}.md`, renderMarkdown(results));
console.log(`\nResults written:\n  ${base}.json\n  ${base}.md`);

// ── Helpers ──────────────────────────────────────────────────────────

async function replayOne({ anthropic, model, experiment, oob, feature, crop }) {
  const condition = experiment.conditions.find((c) => c.id === oob.condition);
  if (!condition) throw new Error(`condition not found in experiment: ${oob.condition}`);

  const origPrompt = condition.promptTemplate({
    feature,
    crop: { width: crop.widthPx, height: crop.heightPx },
  });

  const warning = synthesizeWarning(oob);
  const retryText = buildRetryMessage(warning);

  let response;
  try {
    response = await anthropic.messages.create({
      model,
      max_tokens: 256,
      system: [{ type: "text", text: origPrompt.system, cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: crop.mimeType, data: crop.base64 },
              cache_control: { type: "ephemeral" },
            },
            { type: "text", text: origPrompt.user },
          ],
        },
        { role: "assistant", content: oob.llm_raw ?? "" },
        { role: "user", content: retryText },
      ],
    });
  } catch (err) {
    return { prior_ref: priorRef(oob), replay_error: err?.message ?? String(err) };
  }

  const retryRaw = response.content.find((b) => b.type === "text")?.text ?? "";
  const parsed = parseLlmCoords(retryRaw);

  const crop_px_size = { width: crop.widthPx, height: crop.heightPx };
  const [cx, cy, cw, ch] = parseCropRegion(oob.crop_region);
  const regionBbox = [cx, cy, cw, ch];

  let retryLocal, retryFull, retryFullClamped, retryOob, retryScores;
  let parseErr = null;
  if (!parsed) {
    parseErr = "parse_error";
  } else {
    retryLocal = parsed.format === "pct" ? parsed.bbox : cropPixelsToLocalPct(parsed.bbox, crop_px_size);
    retryFull = projectLocalToFull(retryLocal, regionBbox);
    const clampResult = clampToImage(retryFull, 100);
    retryOob = clampResult.clamped;
    retryFullClamped = clampResult.bbox;
    retryScores = {
      iou: iou(retryFullClamped, oob.ground_truth_pct),
      center_offset_pct: centerOffsetPct(retryFullClamped, oob.ground_truth_pct, oob.image_aspect ?? 1),
      size_ratio: sizeRatio(retryFullClamped, oob.ground_truth_pct),
    };
  }

  const priorScores = oob.scores ?? {};
  return {
    prior_ref: priorRef(oob),
    feature_id: oob.feature_id,
    feature_label: oob.feature_label,
    condition: oob.condition,
    run_idx: oob.run_idx,
    warning,
    retry_raw: retryRaw,
    retry_local: retryLocal,
    retry_full_pct: retryFull,
    retry_full_pct_clamped: retryFullClamped,
    retry_oob_clamped: retryOob ?? null,
    retry_scores: retryScores,
    retry_parse_error: parseErr,
    prior_scores: priorScores,
    recovered: retryScores != null && !retryOob,
    iou_delta: retryScores && priorScores.iou != null ? round3(retryScores.iou - priorScores.iou) : null,
    offset_delta: retryScores && priorScores.center_offset_pct != null
      ? round3(retryScores.center_offset_pct - priorScores.center_offset_pct)
      : null,
    usage: response.usage,
  };
}

function synthesizeWarning(oob) {
  // Identify offending value(s) from the requested pct string.
  const requested = extractRequestedRegion(oob.llm_raw);
  const reqVals = requested ? parseRegionValues(requested) : null;
  const oobAxes = reqVals ? namedOob(reqVals, requested) : "value(s) outside 0–100";
  return {
    warning: "overlay_region_out_of_bounds",
    details: {
      requested,
      clamped_to: oob.predicted_full_pct_clamped
        ? `pct:${oob.predicted_full_pct_clamped.map(round2).join(",")}`
        : null,
      issue: oobAxes,
      valid_range: "each value must be between 0 and 100",
    },
  };
}

function buildRetryMessage(warning) {
  return (
    "The system returned this warning in response to your previous bounding box:\n\n" +
    JSON.stringify(warning, null, 2) +
    "\n\nYour prior coordinates fall outside the 0–100 percent range, and the system has silently clamped them, which likely distorted the box. " +
    "Please re-examine the image and return a corrected bounding box in the same JSON format as before. " +
    "Every coordinate must be between 0 and 100."
  );
}

function extractRequestedRegion(raw) {
  if (!raw) return null;
  const m = raw.match(/"region"\s*:\s*"([^"]+)"/);
  return m ? m[1] : null;
}

function parseRegionValues(regionStr) {
  const m = regionStr.match(/(?:pct|crop_pixels):\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)/);
  return m ? m.slice(1, 5).map(Number) : null;
}

function namedOob(vals, originalStr) {
  const labels = ["x", "y", "w", "h"];
  const flagged = vals
    .map((v, i) => (v < 0 || v > 100 ? `${labels[i]}=${v}` : null))
    .filter(Boolean);
  if (flagged.length === 0) {
    // Sometimes the projected result is OOB even if the LLM's raw local values
    // look fine. Fall back to a generic description.
    return `region ${originalStr} falls outside the valid 0–100 range after projection`;
  }
  return `${flagged.join(", ")} outside 0–100`;
}

function parseCropRegion(regionStr) {
  const m = regionStr.match(/^pct:([0-9.]+),([0-9.]+),([0-9.]+),([0-9.]+)$/);
  if (!m) throw new Error(`unparseable crop region: ${regionStr}`);
  return m.slice(1, 5).map(Number);
}

function priorRef(oob) {
  return `${oob.feature_id}/${oob.condition}/${oob.run_idx}`;
}

function countByCondition(runs) {
  const byCond = {};
  for (const r of runs) byCond[r.condition] = (byCond[r.condition] ?? 0) + 1;
  return byCond;
}

function summarize(records) {
  const ok = records.filter((r) => r.retry_scores);
  if (ok.length === 0) return { n: 0 };
  const recovered = records.filter((r) => r.recovered).length;
  const parseErrs = records.filter((r) => r.retry_parse_error).length;
  const retryStillOob = records.filter((r) => r.retry_oob_clamped).length;

  const iouImproved = ok.filter((r) => r.iou_delta != null && r.iou_delta > 0).length;
  const offsetImproved = ok.filter((r) => r.offset_delta != null && r.offset_delta < 0).length;

  const iouVals = ok.map((r) => r.retry_scores.iou).sort((a, b) => a - b);
  const offVals = ok.map((r) => r.retry_scores.center_offset_pct).sort((a, b) => a - b);
  const iouDeltas = ok.map((r) => r.iou_delta).filter((x) => x != null).sort((a, b) => a - b);
  const offDeltas = ok.map((r) => r.offset_delta).filter((x) => x != null).sort((a, b) => a - b);

  return {
    n: records.length,
    retry_scored: ok.length,
    retry_parse_errors: parseErrs,
    retry_still_oob: retryStillOob,
    recovery_rate: recovered / records.length,
    retry_iou_median: median(iouVals),
    retry_offset_median_pct: median(offVals),
    iou_improved_count: iouImproved,
    offset_improved_count: offsetImproved,
    iou_delta_median: iouDeltas.length ? median(iouDeltas) : null,
    offset_delta_median_pct: offDeltas.length ? median(offDeltas) : null,
  };
}

function median(a) { return a.length ? a[Math.floor(a.length / 2)] : NaN; }
function round2(n) { return Math.round(n * 100) / 100; }
function round3(n) { return Math.round(n * 1000) / 1000; }
function fmt(n) { return typeof n === "number" ? n.toFixed(3) : "—"; }

function renderMarkdown(r) {
  const a = r.aggregate;
  const lines = [];
  lines.push(`# P7 Replay — ${r.experiment_id}`);
  lines.push(`- Prior results: \`${r.prior_results_file}\``);
  lines.push(`- Model: \`${r.model}\``);
  lines.push(`- OOB runs replayed: ${r.total_oob_replayed}`);
  lines.push(`- Started: ${r.started_at}`);
  lines.push("");
  lines.push("## Aggregate");
  lines.push("");
  lines.push("| metric | value |");
  lines.push("|---|---:|");
  lines.push(`| retry scored | ${a.retry_scored ?? 0} / ${r.total_oob_replayed} |`);
  lines.push(`| retry still OOB | ${a.retry_still_oob ?? 0} |`);
  lines.push(`| retry parse errors | ${a.retry_parse_errors ?? 0} |`);
  lines.push(`| recovery rate (in-bounds, scorable) | ${a.recovery_rate != null ? (a.recovery_rate * 100).toFixed(1) + "%" : "—"} |`);
  lines.push(`| retry IoU median | ${fmt(a.retry_iou_median)} |`);
  lines.push(`| retry center-offset median (%) | ${fmt(a.retry_offset_median_pct)} |`);
  lines.push(`| IoU improved (count) | ${a.iou_improved_count ?? 0} / ${a.retry_scored ?? 0} |`);
  lines.push(`| offset improved (count) | ${a.offset_improved_count ?? 0} / ${a.retry_scored ?? 0} |`);
  lines.push(`| IoU delta median | ${fmt(a.iou_delta_median)} |`);
  lines.push(`| offset delta median (pp) | ${fmt(a.offset_delta_median_pct)} |`);
  lines.push("");
  lines.push("## Per-run detail");
  lines.push("");
  lines.push("| ref | prior raw | retry raw | prior IoU→retry IoU | prior off→retry off | recovered |");
  lines.push("|---|---|---|---|---|---|");
  for (const rec of r.records) {
    const prs = rec.prior_scores ?? {};
    const rts = rec.retry_scores ?? {};
    lines.push(
      `| ${rec.prior_ref} | \`${(rec.warning?.details?.requested ?? "?").replace(/\|/g, "\\|")}\` ` +
      `| \`${((rec.retry_raw ?? "").slice(0, 40).replace(/\|/g, "\\|")) || "?"}\` ` +
      `| ${fmt(prs.iou)} → ${fmt(rts.iou)} | ${fmt(prs.center_offset_pct)} → ${fmt(rts.center_offset_pct)} | ${rec.recovered ? "yes" : "no"} |`
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
