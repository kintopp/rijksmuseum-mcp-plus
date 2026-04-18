/**
 * Parse an OmniGraffle 7+ zipped .graffle file into a ground-truth JSON payload.
 *
 * Usage as library:
 *   import { extractGroundTruth } from "./overlay-extract-ground-truth.mjs";
 *   const gt = await extractGroundTruth("/path/to/file.graffle");
 *
 * Usage as CLI:
 *   node scripts/tests/overlay-extract-ground-truth.mjs <in.graffle> [out.json]
 *
 * Format notes (OmniGraffle 7 zip bundle):
 *  - Container is a ZIP with data.plist (binary) + image*.jpg.
 *  - data.plist contains Sheets[0].GraphicsList — array of graphics, one of which has
 *    an ImageID key (the artwork placement) and the rest are ShapedGraphics (bboxes).
 *  - Graphic Bounds is a string like "{{x, y}, {w, h}}"; Layer is an integer index
 *    into Sheets[0].Layers[] whose Name gives the layer label.
 *  - Labels live in graphic.Text.Text as RTF; the plain text is after the last \cfN marker.
 *  - Stroke colour under graphic.Style.stroke.Color.{r,g,b} (floats 0–1).
 */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { argv } from "node:process";

import AdmZip from "adm-zip";
import bplistParser from "bplist-parser";

const BOUNDS_RE = /^\{\{\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\}\s*,\s*\{\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\}\}$/;
const RTF_LABEL_RE = /\\cf\d+\s+([^\\{}]+?)\}?\s*$/;

/** @returns {Promise<{source:string, sheet:string, image:{file:string|null, bounds_px:number[]}, features:object[]}>} */
export async function extractGroundTruth(graffleFilePath) {
  const zip = new AdmZip(graffleFilePath);
  const entry = zip.getEntry("data.plist");
  if (!entry) throw new Error(`No data.plist in ${graffleFilePath}`);
  const plistBuf = entry.getData();

  const [plist] = bplistParser.parseBuffer(plistBuf);
  const sheet = plist.Sheets?.[0];
  if (!sheet) throw new Error("No Sheets[0] in plist");

  const layers = (sheet.Layers ?? []).map((l) => l.Name ?? "");
  const imageList = plist.ImageList ?? [];

  const graphics = sheet.GraphicsList ?? [];
  const imageGraphic = graphics.find((g) => typeof g.ImageID === "number");
  if (!imageGraphic) throw new Error("No graphic with ImageID in GraphicsList");
  const imageBounds = parseBounds(imageGraphic.Bounds);
  const imageFile = imageList[imageGraphic.ImageID - 1] ?? null;

  const features = graphics
    .filter((g) => g !== imageGraphic && g.Class === "ShapedGraphic")
    .map((g) => toFeature(g, layers, imageBounds))
    .sort((a, b) => a.id - b.id);

  return {
    source: path.basename(graffleFilePath),
    sheet: sheet.SheetTitle ?? "",
    image: { file: imageFile, bounds_px: imageBounds.map(round1) },
    features,
  };
}

function toFeature(g, layers, imageBounds) {
  const b = parseBounds(g.Bounds);
  const [ix, iy, iw, ih] = imageBounds;
  const [bx, by, bw, bh] = b;
  const bounds_px = [round1(bx), round1(by), round1(bw), round1(bh)];
  const bbox_pct = [
    round2(((bx - ix) / iw) * 100),
    round2(((by - iy) / ih) * 100),
    round2((bw / iw) * 100),
    round2((bh / ih) * 100),
  ];
  return {
    id: g.ID,
    layer: layers[g.Layer ?? 0] ?? null,
    color: classifyColor(g.Style?.stroke?.Color),
    bounds_px,
    bbox_pct,
    label: extractLabel(g.Text?.Text),
  };
}

function parseBounds(str) {
  const m = BOUNDS_RE.exec(str);
  if (!m) throw new Error(`Bad Bounds string: ${str}`);
  return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]), parseFloat(m[4])];
}

function extractLabel(rtf) {
  if (!rtf || typeof rtf !== "string") return null;
  const m = RTF_LABEL_RE.exec(rtf.trim());
  if (!m) return null;
  const label = m[1].trim();
  return label.length > 0 ? label : null;
}

function classifyColor(c) {
  if (!c) return "unknown";
  const r = c.r ?? 0, g = c.g ?? 0, b = c.b ?? 0;
  if (r < 0.2 && g > 0.8 && b < 0.2) return "green";
  if (r < 0.2 && g > 0.8 && b > 0.8) return "cyan";
  if (r > 0.8 && g < 0.2 && b < 0.2) return "red";
  if (r > 0.8 && g > 0.8 && b < 0.2) return "yellow";
  if (r > 0.8 && g < 0.4 && b > 0.8) return "magenta";
  return "other";
}

function round1(n) { return Math.round(n * 10) / 10; }
function round2(n) { return Math.round(n * 100) / 100; }

// ── CLI ──────────────────────────────────────────────────────────────

if (import.meta.url === `file://${fileURLToPath(import.meta.url)}` && argv[1]?.endsWith("overlay-extract-ground-truth.mjs")) {
  const [, , inPath, outPath] = argv;
  if (!inPath) {
    console.error("usage: overlay-extract-ground-truth.mjs <in.graffle> [out.json]");
    process.exit(2);
  }
  const gt = await extractGroundTruth(inPath);
  const json = JSON.stringify(gt, null, 2);
  if (outPath) {
    await writeFile(outPath, json + "\n");
    console.error(`wrote ${outPath} (${gt.features.length} features)`);
  } else {
    console.log(json);
  }
}