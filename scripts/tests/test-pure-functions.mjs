/**
 * Unit tests for exported pure functions.
 *
 * Run:  node scripts/tests/test-pure-functions.mjs
 * Requires: npm run build (imports from dist/)
 */
// ── Imports from compiled dist/ ──────────────────────────────────

import {
  hasClassification,
  extractContent,
  extractIiifId,
  extractPageToken,
} from "../../dist/api/RijksmuseumApiClient.js";

import {
  haversineKm,
  pluralize,
  buildMultiWordPlaceWarning,
  parseDateFilter,
} from "../../dist/api/VocabularyDb.js";

import {
  regionToPixels,
  parsePctRegion,
  projectToFullImage,
} from "../../dist/registration.js";

import { escapeFts5 } from "../../dist/utils/db.js";

// ── Test helpers ─────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, msg) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}

function assertEq(actual, expected, msg) {
  const ok = actual === expected;
  assert(ok, ok ? msg : `${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertDeepEq(actual, expected, msg) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(ok, ok ? msg : `${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function section(name) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ${name}`);
  console.log(`${"═".repeat(60)}`);
}

// ── extractContent ───────────────────────────────────────────────

section("extractContent");

assertEq(extractContent("hello"), "hello", "string passthrough");
assertEq(extractContent(["a", "b", "c"]), "a; b; c", "array join");
assertEq(extractContent(null), "", "null → empty string");
assertEq(extractContent(undefined), "", "undefined → empty string");

// ── extractIiifId ────────────────────────────────────────────────

section("extractIiifId");

assertEq(
  extractIiifId("https://iiif.micr.io/AbCdE/info.json"),
  "AbCdE",
  "valid IIIF URL"
);
assertEq(extractIiifId("https://example.com/image.jpg"), null, "non-IIIF URL → null");
assertEq(extractIiifId(""), null, "empty string → null");

// ── extractPageToken ─────────────────────────────────────────────

section("extractPageToken");

assertEq(
  extractPageToken({ id: "https://example.com/search?pageToken=abc123" }),
  "abc123",
  "URL with pageToken"
);
assertEq(
  extractPageToken({ id: "https://example.com/search?foo=bar" }),
  undefined,
  "URL without pageToken → undefined"
);
assertEq(extractPageToken(undefined), undefined, "undefined → undefined");
assertEq(extractPageToken({ id: "" }), undefined, "empty id → undefined");

// ── hasClassification ────────────────────────────────────────────

section("hasClassification");

assert(
  hasClassification([{ id: "http://vocab.getty.edu/aat/300015045" }], "http://vocab.getty.edu/aat/300015045"),
  "match by {id} object"
);
assert(
  hasClassification(["http://vocab.getty.edu/aat/300015045"], "http://vocab.getty.edu/aat/300015045"),
  "match by string"
);
assert(
  !hasClassification([{ id: "http://vocab.getty.edu/aat/999" }], "http://vocab.getty.edu/aat/300015045"),
  "no match → false"
);
assert(!hasClassification(undefined, "http://vocab.getty.edu/aat/300015045"), "undefined input → false");
assert(!hasClassification([], "http://vocab.getty.edu/aat/300015045"), "empty array → false");

// ── escapeFts5 ───────────────────────────────────────────────────

section("escapeFts5");

assertEq(escapeFts5("hello world"), '"hello world"', "wraps in quotes");
assertEq(escapeFts5("foo*bar^baz()"), '"foobarbaz"', "strips operators *^()");
assertEq(escapeFts5('say "hello"'), '"say ""hello"""', "escapes double quotes");
assertEq(escapeFts5("***"), null, "empty-after-strip → null");
assertEq(escapeFts5("self-portrait"), '"self-portrait"', "preserves hyphens");

// ── parseDateFilter ──────────────────────────────────────────────

section("parseDateFilter");

assertDeepEq(parseDateFilter("1642"), { earliest: 1642, latest: 1642 }, "exact year 1642");
assertDeepEq(parseDateFilter("164*"), { earliest: 1640, latest: 1649 }, "decade 164*");
assertDeepEq(parseDateFilter("16*"), { earliest: 1600, latest: 1699 }, "century 16*");
assertDeepEq(parseDateFilter("-5*"), { earliest: -5999, latest: -5000 }, "BCE -5*");
assertEq(parseDateFilter(""), null, "empty → null");
assertEq(parseDateFilter("  "), null, "whitespace → null");
assertEq(parseDateFilter("abc"), null, "non-numeric → null");
assertDeepEq(parseDateFilter(" 1642 "), { earliest: 1642, latest: 1642 }, "trimmed");

// ── haversineKm ──────────────────────────────────────────────────

section("haversineKm");

{
  // Amsterdam (52.3676, 4.9041) → Paris (48.8566, 2.3522) ≈ 430 km
  const d = haversineKm(52.3676, 4.9041, 48.8566, 2.3522);
  assert(d > 425 && d < 435, `Amsterdam–Paris ≈ 430 km (got ${d.toFixed(1)})`);
}
{
  const d = haversineKm(0, 0, 0, 0);
  assertEq(d, 0, "same point → 0");
}
{
  // Antipodal: (0,0) → (0,180) ≈ 20015 km
  const d = haversineKm(0, 0, 0, 180);
  assert(d > 20000 && d < 20050, `antipodal ≈ 20015 km (got ${d.toFixed(1)})`);
}

// ── pluralize ────────────────────────────────────────────────────

section("pluralize");

assertEq(pluralize(1, "place"), "1 place", "singular");
assertEq(pluralize(3, "place"), "3 places", "plural");
assertEq(pluralize(0, "place"), "0 places", "zero");
assertEq(pluralize(2, "match"), "2 matches", "ch suffix → es");
assertEq(pluralize(1, "match"), "1 match", "ch suffix singular");

// ── buildMultiWordPlaceWarning ───────────────────────────────────

section("buildMultiWordPlaceWarning");

{
  const msg = buildMultiWordPlaceWarning("depictedPlace", "Kerk", "Amsterdam", 5, {
    filteredCount: 2,
    geocodedCount: 4,
  });
  assert(msg.includes("near \"Amsterdam\""), "geo-filtered: mentions context");
  assert(msg.includes("filtered to 2 of 4 geocoded places"), "geo-filtered: counts");
}
{
  const msg = buildMultiWordPlaceWarning("depictedPlace", "Kerk", "Atlantis", 5);
  assert(msg.includes("could not resolve context \"Atlantis\""), "unresolved context");
  assert(msg.includes("5 ambiguous matches"), "unresolved: candidate count");
}
{
  const msg = buildMultiWordPlaceWarning("depictedPlace", "Kerk", "", 3);
  assert(!msg.includes("context"), "no-context: no context mention");
  assert(msg.includes("3 matches"), "no-context: count");
}

// ── regionToPixels ───────────────────────────────────────────────

section("regionToPixels");

assertEq(regionToPixels("pct:10,20,30,40", 1000, 500), "100,100,300,200", "valid pct → pixels");
assertEq(regionToPixels("full", 1000, 500), undefined, "full → undefined");
assertEq(regionToPixels("garbage", 1000, 500), undefined, "garbage → undefined");
assertEq(regionToPixels("pct:0,0,100,100", 800, 600), "0,0,800,600", "full region → full size");

// ── parsePctRegion ───────────────────────────────────────────────

section("parsePctRegion");

assertDeepEq(parsePctRegion("pct:10.5,20,30.5,40"), [10.5, 20, 30.5, 40], "valid → 4-tuple");
assertEq(parsePctRegion("full"), null, "full → null");
assertEq(parsePctRegion("garbage"), null, "garbage → null");
assertEq(parsePctRegion(""), null, "empty → null");

// ── projectToFullImage ───────────────────────────────────────────

section("projectToFullImage");

{
  // Crop at pct:50,50,50,50 (bottom-right quarter), local point at pct:50,50,20,20
  // Expected: x = 50 + (50/100)*50 = 75, y = 50 + (50/100)*50 = 75, w = (20/100)*50 = 10, h = (20/100)*50 = 10
  assertEq(
    projectToFullImage("pct:50,50,20,20", "pct:50,50,50,50"),
    "pct:75,75,10,10",
    "known projection math"
  );
}
assertEq(projectToFullImage("full", "pct:50,50,50,50"), null, "invalid local → null");
assertEq(projectToFullImage("pct:50,50,50,50", "garbage"), null, "invalid relativeTo → null");

// ── Summary ──────────────────────────────────────────────────────

console.log(`\n${"═".repeat(60)}`);
console.log(`  Passed: ${passed}  Failed: ${failed}`);
if (failures.length > 0) {
  console.log(`\n  Failures:`);
  for (const f of failures) console.log(`    ✗ ${f}`);
}
console.log(`${"═".repeat(60)}\n`);

process.exit(failed > 0 ? 1 : 0);
