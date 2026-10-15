/**
 * GemmaDb two-stage search (in-memory MRL-prefix scan + exact rescore) against a brute-force
 * cosine computed here, on a seeded synthetic gemma.db in both layouts. Needs ./dist only.
 *
 * Failure modes checked:
 *   - coarse chunks stitched at wrong offsets (multi-chunk, partial last chunk) → wrong rows scored
 *   - rescore reads blob bytes as uint8 instead of int8 → ranking diverges from exact cosine
 *   - similarity not a true cosine (query norm or row norm dropped)
 *   - filtered search returns non-candidates, misses candidates, or chokes on unknown ids
 *     (both the small exact-rescore path and the large coarse-restricted path)
 *   - a search before the async warm-up finishes doesn't see a complete index, or a later
 *     loadCoarse() reloads / breaks it
 *   - legacy (vec0) layout no longer searchable after the layout switch
 *
 * Tests GemmaDb directly, not tools/call: multimodal_search also needs the query model,
 * which can't run offline. Equivalent mutation: none known.
 */
import Database from "better-sqlite3";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, "fixtures", ".generated");
const D = 768, COARSE = 384, CHUNK = 4096, SCALE = 313;
let failed = 0;
const check = (ok, msg) => { console.log(`  ${ok ? "✓" : "✗"} ${msg}`); if (!ok) failed++; };

// mulberry32 + Box–Muller: deterministic Gaussian vectors.
let seed = 20261015;
const rand = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32; };
const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
// Tail dims damped like an MRL embedding (information front-loaded): with isotropic noise the
// 384d prefix carries half the signal and no coarse depth would reliably hold the exact top-250.
const unit = () => { const v = Float64Array.from({ length: D }, (_, j) => gauss() * (j < COARSE ? 1 : 0.25)); const n = Math.hypot(...v); return v.map((x) => x / n); };
const toInt8 = (v) => Int8Array.from(v, (x) => Math.max(-127, Math.min(127, Math.round(x * SCALE))));

const N_META = 30_000, N_IMG = 24_000;
const metaIds = Array.from({ length: N_META }, (_, i) => 3 * i + 7); // sparse, non-contiguous ids
const imgIds = metaIds.filter((_, i) => i % 5 !== 0).slice(0, N_IMG);
const vecs = { metadata: new Map(metaIds.map((id) => [id, toInt8(unit())])), images: new Map(imgIds.map((id) => [id, toInt8(unit())])) };

function build(file, layout) {
  const p = path.join(OUT_DIR, file);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const f of [p, `${p}-wal`, `${p}-shm`]) fs.rmSync(f, { force: true });
  const db = new Database(p);
  require("sqlite-vec").load(db);
  db.exec("CREATE TABLE version_info (key TEXT PRIMARY KEY, value TEXT)");
  db.exec("CREATE TABLE iconclass_notations (id INTEGER PRIMARY KEY, notation TEXT UNIQUE NOT NULL, label TEXT)");
  db.exec(`CREATE VIRTUAL TABLE vec_gemma_iconclass USING vec0(notation_id INTEGER PRIMARY KEY, embedding int8[${D}] distance_metric=cosine)`);
  db.prepare("INSERT INTO iconclass_notations VALUES (0, '25F', 'animals')").run();
  db.prepare("INSERT INTO vec_gemma_iconclass (notation_id, embedding) VALUES (0, vec_int8(?))").run(Buffer.from(toInt8(unit()).buffer));
  const vi = { dimensions: D, int8_scale: SCALE, built_at: layout, metadata_count: N_META, image_count: N_IMG, iconclass_count: 1 };
  db.transaction(() => {
    for (const ch of ["metadata", "images"]) {
      const entries = [...vecs[ch]].reverse(); // insert out of id order; the layout contract sorts chunks
      if (layout === "two-stage") {
        db.exec(`CREATE TABLE gemma_${ch}_vectors (artwork_id INTEGER PRIMARY KEY, embedding BLOB NOT NULL)`);
        const ins = db.prepare(`INSERT INTO gemma_${ch}_vectors VALUES (?, ?)`);
        for (const [id, v] of entries) ins.run(id, Buffer.from(v.buffer));
      } else {
        db.exec(`CREATE VIRTUAL TABLE vec_gemma_${ch} USING vec0(artwork_id INTEGER PRIMARY KEY, embedding int8[${D}] distance_metric=cosine)`);
        const ins = db.prepare(`INSERT INTO vec_gemma_${ch} (artwork_id, embedding) VALUES (?, vec_int8(?))`);
        for (const [id, v] of entries) ins.run(BigInt(id), Buffer.from(v.buffer));
      }
    }
    if (layout === "two-stage") {
      vi.coarse_dims = COARSE;
      db.exec("CREATE TABLE gemma_coarse_chunks (channel TEXT NOT NULL, chunk_no INTEGER NOT NULL, n INTEGER NOT NULL, artwork_ids BLOB NOT NULL, prefixes BLOB NOT NULL, inv_norms BLOB NOT NULL, PRIMARY KEY (channel, chunk_no))");
      const ins = db.prepare("INSERT INTO gemma_coarse_chunks VALUES (?, ?, ?, ?, ?, ?)");
      for (const ch of ["metadata", "images"]) {
        const ids = [...vecs[ch].keys()].sort((a, b) => a - b);
        for (let c = 0, i = 0; i < ids.length; c++, i += CHUNK) {
          const part = ids.slice(i, i + CHUNK);
          const pre = new Int8Array(part.length * COARSE), inv = new Float32Array(part.length);
          part.forEach((id, r) => {
            const v = vecs[ch].get(id).subarray(0, COARSE);
            pre.set(v, r * COARSE);
            inv[r] = 1 / Math.hypot(...v);
          });
          ins.run(ch, c, part.length, Buffer.from(Int32Array.from(part).buffer), Buffer.from(pre.buffer), Buffer.from(inv.buffer));
        }
      }
    }
    const vins = db.prepare("INSERT INTO version_info VALUES (?, ?)");
    for (const [k, v] of Object.entries(vi)) vins.run(k, String(v));
  })();
  db.close();
  return p;
}

