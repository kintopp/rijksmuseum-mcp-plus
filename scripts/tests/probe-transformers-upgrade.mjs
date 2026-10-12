// Scratch probe: query vectors, latency and RSS from EmbeddingModel under the installed
// @huggingface/transformers, so two library versions can be diffed.
//   node scripts/tests/probe-transformers-upgrade.mjs <modelId> <out.json> [targetDim]
//   node scripts/tests/probe-transformers-upgrade.mjs --diff a.json b.json
import { readFileSync, writeFileSync } from "node:fs";

const QUERIES = [
  "portrait of a man wearing a ruff collar", "loneliness and isolation in a vast empty space",
  "schip in storm op zee", "beleg van een stad tijdens de Tachtigjarige Oorlog", "Blumenstrauß in einer Vase",
  "nature morte avec des fruits", "江戸時代の浮世絵", "портрет женщины", "vanitas", "Rembrandt",
  "children playing games on the ice", "Chinese porcelain made for the European market",
];

if (process.argv[2] === "--diff") {
  const [a, b] = [3, 4].map((i) => JSON.parse(readFileSync(process.argv[i])));
  let min = 1;
  for (let i = 0; i < a.vecs.length; i++) {
    let d = 0;
    for (let k = 0; k < a.vecs[i].length; k++) d += a.vecs[i][k] * b.vecs[i][k];
    min = Math.min(min, d);
  }
  console.log(`min cosine ${min.toFixed(6)} over ${a.vecs.length} queries`);
  for (const r of [a, b]) console.log(`  ${r.version}: dims ${r.vecs[0].length} load ${r.loadMs} ms, median ${r.medianMs} ms, RSS +${r.rssMb} MB`);
  process.exit(min > 0.9999 ? 0 : 1);
}

const { EmbeddingModel } = await import("../../dist/api/EmbeddingModel.js");
const { version } = JSON.parse(readFileSync(new URL("../../node_modules/@huggingface/transformers/package.json", import.meta.url)));
const [modelId, out, dim] = process.argv.slice(2);
const rss = () => process.memoryUsage().rss / 1e6;
const r0 = rss();
let t = performance.now();
const m = new EmbeddingModel();
await m.init(modelId, Number(dim ?? 0));
if (!m.available) { console.error("model failed to load"); process.exit(1); }
const loadMs = Math.round(performance.now() - t);
const vecs = [], lat = [];
for (const q of QUERIES) {
  t = performance.now();
  vecs.push(Array.from(await m.embed(q)));
  lat.push(performance.now() - t);
}
lat.sort((x, y) => x - y);
const res = { version, modelId, loadMs, medianMs: Math.round(lat[lat.length >> 1]), rssMb: Math.round(rss() - r0), vecs };
writeFileSync(out, JSON.stringify(res));
console.log(`${version} ${modelId}: dims ${vecs[0].length}, load ${loadMs} ms, median ${res.medianMs} ms, RSS +${res.rssMb} MB`);
