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
  parsePctRegion,
  projectToFullImage,
  parseCropPixelsRegion,
  cropPixelsToIiifPixels,
  checkRegionBounds,
  computeDeliveryState,
  parseDimRange,
  parseSortParam,
  stripNullCoerceBool,
  regionPixelDims,
  VISION_MAX_EDGE,
  VISION_MAX_TOKENS,
  padToPatch,
  visualTokens,
  maxInspectWidth,
} from "../../dist/registration.js";

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
{
  // Same projection, but the local box is expressed in rendered crop pixels.
  assertEq(
    projectToFullImage("crop_pixels:600,300,240,120", "pct:50,50,50,50", { width: 1200, height: 600 }),
    "pct:75,75,10,10",
    "crop-local pixels project through relativeToSize"
  );
}
assertEq(projectToFullImage("full", "pct:50,50,50,50"), null, "invalid local → null");
assertEq(projectToFullImage("pct:50,50,50,50", "garbage"), null, "invalid relativeTo → null");
assertEq(projectToFullImage("crop_pixels:600,300,240,120", "pct:50,50,50,50"), null, "crop-local pixels require local size");

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

// ── computeDeliveryState ─────────────────────────────────────────

section("computeDeliveryState");

const NOW = 1_700_000_000_000;
assertEq(computeDeliveryState(undefined, NOW), "no_live_viewer_seen",
  "undefined lastPolledAt → no_live_viewer_seen");
assertEq(computeDeliveryState(NOW - 1000, NOW), "delivered_recently",
  "polled 1s ago → delivered_recently");
assertEq(computeDeliveryState(NOW - 4999, NOW), "delivered_recently",
  "polled 4999ms ago → delivered_recently (just inside the window)");
assertEq(computeDeliveryState(NOW - 5000, NOW), "queued_waiting_for_viewer",
  "polled exactly 5000ms ago → queued_waiting_for_viewer (boundary excluded)");
assertEq(computeDeliveryState(NOW - 60_000, NOW), "queued_waiting_for_viewer",
  "polled 60s ago → queued_waiting_for_viewer");
assertEq(computeDeliveryState(NOW - 5000, NOW, 10_000), "delivered_recently",
  "custom recentMs widens the window");
assertEq(computeDeliveryState(NOW, NOW), "delivered_recently",
  "polled this instant → delivered_recently");

// ── parseDimRange ────────────────────────────────────────────────

section("parseDimRange");

assertDeepEq(parseDimRange("10-50"),  { min: 10, max: 50 }, "two-sided range");
assertDeepEq(parseDimRange("10-"),    { min: 10 },          "open upper bound");
assertDeepEq(parseDimRange("-50"),    { max: 50 },          "open lower bound");
assertDeepEq(parseDimRange("10.5-50.25"), { min: 10.5, max: 50.25 }, "decimal bounds");
assertEq(parseDimRange("10"),      null, "single number without hyphen → null");
assertEq(parseDimRange("-"),       null, "lone hyphen → null");
assertEq(parseDimRange(""),        null, "empty string → null");
assertEq(parseDimRange("abc"),     null, "non-numeric → null");
assertEq(parseDimRange("10-50-"),  null, "trailing junk → null");
assertEq(parseDimRange(undefined), null, "undefined → null");
assertEq(parseDimRange(42),        null, "non-string input → null");

// ── parseSortParam ───────────────────────────────────────────────

section("parseSortParam");

assertDeepEq(parseSortParam("height"),            { sortBy: "height",         sortOrder: "desc" }, "column only → default desc");
assertDeepEq(parseSortParam("height:desc"),       { sortBy: "height",         sortOrder: "desc" }, "explicit desc");
assertDeepEq(parseSortParam("dateEarliest:asc"),  { sortBy: "dateEarliest",   sortOrder: "asc"  }, "column with asc");
assertDeepEq(parseSortParam("recordModified:desc"), { sortBy: "recordModified", sortOrder: "desc" }, "recordModified column");
assertDeepEq(parseSortParam("width"),             { sortBy: "width",          sortOrder: "desc" }, "width default desc");
assertDeepEq(parseSortParam("dateLatest"),        { sortBy: "dateLatest",     sortOrder: "desc" }, "dateLatest default desc");
assertEq(parseSortParam("bogus"),          null, "unknown column → null");
assertEq(parseSortParam("height:sideways"), null, "unknown direction → null");
assertEq(parseSortParam("height:"),        null, "trailing colon → null");
assertEq(parseSortParam(""),               null, "empty string → null");
assertEq(parseSortParam(undefined),        null, "undefined → null");
assertEq(parseSortParam(42),               null, "non-string input → null");

// ── stripNullCoerceBool ──────────────────────────────────────────

section("stripNullCoerceBool");

