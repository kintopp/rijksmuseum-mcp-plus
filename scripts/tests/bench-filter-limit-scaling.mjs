// Issue #74 follow-up: where does raising FILTER_ART_IDS_LIMIT stop paying off?
// Times the chunked vec_distance_cosine path at increasing candidate counts and
// compares to the flat-cost pure-KNN + post-filter fallback (the >limit path).
//
// Run: node scripts/tests/bench-filter-limit-scaling.mjs
import Database from "better-sqlite3";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const sqliteVec = require("sqlite-vec");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const emb = new Database(path.join(root, "data/embeddings.db"), { readonly: true });
emb.pragma("mmap_size = 1073741824");
sqliteVec.load(emb);

const now = () => process.hrtime.bigint();
const hrms = (t0) => Number(now() - t0) / 1e6;

// query vector = a real artwork's int8 embedding
const qInt8 = emb.prepare("SELECT embedding FROM artwork_embeddings ORDER BY art_id LIMIT 1 OFFSET 12345").get().embedding;

// pull a pool of real art_ids to use as synthetic candidate sets
const pool = emb.prepare("SELECT art_id FROM artwork_embeddings ORDER BY art_id").all().map(r => r.art_id);

function chunkedFiltered(candidateArtIds, k) {
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

const knnStmt = emb.prepare(`SELECT artwork_id, distance FROM vec_artworks WHERE embedding MATCH vec_int8(?) AND k = ? ORDER BY distance`);
function fallback(candidateSet, k) {
  const rows = knnStmt.all(qInt8, 4096);
  const out = [];
  for (const r of rows) { if (candidateSet.has(r.artwork_id)) out.push(r); if (out.length >= k) break; }
  return out;
}

function timeIt(label, fn, runs = 3) {
  fn();
  const ts = [];
  for (let i = 0; i < runs; i++) { const t0 = now(); fn(); ts.push(hrms(t0)); }
  ts.sort((a, b) => a - b);
  const med = ts[Math.floor(runs / 2)];
  console.log(`  ${label.padEnd(40)} median ${med.toFixed(0).padStart(5)}ms`);
  return med;
}

console.log("=== Chunked path latency vs candidate count ===");
console.log(`Pool: ${pool.length.toLocaleString()} vectors\n`);
const sizes = [50_000, 100_000, 200_000, 300_000, 400_000, 600_000, 800_000];
console.log("Current FILTER_ART_IDS_LIMIT = 200,000 (≥ this → fallback)\n");
for (const n of sizes) {
  if (n > pool.length) continue;
  const cand = pool.slice(0, n);
  const med = timeIt(`chunked @ ${n.toLocaleString()} cand`, () => chunkedFiltered(cand, 15));
  console.log(`        → ${(med / (n / 1000)).toFixed(2)} ms per 1K candidates`);
}

console.log("\n=== Fallback (pure-KNN + post-filter) — flat cost regardless of count ===");
const set = new Set(pool.slice(0, 400_000));
timeIt("fallback (any count)", () => fallback(set, 15));

console.log("\nNote: fallback is APPROXIMATE (post-filters top-4096 KNN; may return <k for");
console.log("rare filters). Chunked is EXACT. Crossover ≈ where chunked median meets fallback.");
