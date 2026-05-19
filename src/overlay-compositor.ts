import sharp from "sharp";

export interface OverlayInput {
  region: string;
  label?: string;
  color?: string;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Coordinate reference for a single inspect call: the crop's pixel rect within
 * the full image, plus the full image's own dimensions (needed to resolve any
 * pct-formatted overlay regions back to pixels).
 */
export interface CropFrame {
  rect: Rect;
  imageWidth: number;
  imageHeight: number;
}

/**
 * Resolve an IIIF region string to a pixel rect within the full image.
 * Accepts "full", "square", "x,y,w,h", or "pct:x,y,w,h". The `crop_pixels:`
 * prefix is already stripped upstream, so plain pixels are the form we see.
 * Returns null for unrecognised inputs.
 */
export function computeCropRect(
  iiifRegion: string,
  imageWidth: number,
  imageHeight: number,
): Rect | null {
  if (iiifRegion === "full") {
    return { x: 0, y: 0, w: imageWidth, h: imageHeight };
  }
  if (iiifRegion === "square") {
    const side = Math.min(imageWidth, imageHeight);
    return {
      x: Math.floor((imageWidth - side) / 2),
      y: Math.floor((imageHeight - side) / 2),
      w: side,
      h: side,
    };
  }
  const pct = iiifRegion.match(/^pct:([0-9.]+),([0-9.]+),([0-9.]+),([0-9.]+)$/);
  if (pct) {
    return {
      x: (parseFloat(pct[1]) / 100) * imageWidth,
      y: (parseFloat(pct[2]) / 100) * imageHeight,
      w: (parseFloat(pct[3]) / 100) * imageWidth,
      h: (parseFloat(pct[4]) / 100) * imageHeight,
    };
  }
  const px = iiifRegion.match(/^(\d+),(\d+),(\d+),(\d+)$/);
  if (px) {
    return {
      x: parseInt(px[1], 10),
      y: parseInt(px[2], 10),
      w: parseInt(px[3], 10),
      h: parseInt(px[4], 10),
    };
  }
  return null;
}

/**
 * Project an overlay region (in full-image coordinates) into crop-local pixel
 * coordinates. `cropPxWidth`/`cropPxHeight` are the rendered crop's actual
 * JPEG dimensions. Returns null if the overlay is unparseable, zero-area, or
 * falls entirely outside the crop.
 */
export function projectOverlayToCrop(
  overlayRegion: string,
  frame: CropFrame,
  cropPxWidth: number,
  cropPxHeight: number,
): Rect | null {
  const oFull = computeCropRect(overlayRegion, frame.imageWidth, frame.imageHeight);
  if (!oFull) return null;
  if (oFull.w <= 0 || oFull.h <= 0) return null;

  const scaleX = cropPxWidth / frame.rect.w;
  const scaleY = cropPxHeight / frame.rect.h;
  const local: Rect = {
    x: (oFull.x - frame.rect.x) * scaleX,
    y: (oFull.y - frame.rect.y) * scaleY,
    w: oFull.w * scaleX,
    h: oFull.h * scaleY,
  };
  // Reject overlays that miss the crop entirely. SVG viewBox clips the
  // partially-visible ones, so we keep anything that intersects.
  if (
    local.x + local.w <= 0 ||
    local.y + local.h <= 0 ||
    local.x >= cropPxWidth ||
    local.y >= cropPxHeight
  ) {
    return null;
  }
  return local;
}

export function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => {
    switch (c) {
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "&": return "&amp;";
      case '"': return "&quot;";
      case "'": return "&apos;";
      default: return c;
    }
  });
}

/** Truncate raw labels before XML-escaping. Avoids `&amp;` (5 chars) eating
 *  into the visible budget and ensures the on-image text stays compact. */
export function truncateLabel(label: string, maxChars = 32): string {
  if (label.length <= maxChars) return label;
  return label.slice(0, maxChars - 1) + "…";
}

/** Build the `<rect>` + `<text>` pair for a single overlay's label tag.
 *  Positioned above the rect when there's vertical room, otherwise inside
 *  the top edge. The text carries a black halo (paint-order:stroke) so it
 *  stays legible on either light or dark tag fills. */
