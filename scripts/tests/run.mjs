#!/usr/bin/env node
/**
 * Thin concurrent test runner over the standalone scripts/tests/test-*.mjs suite.
 *
 * The suite is a set of standalone Node scripts, each ending with
 *   process.exit(failed > 0 ? 1 : 0)
 * so the EXIT CODE is the single source of truth for pass/fail. This runner does
 * NOT parse test output — it spawns each selected script as a child process,
 * reads its exit code, runs them with bounded concurrency, and prints an
 * aggregate `PASS X / FAIL Y of Z` tally. It edits no test file.
 *
 * The committed manifest (tests.manifest.json) categorizes every test file and
 * documents what each one needs (DBs, network, etc.). It does NOT replace the
 * hand-maintained `&&` chains in package.json — it is purely additive tooling.
 *
 * Flags:
 *   --category <name>   run only files whose manifest category === <name>
 *   --filter <substr>   run only files whose filename contains <substr>
 *   --check-manifest    assert every test-*.mjs on disk has a manifest entry
 *                       (and no entry points at a missing file), then exit
 *   (no args)           run the `ci` category (hermetic; falls back to globbing
 *                       all test-*.mjs if the manifest is absent)
 *
 * Dependency-free: node:child_process / node:fs / node:os / node:path / node:url.
 */
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url)); // scripts/tests
const REPO_ROOT = path.resolve(TESTS_DIR, "..", "..");
const MANIFEST_PATH = path.join(TESTS_DIR, "tests.manifest.json");

// ── Parse args ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
let category = null;
let filter = null;
let checkManifest = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--category") category = argv[++i];
  else if (a.startsWith("--category=")) category = a.slice("--category=".length);
  else if (a === "--filter") filter = argv[++i];
  else if (a.startsWith("--filter=")) filter = a.slice("--filter=".length);
  else if (a === "--check-manifest") checkManifest = true;
  else {
    console.error(`Unknown argument: ${a}`);
    process.exit(2);
  }
}

// ── Discover + load ─────────────────────────────────────────────────────────
function discoverTestFiles() {
  return readdirSync(TESTS_DIR)
    .filter((f) => /^test-.*\.mjs$/.test(f))
    .sort();
}

function loadManifest() {
  if (!existsSync(MANIFEST_PATH)) return null;
  try {
    return JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  } catch (e) {
    console.error(`Failed to parse ${MANIFEST_PATH}: ${e.message}`);
    process.exit(2);
  }
}

const onDisk = discoverTestFiles();
const manifest = loadManifest();

// ── --check-manifest ────────────────────────────────────────────────────────
if (checkManifest) {
  if (!manifest) {
    console.error(`✗ no manifest found at ${MANIFEST_PATH}`);
    process.exit(1);
  }
  const entries = Object.keys(manifest);
  const onDiskSet = new Set(onDisk);
  const entrySet = new Set(entries);
  const missingEntry = onDisk.filter((f) => !entrySet.has(f)); // on disk, no entry
  const danglingEntry = entries.filter((f) => !onDiskSet.has(f)); // entry, no file
  let ok = true;
  if (missingEntry.length) {
    ok = false;
    console.error(`✗ ${missingEntry.length} test file(s) on disk have no manifest entry:`);
    for (const f of missingEntry) console.error(`    ${f}`);
  }
  if (danglingEntry.length) {
    ok = false;
    console.error(`✗ ${danglingEntry.length} manifest entr(y/ies) point at a missing file:`);
    for (const f of danglingEntry) console.error(`    ${f}`);
  }
  if (ok) {
    console.log(`✓ manifest in sync: ${onDisk.length} test file(s), each with an entry`);
    process.exit(0);
  }
  process.exit(1);
}

// ── Build selection ─────────────────────────────────────────────────────────
let selected;
if (filter) {
  selected = onDisk.filter((f) => f.includes(filter));
} else if (category) {
  if (!manifest) {
    console.error("✗ --category requires a manifest (none found)");
    process.exit(2);
  }
  selected = onDisk.filter((f) => manifest[f] && manifest[f].category === category);
} else {
  // no args → ci category (or glob everything if no manifest is present)
  selected = manifest
    ? onDisk.filter((f) => manifest[f] && manifest[f].category === "ci")
    : onDisk;
}

if (selected.length === 0) {
  console.error("No test files matched the selection.");
  process.exit(2);
}

// ── Run with bounded concurrency ────────────────────────────────────────────
const N = Math.max(1, Math.min(4, os.cpus().length - 1));

function runOne(file) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const full = path.join(TESTS_DIR, file);
    const child = spawn(process.execPath, [full], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: REPO_ROOT,
    });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("error", (err) => {
      console.log(`\n──── FAIL ${file} (spawn error: ${err.message}) ────`);
      resolve({ file, exitCode: 1, ms: Date.now() - t0 });
    });
    child.on("close", (code) => {
      const ms = Date.now() - t0;
      const exitCode = code ?? 1;
      const tag = exitCode === 0 ? "PASS" : "FAIL";
      console.log(`\n──── ${tag} ${file} (${ms} ms, exit ${exitCode}) ────`);
      if (out.trim()) process.stdout.write(out.endsWith("\n") ? out : `${out}\n`);
      resolve({ file, exitCode, ms });
    });
  });
}

const results = [];
let idx = 0;
async function worker() {
  while (idx < selected.length) {
    const file = selected[idx++];
    results.push(await runOne(file));
  }
}

console.log(`Running ${selected.length} test file(s) with concurrency ${N}…`);

const workers = [];
for (let i = 0; i < Math.min(N, selected.length); i++) workers.push(worker());
await Promise.all(workers);

// ── Aggregate summary ───────────────────────────────────────────────────────
results.sort((a, b) => a.file.localeCompare(b.file));
const failures = results.filter((r) => r.exitCode !== 0);
const passed = results.length - failures.length;

console.log("\n════════ summary ════════");
for (const r of results) {
  const tag = r.exitCode === 0 ? "PASS" : "FAIL";
  console.log(`  ${tag}  ${r.file}  (${r.ms} ms, exit ${r.exitCode})`);
}
console.log(`\nPASS ${passed} / FAIL ${failures.length} of ${results.length}`);
if (failures.length) {
  console.log("Failures:");
  for (const r of failures) console.log(`  - ${r.file} (exit ${r.exitCode})`);
}
process.exit(failures.length > 0 ? 1 : 0);
