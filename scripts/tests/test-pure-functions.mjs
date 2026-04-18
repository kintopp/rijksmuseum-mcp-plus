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
  parseCropPixelsRegion,
  cropPixelsToIiifPixels,
  checkRegionBounds,
} from "../../dist/registration.js";

import {
  computeCropRect,
  projectOverlayToCrop,
} from "../../dist/overlay-compositor.js";

import { escapeFts5, escapeFts5Token, generateMorphVariants, expandFtsQuery } from "../../dist/utils/db.js";

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

// ── parseCropPixelsRegion ───────────────────────────────────────

section("parseCropPixelsRegion");

assertDeepEq(parseCropPixelsRegion("crop_pixels:100,200,300,400"), [100, 200, 300, 400], "valid → 4-tuple");
assertEq(parseCropPixelsRegion("pct:10,20,30,40"), null, "pct: → null");
assertEq(parseCropPixelsRegion("100,200,300,400"), null, "no prefix → null");
assertEq(parseCropPixelsRegion("crop_pixels:1.5,2,3,4"), null, "decimals → null");
assertEq(parseCropPixelsRegion(""), null, "empty → null");

// ── cropPixelsToIiifPixels ──────────────────────────────────────

section("cropPixelsToIiifPixels");

assertEq(cropPixelsToIiifPixels("crop_pixels:10,20,30,40"), "10,20,30,40", "strip prefix");
assertEq(cropPixelsToIiifPixels("pct:10,20,30,40"), null, "pct: → null");
assertEq(cropPixelsToIiifPixels("full"), null, "full → null");

// ── checkRegionBounds ───────────────────────────────────────────

section("checkRegionBounds");

// Happy path
assertEq(checkRegionBounds("pct:10,20,30,40"), null, "pct in-bounds → null");
assertEq(checkRegionBounds("full"), null, "full → null");
assertEq(checkRegionBounds("square"), null, "square → null");
assertEq(checkRegionBounds("pct:0,0,100,100"), null, "pct edge 0,0,100,100 → null");

// pct OOB — y out of range
{
  const oob = checkRegionBounds("pct:36,325,35,30");
  assert(oob != null, "pct:36,325,35,30 → OOB warning");
  assertEq(oob?.warning, "overlay_region_out_of_bounds", "warning code");
  assert(oob?.details.issue.includes("y=325 outside 0–100"), "issue mentions y=325");
  assertEq(oob?.details.clamped_to, "pct:36,100,35,0", "clamped_to value");
}

// pct — x+w exceeds 100
{
  const oob = checkRegionBounds("pct:80,10,30,20");
  assert(oob != null, "pct:80,10,30,20 → OOB");
  assert(oob?.details.issue.includes("x+w=110"), "issue mentions x+w=110");
}

// Note: negative-pct inputs (e.g. "pct:-10,50,20,20") are rejected upstream
// by IIIF_REGION_RE format validation in navigate_viewer — they never reach
// checkRegionBounds.

// pct — zero dimensions
{
  const oob = checkRegionBounds("pct:10,10,0,20");
  assert(oob != null, "w=0 → OOB");
  assert(oob?.details.issue.includes("w=0"), "issue mentions w=0");
}

// crop_pixels with imageWidth/Height — exceeds bounds
{
  const oob = checkRegionBounds("crop_pixels:100,200,50,50", 120, 400);
  assert(oob != null, "crop_pixels exceeds imgW → OOB");
  assert(oob?.details.issue.includes("x+w=150 exceeds imageWidth=120"), "issue mentions x+w vs imageWidth");
  assertEq(oob?.details.clamped_to, "crop_pixels:100,200,20,50", "clamped preserves prefix");
}

// crop_pixels — unknown image dims, best-effort (only checks w,h > 0)
assertEq(checkRegionBounds("crop_pixels:100,200,50,50"), null, "crop_pixels no dims → null (best-effort)");
{
  const oob = checkRegionBounds("crop_pixels:100,200,0,50");
  assert(oob != null, "crop_pixels w=0 → OOB even without dims");
  assert(oob?.details.issue.includes("w=0"), "issue mentions w=0");
}

