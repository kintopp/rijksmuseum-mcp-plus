#!/usr/bin/env node
// Cluster C: find_similar Theme (#294) + Related Object (#293) channels.
//
// Fixtures (live DB, harvest-baseline 2026-04-12 + v0.26 enrichment):
//   SK-A-1115            — 3 themes (history painting / battlefield / military history)
//   NG-VG-3-242          — 1 theme (min-2 floor case)
//   KOG-ZG-1-19-90       — has 'pendant' edge → KOG-ZG-1-19-87
//
// Notes from probe:
//   - 0 of 11,860 in-scope RO edges have NULL related_art_id, so the
//     null-peer rendering case is unreachable on this DB and not tested.
//   - 0 RO peers appear under multiple in-scope relationship_en values,
//     so multi-label collision is unreachable and not tested.

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

const db = new VocabularyDb();
if (!db.available) { console.error(`Vocab DB not available at ${DB_PATH}`); process.exit(1); }

// ── Cache warmup timing ────────────────────────────────────────────
console.log("\n=== Cache warmup timing ===");
const t0 = Date.now();
db.warmSimilarCaches();
const warmMs = Date.now() - t0;
console.log(`  warmSimilarCaches() total: ${warmMs}ms (theme + related-object are tail-end)`);
checkPredicate("warm budget < 8s", () => warmMs < 8000, `actual: ${warmMs}ms`);

// ── Theme channel ─────────────────────────────────────────────────
console.log("\n=== Theme: happy path (SK-A-1115, 3 themes) ===");
const tQ = Date.now();
const themeRes = db.findSimilarByTheme("SK-A-1115", 10);
const tMs = Date.now() - tQ;
console.log(`  query latency: ${tMs}ms`);
if (!themeRes) { console.error("findSimilarByTheme returned null"); process.exit(1); }
check("queryObjectNumber", themeRes.queryObjectNumber, "SK-A-1115");
checkPredicate("queryTitle non-empty", () => typeof themeRes.queryTitle === "string" && themeRes.queryTitle.length > 0,
  "expected resolved title");
check("queryTerms count = 3", themeRes.queryTerms.length, 3);
checkPredicate("queryTerms have artworks counts", () => themeRes.queryTerms.every(t => typeof t.artworks === "number" && t.artworks > 0),
  "all terms should report a non-zero DF");
checkPredicate("results length > 0", () => themeRes.results.length > 0, "expected ≥1 candidate");
checkPredicate("each result has score > 0", () => themeRes.results.every(r => r.score > 0),
  "IDF-weighted scores should all be positive");
checkPredicate("each result has sharedTerms ≥ 1", () => themeRes.results.every(r => r.sharedTerms.length >= 1),
  "by construction each candidate must share ≥1 theme");
checkPredicate("sharedTerms have no wikidataUri", () => themeRes.results.every(r => r.sharedTerms.every(t => t.wikidataUri === undefined)),
  "themes don't carry Wikidata identifiers");
checkPredicate("results sorted by score descending", () => {
  const scores = themeRes.results.map(r => r.score);
  return scores.every((s, i) => i === 0 || s <= scores[i - 1]);
}, "monotonically non-increasing");
checkPredicate("self-exclusion: query artwork not in results",
  () => !themeRes.results.some(r => r.objectNumber === "SK-A-1115"),
  "the seed must not appear in its own similars");
checkPredicate("no warnings on happy path",
  () => !themeRes.warnings || themeRes.warnings.length === 0,
  `unexpected warnings: ${JSON.stringify(themeRes.warnings)}`);
checkPredicate("query latency < 200ms warm", () => tMs < 200, `actual: ${tMs}ms`);

console.log("\n=== Theme: min-2 floor (NG-VG-3-242, 1 theme) ===");
const themeFloor = db.findSimilarByTheme("NG-VG-3-242", 10);
if (!themeFloor) { console.error("findSimilarByTheme returned null"); process.exit(1); }
check("results empty", themeFloor.results.length, 0);
checkPredicate("warning mentions 2-theme floor",
  () => Array.isArray(themeFloor.warnings) && themeFloor.warnings.some(w => /fewer than 2/.test(w)),
  `got warnings: ${JSON.stringify(themeFloor.warnings)}`);
