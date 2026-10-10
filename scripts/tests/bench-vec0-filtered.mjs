#!/usr/bin/env node
// Can vec0 alone serve filtered KNN, so artwork_embeddings (a second copy of
// every vector) can be dropped? Compares the current vec_distance_cosine path
// over artwork_embeddings with vec0 variants, for timing and top-k agreement.
//
//   node scripts/tests/bench-vec0-filtered.mjs [--db data/embeddings.db] [--reps 3]

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const dbPath = opt("--db", "data/embeddings.db");
const reps = Number(opt("--reps", 3));
const K = 15;
const SIZES = [1_000, 10_000, 50_000, 150_000, 399_000];

const db = new Database(dbPath, { readonly: true });
sqliteVec.load(db);
db.pragma("mmap_size = 1073741824");
console.log("sqlite-vec", db.prepare("SELECT vec_version() v").get().v);

const allIds = db.prepare("SELECT art_id FROM artwork_embeddings").pluck().all();
const query = db.prepare("SELECT embedding FROM artwork_embeddings WHERE art_id = ?").pluck().get(allIds[12345]);

let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
function sample(n) {
  const a = allIds.slice();
  for (let i = 0; i < n; i++) { const j = i + Math.floor(rand() * (a.length - i)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, n);
}

const CHUNK = 998;
const stmtCache = new Map();
function chunked(sqlFor, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    let s = stmtCache.get(sqlFor.name + chunk.length);
    if (!s) { s = db.prepare(sqlFor(chunk.length)); stmtCache.set(sqlFor.name + chunk.length, s); }
    out.push(...s.all(query, ...chunk));
  }
  return out.sort((a, b) => a.distance - b.distance).slice(0, K);
}
const ph = (n) => Array.from({ length: n }, () => "?").join(",");

function current(n) {
  return `SELECT art_id AS id, vec_distance_cosine(vec_int8(embedding), vec_int8(?)) AS distance
          FROM artwork_embeddings WHERE art_id IN (${ph(n)})`;
}
function vec0Point(n) {
  return `SELECT artwork_id AS id, vec_distance_cosine(vec_int8(embedding), vec_int8(?)) AS distance
          FROM vec_artworks WHERE artwork_id IN (${ph(n)})`;
}
const knnJson = db.prepare(`
  SELECT artwork_id AS id, distance FROM vec_artworks
  WHERE embedding MATCH vec_int8(?) AND k = ${K}
    AND artwork_id IN (SELECT value FROM json_each(?))
  ORDER BY distance`);

const variants = {
  "current: artwork_embeddings + vec_distance_cosine": (ids) => chunked(current, ids),
  "vec0 point lookups + vec_distance_cosine": (ids) => chunked(vec0Point, ids),
  "vec0 KNN MATCH + artwork_id IN json_each": (ids) => knnJson.all(query, JSON.stringify(ids)),
};

// Unfiltered baseline: what the fallback path costs.
const pure = db.prepare(`SELECT artwork_id AS id, distance FROM vec_artworks
  WHERE embedding MATCH vec_int8(?) AND k = ${K} ORDER BY distance`);
pure.all(query);
let t = performance.now();
for (let r = 0; r < reps; r++) pure.all(query);
console.log(`pure vec0 KNN (no filter): ${((performance.now() - t) / reps).toFixed(0)} ms`);

for (const n of SIZES) {
  const ids = sample(n);
  const ref = variants["current: artwork_embeddings + vec_distance_cosine"](ids).map((r) => r.id).join(",");
  console.log(`\n── ${n.toLocaleString()} candidates`);
  for (const [name, fn] of Object.entries(variants)) {
    let res;
    try {
      fn(ids); // warm
      const t0 = performance.now();
      for (let r = 0; r < reps; r++) res = fn(ids);
      const ms = (performance.now() - t0) / reps;
      const same = res.map((r) => r.id).join(",") === ref;
      console.log(`  ${name.padEnd(52)} ${ms.toFixed(0).padStart(6)} ms  top-${K} ${same ? "identical" : "DIFFERS"}`);
    } catch (err) {
      console.log(`  ${name.padEnd(52)} error: ${err.message}`);
    }
  }
}
