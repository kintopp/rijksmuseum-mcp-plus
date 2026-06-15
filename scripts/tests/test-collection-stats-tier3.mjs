// Test plan 018 Tier 3: placeType dim + filter, has* boolean filters.
// has* tests use a narrow date range to keep the filtered pool small for speed.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const t = new StdioClientTransport({
  command: "node", args: ["dist/index.js"], cwd: PROJECT_DIR,
  env: { ...process.env, STRUCTURED_CONTENT: "true" },
});
const c = new Client({ name: "test-tier3", version: "0.1" });
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

async function assertPositiveTotal(label, args) {
  const r = await c.callTool({ name: "collection_stats", arguments: args });
  const s = r.structuredContent;
  if (s?.total > 0) {
    console.log(`  PASS: ${label} — total=${s.total}`);
    passed++;
  } else {
    console.error(`  FAIL: ${label} — total=${s?.total}`);
    failed++;
  }
  return s;
}

console.log("=== Tier 3.7: placeType dim + filter ===");
const ptResult = await assertEntries("placeType dim", { dimension: "placeType", topN: 10 });
if (ptResult) {
  const labels = ptResult.entries.map(e => e.label);
  console.log(`    placeType labels: ${labels.join(", ")}`);
  if (labels.length > 0) {
    await assertNarrows(
      `placeType='${labels[0]}' filter narrows type`,
      { dimension: "type", topN: 5 },
      { dimension: "type", placeType: labels[0], topN: 5 },
    );
  }
}

// Use a narrow date range (~17th century) to keep pools small and has* queries fast.
// The 17th century contains ~50K artworks — large enough to exercise the predicates but
// small enough that correlated EXISTS scans finish quickly.
const BASE = { creationDateFrom: 1600, creationDateTo: 1700 };

console.log("\n=== Tier 3.8: has* boolean filters (scoped to 1600–1700 for speed) ===");
await assertNarrows(
  "hasInscription=true narrows",
  { dimension: "type", ...BASE, topN: 5 },
  { dimension: "type", ...BASE, hasInscription: true, topN: 5 },
);
await assertPositiveTotal("hasInscription=false has positive total",
  { dimension: "type", ...BASE, hasInscription: false, topN: 5 });

await assertNarrows(
  "hasNarrative=true narrows",
  { dimension: "type", ...BASE, topN: 5 },
  { dimension: "type", ...BASE, hasNarrative: true, topN: 5 },
);

await assertNarrows(
  "hasDimensions=false narrows",
  { dimension: "type", ...BASE, topN: 5 },
  { dimension: "type", ...BASE, hasDimensions: false, topN: 5 },
);

await assertNarrows(
  "hasExhibitions=true narrows",
  { dimension: "type", ...BASE, topN: 5 },
  { dimension: "type", ...BASE, hasExhibitions: true, topN: 5 },
);

await assertNarrows(
  "hasExternalIds=false narrows",
  { dimension: "type", ...BASE, topN: 5 },
  { dimension: "type", ...BASE, hasExternalIds: false, topN: 5 },
);

await assertNarrows(
  "hasParent=true narrows",
  { dimension: "type", ...BASE, topN: 5 },
  { dimension: "type", ...BASE, hasParent: true, topN: 5 },
);

// hasExaminations and hasModifications are sparse; test as positive totals to avoid empty results
await assertPositiveTotal("hasExaminations=true positive total",
  { dimension: "type", hasExaminations: true, topN: 5 });
await assertPositiveTotal("hasModifications=true positive total",
  { dimension: "type", hasModifications: true, topN: 5 });

// hasWikidataCreator — restrict to 17th century to keep the scan small
await assertNarrows(
  "hasWikidataCreator=true narrows (17th c)",
  { dimension: "type", ...BASE, topN: 5 },
  { dimension: "type", ...BASE, hasWikidataCreator: true, topN: 5 },
);

// hasAltNames — uses organisation/group alt names; positive total check
await assertPositiveTotal("hasAltNames=true positive total",
  { dimension: "type", ...BASE, hasAltNames: true, topN: 5 });

await c.close();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
