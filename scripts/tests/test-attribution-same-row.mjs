/**
 * Verifies the same-row attribution fixes:
 *   - #349: creator + attributionQualifier evaluates against the SAME production row
 *           (assignment_pairs, always-on for connoisseurship qualifiers)
 *   - #357: creator + productionRole + sameRowMatching:true (production_role_pairs)
 *
 * Background: a Rijksmuseum staff member's CMS-derived ground truth for "Rembrandt
 * van Rijn, made by himself" is 25 paintings, 64 drawings, 1,300 prints.
 * Pre-fix, attributionQualifier:"primary" returned ~3,693 because the qualifier filter
 * matched any priority-tagged row on the artwork — including reproductive photographers'
 * rows. The fixes constrain the filters to Rembrandt's OWN production row.
 *
 * Run:  npm run build  &&  node scripts/tests/test-attribution-same-row.mjs
 *
 * The #357 checks need the backfill-only production_role_pairs table; when it is
 * absent those cases are skipped (not failed) — run
 * scripts/backfill-production-role-pairs.py to exercise them.
 *
 * Phase 2 is a query-plan regression guard: the rare connoisseurship case
 * (e.g. "workshop of" + a named creator) must drive from assignment_pairs, not
 * walk idx_artworks_importance (the correlated-EXISTS ~15s-on-prod regression).
 */
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import path from "node:path";

const require = createRequire(import.meta.url);
const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const VOCAB_DB_PATH = process.env.VOCAB_DB_PATH
  ? path.resolve(process.env.VOCAB_DB_PATH)
  : path.join(PROJECT_DIR, "data/vocabulary.db");
const { VocabularyDb } = await import(path.join(PROJECT_DIR, "dist/api/VocabularyDb.js"));

const db = new VocabularyDb();
if (!db.available) {
  console.error("Vocabulary DB not available — set VOCAB_DB_PATH or run from project root");
  process.exit(1);
}

// #357 cases need the backfill-only production_role_pairs table. Detect it so the
// suite can skip (not fail) those cases on DBs where the backfill hasn't run.
const Database = require("better-sqlite3");
const probeDb = new Database(VOCAB_DB_PATH, { readonly: true });
const hasRolePairs = !!probeDb
  .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='production_role_pairs'")
  .get();
probeDb.close();

const REMBRANDT = "Rembrandt van Rijn";

/**
 * Each row: a query to run + the expected outcome. We assert against ranges
 * rather than exact counts because catalogue updates can shift totals by 1-2%.
 */
const CASES = [
  // ── Baselines (unchanged by these fixes) ──
  {
    label: "creator alone (baseline — should be unchanged)",
    params: { creator: REMBRANDT },
    expectRange: [3500, 4000],
    expectWarning: null,
  },
  {
    label: "productionRole alone (no flag — independence, unchanged)",
    params: { productionRole: "painter", type: "painting" },
    // ~7K painters in collection, just spot-check it's large
    expectRange: [3000, 12000],
    expectWarning: null,
  },

  // ── #349: creator + attributionQualifier same-row ──
  {
    label: "#349 — Rembrandt + 'after' (same-row via assignment_pairs)",
    params: { creator: REMBRANDT, attributionQualifier: "after" },
    expectRange: [3000, 3500],
    expectWarning: null,
  },
  {
    label: "#349 — Rembrandt + 'workshop of'",
    params: { creator: REMBRANDT, attributionQualifier: "workshop of" },
    expectRange: [5, 100],
    expectWarning: null,
  },
  {
    label: "#349 — Rembrandt + 'attributed to'",
    params: { creator: REMBRANDT, attributionQualifier: "attributed to" },
    expectRange: [10, 200],
    expectWarning: null,
  },
  {
    label: "#349 fallback — Rembrandt + 'primary' (priority-level → warning)",
    params: { creator: REMBRANDT, attributionQualifier: "primary" },
    // Priority-level falls back to current independent behavior — still ~3,693
    expectRange: [3500, 4000],
    expectWarning: /primary.*don't enforce same-row|priority-level|productionRole/i,
  },

  // ── #357: creator + productionRole + sameRowMatching ──
  {
    label: "#357 — Rembrandt + painter + sameRowMatching",
    params: { creator: REMBRANDT, productionRole: "painter", sameRowMatching: true },
    expectRange: [15, 50],
    expectWarning: null,
    requiresRolePairs: true,
  },
  {
    label: "#357 — Rembrandt + draughtsman + sameRowMatching",
    params: { creator: REMBRANDT, productionRole: "draughtsman", sameRowMatching: true },
    expectRange: [40, 120],
    expectWarning: null,
    requiresRolePairs: true,
  },
  {
    label: "#357 — Rembrandt + print maker + sameRowMatching",
    params: { creator: REMBRANDT, productionRole: "print maker", sameRowMatching: true },
    expectRange: [1000, 1500],
    expectWarning: null,
    requiresRolePairs: true,
  },

  // ── #357 regression: without flag, productionRole stays independent ──
  {
    label: "#357 control — Rembrandt + 'print maker' (no flag, broader)",
    params: { creator: REMBRANDT, productionRole: "print maker" },
    expectRange: [2500, 4000],
    expectWarning: null,
  },
];

