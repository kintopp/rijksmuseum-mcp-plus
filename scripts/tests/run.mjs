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
 * The committed manifest (tests.manifest.json) classifies every test file by:
 *   - category: functional grouping (base, ci, track2, db, live, exploratory)
 *   - class: ownership level (gate, smoke, scratch)
 *   - status: maintenance state (promoted, manual, scratch, deprecated)
 *   - requires: structured prerequisites (dist, vocabDb, network, etc.)
 *
 * Flags:
 *   --class <name>      run files whose manifest class === gate|smoke|scratch
 *   --category <name>   run files whose manifest category === <name>
 *   --status <name>     run files whose manifest status === <name>
 *   --filter <substr>   run only files whose filename contains <substr>
 *   --check-manifest    assert every test-*.mjs on disk has a manifest entry
 *                       (and valid metadata), then exit
 *   (no args)           run the `gate` class. Smoke/scratch scripts are opt-in.
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
let testClass = null;
let status = null;
let filter = null;
let checkManifest = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--class") testClass = argv[++i];
  else if (a.startsWith("--class=")) testClass = a.slice("--class=".length);
  else if (a === "--category") category = argv[++i];
  else if (a.startsWith("--category=")) category = a.slice("--category=".length);
  else if (a === "--status") status = argv[++i];
  else if (a.startsWith("--status=")) status = a.slice("--status=".length);
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

const ALLOWED_CATEGORIES = new Set(["base", "ci", "track2", "db", "live", "exploratory"]);
const ALLOWED_CLASSES = new Set(["gate", "smoke", "scratch"]);
const ALLOWED_STATUSES = new Set(["promoted", "manual", "scratch", "deprecated"]);
const ALLOWED_RUNTIMES = new Set(["node"]);
const ALLOWED_REQUIRES = new Set([
  "apiKey",
  "dist",
  "embeddingsDb",
  "manual",
  "network",
  "server",
  "vocabDb",
]);

function validateSelector(label, value, allowed) {
  if (value && !allowed.has(value)) {
    console.error(`Unknown ${label}: ${value}`);
    console.error(`Allowed ${label}s: ${[...allowed].join(", ")}`);
    process.exit(2);
  }
}

validateSelector("class", testClass, ALLOWED_CLASSES);
validateSelector("category", category, ALLOWED_CATEGORIES);
validateSelector("status", status, ALLOWED_STATUSES);

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
  for (const [file, meta] of Object.entries(manifest)) {
    const problems = [];
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
      problems.push("entry must be an object");
    } else {
      if (!ALLOWED_CATEGORIES.has(meta.category)) problems.push(`invalid category=${meta.category}`);
      if (!ALLOWED_CLASSES.has(meta.class)) problems.push(`invalid class=${meta.class}`);
      if (!ALLOWED_STATUSES.has(meta.status)) problems.push(`invalid status=${meta.status}`);
      if (!ALLOWED_RUNTIMES.has(meta.runtime)) problems.push(`invalid runtime=${meta.runtime}`);
      if (typeof meta.purpose !== "string" || !meta.purpose.trim()) problems.push("purpose must be non-empty");
      if (!Array.isArray(meta.requires)) {
        problems.push("requires must be an array");
      } else {
        for (const req of meta.requires) {
          if (!ALLOWED_REQUIRES.has(req)) problems.push(`invalid requires item=${req}`);
        }
      }
      if (meta.class === "gate" && meta.status !== "promoted") {
        problems.push("gate tests must have status=promoted");
      }
      if (meta.status === "deprecated" && meta.class !== "scratch") {
        problems.push("deprecated tests must have class=scratch");
      }
    }
    if (problems.length) {
      ok = false;
      console.error(`✗ invalid manifest entry for ${file}:`);
      for (const p of problems) console.error(`    ${p}`);
    }
  }
  if (ok) {
    console.log(`✓ manifest in sync: ${onDisk.length} test file(s), each with valid metadata`);
    process.exit(0);
  }
  process.exit(1);
}

// ── Build selection ─────────────────────────────────────────────────────────
if ((category || testClass || status) && !manifest) {
  console.error("✗ class/category/status selectors require a manifest (none found)");
  process.exit(2);
}

let selected = onDisk;
if (manifest) {
  selected = selected.filter((f) => manifest[f]);
  if (category) selected = selected.filter((f) => manifest[f].category === category);
  if (testClass) selected = selected.filter((f) => manifest[f].class === testClass);
  if (status) selected = selected.filter((f) => manifest[f].status === status);
  if (!category && !testClass && !status && !filter) {
    selected = selected.filter((f) => manifest[f].class === "gate");
  }
} else if (!filter) {
  console.error("✗ no manifest found; pass --filter to run an explicit filename subset");
  process.exit(2);
}
if (filter) selected = selected.filter((f) => f.includes(filter));

if (selected.some((f) => manifest?.[f]?.runtime !== "node")) {
  const nonNode = selected.filter((f) => manifest?.[f]?.runtime !== "node");
  for (const f of nonNode) {
    console.error(`✗ ${f} is not a Node test`);
  }
  process.exit(2);
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
