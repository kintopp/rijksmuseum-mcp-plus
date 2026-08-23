// ─── Vision-tier sizing ──────────────────────────────────────────────
//
// How large an image may be before the model's vision encoder rescales it.
// Kept apart from geometry.ts: that module owns IIIF region grammar, this one
// owns vision-model billing facts, and the two change for unrelated reasons.

// Vision models bill an image in 28×28-pixel patches — ⌈w/28⌉ × ⌈h/28⌉ visual
// tokens — and downscale anything over budget before the model sees it, so an
// oversized crop costs a fetch and a transfer for pixels that get thrown away.
//
// The edge cap is 71 patches (1988 px) rather than the high-resolution tier's
// 2576 because a request carrying more than 20 image blocks — counting images
// resent from earlier turns — drops every image in it to a ~2000px per-side
// limit. Breaching that rejects the whole request, and since the history is
// resent, every later turn fails identically until the conversation is
// abandoned. Don't round the cap up to the next patch boundary (2016): that is
// over the limit, and the edge check runs on the padded width, so no width
// between 1989 and 2016 is reachable anyway.
export const VISION_PATCH = 28;
export const VISION_MAX_EDGE = 71 * VISION_PATCH; // 1988
export const VISION_MAX_TOKENS = 4784;

// Exported for testing
/** Width or height rounded up to the patch grid — what the encoder measures. */
export function padToPatch(px: number): number {
  return Math.ceil(px / VISION_PATCH) * VISION_PATCH;
}

// Exported for testing
/** Visual-token cost of a w×h image: one token per 28×28 patch. */
export function visualTokens(width: number, height: number): number {
  return Math.ceil(width / VISION_PATCH) * Math.ceil(height / VISION_PATCH);
}

// Exported for testing
/**
 * Largest delivery width for a region of this shape that arrives untouched.
 *
 * IIIF is asked for `{width},` and derives the height, so the height is
 * predicted with ceil() — over-estimating the patch count wastes a few pixels,
 * under-estimating invites the silent server-side downscale this exists to
 * avoid.
 */
export function maxInspectWidth(regionWidth: number, regionHeight: number): number {
  if (!(regionWidth > 0) || !(regionHeight > 0)) return VISION_MAX_EDGE;

  const fits = (w: number): boolean => {
    const h = Math.max(1, Math.ceil(w * regionHeight / regionWidth));
    return padToPatch(w) <= VISION_MAX_EDGE
      && padToPatch(h) <= VISION_MAX_EDGE
      && visualTokens(w, h) <= VISION_MAX_TOKENS;
  };

  // Largest-first, so the first fit is the answer. A binary search would be
  // fewer probes but would rest on an unstated monotonicity invariant; at a
  // couple of microseconds against the IIIF fetch that follows, the scan is
  // not worth the extra thing to prove.
  for (let w = VISION_MAX_EDGE; w > 1; w--) {
    if (fits(w)) return w;
  }
  return 1; // region taller than the edge cap even one pixel wide
}
