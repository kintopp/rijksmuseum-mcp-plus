/**
 * Pre-flight check for POST-REPARSE-STEPS: verify all expected audit files
 * exist, are NOT dry-runs, and contain collected results.
 *
 * Run this BEFORE any writeback to avoid silent failures from stale dry-run
 * artifacts (see 2026-04-19 incident — three Step 7 audit JSONs were dry-runs
 * with meta.dryRun=true and zero results, causing obscure TypeError crashes
 * when writeback scripts tried to iterate data.results).
 *
 * Exit codes:
 *   0 — all audits present and valid
 *   1 — one or more audits missing, dry-run only, or empty
 *
 * Usage:
 *   node scripts/verify-audit-files.mjs
 *   node scripts/verify-audit-files.mjs --manifest PATH  (use custom manifest)
 *   node scripts/verify-audit-files.mjs --audit-dir data/audit
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const auditDirIdx = args.indexOf("--audit-dir");
const auditDir = auditDirIdx >= 0 ? args[auditDirIdx + 1] : "data/audit";

// ─── Expected audit files (name → purpose) ──────────────────────────
// Keys are the filenames POST-REPARSE-STEPS.md expects. Edit here when new
// audits are added to the workflow.
const REQUIRED = [
  { file: "audit-type-classification-2026-03-22.json",
    purpose: "Step 1a — Type classifications for unknown events" },
  { file: "audit-position-enrichment-r1.json",
    purpose: "Step 1c — Position enrichment R1 (258 parties)" },
  { file: "audit-position-enrichment-r2.json",
    purpose: "Step 1d — Position enrichment R2 (12 parties)" },
  { file: "audit-party-disambiguation-r1.json",
    purpose: "Step 1e — Party disambiguation R1 (213 items)" },
  { file: "audit-party-disambiguation-r2.json",
    purpose: "Step 1f — Party disambiguation R2 (154 items)" },
];

// Optional audits — warn if missing/invalid but don't fail.
const OPTIONAL = [
  { file: "audit-party-disambiguation-v0.24-128residuals-2026-04-19.json",
    purpose: "v0.24 post-reparse: 128 long-phrase residuals disambiguation" },
  { file: "audit-field-correction-v0.24-2026-04-19.json",
    purpose: "Step 7a — Field corrections (#149 truncated, #119 wrong, #116 missing receivers)" },
  { file: "audit-event-reclassification-v0.24-2026-04-19.json",
    purpose: "Step 7b — Event reclassifications (#87 phantoms, #103 alternatives, #104 location-as-event)" },
  { file: "audit-event-splitting-v0.24-2026-04-19.json",
    purpose: "Step 7c — Event splitting (#99 gap-bridge, #117 bequest chain, #125 multi-transfer, #102 catalogue)" },
];

// ─── Checker ────────────────────────────────────────────────────────

function check(entry, required) {
  const fullPath = path.join(auditDir, entry.file);
  const status = { ...entry, path: fullPath, required };

  if (!existsSync(fullPath)) {
    status.ok = false;
    status.reason = "MISSING (file does not exist)";
    return status;
  }

  let data;
  try {
    data = JSON.parse(readFileSync(fullPath, "utf-8"));
  } catch (e) {
    status.ok = false;
    status.reason = `INVALID JSON: ${e.message}`;
    return status;
  }

  if (data?.meta?.dryRun === true) {
    status.ok = false;
    status.reason = "DRY RUN (meta.dryRun === true — never submitted as a real batch)";
    return status;
  }

  const results = data?.results;
  if (!Array.isArray(results)) {
    status.ok = false;
    status.reason = `NO RESULTS (results field is ${typeof results}, expected array)`;
    return status;
  }

  if (results.length === 0) {
    status.ok = false;
    status.reason = "EMPTY RESULTS (results array is []; batch not collected?)";
    return status;
  }

  status.ok = true;
  status.recordCount = results.length;
  status.batchId = data?.meta?.batchId;
  status.model = data?.meta?.model;
  status.createdAt = data?.meta?.createdAt;
  return status;
}

// ─── Run ────────────────────────────────────────────────────────────

console.log(`Audit file pre-flight (dir: ${auditDir})\n`);

let hardFailures = 0;
let softFailures = 0;

function print(report, label) {
  console.log(`── ${label} ──`);
  for (const r of report) {
    const sym = r.ok ? "✓" : "✗";
    const tail = r.ok
      ? `[${r.recordCount} records, batch ${r.batchId || "—"}, ${r.model || "—"}]`
      : r.reason;
    console.log(`  ${sym} ${r.file}`);
    console.log(`      purpose: ${r.purpose}`);
    console.log(`      status:  ${tail}`);
  }
  console.log();
}

const reqReport = REQUIRED.map(e => check(e, true));
const optReport = OPTIONAL.map(e => check(e, false));

print(reqReport, "Required");
print(optReport, "Optional (warn-only)");

for (const r of reqReport) if (!r.ok) hardFailures++;
for (const r of optReport) if (!r.ok) softFailures++;

console.log(`Required failures: ${hardFailures}`);
console.log(`Optional failures: ${softFailures}`);

if (hardFailures > 0) {
  console.error(`\nFAIL — ${hardFailures} required audit file(s) missing, dry-run, or empty.`);
  console.error(`Fix before running POST-REPARSE-STEPS writebacks.`);
  process.exit(1);
}

console.log(`\nPASS — all required audit files valid.`);
process.exit(0);
