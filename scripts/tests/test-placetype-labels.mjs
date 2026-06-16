/**
 * Unit tests for placetypeLabels (src/placetypeLabels.ts).
 *
 * Run:  node scripts/tests/test-placetype-labels.mjs
 * Requires: npm run build (imports from dist/).
 */

import { strict as assert } from "node:assert";
import { labelForPlacetype, urisForPlacetypeLabel, PLACETYPE_LABELS } from "../../dist/placetypeLabels.js";

// ── Pass/fail counters ────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    failures.push(`${name} — ${e.message}`);
    console.log(`  ✗ ${name} — ${e.message}`);
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(60)}`);
console.log(`  placeType label resolution`);
console.log(`${"═".repeat(60)}`);

test("Exact label, Wikidata: Q6256 → country", () => {
  assert.strictEqual(labelForPlacetype("http://www.wikidata.org/entity/Q6256"), "country");
});

test("Exact label, Getty: 300008347 → inhabited places", () => {
  assert.strictEqual(labelForPlacetype("http://vocab.getty.edu/aat/300008347"), "inhabited places");
});

test("Head URI is resolved (does not start with http)", () => {
  assert.ok(!labelForPlacetype("http://www.wikidata.org/entity/Q515").startsWith("http"));
});

test("Unknown URI passes through unchanged", () => {
  assert.strictEqual(
    labelForPlacetype("http://vocab.getty.edu/aat/999999999"),
    "http://vocab.getty.edu/aat/999999999",
  );
});

test("Reverse lookup: country → includes Q6256 URI", () => {
  assert.ok(urisForPlacetypeLabel("country").includes("http://www.wikidata.org/entity/Q6256"));
});

test("Reverse is case-insensitive: COUNTRY → includes Q6256 URI", () => {
  assert.ok(urisForPlacetypeLabel("COUNTRY").includes("http://www.wikidata.org/entity/Q6256"));
});

test("Reverse of unknown label → []", () => {
  assert.strictEqual(urisForPlacetypeLabel("not a real placetype").length, 0);
});

test("Map covers the head: at least 30 entries", () => {
  assert.ok(Object.keys(PLACETYPE_LABELS).length >= 30);
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(60)}`);
console.log(`  Passed: ${passed}  Failed: ${failed}`);
if (failures.length > 0) {
  console.log(`\n  Failures:`);
  for (const f of failures) console.log(`    ✗ ${f}`);
}
console.log(`${"═".repeat(60)}\n`);

process.exit(failed > 0 ? 1 : 0);