/** Brute-force exact cosine ranking over the int8 vectors, optionally restricted. */
function exact(ch, q, k, candidates) {
  const qn = Math.hypot(...q);
  const pool = candidates ? candidates.filter((id) => vecs[ch].has(id)) : [...vecs[ch].keys()];
  return pool.map((id) => {
    const v = vecs[ch].get(id);
    let dot = 0; for (let j = 0; j < D; j++) dot += v[j] * q[j];
    return { artId: id, similarity: dot / (Math.hypot(...v) * qn) };
  }).sort((a, b) => b.similarity - a.similarity).slice(0, k);
}
const sameIds = (a, b) => a.length === b.length && a.every((x, i) => x.artId === b[i].artId);
const maxSimErr = (a, b) => Math.max(...a.map((x, i) => Math.abs(x.similarity - b[i].similarity)));

const { GemmaDb } = await import("../../dist/api/GemmaDb.js");
const open = (p) => { process.env.GEMMA_DB_PATH = p; return new GemmaDb(); };
const queries = Array.from({ length: 4 }, unit);

console.log("1. Two-stage layout, unfiltered (search before warm-up: sync index load)");
const two = open(build("gemma-two-stage.db", "two-stage"));
check(two.available, "two-stage fixture opens");
for (const [qi, qf] of queries.entries()) {
  const q = two.quantize(Float32Array.from(qf));
  const qi8 = new Int8Array(q.buffer, q.byteOffset, q.length);
  for (const ch of ["metadata", "images"]) {
    const got = two.search(ch, q, 250), want = exact(ch, qi8, 250);
    check(sameIds(got, want), `q${qi} ${ch}: top-250 identical to brute-force cosine`);
    check(maxSimErr(got, want) < 1e-6, `q${qi} ${ch}: similarity is the exact cosine`);
  }
}
await two.loadCoarse(() => new Promise((r) => setImmediate(r)));
const q0 = two.quantize(Float32Array.from(queries[0]));
const q0i8 = new Int8Array(q0.buffer, q0.byteOffset, q0.length);
check(sameIds(two.search("metadata", q0, 50), exact("metadata", q0i8, 50)), "loadCoarse() after a sync load leaves the index intact");

console.log("\n2. Two-stage layout, filtered");
const unknown = [1, 2, 5_000_000];
const small = [...metaIds.filter((_, i) => i % 61 === 0), ...unknown];
const gotSmall = two.search("metadata", q0, 50, small);
check(sameIds(gotSmall, exact("metadata", q0i8, 50, small)), `small set (${small.length} ids, exact-rescore path) matches brute force`);
check(gotSmall.every((h) => small.includes(h.artId)), "small set: only candidates returned");
const broad = metaIds.filter((_, i) => i % 4 !== 0).concat(unknown).reverse(); // 22.5K > exact-rescore cutoff, unsorted
const broadSet = new Set(broad);
const gotBroad = two.search("metadata", q0, 50, broad);
check(sameIds(gotBroad, exact("metadata", q0i8, 50, broad)), `broad set (${broad.length} ids, coarse-restricted path) matches brute force`);
check(gotBroad.every((h) => broadSet.has(h.artId)), "broad set: only candidates returned");
check(two.search("images", q0, 10, [metaIds[0]]).length === 0, "candidate without an image vector yields no image hit");

console.log("\n3. Legacy vec0 layout");
const legacy = open(build("gemma-legacy.db", "legacy"));
check(legacy.available, "legacy fixture opens");
const gotLegacy = legacy.search("metadata", legacy.quantize(Float32Array.from(queries[1])), 50);
const q1 = legacy.quantize(Float32Array.from(queries[1]));
check(sameIds(gotLegacy, exact("metadata", new Int8Array(q1.buffer, q1.byteOffset, q1.length), 50)), "legacy top-50 matches brute force");

console.log(failed ? `\n${failed} check(s) failed` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
