/**
 * Benchmark find_similar across diverse artworks to profile performance.
 *
 * Tests a matrix of artworks with varying signal profiles:
 * - Rich iconclass vs sparse
 * - Many depicted persons/places vs none
 * - With/without lineage qualifiers
 * - With/without description embeddings
 * - Paintings vs prints vs objects
 *
 * Run:  ENABLE_FIND_SIMILAR=true node scripts/tests/bench-find-similar.mjs
 *       ENABLE_FIND_SIMILAR=true node scripts/tests/bench-find-similar.mjs SK-A-1718  # single artwork
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// ── Test matrix: diverse artworks ────────────────────────────────

const TEST_ARTWORKS = [
  // Paintings — well-known, likely rich metadata
  { id: "SK-C-5",    label: "Night Watch (Rembrandt) — iconic, many subjects" },
  { id: "SK-A-1718", label: "Winter Landscape (Avercamp) — rich iconclass, no lineage" },
  { id: "SK-A-2344", label: "Love Letter (Vermeer) — genre scene" },
  { id: "SK-A-3924", label: "Self-Portrait (Van Gogh) — modern, lineage" },
  { id: "SK-A-4691", label: "Windmill (Ruisdael) — landscape" },
  // Prints — typically many lineage qualifiers ("after", "copy after")
  { id: "RP-P-OB-1",   label: "Print — likely has lineage qualifiers" },
  { id: "RP-P-2015-8",  label: "Print — heavily inspected in logs" },
  // Decorative arts — different signal profile
  { id: "BK-NM-1010",  label: "Decorative art — few subjects" },
  { id: "BK-14656",    label: "Dollhouse — cross-referenced in provenance" },
  // Photograph
  { id: "RP-F-2001-7-1598-20", label: "Photo — Florence baptistery doors" },
];

// ── Helpers ──────────────────────────────────────────────────────

function parseSignalCounts(text) {
  const signals = {};
  const re = /(\w[\w ]*?):\s*(\d+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    signals[m[1].trim()] = parseInt(m[2], 10);
  }
  return signals;
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  const singleMode = process.argv[2];
  const artworks = singleMode
    ? [{ id: singleMode, label: singleMode }]
    : TEST_ARTWORKS;

  const transport = new StdioClientTransport({
    command: "node",
    args: [path.join(PROJECT_DIR, "dist/index.js")],
    env: { ...process.env, ENABLE_FIND_SIMILAR: "true" },
  });
  const client = new Client({ name: "bench-find-similar", version: "1.0.0" });
  await client.connect(transport);

  const tools = await client.listTools();
  const toolNames = tools.tools.map(t => t.name);
  console.log(`Connected. ${toolNames.length} tools available.`);
  if (!toolNames.includes("find_similar")) {
    console.error("ERROR: find_similar not registered. Set ENABLE_FIND_SIMILAR=true");
    process.exit(1);
  }

  // ── Phase 0: Warm up DB pages + IDF caches ─────────────────────
  console.log("\n--- Phase 0: Warm-up (DB pages + IDF caches) ---");
  {
    const t0 = performance.now();
    await client.callTool({ name: "search_artwork", arguments: { creator: "Rembrandt", maxResults: 1, compact: true } });
    console.log(`  search_artwork warm-up: ${Math.round(performance.now() - t0)}ms`);
  }
  {
    const t0 = performance.now();
    await client.callTool({ name: "semantic_search", arguments: { query: "warmup", maxResults: 1 } });
    console.log(`  semantic_search warm-up: ${Math.round(performance.now() - t0)}ms`);
  }
  // First find_similar primes IDF caches
  {
    const t0 = performance.now();
    await client.callTool({ name: "find_similar", arguments: { objectNumber: "SK-C-5", maxResults: 1 } });
    const ms = Math.round(performance.now() - t0);
    console.log(`  find_similar IDF cache prime: ${ms}ms (includes lazy cache build)`);
  }

  // ── Phase 1: Benchmark each artwork ────────────────────────────
  console.log("\n--- Phase 1: Benchmark matrix (all caches warm) ---\n");

  const results = [];

  for (const art of artworks) {
    const t0 = performance.now();
    const res = await client.callTool({
      name: "find_similar",
      arguments: { objectNumber: art.id, maxResults: 20 },
    });
    const ms = Math.round(performance.now() - t0);

    const text = res.content?.[0]?.text ?? "";
    const signals = parseSignalCounts(text);
    const error = res.isError ? text.slice(0, 80) : null;

    results.push({ ...art, ms, signals, error });

    const signalStr = error
      ? `ERROR: ${error}`
      : Object.entries(signals).map(([k, v]) => `${k}:${v}`).join(" ");
    console.log(`  ${art.id.padEnd(25)} ${String(ms).padStart(5)}ms  ${signalStr}`);
  }

  // ── Phase 2: maxResults sensitivity ────────────────────────────
  if (!singleMode) {
    console.log("\n--- Phase 2: maxResults sensitivity (SK-A-1718) ---\n");
    for (const max of [5, 10, 20, 50]) {
      const t0 = performance.now();
      await client.callTool({
        name: "find_similar",
        arguments: { objectNumber: "SK-A-1718", maxResults: max },
      });
      const ms = Math.round(performance.now() - t0);
      console.log(`  max=${String(max).padStart(2)}: ${ms}ms`);
    }
  }

  // ── Phase 3: Repeat run (fully warm — test consistency) ────────
  if (!singleMode) {
    console.log("\n--- Phase 3: Repeat run (consistency check) ---\n");
    for (const art of artworks.slice(0, 4)) {
      const t0 = performance.now();
      await client.callTool({
        name: "find_similar",
        arguments: { objectNumber: art.id, maxResults: 20 },
      });
      const ms = Math.round(performance.now() - t0);
      const first = results.find(r => r.id === art.id);
      const delta = first ? `(Δ ${ms - first.ms > 0 ? "+" : ""}${ms - first.ms}ms)` : "";
      console.log(`  ${art.id.padEnd(25)} ${String(ms).padStart(5)}ms  ${delta}`);
    }
  }

  // ── Summary ────────────────────────────────────────────────────
  const valid = results.filter(r => !r.error);
  if (valid.length > 1) {
    const times = valid.map(r => r.ms).sort((a, b) => a - b);
    const p50 = times[Math.floor(times.length * 0.5)];
    const p90 = times[Math.floor(times.length * 0.9)];
    const max = times[times.length - 1];
    const min = times[0];

    console.log("\n" + "═".repeat(60));
    console.log("Summary (warm, maxResults=20):");
    console.log(`  Artworks tested: ${valid.length}`);
    console.log(`  Min: ${min}ms  p50: ${p50}ms  p90: ${p90}ms  Max: ${max}ms`);

    // Correlation: total signal count vs latency
    const withSignals = valid.map(r => ({
      id: r.id,
      ms: r.ms,
      totalSignals: Object.values(r.signals).reduce((a, b) => a + b, 0),
    }));
    withSignals.sort((a, b) => b.ms - a.ms);
    console.log("\n  Latency vs signal count:");
    for (const r of withSignals) {
      console.log(`    ${r.id.padEnd(25)} ${String(r.ms).padStart(5)}ms  signals: ${r.totalSignals}`);
    }
    console.log("═".repeat(60));
  }

  await client.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
