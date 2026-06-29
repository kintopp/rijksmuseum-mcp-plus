#!/usr/bin/env node
// build-fixture-vocab-db.mjs — fixture vocabulary DB for hermetic VocabularyDb tests (plans/003).
//
// Run (build, default):   node scripts/tests/build-fixture-vocab-db.mjs
// Run (capture schema):   node scripts/tests/build-fixture-vocab-db.mjs --capture
// Requires: better-sqlite3 (project dep; script lives inside the repo so the ESM
//           resolver finds node_modules/). --capture additionally needs data/vocabulary.db.
//
// Capture mode dumps the real DB's non-internal schema to fixtures/vocab-schema.sql
// (committed). Build mode replays that schema into fixtures/.generated/fixture-vocabulary.db
// and seeds a tiny synthetic dataset — NO access to data/ — so it runs in CI.

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const REAL_DB = path.join(PROJECT_ROOT, "data", "vocabulary.db");
const FIXTURE_DIR = path.join(__dirname, "fixtures");
const SCHEMA_SQL = path.join(FIXTURE_DIR, "vocab-schema.sql");
const GENERATED_DIR = path.join(FIXTURE_DIR, ".generated");
const FIXTURE_DB = path.join(GENERATED_DIR, "fixture-vocabulary.db");

// FTS5 shadow tables belong to an already-captured virtual table — exclude them.
const SHADOW_SUFFIX = /(_data|_idx|_docsize|_config|_content)$/;

// ── Capture: dump real schema to the committed .sql ──────────────────────────
function capture() {
  if (!fs.existsSync(REAL_DB)) {
    console.error(`[capture] ${REAL_DB} not found — capture must run on the maintainer's machine.`);
    process.exit(2);
  }
  const db = new Database(REAL_DB, { readonly: true });
  const rows = db.prepare(
    `SELECT type, name, sql FROM sqlite_master
     WHERE sql IS NOT NULL
     ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name`
  ).all();
  const kept = rows.filter((r) => !r.name.startsWith("sqlite_") && !SHADOW_SUFFIX.test(r.name));
  const version = db.prepare("SELECT key, value FROM version_info").all();
  db.close();

  const header = [
    "-- Captured vocabulary-DB schema for hermetic VocabularyDb fixture tests (plans/003).",
    "-- Source: data/vocabulary.db — regenerate after every harvest and diff for drift:",
    "--   node scripts/tests/build-fixture-vocab-db.mjs --capture",
    "-- version_info at capture:",
    ...version.map((v) => `--   ${v.key} = ${v.value}`),
    `-- captured: ${new Date().toISOString()}`,
    `-- statements: ${kept.length} (tables + indexes; FTS shadow tables excluded)`,
    "",
    "",
  ].join("\n");
  const body = kept.map((r) => `${r.sql};`).join("\n\n");
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  fs.writeFileSync(SCHEMA_SQL, header + body + "\n");
  console.log(`[capture] wrote ${path.relative(PROJECT_ROOT, SCHEMA_SQL)} (${kept.length} statements)`);
}

// ── Seed data (inline constants — no real-DB reads in build mode) ────────────

// All 15 field_lookup names are load-bearing for VocabularyDb.fieldIdMap.
const FIELD_LOOKUP = [
  [1, "attribution_qualifier"], [2, "birth_place"], [3, "collection_set"], [4, "creator"],
  [5, "death_place"], [6, "material"], [7, "production_place"], [8, "production_role"],
  [9, "profession"], [10, "source_type"], [11, "spatial"], [12, "subject"],
  [13, "technique"], [14, "theme"], [15, "type"],
];

// Mirrors the real rights_lookup URIs.
const RIGHTS_LOOKUP = [
  [1, "http://rightsstatements.org/vocab/InC/1.0/"],
  [2, "http://creativecommons.org/publicdomain/mark/1.0/"],
  [3, "http://creativecommons.org/publicdomain/zero/1.0/"],
];

