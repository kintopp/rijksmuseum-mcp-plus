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
  computeDeliveryState,
  computeVerificationRegion,
  parseDimRange,
  parseSortParam,
  stripNullCoerceBool,
} from "../../dist/registration.js";

import {
  computeCropRect,
  projectOverlayToCrop,
  compositeOverlays,
  truncateLabel,
  escapeXml,
} from "../../dist/overlay-compositor.js";

import sharp from "sharp";

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

// ── computeVerificationRegion (#337) ────────────────────────────

section("computeVerificationRegion");

// Normal overlay well inside bounds — expanded to ≥1.4× and ≥12% per axis.
{
  const vr = computeVerificationRegion("pct:38,22,28,22", 1000, 800);
  assert(vr?.startsWith("pct:"), `pct: prefix (got ${vr})`);
  const m = vr.match(/^pct:([0-9.]+),([0-9.]+),([0-9.]+),([0-9.]+)$/);
  assert(m != null, "parseable");
  const [vx, vy, vw, vh] = m.slice(1).map(Number);
  // 28 * 1.4 = 39.2 → vw, 22 * 1.4 = 30.8 → vh
  assert(Math.abs(vw - 39.2) < 0.1, `w expanded to 1.4× (got ${vw})`);
  assert(Math.abs(vh - 30.8) < 0.1, `h expanded to 1.4× (got ${vh})`);
  // Centred on overlay centre (38+14, 22+11) = (52, 33)
  assert(Math.abs(vx + vw / 2 - 52) < 0.1, "centred on overlay x-centre");
  assert(Math.abs(vy + vh / 2 - 33) < 0.1, "centred on overlay y-centre");
}

// Tiny overlay → 12% floor on each axis.
{
  const vr = computeVerificationRegion("pct:50,50,5,5", 1000, 800);
  const m = vr.match(/^pct:([0-9.]+),([0-9.]+),([0-9.]+),([0-9.]+)$/);
  const [, , vw, vh] = m.slice(1).map(Number);
  assert(Math.abs(vw - 12) < 0.01, `w floored to 12 (got ${vw})`);
  assert(Math.abs(vh - 12) < 0.01, `h floored to 12 (got ${vh})`);
}

// Edge overlay → shift-clamped so x+w ≤ 100, contains original.
{
  const vr = computeVerificationRegion("pct:95,95,5,5", 1000, 800);
  const m = vr.match(/^pct:([0-9.]+),([0-9.]+),([0-9.]+),([0-9.]+)$/);
  const [vx, vy, vw, vh] = m.slice(1).map(Number);
  assert(vx + vw <= 100.001, `edge overlay: x+w ≤ 100 (got ${vx + vw})`);
  assert(vy + vh <= 100.001, `edge overlay: y+h ≤ 100 (got ${vy + vh})`);
  // Contains the original overlay (95,95,5,5)
  assert(vx <= 95.001 && vy <= 95.001 && vx + vw + 0.001 >= 100 && vy + vh + 0.001 >= 100,
    "edge overlay: verification rect contains original");
}

// Plain pixels input → converted via image dimensions.
{
  const vr = computeVerificationRegion("100,80,200,160", 1000, 800);
  // Equivalent pct: 10,10,20,20. 20*1.4=28; centred on (20,20).
  const m = vr.match(/^pct:([0-9.]+),([0-9.]+),([0-9.]+),([0-9.]+)$/);
  assert(m != null, "plain pixels converted to pct");
  const [vx, vy, vw, vh] = m.slice(1).map(Number);
  assert(Math.abs(vw - 28) < 0.1, `pixel w expanded (got ${vw})`);
  assert(Math.abs(vh - 28) < 0.1, `pixel h expanded (got ${vh})`);
  assert(Math.abs(vx + vw / 2 - 20) < 0.1, "pixel: centred");
  assert(Math.abs(vy + vh / 2 - 20) < 0.1, "pixel: centred");
}

