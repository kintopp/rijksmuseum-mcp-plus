// Bench: exact 768d vec0 KNN (current gemma.db) vs two-stage (MRL-truncated int8 coarse
// scan + exact 768d rescore from a plain rowid table) on the prototype DB.
// One config per process so RSS reflects that config's touched pages only.
// Usage:
//   node scripts/tests/bench-gemma-twostage.mjs exact
//   node scripts/tests/bench-gemma-twostage.mjs two <coarseDims> <candidates>
import Database from "better-sqlite3";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const [mode, dimsArg, cArg] = process.argv.slice(2);
const SCALE = 313, DEPTH = 250, MMAP = 1073741824;
const CHANNELS = ["metadata", "images"];

const queries = JSON.parse(readFileSync("data/egemma2-test/binary/queries.json", "utf8"));
const quantize = (v) => Int8Array.from(v, (x) => Math.max(-127, Math.min(127, Math.round(x * SCALE))));

const open = (path) => {
  const db = new Database(path, { readonly: true });
  db.pragma(`mmap_size = ${MMAP}`);
  require("sqlite-vec").load(db);
  return db;
};

let search;
if (mode === "exact") {
  const db = open("data/gemma.db");
  const st = Object.fromEntries(CHANNELS.map((ch) => [ch, db.prepare(
    `SELECT artwork_id FROM vec_gemma_${ch} WHERE embedding MATCH vec_int8(?) AND k = ? ORDER BY distance`)]));
  search = (ch, q) => st[ch].all(Buffer.from(q.buffer), DEPTH).map((r) => r.artwork_id);
} else {
  const D = Number(dimsArg), C = Number(cArg);
  const db = open("data/egemma2-test/binary/proto.db");
  const coarse = Object.fromEntries(CHANNELS.map((ch) => [ch, db.prepare(
    `SELECT artwork_id FROM vec_${ch}_c${D} WHERE embedding MATCH vec_int8(?) AND k = ?`).pluck()]));
  const fetch = Object.fromEntries(CHANNELS.map((ch) => [ch, db.prepare(
    `SELECT artwork_id, embedding FROM ${ch}_vectors WHERE artwork_id IN (SELECT value FROM json_each(?))`)]));
  search = (ch, q) => {
    const ids = coarse[ch].all(Buffer.from(q.buffer, 0, D), C);
    const scored = fetch[ch].all(JSON.stringify(ids)).map((r) => {
      const v = new Int8Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.length);
      let dot = 0, nn = 0;
      for (let i = 0; i < v.length; i++) { dot += v[i] * q[i]; nn += v[i] * v[i]; }
      return [r.artwork_id, dot / Math.sqrt(nn)];
    });
    return scored.sort((a, b) => b[1] - a[1]).slice(0, DEPTH).map((x) => x[0]);
  };
}

const qs = queries.map((r) => quantize(r.vec));
const rss0 = process.memoryUsage().rss;
const results = {};
const times = [];
for (let pass = 0; pass < 2; pass++) {
  for (let i = 0; i < qs.length; i++) {
    for (const ch of CHANNELS) {
      const t0 = performance.now();
      const ids = search(ch, qs[i]);
      if (pass === 1) { times.push(performance.now() - t0); results[`${ch}:${i}`] = ids; }
    }
  }
}
times.sort((a, b) => a - b);
const label = mode === "exact" ? "exact-768" : `two-stage D=${dimsArg} C=${cArg}`;
console.error(`${label.padEnd(24)} per-channel p50 ${times[times.length >> 1].toFixed(0)} ms  p95 ${times[Math.floor(times.length * 0.95)].toFixed(0)} ms  RSS +${((process.memoryUsage().rss - rss0) / 1e6).toFixed(0)} MB`);
process.stdout.write(JSON.stringify(results));