// id, type, label_en, label_nl, label_en_norm, label_nl_norm, vocab_int_id
// label_*_norm = lowercase, space-stripped (matches the LIKE-fallback in findVocabIdsFts).
const VOCAB = [
  ["v-paint", "classification", "painting", "schilderij", "painting", "schilderij", 101],
  ["v-print", "classification", "print", "prent", "print", "prent", 102],
  ["v-canvas", "classification", "canvas", "doek", "canvas", "doek", 103],
  ["v-rembrandt", "person", "Rembrandt van Rijn", "Rembrandt van Rijn", "rembrandtvanrijn", "rembrandtvanrijn", 104],
  ["v-amsterdam", "place", "Amsterdam", "Amsterdam", "amsterdam", "amsterdam", 105],
  ["v-deadmaster", "person", "Old Master", "Old Master", "oldmaster", "oldmaster", 110],
  ["v-photog", "person", "Studio Photographer", "Studio Photographer", "studiophotographer", "studiophotographer", 111],
  ["v-role-fotograaf", "classification", "", "fotograaf", "", "fotograaf", 112],
  ["v-role-afterpaint", "classification", "after painting by", "naar schilderij van", "afterpaintingby", "naarschilderijvan", 113],
  // Depicted persons (type='person', no notation) for find_similar Depicted-Person channel (plan 047).
  ["v-dp-peter", "person", "Saint Peter", "Petrus", "saintpeter", "petrus", 130],
  ["v-dp-orange", "person", "William of Orange", "Willem van Oranje", "williamoforange", "willemvanoranje", 131],
  ["v-dp-maria", "person", "Maria", "Maria", "maria", "maria", 132],
];

// Iconclass notations (vocabulary.notation set) for the find_similar Iconclass channel
// (plan 047). type='concept' keeps them out of the person/place caches (which filter on
// type='person'/'place'); the Iconclass cache keys off notation IS NOT NULL, not type.
// id, type, label_en, label_nl, label_en_norm, label_nl_norm, vocab_int_id, notation
const ICONCLASS_VOCAB = [
  ["v-ic-prey", "concept", "beasts of prey", "roofdieren", "beastsofprey", "roofdieren", 120, "25F23"],
  ["v-ic-saint", "concept", "male saints", "mannelijke heiligen", "malesaints", "mannelijkeheiligen", 121, "11H"],
];

// object_number, art_id, title, creator_label, description_text, inscription_text,
// narrative_text, height_cm, width_cm, date_earliest, date_latest, has_image, rights_id, iiif_id
const ARTWORKS = [
  ["FX-1", 1, "The Night Watch Study", "Rembrandt van Rijn", "An oil study of a militia company.", "signatuur, rechtsonder: ‘Rembrandt f 1642’ | signature, lower right: ‘Rembrandt f 1642’", "Curatorial note on the militia study.", 100, 80, 1640, 1642, 1, 2, "iiif-fx-1"],
  ["FX-2", 2, "Winter Landscape with Skaters", "Hendrick Avercamp", "Villagers skating on a frozen river.", null, null, 50, 40, 1608, 1610, 0, 1, null],
  ["FX-3", 3, "Etching of a Windmill", "Anonymous", "A windmill beside a canal.", null, null, 20, 15, 1800, 1850, 1, 3, "iiif-fx-3"],
  ["FX-4", 4, "Untitled Portrait", "Unknown", null, null, null, null, null, null, null, 1, 1, "iiif-fx-4"],
  ["FX-5", 5, "Map of Amsterdam", "Anonymous", "A printed city map.", null, null, 30, 25, 1650, 1650, 0, 2, null],
  ["FX-6", 6, "Self-Portrait", "Rembrandt van Rijn", "The artist in later life.", "aetatis 54", null, 70, 55, 1660, 1660, 1, 2, "iiif-fx-6"],
  ["FX-7", 7, "Tulip Still Life", "Ambrosius Bosschaert", "A vase of tulips in a niche.", null, null, 45, 35, 1620, 1625, 1, 2, "iiif-fx-7"],
  ["FX-8", 8, "Sketch of a Lion", "Anonymous", null, null, null, null, null, 1700, 1700, 0, 1, null],
  ["FX-9", 9, "Photographic reproduction after an Old Master", "Studio Photographer", "A 19th-c. albumen print reproducing an Old Master painting.", null, null, 30, 24, 1865, 1890, 0, 1, null],
];

