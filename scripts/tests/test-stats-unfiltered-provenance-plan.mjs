#!/usr/bin/env node
/**
 * test-stats-unfiltered-provenance-plan.mjs — query-plan regression guard for the
 * #378 REC #2 fix: unfiltered collection_stats provenance dimensions must NOT
 * wrap their WHERE in `artwork_id IN (SELECT art_id FROM _stats_artworks)`.
 *
 * When collection_stats has no artwork filters, `_stats_artworks` is a view over
 * ALL 834K artworks, so the membership is a no-op — but it makes SQLite probe the
 * 101K-row provenance table by artwork_id per row instead of scanning it directly.
 * Dropping it changed raw transferType dimension/coverage from ~1.3-1.4s to ~30ms
 * (36-47×). With ANY artwork filter present the membership is a real restriction
 * and MUST be retained (that's what _stats_artworks is for).
 *
 * Asserts (against the REAL emitted SQL, captured via an instrumented prepare):
 *   1. unfiltered transferType dimension → no _stats_artworks membership; plan
 *      SCANs provenance (idx_prov_transfer), not a per-artwork PRIMARY KEY probe.
 *   2. unfiltered transferType coverage  → same.
 *   3. unfiltered provenanceDecade dim   → no membership (the special arithmetic branch).
 *   4. FILTERED transferType (creationDateFrom) → membership RETAINED (no regression).
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import { captureSql, explainPlan } from "./query-plan-utils.mjs";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const VOCAB_DB_PATH = process.env.VOCAB_DB_PATH || path.join(PROJECT_DIR, "data/vocabulary.db");
const { VocabularyDb } = await import(path.join(PROJECT_DIR, "dist/api/VocabularyDb.js"));

const db = new VocabularyDb();
let passed = 0, failed = 0, skipped = 0;

const MEMBERSHIP = /_stats_artworks/;
const PK_PROBE = /PRIMARY KEY \(artwork_id/;
// `pe` is always the provenance_events alias here; a direct SCAN/SEARCH of it (or its
// idx_prov_* covering index) is the good plan. The PK-probe pathology is caught separately.
const SCANS_PROV = /\b(SCAN|SEARCH) pe\b|idx_prov/i;

/** All SQL strings computeCollectionStats prepares for the given args. */
function captureStatsSqls(args) {
  return captureSql(() => db.computeCollectionStats(args));
}
/** The provenance DIMENSION query: grouped, aliased `AS label`. */
const findDimSql = (sqls) =>
  sqls.find((s) => /FROM provenance_events pe/.test(s) && /AS label/.test(s) && /GROUP BY/.test(s));
/** The provenance COVERAGE query: bare COUNT(DISTINCT ...), no GROUP BY. */
const findCoverageSql = (sqls) =>
  sqls.find((s) => /SELECT COUNT\(DISTINCT pe\.artwork_id\) AS cnt\s+FROM provenance_events pe/.test(s) && !/GROUP BY/.test(s));

// Feature-detect: provenance tables present in this DB?
const probe = captureStatsSqls({ dimension: "transferType" });
if (!findDimSql(probe)) {
  console.log("  ⚠ skipped — no provenance dimension SQL captured (provenance tables absent?)");
  console.log(`\n${passed} passed, ${skipped + 1} skipped`);
  process.exit(0);
}

function checkUnfilteredScan(label, sql) {
  if (!sql) { console.log(`  ⚠ ${label}: could not capture SQL`); skipped++; return; }
  const plan = explainPlan(VOCAB_DB_PATH, sql).map((r) => r.detail).join("\n");
  let ok = true;
  if (MEMBERSHIP.test(sql)) { console.log(`  ✗ ${label}: still references _stats_artworks (membership not dropped)`); ok = false; }
  if (PK_PROBE.test(plan)) { console.log(`  ✗ ${label}: plan probes PRIMARY KEY (artwork_id=?) per row — slow path back`); ok = false; }
  if (!SCANS_PROV.test(plan)) { console.log(`  ✗ ${label}: plan does not scan provenance_events`); ok = false; }
  if (ok) {
    console.log(`  ✓ ${label}: no membership, scans provenance directly`);
    for (const line of plan.split("\n")) console.log(`      ${line}`);
    passed++;
  } else {
    for (const line of plan.split("\n")) console.log(`      ${line}`);
    failed++;
  }
}

console.log("── 1+2. unfiltered transferType → dimension + coverage scan provenance directly ──");
{
  const sqls = captureStatsSqls({ dimension: "transferType" });
  checkUnfilteredScan("transferType dimension", findDimSql(sqls));
  checkUnfilteredScan("transferType coverage", findCoverageSql(sqls));
}

console.log("\n── 3. unfiltered provenanceDecade → dimension drops membership ──");
{
  const sqls = captureStatsSqls({ dimension: "provenanceDecade" });
  const dim = sqls.find((s) => /FROM provenance_events pe/.test(s) && /date_year/.test(s) && /GROUP BY/.test(s));
  if (!dim) { console.log("  ⚠ skipped — no provenanceDecade dimension SQL captured"); skipped++; }
  else if (MEMBERSHIP.test(dim)) { console.log("  ✗ provenanceDecade dimension still references _stats_artworks"); failed++; }
  else { console.log("  ✓ provenanceDecade dimension has no _stats_artworks membership"); passed++; }
}

console.log("\n── 4. FILTERED transferType (creationDateFrom:1600) → membership RETAINED ──");
{
  const sqls = captureStatsSqls({ dimension: "transferType", creationDateFrom: 1600 });
  const dim = findDimSql(sqls);
  const cov = findCoverageSql(sqls);
  let ok = true;
  if (!dim || !MEMBERSHIP.test(dim)) { console.log("  ✗ filtered dimension dropped _stats_artworks membership — would ignore the filter"); ok = false; }
  if (!cov || !MEMBERSHIP.test(cov)) { console.log("  ✗ filtered coverage dropped _stats_artworks membership"); ok = false; }
  if (ok) { console.log("  ✓ filter present → membership retained on both dimension and coverage"); passed++; }
  else failed++;
}

console.log(`\n${passed} passed${failed ? `, ${failed} failed` : ""}${skipped ? `, ${skipped} skipped` : ""}`);
process.exit(failed ? 1 : 0);
