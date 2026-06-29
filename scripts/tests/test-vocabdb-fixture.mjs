/**
 * Hermetic characterization tests for VocabularyDb (plans/003).
 *
 * Builds a tiny synthetic fixture DB (committed schema dump + inline seed,
 * no data/ access) and LOCKS IN the current behavior of the core query
 * builders that search_artwork / get_artwork_details depend on. These are
 * characterization tests: they assert what the code does TODAY, so a future
 * refactor of VocabularyDb that changes a result is forced to surface here.
 *
 * Run:  node scripts/tests/test-vocabdb-fixture.mjs
 * Requires: npm run build (imports from dist/).
 */
import { strict as assert } from "node:assert";
import { buildFixture } from "./build-fixture-vocab-db.mjs";

// Build the fixture, point the DB resolver at it BEFORE constructing the class.
const dbPath = buildFixture();
process.env.VOCAB_DB_PATH = dbPath;
const { VocabularyDb } = await import("../../dist/api/VocabularyDb.js");
const db = new VocabularyDb();

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };
const objs = (res) => res.results.map((r) => r.objectNumber).sort();

console.log("\nVocabularyDb fixture characterization tests\n");

// ── Readiness ────────────────────────────────────────────────────────────
check("db.available is true against the fixture", () => {
  assert.equal(db.available, true);
});

// ── Vocab filters resolve through FTS → mappings ───────────────────────────
check("type:painting returns exactly the type-mapped paintings", () => {
  assert.deepEqual(objs(db.search({ type: ["painting"] })), ["FX-1", "FX-2", "FX-4", "FX-6", "FX-7"]);
});

check("type:print returns exactly the type-mapped prints", () => {
  assert.deepEqual(objs(db.search({ type: ["print"] })), ["FX-3", "FX-5", "FX-8"]);
});

check("material:canvas intersects to the single canvas painting", () => {
  assert.deepEqual(objs(db.search({ material: ["canvas"] })), ["FX-1"]);
});

check("creator name resolves via FTS phrase to both Rembrandt works", () => {
  assert.deepEqual(objs(db.search({ creator: ["Rembrandt van Rijn"] })), ["FX-1", "FX-6"]);
});

// ── Combined / structured filters ──────────────────────────────────────────
check("type + creationDate (exact year, overlaps) intersects correctly", () => {
  // 1642 overlaps only FX-1 (1640-1642); FX-6/FX-7/FX-2 fall outside.
  assert.deepEqual(
    objs(db.search({ type: ["painting"], creationDate: "1642", dateMatch: "overlaps" })),
    ["FX-1"],
  );
});

check("minHeight bound returns artworks at/above the threshold", () => {
  // height_cm >= 60: FX-1 (100), FX-6 (70). Locks current inclusive-bound behavior.
  assert.deepEqual(objs(db.search({ minHeight: 60 })), ["FX-1", "FX-6"]);
});

check("imageAvailable:true + type:print keeps only digitised prints", () => {
  // Of the prints, only FX-3 has has_image = 1.
  assert.deepEqual(objs(db.search({ type: ["print"], imageAvailable: true })), ["FX-3"]);
});

// ── Empty result is a shape, not a throw ───────────────────────────────────
check("unmatched type returns empty results without throwing", () => {
  const res = db.search({ type: ["sculpture"] });
  assert.deepEqual(res.results, []);
  assert.equal(res.source, "vocabulary");
});

// ── Pagination ─────────────────────────────────────────────────────────────
check("maxResults caps the page size", () => {
  assert.equal(db.search({ type: ["painting"], maxResults: 2 }).results.length, 2);
});

check("offset advances to a disjoint page", () => {
  const page1 = objs(db.search({ type: ["painting"], maxResults: 2, offset: 0 }));
  const page2 = objs(db.search({ type: ["painting"], maxResults: 2, offset: 2 }));
  assert.equal(page1.length, 2);
  assert.equal(page2.length, 2);
  assert.equal(page1.some((o) => page2.includes(o)), false, "pages overlap");
});

