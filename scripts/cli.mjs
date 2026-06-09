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
 *   node scripts/cli.mjs tools --compact          # compact capability manifest (agent bootstrap)
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
  inscriptions: { tool: "search_inscriptions",   pos: "text",         list: "results",  total: "totalConfirmed", page: "offset" },
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

// Curated help copy (authored one-liners + a worked example per verb). Kept here, not derived
// from tool descriptions — those clip mid-word and read as fragments. The per-command *flag* list
// stays schema-derived (always current); only this prose framing is hand-written.
const VERB_HELP = {
  search:       { summary: "Structured metadata search — filter by creator, type, subject, place, date (all combine, AND).",
                  example: `rijks-mcp search --creator "Rembrandt van Rijn" --type painting --max 5 --fields objectNumber,title` },
  semantic:     { summary: "Meaning/concept search over reconstructed text; natural-language queries, ranked by similarity.",
                  example: `rijks-mcp semantic "ships in a stormy sea" --max 5 --fields objectNumber,title,similarityScore` },
  persons:      { summary: "Look up people/groups; returns vocabIds to feed search --creator (by) or --aboutActor (depicting).",
                  example: `rijks-mcp persons "Vermeer" --max 3 --fields vocabId,label,artworkCount` },
  provenance:   { summary: "Search parsed ownership history — party, transfer type, location, date/price range, gaps.",
                  example: `rijks-mcp provenance --party "Six" --max 5 --fields objectNumber,title` },
  inscriptions: { summary: "Structured inscription search — collector's marks, signatures, transcribed on-object text; facet by type/placement/technique.",
                  example: `rijks-mcp inscriptions --transcribedText "Rembrandt" --max 5 --fields objectNumber,title` },
  details:      { summary: "Full metadata for one artwork by object number (single-object output).",
                  example: `rijks-mcp details SK-C-5 --fields objectNumber,title,creator,date` },
  stats:        { summary: "Aggregate counts across a dimension (type, decade, creator, place…). Cap with --topN, not --max.",
                  example: `rijks-mcp stats type --topN 10 --fields label,count --table` },
  similar:      { summary: "Artwork-to-artwork similarity across 9 signal channels plus a pooled consensus.",
                  example: `rijks-mcp similar SK-C-5 --max 10 --json | jq '.modes.visual'` },
  "browse-set": { summary: "Enumerate the members of one curated set (token pagination).",
                  example: `rijks-mcp browse-set 2619 --max 5 --fields objectNumber,title` },
  "list-sets":  { summary: "Discover curated sets; filter by --query/--minMembers/--maxMembers (no --max).",
                  example: `rijks-mcp list-sets --query Rembrandt --fields setSpec,name,memberCount` },
  changes:      { summary: "Recent additions/modifications by date range; --identifiersOnly for light headers (token paging).",
                  example: `rijks-mcp changes --from 2024-01-01 --identifiersOnly --max 5` },
  inspect:      { summary: "Fetch an image region as bytes for visual analysis; --out <file> saves them to disk.",
                  example: `rijks-mcp inspect SK-C-5 --region "pct:40,40,15,15" --out crop.jpg` },
};
// Invariant: every verb has curated help. Catches a verb added to VERBS but not VERB_HELP at load,
// instead of as a silent blank summary in --help. (Lets the help renderers drop defensive fallbacks.)
for (const v of Object.keys(VERBS)) {
  if (!VERB_HELP[v]?.summary) throw new Error(`VERB_HELP is missing a summary for verb "${v}"`);
}

