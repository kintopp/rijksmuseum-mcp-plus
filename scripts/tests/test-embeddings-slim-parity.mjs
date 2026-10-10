#!/usr/bin/env node
// Parity check for the vec0-only EmbeddingsDb: filtered KNN, pure KNN and
// description similarity must match the previous plain-table SQL, on both the
// full embeddings.db and the slimmed one (scripts/slim-embeddings-db.py).
//
//   node scripts/tests/test-embeddings-slim-parity.mjs [--slim data/embeddings-slim.db]
//
// Needs ./dist, data/vocabulary.db and data/embeddings.db.

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const i = process.argv.indexOf("--slim");
const FULL = path.join(root, "data/embeddings.db");
const SLIM = i >= 0 ? path.resolve(process.argv[i + 1]) : path.join(root, "data/embeddings-slim.db");
const K = 15;

const { EmbeddingsDb } = await import(path.join(root, "dist/api/EmbeddingsDb.js"));
const { VocabularyDb } = await import(path.join(root, "dist/api/VocabularyDb.js"));

function openEmb(p) {
  process.env.EMBEDDINGS_DB_PATH = p;
  const db = new EmbeddingsDb();
  if (!db.available) throw new Error(`EmbeddingsDb unavailable for ${p}`);
  return db;
}
const full = openEmb(FULL);
const slim = openEmb(SLIM);
const vocab = new VocabularyDb();

// Reference: the previous filtered path, exact over artwork_embeddings.
const ref = new Database(FULL, { readonly: true });
sqliteVec.load(ref);
const quantize = ref.prepare("SELECT vec_quantize_int8(vec_normalize(?), 'unit') v").pluck();
const refStmts = new Map();
function refFiltered(qf32, ids) {
  const q = quantize.get(qf32);
  const out = [];
  for (let s = 0; s < ids.length; s += 998) {
    const chunk = ids.slice(s, s + 998);
    let st = refStmts.get(chunk.length);
    if (!st) {
      st = ref.prepare(`SELECT art_id artId, object_number objectNumber,
        vec_distance_cosine(vec_int8(embedding), vec_int8(?)) distance
        FROM artwork_embeddings WHERE art_id IN (${chunk.map(() => "?").join(",")})`);
      refStmts.set(chunk.length, st);
    }
    out.push(...st.all(q, ...chunk));
  }
  return out.sort((a, b) => a.distance - b.distance || a.artId - b.artId).slice(0, K);
}

// Equal up to the order of exact distance ties.
const key = (rs) => rs.map((r) => `${r.distance.toFixed(6)}`).join(",");
const sorted = (rs) => [...rs].sort((a, b) => a.distance - b.distance || a.artId - b.artId);
function same(a, b) {
  if (a.length !== b.length || key(sorted(a)) !== key(sorted(b))) return false;
  const kth = sorted(a).at(-1)?.distance;
  const strict = (rs) => sorted(rs).filter((r) => r.distance < kth - 1e-9).map((r) => `${r.artId}:${r.objectNumber}`).join();
  return strict(a) === strict(b);
}

let failures = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
  if (!ok) failures++;
};

const vecOf = (artId) => {
  const blob = ref.prepare("SELECT embedding FROM artwork_embeddings WHERE art_id = ?").pluck().get(artId);
  return Float32Array.from(new Int8Array(blob.buffer, blob.byteOffset, blob.length));
};
const someIds = ref.prepare("SELECT art_id FROM artwork_embeddings ORDER BY art_id LIMIT 3 OFFSET 200000").pluck().all();

const FILTERS = [
  { type: "painting" },
  { type: "print" },
  { material: "paper" },
  { type: "drawing", creationDate: "17*" },
  { subject: "ship" },
];

for (const filter of FILTERS) {
  const ids = vocab.filterArtIds(filter);
  if (!ids || ids.length === 0) { check(`filter ${JSON.stringify(filter)}`, false, "no candidates"); continue; }
  for (const qid of someIds) {
    const q = vecOf(qid);
    const expected = refFiltered(q, ids);
    const t0 = performance.now();
    const gotFull = full.searchFiltered(q, ids, K).results;
    const t1 = performance.now();
    const gotSlim = slim.searchFiltered(q, ids, K).results;
    const t2 = performance.now();
    check(`filtered ${JSON.stringify(filter)} (${ids.length.toLocaleString()} cands) q=${qid}`,
      same(expected, gotFull) && same(expected, gotSlim),
      `full ${(t1 - t0).toFixed(0)}ms slim ${(t2 - t1).toFixed(0)}ms`);
  }
}

for (const qid of someIds) {
  const q = vecOf(qid);
  check(`pure KNN q=${qid}`, same(full.search(q, K), slim.search(q, K)));
}

const descIds = ref.prepare("SELECT art_id FROM desc_embeddings ORDER BY art_id LIMIT 3 OFFSET 100000").pluck().all();
const refDescObj = ref.prepare("SELECT object_number FROM desc_embeddings WHERE art_id = ?").pluck();
for (const qid of descIds) {
  const a = full.searchDescriptionSimilar(qid, K);
  const b = slim.searchDescriptionSimilar(qid, K);
  const objOk = b.every((r) => refDescObj.get(r.artId) === r.objectNumber);
  const asDist = (rs) => rs.map((r) => ({ ...r, distance: 1 - r.similarity }));
  check(`description similar q=${qid}`, a.length === K && same(asDist(a), asDist(b)) && objOk);
}

console.log(failures ? `\n${failures} FAILED` : "\nall parity checks passed");
process.exit(failures ? 1 : 0);
