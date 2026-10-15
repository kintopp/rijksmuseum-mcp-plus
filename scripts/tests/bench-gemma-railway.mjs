// In-container bench of one GemmaDb build: per-channel search latency and the process's
// anonymous vs file-backed RSS (Linux /proc — macOS RSS hides SQLite file pages).
// Runs on Railway via `railway ssh` from /app/scripts/ (see CLAUDE.md base64 pattern):
//   node scripts/_bench-gemma-railway.mjs <GemmaDb.js module> <gemma.db path>
// The query model is the deployed dist/api/GemmaModel.js (HF cache on /data).
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const [modPath, dbPath] = process.argv.slice(2);
process.env.GEMMA_DB_PATH = dbPath;
const { GemmaDb } = await import(pathToFileURL(modPath).href);
const { GemmaModel } = await import(pathToFileURL(`${process.env.BENCH_DIST ?? "/app/dist"}/api/GemmaModel.js`).href);

const QUERIES = [
  "children playing outside on the street", "a skull next to an hourglass", "red umbrella",
  "ships in a storm at sea", "a woman reading a letter by a window", "windmill beside a river at dusk",
  "a cat sleeping by the fire", "skaters on a frozen canal", "horseman in the snow", "flowers in a glass vase",
  "a man playing the violin", "fishing boats on a beach",
];
const mem = () => {
  if (process.platform !== "linux") return { rss: Math.round(process.memoryUsage().rss / 2 ** 20), anon: NaN, file: NaN };
  const s = readFileSync("/proc/self/status", "utf8");
  const kb = (k) => Number(s.match(new RegExp(`^${k}:\\s+(\\d+)`, "m"))?.[1] ?? 0);
  return { rss: Math.round(kb("VmRSS") / 1024), anon: Math.round(kb("RssAnon") / 1024), file: Math.round(kb("RssFile") / 1024) };
};
const fmt = (m) => `RSS ${m.rss} MB (anon ${m.anon}, file ${m.file})`;
const p = (a, q) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * q))].toFixed(0);

const model = new GemmaModel();
await model.init();
const vecs = [];
for (const q of QUERIES) vecs.push(await model.embed(q));
console.log(`model + query vectors: ${fmt(mem())}`);

const db = new GemmaDb();
const t0 = Date.now();
await db.loadCoarse?.(() => new Promise((r) => setImmediate(r)));
console.log(`opened ${dbPath} (coarse load ${Date.now() - t0} ms): ${fmt(mem())}`);

// mulberry32: 32-bit integer math via Math.imul (a float LCG overflows 2^53 and cycles early).
const rng = (() => { let a = 7; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32; }; })();
const allIds = db.rawDb.prepare("SELECT art_id FROM artwork_object_numbers").pluck().all();
const subset = (n) => { const out = new Set(); while (out.size < n) out.add(allIds[Math.floor(rng() * allIds.length)]); return [...out]; };
const cands = { "small(5K)": subset(5000), "broad(400K)": subset(400000) };

for (const pass of ["cold", "warm"]) {
  for (const t of ["metadata", "images"]) {
    const ms = [];
    for (const v of vecs) { const s = performance.now(); db.search(t, db.quantize(v), 250); ms.push(performance.now() - s); }
    console.log(`${pass} ${t.padEnd(8)} unfiltered p50 ${p(ms, 0.5)} ms p95 ${p(ms, 0.95)} ms  ${fmt(mem())}`);
  }
}
for (const [name, c] of Object.entries(cands)) {
  const ms = [];
  for (const v of vecs) { const s = performance.now(); db.search("metadata", db.quantize(v), 250, c); ms.push(performance.now() - s); }
  console.log(`warm metadata ${name.padEnd(11)} p50 ${p(ms, 0.5)} ms p95 ${p(ms, 0.95)} ms  ${fmt(mem())}`);
}