// Plain IIIF pixels (legacy) — equivalent to crop_pixels for bounds-check
{
  const oob = checkRegionBounds("100,200,50,50", 120, 400);
  assert(oob != null, "plain pixels OOB with dims");
  assertEq(oob?.details.clamped_to, "100,200,20,50", "clamped has no prefix for plain pixels");
}

// ── computeCropRect ─────────────────────────────────────────────

section("computeCropRect");

assertDeepEq(computeCropRect("full", 1000, 800), { x: 0, y: 0, w: 1000, h: 800 }, "full → whole image");
assertDeepEq(computeCropRect("square", 1000, 800), { x: 100, y: 0, w: 800, h: 800 }, "square on landscape — centered");
assertDeepEq(computeCropRect("square", 600, 900), { x: 0, y: 150, w: 600, h: 600 }, "square on portrait — centered");
assertDeepEq(computeCropRect("pct:25,25,50,50", 1000, 800), { x: 250, y: 200, w: 500, h: 400 }, "pct → proportional");
assertDeepEq(computeCropRect("100,200,300,400", 1000, 800), { x: 100, y: 200, w: 300, h: 400 }, "plain pixels → as-is");
assertEq(computeCropRect("bogus", 1000, 800), null, "unrecognised → null");

// ── projectOverlayToCrop ────────────────────────────────────────

section("projectOverlayToCrop");

// Overlay fully inside crop: pct:40,40,20,20 on 1000×800 = (400,320,200,160).
// Crop is pct:25,25,50,50 = (250,200,500,400). Rendered crop is 400×320 px → scale 0.8.
// Overlay local = ((400-250)*0.8, (320-200)*0.8, 200*0.8, 160*0.8) = (120, 96, 160, 128).
{
  const frame = { rect: { x: 250, y: 200, w: 500, h: 400 }, imageWidth: 1000, imageHeight: 800 };
  const local = projectOverlayToCrop("pct:40,40,20,20", frame, 400, 320);
  assert(local != null, "overlay projects into crop");
  assertEq(Math.round(local.x), 120, "local x");
  assertEq(Math.round(local.y), 96, "local y");
  assertEq(Math.round(local.w), 160, "local w");
  assertEq(Math.round(local.h), 128, "local h");
}

// Overlay fully outside crop → null
{
  const frame = { rect: { x: 0, y: 0, w: 200, h: 200 }, imageWidth: 1000, imageHeight: 800 };
  const local = projectOverlayToCrop("pct:80,80,10,10", frame, 200, 200);
  assertEq(local, null, "overlay outside crop → null");
}

// Overlay straddling crop boundary → returned (SVG viewBox clips on render)
{
  const frame = { rect: { x: 100, y: 100, w: 200, h: 200 }, imageWidth: 1000, imageHeight: 800 };
  // Overlay at (50, 50) with size 100×100 in full image — extends off crop's top-left.
  const local = projectOverlayToCrop("50,50,100,100", frame, 200, 200);
  assert(local != null, "straddling overlay returned (clipped by SVG on render)");
  assertEq(Math.round(local.x), -50, "straddling x is negative");
  assertEq(Math.round(local.y), -50, "straddling y is negative");
}

// Zero-dimension overlay → null
{
  const frame = { rect: { x: 0, y: 0, w: 1000, h: 800 }, imageWidth: 1000, imageHeight: 800 };
  assertEq(projectOverlayToCrop("pct:10,10,0,10", frame, 1000, 800), null, "zero-width overlay → null");
  assertEq(projectOverlayToCrop("pct:10,10,10,0", frame, 1000, 800), null, "zero-height overlay → null");
}

// ── escapeFts5Token ─────────────────────────────────────────────

section("escapeFts5Token");

assertEq(escapeFts5Token("cat"), '"cat"', "simple word quoted");
assertEq(escapeFts5Token("wild*"), '"wild"', "strips FTS5 operators and quotes");
assertEq(escapeFts5Token('"quoted"'), '"quoted"', "strips double quotes and re-quotes");
assertEq(escapeFts5Token(""), null, "empty → null");
assertEq(escapeFts5Token("***"), null, "all operators → null");

