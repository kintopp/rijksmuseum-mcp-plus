// #354 scope scan: is get_artwork_details' creator↔role swap (RP-F-00-173) isolated
// or systematic? Compares the server's POSITIONAL zip (creators[i] ⟷ roles[i], both
// sorted by vocab_int_id, the order the no-ORDER-BY mappings query returns) against the
// row-aware ground truth in production_role_pairs (carries part_index).
//
// Run: node scripts/tests/scan-354-role-swap-scope.mjs
import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const db = new Database(join(root, "data", "vocabulary.db"), { readonly: true });

const FOTOGRAAF = "2204764"; // production_role vocab id for "fotograaf"/photographer

// Per-artwork positional pairs the detail view would emit: zip equal-length
// creator/role lists, each ordered by vocab_rowid (= mappings PK cluster order).
const positional = db.prepare(`
  WITH crt AS (
    SELECT m.artwork_id, v.id AS creator_id, v.death_year,
           ROW_NUMBER() OVER (PARTITION BY m.artwork_id ORDER BY m.vocab_rowid) AS rn,
           COUNT(*)     OVER (PARTITION BY m.artwork_id) AS n
    FROM mappings m JOIN vocabulary v ON m.vocab_rowid = v.vocab_int_id
    WHERE m.field_id = 4),
  rol AS (
    SELECT m.artwork_id, v.id AS role_id,
           ROW_NUMBER() OVER (PARTITION BY m.artwork_id ORDER BY m.vocab_rowid) AS rn,
           COUNT(*)     OVER (PARTITION BY m.artwork_id) AS n
    FROM mappings m JOIN vocabulary v ON m.vocab_rowid = v.vocab_int_id
    WHERE m.field_id = 8)
  SELECT crt.artwork_id, crt.creator_id, crt.death_year, rol.role_id
  FROM crt JOIN rol ON crt.artwork_id = rol.artwork_id AND crt.rn = rol.rn
  WHERE crt.n = rol.n AND crt.n >= 2
`).all();

// zip-eligible population (multi-creator, equal creator/role counts) — only here can
// the positional zip cross wires. Single-creator works are always paired correctly.
const eligibleArtworks = new Set(positional.map((p) => p.artwork_id));

const hasTruePair = db.prepare(
  `SELECT 1 FROM production_role_pairs WHERE artwork_id=? AND creator_id=? AND role_id=? LIMIT 1`
);
const datesFor = db.prepare(`SELECT object_number, date_earliest, date_latest FROM artworks WHERE art_id=?`);

const mispairedArtworks = new Set();
const anachronisticPositional = []; // dead-before-1839 creator positionally tagged fotograaf
for (const p of positional) {
  if (!hasTruePair.get(p.artwork_id, p.creator_id, p.role_id)) {
    mispairedArtworks.add(p.artwork_id);
    if (p.role_id === FOTOGRAAF && p.death_year != null && p.death_year < 1839) {
      anachronisticPositional.push(p);
    }
  }
}

// Contrast: does the GROUND TRUTH (production_role_pairs) ever tag a pre-1839-dead
// person as fotograaf? If ~0, every such "anachronism" is a zip artifact, not source data.
const anachronisticTrue = db.prepare(`
  SELECT COUNT(*) AS n
  FROM production_role_pairs p JOIN vocabulary v ON v.id = p.creator_id
  WHERE p.role_id = ? AND v.death_year IS NOT NULL AND v.death_year < 1839
`).get(FOTOGRAAF).n;

// Rembrandt name-cluster (actor 2103429): photographic-object scope from the issue.
const REMBRANDT = "2103429";
const rembrandtPositionalFotograaf = positional.filter(
  (p) => p.creator_id === REMBRANDT && p.role_id === FOTOGRAAF
);
const rembrandtTrueFotograaf = db.prepare(
  `SELECT COUNT(*) AS n FROM production_role_pairs WHERE creator_id=? AND role_id=?`
).get(REMBRANDT, FOTOGRAAF).n;

console.log("=== #354 role-swap scope scan ===\n");
console.log(`Zip-eligible artworks (≥2 creators, equal creator/role counts): ${eligibleArtworks.size}`);
console.log(`Artworks the positional zip MISPAIRS (≥1 pair absent from production_role_pairs): ${mispairedArtworks.size}`);
console.log(`  → as % of zip-eligible: ${(100 * mispairedArtworks.size / eligibleArtworks.size).toFixed(1)}%\n`);

console.log("--- Symptom the issue flagged: pre-1839-dead person tagged 'fotograaf' ---");
console.log(`Positional zip (server output):        ${anachronisticPositional.length} (creator,artwork) pairs`);
console.log(`Ground truth (production_role_pairs):   ${anachronisticTrue} pairs`);
console.log(`  → ${anachronisticTrue === 0 ? "ALL such anachronisms are zip artifacts; source data is clean." : "source data also has anachronisms — investigate."}\n`);

console.log("--- Rembrandt cluster (actor 2103429) ---");
console.log(`Positionally tagged 'fotograaf' (server output): ${rembrandtPositionalFotograaf.length}`);
console.log(`Truly tagged 'fotograaf' in production_role_pairs: ${rembrandtTrueFotograaf}`);
console.log("");

console.log("--- Sample of mispaired records (first 15 anachronistic-fotograaf cases) ---");
for (const p of anachronisticPositional.slice(0, 15)) {
  const d = datesFor.get(p.artwork_id);
  const cname = db.prepare(`SELECT label_en, label_nl FROM vocabulary WHERE id=?`).get(p.creator_id);
  console.log(`  ${d.object_number.padEnd(16)} ${(cname.label_en || cname.label_nl || "?").padEnd(24)} d.${p.death_year}  obj ${d.date_earliest}-${d.date_latest}`);
}
console.log(`  … ${Math.max(0, anachronisticPositional.length - 15)} more`);

db.close();
