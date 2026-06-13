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
];

// object_number, art_id, title, creator_label, description_text, inscription_text,
// narrative_text, height_cm, width_cm, date_earliest, date_latest, has_image, rights_id, iiif_id
const ARTWORKS = [
  ["FX-1", 1, "The Night Watch Study", "Rembrandt van Rijn", "An oil study of a militia company.", "Rembrandt f 1642", "Curatorial note on the militia study.", 100, 80, 1640, 1642, 1, 2, "iiif-fx-1"],
  ["FX-2", 2, "Winter Landscape with Skaters", "Hendrick Avercamp", "Villagers skating on a frozen river.", null, null, 50, 40, 1608, 1610, 0, 1, null],
  ["FX-3", 3, "Etching of a Windmill", "Anonymous", "A windmill beside a canal.", null, null, 20, 15, 1800, 1850, 1, 3, "iiif-fx-3"],
  ["FX-4", 4, "Untitled Portrait", "Unknown", null, null, null, null, null, null, null, 1, 1, "iiif-fx-4"],
  ["FX-5", 5, "Map of Amsterdam", "Anonymous", "A printed city map.", null, null, 30, 25, 1650, 1650, 0, 2, null],
  ["FX-6", 6, "Self-Portrait", "Rembrandt van Rijn", "The artist in later life.", "aetatis 54", null, 70, 55, 1660, 1660, 1, 2, "iiif-fx-6"],
  ["FX-7", 7, "Tulip Still Life", "Ambrosius Bosschaert", "A vase of tulips in a niche.", null, null, 45, 35, 1620, 1625, 1, 2, "iiif-fx-7"],
  ["FX-8", 8, "Sketch of a Lion", "Anonymous", null, null, null, null, null, 1700, 1700, 0, 1, null],
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

  // External-content FTS: rebuild from the content tables we just populated.
  db.exec("INSERT INTO vocabulary_fts(vocabulary_fts) VALUES('rebuild')");
  db.exec("INSERT INTO artwork_texts_fts(artwork_texts_fts) VALUES('rebuild')");

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
