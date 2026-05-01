/**
 * Translate audit-provenance-batch --mode party-extraction output into the
 * shape that writeback-field-corrections.mjs expects.
 *
 * The two scripts disagree on field names:
 *   - audit  emits: data.extractions[]   (with parties[]: {name, position, role})
 *   - writeback reads: data.corrections[] (with field: "parties", new_party: {...})
 *
 * Each extraction may carry multiple parties (sender + receiver + agent).
 * Each party becomes one correction row: field="parties", new_party={name,role,position}.
 *
 * Usage:
 *   node scripts/translate-party-extraction.mjs \
 *     --input  data/audit/audit-party-extraction-2026-04-30.json \
 *     --output data/audit/audit-party-extraction-2026-04-30-as-field-corrections.json
 */

import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : fallback;
};
const inputPath = opt("--input");
const outputPath = opt("--output");
if (!inputPath || !outputPath) {
  console.error("Usage: --input PATH --output PATH");
  process.exit(1);
}

const data = JSON.parse(readFileSync(inputPath, "utf-8"));
const translated = {
  meta: {
    ...data.meta,
    translated_from: "party-extraction",
    translated_at: new Date().toISOString(),
  },
  results: [],
};

let totalExtractions = 0;
let totalCorrections = 0;
let totalSkipped = 0;
let totalNoExtraction = 0;

for (const r of data.results) {
  if (r.error || !r.data) continue;
  const { artwork_id, object_number, extractions = [], no_extraction_possible = [] } = r.data;
  totalExtractions += extractions.length;
  totalNoExtraction += no_extraction_possible.length;
  const corrections = [];
  for (const ex of extractions) {
    if (!Array.isArray(ex.parties) || ex.parties.length === 0) {
      totalSkipped++;
      continue;
    }
    for (const p of ex.parties) {
      if (!p?.name) { totalSkipped++; continue; }
      corrections.push({
        field: "parties",
        issue_type: ex.issue_type,
        event_sequence: ex.event_sequence,
        confidence: ex.confidence,
        new_party: {
          name: p.name,
          role: p.role ?? null,
          position: p.position ?? null,
        },
        reasoning: ex.reasoning,
      });
      totalCorrections++;
    }
  }
  if (corrections.length > 0) {
    translated.results.push({
      customId: r.customId,
      data: { artwork_id, object_number, corrections },
    });
  }
}

writeFileSync(outputPath, JSON.stringify(translated, null, 2));

console.log(`Translated ${inputPath} → ${outputPath}`);
console.log(`  ${data.results.length} input results`);
console.log(`  ${totalExtractions} extractions`);
console.log(`  ${totalNoExtraction} no_extraction_possible (skipped — no party to insert)`);
console.log(`  ${totalCorrections} party corrections emitted`);
console.log(`  ${totalSkipped} extractions skipped (empty/malformed parties)`);
console.log(`  ${translated.results.length} output result records`);
