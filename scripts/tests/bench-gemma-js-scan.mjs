// Bench: coarse scan in plain JS over an in-memory int8 buffer (MRL prefix) + exact 768d
// rescore from the prototype's plain table, vs exact vec0 768d k=250 rankings.
// Usage: node scripts/tests/bench-gemma-js-scan.mjs <coarseDims> <candidates> [exact.json]
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";

const D = Number(process.argv[2] ?? 384), C = Number(process.argv[3] ?? 2000), DEPTH = 250, SCALE = 313;
const exactPath = process.argv[4];
const queries = JSON.parse(readFileSync("data/egemma2-test/binary/queries.json", "utf8"))
  .map((r) => Int8Array.from(r.vec, (x) => Math.max(-127, Math.min(127, Math.round(x * SCALE)))));
const db = new Database("data/egemma2-test/binary/proto.db", { readonly: true });

const load = (ch) => {
  const t0 = performance.now();
  const rows = db.prepare(`SELECT artwork_id, embedding FROM ${ch}_vectors ORDER BY artwork_id`).raw().iterate();
  const ids = [], chunks = [];
  for (const [id, e] of rows) { ids.push(id); chunks.push(e.subarray(0, D)); }
  const n = ids.length, vecs = new Int8Array(n * D), inv = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = new Int8Array(chunks[i].buffer, chunks[i].byteOffset, D);
    vecs.set(v, i * D);
    let s = 0; for (let j = 0; j < D; j++) s += v[j] * v[j];
    inv[i] = 1 / Math.sqrt(s);
  }
  console.error(`${ch}: ${n} × ${D} loaded in ${(performance.now() - t0).toFixed(0)} ms (${(vecs.byteLength / 1e6).toFixed(0)} MB)`);
  return { ids: Int32Array.from(ids), vecs, inv, n, fetch: db.prepare(`SELECT artwork_id, embedding FROM ${ch}_vectors WHERE artwork_id IN (SELECT value FROM json_each(?))`) };
};

const topC = (scores, c) => {
  const idx = new Uint32Array(scores.length);
  for (let i = 0; i < idx.length; i++) idx[i] = i;
  // threshold from a sorted copy, then collect — simple and O(n log n) on a Float32Array
  const kth = Float32Array.from(scores).sort()[scores.length - c];
  const out = [];
  for (let i = 0; i < scores.length; i++) if (scores[i] >= kth) out.push(i);
  return out;
};

const search = (T, q) => {
  const t0 = performance.now();
  const { vecs, inv, n } = T, scores = new Float32Array(n);
  for (let i = 0, o = 0; i < n; i++, o += D) {
    let s = 0;
    for (let j = 0; j < D; j++) s += vecs[o + j] * q[j];
    scores[i] = s * inv[i];
  }
  const t1 = performance.now();
  const cand = topC(scores, C).map((i) => T.ids[i]);
  const t2 = performance.now();
  const ranked = T.fetch.all(JSON.stringify(cand)).map((r) => {
    const v = new Int8Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.length);
    let dot = 0, nn = 0;
    for (let i = 0; i < v.length; i++) { dot += v[i] * q[i]; nn += v[i] * v[i]; }
    return [r.artwork_id, dot / Math.sqrt(nn)];
  }).sort((a, b) => b[1] - a[1]).slice(0, DEPTH).map((x) => x[0]);
  return { ranked, scan: t1 - t0, select: t2 - t1, rescore: performance.now() - t2 };
};

const out = {};
for (const ch of ["metadata", "images"]) {
  const T = load(ch);
  for (const q of queries.slice(0, 3)) search(T, q); // JIT warm-up
  const t = { scan: [], select: [], rescore: [], total: [] };
  queries.forEach((q, i) => {
    const r = search(T, q);
    out[`${ch}:${i}`] = r.ranked;
    t.scan.push(r.scan); t.select.push(r.select); t.rescore.push(r.rescore); t.total.push(r.scan + r.select + r.rescore);
  });
  const p50 = (a) => a.sort((x, y) => x - y)[a.length >> 1].toFixed(0);
  console.error(`${ch} D=${D} C=${C}: total p50 ${p50(t.total)} ms (scan ${p50(t.scan)}, select ${p50(t.select)}, rescore ${p50(t.rescore)})`);
}
if (exactPath) {
  const ex = JSON.parse(readFileSync(exactPath, "utf8"));
  for (const ch of ["metadata", "images"]) {
    const ks = Object.keys(ex).filter((k) => k.startsWith(ch));
    for (const K of [10, 50, 250]) {
      const r = ks.map((k) => ex[k].slice(0, K).filter((x) => new Set(out[k].slice(0, K)).has(x)).length / K);
      console.error(`  ${ch} overlap@${K} mean ${(r.reduce((a, b) => a + b) / r.length).toFixed(3)} min ${Math.min(...r).toFixed(2)}`);
    }
  }
}
