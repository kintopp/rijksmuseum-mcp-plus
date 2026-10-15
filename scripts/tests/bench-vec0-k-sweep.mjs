// Bench: vec0 int8 KNN latency vs k and dimensionality (is the coarse scan's cost
// in bytes read or in top-k bookkeeping?). Uses the gemma two-stage prototype tables.
// Usage: node scripts/tests/bench-vec0-k-sweep.mjs
import Database from "better-sqlite3";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const SCALE = 313;
const qs = JSON.parse(readFileSync("data/egemma2-test/binary/queries.json", "utf8")).slice(0, 12)
  .map((r) => Int8Array.from(r.vec, (x) => Math.max(-127, Math.min(127, Math.round(x * SCALE)))));

const open = (p) => { const db = new Database(p, { readonly: true }); db.pragma("mmap_size = 4294967296"); require("sqlite-vec").load(db); return db; };
const full = open("data/gemma.db"), proto = open("data/egemma2-test/binary/proto.db");

const run = (db, table, d, k) => {
  const st = db.prepare(`SELECT artwork_id FROM ${table} WHERE embedding MATCH vec_int8(?) AND k = ?`).pluck();
  for (const q of qs.slice(0, 2)) st.all(Buffer.from(q.buffer, 0, d), k); // warm
  const t = qs.map((q) => { const t0 = performance.now(); st.all(Buffer.from(q.buffer, 0, d), k); return performance.now() - t0; }).sort((a, b) => a - b);
  console.log(`${table.padEnd(26)} d=${String(d).padEnd(3)} k=${String(k).padEnd(5)} p50 ${t[t.length >> 1].toFixed(0)} ms`);
};

for (const k of [10, 250, 2000]) run(full, "vec_gemma_metadata", 768, k);
for (const d of [384, 256]) for (const k of [10, 250, 2000]) run(proto, `vec_metadata_c${d}`, d, k);
for (const cs of [2048, 4096]) for (const k of [10, 250, 2000]) {
  try { run(proto, `vec_metadata_c384_cs${cs}`, 384, k); } catch (e) { console.log(`cs${cs}: ${e.message}`); }
}