check("queryTerms still surface the 1 theme", themeFloor.queryTerms.length, 1);

console.log("\n=== Theme: unknown artwork ===");
const themeMissing = db.findSimilarByTheme("DOES-NOT-EXIST-9999", 10);
check("returns null", themeMissing, null);

// ── Related Object channel ────────────────────────────────────────
console.log("\n=== Related Object: pendant happy path (KOG-ZG-1-19-90) ===");
const rQ = Date.now();
const roRes = db.findSimilarByRelatedObject("KOG-ZG-1-19-90", 10);
const rMs = Date.now() - rQ;
console.log(`  query latency: ${rMs}ms`);
if (!roRes) { console.error("findSimilarByRelatedObject returned null"); process.exit(1); }
check("queryObjectNumber", roRes.queryObjectNumber, "KOG-ZG-1-19-90");
checkPredicate("results length ≥ 1", () => roRes.results.length >= 1, "expected ≥1 peer");
checkPredicate("KOG-ZG-1-19-87 is one of the peers",
  () => roRes.results.some(r => r.objectNumber === "KOG-ZG-1-19-87"),
  "expected pendant peer in results");
checkPredicate("every result has score = 10",
  () => roRes.results.every(r => r.score === 10),
  "fixed-score model");
checkPredicate("every result has at least 1 sharedTerm",
  () => roRes.results.every(r => r.sharedTerms.length >= 1),
  "labels should always be present");
checkPredicate("first result label is 'pendant'",
  () => roRes.results[0].sharedTerms.some(t => t.label === "pendant"),
  "expected the pendant label");
checkPredicate("no NULL-peer results leaked",
  () => roRes.results.every(r => r.objectNumber && !r.objectNumber.startsWith("art_id:")),
  "all peers should resolve to real object_numbers");
checkPredicate("query latency < 50ms warm", () => rMs < 50, `actual: ${rMs}ms`);

console.log("\n=== Related Object: artwork without RO edges ===");
const roEmpty = db.findSimilarByRelatedObject("NG-VG-3-242", 10);
if (!roEmpty) { console.error("findSimilarByRelatedObject returned null"); process.exit(1); }
check("results empty", roEmpty.results.length, 0);
checkPredicate("warning mentions declared edges",
  () => Array.isArray(roEmpty.warnings) && roEmpty.warnings.some(w => /declared related-object/.test(w)),
  `got warnings: ${JSON.stringify(roEmpty.warnings)}`);

console.log("\n=== Related Object: unknown artwork ===");
const roMissing = db.findSimilarByRelatedObject("DOES-NOT-EXIST-9999", 10);
check("returns null", roMissing, null);

// ── Regression: existing 6 channels still work on a known-good seed ──
console.log("\n=== Regression: SK-A-1115 still works on existing channels ===");
const ic = db.findSimilarByIconclass("SK-A-1115", 5);
checkPredicate("Iconclass returns a result",
  () => ic && ic.results.length > 0,
  "expected ≥1 Iconclass match for SK-A-1115");
const li = db.findSimilarByLineage("SK-A-1115", 5);
checkPredicate("Lineage callable", () => li !== null, "expected non-null lineage result object");
const dp = db.findSimilarByDepictedPerson("SK-A-1115", 5);
checkPredicate("DepictedPerson callable", () => dp !== null, "expected non-null person result object");
const dpl = db.findSimilarByDepictedPlace("SK-A-1115", 5);
checkPredicate("DepictedPlace callable", () => dpl !== null, "expected non-null place result object");

console.log(`\n${failures === 0 ? "✓ all checks passed" : `✗ ${failures} failure(s)`}`);
process.exit(failures === 0 ? 0 : 1);
