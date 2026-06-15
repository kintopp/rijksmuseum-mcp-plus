// Test plan 018 Tier 2: parseMethod/unsold/uncertain/gap/crossRef filters,
// partyRole dim + filter, exhibition filter.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const t = new StdioClientTransport({
  command: "node", args: ["dist/index.js"], cwd: PROJECT_DIR,
  env: { ...process.env, STRUCTURED_CONTENT: "true" },
});
const c = new Client({ name: "test-tier2", version: "0.1" });
await c.connect(t);

let passed = 0;
let failed = 0;

async function assertEntries(label, args) {
  const r = await c.callTool({ name: "collection_stats", arguments: args });
  const s = r.structuredContent;
  if (s?.entries?.length > 0) {
    console.log(`  PASS: ${label} — entries=${s.entries.length}, total=${s.total}`);
    passed++;
  } else {
    console.error(`  FAIL: ${label} — entries=${s?.entries?.length}, total=${s?.total}`);
    failed++;
  }
  return s;
}

async function assertNarrows(label, baseArgs, filterArgs) {
  const base = await c.callTool({ name: "collection_stats", arguments: baseArgs });
  const filtered = await c.callTool({ name: "collection_stats", arguments: filterArgs });
  const baseTotal = base.structuredContent?.total ?? 0;
  const filteredTotal = filtered.structuredContent?.total ?? 0;
  const ok = filteredTotal < baseTotal && filteredTotal > 0;
  if (ok) {
    console.log(`  PASS: ${label} — ${filteredTotal} < ${baseTotal}`);
    passed++;
  } else {
    console.error(`  FAIL: ${label} — filtered=${filteredTotal} vs base=${baseTotal}`);
    failed++;
  }
}

console.log("=== Tier 2.5: parseMethod filter ===");
await assertNarrows(
  "parseMethod='peg' narrows transferType total",
  { dimension: "transferType", topN: 5 },
  { dimension: "transferType", parseMethod: "peg", topN: 5 },
);

console.log("\n=== Tier 2.5: event boolean filters ===");
// unsold=true should narrow (some events are flagged unsold)
await assertNarrows(
  "unsold=true narrows",
  { dimension: "transferType", topN: 5 },
  { dimension: "transferType", unsold: true, topN: 5 },
);
// uncertain=true should also narrow
await assertNarrows(
  "uncertain=true narrows",
  { dimension: "transferType", topN: 5 },
  { dimension: "transferType", uncertain: true, topN: 5 },
);

console.log("\n=== Tier 2.6: partyRole dim + filter ===");
const partyRoleResult = await assertEntries("partyRole dim", { dimension: "partyRole", topN: 10 });
if (partyRoleResult) {
  const labels = partyRoleResult.entries.map(e => e.label);
  console.log(`    partyRole labels: ${labels.join(", ")}`);
  // Test partyRole filter using first result label
  if (labels.length > 0) {
    await assertNarrows(
      `partyRole='${labels[0]}' filter narrows party total`,
      { dimension: "party", topN: 5 },
      { dimension: "party", partyRole: labels[0], topN: 5 },
    );
  }
}

console.log("\n=== Step 4: exhibition filter ===");
await assertNarrows(
  "exhibition filter narrows",
  { dimension: "type", topN: 5 },
  { dimension: "type", exhibition: "Nederland", topN: 5 },
);

await c.close();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