// ── Detail lookup round-trip ───────────────────────────────────────────────
check("getArtworkDetail round-trips fields + grouped mappings", () => {
  const d = db.getArtworkDetail("FX-1");
  assert.ok(d, "detail not found");
  assert.equal(d.objectNumber, "FX-1");
  assert.equal(d.title, "The Night Watch Study");
  assert.equal(d.creator, "Rembrandt van Rijn");
  assert.equal(d.type, "painting");
  assert.equal(d.license, "http://creativecommons.org/publicdomain/mark/1.0/"); // rights_id 2
  assert.deepEqual(d.objectTypes.map((t) => t.label), ["painting"]);
  assert.deepEqual(d.materials.map((m) => m.label), ["canvas"]);
  assert.equal(d.production[0].name, "Rembrandt van Rijn");
  // Raw `| `-split segments (NL form + EN gloss), as get_artwork_details returns them.
  assert.deepEqual(d.inscriptions, [
    "signatuur, rechtsonder: ‘Rembrandt f 1642’",
    "signature, lower right: ‘Rembrandt f 1642’",
  ]);
  const dims = Object.fromEntries(d.dimensions.map((x) => [x.type, x.value]));
  assert.equal(dims.height, 100);
  assert.equal(dims.width, 80);
});

check("getArtworkDetail returns null for an unknown object number", () => {
  assert.equal(db.getArtworkDetail("NOPE-1"), null);
});

check("getArtworkDetail surfaces attributionMarks counts, not the old array", () => {
  const d = db.getArtworkDetail("FX-1");
  assert.ok(d, "FX-1 not found");
  assert.equal(d.attributionEvidence, undefined, "old attributionEvidence array must be gone");
  assert.deepEqual(d.attributionMarks, { signatures: 1, inscriptions: 1, total: 2 });
  const d2 = db.getArtworkDetail("FX-2");
  assert.deepEqual(d2.attributionMarks, { signatures: 0, inscriptions: 0, total: 0 });
});

check("getArtworkDetail reports bibliographyCount for a cited artwork", () => {
  const d = db.getArtworkDetail("FX-1");
  assert.ok(d);
  assert.equal(d.bibliographyCount, 3);
});

check("getArtworkDetail reports bibliographyCount 0 for an uncited artwork", () => {
  const d = db.getArtworkDetail("FX-2");
  assert.ok(d);
  assert.equal(d.bibliographyCount, 0);
});

check("getArtworkDetail surfaces physicalRelations (frame/pedestal), separate from relatedObjects", () => {
  const d = db.getArtworkDetail("FX-1");
  assert.ok(d, "FX-1 not found");
  assert.equal(d.physicalRelationsTotalCount, 3);
  // ordered by relationship_en then object_number (current frame, former frame, pedestal)
  assert.deepEqual(d.physicalRelations.map((r) => r.relationship),
    ["object | current frame", "object | former frame", "object | pedestal"]);
  // current frame resolved to peer FX-3 via related_art_id
  const cur = d.physicalRelations.find((r) => r.relationship === "object | current frame");
  assert.equal(cur.objectNumber, "FX-3");
  assert.equal(cur.objectUri, "https://id.rijksmuseum.nl/peer-frame-cur");
  // former frame has no in-fixture peer → null objectNumber but URI preserved
  const old = d.physicalRelations.find((r) => r.relationship === "object | former frame");
  assert.equal(old.objectNumber, null);
  assert.equal(old.objectUri, "https://id.rijksmuseum.nl/peer-frame-old");
  // the existing relatedObjects (variant) path is unaffected — FX-1 has no variant edges
  assert.deepEqual(d.relatedObjects, []);
  assert.equal(d.relatedObjectsTotalCount, 0);
});

check("getArtworkDetail returns empty physicalRelations when none", () => {
  const d = db.getArtworkDetail("FX-2");
  assert.deepEqual(d.physicalRelations, []);
  assert.equal(d.physicalRelationsTotalCount, 0);
});

// ── Batch / lookup helpers ─────────────────────────────────────────────────
check("lookupTypes maps object numbers to their type label", () => {
  const m = db.lookupTypes(["FX-1", "FX-3"]);
  assert.equal(m.get("FX-1"), "painting");
  assert.equal(m.get("FX-3"), "print");
});

check("batchLookupByArtId returns metadata keyed by art_id", () => {
  const m = db.batchLookupByArtId([1, 3]);
  assert.equal(m.get(1).objectNumber, "FX-1");
  assert.equal(m.get(1).creator, "Rembrandt van Rijn");
  assert.equal(m.get(3).objectNumber, "FX-3");
});

