#!/usr/bin/env node
/**
 * test-stats-field-shape-plan.mjs — query-plan regression guard for #378 Step 3:
 * collection_stats vocab dimensions (+ coverage) must pick the right mappings-field
 * access shape by candidate-set size (STATS_INDEX_THRESHOLD = 50_000):
 *
 *   - unfiltered / broad (>= threshold) → `INDEXED BY idx_mappings_field_vocab` +
 *     plain `m.field_id = ?`, so the field's covering index drives (type 7.2s→2.4s,
 *     productionPlace 5.8s→1.1s). Unfiltered also drops the no-op _stats_artworks membership.
 *   - narrow filtered (< threshold) → keeps `+m.field_id` (PK-probe driven from the small
 *     _stats_artworks set), which wins by up to ~250× for small candidate sets.
 *
 * A blanket swap to the indexed shape would regress every narrow-filtered stats call, so
 * this guards all three regimes (the heuristic must not be "cleaned up" into a constant).
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import { captureSql, explainPlan } from "./query-plan-utils.mjs";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const VOCAB_DB_PATH = process.env.VOCAB_DB_PATH || path.join(PROJECT_DIR, "data/vocabulary.db");
const { VocabularyDb } = await import(path.join(PROJECT_DIR, "dist/api/VocabularyDb.js"));

const db = new VocabularyDb();
let passed = 0, failed = 0, skipped = 0;

const INDEXED = /INDEXED BY idx_mappings_field_vocab/;
const PLUS_PK = /\+m\.field_id/;
const MEMBERSHIP = /_stats_artworks/;

/** Capture computeCollectionStats SQLs, return {dim, cov} mappings-field statements. */
function shapes(args) {
  const sqls = captureSql(() => db.computeCollectionStats(args));
  return {
    dim: sqls.find(s => /FROM mappings m/.test(s) && /AS label/.test(s) && /GROUP BY/.test(s)),
    cov: sqls.find(s => /SELECT COUNT\(DISTINCT m\.artwork_id\) AS cnt FROM mappings m/.test(s) && !/GROUP BY/.test(s)),
  };
}

// Feature-detect: mappings-backed dim SQL emitted?
if (!shapes({ dimension: "type" }).dim) {
  console.log("  ⚠ skipped — no mappings dimension SQL captured");
  console.log(`\n${passed} passed, ${skipped + 1} skipped`);
  process.exit(0);
}

console.log("── 1. unfiltered type → indexed, no membership, covering-index plan ──");
{
  const { dim, cov } = shapes({ dimension: "type" });
  const plan = explainPlan(VOCAB_DB_PATH, dim).map(r => r.detail).join("\n");
  let ok = true;
  if (!INDEXED.test(dim)) { console.log("  ✗ dimension not using INDEXED BY"); ok = false; }
  if (PLUS_PK.test(dim)) { console.log("  ✗ dimension still uses +m.field_id"); ok = false; }
  if (MEMBERSHIP.test(dim)) { console.log("  ✗ dimension keeps no-op _stats_artworks membership"); ok = false; }
  if (!/COVERING INDEX idx_mappings_field_vocab/.test(plan)) { console.log(`  ✗ plan not covering-index:\n    ${plan.replace(/\n/g, "\n    ")}`); ok = false; }
  if (!cov || !INDEXED.test(cov) || PLUS_PK.test(cov) || MEMBERSHIP.test(cov)) { console.log("  ✗ coverage SQL shape mismatch (expected indexed, no membership)"); ok = false; }
  if (ok) { console.log("  ✓ dimension + coverage use covering index, no membership"); passed++; } else failed++;
}

console.log("\n── 2. broad type:\"print\" (productionPlace dim, ≥50K) → indexed + membership ──");
{
  const { dim, cov } = shapes({ dimension: "productionPlace", type: "print", topN: 15 });
  let ok = true;
  if (!dim || !INDEXED.test(dim) || PLUS_PK.test(dim) || !MEMBERSHIP.test(dim)) { console.log("  ✗ broad dimension shape mismatch (expected indexed + membership)"); ok = false; }
  if (!cov || !INDEXED.test(cov) || !MEMBERSHIP.test(cov)) { console.log("  ✗ broad coverage shape mismatch"); ok = false; }
  if (ok) { console.log("  ✓ broad filtered → indexed field + retained membership"); passed++; } else failed++;
}

console.log("\n── 3. narrow creator:\"Rembrandt van Rijn\" (<50K) → +m.field_id PK + membership ──");
{
  const { dim, cov } = shapes({ dimension: "type", creator: "Rembrandt van Rijn", topN: 30 });
  if (!dim) { console.log("  ⚠ skipped — creator filter matched no vocab (DB without person enrichment?)"); skipped++; }
  else {
    let ok = true;
    if (!PLUS_PK.test(dim)) { console.log("  ✗ narrow dimension lost +m.field_id (would regress small-set PK-probe up to ~250×)"); ok = false; }
    if (INDEXED.test(dim)) { console.log("  ✗ narrow dimension forced INDEXED BY"); ok = false; }
    if (!MEMBERSHIP.test(dim)) { console.log("  ✗ narrow dimension dropped membership (would ignore the filter)"); ok = false; }
    if (!cov || !PLUS_PK.test(cov) || !MEMBERSHIP.test(cov)) { console.log("  ✗ narrow coverage shape mismatch"); ok = false; }
    if (ok) { console.log("  ✓ narrow filtered → +m.field_id PK-probe + membership (no regression)"); passed++; } else failed++;
  }
}

console.log(`\n${passed} passed${failed ? `, ${failed} failed` : ""}${skipped ? `, ${skipped} skipped` : ""}`);
process.exit(failed ? 1 : 0);
