#!/usr/bin/env node
/**
 * Entrypoint CLI for the overlay-accuracy harness.
 *
 * Usage:
 *   node scripts/tests/overlay-run.mjs <experiment-dir> [--pilot] [--yes] [--model X]
 *
 * The <experiment-dir> must contain a config.mjs.
 */
import path from "node:path";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";

import { loadExperiment } from "./overlay-config.mjs";
import { runFixedCropHarness, writeResults } from "./overlay-harness-fixed-crop.mjs";

const args = process.argv.slice(2);
if (args.length === 0 || args.includes("--help")) {
  console.error("usage: overlay-run.mjs <experiment-dir> [--pilot] [--yes] [--model MODEL]");
  process.exit(2);
}
const expDir = path.resolve(args[0]);
const isPilot = args.includes("--pilot");
const skipConfirm = args.includes("--yes");
const modelFlag = (() => {
  const i = args.indexOf("--model");
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : null;
})();

const experiment = await loadExperiment(path.join(expDir, "config.mjs"));
if (modelFlag) experiment.model = modelFlag;

const gt = JSON.parse(await readFile(experiment.case.groundTruthFile, "utf8"));
const labeledFeatures = gt.features.filter((f) => f.label);

let featureSubset = null;
let runsOverride = null;
if (isPilot) {
  const n = experiment.pilot?.features ?? 3;
  featureSubset = labeledFeatures.slice(0, n);
  runsOverride = experiment.pilot?.runsPerCondition ?? 3;
}

const featureCount = (featureSubset ?? labeledFeatures).length;
const totalCalls = featureCount * experiment.conditions.length * (runsOverride ?? experiment.runsPerCondition);
const estCost = estimateCost(experiment.model, totalCalls);

console.log(`Experiment: ${experiment.id}${isPilot ? " (PILOT)" : ""}`);
console.log(`  Model: ${experiment.model}`);
console.log(`  Features: ${featureCount}${isPilot ? " (pilot subset)" : ""} | Conditions: ${experiment.conditions.length} | Runs/cond: ${runsOverride ?? experiment.runsPerCondition}`);
console.log(`  Total API calls: ${totalCalls}  Est. cost: ~$${estCost.toFixed(2)}`);

if (!skipConfirm) {
  const yes = await askYesNo("Proceed? [y/N] ");
  if (!yes) { console.log("aborted."); process.exit(0); }
}

const results = await runFixedCropHarness({
  experiment, groundTruth: gt, featureSubset, runsOverride,
  onProgress: (evt) => {
    if (evt.phase === "run-done") {
      const s = evt.rec.scores ?? {};
      console.error(`  [${evt.rec.feature_label ?? evt.rec.feature_id}] ${evt.rec.condition}#${evt.rec.run_idx} IoU=${fmt(s.iou)} off=${fmt(s.center_offset_pct)}`);
    }
  },
});
if (isPilot) results.pilot = true;

const outDir = path.join(expDir, "results");
const paths = await writeResults(outDir, results);
console.log(`\nResults written:\n  ${paths.json}\n  ${paths.md}`);

function fmt(n) { return typeof n === "number" ? n.toFixed(3) : "—"; }

function askYesNo(prompt) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

function estimateCost(model, nCalls) {
  const perCall = model.includes("opus") ? 0.05 : 0.008;   // rough USD per call
  return perCall * nCalls;
}
