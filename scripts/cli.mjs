#!/usr/bin/env node
/**
 * Headless CLI over the Rijksmuseum MCP server's stateless tools (issue #368).
 *
 * This is an MCP *client* — it drives the existing server, so a CLI query and an
 * LLM query return identical results (it also doubles as a debug/regression harness).
 * There is NO second implementation of search logic here.
 *
 * Transport (one `invoke()` seam, two backends):
 *   --http <url>         StreamableHTTP against a running `npm run serve` / Railway (warm → instant).
 *   (default)            stdio-subprocess: spawns `node dist/index.js` (zero-config; needs dist/ + DBs).
 *
 * Output is JSON-first for agent/pipeline use:
 *   default   list tools → JSONL on stdout; single-object tools → one compact JSON object.
 *   --json    print the entire structuredContent as one pretty JSON object (verbatim).
 *   --table   terse human table (opt-in).
 *   --fields  a,b,c   top-level key projection (the biggest token lever).
 *   counts + pagination hints + warnings go to STDERR (keeps stdout pure JSONL).
 *
 * Exit codes:  0 ok · 1 tool/connection error · 2 usage error.
 *
 * Examples:
 *   node scripts/cli.mjs search --query "tulip" --max 5 --fields objectNumber,title
 *   node scripts/cli.mjs details SK-C-5 --json
 *   node scripts/cli.mjs inspect SK-C-5 --region "pct:40,40,20,20" --out /tmp/crop.jpg
 *   node scripts/cli.mjs --http http://localhost:3000/mcp semantic "ships in a storm"
 *   node scripts/cli.mjs tools --json
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import path from "node:path";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Bad input the user can fix (e.g. malformed --textQuery JSON) → exit 2, not 1.
class UsageError extends Error {}

// ── Verb → tool table (presentation metadata only; schemas come from listTools) ──
// `pos`  = which input param the first positional maps to.
// `list` = key in structuredContent holding the result array (list tools).
// `total`= key holding the count used for the pagination summary.
// `page` = "offset" (maxResults+offset) or "token" (resumptionToken).
const VERBS = {
  search:       { tool: "search_artwork",        pos: "query",        list: "results",  total: "totalResults",  page: "offset" },
  semantic:     { tool: "semantic_search",       pos: "query",        list: "results",  total: "returnedCount", page: "offset" },
  persons:      { tool: "search_persons",        pos: "name",         list: "persons",  total: "totalResults",  page: "offset" },
  provenance:   { tool: "search_provenance",     pos: "party",        list: "results",  total: "totalArtworks", page: "offset" },
  details:      { tool: "get_artwork_details",   pos: "objectNumber", single: true },
  stats:        { tool: "collection_stats",      pos: "dimension",    list: "entries",  total: "totalBuckets",  page: "offset" },
  similar:      { tool: "find_similar",          pos: "objectNumber", single: true },
  "browse-set": { tool: "browse_set",            pos: "setSpec",      list: "records",  total: "totalInSet",    page: "token" },
  "list-sets":  { tool: "list_curated_sets",                          list: "sets",     total: "totalSets" },
  changes:      { tool: "get_recent_changes",                         list: "records",  total: "totalChanges",  page: "token" },
  inspect:      { tool: "inspect_artwork_image", pos: "objectNumber", image: true },
};
const TOOL_TO_VERB = Object.fromEntries(Object.entries(VERBS).map(([v, c]) => [c.tool, v]));
const IN_SCOPE_TOOLS = new Set(Object.values(VERBS).map((c) => c.tool));
// Viewer/stateful tools depend on the iframe + viewerQueues — not usable over the CLI.
const VIEWER_TOOLS = new Set(["get_artwork_image", "navigate_viewer", "remount_viewer", "poll_viewer_commands"]);

// Global flags (consumed by the CLI, never forwarded as tool args).
const GLOBAL_BOOL = new Set(["json", "table", "quiet", "show-call", "help"]);
const GLOBAL_VALUE = new Set(["http", "fields", "out"]);
// Short/friendly flag aliases → canonical name.
const FLAG_ALIASES = { max: "maxResults", n: "maxResults", o: "out", h: "help" };

const MIME_EXT = { "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "image/tiff": ".tif" };

// ── Tiny arg tokenizer ────────────────────────────────────────────────────────
// parseArgs can't disambiguate `--flag value` from a boolean without a per-flag
// spec, and we only know booleans after listTools(). So we hand-roll: a flag is
// boolean if it's in `boolSet`; otherwise it consumes the next token as its value.
// `--key=value` always works; repeated keys collect into an array.
function tokenize(args, boolSet) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") { positionals.push(...args.slice(i + 1)); break; }
    if (!a.startsWith("--") && !(a.startsWith("-") && a.length === 2 && /[a-z]/i.test(a[1]))) {
      positionals.push(a);
      continue;
    }
    const dashless = a.replace(/^--?/, "");
    const eq = dashless.indexOf("=");
    let key, val;
    if (eq !== -1) {
      key = dashless.slice(0, eq);
      val = dashless.slice(eq + 1);
    } else {
      key = dashless;
    }
    key = FLAG_ALIASES[key] || key;
    if (val === undefined) {
      if (boolSet.has(key)) val = true;
      else { val = args[i + 1]; i++; }
    }
    if (key in flags) flags[key] = [].concat(flags[key], val);
    else flags[key] = val;
  }
  return { flags, positionals };
}

// ── JSON Schema → arg classification ────────────────────────────────────────────
function propType(prop) {
  if (!prop || typeof prop !== "object") return "string";
  if (prop.type === "array") return "array";
  if (prop.type === "integer" || prop.type === "number") return "number";
  if (prop.type === "boolean") return "boolean";
  // unions (e.g. transferType: string | string[]) → allow repeatable
  if (Array.isArray(prop.anyOf) && prop.anyOf.some((b) => b?.type === "array")) return "array";
  // Nested object params (e.g. the search_artwork.textQuery DSL) take a JSON literal:
  // --textQuery '{"must":[…]}' — parsed in coerce() before it goes on the wire.
  if (prop.type === "object") return "json";
  return "string";
}

function coerce(value, type, name) {
  if (type === "number") {
    const arr = [].concat(value).map(Number);
    return arr.length === 1 ? arr[0] : arr;
  }
  if (type === "boolean") {
    const toBool = (v) => v === true || v === "true" || v === "1";
    const arr = [].concat(value).map(toBool);
    return arr.length === 1 ? arr[0] : arr;
  }
  if (type === "array") return [].concat(value);
  if (type === "json") {
    if (typeof value !== "string") throw new UsageError(`--${name} expects a single JSON object (pass it once)`);
    try { return JSON.parse(value); }
    catch (e) { throw new UsageError(`--${name} expects a JSON object (e.g. '{"must":[{"field":"title","phrase":"tulip"}]}') — ${e.message}`); }
  }
  return value;
}

// Build the boolean-flag set for a tool from its inputSchema + globals.
function boolSetFor(schema) {
  const s = new Set(GLOBAL_BOOL);
  const props = schema?.properties ?? {};
  for (const [name, prop] of Object.entries(props)) {
    if (propType(prop) === "boolean") s.add(name);
  }
  return s;
}

// Map tokenized flags + positionals → tool arguments (coerced per schema).
function buildToolArgs(verbCfg, schema, flags, positionals) {
  const props = schema?.properties ?? {};
  const args = {};
  for (const [key, raw] of Object.entries(flags)) {
    if (GLOBAL_BOOL.has(key) || GLOBAL_VALUE.has(key)) continue;
    args[key] = coerce(raw, propType(props[key]), key);
  }
  // First positional → the verb's primary param (if the flag wasn't already set).
  if (positionals.length && verbCfg.pos && args[verbCfg.pos] === undefined) {
    args[verbCfg.pos] = coerce(positionals[0], propType(props[verbCfg.pos]), verbCfg.pos);
  }
  return args;
}

// ── Transport / connection ───────────────────────────────────────────────────
async function connect(httpUrl) {
  const transport = httpUrl
    ? new StreamableHTTPClientTransport(new URL(httpUrl))
    : new StdioClientTransport({
        command: "node",
        args: ["dist/index.js"],
        cwd: PROJECT_ROOT,
        // Force structured output on, and skip the ~13s eager warm-up (lazy on first use).
        env: { ...process.env, STRUCTURED_CONTENT: "true", MCP_SKIP_STARTUP_WARM: "1" },
      });
  const client = new Client({ name: "rijks-cli", version: "0.1" });
  await client.connect(transport);
  return client;
}

// ── Result helpers ─────────────────────────────────────────────────────────────
const textOf = (res) => (res.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
const imageOf = (res) => (res.content ?? []).find((c) => c.type === "image");

function project(obj, fields) {
  if (!fields || !obj || typeof obj !== "object") return obj;
  const out = {};
  for (const f of fields) if (f in obj) out[f] = obj[f];
  return out;
}

function renderTable(rows, fields) {
  if (!rows.length) return "(no results)";
  const cols = (fields && fields.length ? fields : Object.keys(rows[0]).filter((k) => {
    const v = rows[0][k];
    return v == null || typeof v !== "object";
  })).slice(0, 6);
  const cell = (v) => {
    if (v == null) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return s.length > 40 ? s.slice(0, 37) + "…" : s;
  };
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => cell(r[c]).length)));
  const fmt = (vals) => vals.map((v, i) => String(v).padEnd(widths[i])).join("  ");
  const lines = [fmt(cols), fmt(widths.map((w) => "-".repeat(w)))];
  for (const r of rows) lines.push(fmt(cols.map((c) => cell(r[c]))));
  return lines.join("\n");
}

function paginationSummary(verbCfg, data, list, flags) {
  const parts = [];
  if (verbCfg.page === "offset") {
    const offset = Number(flags.offset ?? 0) || 0;
    const total = verbCfg.total ? data[verbCfg.total] : undefined;
    if (typeof total === "number") {
      parts.push(`${list.length} shown (offset ${offset}) of ${total}`);
      if (offset + list.length < total) parts.push(`pass --offset ${offset + list.length} for more`);
    } else {
      parts.push(`${list.length} shown (offset ${offset})`);
    }
  } else if (verbCfg.page === "token") {
    const total = verbCfg.total ? data[verbCfg.total] : undefined;
    parts.push(`${list.length} shown${typeof total === "number" ? ` of ${total}` : ""}`);
    if (data.resumptionToken) parts.push(`pass --resumption-token ${data.resumptionToken} for more`);
  } else {
    parts.push(`${list.length} shown`);
  }
  return parts.join("; ");
}

// ── Output rendering ─────────────────────────────────────────────────────────
function renderResult(res, verbCfg, flags) {
  const fields = flags.fields ? String(flags.fields).split(",").map((s) => s.trim()).filter(Boolean) : null;
  const data = res.structuredContent ?? safeParseJson(textOf(res));
  const quiet = flags.quiet === true;
  const emitWarnings = () => {
    if (!quiet && Array.isArray(data?.warnings) && data.warnings.length) {
      process.stderr.write("warnings: " + data.warnings.join(" | ") + "\n");
    }
  };

  // Image tool — write bytes to --out, never dump base64 to stdout.
  if (verbCfg.image) {
    const img = imageOf(res);
    if (flags.out && img) {
      let out = String(flags.out);
      if (!path.extname(out)) out += MIME_EXT[img.mimeType] ?? ".bin";
      writeFileSync(out, Buffer.from(img.data, "base64"));
      if (!quiet) process.stderr.write(`Wrote ${out} (${img.mimeType})\n`);
    } else if (img && !quiet) {
      process.stderr.write(`Image bytes available (${img.mimeType}); pass --out <file> to save them.\n`);
    }
    process.stdout.write(JSON.stringify(project(data ?? {}, fields)) + "\n");
    return;
  }

  if (!data || typeof data !== "object") {
    // No structuredContent (e.g. STRUCTURED_CONTENT=false on a remote --http server).
    process.stdout.write(textOf(res) + "\n");
    return;
  }

  // --json: full structuredContent verbatim (pretty), no list-splitting/projection.
  if (flags.json === true) {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
    emitWarnings();
    return;
  }

  // Single-object tools (details, find_similar) → one compact JSON object.
  if (verbCfg.single) {
    if (flags.table === true) process.stdout.write(renderTable([flatten(data)], fields) + "\n");
    else process.stdout.write(JSON.stringify(project(data, fields)) + "\n");
    emitWarnings();
    return;
  }

  // List tools → JSONL (default) or table.
  const listKey = verbCfg.list ?? Object.keys(data).find((k) => Array.isArray(data[k]));
  const list = Array.isArray(data[listKey]) ? data[listKey] : [];
  if (flags.table === true) {
    process.stdout.write(renderTable(list.map((r) => project(r, fields)), fields) + "\n");
  } else {
    for (const row of list) process.stdout.write(JSON.stringify(project(row, fields)) + "\n");
  }
  if (!quiet) process.stderr.write(paginationSummary(verbCfg, data, list, flags) + "\n");
  emitWarnings();
}

// Shallow-flatten an object for table display (drops nested objects/arrays).
function flatten(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v == null || typeof v !== "object") out[k] = v;
  }
  return out;
}

function safeParseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// ── Help / discovery ─────────────────────────────────────────────────────────
function topUsage(toolMap) {
  const lines = [
    "rijks-cli — headless CLI over the Rijksmuseum MCP tools",
    "",
    "Usage: rijks-cli [--http <url>] <command> [args] [flags]",
    "       rijks-cli tools [--json]        list tool capabilities",
    "       rijks-cli <command> --help      flags for one command",
    "",
    "Commands:",
  ];
  for (const [verb, cfg] of Object.entries(VERBS)) {
    const desc = (toolMap.get(cfg.tool)?.description ?? "").split("\n")[0].slice(0, 80);
    lines.push(`  ${verb.padEnd(12)} ${cfg.tool.padEnd(22)} ${desc}`);
  }
  lines.push(
    "",
    "Output:  default JSONL (lists) / compact JSON (single) on stdout; counts+paging on stderr.",
    "Flags:   --json (full payload) · --table · --fields a,b,c · --out <file> (inspect) · --quiet · --show-call",
    "Exit:    0 ok · 1 tool/connection error · 2 usage error",
  );
  return lines.join("\n");
}

function verbHelp(verb, cfg, tool) {
  const props = tool?.inputSchema?.properties ?? {};
  const required = new Set(tool?.inputSchema?.required ?? []);
  const lines = [`${verb} → ${cfg.tool}`, ""];
  if (tool?.description) lines.push(tool.description.split("\n")[0], "");
  if (cfg.pos) lines.push(`Positional: <${cfg.pos}>  (first positional maps to --${cfg.pos})`, "");
  lines.push("Flags:");
  for (const [name, prop] of Object.entries(props)) {
    const t = propType(prop);
    const req = required.has(name) ? " (required)" : "";
    const desc = (prop?.description ?? "").split("\n")[0].slice(0, 80);
    lines.push(`  --${name} <${t}>${req}  ${desc}`);
  }
  if (cfg.image) lines.push("  --out <file>  write the image bytes to disk");
  return lines.join("\n");
}

function toolsDump(toolMap, asJson) {
  const tools = [...IN_SCOPE_TOOLS].map((name) => {
    const t = toolMap.get(name);
    return { name, verb: TOOL_TO_VERB[name], description: t?.description, inputSchema: t?.inputSchema, outputSchema: t?.outputSchema };
  });
  if (asJson) return JSON.stringify(tools, null, 2);
  return tools.map((t) => `${t.verb.padEnd(12)} ${t.name}`).join("\n");
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);

  // Pre-scan for the transport URL + the verb. We can't classify every flag's
  // value-arity before listTools(), but we only need to skip the global value
  // flags (--http/--fields/--out) in space-form to find the first bare token.
  let httpUrl = process.env.RIJKS_MCP_HTTP || null;
  let verb;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--http") { httpUrl = argv[i + 1]; i++; continue; }
    if (a.startsWith("--http=")) { httpUrl = a.slice("--http=".length); continue; }
    if (a.startsWith("-")) {
      const key = a.replace(/^--?/, "").split("=")[0];
      if (GLOBAL_VALUE.has(key) && !a.includes("=")) i++; // skip its value
      continue;
    }
    if (verb === undefined) verb = a;
  }

  // Bare help (no server needed for the static frame; we still enrich from listTools when possible).
  const wantsHelp = argv.includes("--help") || argv.includes("-h") || verb === "help" || argv.length === 0;

  let client;
  try {
    client = await connect(httpUrl);
  } catch (err) {
    process.stderr.write(`Connection failed: ${err?.message ?? err}\n`);
    if (!httpUrl) process.stderr.write("Hint: run `npm run build` and ensure data/ DBs exist, or use --http <url>.\n");
    process.exitCode = 1;
    return;
  }

  try {
    const listed = await client.listTools();
    const toolMap = new Map(listed.tools.map((t) => [t.name, t]));

    if (wantsHelp && (verb === "help" || verb === undefined)) {
      process.stdout.write(topUsage(toolMap) + "\n");
      return;
    }
    if (verb === "tools") {
      const asJson = argv.includes("--json");
      process.stdout.write(toolsDump(toolMap, asJson) + "\n");
      return;
    }

    const cfg = VERBS[verb];
    if (!cfg) {
      const hint = VIEWER_TOOLS.has(verb) ? " (viewer/stateful tool — not available over the CLI)" : "";
      process.stderr.write(`Unknown command: ${verb ?? "(none)"}${hint}\n\n${topUsage(toolMap)}\n`);
      process.exitCode = 2;
      return;
    }

    const tool = toolMap.get(cfg.tool);
    if (!tool) {
      process.stderr.write(`Tool ${cfg.tool} is not available on this server (feature-gated?).\n`);
      process.exitCode = 1;
      return;
    }

    if (argv.includes("--help") || argv.includes("-h")) {
      process.stdout.write(verbHelp(verb, cfg, tool) + "\n");
      return;
    }

    // Re-tokenize using the tool's schema, dropping the verb itself from positionals.
    const boolSet = boolSetFor(tool.inputSchema);
    const { flags, positionals } = tokenize(argv, boolSet);
    // The verb is always the first bare token; drop it so the rest map to tool params.
    const restPositionals = positionals[0] === verb ? positionals.slice(1) : positionals;
    const toolArgs = buildToolArgs(cfg, tool.inputSchema, flags, restPositionals);

    if (flags["show-call"] === true) {
      process.stdout.write(JSON.stringify({ tool: cfg.tool, arguments: toolArgs }, null, 2) + "\n");
      return;
    }

    const res = await client.callTool({ name: cfg.tool, arguments: toolArgs });
    if (res.isError) {
      process.stderr.write(textOf(res) + "\n");
      process.exitCode = 1;
      return;
    }
    renderResult(res, cfg, flags);
  } catch (err) {
    process.stderr.write(`Error: ${err?.message ?? err}\n`);
    process.exitCode = err instanceof UsageError ? 2 : 1;
  } finally {
    await client.close().catch(() => {});
  }
}

main();
