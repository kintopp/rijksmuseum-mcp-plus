/**
 * Tests for overlay-extract-ground-truth.mjs.
 * Fixture: scripts/tests/fixtures/overlay-test.graffle (4 rectangles).
 * Run:  node scripts/tests/test-overlay-extract.mjs
 */
import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { extractGroundTruth } from "./overlay-extract-ground-truth.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fixtures/overlay-test.graffle");

const gt = await extractGroundTruth(FIXTURE);

assert.equal(gt.sheet, "SK-A-2152", "sheet title");
assert.deepEqual(gt.image.bounds_px, [0, 0, 1200, 663], "image bounds");
assert.equal(gt.image.file, "image1.jpg", "image file name");
assert.equal(gt.features.length, 4, "four rectangles extracted");

const byId = (id) => gt.features.find((f) => f.id === id);

const grasshopper = byId(12);
assert.ok(grasshopper, "ID 12 present");
assert.equal(grasshopper.label, "Grasshopper", "ID 12 label");
assert.equal(grasshopper.layer, "Layer 2", "ID 12 layer");
assert.equal(grasshopper.color, "cyan", "ID 12 color");
assert.deepEqual(grasshopper.bounds_px, [1062.8, 514.6, 107.2, 70.0], "ID 12 bounds_px");
assert.deepEqual(
  grasshopper.bbox_pct.map((n) => Math.round(n * 100) / 100),
  [88.57, 77.62, 8.93, 10.56],
  "ID 12 bbox_pct",
);

const spider = byId(11);
assert.equal(spider.label, "Spider", "ID 11 label");
assert.equal(spider.layer, "Layer 2", "ID 11 layer");
assert.equal(spider.color, "cyan", "ID 11 color");

const green9 = byId(9);
assert.equal(green9.label, null, "ID 9 label is null");
assert.equal(green9.layer, "Layer 1", "ID 9 layer");
assert.equal(green9.color, "green", "ID 9 color");

const green7 = byId(7);
assert.equal(green7.label, null, "ID 7 label is null");
assert.equal(green7.layer, "Layer 1", "ID 7 layer");
assert.deepEqual(green7.bounds_px, [426.5, 481.5, 98, 81], "ID 7 bounds_px");

console.log("test-overlay-extract: PASS (", 14, "assertions)");
