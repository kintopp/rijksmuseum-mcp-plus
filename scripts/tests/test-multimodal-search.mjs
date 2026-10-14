/**
 * multimodal_search smoke test over stdio against the real vocab DB + gemma.db
 * (the Gemma query model downloads on first run).
 *
 * Failure modes checked:
 *   - tool missing although gemma.db is present (registration gate broken)
 *   - a channel silently returns nothing (vec0 table / quantisation / notation join broken)
 *   - query vector in the wrong space: the canonical image query no longer finds its
 *     painting in the image channel's top 10
 *   - fusion drops per-channel provenance (matchedBy disagrees with the channel fields)
 *   - single-channel mode leaks other channels, or its ranks aren't 1..n
 *   - pre-filters ignored (a type filter lets other types through)
 *   - offset pagination overlaps the first page
 *
 * Run: npm run build && node scripts/tests/test-multimodal-search.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let failed = 0;
const check = (ok, msg) => { console.log(`  ${ok ? "✓" : "✗"} ${msg}`); if (!ok) failed++; };

const client = new Client({ name: "test-multimodal-search", version: "1.0" });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [path.join(PROJECT_DIR, "dist", "index.js")],
  env: { ...process.env, MCP_SKIP_STARTUP_WARM: "1", STRUCTURED_CONTENT: "true" },
  stderr: "ignore",
}));
const call = async (args) => {
  const t0 = performance.now();
  const r = await client.callTool({ name: "multimodal_search", arguments: args });
  console.log(`  (${Math.round(performance.now() - t0)} ms) ${JSON.stringify(args)}`);
  return r;
};

try {
  const { tools } = await client.listTools();
  check(tools.some(t => t.name === "multimodal_search"), "multimodal_search is registered");

  console.log("\n1. Fused query, all channels");
  const r = await call({ query: "children playing outside on the street", maxResults: 20 });
  const d = r.structuredContent;
  check(!r.isError && d.returnedCount === 20, `20 fused results (got ${d.returnedCount})`);
  check(d.channels.join() === "metadata,image,iconclass", "all three channels ran");
  for (const c of ["metadata", "image", "iconclass"]) {
    check(d.results.some(x => x.matchedBy.includes(c)), `channel ${c} contributes to the fused list`);
  }
  check(d.iconclassNotations?.length === 3 && d.iconclassNotations.every(n => n.label), "3 labelled Iconclass notations");
  check(d.results.every(x => x.matchedBy.every(c => x[c]) && ["metadata", "image", "iconclass"].every(c => !x[c] || x.matchedBy.includes(c))),
    "matchedBy agrees with the per-channel fields");
  check(d.results.every((x, i) => x.rank === i + 1), "fused ranks are 1..n");
  console.log(r.content[0].text.split("\n").slice(0, 8).join("\n"));

  console.log("\n2. Image channel alone finds a known visual-only query");
  // The Milkmaid: a woman pouring milk from a jug — a scene the image tower ranks near the top.
  const img = await call({ query: "a maid pouring milk from a jug in a kitchen", channels: ["image"], type: "painting", maxResults: 10 });
  const di = img.structuredContent;
  check(di.results.every(x => x.matchedBy.length === 1 && x.matchedBy[0] === "image"), "single-channel results carry only the image channel");
  check(di.results.every((x, i) => x.image.rank === i + 1), "image ranks are 1..n");
  check(di.results.some(x => x.objectNumber === "SK-A-2344"), `SK-A-2344 (The Milkmaid) in the top 10 (got ${di.results.map(x => x.objectNumber).join(", ")})`);
  check(di.results.every(x => x.type === "painting"), "type pre-filter holds");

  console.log("\n3. Pagination");
  const p2 = await call({ query: "children playing outside on the street", maxResults: 20, offset: 20 });
  const firstPage = new Set(d.results.map(x => x.objectNumber));
  check(p2.structuredContent.results.every(x => !firstPage.has(x.objectNumber)), "page 2 does not overlap page 1");
  check(p2.structuredContent.results[0]?.rank === 21, "page 2 starts at rank 21");

  console.log("\n4. Filter with no matches");
  const none = await call({ query: "ship", creator: "zzzz-no-such-artist-zzzz" });
  check(none.structuredContent.returnedCount === 0 && none.structuredContent.warnings?.length, "empty result with a warning");
} finally {
  await client.close();
}

console.log(failed ? `\n${failed} check(s) failed` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
