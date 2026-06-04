#!/usr/bin/env node
/**
 * test-stats-provenance-plan.mjs — query-plan regression guard for the
 * collection_stats hasProvenance driver optimisation (analogous to the #375 /
 * #349 same-row fix, but in the no-LIMIT collection_stats path).
 *
 * computeCollectionStats builds `CREATE TEMP TABLE _stats AS SELECT a.art_id
 * FROM artworks a WHERE <conds>` then COUNTs it (no LIMIT → no importance-walk
 * early termination). When hasProvenance:true is the SOLE artwork-restricting
 * filter, a correlated EXISTS forces a full 834K-row scan probing the PK per row
 * (~691ms); driving from the ~48K provenance set via `art_id IN (SELECT
 * artwork_id FROM provenance_events)` is ~20× faster. But with any other
 * (possibly rarer) filter present, the correlated EXISTS must be kept — letting
 * that filter drive — because a driving IN would eagerly materialise the 48K set
 * and regress the rare case ~84× (see diagnose-stats-provenance-plan.mjs).
 *
 * Asserts (against the REAL emitted SQL, captured via an instrumented prepare):
 *   1. sole hasProvenance        → drives from provenance_events (no correlated EXISTS,
 *                                    plan does not do a full SCAN a + per-row EXISTS probe)
 *   2. hasProvenance + a vocab filter → KEEPS the correlated EXISTS (no eager provenance IN)
 *   3. hasProvenance + imageAvailable:true  → STILL drives from provenance_events — the
 *                                    image filter (~87.5%) is non-selective and must not
 *                                    disqualify the fast path (the bug this guards)
 *   4. hasProvenance + imageAvailable:false → drives from provenance AND emits has_image = 0
 *   5. imageAvailable:false is a real complement filter in the search path (with + without
 *                                    == all), not the old silent no-op
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import { captureSql, explainPlan } from "./query-plan-utils.mjs";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const VOCAB_DB_PATH = process.env.VOCAB_DB_PATH || path.join(PROJECT_DIR, "data/vocabulary.db");
const { VocabularyDb } = await import(path.join(PROJECT_DIR, "dist/api/VocabularyDb.js"));

const db = new VocabularyDb();
let passed = 0, failed = 0, skipped = 0;

function captureStatsSql(args) {
  // The temp-table build is the only `... FROM artworks a WHERE ...` we restrict on.
  return captureSql(() => db.computeCollectionStats(args))
    .find((s) => /CREATE TEMP TABLE.*FROM artworks a WHERE/s.test(s));
}

// Feature-detect: provenance tables present in this DB?
const probe = captureStatsSql({ dimension: "type", hasProvenance: true });
if (!probe) {
  console.log("  ⚠ skipped — no provenance-filtered temp-table build captured (provenance tables absent or hasProvenance ignored)");
  console.log(`\n${passed} passed, ${skipped + 1} skipped`);
  process.exit(0);
}

const DRIVING_IN = /a\.art_id IN \(SELECT artwork_id FROM provenance_events\)/;
const CORRELATED_EXISTS = /EXISTS \(SELECT 1 FROM provenance_events WHERE artwork_id = a\.art_id\)/;
const HAS_IMAGE_1 = /a\.has_image = 1/;
const HAS_IMAGE_0 = /a\.has_image = 0/;

// ── 1. Sole hasProvenance → driving IN, plan drives from provenance ──
console.log("── 1. hasProvenance as sole filter → drives from provenance_events ──");
{
  const sql = probe;
  const usesDrivingIn = DRIVING_IN.test(sql);
  const usesCorrelated = CORRELATED_EXISTS.test(sql);

  const innerSelect = sql.replace(/^.*?AS\s+/s, "");
  const planText = explainPlan(VOCAB_DB_PATH, innerSelect).map((r) => r.detail).join("\n");
  // Pathology marker: a full artworks scan that probes provenance via correlated EXISTS PK lookup.
  const fullScanProbe = /SCAN a\b/.test(planText) && /provenance_events EXISTS/.test(planText);

  console.log("  Plan:");
  for (const line of planText.split("\n")) console.log(`    ${line}`);

  let ok = true;
  if (!usesDrivingIn) { console.log("  ✗ emitted SQL does not drive from provenance_events (driving IN missing)"); ok = false; }
  if (usesCorrelated) { console.log("  ✗ emitted SQL still uses the correlated EXISTS for the sole-filter case"); ok = false; }
  if (fullScanProbe)  { console.log("  ✗ plan does full SCAN a + per-row provenance EXISTS probe — the slow path is back"); ok = false; }
  if (ok) { console.log("  ✓ sole hasProvenance drives from provenance_events, no full-artworks scan"); passed++; }
  else failed++;
}

// ── 2. hasProvenance + a vocab filter → keep correlated EXISTS (no eager provenance IN) ──
console.log("\n── 2. hasProvenance + creator filter → keeps correlated EXISTS (no rare-case regression) ──");
{
  const sql = captureStatsSql({ dimension: "type", hasProvenance: true, creator: "Rembrandt" });
  if (!sql) {
    console.log("  ⚠ skipped — could not capture co-filter temp-table build");
    skipped++;
  } else {
    const usesDrivingIn = DRIVING_IN.test(sql);
    const usesCorrelated = CORRELATED_EXISTS.test(sql);
    let ok = true;
    if (usesDrivingIn) { console.log("  ✗ emitted SQL eagerly materialises provenance IN despite a co-filter — regresses the rare case"); ok = false; }
    if (!usesCorrelated) { console.log("  ✗ provenance predicate lost in the co-filter case"); ok = false; }
    if (ok) { console.log("  ✓ co-filter present → correlated EXISTS retained (co-filter drives, EXISTS is a PK probe)"); passed++; }
    else failed++;
  }
}

// ── 3. hasProvenance + imageAvailable:true → STILL drives from provenance ──
// The image filter is non-selective (~87.5%), so it must not count as a restricting
// filter that disqualifies the driving-IN fast path. This is the bug the fix targets.
console.log("\n── 3. hasProvenance + imageAvailable:true → driving IN (image filter is non-selective) ──");
{
  const sql = captureStatsSql({ dimension: "type", hasProvenance: true, imageAvailable: true });
  if (!sql) {
    console.log("  ⚠ skipped — could not capture imageAvailable temp-table build");
    skipped++;
  } else {
    let ok = true;
    if (!DRIVING_IN.test(sql)) { console.log("  ✗ does not drive from provenance despite image being the only co-filter"); ok = false; }
    if (CORRELATED_EXISTS.test(sql)) { console.log("  ✗ fell back to correlated EXISTS — image filter wrongly counted as restricting"); ok = false; }
    if (!HAS_IMAGE_1.test(sql)) { console.log("  ✗ image filter (has_image = 1) not applied"); ok = false; }
    if (ok) { console.log("  ✓ drives from provenance_events AND applies has_image = 1"); passed++; }
    else failed++;
  }
}

// ── 4. hasProvenance + imageAvailable:false → driving IN + has_image = 0 ──
console.log("\n── 4. hasProvenance + imageAvailable:false → driving IN + has_image = 0 ──");
{
  const sql = captureStatsSql({ dimension: "type", hasProvenance: true, imageAvailable: false });
  if (!sql) {
    console.log("  ⚠ skipped — could not capture imageAvailable:false temp-table build");
    skipped++;
  } else {
    let ok = true;
    if (!DRIVING_IN.test(sql)) { console.log("  ✗ does not drive from provenance"); ok = false; }
    if (CORRELATED_EXISTS.test(sql)) { console.log("  ✗ fell back to correlated EXISTS"); ok = false; }
    if (!HAS_IMAGE_0.test(sql)) { console.log("  ✗ imageAvailable:false did not emit has_image = 0 (still a no-op?)"); ok = false; }
    if (ok) { console.log("  ✓ drives from provenance_events AND applies has_image = 0"); passed++; }
    else failed++;
  }
}

// ── 5. imageAvailable:false is a real complement filter (search path) ──
console.log("\n── 5. imageAvailable:false partitions a vocab result set (with + without == all) ──");
{
  const all = db.searchCompact({ type: "drawing", maxResults: 1 }).totalResults;
  const withImg = db.searchCompact({ type: "drawing", imageAvailable: true, maxResults: 1 }).totalResults;
  const without = db.searchCompact({ type: "drawing", imageAvailable: false, maxResults: 1 }).totalResults;
  console.log(`  drawings: all=${all?.toLocaleString()} withImage=${withImg?.toLocaleString()} withoutImage=${without?.toLocaleString()}`);
  let ok = true;
  if (!(without > 0)) { console.log("  ✗ imageAvailable:false returned 0 — not filtering"); ok = false; }
  if (withImg + without !== all) { console.log(`  ✗ partition broken: ${withImg} + ${without} != ${all}`); ok = false; }
  if (ok) { console.log("  ✓ with-image + without-image == all (false is a real complement filter)"); passed++; }
  else failed++;
}

console.log(`\n${passed} passed${failed ? `, ${failed} failed` : ""}${skipped ? `, ${skipped} skipped` : ""}`);
process.exit(failed ? 1 : 0);
