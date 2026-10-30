// Scratch probe: find_similar Description channel on gemma.db's two-stage `descriptions`
// table vs an exact brute-force cosine over the same int8 vectors, plus per-call latency.
// Usage: GEMMA_DB_PATH=data/gemma.db node scripts/tests/probe-description-gemma.mjs [seeds=25]
import Database from "better-sqlite3";
import { GemmaDb } from "../../dist/api/GemmaDb.js";

process.env.GEMMA_DB_PATH ??= "data/gemma.db";
const N_SEEDS = parseInt(process.argv[2] ?? "25", 10);
const K = 10;

const g = new GemmaDb();
if (!g.descriptionsAvailable) {
  console.error("descriptions channel missing from", process.env.GEMMA_DB_PATH);
  process.exit(1);
}
let t0 = performance.now();
await g.loadCoarse(() => Promise.resolve());
console.log(`coarse load ${Math.round(performance.now() - t0)} ms`);

const db = new Database(process.env.GEMMA_DB_PATH, { readonly: true });
const rows = db.prepare("SELECT artwork_id, embedding FROM gemma_descriptions_vectors").all();
const D = rows[0].embedding.length;
const ids = new Int32Array(rows.length);
const vecs = new Int8Array(rows.length * D);
const norms = new Float32Array(rows.length);
rows.forEach((r, i) => {
  ids[i] = r.artwork_id;
  vecs.set(new Int8Array(r.embedding.buffer, r.embedding.byteOffset, D), i * D);
  let s = 0;
  for (let j = 0; j < D; j++) s += vecs[i * D + j] ** 2;
  norms[i] = Math.sqrt(s);
});
console.log(`${rows.length} vectors, ${D}d`);

function exact(seedIdx) {
  const scores = new Float32Array(ids.length);
  const o = seedIdx * D;
  for (let i = 0; i < ids.length; i++) {
    let dot = 0;
    for (let j = 0, p = i * D; j < D; j++, p++) dot += vecs[p] * vecs[o + j];
    scores[i] = dot / (norms[i] * norms[seedIdx]);
  }
  return [...scores.keys()].filter(i => i !== seedIdx)
    .sort((a, b) => scores[b] - scores[a]).slice(0, K).map(i => ids[i]);
}

let rng = 7;
const rand = () => (rng = (rng * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const lat = [];
let overlap = 0, exactTop1 = 0;
for (let s = 0; s < N_SEEDS; s++) {
  const idx = Math.floor(rand() * ids.length);
  t0 = performance.now();
  const got = g.similarDescriptions(ids[idx], K).map(h => h.artId);
  lat.push(performance.now() - t0);
  const want = exact(idx);
  const inter = got.filter(a => want.includes(a)).length;
  overlap += inter;
  if (got[0] === want[0]) exactTop1++;
  if (got.includes(ids[idx])) { console.error("seed returned as its own neighbour", ids[idx]); process.exit(1); }
  if (inter < K) console.log(`seed ${ids[idx]}: ${inter}/${K}`);
}
lat.sort((a, b) => a - b);
console.log(`recall@${K} ${(overlap / (N_SEEDS * K)).toFixed(3)}, top-1 match ${exactTop1}/${N_SEEDS}`);
console.log(`latency ms: p50 ${lat[lat.length >> 1].toFixed(0)}, max ${lat.at(-1).toFixed(0)}`);
