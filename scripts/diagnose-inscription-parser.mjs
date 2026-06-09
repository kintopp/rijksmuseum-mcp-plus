/**
 * Parser-residue diagnostic for the inscription parser (R7 of issue #383).
 *
 * Unlike scripts/build-inscription-report.py (which *describes* what the field
 * contains), this script is *diagnostic*: it runs the shipping parser over the
 * full inscription population and reports how well the normalised vocabulary
 * covers it, so the bucket maps can be tuned against the long tail BEFORE the
 * facet contract is frozen.
 *
 * It imports the parser + maps from dist/ — the single source of truth — so
 * "clean enough" is always measured against the shipping vocabulary, never a
 * hardcoded copy that can drift (per the issue's exit-criterion note).
 *
 * Emits:
 *   - % of segments resolving to a recognised type / placement / technique
 *   - frequency table of unrecognised pre-colon TYPE tokens (field[0])
 *   - frequency table of unrecognised header QUALIFIER tokens (R5 residue)
 *   - the unquoted post-colon tail (values with no transcribed quotes)
 *   - record-composition rollup (transcribed / collector-mark-only / placeholder)
 *
 * Run:  node scripts/diagnose-inscription-parser.mjs [--db PATH] [--limit N]
 * Requires: npm run build (imports from dist/)
 */

import Database from "better-sqlite3";
import {
  parseInscriptions,
  INSCRIPTION_TYPES,
} from "../dist/inscriptions.js";

const args = process.argv.slice(2);
const dbPath = args.includes("--db") ? args[args.indexOf("--db") + 1] : "data/vocabulary.db";
const limit = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : Infinity;

const db = new Database(dbPath, { readonly: true });

// ── Counters ─────────────────────────────────────────────────────

let records = 0;
let segments = 0;
let segWithType = 0;
let segWithPlacement = 0;
let segWithTechnique = 0;
let segWithValue = 0;
let segWithTranscribed = 0;
let segCollectorMark = 0;
let segPlaceholder = 0;

const unknownTypeTokens = new Map();   // raw field[0] that resolved to no bucket
const residueQualifiers = new Map();   // R5 residue: header qualifiers w/ no bucket
const unquotedValues = new Map();      // post-colon values with no quotes (sampled)

// Record-composition (mutually exclusive, matching the report's framing).
let compTranscribed = 0;
let compCollectorMarkOnly = 0;
let compPlaceholderOnly = 0;
let compOther = 0;

function bump(map, key, cap = 400) {
  if (!map.has(key) && map.size >= cap * 50) return; // soft guard on memory
  map.set(key, (map.get(key) ?? 0) + 1);
}

// ── Scan ─────────────────────────────────────────────────────────

const rows = db
  .prepare(
    `SELECT inscription_text FROM artworks
     WHERE inscription_text IS NOT NULL AND TRIM(inscription_text) <> ''`,
  )
  .iterate();

for (const { inscription_text } of rows) {
  if (records >= limit) break;
  records++;
  const parsed = parseInscriptions(inscription_text);

  let anyTranscribed = false;
  let anyMark = false;
  let allPlaceholder = parsed.length > 0;

  for (const s of parsed) {
    segments++;
    if (s.normalizedType) segWithType++;
    else if (s.type) bump(unknownTypeTokens, s.type.toLowerCase());
    if (s.normalizedPlacement) segWithPlacement++;
    if (s.normalizedTechnique) segWithTechnique++;
    if (s.value) segWithValue++;
    if (s.transcribedText.length) { segWithTranscribed++; anyTranscribed = true; }
    if (s.isCollectorMark) { segCollectorMark++; anyMark = true; }
    if (s.isPlaceholder) segPlaceholder++;
    if (!s.isPlaceholder) allPlaceholder = false;

    for (const q of s.unknownQualifiers) bump(residueQualifiers, q.toLowerCase());

    // Unquoted post-colon tail: a value present but no quoted transcription and
    // not a pure collector mark — these are the cataloguer-description residue.
    if (s.value && s.transcribedText.length === 0 && s.collectorMarks.length === 0) {
      const sample = s.value.length > 60 ? s.value.slice(0, 60) + "…" : s.value;
      bump(unquotedValues, sample);
    }
  }

  // Record composition (mutually exclusive, first match wins)
  if (anyTranscribed) compTranscribed++;
  else if (allPlaceholder) compPlaceholderOnly++;
  else if (anyMark) compCollectorMarkOnly++;
  else compOther++;
}

// ── Report ───────────────────────────────────────────────────────

const pct = (n, d) => (d ? ((100 * n) / d).toFixed(1) + "%" : "—");

function topTable(map, title, n = 30) {
  const sorted = [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  console.log(`\n  ${title} (${map.size} distinct)`);
  console.log("  " + "─".repeat(58));
  for (const [tok, c] of sorted) {
    console.log(`    ${String(c).padStart(8)}  ${tok}`);
  }
}

console.log("═".repeat(62));
console.log("  Inscription parser-residue diagnostic (R7, issue #383)");
console.log("═".repeat(62));
console.log(`  DB: ${dbPath}`);
console.log(`  Records with inscription_text: ${records.toLocaleString()}`);
console.log(`  Segments parsed:               ${segments.toLocaleString()}`);

console.log(`\n  ── Segment-level coverage ─────────────────────────────`);
console.log(`    recognised type:       ${pct(segWithType, segments)}  (${segWithType.toLocaleString()})`);
console.log(`    recognised placement:  ${pct(segWithPlacement, segments)}  (${segWithPlacement.toLocaleString()})`);
console.log(`    recognised technique:  ${pct(segWithTechnique, segments)}  (${segWithTechnique.toLocaleString()})`);
console.log(`    has post-colon value:  ${pct(segWithValue, segments)}`);
console.log(`    has transcribed text:  ${pct(segWithTranscribed, segments)}`);
console.log(`    is collector mark:     ${pct(segCollectorMark, segments)}`);
console.log(`    is placeholder:        ${pct(segPlaceholder, segments)}`);

console.log(`\n  ── Record composition (mutually exclusive) ────────────`);
console.log(`    transcribed text present:   ${pct(compTranscribed, records)}`);
console.log(`    collector-mark only:        ${pct(compCollectorMarkOnly, records)}`);
console.log(`    placeholder / label only:   ${pct(compPlaceholderOnly, records)}`);
console.log(`    other:                      ${pct(compOther, records)}`);

console.log(`\n  Closed type vocabulary: ${INSCRIPTION_TYPES.length} buckets`);

topTable(unknownTypeTokens, "Unrecognised TYPE tokens (field[0]) — tune or accept as null");
topTable(residueQualifiers, "Unrecognised HEADER QUALIFIERS (R5 residue) — placement/technique gaps");
topTable(unquotedValues, "Unquoted post-colon tail (cataloguer description, not transcription)", 20);

db.close();
