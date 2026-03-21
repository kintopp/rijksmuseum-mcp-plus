#!/usr/bin/env node
/**
 * Run all stdio test scripts in scripts/tests/.
 * Skips test-http-viewer-queues.mjs (requires a running HTTP server).
 * Usage: ENABLE_FIND_SIMILAR=true node scripts/tests/run-all.mjs
 */
import { readdirSync } from "fs";
import { execSync } from "child_process";

const SKIP = new Set(["test-http-viewer-queues.mjs", "run-all.mjs"]);

const tests = readdirSync("scripts/tests")
  .filter((f) => f.startsWith("test-") && f.endsWith(".mjs") && !SKIP.has(f))
  .sort();

let failed = 0;
for (const t of tests) {
  console.log(`\n▶ ${t}`);
  try {
    execSync(`node scripts/tests/${t}`, { stdio: "inherit" });
  } catch {
    failed++;
  }
}

console.log(
  failed
    ? `\n✗ ${failed}/${tests.length} suites failed`
    : `\n✓ ${tests.length}/${tests.length} suites passed`,
);
process.exit(failed ? 1 : 0);
