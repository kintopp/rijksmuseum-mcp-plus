// Payload-redundancy audit — orchestrator.
//
// Phases:
//   1.  Connect MCP stdio client, list tools, capture flattened schemas.
//   1b. Grep the source tree for shared format/build/render helpers.
//   2.  Call each fixture, capture (structuredContent, text) per response.
//   3.  Per-response: byte budget, structured↔text presence diff, intra-field
//       self-duplication, derivable-string detection.
//   4.  Cross-tool: shape collisions (from schemas), value aliases (from
//       captured responses on shared anchors).
//   5.  Render audit-report.html, audit-findings.csv, audit-schemas.json
//       under scripts/tests/audit/out/.
//
// Usage:
//   node scripts/tests/audit/run.mjs                   # full run
//   node scripts/tests/audit/run.mjs --use-cached      # reuse responses/, re-analyze only
//
// Requires:
//   - npm run build  (dist/index.js must exist)
//   - data/vocabulary.db, data/embeddings.db present locally

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FIXTURES, SKIPPED_TOOLS } from "./fixtures.mjs";
import { buildHelperGraph, flagSharedHelpers } from "./helper-graph.mjs";
import {
  flattenJsonSchema,
  bytesByField,
  presenceDiff,
  intraFieldDup,
  buildNameIndex,
  findShapeCollisions,
  findValueAliases,
  findTextOnlySignals,
  tryDeriveString,
  walkValue,
  severity,
} from "./analyzers.mjs";
import { renderReport } from "./render-html.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "../../..");
const OUT_DIR = path.join(HERE, "out");
const RESPONSES_DIR = path.join(OUT_DIR, "responses");

const USE_CACHED = process.argv.includes("--use-cached");

fs.mkdirSync(RESPONSES_DIR, { recursive: true });

// ── Phase 0: load project version ─────────────────────────────────

function loadProjectVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8"));
    return `v${pkg.version}`;
  } catch {
    return "v?";
  }
}

// ── Phase 1: connect + tools/list + schema flatten ────────────────

async function connect() {
  console.log("[1/5] Connecting to MCP server via stdio…");
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    cwd: PROJECT_ROOT,
    env: { ...process.env, ENABLE_FIND_SIMILAR: "true", STRUCTURED_CONTENT: "true" },
  });
  const client = new Client({ name: "payload-audit", version: "0.1.0" });
  await client.connect(transport);
  return { client, transport };
}

function flattenAllSchemas(toolsList) {
  const schemasByTool = {};
  for (const tool of toolsList) {
    const schema = tool.outputSchema;
    if (!schema) {
      schemasByTool[tool.name] = [];
      continue;
    }
    schemasByTool[tool.name] = flattenJsonSchema(schema);
  }
  return schemasByTool;
}

/**
 * Parse the TOOL_LIMITS const declaration from src/registration.ts to
 * recover per-call max/default thresholds. Regex-based; bails out
 * (returns empty) if the format changes — the appendix will just be empty
 * in that case, which is a visible signal to update this parser.
 */
function parseToolLimits() {
  const src = fs.readFileSync(path.join(PROJECT_ROOT, "src/registration.ts"), "utf8");
  const blockMatch = /const\s+TOOL_LIMITS\s*=\s*\{([\s\S]*?)\}\s*as\s+const/.exec(src);
  if (!blockMatch) return {};
  const lines = blockMatch[1].split("\n");
  const out = {};
  const rowRe = /^\s*([a-z_]+)\s*:\s*\{\s*max\s*:\s*(\d+)\s*,\s*default\s*:\s*(\d+)\s*\}/;
  for (const line of lines) {
    const m = rowRe.exec(line);
    if (m) out[m[1]] = { max: Number(m[2]), default: Number(m[3]) };
  }
  return out;
}

/**
 * For each tool's inputSchema, find boolean properties whose name matches
 * the project's "response-mode-switch" pattern (compact, identifiersOnly,
 * etc.). Returns { tool: [{ flag, description }] }.
 */
function detectModeFlags(toolsList) {
  const known = ["compact", "identifiersOnly", "compactMode", "summaryOnly"];
  const out = {};
  for (const tool of toolsList) {
    const props = tool.inputSchema?.properties ?? {};
    const flags = [];
    for (const [name, sub] of Object.entries(props)) {
      if (!known.includes(name)) continue;
      const desc = sub?.description ?? "";
      flags.push({ flag: name, description: desc });
    }
    if (flags.length > 0) out[tool.name] = flags;
  }
  return out;
}

// ── Phase 2: capture responses ────────────────────────────────────

function fixtureFilePath(fixture) {
  return path.join(RESPONSES_DIR, `${fixture.tool}__${fixture.label}.json`);
}

