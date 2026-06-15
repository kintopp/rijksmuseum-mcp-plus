#!/usr/bin/env node
/**
 * Empirical probe for the MCP_TEXT_JSON_COMPAT question (RELEASE_NOTES_next.md):
 * across the FULL prompt corpus, how often does the serialized-JSON text fallback
 * give a model materially more to work with than the prose summary alone?
 *
 * Corpus = every tool call in scripts/warm-cache-prompts.tsv (derived from the
 * research scenarios) PLUS the research-scenarios tools the TSV omits
 * (search_persons, search_inscriptions). For each call we capture BOTH channels
 * the live server emits — prose summary (content[].text) and structuredContent —
 * and compute a deterministic LOSS metric per prompt:
 *
 *   leafCoverage = fraction of structuredContent leaf VALUES that appear verbatim
 *                  in the prose. High ⇒ prose near-lossless (JSON redundant).
 *                  Low + substantive dropped keys ⇒ prose is a lossy summary.
 *
 * Condition A (flag off) = prose only.
 * Condition B (flag on)  = prose + JSON.stringify(structuredContent), subject to
 *   responseShape.ts's two-tier size guard (per-copy 20 KB cap; projected-total
 *   ceiling 120 KB → marker instead of the copy).
 *
 * Writes one artifact per call to plans/exp-json-compat/calls/ + a master summary
 * (_summary.json) + a table to stdout. No model in the loop here.
 *
 * Run:  node scripts/tests/measure-summary-vs-structured.mjs
 *       RIJKS_MCP_HTTP=<url> node scripts/tests/measure-summary-vs-structured.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT_DIR = path.join(PROJECT_ROOT, "plans", "exp-json-compat");
const CALLS_DIR = path.join(OUT_DIR, "calls");
const TSV = path.join(PROJECT_ROOT, "scripts", "warm-cache-prompts.tsv");
const HTTP_URL =
  process.env.RIJKS_MCP_HTTP ||
  "https://rijksmuseum-mcp-plus-production.up.railway.app/mcp";

const PER_COPY_CAP = 20_000;
const SAFE_RESULT_BUDGET = Math.round(150_000 * 0.8); // 120_000

// Tools whose result is an opaque image / viewer-state blob, not a text answer —
// excluded from the prose-vs-structured comparison.
const SKIP_TOOLS = new Set([
  "get_artwork_image",
  "inspect_artwork_image",
  "navigate_viewer",
  "remount_viewer",
  "poll_viewer_commands",
]);

function parseTsv(file) {
  const out = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const tab = t.indexOf("\t");
    if (tab < 0) continue;
    const tool = t.slice(0, tab).trim();
    let args;
    try {
      args = JSON.parse(t.slice(tab + 1).trim());
    } catch {
      continue;
    }
    out.push({ tool, args, source: "tsv" });
  }
  return out;
}

// research-scenarios.md tools the warm-cache TSV does not exercise.
const EXTRA_CALLS = [
  { tool: "search_persons", args: { gender: "female", hasArtworks: true, maxResults: 25 }, source: "scenario-9" },
  { tool: "search_persons", args: { name: "van Mieris" }, source: "scenario-11" },
  { tool: "search_persons", args: { profession: "print maker", birthPlace: "Haarlem" }, source: "scenario-5" },
  { tool: "search_inscriptions", args: { collectorMark: "Lugt 2760", maxResults: 10 }, source: "scenario-29" },
  { tool: "search_inscriptions", args: { inscriptionType: ["maker's mark", "town mark", "date letter"], maxResults: 10 }, source: "scenario-30" },
  { tool: "search_inscriptions", args: { inscriptionType: "signature", placement: "recto", technique: "handwritten", excludeCollectorMarkOnly: true, maxResults: 10 }, source: "scenario-31" },
  { tool: "collection_stats", args: { dimension: "type", subject: "vanitas" }, source: "scenario-6" },
  { tool: "collection_stats", args: { dimension: "transferType", creator: "Rembrandt" }, source: "scenario-8" },
];

const textOf = (res) =>
  (res.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
const bytes = (s) => Buffer.byteLength(s, "utf8");

// Flatten an object/array to leaf (path, value) pairs.
function leaves(node, prefix, acc) {
  if (node === null || node === undefined) return acc;
  if (Array.isArray(node)) {
    node.forEach((v, i) => leaves(v, `${prefix}[${i}]`, acc));
  } else if (typeof node === "object") {
    for (const [k, v] of Object.entries(node)) leaves(v, prefix ? `${prefix}.${k}` : k, acc);
  } else {
    acc.push({ key: prefix.split(".").pop().replace(/\[\d+\]$/, ""), value: node });
  }
  return acc;
}

// A leaf "appears in prose" if its stringified value occurs verbatim. We skip
// trivially-matchable values (booleans, nulls, <4-char strings, tiny ints) so
// coverage reflects MEANINGFUL data, not coincidental single-digit matches.
function isCheckable(v) {
  if (typeof v === "boolean") return false;
  if (typeof v === "number") return Math.abs(v) >= 1000; // years/counts/prices, not 0/1/seq
  if (typeof v === "string") return v.length >= 4;
  return false;
}

function coverageStats(structured, prose) {
  const all = leaves(structured, "", []);
  const checkable = all.filter((l) => isCheckable(l.value));
  let covered = 0;
  const droppedKeys = {};
  for (const l of checkable) {
    if (prose.includes(String(l.value))) covered++;
    else droppedKeys[l.key] = (droppedKeys[l.key] || 0) + 1;
  }
  const topDropped = Object.entries(droppedKeys)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([k, n]) => `${k}:${n}`);
  return {
    leafTotal: all.length,
    checkable: checkable.length,
    covered,
    coverage: checkable.length ? +(covered / checkable.length).toFixed(2) : 1,
    topDropped,
  };
}

const argDigest = (args) => {
  const s = JSON.stringify(args);
  return s.length > 46 ? s.slice(0, 45) + "…" : s;
};

async function main() {
  mkdirSync(CALLS_DIR, { recursive: true });
  const calls = [...parseTsv(TSV), ...EXTRA_CALLS].filter((c) => !SKIP_TOOLS.has(c.tool));

  const client = new Client({ name: "json-compat-probe", version: "0.2" });
  await client.connect(new StreamableHTTPClientTransport(new URL(HTTP_URL)));

  const rows = [];
  try {
    for (let i = 0; i < calls.length; i++) {
      const c = calls[i];
      const id = String(i).padStart(2, "0") + "-" + c.tool;
      let res;
      try {
        res = await client.callTool({ name: c.tool, arguments: c.args }, undefined, { timeout: 45_000 });
      } catch (err) {
        rows.push({ id, tool: c.tool, args: argDigest(c.args), error: String(err?.message ?? err).slice(0, 40) });
        continue;
      }
      const prose = textOf(res);
      const structured = res.structuredContent ?? null;
      if (res.isError || structured == null) {
        rows.push({ id, tool: c.tool, args: argDigest(c.args), error: res.isError ? "isError" : "no structuredContent" });
        continue;
      }
      const serialized = JSON.stringify(structured);
      const proseBytes = bytes(prose);
      const copyBytes = bytes(serialized);
      const projectedTotal = proseBytes + copyBytes + copyBytes;
      const guard =
        copyBytes <= PER_COPY_CAP && projectedTotal <= SAFE_RESULT_BUDGET
          ? "json"
          : copyBytes > PER_COPY_CAP
            ? "MARKER:cap"
            : "MARKER:ceil";
      const cov = coverageStats(structured, prose);

      const row = {
        id,
        source: c.source,
        tool: c.tool,
        args: argDigest(c.args),
        proseC: prose.length,
        structC: serialized.length,
        ratio: +(serialized.length / Math.max(prose.length, 1)).toFixed(1),
        guard,
        cov: cov.coverage,
        checkable: cov.checkable,
        topDropped: cov.topDropped.join(" "),
      };
      rows.push(row);
      writeFileSync(
        path.join(CALLS_DIR, `${id}.json`),
        JSON.stringify(
          { ...c, question_proxy: c.source, prose, structured, serialized, metrics: cov, guard, sizes: { proseBytes, copyBytes, projectedTotal } },
          null,
          2,
        ),
      );
    }
  } finally {
    await client.close().catch(() => {});
  }

  writeFileSync(path.join(OUT_DIR, "_summary.json"), JSON.stringify(rows, null, 2));

  // stdout table
  const cols = ["id", "tool", "args", "proseC", "structC", "ratio", "guard", "cov", "checkable", "topDropped"];
  const widths = cols.map((col) =>
    Math.max(col.length, ...rows.map((r) => String(r[col] ?? (r.error ? "ERR" : "")).length)),
  );
  const fmt = (vals) => vals.map((v, i) => String(v ?? "").padEnd(widths[i])).join("  ");
  console.log(fmt(cols));
  console.log(fmt(widths.map((w) => "-".repeat(w))));
  for (const r of rows) {
    if (r.error) console.log(`${r.id.padEnd(widths[0])}  ${r.tool.padEnd(widths[1])}  ${r.args.padEnd(widths[2])}  ERROR: ${r.error}`);
    else console.log(fmt(cols.map((col) => r[col])));
  }

  // Bucket summary
  const ok = rows.filter((r) => !r.error);
  const lossy = ok.filter((r) => r.cov < 0.6);
  const mid = ok.filter((r) => r.cov >= 0.6 && r.cov < 0.85);
  const lossless = ok.filter((r) => r.cov >= 0.85);
  console.log(
    `\nBUCKETS (by leaf coverage):  lossless ≥0.85: ${lossless.length}   mid 0.6–0.85: ${mid.length}   lossy <0.6: ${lossy.length}   (errors: ${rows.length - ok.length})`,
  );
  console.log(`Artifacts: ${path.relative(PROJECT_ROOT, CALLS_DIR)}/<id>.json + _summary.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
