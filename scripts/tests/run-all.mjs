#!/usr/bin/env node
/**
 * Compatibility wrapper for the older "run every stdio-looking test" command.
 *
 * The test directory is a mixed scratchpad. The maintained surface is now
 * scripts/tests/run.mjs + tests.manifest.json, where scratch/manual/deprecated
 * probes are classified explicitly and never run by default.
 */
import { spawnSync } from "node:child_process";

console.error(
  "run-all.mjs is deprecated; using run.mjs (default class=gate) instead. " +
  "Use run.mjs --class gate|smoke|scratch for explicit ownership classes.",
);

const result = spawnSync(
  process.execPath,
  ["scripts/tests/run.mjs", ...process.argv.slice(2)],
  { stdio: "inherit" },
);

process.exit(result.status ?? 1);