async function captureAll(client, fixtures, toolNames) {
  const captures = [];
  const failures = [];
  for (const f of fixtures) {
    if (!toolNames.has(f.tool)) {
      failures.push({ tool: f.tool, fixture: f.label, error: `tool not present on this server` });
      continue;
    }
    const filePath = fixtureFilePath(f);
    if (USE_CACHED && fs.existsSync(filePath)) {
      const cached = JSON.parse(fs.readFileSync(filePath, "utf8"));
      captures.push({ ...cached, fixture: f.label, tool: f.tool, anchor: f.anchor, excludeFields: f.excludeFields });
      continue;
    }
    try {
      console.log(`[2/5] Calling ${f.tool} / ${f.label}…`);
      const r = await client.callTool({ name: f.tool, arguments: f.args });
      const structured = r.structuredContent ?? safeJson(r.content?.[0]?.text);
      const text = r.content?.[0]?.text ?? "";
      const isError = !!r.isError;
      const record = {
        tool: f.tool,
        fixture: f.label,
        anchor: f.anchor,
        excludeFields: f.excludeFields ?? [],
        isError,
        bytesStructured: JSON.stringify(structured ?? null).length,
        bytesText: text.length,
        structured,
        text,
        args: f.args,
      };
      fs.writeFileSync(filePath, JSON.stringify(record, null, 2));
      captures.push(record);
      if (isError) {
        failures.push({ tool: f.tool, fixture: f.label, error: extractError(structured, text) });
      }
    } catch (err) {
      failures.push({ tool: f.tool, fixture: f.label, error: String(err?.message ?? err) });
    }
  }
  return { captures, failures };
}

function safeJson(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

function extractError(structured, text) {
  if (structured?.error) return String(structured.error);
  return text.slice(0, 200);
}

// ── Phase 3: per-response analysis ────────────────────────────────

function analyzePerResponse(captures) {
  const deadBytes = [];
  const intraDups = [];
  const derivables = [];
  const textOnly = [];
  const bytesByTool = [];

  for (const cap of captures) {
    if (cap.isError || !cap.structured) continue;
    const exclude = new Set(cap.excludeFields ?? []);

    // 3a: bytes per field
    const fieldBytes = bytesByField(cap.structured);
    // Exclude configured fields from accounting (e.g. base64 image bytes)
    let topFields = [...fieldBytes.entries()]
      .filter(([k]) => !exclude.has(k.split(".").pop()))
      .filter(([k]) => k.includes(".") || k.includes("[]"))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    bytesByTool.push({
      tool: cap.tool,
      fixture: cap.fixture,
      bytesStructured: cap.bytesStructured,
      bytesText: cap.bytesText,
      topFields,
    });

    // 3b: structured↔text presence diff (dead bytes)
    const presence = presenceDiff(cap.structured, cap.text ?? "");
    for (const p of presence) {
      if (p.present) continue;
      if (p.bytes < 40) continue;
      if (exclude.has(p.path.split(".").pop())) continue;
      const sev = severity({ bytesWasted: p.bytes, callsPerDay: 1, classWeight: 1.5 });
      deadBytes.push({
        tool: cap.tool,
        fixture: cap.fixture,
        path: p.path,
        bytes: p.bytes,
        valueSample: p.valueSample,
        severity: sev,
      });
    }

    // 3c: intra-field self-duplication on long string fields
    for (const node of walkValue(cap.structured)) {
      if (typeof node.value !== "string") continue;
      if (node.value.length < 200) continue;
      const dup = intraFieldDup(node.value);
      if (!dup) continue;
      if (dup.overallRedundancy < 0.3 && dup.translationPairs < 1) continue;
      const sev = severity({
        bytesWasted: dup.totalBytes * dup.overallRedundancy,
        callsPerDay: 1,
        classWeight: 1.2,
      });
      intraDups.push({
        tool: cap.tool,
        fixture: cap.fixture,
        path: node.path.replace(/\[\d+\]/g, "[]"),
        dup,
        severity: sev,
      });
    }

    // 3d: derivable string fields — find array fields with matching string siblings
    findDerivablePairs(cap.structured, "", cap.tool, cap.fixture, derivables);

    // 3e: text-only signals (reverse of dead bytes)
    if (cap.text) {
      const signals = findTextOnlySignals(cap.text, cap.structured);
      for (const s of signals) {
        const sev = severity({
          bytesWasted: s.valueSample.length,
          callsPerDay: 1,
          // Text-only signals weight slightly higher than dead bytes —
          // they represent missing structured-channel surface area,
          // which is harder to retrofit than removing a redundant field.
          classWeight: s.valuePresentInStructured ? 1.0 : 1.4,
        });
        textOnly.push({
          tool: cap.tool,
          fixture: cap.fixture,
          label: s.label,
          valueSample: s.valueSample,
          valuePresentInStructured: s.valuePresentInStructured,
          reason: s.reason,
          severity: sev,
        });
      }
    }
  }

  // Sort each list by severity desc
  deadBytes.sort((a, b) => b.severity - a.severity);
  intraDups.sort((a, b) => b.severity - a.severity);
  textOnly.sort((a, b) => b.severity - a.severity);

  return { deadBytes, intraDups, derivables, textOnly, bytesByTool };
}

function findDerivablePairs(node, prefix, tool, fixture, out) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      findDerivablePairs(node[i], `${prefix}[${i}]`, tool, fixture, out);
    }
    return;
  }
  // Look at sibling pairs within this object
  const entries = Object.entries(node);
  const arrays = entries.filter(([, v]) => Array.isArray(v));
  const strings = entries.filter(([, v]) => typeof v === "string");
  for (const [aKey, aVal] of arrays) {
    for (const [sKey, sVal] of strings) {
      const derived = tryDeriveString(aVal, sVal);
      if (derived?.matched) {
        out.push({
          tool,
          fixture,
          arrayPath: prefix ? `${prefix}.${aKey}` : aKey,
          stringPath: prefix ? `${prefix}.${sKey}` : sKey,
          value: sVal,
          synthesiser: derived.synthesiser,
        });
      }
    }
  }
  for (const [k, v] of entries) {
    findDerivablePairs(v, prefix ? `${prefix}.${k}` : k, tool, fixture, out);
  }
}