// Global flags (consumed by the CLI, never forwarded as tool args). NB: `--compact` is NOT here
// on purpose — it's only meaningful on the `tools` verb (handled by argv inspection before
// tokenize), and search_artwork has its own `compact` param we must forward, not shadow.
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
  const client = new Client({ name: "rijks-mcp", version: "0.1" });
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
// Fully static — no toolMap, no connection. Curated command summaries + flag/transport blocks.
function topUsage() {
  const lines = [
    "rijks-mcp — headless CLI over the Rijksmuseum MCP tools",
    "",
    "Usage: rijks-mcp [--http <url>] <command> [args] [flags]",
    "       rijks-mcp tools [--compact|--json]   list tool capabilities (compact = agent bootstrap)",
    "       rijks-mcp <command> --help           flags + an example for one command",
    "",
    "Commands:",
  ];
  for (const verb of Object.keys(VERBS)) {
    lines.push(`  ${verb.padEnd(11)} ${VERB_HELP[verb].summary}`);
  }
  lines.push(
    "",
    "Common flags:",
    "  --http <url>     target a running server (else stdio-spawns dist/index.js); env: RIJKS_MCP_HTTP",
    "  --fields a,b,c   project to these top-level keys on every row (biggest token saver)",
    "  --max N  (-n)    result cap → maxResults  (stats caps with --topN; list-sets has none)",
    "  --json           full structuredContent payload, pretty-printed",
    "  --table          terse human-readable table",
    "  --quiet          suppress the stderr count/summary line",
    "  --show-call      print the resolved {tool, arguments} WITHOUT executing (cheap dry-run)",
    "",
    "Transports:",
    "  HTTP (recommended): --http <url> or RIJKS_MCP_HTTP — a warm server; every call is instant.",
    "  stdio (default):    no --http; spawns `node dist/index.js` — needs `npm run build` + DBs in data/.",
    "",
    "Output:  list tools → JSONL · single-object tools → one compact JSON · counts+paging → stderr.",
    "Exit:    0 ok · 1 tool/connection error · 2 usage error",
  );
  return lines.join("\n");
}

// First line of a description, truncated on a word boundary (no mid-word cuts) with an ellipsis.
function clip(text, n) {
  const s = (text ?? "").split("\n")[0];
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const sp = cut.lastIndexOf(" ");
  return (sp > 0 ? cut.slice(0, sp) : cut) + "…";
}

// Surface a flag's allowed values (string enum or array-of-enum); inline if short, else punt.
function enumValues(prop) {
  const vals = Array.isArray(prop?.enum) ? prop.enum
    : Array.isArray(prop?.items?.enum) ? prop.items.enum
    : null;
  if (!vals || !vals.length) return null;
  const joined = vals.map(String).join("|");
  return joined.length <= 60 ? `{${joined}}` : `{${vals.length} values — see \`tools --json\`}`;
}

// Per-command help. With a live `tool` (server reachable): curated summary + schema-derived flag
// list (enums + the --max alias) + a worked example. Without one (`tool` null, no server): the
// curated summary + positional + example, plus a hint for getting the full flag list.
function verbHelp(verb, cfg, tool) {
  const meta = VERB_HELP[verb];
  const lines = [`${verb} → ${cfg.tool}`, "", meta.summary, ""];
  if (cfg.pos) lines.push(`Positional: <${cfg.pos}>  (first positional maps to --${cfg.pos})`, "");
  if (tool) {
    const props = tool.inputSchema?.properties ?? {};
    const required = new Set(tool.inputSchema?.required ?? []);
    lines.push("Flags:");
    for (const [name, prop] of Object.entries(props)) {
      const req = required.has(name) ? " (required)" : "";
      const desc = clip(prop?.description, 90);
      const enums = enumValues(prop);
      lines.push(`  --${name} <${propType(prop)}>${req}  ${desc}${enums ? "  " + enums : ""}`);
    }
    if (cfg.image) lines.push("  --out <file>  write the image bytes to disk");
    if ("maxResults" in props) lines.push("", "Aliases:  --max, -n  → maxResults");
  }
  if (meta.example) lines.push("", "Example:", "  " + meta.example);
  if (!tool) lines.push(
    "",
    "(The full flag list is schema-derived and needs a server. Start one with `npm run serve` and",
    " pass `--http <url>`, or build locally — `npm run build` + DBs in data/ — then re-run this.)",
  );
  return lines.join("\n");
}

// Static help for the built-in `tools` command (advertised in topUsage). Describes the three
// output modes; like the other help paths it renders without connecting to a server.
function toolsHelp() {
  return [
    "tools — list the in-scope tool capabilities (introspection; not a real tool call)",
    "",
    "Usage: rijks-mcp tools [--compact|--json]",
    "",
    "  (default)   verb → tool-name table",
    "  --compact   compact capability manifest (agent bootstrap): one entry per tool —",
    "              verb, tool, positional, result shape, paging, args as name→type (`!` = required)",
    "  --json      full input + output JSON Schema per tool (deep introspection)",
    "",
    "All three read the live schema, so they need a server: --http <url>, or a built dist/ + DBs in data/.",
  ].join("\n");
}

