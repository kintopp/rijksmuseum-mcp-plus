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
 * coordinates. `scale` is the ratio of the rendered crop's pixel width to the
 * crop's full-image pixel width. Returns null if the overlay region is not
 * parseable or if the overlay falls entirely outside the crop.
 */
export function projectOverlayToCrop(
  overlayRegion: string,
  imageWidth: number,
  imageHeight: number,
  cropRect: Rect,
  cropPxWidth: number,
  cropPxHeight: number,
): Rect | null {
  const oFull = computeCropRect(overlayRegion, imageWidth, imageHeight);
  if (!oFull) return null;
  if (oFull.w <= 0 || oFull.h <= 0) return null;

  const scaleX = cropPxWidth / cropRect.w;
  const scaleY = cropPxHeight / cropRect.h;
  const local: Rect = {
    x: (oFull.x - cropRect.x) * scaleX,
    y: (oFull.y - cropRect.y) * scaleY,
    w: oFull.w * scaleX,
    h: oFull.h * scaleY,
  };
  // Reject overlays that miss the crop entirely. SVG viewBox will clip the
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

function escapeXml(s: string): string {
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

export interface CompositeResult {
  buffer: Buffer;
  mimeType: string;
  rendered: number;
  skipped: number;
}

/**
 * Draw stroke-only rectangles for each visible overlay onto the crop JPEG.
 * Overlays that fall outside the crop are silently skipped (counted).
 */
export async function compositeOverlays(
  jpegBytes: Buffer,
  overlays: OverlayInput[],
  cropRect: Rect,
  imageWidth: number,
  imageHeight: number,
  { strokeWidth = 3, defaultColor = "#ff6b35" }: { strokeWidth?: number; defaultColor?: string } = {},
): Promise<CompositeResult> {
  const image = sharp(jpegBytes);
  const meta = await image.metadata();
  const jpegW = meta.width;
  const jpegH = meta.height;
  if (jpegW == null || jpegH == null) {
    return { buffer: jpegBytes, mimeType: "image/jpeg", rendered: 0, skipped: overlays.length };
  }

  const rects: string[] = [];
  let skipped = 0;
  for (const overlay of overlays) {
    const local = projectOverlayToCrop(
      overlay.region, imageWidth, imageHeight, cropRect, jpegW, jpegH,
    );
    if (!local) { skipped++; continue; }
    const color = escapeXml(overlay.color ?? defaultColor);
    rects.push(
      `<rect x="${local.x.toFixed(2)}" y="${local.y.toFixed(2)}" ` +
      `width="${local.w.toFixed(2)}" height="${local.h.toFixed(2)}" ` +
      `fill="none" stroke="${color}" stroke-width="${strokeWidth}"/>`,
    );
  }

  if (rects.length === 0) {
    return { buffer: jpegBytes, mimeType: "image/jpeg", rendered: 0, skipped };
  }

  const svg =
    `<svg viewBox="0 0 ${jpegW} ${jpegH}" width="${jpegW}" height="${jpegH}" ` +
    `xmlns="http://www.w3.org/2000/svg">${rects.join("")}</svg>`;
  const buffer = await image
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 85 })
    .toBuffer();

  return { buffer, mimeType: "image/jpeg", rendered: rects.length, skipped };
}
