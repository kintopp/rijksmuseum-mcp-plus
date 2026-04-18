/**
 * Tests for overlay-scoring.mjs pure functions.
 * Run:  node scripts/tests/test-overlay-scoring.mjs
 */
import { strict as assert } from "node:assert";
import {
  iou,
  centerOffsetPct,
  sizeRatio,
  projectLocalToFull,
  clampToImage,
} from "./overlay-scoring.mjs";

assert.equal(iou([10, 10, 20, 20], [10, 10, 20, 20]), 1, "identical boxes → 1");
assert.equal(iou([0, 0, 10, 10], [20, 20, 10, 10]), 0, "disjoint → 0");
assert.equal(
  Math.round(iou([0, 0, 10, 10], [5, 0, 10, 10]) * 1000) / 1000,
  0.333,
  "half-overlap → ≈0.333",
);

assert.equal(centerOffsetPct([0, 0, 10, 10], [0, 0, 10, 10]), 0, "same center → 0");
assert.equal(centerOffsetPct([0, 0, 10, 10], [10, 0, 10, 10]), 10, "10% horiz offset");

assert.equal(sizeRatio([0, 0, 10, 10], [0, 0, 10, 10]), 1, "equal sizes");
assert.equal(sizeRatio([0, 0, 10, 10], [0, 0, 20, 20]), 0.25, "predicted is quarter-size");
assert.equal(sizeRatio([0, 0, 20, 20], [0, 0, 10, 10]), 4, "predicted is 4x size");

// projection math: relativeTo=[10,10,50,50], local=[20,40,40,20]
//   fx = 10 + (20/100)*50 = 20
//   fy = 10 + (40/100)*50 = 30
//   fw = (40/100)*50 = 20
//   fh = (20/100)*50 = 10
assert.deepEqual(
  projectLocalToFull([20, 40, 40, 20], [10, 10, 50, 50]),
  [20, 30, 20, 10],
  "projection math matches server",
);
assert.deepEqual(
  projectLocalToFull([25, 25, 50, 50], [0, 0, 100, 100]),
  [25, 25, 50, 50],
  "relativeTo full = identity",
);

// clampToImage: in-bounds → unchanged
const c1 = clampToImage([10, 10, 20, 20], 100);
assert.equal(c1.clamped, false, "in-bounds not clamped");
assert.deepEqual(c1.bbox, [10, 10, 20, 20], "in-bounds bbox unchanged");

// clampToImage: right-edge overflow
const c2 = clampToImage([90, 10, 20, 20], 100);
assert.equal(c2.clamped, true, "right overflow clamped");
assert.deepEqual(c2.bbox, [90, 10, 10, 20], "clamped to fit");

// clampToImage: negative x
const c3 = clampToImage([-5, 10, 20, 20], 100);
assert.equal(c3.clamped, true, "negative x clamped");
assert.deepEqual(c3.bbox, [0, 10, 15, 20], "clamped negative x");

console.log("test-overlay-scoring: PASS ( 14 assertions)");
