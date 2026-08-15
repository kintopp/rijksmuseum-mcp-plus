// Regression gates for two silent-wrong-answer bugs:
//   1. binWidth was ignored on every binned dimension — better-sqlite3 binds JS numbers
//      as REAL, so an uncast `x / ?` divided in floating point and `(x/w)*w === x` put
//      every value in its own bucket, while structuredContent still echoed bucketWidth.
//   2. compact=true at layer='periods' returned an all-zero rollup — the compact
//      projection read `events`, which is empty on the periods layer.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const t = new StdioClientTransport({
  command: "node", args: ["dist/index.js"], cwd: PROJECT_DIR,
  env: { ...process.env, STRUCTURED_CONTENT: "true", MCP_SKIP_STARTUP_WARM: "1" },
});
const c = new Client({ name: "test-binned-dims", version: "0.1" });
await c.connect(t);

let passed = 0;
let failed = 0;
const check = (ok, label, detail) => {
  if (ok) { console.log(`  PASS: ${label}${detail ? ` — ${detail}` : ""}`); passed++; }
  else { console.error(`  FAIL: ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
};

async function assertBinned(dimension, binWidth, extra = {}) {
  const r = await c.callTool({
    name: "collection_stats",
    arguments: { dimension, binWidth, topN: 10, ...extra },
  });
  const s = r.structuredContent;
  const labels = (s?.entries ?? []).map(e => Number(e.label));
  const offGrid = labels.filter(l => l % binWidth !== 0);
  check(labels.length > 0 && offGrid.length === 0,
    `${dimension} binWidth=${binWidth} → every label on the grid`,
    `n=${labels.length}, off-grid=${offGrid.slice(0, 5).join(",") || "none"}`);
  check(s?.bucketWidth === binWidth,
    `${dimension} bucketWidth echo matches the data`, `bucketWidth=${s?.bucketWidth}`);
}

console.log("=== binWidth honoured on binned dimensions ===");
await assertBinned("decade", 50, { technique: "etching", creationDateFrom: 1500, creationDateTo: 1800 });
await assertBinned("height", 20, { type: "painting" });
await assertBinned("width", 25, { type: "painting" });
await assertBinned("creatorBirthDecade", 50, { type: "painting" });
await assertBinned("provenanceDecade", 50, { hasProvenance: true });

// century/decadeModified hardcode their bucket width — binWidth must not perturb them.
console.log("\n=== fixed-width dimensions ignore binWidth ===");
{
  const r = await c.callTool({
    name: "collection_stats",
    arguments: { dimension: "century", binWidth: 7, topN: 10 },
  });
  const labels = (r.structuredContent?.entries ?? []).map(e => Number(e.label));
  check(labels.length > 0 && labels.every(l => l % 100 === 0),
    "century stays on 100-year buckets", `labels=${labels.slice(0, 4).join(",")}`);
}

console.log("\n=== compact=true at layer='periods' ===");
{
  const r = await c.callTool({
    name: "search_provenance",
    arguments: { layer: "periods", compact: true, sortBy: "duration", minDuration: 100, maxResults: 3 },
  });
  const arts = r.structuredContent?.results ?? [];
  check(arts.length > 0, "periods+compact returns artworks", `n=${arts.length}`);

  const withRollup = arts.filter(a => a.periodSummary && a.periodSummary.periodCount > 0);
  check(withRollup.length === arts.length,
    "every record carries a non-empty periodSummary",
    `${withRollup.length}/${arts.length}`);

  const durations = arts.map(a => a.periodSummary?.longestDuration).filter(d => d != null);
  check(durations.length > 0 && durations.every(d => d >= 100),
    "longestDuration honours minDuration=100", `durations=${durations.join(",")}`);

  check(arts.every(a => (a.matchedPeriods ?? []).length > 0),
    "matched-period one-liners are present");

  check(arts.every(a => !a.summary && !a.matchedEvents),
    "event-shaped rollup fields are omitted on the periods layer");

  const text = r.content?.find(b => b.type === "text")?.text ?? "";
  check(/\d+\/\d+ periods matched/.test(text) && !/events matched/.test(text),
    "text channel reports periods, not events");
}

console.log("\n=== compact=true at layer='events' is unchanged ===");
{
  const r = await c.callTool({
    name: "search_provenance",
    arguments: { party: "Six", compact: true, maxResults: 3 },
  });
  const arts = r.structuredContent?.results ?? [];
  check(arts.length > 0 && arts.every(a => a.summary && !a.periodSummary),
    "events layer still emits summary/matchedEvents", `n=${arts.length}`);
}

await c.close();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
