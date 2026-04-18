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
});

export const ConditionSchema = z.object({
  id: z.string(),
  promptTemplate: z.function(),
  coordFormat: z.enum(["pct", "crop_pixels"]),
  serverBuild: z.object({ env: z.record(z.string()) }).optional(),
});

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
});

export async function loadCase(caseFile) {
  const mod = await import(pathToFileURL(path.resolve(caseFile)).href);
  const parsed = CaseSchema.parse(mod.default);
  const caseDir = path.dirname(path.resolve(caseFile));
  parsed.groundTruthFile = path.resolve(caseDir, parsed.groundTruthFile);
  return parsed;
}

export async function loadExperiment(configFile) {
  const mod = await import(pathToFileURL(path.resolve(configFile)).href);
  const raw = { ...mod.default };
  if (typeof raw.case === "string") {
    const configDir = path.dirname(path.resolve(configFile));
    raw.case = await loadCase(path.resolve(configDir, raw.case));
  }
  return ExperimentConfigSchema.parse(raw);
}