// ── Phase 4: cross-tool ───────────────────────────────────────────

function analyzeCrossTool(schemasByTool, captures) {
  // 4a: same-name-different-shape
  const nameIndex = buildNameIndex(schemasByTool);
  const shapeCollisions = findShapeCollisions(nameIndex);

  // 4b: value aliases on shared anchors
  const capturesByAnchor = {};
  for (const cap of captures) {
    if (!cap.anchor || cap.isError) continue;
    if (!capturesByAnchor[cap.anchor]) capturesByAnchor[cap.anchor] = [];
    capturesByAnchor[cap.anchor].push(cap);
  }
  const rawAliases = findValueAliases(capturesByAnchor);
  // Filter out aliases that are just the object number / title appearing
  // legitimately in every tool — characterise these by short common values
  // that resolve to the same conceptual identity carrier.
  const valueAliases = rawAliases
    .filter(a => {
      // Drop aliases whose value matches the anchor (objectNumber is expected
      // to appear in every tool's response for that anchor).
      if (a.value === a.anchor) return false;
      // Drop aliases where every occurrence uses the same final-segment name
      // (e.g. `objectNumber` always appears as `objectNumber` even at
      // different paths — not a renaming, just a shared identifier).
      const finalSegments = new Set(a.occurrences.map(o => o.path.split(".").pop()));
      if (finalSegments.size < 2) return false;
      return true;
    })
    .map(a => ({
      ...a,
      severity: severity({ bytesWasted: a.fullLength, callsPerDay: 1, classWeight: 1.4 }),
    }));
  valueAliases.sort((a, b) => b.severity - a.severity);

  return { shapeCollisions, valueAliases };
}

// ── Phase 5: render outputs ───────────────────────────────────────