// Shape-only inputs → undefined.
assertEq(computeVerificationRegion("full", 1000, 800), undefined, "full → undefined");
assertEq(computeVerificationRegion("square", 1000, 800), undefined, "square → undefined");
assertEq(computeVerificationRegion("bogus", 1000, 800), undefined, "unparseable → undefined");
assertEq(computeVerificationRegion("pct:10,10,20,20"), undefined, "missing dims → undefined");

// ── truncateLabel / escapeXml ───────────────────────────────────

section("truncateLabel + escapeXml");

assertEq(truncateLabel("short"), "short", "short label unchanged");
assertEq(truncateLabel("a".repeat(32)), "a".repeat(32), "exactly 32 chars unchanged");
{
  const t = truncateLabel("a".repeat(50));
  assertEq(t.length, 32, "long label truncated to 32 chars");
  assert(t.endsWith("…"), "long label ends with ellipsis");
}

// Escape AFTER truncate — `&` shouldn't blow up the visible budget.
{
  const raw = "x&y<z>" + "a".repeat(100);
  const truncated = truncateLabel(raw);
  assertEq(truncated.length, 32, "truncate before escape: 32 chars");
  const escaped = escapeXml(truncated);
  assert(!/[<>&](?!amp;|lt;|gt;|quot;|apos;)/.test(escaped),
    "escapeXml replaces all unescaped <, >, & characters");
  assert(escaped.includes("&amp;") && escaped.includes("&lt;") && escaped.includes("&gt;"),
    "escapeXml produces &amp;, &lt;, &gt;");
}

// ── compositeOverlays label rendering (#337) ─────────────────────

section("compositeOverlays labels");

// Build a synthetic JPEG so the test doesn't need network or real artwork.
const testJpeg = await sharp({
  create: { width: 400, height: 300, channels: 3, background: { r: 80, g: 80, b: 80 } },
}).jpeg().toBuffer();

const compFrame = { rect: { x: 0, y: 0, w: 400, h: 300 }, imageWidth: 400, imageHeight: 300 };

const unlabeled = await compositeOverlays(
  testJpeg,
  [{ region: "pct:25,25,50,50", color: "orange" }],
  compFrame,
);
const labeled = await compositeOverlays(
  testJpeg,
  [{ region: "pct:25,25,50,50", color: "orange", label: "Hello" }],
  compFrame,
);
assertEq(unlabeled.rendered, 1, "unlabeled: rendered=1");
assertEq(unlabeled.skipped, 0, "unlabeled: skipped=0");
assertEq(labeled.rendered, 1, "labeled: rendered=1");
assertEq(labeled.skipped, 0, "labeled: skipped=0");
assert(labeled.buffer.length !== unlabeled.buffer.length,
  `labeled composite bytes differ from unlabeled (${labeled.buffer.length} vs ${unlabeled.buffer.length})`);

// Empty-string label is treated as no label — same byte output as unlabeled.
const emptyLabel = await compositeOverlays(
  testJpeg,
  [{ region: "pct:25,25,50,50", color: "orange", label: "" }],
  compFrame,
);
assertEq(emptyLabel.rendered, 1, "empty label: rendered=1");
assert(emptyLabel.buffer.length === unlabeled.buffer.length,
  "empty-string label produces same bytes as no label");

// Multiple labelled overlays still report rendered=2.
const twoLabeled = await compositeOverlays(
  testJpeg,
  [
    { region: "pct:10,10,20,20", color: "red", label: "A" },
    { region: "pct:60,60,20,20", color: "blue", label: "B" },
  ],
  compFrame,
);
assertEq(twoLabeled.rendered, 2, "two labelled overlays: rendered=2");
assertEq(twoLabeled.skipped, 0, "two labelled overlays: skipped=0");

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

// ── Summary ──────────────────────────────────────────────────────

console.log(`\n${"═".repeat(60)}`);
console.log(`  Passed: ${passed}  Failed: ${failed}`);
if (failures.length > 0) {
  console.log(`\n  Failures:`);
  for (const f of failures) console.log(`    ✗ ${f}`);
}
console.log(`${"═".repeat(60)}\n`);

process.exit(failed > 0 ? 1 : 0);
