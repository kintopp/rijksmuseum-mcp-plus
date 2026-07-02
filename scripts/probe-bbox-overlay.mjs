// Probe for the overlay-binding accuracy eval protocol (bbox grounding). See plans/051.
// Usage:
//   crop:  node scripts/probe-bbox-overlay.mjs crop <in.jpg> <out.jpg> <pctX> <pctY> <pctW> <pctH>
//   boxes: node scripts/probe-bbox-overlay.mjs boxes <in.jpg> <out.jpg> <label:color:pctX,pctY,pctW,pctH> [...]
import sharp from "sharp";

const [mode, inPath, outPath, ...rest] = process.argv.slice(2);

const img = sharp(inPath);
const meta = await img.metadata();
const W = meta.width, H = meta.height;

if (mode === "crop") {
  const [x, y, w, h] = rest.map(Number);
  const left = Math.round((x / 100) * W);
  const top = Math.round((y / 100) * H);
  const width = Math.min(W - left, Math.round((w / 100) * W));
  const height = Math.min(H - top, Math.round((h / 100) * H));
  await img.extract({ left, top, width, height }).jpeg({ quality: 90 }).toFile(outPath);
  console.log(`crop ${width}x${height} from ${W}x${H} at (${left},${top}) -> ${outPath}`);
} else if (mode === "boxes") {
  const elements = [];
  for (const spec of rest) {
    const [label, color, coords] = spec.split(":");
    const [x, y, w, h] = coords.split(",").map(Number);
    const rx = (x / 100) * W, ry = (y / 100) * H;
    const rw = (w / 100) * W, rh = (h / 100) * H;
    const sw = Math.max(3, Math.round(W / 500));
    elements.push(
      `<rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" fill="none" stroke="${color}" stroke-width="${sw}"/>`,
      `<text x="${rx + 4}" y="${Math.max(20, ry - 8)}" font-family="sans-serif" font-size="${Math.round(W / 55)}" font-weight="bold" fill="${color}" stroke="black" stroke-width="1" paint-order="stroke">${label}</text>`,
    );
  }
  const svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${elements.join("")}</svg>`;
  await img.composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).jpeg({ quality: 88 }).toFile(outPath);
  console.log(`boxes -> ${outPath}`);
} else {
  console.error("unknown mode");
  process.exit(1);
}