// artwork_id (art_id), vocab_rowid (vocab_int_id), field_id
//   type=15 → paintings: FX-1,2,4,6,7 (5);  prints: FX-3,5,8 (3)
//   material=6 → canvas on FX-1;  creator=4 → Rembrandt on FX-1,FX-6
//   subject=12 → Amsterdam depicted on FX-5
const MAPPINGS = [
  [1, 101, 15], [1, 103, 6], [1, 104, 4],
  [2, 101, 15],
  [3, 102, 15],
  [4, 101, 15],
  [5, 102, 15], [5, 105, 12],
  [6, 101, 15], [6, 104, 4],
  [7, 101, 15],
  [8, 102, 15],
  [9, 110, 4], [9, 111, 4], [9, 112, 8], [9, 113, 8],
  // ── find_similar fixtures (plan 047) — subject field (12) ──
  // Iconclass overlap: FX-1 carries 25F23(len5) + 11H(len3). FX-2 shares both,
  // FX-7 shares only 25F23 (depth 5 ≥ MIN_SOLO_NOTATION_DEPTH → kept), FX-3 shares
  // only 11H (depth 3 < 5 → dropped by the solo-notation filter).
  [1, 120, 12], [1, 121, 12],
  [2, 120, 12], [2, 121, 12],
  [3, 121, 12],
  [7, 120, 12],
  // Depicted-Person overlap: FX-1 depicts Saint Peter(130) + William of Orange(131).
  // FX-6 shares both; FX-4 shares only 131; FX-8 carries Maria(132) alone (raises
  // personN so 130/131 keep positive IDF and the two neighbours rank distinctly).
  [1, 130, 12], [1, 131, 12],
  [6, 130, 12], [6, 131, 12],
  [4, 131, 12],
  [8, 132, 12],
];

// artwork_id, creator_id, role_id, part_index — the TRUE row-aware pairing for FX-9.
const PRODUCTION_ROLE_PAIRS = [
  [9, "v-deadmaster", "v-role-afterpaint", 1],
  [9, "v-photog", "v-role-fotograaf", 0],
];

const VERSION_INFO = [
  ["fixture", "true"],
  ["built_at", "fixture-0"],
  ["source", "plans/003 synthetic fixture — not real Rijksmuseum data"],
];

