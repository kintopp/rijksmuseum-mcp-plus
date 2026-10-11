/**
 * Viewer build output validation tests.
 *
 * Verifies that the Vite-built viewer HTML is a self-contained single file
 * with no external CDN dependencies, and stays within size budget.
 *
 * Run: node scripts/tests/test-viewer-build.mjs
 * Requires: npm run build:ui (or npm run build) first.
 */

import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const htmlPath = resolve(__dirname, '../../dist/apps/index.html');

let pass = 0;
let fail = 0;

function assert(condition, label) {
  if (condition) {
    pass++;
    console.log(`  \x1b[32mPASS\x1b[0m  ${label}`);
  } else {
    fail++;
    console.error(`  \x1b[31mFAIL\x1b[0m  ${label}`);
  }
}

// ── Load built HTML ──────────────────────────────────────────────────

let html;
try {
  html = readFileSync(htmlPath, 'utf-8');
} catch {
  console.error(`\n  \x1b[31mFAIL\x1b[0m  dist/apps/index.html not found — run npm run build:ui first\n`);
  process.exit(1);
}

console.log('\nViewer build tests\n');

// ── 1. No external <script> tags ─────────────────────────────────────

const externalScripts = html.match(/<script[^>]+src=["']https?:\/\//gi);
assert(
  !externalScripts,
  `No external <script> tags (found ${externalScripts?.length ?? 0})`
);

// ── 2. No CDN URLs ──────────────────────────────────────────────────

assert(
  !html.includes('cdn.jsdelivr.net'),
  'No cdn.jsdelivr.net references'
);
assert(
  !html.includes('unpkg.com'),
  'No unpkg.com references'
);

// ── 3. OpenSeadragon bundled ─────────────────────────────────────────

assert(
  html.includes('OpenSeadragon') || html.includes('TiledImage'),
  'OpenSeadragon code is bundled (OpenSeadragon or TiledImage found)'
);

// ── 4. ext-apps SDK bundled ──────────────────────────────────────────

// Not `postMessage`: OpenSeadragon contains it too, so it can't tell whether
// ext-apps made it into the bundle.
assert(
  html.includes('callServerTool'),
  'ext-apps SDK is bundled (callServerTool found)'
);

// ── 5. Related-artwork navigation controls ──────────────────────────

assert(
  html.includes('id="prev-related"') && html.includes('id="next-related"'),
  'Toolbar exposes prev-related / next-related buttons',
);

// ── 6. Size budget ──────────────────────────────────────────────────

const rawBytes = Buffer.byteLength(html, 'utf-8');
const gzBytes = gzipSync(html).length;
const rawKB = (rawBytes / 1024).toFixed(1);
const gzKB = (gzBytes / 1024).toFixed(1);

console.log(`\n  Size: ${rawKB} KB raw, ${gzKB} KB gzipped\n`);

assert(rawBytes < 750_000, `Raw size under 750 KB (${rawKB} KB)`);
assert(gzBytes < 200_000, `Gzipped size under 200 KB (${gzKB} KB)`);

// ── Summary ─────────────────────────────────────────────────────────

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