assertEq(stripNullCoerceBool(true),         true,      "literal true → true");
assertEq(stripNullCoerceBool(false),        false,     "literal false → false");
assertEq(stripNullCoerceBool("true"),       true,      "'true' string → true (the bug shape)");
assertEq(stripNullCoerceBool("false"),      false,     "'false' string → false");
assertEq(stripNullCoerceBool(null),         undefined, "null → undefined (stripped)");
assertEq(stripNullCoerceBool(undefined),    undefined, "undefined → undefined");
assertEq(stripNullCoerceBool("null"),       undefined, "'null' string → undefined (stripped)");
assertEq(stripNullCoerceBool(""),           undefined, "empty string → undefined (stripped)");
// Strict canonical form — case-sensitive
assertEq(stripNullCoerceBool("True"),       "True",    "'True' (capital) NOT coerced — Zod will reject it");
assertEq(stripNullCoerceBool("TRUE"),       "TRUE",    "'TRUE' (uppercase) NOT coerced — Zod will reject it");
assertEq(stripNullCoerceBool("yes"),        "yes",     "'yes' NOT coerced — only the canonical strings");
// Non-string non-bool falls through to Zod for type-checking
assertEq(stripNullCoerceBool(1),            1,         "1 falls through unchanged (Zod will reject)");
assertEq(stripNullCoerceBool(0),            0,         "0 falls through unchanged (Zod will reject)");

section("visualTokens");

assertEq(visualTokens(28, 28),       1,    "one exact patch → 1 token");
assertEq(visualTokens(29, 28),       2,    "one pixel over → next patch column (ceil, not round)");
assertEq(visualTokens(1000, 1000),  1296,  "1000×1000 → 1296 (documented example)");
assertEq(visualTokens(2576, 1449),  4784,  "2576×1449 → exactly the 4784 budget (documented example)");

section("maxInspectWidth");

// The contract, stated once, from the exported constants — so a change to
// either budget can't leave the test asserting the old one.
const fitsBudget = (w, regionW, regionH) => {
  const h = Math.max(1, Math.ceil(w * regionH / regionW));
  return padToPatch(w) <= VISION_MAX_EDGE
    && padToPatch(h) <= VISION_MAX_EDGE
    && visualTokens(w, h) <= VISION_MAX_TOKENS;
};

// Shapes chosen so the two limits take turns binding: elongated regions are
// edge-bound, square ones are token-bound well below the edge cap. Each shape
// asserts both halves of "largest that fits" — fit AND maximality, since fit
// alone would pass for any conservative implementation.
for (const [label, w, h] of [
  ["16:9 landscape", 1920, 1080],
  ["3:2 landscape",  3000, 2000],
  ["4:3 landscape",  4000, 3000],
  ["square",         5000, 5000],
  ["3:4 portrait",   3000, 4000],
  ["9:16 portrait",  1080, 1920],
  ["A4 portrait",    1000, 1414],
  ["VOC scan",       3148, 4179],
  ["degenerate 1×1", 1, 1],
]) {
  const got = maxInspectWidth(w, h);
  assert(fitsBudget(got, w, h),      `${label}: ${got}px fits the budget`);
  assert(!fitsBudget(got + 1, w, h), `${label}: ${got + 1}px does not — ${got} is the ceiling`);
}

// Exact values the loop cannot pin. Regression guard for the bug this replaced:
// the old cap was 2016, the first patch multiple ABOVE the ~2000px many-image
// limit, silently downscaled for anything squarer than ~1.09:1.
assertEq(maxInspectWidth(1920, 1080), VISION_MAX_EDGE, "wide regions reach the edge cap");
assert(maxInspectWidth(5000, 5000) < VISION_MAX_EDGE,  "square regions are token-bound BELOW the edge cap");
assert(maxInspectWidth(3000, 4000) < VISION_MAX_EDGE,  "portrait regions are clamped below the edge cap");
assertEq(maxInspectWidth(0, 0),   VISION_MAX_EDGE, "zero dimensions fall back to the edge cap");
assertEq(maxInspectWidth(100, 0), VISION_MAX_EDGE, "zero height falls back to the edge cap");
assertEq(VISION_MAX_EDGE % 28,    0,               "the edge cap sits on a patch boundary");

section("regionPixelDims");

assertDeepEq(regionPixelDims("full", 4000, 3000),        { width: 4000, height: 3000 }, "full → native dimensions");
assertDeepEq(regionPixelDims("square", 4000, 3000),      { width: 3000, height: 3000 }, "square → shorter side both ways");
assertDeepEq(regionPixelDims("1,2,300,400", 4000, 3000), { width: 300,  height: 400 },  "plain IIIF pixels → w,h");
assertDeepEq(regionPixelDims("crop_pixels:1,2,300,400", 4000, 3000), { width: 300, height: 400 },
  "crop_pixels: accepted unnormalized — callers need not strip the prefix first");
// pct carries a 3px inset for server-side rounding.
assertDeepEq(regionPixelDims("pct:0,0,50,50", 4000, 3000), { width: 1997, height: 1497 }, "pct → percentage minus the 3px rounding inset");
assertDeepEq(regionPixelDims("pct:0,0,0.01,0.01", 4000, 3000), { width: 1, height: 1 }, "tiny pct clamps to 1px, never 0 or negative");
assertDeepEq(regionPixelDims("nonsense", 4000, 3000),    { width: 4000, height: 3000 }, "unrecognized → native dimensions");

// ── Summary ──────────────────────────────────────────────────────

console.log(`\n${"═".repeat(60)}`);
console.log(`  Passed: ${passed}  Failed: ${failed}`);
if (failures.length > 0) {
  console.log(`\n  Failures:`);
  for (const f of failures) console.log(`    ✗ ${f}`);
}
console.log(`${"═".repeat(60)}\n`);

process.exit(failed > 0 ? 1 : 0);