// ── Build: replay schema + seed into the generated fixture DB ─────────────────
export function buildFixture() {
  if (!fs.existsSync(SCHEMA_SQL)) {
    console.error(`[build] ${path.relative(PROJECT_ROOT, SCHEMA_SQL)} missing — run --capture first (needs data/vocabulary.db).`);
    process.exit(2);
  }
  fs.mkdirSync(GENERATED_DIR, { recursive: true });
  for (const f of [FIXTURE_DB, `${FIXTURE_DB}-wal`, `${FIXTURE_DB}-shm`]) {
    fs.rmSync(f, { force: true });
  }

  const raw = fs.readFileSync(SCHEMA_SQL, "utf8");
  // Strip comment-only lines; captured statements contain no internal `;`, so a
  // naive split on `;` is safe and lets us skip individual failing statements.
  const sqlText = raw.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  const statements = sqlText.split(";").map((s) => s.trim()).filter(Boolean);

  const db = new Database(FIXTURE_DB);
  const skipped = [];
  for (const stmt of statements) {
    try {
      db.exec(stmt);
    } catch (err) {
      skipped.push({ stmt: stmt.slice(0, 60).replace(/\s+/g, " "), msg: err.message });
    }
  }
  if (skipped.length > 0) {
    console.error(`[build] skipped ${skipped.length} schema statement(s):`);
    for (const s of skipped) console.error(`  - "${s.stmt}…": ${s.msg}`);
    if (skipped.length > 3) {
      console.error("[build] more than 3 skips — schema replay hit something structural; STOP.");
      process.exit(1);
    }
  }

  const insertMany = (sql, rows) => {
    const stmt = db.prepare(sql);
    const tx = db.transaction((rs) => { for (const r of rs) stmt.run(...r); });
    tx(rows);
  };

  insertMany("INSERT INTO field_lookup (id, name) VALUES (?, ?)", FIELD_LOOKUP);
  insertMany("INSERT INTO rights_lookup (id, uri) VALUES (?, ?)", RIGHTS_LOOKUP);
  insertMany(
    "INSERT INTO vocabulary (id, type, label_en, label_nl, label_en_norm, label_nl_norm, vocab_int_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    VOCAB
  );
  insertMany(
    "INSERT INTO vocabulary (id, type, label_en, label_nl, label_en_norm, label_nl_norm, vocab_int_id, notation) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ICONCLASS_VOCAB
  );
  insertMany(
    `INSERT INTO artworks
       (object_number, art_id, title, title_all_text, creator_label, description_text,
        inscription_text, narrative_text, height_cm, width_cm, date_earliest, date_latest,
        has_image, rights_id, iiif_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    // title_all_text = title for every row; duplicate it after the title column.
    ARTWORKS.map(([objectNumber, artId, title, ...rest]) => [objectNumber, artId, title, title, ...rest])
  );
  insertMany("INSERT INTO mappings (artwork_id, vocab_rowid, field_id) VALUES (?, ?, ?)", MAPPINGS);
  insertMany("INSERT INTO version_info (key, value) VALUES (?, ?)", VERSION_INFO);
  insertMany(
    "INSERT INTO examinations (art_id, seq, examiner_name, report_type_id, report_type_en, date_display, date_begin, date_end) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [[1, 0, "G. Tauber", "https://id.rijksmuseum.nl/22015553", "infrared photography", "2016", "2016-01-01", "2016-12-31"]]
  );
  insertMany(
    "INSERT INTO modifications (art_id, seq, modifier_uri, date_display, date_begin, date_end, description) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [[1, 0, "https://id.rijksmuseum.nl/21059655", "1991 - 1992", "1991-01-01", "1992-12-31", "complete restoration"]]
  );
  // Seed TWO rows with label_text = null (the production shape — label_text is empty for every
  // harvested row) and the two real evidence_type_aat codes, so the counts assertion is meaningful.
  insertMany(
    "INSERT INTO attribution_evidence (art_id, part_index, evidence_type_aat, carried_by_uri, label_text) VALUES (?, ?, ?, ?, ?)",
    [
      [1, 0, "http://vocab.getty.edu/aat/300028702", "https://id.rijksmuseum.nl/200111", null],
      [1, 1, "http://vocab.getty.edu/aat/300028705", "https://id.rijksmuseum.nl/200222", null],
    ]
  );
  insertMany(
    "INSERT INTO production_role_pairs (artwork_id, creator_id, role_id, part_index) VALUES (?, ?, ?, ?)",
    PRODUCTION_ROLE_PAIRS
  );
  // vocabulary_external_ids — exercise the allowlist (rijks_internal MUST be excluded).
  const VOCAB_EXTERNAL_IDS = [
    ["v-rembrandt", "wikidata", "Q5598", "http://www.wikidata.org/entity/Q5598"],
    ["v-rembrandt", "viaf", "64013650", "http://viaf.org/viaf/64013650"],
    ["v-rembrandt", "ulan", "500011051", "http://vocab.getty.edu/ulan/500011051"],
    ["v-rembrandt", "rkd", "66219", "https://rkd.nl/explore/artists/66219"],
    ["v-rembrandt", "rijks_internal", "JUNK-1", "urn:internal:JUNK-1"], // must NOT appear in output
    ["v-amsterdam", "tgn", "7006952", "http://vocab.getty.edu/tgn/7006952"],
    ["v-amsterdam", "geonames", "2759794", "https://sws.geonames.org/2759794/"],
    ["v-paint", "aat", "300033618", "http://vocab.getty.edu/aat/300033618"],
  ];
  insertMany(
    "INSERT INTO vocabulary_external_ids (vocab_id, authority, id, uri) VALUES (?, ?, ?, ?)",
    VOCAB_EXTERNAL_IDS
  );
  // Three citation rows for FX-1 (art_id 1) covering all three shapes.
  // FX-2 intentionally has no rows — used for the empty-case test.
  // FX-3 (art_id 3) cites ONE publication (301999001) on TWO rows (different page
  // ranges) — exercises the SELECT DISTINCT dedup in getArtworksCitingPublication.
  insertMany(
    "INSERT INTO artwork_citations (art_id, seq, citation_text, publication_id, pages, isbn, worldcat_uri, library_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [
      // Type B: inline string, no publication link
      [1, 1, "E. van Duijn; J.P. Filedt Kok, The Art of Conservation III, The Burlington Magazine, 158, 2016, p. 117-128", null, "p. 117-128", null, null, null],
      // Type A: composed from a resolved publication (publication_id = full URI segment)
      [1, 2, "P. Broekhoff, Catalogue of Dutch Paintings (Amsterdam, 1976), p. 169-170", 301154354, "p. 169-170", null, "http://www.worldcat.org/oclc/123456", "https://library.rijksmuseum.nl/.../301154354"],
      // Type C: composed from a bare BIBFRAME instance
      [1, 3, "Bulletin van het Rijksmuseum, 64 (2016)", 301234479, null, null, null, null],
      // FX-3 cites publication 301999001 twice (distinct page ranges) — dedup fixture.
      [3, 1, "J. Jansen, Dutch Etchings (Amsterdam, 1980), p. 12", 301999001, "p. 12", null, null, null],
      [3, 2, "J. Jansen, Dutch Etchings (Amsterdam, 1980), p. 45", 301999001, "p. 45", null, null, null],
    ]
  );

  // related_objects — frame/pedestal physical companions for FX-1 (art_id 1).
  // related_art_id points at a peer artwork so the LEFT JOIN resolves object_number/title.
  const RELATED_OBJECTS = [
    [1, "https://id.rijksmuseum.nl/peer-frame-cur", 3, "object | current frame", "object | huidige lijst"],
    [1, "https://id.rijksmuseum.nl/peer-frame-old", null, "object | former frame", "object | voormalige lijst"],
    [1, "https://id.rijksmuseum.nl/peer-pedestal", 4, "object | pedestal", "object | sokkel"],
  ];
  insertMany(
    "INSERT INTO related_objects (art_id, related_la_uri, related_art_id, relationship_en, relationship_nl) VALUES (?, ?, ?, ?, ?)",
    RELATED_OBJECTS
  );

  // person_names — variants for v-rembrandt (one equals the primary label, must be filtered out).
  const PERSON_NAMES = [
    ["v-rembrandt", "Rembrandt van Rijn", "en", "display"],     // == primary label → excluded
    ["v-rembrandt", "Rijn, Rembrandt van", "nl", "inverted"],
    ["v-rembrandt", "Rembrandt Harmensz. van Rijn", "nl", "alternate"],
    ["v-rembrandt", "Rijn, Rembrandt van", "en", "former"],     // DUPLICATE name (diff lang) → must collapse to one
  ];
  insertMany(
    "INSERT INTO person_names (person_id, name, lang, classification) VALUES (?, ?, ?, ?)",
    PERSON_NAMES
  );

  // External-content FTS: rebuild from the content tables we just populated.
  db.exec("INSERT INTO vocabulary_fts(vocabulary_fts) VALUES('rebuild')");
  db.exec("INSERT INTO artwork_texts_fts(artwork_texts_fts) VALUES('rebuild')");
  db.exec("INSERT INTO person_names_fts(person_names_fts) VALUES('rebuild')");

  const n = db.prepare("SELECT COUNT(*) AS n FROM artworks").get().n;
  db.close();
  console.log(`[build] wrote ${path.relative(PROJECT_ROOT, FIXTURE_DB)} — ${n} artworks, ${VOCAB.length} vocab terms, ${MAPPINGS.length} mappings`);
  return FIXTURE_DB;
}

// CLI entry
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--capture")) capture();
  else buildFixture();
}