function buildLabelTagSvg(
  rawLabel: string,
  rect: Rect,
  jpegW: number,
  jpegH: number,
  color: string,
): string {
  const truncated = truncateLabel(rawLabel, 32);
  const escaped = escapeXml(truncated);
  const fontSize = Math.max(jpegW, jpegH) * 0.025;
  const padX = fontSize * 0.35;
  const padY = fontSize * 0.18;
  const charW = fontSize * 0.55;
  const tagW = Math.min(jpegW, truncated.length * charW + padX * 2);
  const tagH = fontSize + padY * 2;

  const tagX = Math.max(0, Math.min(jpegW - tagW, rect.x));
  const tagY = rect.y - tagH >= 0 ? rect.y - tagH : rect.y;
  const textX = tagX + padX;
  const textY = tagY + padY + fontSize * 0.85;
  const halo = (fontSize * 0.12).toFixed(2);

  return (
    `<rect x="${tagX.toFixed(2)}" y="${tagY.toFixed(2)}" ` +
    `width="${tagW.toFixed(2)}" height="${tagH.toFixed(2)}" ` +
    `fill="${color}" opacity="0.92"/>` +
    `<text x="${textX.toFixed(2)}" y="${textY.toFixed(2)}" ` +
    `font-family="sans-serif" font-size="${fontSize.toFixed(2)}" font-weight="bold" ` +
    `fill="white" stroke="black" stroke-width="${halo}" ` +
    `paint-order="stroke" stroke-linejoin="round">${escaped}</text>`
  );
}

export interface CompositeResult {
  buffer: Buffer;
  mimeType: string;
  rendered: number;
  skipped: number;
  width?: number;
  height?: number;
}

const JPEG_MIME = "image/jpeg";
const DEFAULT_OVERLAY_COLOR = "#ff6b35";

export async function readImageDimensions(imageBytes: Buffer): Promise<{ width?: number; height?: number }> {
  const meta = await sharp(imageBytes).metadata();
  return { width: meta.width, height: meta.height };
}

/**
 * Draw stroke-only rectangles for each visible overlay onto the crop JPEG.
 * Overlays that fall outside the crop are silently skipped (counted).
 */
export async function compositeOverlays(
  jpegBytes: Buffer,
  overlays: OverlayInput[],
  frame: CropFrame,
  { strokeWidth = 3, defaultColor = DEFAULT_OVERLAY_COLOR }: { strokeWidth?: number; defaultColor?: string } = {},
): Promise<CompositeResult> {
  const image = sharp(jpegBytes);
  const meta = await image.metadata();
  const jpegW = meta.width;
  const jpegH = meta.height;
  if (jpegW == null || jpegH == null) {
    return { buffer: jpegBytes, mimeType: JPEG_MIME, rendered: 0, skipped: overlays.length, width: jpegW, height: jpegH };
  }

  const elements: string[] = [];
  let rendered = 0;
  let skipped = 0;
  for (const overlay of overlays) {
    const local = projectOverlayToCrop(overlay.region, frame, jpegW, jpegH);
    if (!local) { skipped++; continue; }
    const color = escapeXml(overlay.color ?? defaultColor);
    elements.push(
      `<rect x="${local.x.toFixed(2)}" y="${local.y.toFixed(2)}" ` +
      `width="${local.w.toFixed(2)}" height="${local.h.toFixed(2)}" ` +
      `fill="none" stroke="${color}" stroke-width="${strokeWidth}"/>`,
    );
    if (overlay.label && overlay.label.length > 0) {
      elements.push(buildLabelTagSvg(overlay.label, local, jpegW, jpegH, color));
    }
    rendered++;
  }

  if (rendered === 0) {
    return { buffer: jpegBytes, mimeType: JPEG_MIME, rendered: 0, skipped, width: jpegW, height: jpegH };
  }

  const svg =
    `<svg viewBox="0 0 ${jpegW} ${jpegH}" width="${jpegW}" height="${jpegH}" ` +
    `xmlns="http://www.w3.org/2000/svg">${elements.join("")}</svg>`;
  const buffer = await image
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 85 })
    .toBuffer();

  return { buffer, mimeType: JPEG_MIME, rendered, skipped, width: jpegW, height: jpegH };
}
