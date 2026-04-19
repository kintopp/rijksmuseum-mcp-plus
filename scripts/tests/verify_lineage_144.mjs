#!/usr/bin/env node
/**
 * Verify issue #144 fix: findSimilarByLineage now reads from assignment_pairs
 * instead of fabricating cartesian (qualifier, creator) pairs via mappings self-JOIN.
 *
 * Test target: RP-F-2018-183-9 — has 9 real (qualifier, creator) assignment pairs
 * across 5 distinct creators and 2 qualifiers. The OLD code would have produced
 * 10 cartesian pairs (2 × 5), inventing "attributed to anonymous" which does not
 * exist in the source data.
 *
 * Calls VocabularyDb.findSimilarByLineage() directly — no MCP server roundtrip.
 *
 * Usage: node scripts/tests/verify_lineage_144.mjs
 */
import Database from "better-sqlite3";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { VocabularyDb, LINEAGE_QUALIFIERS } from "../../dist/api/VocabularyDb.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "../..");
const DB_PATH = resolve(PROJECT_ROOT, "data/vocabulary.db");
const TARGET_OBJECT = "RP-F-2018-183-9";

// Derive the canonical qualifier-id list from the same source the runtime uses.
const QUALIFIER_IDS = [...LINEAGE_QUALIFIERS.keys()].map(uri => uri.split("/").pop());

console.log(`\n=== #144 verification: ${TARGET_OBJECT} ===\n`);

// ── Truth set from assignment_pairs ─────────────────────────────────────
const db = new Database(DB_PATH, { readonly: true });
const artRow = db.prepare("SELECT art_id FROM artworks WHERE object_number = ?").get(TARGET_OBJECT);
if (!artRow) {
  console.error(`  ERROR: ${TARGET_OBJECT} not in artworks`);
  process.exit(1);
}

const placeholders = QUALIFIER_IDS.map(() => "?").join(", ");
const truthRows = db.prepare(`
  SELECT ap.qualifier_id, vq.label_en AS qualifier_label,
         ap.creator_id,   COALESCE(vc.label_en, vc.label_nl, '') AS creator_label
  FROM assignment_pairs ap
  JOIN vocabulary vq ON vq.id = ap.qualifier_id
  LEFT JOIN vocabulary vc ON vc.id = ap.creator_id
  WHERE ap.artwork_id = ?
    AND ap.qualifier_id IN (${placeholders})
  ORDER BY ap.qualifier_id, ap.creator_id
`).all(artRow.art_id, ...QUALIFIER_IDS);
db.close();

const truthSet = new Set(truthRows.map(r => `${r.qualifier_label}|${r.creator_label}`));
console.log(`Truth (assignment_pairs): ${truthRows.length} pairs`);
for (const r of truthRows) console.log(`  ${r.qualifier_label.padEnd(14)} | ${r.creator_label}`);

// ── Direct method call ──────────────────────────────────────────────────
process.env.VOCAB_DB_PATH = DB_PATH;
const vocab = new VocabularyDb();

const result = vocab.findSimilarByLineage(TARGET_OBJECT, 5);

console.log(`\nReturned (findSimilarByLineage): ${result.queryLineage.length} pairs`);
for (const p of result.queryLineage) {
  console.log(`  ${(p.qualifierLabel ?? "").padEnd(14)} | ${p.creatorLabel ?? ""}`);
}

const returnedSet = new Set(result.queryLineage.map(p => `${p.qualifierLabel}|${p.creatorLabel}`));
const fabricated = [...returnedSet].filter(k => !truthSet.has(k));
const missing    = [...truthSet].filter(k => !returnedSet.has(k));

console.log("\n--- Diff ---");
console.log(`  Fabricated (returned but not in truth): ${fabricated.length}`);
for (const k of fabricated) console.log(`    + ${k}`);
console.log(`  Missing    (in truth but not returned): ${missing.length}`);
for (const k of missing) console.log(`    - ${k}`);

const ok = fabricated.length === 0 && missing.length === 0;
console.log(ok ? "\n✓ PASS" : "\n✗ FAIL");

console.log(`\nResults returned: ${result.results.length} similar artworks`);
if (result.warnings?.length) console.log(`Warnings:\n  ${result.warnings.join("\n  ")}`);
console.log(`\nLineage cache: ${vocab.lineageCreatorDf?.size ?? "n/a"} creators, ${vocab.lineageN ?? "n/a"} artworks`);

process.exit(ok ? 0 : 1);
