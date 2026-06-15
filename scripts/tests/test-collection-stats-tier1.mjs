// Test plan 018 Tier 1: productionRole/profession/birthPlace/deathPlace dims + filters,
// gender dim + filter, creatorBirthDecade/creatorBirthCentury dims.
// Models on smoke-collection-stats-party.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const t = new StdioClientTransport({
  command: "node", args: ["dist/index.js"], cwd: PROJECT_DIR,
  env: { ...process.env, STRUCTURED_CONTENT: "true" },
});
const c = new Client({ name: "test-tier1", version: "0.1" });
await c.connect(t);

let passed = 0;
let failed = 0;

async function assertEntries(label, args, expectEntries = true) {
  const r = await c.callTool({ name: "collection_stats", arguments: args });
  const s = r.structuredContent;
  const ok = expectEntries ? (s?.entries?.length > 0) : (s?.entries?.length === 0);
  if (ok) {
    console.log(`  PASS: ${label} — entries=${s?.entries?.length}, total=${s?.total}`);
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

console.log("=== Tier 1: productionRole / profession / birthPlace / deathPlace dims ===");
await assertEntries("productionRole dim", { dimension: "productionRole", topN: 5 });
await assertEntries("profession dim", { dimension: "profession", topN: 5 });
await assertEntries("birthPlace dim", { dimension: "birthPlace", topN: 5 });
await assertEntries("deathPlace dim", { dimension: "deathPlace", topN: 5 });

console.log("\n=== Tier 1: profession / birthPlace / deathPlace filters narrow total ===");
await assertNarrows(
  "profession filter narrows",
  { dimension: "type", topN: 5 },
  { dimension: "type", profession: "painter", topN: 5 },
);
await assertNarrows(
  "birthPlace filter narrows",
  { dimension: "type", topN: 5 },
  { dimension: "type", birthPlace: "Amsterdam", topN: 5 },
);
await assertNarrows(
  "deathPlace filter narrows",
  { dimension: "type", topN: 5 },
  { dimension: "type", deathPlace: "Amsterdam", topN: 5 },
);

console.log("\n=== Tier 2: gender dim + filter ===");
const genderResult = await assertEntries("gender dim", { dimension: "gender", topN: 10 });
if (genderResult) {
  const labels = genderResult.entries.map(e => e.label);
  console.log(`    gender labels: ${labels.join(", ")}`);
}
await assertNarrows(
  "gender='female' filter narrows type breakdown",
  { dimension: "type", topN: 5 },
  { dimension: "type", gender: "female", topN: 5 },
);

console.log("\n=== Tier 2: creatorBirthDecade / creatorBirthCentury dims ===");
const decResult = await assertEntries("creatorBirthDecade dim", { dimension: "creatorBirthDecade", topN: 10 });
if (decResult) {
  const labels = decResult.entries.map(e => e.label);
  console.log(`    sample buckets: ${labels.slice(0, 5).join(", ")}`);
}
await assertEntries("creatorBirthCentury dim", { dimension: "creatorBirthCentury", topN: 10 });

await c.close();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