function toolsDump(toolMap, asJson) {
  const tools = [...IN_SCOPE_TOOLS].map((name) => {
    const t = toolMap.get(name);
    return { name, verb: TOOL_TO_VERB[name], description: t?.description, inputSchema: t?.inputSchema, outputSchema: t?.outputSchema };
  });
  if (asJson) return JSON.stringify(tools, null, 2);
  return tools.map((t) => `${t.verb.padEnd(12)} ${t.name}`).join("\n");
}

// Compact capability manifest for agent bootstrap — verb, tool, positional, result
// shape, paging, and arg names→types only (no descriptions or full JSON Schemas). A
// trailing "!" marks a required arg. Orders of magnitude cheaper than `tools --json`.
function toolsCompact(toolMap) {
  return [...IN_SCOPE_TOOLS].map((name) => {
    const verb = TOOL_TO_VERB[name];
    const cfg = VERBS[verb];
    const schema = toolMap.get(name)?.inputSchema;
    const required = new Set(schema?.required ?? []);
    const args = {};
    for (const [k, prop] of Object.entries(schema?.properties ?? {})) {
      args[k] = propType(prop) + (required.has(k) ? "!" : "");
    }
    const result = cfg.single ? "single" : cfg.image ? "image" : (cfg.list ?? null);
    const entry = { verb, tool: name, positional: cfg.pos ?? null, result, args };
    if (cfg.page) entry.page = cfg.page;
    return entry;
  });
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

  const wantsHelp = argv.includes("--help") || argv.includes("-h") || verb === "help" || argv.length === 0;
  const isTopHelp = wantsHelp && (verb === "help" || verb === undefined);

  // Top-level help is fully static — render it WITHOUT connecting (offline-safe + instant, even
  // with a stale RIJKS_MCP_HTTP or no built dist/+DBs). Only schema-derived per-command help and
  // real tool calls touch the server.
  if (isTopHelp) {
    process.stdout.write(topUsage() + "\n");
    return;
  }

  // `tools` is a built-in (not in VERBS) but advertised in the usage — its --help is static too.
  if (wantsHelp && verb === "tools") {
    process.stdout.write(toolsHelp() + "\n");
    return;
  }

  const cfg = VERBS[verb];
  // Unknown command (and not the built-in `tools`) is a static usage error — no server needed.
  if (!cfg && verb !== "tools") {
    const hint = VIEWER_TOOLS.has(verb) ? " (viewer/stateful tool — not available over the CLI)" : "";
    process.stderr.write(`Unknown command: ${verb ?? "(none)"}${hint}\n\n${topUsage()}\n`);
    process.exitCode = 2;
    return;
  }
  const isVerbHelp = wantsHelp && !!cfg; // `<command> --help`

  let client;
  try {
    client = await connect(httpUrl);
  } catch (err) {
    // Per-command help degrades to static verb info + a hint when no server is reachable.
    if (isVerbHelp) {
      process.stdout.write(verbHelp(verb, cfg, null) + "\n");
      return;
    }
    process.stderr.write(`Connection failed: ${err?.message ?? err}\n`);
    if (!httpUrl) process.stderr.write("Hint: run `npm run build` and ensure data/ DBs exist, or use --http <url>.\n");
    process.exitCode = 1;
    return;
  }

  try {
    const listed = await client.listTools();
    const toolMap = new Map(listed.tools.map((t) => [t.name, t]));

    if (verb === "tools") {
      if (argv.includes("--compact")) {
        process.stdout.write(JSON.stringify(toolsCompact(toolMap), null, 2) + "\n");
      } else {
        process.stdout.write(toolsDump(toolMap, argv.includes("--json")) + "\n");
      }
      return;
    }

    const tool = toolMap.get(cfg.tool);
    if (!tool) {
      process.stderr.write(`Tool ${cfg.tool} is not available on this server (feature-gated?).\n`);
      process.exitCode = 1;
      return;
    }

    if (isVerbHelp) {
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
