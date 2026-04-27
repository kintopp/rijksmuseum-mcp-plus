#!/usr/bin/env node
// Task C smoke test: get_artwork_details surfaces peer-artwork relations
// (recto/verso, frame/painting, pendant, production stadia, …) from
// related_objects.
//
// Fixtures (live DB, harvest-baseline 2026-04-12):
//   SK-A-5088          — has 'object | current frame' → SK-L-6972
//   SK-A-1115          — has 4 distinct relationship types, 14 entries
//   RP-P-2010-222-3315 — print with no related_objects nor artwork_parent rows
//   RP-R-1927-66-0     — heaviest LHS (359 relations), exercises the cap

import path from "node:path";
import { VocabularyDb } from "../../dist/api/VocabularyDb.js";

const DB_PATH = path.resolve(process.cwd(), "data/vocabulary.db");

let failures = 0;
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${pass ? "✓" : "✗"} ${label}: ${pass ? "ok" : `got=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`}`);
  if (!pass) failures++;
}
function checkPredicate(label, fn, why) {
  const pass = !!fn();
  console.log(`  ${pass ? "✓" : "✗"} ${label}${pass ? "" : ` — ${why}`}`);
  if (!pass) failures++;
}

const db = new VocabularyDb(DB_PATH);
if (!db.available) { console.error("Vocab DB not available"); process.exit(1); }

console.log("\n=== Single-relation artwork (SK-A-5088 ↔ frame) ===");
const framed = db.getArtworkDetail("SK-A-5088");
if (!framed) { console.error("SK-A-5088 not found"); process.exit(1); }
check("relatedObjectsTotalCount", framed.relatedObjectsTotalCount, framed.relatedObjects.length);
checkPredicate(
  "has 'object | current frame' → SK-L-6972 with title resolved",
  () => framed.relatedObjects.some(r =>
    r.relationship === "object | current frame" &&
    r.objectNumber === "SK-L-6972" &&
    typeof r.title === "string" && r.title.length > 0 &&
    typeof r.objectUri === "string" && r.objectUri.startsWith("https://id.rijksmuseum.nl/")
  ),
  "expected resolved frame peer with title + URI");

console.log("\n=== Multi-relation artwork (SK-A-1115) ===");
const multi = db.getArtworkDetail("SK-A-1115");
if (!multi) { console.error("SK-A-1115 not found"); process.exit(1); }
check("relatedObjectsTotalCount", multi.relatedObjectsTotalCount, 14);
check("relatedObjects.length (under cap)", multi.relatedObjects.length, 14);
const distinctRels = new Set(multi.relatedObjects.map(r => r.relationship));
check("has 4 distinct relationship types", distinctRels.size, 4);
const sortedRels = multi.relatedObjects.map(r => r.relationship);
check("rows ordered by relationship label", sortedRels, [...sortedRels].sort());

console.log("\n=== Standalone print (no relations, no parent) ===");
const standalone = db.getArtworkDetail("RP-P-2010-222-3315");
if (!standalone) { console.error("RP-P-2010-222-3315 not found"); process.exit(1); }
check("zero related", standalone.relatedObjectsTotalCount, 0);
check("relatedObjects empty array", standalone.relatedObjects, []);

console.log("\n=== Capped artwork (RP-R-1927-66-0, 359 total) ===");
const heavy = db.getArtworkDetail("RP-R-1927-66-0");
if (!heavy) { console.error("RP-R-1927-66-0 not found"); process.exit(1); }
check("relatedObjectsTotalCount = 359", heavy.relatedObjectsTotalCount, 359);
check("relatedObjects capped at 25", heavy.relatedObjects.length, 25);
checkPredicate(
  "all preview entries have stable schema (relationship + objectUri)",
  () => heavy.relatedObjects.every(r =>
    typeof r.relationship === "string" &&
    typeof r.objectUri === "string" &&
    (r.objectNumber === null || typeof r.objectNumber === "string") &&
    (r.title === null || typeof r.title === "string")
  ),
  "expected uniform shape across all preview rows");

console.log(`\n${failures === 0 ? "✓ all checks passed" : `✗ ${failures} failure(s)`}`);
process.exit(failures === 0 ? 0 : 1);
