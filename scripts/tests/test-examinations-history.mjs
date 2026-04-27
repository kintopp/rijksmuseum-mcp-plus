#!/usr/bin/env node
// Tasks D + E smoke test: get_artwork_details surfaces conservation/scientific
// examinations and restoration treatment events.
//
// Fixtures (live DB):
//   SK-A-110           — 15 examinations + 5 modifications (the heaviest)
//   RP-P-2010-222-3315 — print with no examinations and no modifications
//   SK-A-290           — 12 examinations + 2 modifications

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

console.log("\n=== Heavy fixture (SK-A-110: 15 exams, 5 treatments) ===");
const heavy = db.getArtworkDetail("SK-A-110");
if (!heavy) { console.error("SK-A-110 not found"); process.exit(1); }
check("examinationsTotalCount", heavy.examinationsTotalCount, 15);
check("examinations.length under cap", heavy.examinations.length, 15);
check("conservationHistoryTotalCount", heavy.conservationHistoryTotalCount, 5);
check("conservationHistory.length", heavy.conservationHistory.length, 5);

const exam0 = heavy.examinations[0];
checkPredicate(
  "examination has examiner + reportTypeId + dates",
  () => typeof exam0.examiner === "string" && exam0.examiner.length > 0
        && typeof exam0.reportTypeId === "string" && exam0.reportTypeId.startsWith("https://")
        && typeof exam0.dateBegin === "string",
  "expected populated examiner, reportTypeId URI, and dateBegin");
check("reportTypeLabel is null in v0.24 (harvest gap)", exam0.reportTypeLabel, null);

// Most-recent-first ordering
const examDates = heavy.examinations.map(e => e.dateBegin).filter(Boolean);
checkPredicate(
  "examinations sorted most-recent-first",
  () => {
    for (let i = 1; i < examDates.length; i++) {
      if (examDates[i - 1] < examDates[i]) return false;
    }
    return true;
  },
  "expected non-increasing dateBegin sequence");

const treatment0 = heavy.conservationHistory[0];
checkPredicate(
  "treatment has description + dates",
  () => typeof treatment0.description === "string" && treatment0.description.length > 0
        && typeof treatment0.dateBegin === "string",
  "expected populated description + dateBegin");

console.log("\n=== Print with neither (RP-P-2010-222-3315) ===");
const standalone = db.getArtworkDetail("RP-P-2010-222-3315");
check("examinationsTotalCount=0", standalone.examinationsTotalCount, 0);
check("examinations empty", standalone.examinations, []);
check("conservationHistoryTotalCount=0", standalone.conservationHistoryTotalCount, 0);
check("conservationHistory empty", standalone.conservationHistory, []);

console.log("\n=== Mid fixture (SK-A-290: 12 exams, 2 treatments) ===");
const mid = db.getArtworkDetail("SK-A-290");
check("SK-A-290 examinationsTotalCount", mid.examinationsTotalCount, 12);
check("SK-A-290 conservationHistoryTotalCount", mid.conservationHistoryTotalCount, 2);

console.log(`\n${failures === 0 ? "✓ all checks passed" : `✗ ${failures} failure(s)`}`);
process.exit(failures === 0 ? 0 : 1);