// ── generateMorphVariants ───────────────────────────────────────

section("generateMorphVariants");

// Plural → singular
{
  const v = generateMorphVariants("cats");
  assert(v.includes("cat"), "cats → cat");
}
{
  const v = generateMorphVariants("churches");
  assert(v.includes("church"), "churches → church");
}
{
  const v = generateMorphVariants("butterflies");
  assert(v.includes("butterfly"), "butterflies → butterfly");
}

// Singular → plural
{
  const v = generateMorphVariants("cat");
  assert(v.includes("cats"), "cat → cats");
}

// Gerunds
{
  const v = generateMorphVariants("painting");
  assert(v.includes("paint"), "painting → paint");
}
{
  const v = generateMorphVariants("skating");
  assert(v.includes("skate"), "skating → skate");
}

// Past tense
{
  const v = generateMorphVariants("painted");
  assert(v.includes("paint"), "painted → paint");
}
{
  const v = generateMorphVariants("crucified");
  assert(v.includes("crucify"), "crucified → crucify");
}

// Specific plural edge cases (rule ordering)
{
  const v = generateMorphVariants("foxes");
  assert(v.includes("fox"), "foxes → fox (xes rule, not ses)");
  assert(!v.includes("foxe"), "foxes does not produce 'foxe'");
}
{
  const v = generateMorphVariants("buses");
  assert(v.includes("bus"), "buses → bus (ses rule)");
}
{
  const v = generateMorphVariants("watches");
  assert(v.includes("watch"), "watches → watch (ches rule)");
}

// Minimum stem guard
{
  const v = generateMorphVariants("is");
  assertDeepEq(v, [], "is → [] (too short)");
}
{
  const v = generateMorphVariants("ass");
  assert(!v.includes("as"), "ass does not produce 'as' (min stem 3)");
}

// No self-reference
{
  const v = generateMorphVariants("cat");
  assert(!v.includes("cat"), "cat variants don't include 'cat' itself");
}

// ── expandFtsQuery ──────────────────────────────────────────────

section("expandFtsQuery");

// Single word
{
  const q = expandFtsQuery("cats");
  assert(q !== null, "cats → non-null");
  assert(q.includes("cats"), "cats query includes original");
  assert(q.includes("cat"), "cats query includes stem");
  assert(q.includes("OR"), "cats query uses OR");
}

// Two words
{
  const q = expandFtsQuery("wild cats");
  assert(q !== null, "wild cats → non-null");
  assert(q.includes("AND"), "two-word query uses AND");
  assert(q.includes("OR"), "two-word query has OR for variants");
}

// >3 tokens → null
assertEq(expandFtsQuery("the old church in Amsterdam"), null, ">3 tokens → null");
assertEq(expandFtsQuery("one two three four"), null, "4 tokens → null");

// 3 tokens — should work
assert(expandFtsQuery("wild forest cat") !== null, "3 tokens → non-null");

// Empty
assertEq(expandFtsQuery(""), null, "empty → null");

// Cap enforcement: total terms ≤ 8
{
  const q = expandFtsQuery("painting skating");
  if (q) {
    const terms = q.replace(/[()]/g, "").split(/\s+(?:AND|OR)\s+/).length;
    // Count actual terms by splitting on spaces and filtering out operators
    const allTerms = q.replace(/[()]/g, "").split(/\s+/).filter(t => t !== "AND" && t !== "OR");
    assert(allTerms.length <= 8, `cap enforcement: ${allTerms.length} terms ≤ 8`);
  }
}

// No expansion possible (no variants) → null
assertEq(expandFtsQuery("a"), null, "single short token with no variants → null");

// ── Summary ──────────────────────────────────────────────────────

console.log(`\n${"═".repeat(60)}`);
console.log(`  Passed: ${passed}  Failed: ${failed}`);
if (failures.length > 0) {
  console.log(`\n  Failures:`);
  for (const f of failures) console.log(`    ✗ ${f}`);
}
console.log(`${"═".repeat(60)}\n`);

process.exit(failed > 0 ? 1 : 0);