check("reconstructSourceText assembles the labelled composite text", () => {
  const m = db.reconstructSourceText([1]);
  const text = m.get(1);
  assert.ok(text.includes("[Title] The Night Watch Study"), "title segment");
  assert.ok(text.includes("[Inscriptions] Rembrandt f 1642"), "inscription segment");
  assert.ok(text.includes("[Description] An oil study"), "description segment");
  assert.ok(text.includes("[Narrative] Curatorial note"), "narrative segment");
});

check("getConservationHistory returns the forensic surfaces + attribution presence signal", () => {
  const d = db.getConservationHistory("FX-1"); // the object you seeded
  assert.ok(d, "conservation history not found");
  assert.equal(d.examinationsTotalCount, 1);
  assert.equal(d.examinations[0].reportTypeLabel, "infrared photography");
  assert.equal(d.examinations[0].reportTypeId, "https://id.rijksmuseum.nl/22015553");
  assert.equal(d.conservationHistoryTotalCount, 1);
  assert.equal(d.conservationHistory[0].description, "complete restoration");
  assert.equal(d.conservationHistory[0].modifierUri, "https://id.rijksmuseum.nl/21059655");
  // attribution surfaced as counts, NOT a row array; label_text is null in production
  assert.equal(d.attributionMarks.signatures, 1);
  assert.equal(d.attributionMarks.inscriptions, 1);
  assert.equal(d.attributionMarks.total, 2);
});

check("getConservationHistory returns empty arrays / zero counts for an artwork with no forensic data", () => {
  const d = db.getConservationHistory("FX-2"); // an object you did NOT seed
  assert.ok(d, "header not found");
  assert.deepEqual(d.examinations, []);
  assert.equal(d.examinationsTotalCount, 0);
  assert.deepEqual(d.conservationHistory, []);
  assert.deepEqual(d.attributionMarks, { signatures: 0, inscriptions: 0, total: 0 });
});

check("getConservationHistory returns null for an unknown objectNumber", () => {
  assert.equal(db.getConservationHistory("NOPE-9999"), null);
});

check("getBibliography returns all entries with full=true (limit 0)", () => {
  const d = db.getBibliography("FX-1", { limit: 0 });
  assert.ok(d, "bibliography not found");
  assert.equal(d.total, 3);
  assert.equal(d.entries.length, 3);
  assert.equal(d.entries[0].sequence, 1);
  assert.ok(d.entries[0].citation.includes("Burlington"), `entry 0 citation should mention Burlington: ${d.entries[0].citation}`);
  assert.equal(d.entries[0].publicationUri, null, "Type B should have no publicationUri");
  assert.equal(d.entries[1].publicationUri, "https://id.rijksmuseum.nl/301154354", "Type A publicationUri");
  assert.equal(d.entries[1].worldcatUri, "http://www.worldcat.org/oclc/123456", "Type A worldcatUri");
});

check("getBibliography honors the limit (summary mode)", () => {
  const d = db.getBibliography("FX-1", { limit: 2 });
  assert.equal(d.total, 3, "total is the FULL count");
  assert.equal(d.entries.length, 2, "entries capped at limit");
});

check("getBibliography returns total 0 for an artwork with no citations", () => {
  const d = db.getBibliography("FX-2", { limit: 0 });
  assert.ok(d);
  assert.equal(d.total, 0);
  assert.deepEqual(d.entries, []);
});

check("getBibliography returns null for an unknown objectNumber", () => {
  assert.equal(db.getBibliography("NOPE-9999", {}), null);
});

check("getArtworksCitingPublication finds the citing artwork", () => {
  const d = db.getArtworksCitingPublication(301154354, {});
  assert.equal(d.total, 1);
  assert.equal(d.artworks[0].objectNumber, "FX-1");
  assert.equal(d.publicationUri, "https://id.rijksmuseum.nl/301154354");
});

check("getArtworksCitingPublication returns total 0 for an uncited publication", () => {
  const d = db.getArtworksCitingPublication(999999, {});
  assert.equal(d.total, 0);
  assert.deepEqual(d.artworks, []);
});

check("getArtworksCitingPublication dedupes an artwork citing a publication on multiple rows (DISTINCT)", () => {
  const d = db.getArtworksCitingPublication(301999001, {});
  assert.equal(d.total, 1, "FX-3 cites 301999001 on two citation rows but must be counted once");
  assert.equal(d.artworks.length, 1);
  assert.equal(d.artworks[0].objectNumber, "FX-3");
});

