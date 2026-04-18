/**
 * Zod schemas + loaders for experiment configs and cases.
 */
import { z } from "zod";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const CaseSchema = z.object({
  id: z.string(),
  objectNumber: z.string(),
  groundTruthFile: z.string(),
  description: z.string().optional(),
}).strict();

export const ConditionSchema = z.object({
  id: z.string(),
  promptTemplate: z.function(),
  coordFormat: z.enum(["pct", "crop_pixels"]),
  serverBuild: z.object({ env: z.record(z.string()) }).optional(),
}).strict();

export const ExperimentConfigSchema = z.object({
  id: z.string(),
  harness: z.enum(["fixed-crop", "agentic"]),
  case: CaseSchema,
  model: z.string().default("claude-sonnet-4-6"),
  runsPerCondition: z.number().int().positive().default(5),
  cropExpandFactor: z.number().positive().default(3),
  conditions: z.array(ConditionSchema).min(2),
  scoring: z.object({
    metrics: z.array(z.enum(["iou", "center_offset_pct", "size_ratio"]))
      .default(["iou", "center_offset_pct", "size_ratio"]),
  }).default({ metrics: ["iou", "center_offset_pct", "size_ratio"] }),
  expected: z.object({
    hypothesis: z.string(),
    thresholds: z.array(z.object({
      // size_ratio is a diagnostic metric only — not eligible as a win/loss threshold.
      metric: z.enum(["median_iou", "median_center_offset_pct"]),
      min_delta: z.number().optional(),
      max_delta: z.number().optional(),
    })),
    verdict: z.enum(["either_threshold", "all_thresholds"]).default("either_threshold"),
  }).nullable().default(null),
  pilot: z.object({
    features: z.number().int().positive().default(3),
    runsPerCondition: z.number().int().positive().default(3),
  }).optional(),
}).strict();

export async function loadCase(caseFile) {
  const resolved = path.resolve(caseFile);
  let mod;
  try {
    mod = await import(pathToFileURL(resolved).href);
  } catch (err) {
    throw new Error(`loadCase: cannot load "${resolved}": ${err.message}`);
  }
  const raw = CaseSchema.parse(mod.default);
  const caseDir = path.dirname(resolved);
  return { ...raw, groundTruthFile: path.resolve(caseDir, raw.groundTruthFile) };
}

export async function loadExperiment(configFile) {
  const resolved = path.resolve(configFile);
  let mod;
  try {
    mod = await import(pathToFileURL(resolved).href);
  } catch (err) {
    throw new Error(`loadExperiment: cannot load "${resolved}": ${err.message}`);
  }
  const raw = { ...mod.default };
  if (typeof raw.case === "string") {
    const configDir = path.dirname(resolved);
    raw.case = await loadCase(path.resolve(configDir, raw.case));
  }
  return ExperimentConfigSchema.parse(raw);
}
