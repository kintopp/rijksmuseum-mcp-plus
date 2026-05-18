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
 * Requires production_role_pairs to be populated for the #357 checks — run
 * scripts/backfill-production-role-pairs.py first.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { VocabularyDb } = await import(path.join(PROJECT_DIR, "dist/api/VocabularyDb.js"));

const db = new VocabularyDb();
if (!db.available) {
  console.error("Vocabulary DB not available — set VOCAB_DB_PATH or run from project root");
  process.exit(1);
}

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
  },
  {
    label: "#357 — Rembrandt + draughtsman + sameRowMatching",
    params: { creator: REMBRANDT, productionRole: "draughtsman", sameRowMatching: true },
    expectRange: [40, 120],
    expectWarning: null,
  },
  {
    label: "#357 — Rembrandt + print maker + sameRowMatching",
    params: { creator: REMBRANDT, productionRole: "print maker", sameRowMatching: true },
    expectRange: [1000, 1500],
    expectWarning: null,
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
for (const c of CASES) {
  const result = db.searchCompact({ ...c.params, maxResults: 1 });
  const count = result.totalResults ?? result.ids.length;
  const warnings = result.warnings ?? [];
  const inRange = count >= c.expectRange[0] && count <= c.expectRange[1];
  const warnOK = c.expectWarning
    ? warnings.some(w => c.expectWarning.test(w))
    : true;
  const ok = inRange && warnOK;

  const mark = ok ? "✓" : "✗";
  console.log(`${mark} ${c.label}`);
  console.log(`    count=${count.toLocaleString()} (expect ${c.expectRange[0].toLocaleString()}-${c.expectRange[1].toLocaleString()})`);
  if (warnings.length) {
    for (const w of warnings) console.log(`    ⚠ ${w}`);
  }
  if (c.expectWarning && !warnOK) {
    console.log(`    expected warning matching ${c.expectWarning} — not emitted`);
  }
  if (ok) passed++;
  else failed++;
}

console.log(`\n${passed}/${CASES.length} passed${failed ? ` (${failed} failed)` : ""}`);
process.exit(failed ? 1 : 0);
