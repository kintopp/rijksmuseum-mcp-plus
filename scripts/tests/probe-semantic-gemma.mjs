// Scratch probe: semantic_search on gemma.db + find_similar Description channel, over stdio.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node", args: ["dist/index.js"],
  env: { ...process.env, MCP_SKIP_STARTUP_WARM: "1", GEMMA_DB_PATH: process.env.GEMMA_DB_PATH ?? "data/gemma.db" },
  stderr: "pipe",
});
const client = new Client({ name: "probe", version: "0" });
await client.connect(transport);
const { tools } = await client.listTools();
console.log(tools.length, "tools; semantic_search:", tools.some(t => t.name === "semantic_search"));
const call = async (name, args) => {
  const t0 = performance.now();
  const r = await client.callTool({ name, arguments: args });
  console.log(`\n── ${name} ${JSON.stringify(args)} ${Math.round(performance.now() - t0)} ms`);
  console.log(r.content[0].text.split("\n").filter(l => !l.startsWith("   ")).slice(0, 8).join("\n"));
  return r;
};
await call("semantic_search", { query: "sense of loneliness", maxResults: 5 });
await call("semantic_search", { query: "winter landscape with ice skating", type: "painting", maxResults: 5 });
await call("semantic_search", { query: "winter landscape with ice skating", type: "painting", maxResults: 3, offset: 3 });
await call("semantic_search", { query: "ships at sea", type: "print", maxResults: 5 });
const r = await call("find_similar", { objectNumber: "SK-A-1718", maxResults: 3 });
console.log(/Description/.test(r.content.map(c => c.text).join("")) ? "Description channel present" : "NO Description channel");
await client.close();
