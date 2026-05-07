#!/usr/bin/env node
// Task C smoke test: get_artwork_details surfaces peer-artwork relations.
//
// As of v0.27 cluster E (#296), relatedObjects[] is restricted to the 3
// co-production labels ('different example', 'production stadia', 'pendant')
// — the creator-invariant peers used by the viewer's prev/next-related
// navigation. Other relationship types (recto/verso, frame, reproduction,
// related object, etc.) surface through find_similar's Related Object channel.
//
// Fixtures (live DB, harvest-baseline 2026-05-02):
//   KOG-ZG-1-19-90    — single 'pendant' relation, resolvable peer KOG-ZG-1-19-87
//   SK-A-1115         — 4 'production stadia' (single co-production type)
//   RP-P-1997-361     — 7 entries, 2 distinct types ('different example' + 'production stadia')
//   SK-A-5088         — has 'object | current frame' but 0 co-production → negative test
//   RP-P-2010-222-3315 — no related_objects nor artwork_parent rows at all

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

console.log("\n=== Single-pendant fixture (KOG-ZG-1-19-90 ↔ KOG-ZG-1-19-87) ===");
const pendant = db.getArtworkDetail("KOG-ZG-1-19-90");
if (!pendant) { console.error("KOG-ZG-1-19-90 not found"); process.exit(1); }
check("relatedObjectsTotalCount", pendant.relatedObjectsTotalCount, 1);
check("relatedObjects.length", pendant.relatedObjects.length, 1);
checkPredicate(
  "has 'pendant' → KOG-ZG-1-19-87 with title resolved",
  () => pendant.relatedObjects.some(r =>
    r.relationship === "pendant" &&
    r.objectNumber === "KOG-ZG-1-19-87" &&
    typeof r.title === "string" && r.title.length > 0 &&
    typeof r.objectUri === "string" && r.objectUri.startsWith("https://id.rijksmuseum.nl/")
  ),
  "expected resolved pendant peer with title + URI");

console.log("\n=== Multi-relation single-type (SK-A-1115) ===");
const single = db.getArtworkDetail("SK-A-1115");
if (!single) { console.error("SK-A-1115 not found"); process.exit(1); }
check("relatedObjectsTotalCount", single.relatedObjectsTotalCount, 4);
check("relatedObjects.length", single.relatedObjects.length, 4);
checkPredicate(
  "all 4 entries are 'production stadia'",
  () => single.relatedObjects.every(r => r.relationship === "production stadia"),
  "expected all rows to share the same relationship_en");

console.log("\n=== Multi-type co-production (RP-P-1997-361) ===");
const multi = db.getArtworkDetail("RP-P-1997-361");
if (!multi) { console.error("RP-P-1997-361 not found"); process.exit(1); }
check("relatedObjectsTotalCount", multi.relatedObjectsTotalCount, 7);
check("relatedObjects.length", multi.relatedObjects.length, 7);
const distinctRels = new Set(multi.relatedObjects.map(r => r.relationship));
check("has 2 distinct relationship types", distinctRels.size, 2);
checkPredicate(
  "covers both 'different example' and 'production stadia'",
  () => distinctRels.has("different example") && distinctRels.has("production stadia"),
  "expected both labels in the result set");
const sortedRels = multi.relatedObjects.map(r => r.relationship);
check("rows ordered by relationship label", sortedRels, [...sortedRels].sort());

console.log("\n=== Negative: only non-co-production relations (SK-A-5088) ===");
const framed = db.getArtworkDetail("SK-A-5088");
if (!framed) { console.error("SK-A-5088 not found"); process.exit(1); }
check("relatedObjectsTotalCount", framed.relatedObjectsTotalCount, 0);
check("relatedObjects empty array", framed.relatedObjects, []);

console.log("\n=== No relations at all (RP-P-2010-222-3315) ===");
const standalone = db.getArtworkDetail("RP-P-2010-222-3315");
if (!standalone) { console.error("RP-P-2010-222-3315 not found"); process.exit(1); }
check("zero related", standalone.relatedObjectsTotalCount, 0);
check("relatedObjects empty array", standalone.relatedObjects, []);

console.log(`\n${failures === 0 ? "✓ all checks passed" : `✗ ${failures} failure(s)`}`);
process.exit(failures === 0 ? 0 : 1);
