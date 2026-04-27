#!/usr/bin/env node
// Smoke test for Task A: get_artwork_details now surfaces title_variants[]
// in the `titles` array.
//
// Verifies:
//   1. Night Watch (SK-C-5) returns its 6 known variants with correct
//      language + qualifier mappings.
//   2. The qualifier enum is preserved (brief/full/display/former/other).
//   3. An artwork with a single variant doesn't gain spurious entries.

import { VocabularyDb } from "../../dist/api/VocabularyDb.js";
import path from "node:path";

const DB_PATH = path.resolve(process.cwd(), "data/vocabulary.db");

function expect(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${pass ? "✓" : "✗"} ${label}: ${pass ? "ok" : `got=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`}`);
  return pass;
}

let failures = 0;
function check(label, actual, expected) { if (!expect(label, actual, expected)) failures++; }

const db = new VocabularyDb(DB_PATH);
if (!db.available) {
  console.error("Vocab DB not available at", DB_PATH);
  process.exit(1);
}

console.log("\n=== Night Watch (SK-C-5) ===");
const nw = db.getArtworkDetail("SK-C-5");
if (!nw) { console.error("SK-C-5 not found"); process.exit(1); }

check("titles[].length", nw.titles.length, 6);
check("titles[0].language", nw.titles[0].language, "nl");
check("titles[0].qualifier", nw.titles[0].qualifier, "full");
check("titles[2].title", nw.titles[2].title, "De Nachtwacht");
check("titles[2].qualifier", nw.titles[2].qualifier, "brief");
check("titles[3].qualifier (display preserved)", nw.titles[3].qualifier, "display");
check("titles[4].qualifier (former preserved)", nw.titles[4].qualifier, "former");

const qualifiersFound = new Set(nw.titles.map(t => t.qualifier));
check("Night Watch qualifier diversity", [...qualifiersFound].sort(), ["brief", "display", "former", "full"]);

console.log("\n=== Variant-light artwork ===");
// Pick an artwork known to have a small variant count via direct query
import Database from "better-sqlite3";
const conn = new Database(DB_PATH, { readonly: true });
const sample = conn.prepare(
  "SELECT a.object_number, COUNT(*) AS n FROM title_variants tv JOIN artworks a ON a.art_id = tv.art_id GROUP BY tv.art_id ORDER BY n LIMIT 1"
).get();
conn.close();

if (sample) {
  const detail = db.getArtworkDetail(sample.object_number);
  check(`min-variant artwork ${sample.object_number} length`, detail.titles.length, sample.n);
}

console.log(`\n${failures === 0 ? "✓ all checks passed" : `✗ ${failures} failure(s)`}`);
process.exit(failures === 0 ? 0 : 1);
