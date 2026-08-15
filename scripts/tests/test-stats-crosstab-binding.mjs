// Regression guard for creator-domain cross-tab semantics on collection_stats:
//   - the gender filter binds to the same person row as the creator-bucketed dims
//     (no 1300s/1400s birth centuries on a gender=female, 1600–1900 cross-tab);
//   - unbound creator-domain predicate pairs draw the cross-tab warning;
//   - sameRowMatching without creator+productionRole draws an inert-flag warning.
// Needs data/vocabulary.db + built dist/.
import { VocabularyDb } from "../../dist/api/VocabularyDb.js";

const db = new VocabularyDb("data/vocabulary.db");
if (!db.available) { console.error("vocab DB unavailable"); process.exit(2); }

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

// ── S-1 repro: creatorBirthCentury × gender=female, created 1600–1900 ──
const r1 = db.computeCollectionStats({
  dimension: "creatorBirthCentury", gender: "female",
  creationDateFrom: 1600, creationDateTo: 1900, topN: 50,
});
console.log(`total=${r1.total}  buckets=${r1.entries.map(e => `${e.label}:${e.count}`).join(" ")}`);
const labels = r1.entries.map(e => Number(e.label));
check("S-1: no birth century before 1500 (was 1300/1400 leakage)", labels.every(l => l >= 1500),
  `min bucket ${Math.min(...labels)}`);
check("S-1: pool total unchanged by binding (still counts any-female-creator works)", r1.total > 0, `total ${r1.total}`);

// Baseline: same call WITHOUT gender must still show early centuries (male creators exist there)
const r1b = db.computeCollectionStats({
  dimension: "creatorBirthCentury", creationDateFrom: 1600, creationDateTo: 1900, topN: 50,
});
const baseLabels = r1b.entries.map(e => Number(e.label));
check("S-1 control: unfiltered cross-tab still spans early centuries", baseLabels.some(l => l < 1500),
  `min bucket ${Math.min(...baseLabels)}`);

// gender dim × gender filter collapses to that gender only
const r2 = db.computeCollectionStats({ dimension: "gender", gender: "female", topN: 10 });
check("S-1: gender dim under gender=female shows only 'female'",
  r2.entries.length === 1 && r2.entries[0].label === "female",
  r2.entries.map(e => e.label).join(","));

// ── warning matrix ──
check("S-1: cross-tab warning absent when gender is bound (single demographic predicate)",
  !(r1.warnings ?? []).some(w => w.includes("Creator-domain")), (r1.warnings ?? []).join(" | "));
const r3 = db.computeCollectionStats({ dimension: "creatorBirthCentury", profession: "painter", topN: 5 });
check("S-1: cross-tab warning fires for profession filter × cohort dim",
  (r3.warnings ?? []).some(w => w.includes("Creator-domain")));
const r4 = db.computeCollectionStats({ dimension: "type", gender: "female", profession: "painter", topN: 5 });
check("S-1: cross-tab warning fires for two demographic filters",
  (r4.warnings ?? []).some(w => w.includes("Creator-domain")));

// ── S-2: inert sameRowMatching draws a warning; effective one does not ──
const r5 = db.computeCollectionStats({
  dimension: "creatorBirthCentury", gender: "female",
  creationDateFrom: 1600, creationDateTo: 1900, sameRowMatching: true, topN: 5,
});
check("S-2: inert sameRowMatching warns", (r5.warnings ?? []).some(w => w.includes("sameRowMatching: true was ignored")),
  (r5.warnings ?? []).join(" | "));
const r6 = db.computeCollectionStats({
  dimension: "type", creator: "Rembrandt van Rijn", productionRole: "print maker", sameRowMatching: true, topN: 5,
});
check("S-2: effective sameRowMatching does not warn",
  !(r6.warnings ?? []).some(w => w.includes("sameRowMatching")), (r6.warnings ?? []).join(" | "));

// search_artwork path shares the intercept — inert flag must warn there too
const r7 = db.search({ gender: undefined, type: "painting", sameRowMatching: true, maxResults: 1 });
check("S-2: search path warns on inert flag too",
  (r7.warnings ?? []).some(w => w.includes("sameRowMatching: true was ignored")), (r7.warnings ?? []).join(" | "));

process.exit(failures ? 1 : 0);
