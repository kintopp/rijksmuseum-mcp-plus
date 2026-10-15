// Probe: multimodal_search latency + process memory on a live HTTP server.
// Snapshots /debug/memory (RSS, smaps per DB) before and after each phase of timed calls.
// Usage: node scripts/tests/probe-gemma-prod-memory.mjs [--server <base-url>] [--out <file.json>]
// Modest call count (~60) — a probe, not a load test.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const BASE = arg("--server", "https://rijksmuseum-mcp-plus-production.up.railway.app").replace(/\/$/, "");
const OUT = arg("--out", null);

const QUERIES = [
  "a woman pouring milk in a kitchen", "windmill beside a river at dusk", "a skull next to an hourglass",
  "fishing boats on a beach", "a man playing the violin", "flowers in a glass vase",
];

const mem = async () => {
  const m = await (await fetch(`${BASE}/debug/memory`)).json();
  return {
    t: m.timestamp, rssMB: Math.round(m.process.rssBytes / 1e6), heapMB: Math.round(m.process.heapUsedBytes / 1e6),
    dbResidentMB: Object.fromEntries(m.databases.map((d) => [d.name, Math.round(d.smapsResidentBytes / 1e6)])),
  };
};

const client = new Client({ name: "probe-gemma-prod-memory", version: "0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)));

const timed = async (tool, args) => {
  const t0 = performance.now();
  const r = await client.callTool({ name: tool, arguments: args });
  const ms = Math.round(performance.now() - t0);
  return { ms, isError: !!r.isError };
};

const log = [];
const phase = async (name, calls) => {
  const before = await mem();
  const times = [];
  for (const [tool, args] of calls) {
    const r = await timed(tool, args);
    times.push({ tool, args, ...r });
    if (r.isError) console.error(`  ✗ ${tool} ${JSON.stringify(args)}`);
  }
  const after = await mem();
  const ms = times.map((x) => x.ms).sort((a, b) => a - b);
  const p50 = ms[Math.floor(ms.length / 2)], max = ms.at(-1);
  console.log(`${name.padEnd(26)} n=${ms.length} p50=${p50}ms max=${max}ms  rss ${before.rssMB}→${after.rssMB} MB  db ${JSON.stringify(after.dbResidentMB)}`);
  log.push({ name, before, after, times });
};

const q = (extra) => QUERIES.map((query) => ["multimodal_search", { query, maxResults: 10, ...extra }]);

console.log(`server ${BASE}`);
console.log(`baseline ${JSON.stringify(await mem())}`);
await phase("semantic_search (e5)", QUERIES.map((query) => ["semantic_search", { query, maxResults: 10 }]));
await phase("mm metadata-only", q({ channels: ["metadata"] }));
await phase("mm image-only", q({ channels: ["image"] }));
await phase("mm iconclass-only", q({ channels: ["iconclass"] }));
await phase("mm fused (cold-ish)", q({}));
await phase("mm fused (repeat)", q({}).map(([t, a]) => [t, { ...a, query: a.query + " " }]));
await phase("mm fused type=painting", q({ type: "painting" }));
await phase("mm fused type=print", q({ type: "print" }));
await phase("mm fused creator=Rembrandt", q({ creator: "Rembrandt van Rijn" }));

await client.close();
if (OUT) writeFileSync(OUT, JSON.stringify(log, null, 2));