check("getArtworkDetail surfaces equivalents[] from vocabulary_external_ids (allowlist applied)", () => {
  const d = db.getArtworkDetail("FX-1");
  assert.ok(d, "FX-1 not found");
  // production creator Rembrandt → 4 external authorities, rijks_internal filtered out
  const prod = d.production.find((p) => p.actorUri === "v-rembrandt");
  assert.ok(prod, "Rembrandt production entry missing");
  assert.deepEqual(prod.equivalents.map((e) => e.authority), ["wikidata", "viaf", "ulan", "rkd"]);
  assert.equal(prod.equivalents.some((e) => e.authority === "rijks_internal"), false, "internal authority leaked");
  assert.equal(prod.equivalents[0].uri, "http://www.wikidata.org/entity/Q5598");
  // objectTypes term 'painting' (v-paint) → AAT
  const paint = d.objectTypes.find((t) => t.id === "v-paint");
  assert.deepEqual(paint.equivalents.map((e) => e.authority), ["aat"]);
});

check("getArtworkDetail surfaces depictedPlaces equivalents (TGN/GeoNames)", () => {
  const d = db.getArtworkDetail("FX-5");
  assert.ok(d, "FX-5 not found");
  const ams = d.subjects.depictedPlaces.find((p) => p.id === "v-amsterdam");
  assert.ok(ams, "Amsterdam depictedPlace missing");
  assert.deepEqual(ams.equivalents.map((e) => e.authority), ["tgn", "geonames"]);
});

check("terms with no external ids omit equivalents", () => {
  const d = db.getArtworkDetail("FX-1");
  const canvas = d.materials.find((m) => m.id === "v-canvas");
  assert.equal(canvas.equivalents, undefined, "equivalents should be omitted, not []");
});

check("getArtworkDetail pairs production role↔creator row-aware, not positionally (#354 / RP-F-00-173)", () => {
  const d = db.getArtworkDetail("FX-9");
  assert.ok(d, "FX-9 not found");
  const roleOf = (uri) => d.production.find((p) => p.actorUri === uri)?.role;
  // The dead source painter must be 'after painting by', NOT the photographer of his own reproduction.
  assert.equal(roleOf("v-deadmaster"), "after painting by", "source painter must be 'after painting by', not fotograaf");
  // The 19th-c. photographer must carry 'fotograaf' (label_en empty → label_nl fallback).
  assert.equal(roleOf("v-photog"), "fotograaf", "photographer must carry fotograaf");
});

// ── search_persons equivalents + nameVariants ──────────────────────────────
check("searchPersons surfaces equivalents[] and nameVariants[] for a known person", () => {
  const res = db.searchPersons({ name: "Rembrandt", hasArtworks: false });
  const r = res.persons.find((p) => p.vocabId === "v-rembrandt");
  assert.ok(r, "Rembrandt not found in search_persons");
  assert.deepEqual(r.equivalents.map((e) => e.authority), ["wikidata", "viaf", "ulan", "rkd"]);
  assert.equal(r.equivalents.some((e) => e.authority === "rijks_internal"), false);
  // nameVariants excludes the primary-label echo
  assert.deepEqual(r.nameVariants.sort(), ["Rembrandt Harmensz. van Rijn", "Rijn, Rembrandt van"]);
  assert.equal(r.nameVariants.includes("Rembrandt van Rijn"), false, "primary label leaked into variants");
});

check("searchPersons omits equivalents/nameVariants for persons with none", () => {
  // Use no-name search to avoid FTS dependency — v-photog has no person_names rows.
  const res = db.searchPersons({ hasArtworks: false });
  const r = res.persons.find((p) => p.vocabId === "v-photog");
  assert.ok(r, "v-photog not found");
  assert.equal(r.equivalents, undefined);
  assert.equal(r.nameVariants, undefined);
});

check("searchPersons de-duplicates nameVariants (same name across lang/classification rows)", () => {
  const res = db.searchPersons({ name: "Rembrandt", hasArtworks: false });
  const r = res.persons.find((p) => p.vocabId === "v-rembrandt");
  assert.ok(r, "Rembrandt not found in search_persons");
  // "Rijn, Rembrandt van" is seeded twice (lang nl + en) — must appear exactly once.
  assert.equal(r.nameVariants.length, new Set(r.nameVariants).size, "nameVariants contains duplicates");
  assert.equal(r.nameVariants.filter((n) => n === "Rijn, Rembrandt van").length, 1, "duplicate name not collapsed");
});

console.log(`\n${passed} passed\n`);
