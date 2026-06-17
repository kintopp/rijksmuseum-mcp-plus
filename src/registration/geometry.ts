// ─── Geometry helpers (pure) ─────────────────────────────────────────

import { type CropLocalSize } from "./state.js";

// Re-export CropLocalSize so callers can import it from here too (avoids
// forcing them to know which sub-module owns the definition).
export type { CropLocalSize };

// Exported for testing
export function regionToPixels(region: string, w: number, h: number): string | undefined {
  const p = parsePctRegion(region);
  if (!p) return undefined;
  return `${Math.round(p[0] * w / 100)},${Math.round(p[1] * h / 100)},${Math.round(p[2] * w / 100)},${Math.round(p[3] * h / 100)}`;
}

// Exported for testing
/**
 * Compute a ready-to-paste pct: crop for verifying a placed overlay via
 * inspect_artwork_image(show_overlays:true). The result is centred on the
 * overlay and expanded to ≥1.4× the overlay's footprint, ≥12% per axis,
 * shift-clamped to stay inside 0–100. The 12% floor keeps the overlay
 * visible after the 448 px clamp that show_overlays applies.
 *
 * Returns undefined for full/square/unparseable inputs or when image
 * dimensions are missing.
 */
export function computeVerificationRegion(
  region: string,
  imageWidth?: number,
  imageHeight?: number,
): string | undefined {
  if (!imageWidth || !imageHeight) return undefined;
  if (region === "full" || region === "square") return undefined;

  let x: number, y: number, w: number, h: number;
  const pct = parsePctRegion(region);
  if (pct) {
    [x, y, w, h] = pct;
  } else {
    const cp = parseCropPixelsRegion(region);
    const plainMatch = region.match(/^(\d+),(\d+),(\d+),(\d+)$/);
    const px: [number, number, number, number] | null = cp
      ?? (plainMatch
        ? [parseInt(plainMatch[1], 10), parseInt(plainMatch[2], 10), parseInt(plainMatch[3], 10), parseInt(plainMatch[4], 10)]
        : null);
    if (!px) return undefined;
    x = (px[0] / imageWidth) * 100;
    y = (px[1] / imageHeight) * 100;
    w = (px[2] / imageWidth) * 100;
    h = (px[3] / imageHeight) * 100;
  }
  if (w <= 0 || h <= 0) return undefined;

  const cx = x + w / 2;
  const cy = y + h / 2;
  const vw = Math.min(100, Math.max(w * 1.4, 12));
  const vh = Math.min(100, Math.max(h * 1.4, 12));
  const vx = Math.max(0, Math.min(100 - vw, cx - vw / 2));
  const vy = Math.max(0, Math.min(100 - vh, cy - vh / 2));

  const fmt = (n: number) => {
    const s = n.toFixed(1);
    return s.endsWith(".0") ? s.slice(0, -2) : s;
  };
  return `pct:${fmt(vx)},${fmt(vy)},${fmt(vw)},${fmt(vh)}`;
}

// Exported for testing
export function parsePctRegion(region: string): [number, number, number, number] | null {
  const m = region.match(/^pct:([0-9.]+),([0-9.]+),([0-9.]+),([0-9.]+)$/);
  if (!m) return null;
  return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]), parseFloat(m[4])];
}

// Exported for testing
export function parseCropPixelsRegion(region: string): [number, number, number, number] | null {
  const m = region.match(/^crop_pixels:(\d+),(\d+),(\d+),(\d+)$/);
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10), parseInt(m[4], 10)];
}

// Exported for testing
/** Strip `crop_pixels:` prefix, return plain IIIF pixel region. */
export function cropPixelsToIiifPixels(region: string): string | null {
  const p = parseCropPixelsRegion(region);
  if (!p) return null;
  return `${p[0]},${p[1]},${p[2]},${p[3]}`;
}

export interface OobWarning {
  warning: "overlay_region_out_of_bounds";
  details: {
    requested: string;
    clamped_to: string;
    issue: string;
    valid_range: string;
  };
}

/** Shape an out-of-bounds error: `emit` returns a tool error in the caller's format. */
export function oobError<E>(oob: OobWarning, hint: string, emit: (error: string, text?: string) => E): E {
  const payload = JSON.stringify(oob, null, 2);
  return emit(`overlay_region_out_of_bounds: ${oob.details.issue}`, `${payload}\n\n${hint}`);
}

// Exported for testing
/**
 * Validate region bounds. Returns null if in-bounds (or bounds-check skipped).
 * For pct: always checkable. For crop_pixels/plain-pixels: requires imgW/imgH.
 */
