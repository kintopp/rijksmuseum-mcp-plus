/**
 * Pure scoring functions for the overlay-accuracy harness.
 * All bboxes are [x, y, w, h] in percent-of-image (0..100) unless noted.
 * Coordinate system: top-left origin, y grows down.
 */

/** Intersection-over-Union for two bboxes in the same coordinate space. */
export function iou(a, b) {
  const [ax, ay, aw, ah] = a;
  const [bx, by, bw, bh] = b;
  const ix1 = Math.max(ax, bx);
  const iy1 = Math.max(ay, by);
  const ix2 = Math.min(ax + aw, bx + bw);
  const iy2 = Math.min(ay + ah, by + bh);
  if (ix2 <= ix1 || iy2 <= iy1) return 0;
  const inter = (ix2 - ix1) * (iy2 - iy1);
  const union = aw * ah + bw * bh - inter;
  return union > 0 ? inter / union : 0;
}

/** Euclidean distance between bbox centers, in pct of image width (same unit as inputs). */
export function centerOffsetPct(a, b) {
  const [ax, ay, aw, ah] = a;
  const [bx, by, bw, bh] = b;
  const dx = (ax + aw / 2) - (bx + bw / 2);
  const dy = (ay + ah / 2) - (by + bh / 2);
  return Math.sqrt(dx * dx + dy * dy);
}

/** area(predicted) / area(truth). >1 = predicted is larger; <1 = smaller. */
export function sizeRatio(predicted, truth) {
  const [, , pw, ph] = predicted;
  const [, , tw, th] = truth;
  const ta = tw * th;
  return ta > 0 ? (pw * ph) / ta : NaN;
}

/**
 * Project a crop-local pct bbox into full-image pct space.
 * Mirrors the MCP server's projectToFullImage (src/registration.ts).
 * @param local       [x, y, w, h] — percentages within the crop
 * @param relativeTo  [x, y, w, h] — the crop's placement in full-image pct
 */
export function projectLocalToFull(local, relativeTo) {
  const [lx, ly, lw, lh] = local;
  const [ox, oy, ow, oh] = relativeTo;
  const r = (n) => Math.round(n * 100) / 100;
  return [
    r(ox + (lx / 100) * ow),
    r(oy + (ly / 100) * oh),
    r((lw / 100) * ow),
    r((lh / 100) * oh),
  ];
}

/** Clamp a bbox to [0, max] in each dimension. Returns { clamped: bool, bbox }. */
export function clampToImage(bbox, max = 100) {
  let [x, y, w, h] = bbox;
  let clamped = false;
  if (x < 0) { w += x; x = 0; clamped = true; }
  if (y < 0) { h += y; y = 0; clamped = true; }
  if (x + w > max) { w = max - x; clamped = true; }
  if (y + h > max) { h = max - y; clamped = true; }
  w = Math.max(0, w);
  h = Math.max(0, h);
  return { clamped, bbox: [x, y, w, h] };
}
