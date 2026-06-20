// Benchmark for issue #74: native vec0 partition-key / metadata-column pre-filtering
// vs the current chunked vec_distance_cosine filtered path.
//
// Builds a throwaway native vec0 table (partition key = type_id, metadata cols =
// material_id, technique_id) populated from the REAL embeddings.db vectors, then
// times native filtered KNN against it. Compares to the existing chunked path.
//
// Run: node scripts/tests/bench-native-prefilter.mjs
import Database from "better-sqlite3";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const sqliteVec = require("sqlite-vec");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const EMB = path.join(root, "data/embeddings.db");
const VOCAB = path.join(root, "data/vocabulary.db");

function hrms(t0) { return (Number(process.hrtime.bigint() - t0) / 1e6); }
function now() { return process.hrtime.bigint(); }

// ── Open source DBs ──────────────────────────────────────────────
const emb = new Database(EMB, { readonly: true });
emb.pragma("mmap_size = 1073741824");
sqliteVec.load(emb);
const vocab = new Database(VOCAB, { readonly: true });
vocab.pragma("mmap_size = 1073741824");

// ── Build a throwaway in-memory query vector (normalized int8) ──
const DIM = 384;
function randomQueryInt8() {
  // pick a real artwork's embedding as the query (realistic distances)
  const row = emb.prepare("SELECT embedding FROM artwork_embeddings ORDER BY art_id LIMIT 1 OFFSET 12345").get();
  return row.embedding; // already int8 blob
}
const qInt8 = randomQueryInt8();

// ── CURRENT PATH: chunked vec_distance_cosine over candidate art_ids ──
function currentFiltered(candidateArtIds, k) {
  const CHUNK = 998;
  const all = [];
  for (let i = 0; i < candidateArtIds.length; i += CHUNK) {
    const chunk = candidateArtIds.slice(i, i + CHUNK);
    const ph = chunk.map(() => "?").join(",");
    const stmt = emb.prepare(`
      SELECT art_id AS artId,
             vec_distance_cosine(vec_int8(embedding), vec_int8(?)) AS distance
      FROM artwork_embeddings WHERE art_id IN (${ph}) ORDER BY distance`);
    all.push(...stmt.all(qInt8, ...chunk));
  }
  all.sort((a, b) => a.distance - b.distance);
  return all.slice(0, k);
}

// ── PURE KNN + post-filter (the >200K fallback) ──
const knnStmt = emb.prepare(`
  SELECT artwork_id, distance FROM vec_artworks
  WHERE embedding MATCH vec_int8(?) AND k = ? ORDER BY distance`);
function pureKnnPostFilter(candidateSet, k) {
  const rows = knnStmt.all(qInt8, 4096);
  const out = [];
  for (const r of rows) { if (candidateSet.has(r.artwork_id)) out.push(r); if (out.length >= k) break; }
  return out;
}

// ── Resolve candidate art_ids for a (field_id, label_nl) filter ──
function candidatesFor(fieldId, labelNl, limit = 200000) {
  return vocab.prepare(`
    SELECT DISTINCT m.artwork_id AS art_id
    FROM mappings m JOIN vocabulary v ON v.vocab_int_id = m.vocab_rowid
    WHERE m.field_id = ? AND v.label_nl = ? LIMIT ?`).all(fieldId, labelNl, limit).map(r => r.art_id);
}

// ── Build a native vec0 prototype: partition key type_id + metadata material/technique ──
// Picks ONE (lowest vocab_rowid) value per field per artwork — lossy by construction.
function buildNativePrototype() {
  console.log("\nBuilding native vec0 prototype (partition=type_id, meta=material_id,technique_id)…");
  const t0 = now();
  const proto = new Database(":memory:");
  sqliteVec.load(proto);
  proto.exec(`CREATE VIRTUAL TABLE vec_native USING vec0(
      artwork_id INTEGER PRIMARY KEY,
      type_id INTEGER PARTITION KEY,
      material_id INTEGER,
      technique_id INTEGER,
      embedding int8[${DIM}] distance_metric=cosine
  );`);

  // Pull one type/material/technique per artwork from vocab DB into a Map
  const pick = (fid) => {
    const m = new Map();
    const rows = vocab.prepare(
      `SELECT artwork_id, MIN(vocab_rowid) v FROM mappings WHERE field_id=? GROUP BY artwork_id`
    ).all(fid);
    for (const r of rows) m.set(r.artwork_id, r.v);
    return m;
  };
  const typeMap = pick(15), matMap = pick(6), techMap = pick(13);

  const ins = proto.prepare(
    `INSERT INTO vec_native(artwork_id, type_id, material_id, technique_id, embedding)
     VALUES (?,?,?,?,vec_int8(?))`);
  const insMany = proto.transaction((rows) => {
    for (const r of rows) {
      // vec0 partition/metadata INTEGER columns are strict on storage class —
      // better-sqlite3 binds JS numbers as doubles, so force BigInt → INTEGER.
      ins.run(BigInt(r.art_id),
        BigInt(typeMap.get(r.art_id) ?? 0),
        BigInt(matMap.get(r.art_id) ?? 0),
        BigInt(techMap.get(r.art_id) ?? 0),
        r.embedding);
    }
  });
  const allEmb = emb.prepare("SELECT art_id, embedding FROM artwork_embeddings").all();
  // batch insert
  const B = 5000;
  for (let i = 0; i < allEmb.length; i += B) insMany(allEmb.slice(i, i + B));
  console.log(`  built ${allEmb.length.toLocaleString()} rows in ${(hrms(t0)/1000).toFixed(1)}s`);
  return { proto, typeMap, matMap, techMap };
}

