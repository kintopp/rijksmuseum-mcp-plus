// Quick smoke: verify party-conjunction fix on real data.
// Issues a positionMethod-only query and a party-only query, then both together,
// and prints the structured `total` + `coverage` so the operator can eyeball.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const t = new StdioClientTransport({
  command: "node", args: ["dist/index.js"], cwd: PROJECT_DIR,
  env: { ...process.env, STRUCTURED_CONTENT: "true" },
});
const c = new Client({ name: "smoke-party", version: "0.1" });
await c.connect(t);

const queries = [
  { dimension: "party", positionMethod: "llm_enrichment", topN: 3 },
  { dimension: "party", party: "Bredius", topN: 3 },
  { dimension: "party", party: "Bredius", positionMethod: "llm_enrichment", topN: 3 },
];
for (const args of queries) {
  const r = await c.callTool({ name: "collection_stats", arguments: args });
  const s = r.structuredContent;
  console.log(JSON.stringify(args), "→", { total: s?.total, coverage: s?.coverage, entries: s?.entries?.length });
}
await c.close();
