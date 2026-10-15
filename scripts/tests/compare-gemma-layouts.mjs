/**
 * Compare multimodal_search between two gemma.db builds (e.g. legacy vec0 vs two-stage)
 * through the real tool over stdio: per-call latency and top-N overlap per query/mode.
 *
 * Usage: node scripts/tests/compare-gemma-layouts.mjs <a.db> <b.db>
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const [dbA, dbB] = process.argv.slice(2);
if (!dbA || !dbB) { console.error("usage: compare-gemma-layouts.mjs <a.db> <b.db>"); process.exit(2); }

const QUERIES = ["children playing outside on the street", "a skull next to an hourglass", "red umbrella",
  "ships in a storm at sea", "a woman reading a letter by a window", "windmill beside a river at dusk"];
const MODES = [
  ["fused", {}], ["metadata", { channels: ["metadata"] }], ["image", { channels: ["image"] }],
  ["iconclass", { channels: ["iconclass"] }], ["type=painting", { type: "painting" }],
  ["type=print", { type: "print" }], ["creator=Rembrandt", { creator: "Rembrandt van Rijn" }],
];

const connect = async (db) => {
  const c = new Client({ name: "compare-gemma-layouts", version: "1" });
  await c.connect(new StdioClientTransport({
    command: process.execPath, args: [path.join(PROJECT_DIR, "dist", "index.js")],
    env: { ...process.env, GEMMA_DB_PATH: path.resolve(db), STRUCTURED_CONTENT: "true" }, stderr: "ignore",
  }));
  return c;
};
const run = async (c, args) => {
  const t0 = performance.now();
  const r = await c.callTool({ name: "multimodal_search", arguments: { maxResults: 50, ...args } });
  if (r.isError) throw new Error(JSON.stringify(r.content));
  return { ms: performance.now() - t0, ids: r.structuredContent.results.map((x) => x.objectNumber) };
};

const a = await connect(dbA), b = await connect(dbB);
await run(a, { query: "warmup" }); await run(b, { query: "warmup" });
let worst = 1;
for (const [mode, extra] of MODES) {
  const ta = [], tb = [], o10 = [], o50 = [];
  for (const query of QUERIES) {
    const ra = await run(a, { query, ...extra }), rb = await run(b, { query, ...extra });
    ta.push(ra.ms); tb.push(rb.ms);
    const ov = (n) => { const s = new Set(ra.ids.slice(0, n)); return rb.ids.slice(0, n).filter((x) => s.has(x)).length / Math.max(1, Math.min(n, ra.ids.length)); };
    o10.push(ov(10)); o50.push(ov(50));
  }
  const med = (x) => x.sort((p, q) => p - q)[x.length >> 1].toFixed(0);
  const mean = (x) => (x.reduce((p, q) => p + q) / x.length).toFixed(3);
  worst = Math.min(worst, ...o10);
  console.log(`${mode.padEnd(18)} A p50 ${med(ta).padStart(5)} ms  B p50 ${med(tb).padStart(5)} ms  overlap@10 ${mean(o10)} (min ${Math.min(...o10).toFixed(2)})  @50 ${mean(o50)}`);
}
await a.close(); await b.close();
console.log(`worst overlap@10: ${worst.toFixed(2)}`);