function writeCsv(filePath, rows, columns) {
  const escape = v => {
    const s = String(v ?? "");
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [columns.join(",")];
  for (const r of rows) lines.push(columns.map(c => escape(r[c])).join(","));
  fs.writeFileSync(filePath, lines.join("\n"));
}

function exportFindings(outDir, allFindings) {
  const flat = [];
  for (const f of allFindings.shapeCollisions) {
    flat.push({
      class: "A_shape_collision",
      tool: f.occurrences.map(o => o.tool).join("|"),
      field: f.name,
      detail: `kinds=${f.kinds.join(",")}`,
      severity: 80,
    });
  }
  for (const f of allFindings.valueAliases) {
    flat.push({
      class: "B_value_alias",
      tool: f.occurrences.map(o => o.tool).join("|"),
      field: f.occurrences.map(o => o.path).join("|"),
      detail: f.value,
      severity: f.severity,
    });
  }
  for (const f of allFindings.deadBytes) {
    flat.push({
      class: "C_dead_bytes",
      tool: f.tool,
      field: f.path,
      detail: `bytes=${f.bytes} fixture=${f.fixture}`,
      severity: f.severity,
    });
  }
  for (const f of allFindings.intraDups) {
    flat.push({
      class: "D_intra_dup",
      tool: f.tool,
      field: f.path,
      detail: `${f.dup.blockCount}blocks ${(f.dup.overallRedundancy*100).toFixed(0)}%red ${f.dup.translationPairs}NL_EN`,
      severity: f.severity,
    });
  }
  for (const f of allFindings.derivables) {
    flat.push({
      class: "E_derivable",
      tool: f.tool,
      field: `${f.arrayPath}→${f.stringPath}`,
      detail: f.synthesiser,
      severity: 35,
    });
  }
  for (const f of allFindings.textOnly) {
    flat.push({
      class: "G_text_only",
      tool: f.tool,
      field: f.label,
      detail: `${f.valuePresentInStructured ? "derived_rendering" : "computed_only_in_text"} fixture=${f.fixture}`,
      severity: f.severity,
    });
  }
  writeCsv(path.join(outDir, "audit-findings.csv"), flat, ["class", "tool", "field", "detail", "severity"]);
}

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  const projectVersion = loadProjectVersion();
  const generatedAt = new Date().toISOString();

  if (!fs.existsSync(path.join(PROJECT_ROOT, "dist/index.js"))) {
    console.error("dist/index.js not found. Run `npm run build` first.");
    process.exit(1);
  }

  // Phase 1
  const { client, transport } = await connect();
  const { tools } = await client.listTools();
  const toolNames = new Set(tools.map(t => t.name));
  const schemasByTool = flattenAllSchemas(tools);
  const toolLimits = parseToolLimits();
  const modeFlags = detectModeFlags(tools);
  console.log(`[1/5] Schemas captured for ${tools.length} tools; ${Object.keys(toolLimits).length} TOOL_LIMITS entries; ${Object.keys(modeFlags).length} tools with mode flags`);
  fs.writeFileSync(path.join(OUT_DIR, "audit-schemas.json"), JSON.stringify({ generatedAt, tools: schemasByTool }, null, 2));

  // Phase 1b
  console.log("[1b/5] Building helper call graph from src/…");
  const helperRecordsAll = buildHelperGraph();
  const helperRecords = flagSharedHelpers(helperRecordsAll);
  console.log(`[1b/5] ${helperRecordsAll.length} helpers found, ${helperRecords.length} shared`);

  // Phase 2
  const { captures, failures } = await captureAll(client, FIXTURES, toolNames);
  console.log(`[2/5] Captured ${captures.length} responses, ${failures.length} failures`);

  // Close client now that capture is done
  await client.close();
  await transport.close();

  // Phase 3
  console.log("[3/5] Analyzing per-response (byte budget, dead bytes, intra-dup, derivable)…");
  const perResponse = analyzePerResponse(captures);

  // Phase 4
  console.log("[4/5] Analyzing cross-tool (shape collisions, value aliases)…");
  const crossTool = analyzeCrossTool(schemasByTool, captures);

  const totalFindings =
    crossTool.shapeCollisions.length +
    crossTool.valueAliases.length +
    perResponse.deadBytes.length +
    perResponse.intraDups.length +
    perResponse.derivables.length +
    perResponse.textOnly.length;

  console.log(`[4/5] Findings: ${crossTool.shapeCollisions.length} shape, ${crossTool.valueAliases.length} alias, ${perResponse.deadBytes.length} dead, ${perResponse.intraDups.length} intra-dup, ${perResponse.derivables.length} derivable, ${perResponse.textOnly.length} text-only`);

  // Phase 5
  console.log("[5/5] Rendering HTML + CSV + JSON outputs…");
  const html = renderReport({
    generatedAt,
    projectVersion,
    totalFindings,
    schemasByTool,
    helperRecords,
    shapeCollisions: crossTool.shapeCollisions,
    valueAliases: crossTool.valueAliases,
    deadBytes: perResponse.deadBytes,
    intraDups: perResponse.intraDups,
    derivables: perResponse.derivables,
    textOnly: perResponse.textOnly,
    bytesByTool: perResponse.bytesByTool,
    toolLimits,
    modeFlags,
    captureFailures: failures,
    skippedTools: SKIPPED_TOOLS,
  });
  fs.writeFileSync(path.join(OUT_DIR, "audit-report.html"), html);
  exportFindings(OUT_DIR, {
    shapeCollisions: crossTool.shapeCollisions,
    valueAliases: crossTool.valueAliases,
    deadBytes: perResponse.deadBytes,
    intraDups: perResponse.intraDups,
    derivables: perResponse.derivables,
    textOnly: perResponse.textOnly,
  });

  console.log(`\nDone. Outputs in: ${path.relative(PROJECT_ROOT, OUT_DIR)}/`);
  console.log("  - audit-report.html");
  console.log("  - audit-findings.csv");
  console.log("  - audit-schemas.json");
  console.log("  - responses/*.json");
}

main().catch(err => {
  console.error("Audit failed:", err);
  process.exit(1);
});