export function checkRegionBounds(
  region: string,
  imgW?: number,
  imgH?: number,
): OobWarning | null {
  if (region === "full" || region === "square") return null;

  const pct = parsePctRegion(region);
  if (pct) {
    const [x, y, w, h] = pct;
    const issues: string[] = [];
    if (x < 0 || x > 100) issues.push(`x=${x} outside 0–100`);
    if (y < 0 || y > 100) issues.push(`y=${y} outside 0–100`);
    if (w <= 0) issues.push(`w=${w} must be > 0`);
    if (h <= 0) issues.push(`h=${h} must be > 0`);
    if (x + w > 100.01) issues.push(`x+w=${(x + w).toFixed(2)} exceeds 100`);
    if (y + h > 100.01) issues.push(`y+h=${(y + h).toFixed(2)} exceeds 100`);
    if (issues.length === 0) return null;
    const cx = Math.max(0, Math.min(100, x));
    const cy = Math.max(0, Math.min(100, y));
    const cw = Math.max(0, Math.min(100 - cx, w));
    const ch = Math.max(0, Math.min(100 - cy, h));
    return {
      warning: "overlay_region_out_of_bounds",
      details: {
        requested: region,
        clamped_to: `pct:${cx},${cy},${cw},${ch}`,
        issue: issues.join("; "),
        valid_range: "each value must be between 0 and 100, and x+w, y+h must not exceed 100",
      },
    };
  }

  // crop_pixels: or plain IIIF pixels
  const cp = parseCropPixelsRegion(region);
  const plainPixels = region.match(/^(\d+),(\d+),(\d+),(\d+)$/);
  const pixelMatch: [number, number, number, number] | null =
    cp ?? (plainPixels
      ? [parseInt(plainPixels[1], 10), parseInt(plainPixels[2], 10), parseInt(plainPixels[3], 10), parseInt(plainPixels[4], 10)]
      : null);
  if (!pixelMatch) return null;
  const [x, y, w, h] = pixelMatch;
  const issues: string[] = [];
  if (w <= 0) issues.push(`w=${w} must be > 0`);
  if (h <= 0) issues.push(`h=${h} must be > 0`);
  if (imgW != null && imgH != null) {
    if (x < 0 || x >= imgW) issues.push(`x=${x} outside 0–${imgW - 1}`);
    if (y < 0 || y >= imgH) issues.push(`y=${y} outside 0–${imgH - 1}`);
    if (x + w > imgW) issues.push(`x+w=${x + w} exceeds imageWidth=${imgW}`);
    if (y + h > imgH) issues.push(`y+h=${y + h} exceeds imageHeight=${imgH}`);
  }
  if (issues.length === 0) return null;
  const prefix = cp ? "crop_pixels:" : "";
  const cx = imgW != null ? Math.max(0, Math.min(imgW - 1, x)) : x;
  const cy = imgH != null ? Math.max(0, Math.min(imgH - 1, y)) : y;
  const cw = imgW != null ? Math.max(0, Math.min(imgW - cx, w)) : Math.max(0, w);
  const ch = imgH != null ? Math.max(0, Math.min(imgH - cy, h)) : Math.max(0, h);
  return {
    warning: "overlay_region_out_of_bounds",
    details: {
      requested: region,
      clamped_to: `${prefix}${cx},${cy},${cw},${ch}`,
      issue: issues.join("; "),
      valid_range: imgW != null
        ? `x in [0, ${imgW}), y in [0, ${imgH}), x+w ≤ ${imgW}, y+h ≤ ${imgH}, w>0, h>0`
        : "w>0, h>0 (image dimensions unknown — open the viewer with get_artwork_image for stricter checking)",
    },
  };
}

/**
 * Classify how a navigate_viewer call's commands will reach the iframe,
 * given the queue's last-poll timestamp. Pure for unit testing.
 *
 *   delivered_recently         — iframe polled within `recentMs` and will drain on its next tick
 *   queued_waiting_for_viewer  — iframe has polled before but not recently (typical when scrolled offscreen)
 *   no_live_viewer_seen        — no poll has been recorded for this UUID yet
 */
export type DeliveryState =
  | "delivered_recently"
  | "queued_waiting_for_viewer"
  | "no_live_viewer_seen";

export function computeDeliveryState(
  lastPolledAtMs: number | undefined,
  nowMs: number,
  recentMs = 5000,
): DeliveryState {
  if (lastPolledAtMs == null) return "no_live_viewer_seen";
  if (nowMs - lastPolledAtMs < recentMs) return "delivered_recently";
  return "queued_waiting_for_viewer";
}

// Exported for testing
/** Project crop-local pct or crop-local pixel coordinates to full-image pct space. */
export function projectToFullImage(local: string, relativeTo: string, localSize?: CropLocalSize): string | null {
  const o = parsePctRegion(relativeTo);
  if (!o) return null;
  const pct = parsePctRegion(local);
  const px = parseCropPixelsRegion(local);
  if (!pct && !px) return null;
  if (px && !localSize) return null;

  const l = pct ?? [
    (px![0] / localSize!.width) * 100,
    (px![1] / localSize!.height) * 100,
    (px![2] / localSize!.width) * 100,
    (px![3] / localSize!.height) * 100,
  ];
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const fx = round2(o[0] + (l[0] / 100) * o[2]);
  const fy = round2(o[1] + (l[1] / 100) * o[3]);
  const fw = round2((l[2] / 100) * o[2]);
  const fh = round2((l[3] / 100) * o[3]);
  return `pct:${fx},${fy},${fw},${fh}`;
}
