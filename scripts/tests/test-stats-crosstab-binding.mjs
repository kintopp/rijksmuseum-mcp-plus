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
const warned = (r, s) => (r.warnings ?? []).some(w => w.includes(s));
const warnText = r => (r.warnings ?? []).join(" | ");

// ── S-1 repro: creatorBirthCentury × gender=female, created 1600–1900 ──
const r1 = db.computeCollectionStats({
  dimension: "creatorBirthCentury", gender: "female",
  creationDateFrom: 1600, creationDateTo: 1900, topN: 50,
});
console.log(`total=${r1.total}  buckets=${r1.entries.map(e => `${e.label}:${e.count}`).join(" ")}`);
const labels = r1.entries.map(e => Number(e.label));
check("S-1: no birth century before 1500 (was 1300/1400 leakage)",
  labels.length > 0 && labels.every(l => l >= 1500), `buckets ${labels.join(",")}`);

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
const r3 = db.computeCollectionStats({ dimension: "creatorBirthCentury", profession: "painter", topN: 5 });
const r4 = db.computeCollectionStats({ dimension: "type", gender: "female", profession: "painter", topN: 5 });
for (const [name, r, expect] of [
  ["absent when gender is bound (single demographic predicate)", r1, false],
  ["fires for profession filter × cohort dim", r3, true],
  ["fires for two demographic filters", r4, true],
]) check(`S-1: cross-tab warning ${name}`, warned(r, "Creator-domain") === expect, warnText(r));

// ── S-2: inert sameRowMatching draws a warning + drops out of appliedFilters ──
const r5 = db.computeCollectionStats({
  dimension: "creatorBirthCentury", gender: "female",
  creationDateFrom: 1600, creationDateTo: 1900, sameRowMatching: true, topN: 5,
});
check("S-2: inert sameRowMatching warns", warned(r5, "sameRowMatching: true was ignored"), warnText(r5));
check("S-2: inert flag stripped from appliedFilters", r5.appliedFilters.sameRowMatching === undefined);
const r6 = db.computeCollectionStats({
  dimension: "type", creator: "Rembrandt van Rijn", productionRole: "print maker", sameRowMatching: true, topN: 5,
});
check("S-2: effective sameRowMatching does not warn", !warned(r6, "sameRowMatching"), warnText(r6));
check("S-2: effective flag stays in appliedFilters", r6.appliedFilters.sameRowMatching === true);

// search_artwork path shares the intercept — inert flag must warn there too
const r7 = db.search({ type: "painting", sameRowMatching: true, maxResults: 1 });
check("S-2: search path warns on inert flag too", warned(r7, "sameRowMatching: true was ignored"), warnText(r7));

process.exit(failures ? 1 : 0);
