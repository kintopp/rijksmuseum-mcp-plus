// Median of 5 runs per query against the real vocabulary DB. Run before and after a
// change to query shape: the gate has no real DB, so it cannot see a slow query.
process.env.VOCAB_DB_PATH ??= "data/vocabulary.db";
const { VocabularyDb } = await import("../../dist/api/VocabularyDb.js");
const db = new VocabularyDb();
const cases = {
  "creator van": () => db.search({ creator: "van", maxResults: 25 }),
  "creator van + type": () => db.search({ creator: "van", type: ["print"], maxResults: 25 }),
  "persons van": () => db.searchPersons({ name: "van" }),
  "near Amsterdam": () => db.search({ nearPlace: "Amsterdam", maxResults: 25 }),
  "near Paris": () => db.search({ nearPlace: "Paris", maxResults: 25 }),
  "near coords 200km": () => db.search({ nearLat: 48, nearLon: 2, nearPlaceRadius: 200, maxResults: 25 }),
  "near compact": () => db.searchCompact({ nearPlace: "Leiden", maxResults: 25 }),
};
for (const [name, run] of Object.entries(cases)) {
  const ms = [];
  for (let i = 0; i < 5; i++) { const t = performance.now(); run(); ms.push(performance.now() - t); }
  console.log(`${name}: ${ms.sort((a, b) => a - b)[2].toFixed(0)} ms`);
}
