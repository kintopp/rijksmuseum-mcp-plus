// Scratch probe: EmbeddingGemma 2 text-query encoding under transformers.js on CPU —
// load time, RSS, per-query latency, and vectors for parity against the Python reference.
//   node scripts/tests/probe-gemma-runtime.mjs <dtype> <threads|0> <out.json> [--pipeline]
// threads=0 leaves onnxruntime's default; --pipeline uses feature-extraction (loads every encoder).
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const MODEL = "onnx-community/embeddinggemma-2-ONNX";
const PREFIX = "task: search result | query: ";
const [dtype, threadsArg, out] = process.argv.slice(2);
const usePipeline = process.argv.includes("--pipeline");
const threads = Number(threadsArg);

// Reference queries come from the Python encode_query run (compare-text/queries.npz), exported to JSON.
const ref = JSON.parse(readFileSync(new URL("../../data/egemma2-test/corpus/compare-text/queries-ref.json", import.meta.url)));
const LONG = "a crowded harbour scene at dusk with merchant ships unloading cargo, porters carrying barrels along the quay, " +
  "a church tower in the background and fishermen mending nets in the foreground, painted in muted browns and greys";

const rss = () => process.memoryUsage().rss / 1e6;
const r0 = rss();
const tf = await import("@huggingface/transformers");
// --with-e5: load the production e5 model first, to size the RSS of running both side by side.
if (process.argv.includes("--with-e5")) {
  const e5 = await tf.pipeline("feature-extraction", "kintopp/multilingual-e5-small-rijksmuseum", { dtype: "q8" });
  await e5("query: warm-up", { pooling: "mean", normalize: true });
  console.log(`e5 loaded: RSS +${Math.round(rss() - r0)} MB`);
}
const session_options =threads > 0 ? { intraOpNumThreads: threads, interOpNumThreads: 1 } : undefined;

let t = performance.now();
let encode;
if (usePipeline) {
  const pipe = await tf.pipeline("feature-extraction", MODEL, { dtype, device: "cpu", session_options });
  encode = async (s) => (await pipe(PREFIX + s, { pooling: "mean", normalize: true })).data;
} else {
  const config = await tf.AutoConfig.from_pretrained(MODEL);
  config.vision_config = config.audio_config = null;
  const model = await tf.AutoModel.from_pretrained(MODEL, { config, dtype, device: "cpu", session_options });
  const tok = await tf.AutoTokenizer.from_pretrained(MODEL);
  encode = async (s) => (await model(await tok([PREFIX + s]))).sentence_embedding.normalize(2, -1).data;
}
const loadMs = Math.round(performance.now() - t);
const rssLoaded = rss();

const vecs = [], lat = [];
await encode("warm-up");
for (const q of ref.queries) {
  t = performance.now();
  vecs.push(Array.from(await encode(q)));
  lat.push(performance.now() - t);
}
const longLat = [];
for (let i = 0; i < 5; i++) { t = performance.now(); await encode(LONG); longLat.push(performance.now() - t); }

const med = (a) => { const s = [...a].sort((x, y) => x - y); return Math.round(s[s.length >> 1]); };
const p95 = (a) => { const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.floor(s.length * 0.95)]); };
// The bf16 reference vectors have norms up to ~1.0035, so normalise both sides.
const norm = (v) => Math.sqrt(v.reduce((a, x) => a + x * x, 0));
const cos = vecs.map((v, i) => v.reduce((acc, x, k) => acc + x * ref.vecs[i][k], 0) / (norm(v) * norm(ref.vecs[i])));
// Peak RSS of this process (macOS ru_maxrss is bytes).
const peakMb = Math.round(Number(execFileSync("ps", ["-o", "rss=", "-p", String(process.pid)]).toString().trim()) / 1e3);

const res = {
  dtype, threads, route: usePipeline ? "pipeline" : "text-only", loadMs,
  rssLoadedMb: Math.round(rssLoaded - r0), rssAfterMb: peakMb,
  medianMs: med(lat), p95Ms: p95(lat), longMedianMs: med(longLat),
  minCos: Math.min(...cos), meanCos: cos.reduce((a, b) => a + b, 0) / cos.length, vecs,
};
writeFileSync(out, JSON.stringify(res));
console.log(`${res.route} ${dtype} t=${threads || "default"}: load ${loadMs} ms, RSS +${res.rssLoadedMb} MB (now ${peakMb}), ` +
  `median ${res.medianMs} ms, p95 ${res.p95Ms} ms, long ${res.longMedianMs} ms, cos min ${res.minCos.toFixed(5)} mean ${res.meanCos.toFixed(5)}`);