// ── Native filtered KNN: WHERE on partition/metadata before distance ──
function nativeFiltered(proto, where, params, k) {
  const stmt = proto.prepare(`
    SELECT artwork_id, distance FROM vec_native
    WHERE embedding MATCH vec_int8(?) AND k = ? ${where ? "AND " + where : ""}
    ORDER BY distance`);
  return stmt.all(qInt8, BigInt(k), ...params.map(p => BigInt(p)));
}

function timeIt(label, fn, runs = 5) {
  fn(); // warm
  const ts = [];
  for (let i = 0; i < runs; i++) { const t0 = now(); fn(); ts.push(hrms(t0)); }
  ts.sort((a, b) => a - b);
  console.log(`  ${label.padEnd(48)} median ${ts[Math.floor(runs/2)].toFixed(1)}ms  (min ${ts[0].toFixed(1)} max ${ts[runs-1].toFixed(1)})`);
  return ts[Math.floor(runs/2)];
}

// ── Run ──
console.log("=== Issue #74 native pre-filter benchmark ===");
console.log("Vectors:", emb.prepare("SELECT COUNT(*) c FROM artwork_embeddings").get().c.toLocaleString());

const cases = [
  ["type=schilderij(painting)", 15, "schilderij"],
  ["material=perkament(parchment)", 6, "perkament"],
  ["type=prent(print) [>200K→fallback]", 15, "prent"],
];

console.log("\n--- CURRENT chunked path (baseline) ---");
const baseline = {};
for (const [name, fid, label] of cases) {
  const ids = candidatesFor(fid, label);
  if (ids.length === 0) { console.log(`  ${name}: 0 candidates (label miss) — skip`); continue; }
  if (ids.length >= 200000) {
    const set = new Set(ids);
    baseline[name] = timeIt(`${name} [${ids.length} cand] pureKNN+postfilter`, () => pureKnnPostFilter(set, 15));
  } else {
    baseline[name] = timeIt(`${name} [${ids.length} cand] chunked`, () => currentFiltered(ids, 15));
  }
}

// ── Flat prototype (no partition key) for the unfiltered-tax comparison ──
function buildFlatPrototype() {
  console.log("\nBuilding FLAT vec0 prototype (no partition key)…");
  const t0 = now();
  const flat = new Database(":memory:");
  sqliteVec.load(flat);
  flat.exec(`CREATE VIRTUAL TABLE vec_flat USING vec0(
      artwork_id INTEGER PRIMARY KEY,
      embedding int8[${DIM}] distance_metric=cosine
  );`);
  const ins = flat.prepare(`INSERT INTO vec_flat(artwork_id, embedding) VALUES (?, vec_int8(?))`);
  const insMany = flat.transaction((rows) => {
    for (const r of rows) ins.run(BigInt(r.art_id), r.embedding);
  });
  const allEmb = emb.prepare("SELECT art_id, embedding FROM artwork_embeddings").all();
  const B = 5000;
  for (let i = 0; i < allEmb.length; i += B) insMany(allEmb.slice(i, i + B));
  console.log(`  built in ${(hrms(t0)/1000).toFixed(1)}s`);
  return flat;
}

const { proto } = buildNativePrototype();
console.log("\n--- NATIVE vec0 partition/metadata path ---");
// Map labels to the picked ids used in the prototype
function vocabRowidFor(label) {
  const r = vocab.prepare(`SELECT vocab_int_id v FROM vocabulary WHERE label_nl=? LIMIT 1`).get(label);
  return r?.v;
}
for (const [name, fid, label] of cases) {
  const vid = vocabRowidFor(label);
  if (vid == null) { console.log(`  ${name}: label miss — skip`); continue; }
  const col = fid === 15 ? "type_id" : fid === 6 ? "material_id" : "technique_id";
  // NOTE: prototype stored only the MIN vocab_rowid per artwork, so this WHERE
  // only matches artworks whose *first* value equals vid — recall is lossy.
  timeIt(`${name} native WHERE ${col}=${vid}`, () => nativeFiltered(proto, `${col} = ?`, [vid], 15));
}

// ── The hidden tax: partition key affects the UNFILTERED pure-KNN path too ──
const flat = buildFlatPrototype();
console.log("\n--- UNFILTERED pure-KNN: partition tax (the dominant query has NO filters) ---");
const knnFlat = flat.prepare(`SELECT artwork_id, distance FROM vec_flat WHERE embedding MATCH vec_int8(?) AND k = ? ORDER BY distance`);
const knnPart = proto.prepare(`SELECT artwork_id, distance FROM vec_native WHERE embedding MATCH vec_int8(?) AND k = ? ORDER BY distance`);
timeIt("flat (no partition) unfiltered KNN", () => knnFlat.all(qInt8, 15n));
timeIt("partitioned (type_id) unfiltered KNN", () => knnPart.all(qInt8, 15n));
timeIt("prod vec_artworks unfiltered KNN", () => knnStmt.all(qInt8, 15));

console.log("\nDone.");
