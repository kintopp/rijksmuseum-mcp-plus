// Scratch probe for the Railway container: EmbeddingGemma 2 text-only query latency on its CPU.
// Caches the model under /tmp (not the /data volume) so nothing persists; delete /tmp/gemma-probe after.
// Last stdout line is JSON with the q8 default-thread vectors, for parity against
// data/egemma2-test/corpus/compare-text/queries-ref.json.
import os from "node:os";
import { readFileSync } from "node:fs";

const MODEL = "onnx-community/embeddinggemma-2-ONNX";
const PREFIX = "task: search result | query: ";
const QUERIES = ["cultural exchange between East and West", "contact between European and Asian cultures", "loneliness and isolation in a vast empty space", "Blumenstrauß in einer Vase", "vanitas symbolism and mortality", "winter landscape with ice skating", "glorification of stadholder William III", "an officer courting a young woman in an interior", "Japanese woodblock print of a courtesan", "Chinese porcelain made for the European market", "artworks looted during the Second World War and returned afterwards", "schip in storm op zee", "spotprent op de politiek", "beleg van een stad tijdens de Tachtigjarige Oorlog", "portrait of a man wearing a ruff collar", "slavery in the Dutch colonies", "Noah's ark and the animals", "children playing games", "triumphal entry of a prince into a city", "anatomy lesson with the dissection of a corpse"];
const LONG = "a crowded harbour scene at dusk with merchant ships unloading cargo, porters carrying barrels along the quay, " +
  "a church tower in the background and fishermen mending nets in the foreground, painted in muted browns and greys";

const read = (p) => { try { return readFileSync(p, "utf8").trim(); } catch { return "n/a"; } };
console.log(`cpus ${os.cpus().length} × ${os.cpus()[0]?.model}; cgroup cpu.max ${read("/sys/fs/cgroup/cpu.max")}; ` +
  `avx512_vnni ${/avx512_vnni|avx_vnni/.test(read("/proc/cpuinfo")) ? "yes" : "no"}`);

const tf = await import("@huggingface/transformers");
tf.env.cacheDir = "/tmp/gemma-probe";
tf.env.useFSCache = true;
const config = await tf.AutoConfig.from_pretrained(MODEL);
config.vision_config = config.audio_config = null;
const tok = await tf.AutoTokenizer.from_pretrained(MODEL);

const rss = () => Math.round(process.memoryUsage().rss / 1e6);
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))]); };
let out = null;
for (const dtype of ["q8", "fp32"]) {
  for (const threads of [0, 1, 2]) {
    const r0 = rss();
    let t = performance.now();
    const session_options = threads > 0 ? { intraOpNumThreads: threads, interOpNumThreads: 1 } : undefined;
    const model = await tf.AutoModel.from_pretrained(MODEL, { config, dtype, device: "cpu", session_options });
    const loadMs = Math.round(performance.now() - t);
    const encode = async (s) => (await model(await tok([PREFIX + s]))).sentence_embedding.normalize(2, -1).data;
    await encode("warm-up");
    const lat = [], vecs = [];
    for (const q of QUERIES) { t = performance.now(); vecs.push(Array.from(await encode(q), (x) => +x.toFixed(6))); lat.push(performance.now() - t); }
    const longLat = [];
    for (let i = 0; i < 5; i++) { t = performance.now(); await encode(LONG); longLat.push(performance.now() - t); }
    console.log(`${dtype} t=${threads || "default"}: load ${loadMs} ms, RSS ${r0}→${rss()} MB, median ${pct(lat, 0.5)} ms, ` +
      `p95 ${pct(lat, 0.95)} ms, long ${pct(longLat, 0.5)} ms`);
    if (dtype === "q8" && threads === 0) out = vecs;
    await model.dispose();
  }
}
console.log(JSON.stringify({ vecs: out }));
