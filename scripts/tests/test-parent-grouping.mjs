#!/usr/bin/env node
// Task B smoke test:
//   1. get_artwork_details exposes parents + childCount + children preview.
//   2. VocabularyDb.findParentGroupings only returns rows where the child's
//      parent is also in the input set.
//
// Test fixtures:
//   - BI-1898-1748A   = the sketchbook from issue #28 (parent record).
//   - BI-1898-1748A-1(R) = first folio (child record).
//   - SK-C-5          = standalone painting (no parent / no children).

import Database from "better-sqlite3";
import path from "node:path";
import { VocabularyDb } from "../../dist/api/VocabularyDb.js";

const DB_PATH = path.resolve(process.cwd(), "data/vocabulary.db");

let failures = 0;
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${pass ? "✓" : "✗"} ${label}: ${pass ? "ok" : `got=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`}`);
  if (!pass) failures++;
}

const db = new VocabularyDb(DB_PATH);
if (!db.available) { console.error("Vocab DB not available"); process.exit(1); }

console.log("\n=== Detail-side: child record (folio) ===");
const folio = db.getArtworkDetail("BI-1898-1748A-1(R)");
if (!folio) { console.error("BI-1898-1748A-1(R) not found"); process.exit(1); }
check("folio.parents.length", folio.parents.length, 1);
check("folio.parents[0].objectNumber", folio.parents[0].objectNumber, "BI-1898-1748A");
check("folio.childCount", folio.childCount, 0);
check("folio.children", folio.children, []);

console.log("\n=== Detail-side: parent record (sketchbook) ===");
const book = db.getArtworkDetail("BI-1898-1748A");
if (!book) { console.error("BI-1898-1748A not found"); process.exit(1); }
check("book.parents", book.parents, []);
// Sketchbook has 51 folio sides (26 leaves × recto+verso, minus blanks).
// Pull the live count straight from the DB so the test stays correct
// regardless of harvest vintage.
const conn0 = new Database(DB_PATH, { readonly: true });
const expectedChildCount = conn0.prepare(`
  SELECT COUNT(*) AS n FROM artwork_parent ap
  JOIN artworks p ON p.art_id = ap.parent_art_id
  WHERE p.object_number = 'BI-1898-1748A'
`).get().n;
conn0.close();
check("book.childCount (full count)", book.childCount, expectedChildCount);
check("book.children.length (capped at 25)", book.children.length, Math.min(expectedChildCount, 25));
// Verify ordering by object_number
const sortedNames = book.children.map(c => c.objectNumber).slice();
const sorted = [...sortedNames].sort();
check("book.children ordered by object_number", sortedNames, sorted);

console.log("\n=== Detail-side: standalone painting ===");
const painting = db.getArtworkDetail("SK-C-5");
check("painting.parents", painting.parents, []);
check("painting.childCount", painting.childCount, 0);
check("painting.children", painting.children, []);

console.log("\n=== findParentGroupings ===");
// Verify the parent-and-child-both-present semantics
const both = db.findParentGroupings(["BI-1898-1748A", "BI-1898-1748A-1(R)"]);
check("both present → 1 grouping", both.size, 1);
check("child maps to parent", both.get("BI-1898-1748A-1(R)"), "BI-1898-1748A");

const childOnly = db.findParentGroupings(["BI-1898-1748A-1(R)"]);
check("child-only → 0 groupings", childOnly.size, 0);

const parentOnly = db.findParentGroupings(["BI-1898-1748A"]);
check("parent-only → 0 groupings", parentOnly.size, 0);

const nothing = db.findParentGroupings(["SK-C-5"]);
check("standalone → 0 groupings", nothing.size, 0);

// Multi-folio result with the parent in the same batch
const conn = new Database(DB_PATH, { readonly: true });
const folioObjs = conn.prepare(`
  SELECT a.object_number FROM artwork_parent ap
  JOIN artworks a ON a.art_id = ap.art_id
  JOIN artworks p ON p.art_id = ap.parent_art_id
  WHERE p.object_number = 'BI-1898-1748A'
  ORDER BY a.object_number LIMIT 5
`).all().map(r => r.object_number);
conn.close();
const batch = ["BI-1898-1748A", ...folioObjs];
const batchMap = db.findParentGroupings(batch);
check("multi-folio batch maps each child→sketchbook", batchMap.size, folioObjs.length);

console.log(`\n${failures === 0 ? "✓ all checks passed" : `✗ ${failures} failure(s)`}`);
process.exit(failures === 0 ? 0 : 1);
