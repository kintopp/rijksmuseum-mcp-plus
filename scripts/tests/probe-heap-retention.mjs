// Probe: is heap growth under a mixed tool workload live retention (leak) or uncollected garbage?
// Spawns a local HTTP server with --inspect, runs rounds of varied tool calls, and after each
// round samples heapUsed before and after a forced full GC (CDP HeapProfiler.collectGarbage).
// Retained heap that keeps climbing round over round = leak; a plateau = lazy GC only.
// Usage: node scripts/tests/probe-heap-retention.mjs [--rounds N] [--gemma data/gemma-v3.db]
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const ROUNDS = Number(arg("--rounds", 8));
const PORT = 3124, INSPECT = 9339, BASE = `http://localhost:${PORT}`;

const server = spawn(process.execPath, [`--inspect=127.0.0.1:${INSPECT}`, "dist/index.js"], {
  env: { ...process.env, PORT: String(PORT), GEMMA_DB_PATH: arg("--gemma", "data/gemma-v3.db") },
  stdio: ["ignore", "ignore", "ignore"],
});
process.on("exit", () => server.kill());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; ; i++) {
  try { if ((await fetch(`${BASE}/ready`).then((r) => r.json())).ready) break; } catch {}
  if (i > 120) throw new Error("server not ready");
  await sleep(1000);
}

const [{ webSocketDebuggerUrl }] = await fetch(`http://127.0.0.1:${INSPECT}/json/list`).then((r) => r.json());
const ws = new WebSocket(webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let msgId = 0;
const cdp = (method) => new Promise((resolve) => {
  const id = ++msgId;
  const on = (ev) => { const m = JSON.parse(ev.data); if (m.id === id) { ws.removeEventListener("message", on); resolve(m); } };
  ws.addEventListener("message", on);
  ws.send(JSON.stringify({ id, method }));
});

const heapMB = async () => {
  const m = await fetch(`${BASE}/debug/memory`).then((r) => r.json());
  return { heap: Math.round(m.process.heapUsedBytes / 1e6), rss: Math.round(m.process.rssBytes / 1e6), ab: Math.round(m.process.arrayBuffersBytes / 1e6) };
};

const WORDS = ["ship", "dog", "church", "portrait", "flower", "windmill", "river", "skull", "horse", "kitchen",
  "battle", "winter", "market", "music", "child", "tree", "moon", "fish", "bird", "letter"];
const OBJECTS = ["SK-C-5", "SK-A-2344", "SK-C-251", "SK-A-1718", "SK-A-3262", "SK-C-216", "SK-A-4050", "SK-A-180"];

function batch(round) {
  const calls = [];
  for (let i = 0; i < 6; i++) {
    const w = WORDS[(round * 6 + i) % WORDS.length], w2 = WORDS[(round * 7 + i * 3 + 1) % WORDS.length];
    const o = OBJECTS[(round + i) % OBJECTS.length];
    calls.push(
      ["search_artwork", { query: w }],
      ["search_artwork", { subject: [w2], creator: ["Rembrandt van Rijn"] }],
      ["collection_stats", { dimension: ["type", "century", "creator", "material", "technique", "theme"][i], subject: w }],
      ["list_curated_sets", {}],
      ["semantic_search", { query: `${w} and ${w2} round ${round}`, maxResults: 10 }],
      ["multimodal_search", { query: `${w2} near a ${w} ${round}`, maxResults: 10 }],
      ["get_artwork_details", { objectNumber: o }],
      ["search_persons", { name: w }],
    );
    if (i < 2) calls.push(["find_similar", { objectNumber: o }]);
  }
  return calls;
}

const client = new Client({ name: "probe-heap-retention", version: "0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)));

await cdp("HeapProfiler.collectGarbage");
console.log("baseline (post-GC)", await heapMB());
const errors = new Set();
for (let r = 1; r <= ROUNDS; r++) {
  for (const [name, args] of batch(r)) {
    try {
      const res = await client.callTool({ name, arguments: args });
      if (res.isError) errors.add(`${name}: ${res.content?.[0]?.text?.slice(0, 120)}`);
    } catch (e) { errors.add(`${name}: ${e.message.slice(0, 120)}`); }
  }
  const before = await heapMB();
  await cdp("HeapProfiler.collectGarbage");
  const after = await heapMB();
  console.log(`round ${r}: heap ${before.heap} → ${after.heap} MB after GC  (rss ${after.rss}, arrayBuffers ${after.ab})`);
}
if (errors.size) console.log("tool errors:", [...errors]);
await client.close();
ws.close();
server.kill();
process.exit(0);