let passed = 0;
let failed = 0;
let skipped = 0;
for (const c of CASES) {
  if (c.requiresRolePairs && !hasRolePairs) {
    console.log(`⊘ ${c.label}`);
    console.log(`    skipped — production_role_pairs not present (run scripts/backfill-production-role-pairs.py)`);
    skipped++;
    continue;
  }

  const t0 = process.hrtime.bigint();
  const result = db.searchCompact({ ...c.params, maxResults: 1 });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const count = result.totalResults ?? result.ids.length;
  const warnings = result.warnings ?? [];
  const inRange = count >= c.expectRange[0] && count <= c.expectRange[1];
  const warnOK = c.expectWarning
    ? warnings.some(w => c.expectWarning.test(w))
    : true;
  const ok = inRange && warnOK;

  const mark = ok ? "✓" : "✗";
  console.log(`${mark} ${c.label}`);
  console.log(`    count=${count.toLocaleString()} (expect ${c.expectRange[0].toLocaleString()}-${c.expectRange[1].toLocaleString()})  ${ms.toFixed(1)}ms`);
  if (warnings.length) {
    for (const w of warnings) console.log(`    ⚠ ${w}`);
  }
  if (c.expectWarning && !warnOK) {
    console.log(`    expected warning matching ${c.expectWarning} — not emitted`);
  }
  if (ok) passed++;
  else failed++;
}

// ── Phase 2: query-plan regression for the #349 importance-index-walk bug ──
// "workshop of" + a named creator returns only a handful of rows. When
// emitSameRowExists emitted a correlated EXISTS, ORDER BY a.importance DESC walked
// idx_artworks_importance probing per artwork (~834K probes → ~15s on prod). It now
// emits a driving `a.art_id IN (assignment_pairs …)` subquery, so the planner
// materialises the tiny match set first. Capture the REAL generated SQL (via an
// instrumented prepare) and assert the plan never touches idx_artworks_importance
// and does drive from assignment_pairs.
console.log("\n── Phase 2: query-plan regression (importance-index-walk guard) ──");

const captured = new Set();
const origPrepare = Database.prototype.prepare;
Database.prototype.prepare = function (sql) { captured.add(sql); return origPrepare.call(this, sql); };
db.searchCompact({ creator: REMBRANDT, attributionQualifier: "workshop of", maxResults: 25 });
Database.prototype.prepare = origPrepare;

const sameRowSql = [...captured].find(
  (s) => /FROM artworks a/.test(s) && /assignment_pairs/.test(s) && /ORDER BY/.test(s),
);
assert(sameRowSql, "could not capture the same-row search SQL (did the query shape change?)");

const explainDb = new Database(VOCAB_DB_PATH, { readonly: true });
explainDb.function("haversine_km", () => 0);
const planRows = explainDb
  .prepare("EXPLAIN QUERY PLAN " + sameRowSql.replace(/\?/g, "1"))
  .all();
explainDb.close();
const planText = planRows.map((r) => r.detail).join("\n");

const usesImportanceIndex = /idx_artworks_importance/.test(planText);
const drivesFromPairs = /assignment_pairs/.test(planText);

console.log("  Plan:");
for (const r of planRows) console.log(`    ${r.detail}`);

let phase2ok = true;
if (usesImportanceIndex) {
  console.log("  ✗ plan touches idx_artworks_importance — the slow correlated-EXISTS regression is back");
  phase2ok = false;
}
if (!drivesFromPairs) {
  console.log("  ✗ plan no longer references assignment_pairs — same-row predicate lost");
  phase2ok = false;
}
if (phase2ok) {
  console.log("  ✓ same-row search drives from assignment_pairs, not the importance index");
  passed++;
} else {
  failed++;
}

console.log(`\n${passed} passed${failed ? `, ${failed} failed` : ""}${skipped ? `, ${skipped} skipped` : ""}`);
process.exit(failed ? 1 : 0);
