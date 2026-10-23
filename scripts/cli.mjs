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
 *   --stdin   batch: read the primary positional from stdin, one invocation per line.
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
// `page` = "offset" (maxResults+offset), "token" (resumptionToken) or "full" (first few, --full for all).
// `cap` = the tool's result-cap param that --max/-n resolves to; absent → --max is a usage error.
// `alt` = list key the tool fills instead of `list` in some modes (search compact, provenance credit lines).
// `aside` = top-level keys outside the rows, which neither JSONL nor --fields can reach.
const VERBS = {
  search:       { tool: "search_artwork",        pos: "query",        list: "results",  total: "totalResults",  page: "offset", cap: "maxResults", alt: "ids", aside: ["facets"] },
  semantic:     { tool: "semantic_search",       pos: "query",        list: "results",  total: "returnedCount", page: "offset", cap: "maxResults" },
  multimodal:   { tool: "multimodal_search",     pos: "query",        list: "results",  total: "returnedCount", page: "offset", cap: "maxResults" },
  persons:      { tool: "search_persons",        pos: "name",         list: "persons",  total: "totalResults",  page: "offset", cap: "maxResults" },
  provenance:   { tool: "search_provenance",     pos: "party",        list: "results",  total: "totalArtworks", page: "offset", cap: "maxResults", alt: "creditLineResults", aside: ["facets"] },
  inscriptions: { tool: "search_inscriptions",   pos: "text",         list: "results",  total: "totalConfirmed", page: "offset", cap: "maxResults" },
  details:      { tool: "get_artwork_details",   pos: "objectNumber", single: true },
  conservation: { tool: "get_conservation_history", pos: "objectNumber", single: true },
  bibliography: { tool: "get_artwork_bibliography", pos: "objectNumber", list: "entries", total: "total", page: "full" },
  citing:       { tool: "find_artworks_citing_publication", pos: "publication", list: "artworks", total: "total", page: "full" },
  stats:        { tool: "collection_stats",      pos: "dimension",    list: "entries",  total: "totalBuckets",  page: "offset", cap: "topN" },
  similar:      { tool: "find_similar",          pos: "objectNumber", single: true, cap: "maxResults" },
  "browse-set": { tool: "browse_set",            pos: "setSpec",      list: "records",  total: "totalInSet",    page: "token", cap: "maxResults" },
  "list-sets":  { tool: "list_curated_sets",                          list: "sets",     total: "totalSets" },
  changes:      { tool: "get_recent_changes",                         list: "records",  total: "totalChanges",  page: "token", cap: "maxResults" },
  inspect:      { tool: "inspect_artwork_image", pos: "objectNumber", image: true },
};
const TOOL_TO_VERB = Object.fromEntries(Object.entries(VERBS).map(([v, c]) => [c.tool, v]));
const IN_SCOPE_TOOLS = new Set(Object.values(VERBS).map((c) => c.tool));
// Viewer/stateful tools depend on the iframe + viewerQueues — not usable over the CLI.
const VIEWER_TOOLS = new Set(["get_artwork_image", "navigate_viewer", "remount_viewer", "poll_viewer_commands"]);

// Curated help copy (authored one-liners + a worked example per verb), kept CLI-tailored: each
// summary echoes the tool's front-loaded description lead (#392) but adds terminal-specific flag
// and pagination hints the MCP descriptions don't carry. The per-command *flag* list stays
// schema-derived (always current); only this prose framing is hand-written.
const VERB_HELP = {
  search:       { summary: "Structured filter search — artworks matching ALL given filters (creator, type, subject, place, date; combine, AND).",
                  example: `rijks-mcp search --creator "Rembrandt van Rijn" --type painting --max 5 --fields objectNumber,title` },
  semantic:     { summary: "Free-text concept search by embedding similarity; natural-language queries ranked over reconstructed text.",
                  example: `rijks-mcp semantic "ships in a stormy sea" --max 5 --fields objectNumber,title,similarityScore` },
  multimodal:   { summary: "Find artworks by what they show — metadata, image and Iconclass channels fused, with per-channel ranks.",
                  example: `rijks-mcp multimodal "red umbrella in the rain" --max 5 --fields objectNumber,title,matchedBy` },
  persons:      { summary: "Demographic/structural lookup of people/groups; returns vocabIds to feed search --creator (by) or --aboutActor (depicting).",
                  example: `rijks-mcp persons "Vermeer" --max 3 --fields vocabId,label,artworkCount` },
  provenance:   { summary: "Ownership-history search across parsed provenance — party, transfer type, location, date/price range, gaps.",
                  example: `rijks-mcp provenance --party "Six" --max 5 --fields objectNumber,title` },
  inscriptions: { summary: "Structured search over inscriptions — collector's marks, signatures, transcribed on-object text; facet by type/placement/technique.",
                  example: `rijks-mcp inscriptions --transcribedText "Rembrandt" --max 5 --fields objectNumber,title` },
  details:      { summary: "Full metadata for ONE artwork by object number — creator, dates, materials, provenance, inscriptions, related objects.",
                  example: `rijks-mcp details SK-C-5 --fields objectNumber,title,creator,date` },
  conservation: { summary: "Conservation/forensics for one artwork by object number — technical examinations, restoration treatments, mark counts.",
                  example: `rijks-mcp conservation SK-C-5 --json | jq '.examinations'` },
  bibliography: { summary: "Scholarly references for one artwork by object number — citations with linked publication, pages, ISBN.",
                  example: `rijks-mcp bibliography SK-C-5 --fields sequence,citation` },
  citing:       { summary: "Reverse bibliography — artworks whose references cite a publication (by URI or id); complement of bibliography.",
                  example: `rijks-mcp citing 30189730 --full --fields objectNumber,creator` },
  stats:        { summary: "Group-by breakdown over one dimension (type, decade, creator, place…) — counts/percentages per bucket.",
                  example: `rijks-mcp stats type --max 10 --fields label,count --table` },
  similar:      { summary: "Given one object number, finds others like it across 9 signal channels plus a pooled consensus.",
                  example: `rijks-mcp similar SK-C-5 --max 10 --json | jq '.modes.visual'` },
  "browse-set": { summary: "Enumerate the member artworks of one curated set by setSpec (token pagination).",
                  example: `rijks-mcp browse-set 2619 --max 5 --fields objectNumber,title` },
  "list-sets":  { summary: "Browse curated sets — thematic/sub-collection groupings; filter by --query/--minMembers/--maxMembers.",
                  example: `rijks-mcp list-sets --query Rembrandt --fields setSpec,name,memberCount` },
  changes:      { summary: "OAI-PMH delta feed — records changed in a date range; --identifiersOnly for light headers (token paging).",
                  example: `rijks-mcp changes --from 2024-01-01 --identifiersOnly --max 5` },
  inspect:      { summary: "Image region as bytes for visual analysis; --out <file> saves them to disk.",
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
const GLOBAL_BOOL = new Set(["json", "table", "quiet", "show-call", "help", "stdin"]);
const GLOBAL_VALUE = new Set(["http", "fields", "out"]);
// Short/friendly flag aliases → canonical name. `max` is resolved per verb to cfg.cap
// in buildToolArgs (maxResults for most tools, topN for stats).
const FLAG_ALIASES = { n: "max", o: "out", h: "help" };
// Value-taking flags to skip (with their value) during the pre-scan for the verb.
const PRESCAN_VALUE = new Set([...GLOBAL_VALUE, "max"]);

const MIME_EXT = { "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "image/tiff": ".tif" };

// Flag-shaped token: long (`--json`) or short (`-n`). A negative number (`-4.9`) is not.
const isFlagLike = (t) => t.startsWith("--") || (t.startsWith("-") && t.length === 2 && /[a-z]/i.test(t[1]));

// The commonest flag slip is punctuation or case, not spelling: `--resumption_token`.
function nearestFlag(key, candidates) {
  const squash = (s) => s.replace(/[-_]/g, "").toLowerCase();
  return [...candidates].find((c) => c !== key && squash(c) === squash(key)) || null;
}

// The one "no such flag" message, shared by the tokenizer (a value-less typo) and
// validateToolArgs (`--typo value`), so a mistake reads the same in either form.
function unknownFlagError(key, verb, props) {
  const names = Object.keys(props);
  const near = nearestFlag(key, names);
  return new UsageError(
    `--${key} is not a flag for "${verb}".${near ? ` Did you mean --${near}?` : ""}`
    + ` Tool flags: ${names.map((p) => `--${p}`).join(", ")} (see \`rijks-mcp ${verb} --help\`)`,
  );
}

// ── Tiny arg tokenizer ────────────────────────────────────────────────────────
// parseArgs can't disambiguate `--flag value` from a boolean without a per-flag
// spec, and we only know booleans after listTools(). So we hand-roll: a flag is
// boolean if it's in `boolSet`; otherwise it consumes the next token as its value.
// `--key=value` always works; repeated keys collect into an array. A value flag
// followed by another flag (or nothing) is recorded in `missing` rather than
// swallowing that flag as its value.
function tokenize(args, boolSet) {
  const flags = {};
  const positionals = [];
  const missing = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") { positionals.push(...args.slice(i + 1)); break; }
    if (!isFlagLike(a)) {
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
      else if (args[i + 1] === undefined || isFlagLike(args[i + 1])) { missing.push(key); continue; }
      else { val = args[i + 1]; i++; }
    }
    if (key in flags) flags[key] = [].concat(flags[key], val);
    else flags[key] = val;
  }
  return { flags, positionals, missing };
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

// Schema params are camelCase but the CLI's own stderr hints (and habit) reach for
// kebab-case. Accept both: resolve `--resumption-token` → `resumptionToken` only when the
// camel form is a real schema property, so global flags like `show-call` are never rewritten.
const kebabToCamel = (k) => k.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
const camelToKebab = (k) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
function resolveKey(key, props) {
  if (key in props) return key;
  const camel = kebabToCamel(key);
  return camel in props ? camel : key;
}

// Build the boolean-flag set for a tool from its inputSchema + globals.
function boolSetFor(schema) {
  const s = new Set(GLOBAL_BOOL);
  const props = schema?.properties ?? {};
  for (const [name, prop] of Object.entries(props)) {
    if (propType(prop) === "boolean") { s.add(name); s.add(camelToKebab(name)); }
  }
  return s;
}

// A value flag with no value: name the flag if it exists, else treat it as the typo it is.
function missingValueError(key, verb, props) {
  if (key === "max" || GLOBAL_VALUE.has(key) || resolveKey(key, props) in props) {
    return new UsageError(`--${key} expects a value (see \`rijks-mcp ${verb} --help\`)`);
  }
  return unknownFlagError(key, verb, props);
}

// Map tokenized flags + positionals → tool arguments (coerced per schema).
function buildToolArgs(verb, verbCfg, schema, flags, positionals) {
  const props = schema?.properties ?? {};
  const args = {};
  for (const [rawKey, raw] of Object.entries(flags)) {
    if (GLOBAL_BOOL.has(rawKey) || GLOBAL_VALUE.has(rawKey)) continue;
    let key;
    if (rawKey === "max") {
      if (!verbCfg.cap) throw new UsageError(`--max/-n is not a flag for "${verb}" — it has no result cap (see \`rijks-mcp ${verb} --help\`)`);
      key = verbCfg.cap;
    } else {
      key = resolveKey(rawKey, props);
    }
    args[key] = coerce(raw, propType(props[key]), key);
  }
  // First positional → the verb's primary param (if the flag wasn't already set). An empty
  // positional is dropped, never sent as "" — the required check then names the param.
  let consumed = 0;
  if (positionals.length && verbCfg.pos && args[verbCfg.pos] === undefined && positionals[0] !== "") {
    args[verbCfg.pos] = coerce(positionals[0], propType(props[verbCfg.pos]), verbCfg.pos);
    consumed = 1;
  }
  // A verb takes at most one positional; a second one would otherwise be dropped silently.
  const extra = positionals.slice(consumed).filter((p) => p !== "");
  if (extra.length) {
    const hint = verbCfg.pos
      ? `"${verb}" takes a single <${verbCfg.pos}> positional; pass other values as flags`
      : `"${verb}" takes no positional arguments`;
    throw new UsageError(`unexpected extra argument(s): ${extra.map((e) => `"${e}"`).join(", ")} — ${hint}`);
  }
  return args;
}

// Check resolved args against the live inputSchema BEFORE --show-call prints them or the
// server sees them: an unknown flag or a missing required param is a usage error (exit 2),
// and --show-call never presents a call as valid that the strict schema would reject.
function validateToolArgs(verb, schema, args) {
  const props = schema?.properties ?? {};
  for (const key of Object.keys(args)) {
    if (!(key in props)) throw unknownFlagError(key, verb, props);
  }
  for (const req of schema?.required ?? []) {
    if (args[req] === undefined) {
      throw new UsageError(`"${verb}" requires <${req}> (positional or --${req}) — see \`rijks-mcp ${verb} --help\``);
    }
  }
}

// ── Transport / connection ───────────────────────────────────────────────────
// The stdio server's stderr is piped, not inherited, so its startup logs don't mix into ours
// (where counts and notes go). The last lines are kept so a failed connect or tool call can
// show the server's own diagnosis.
const SERVER_LOG_KEEP = 200;
const serverLog = [];
let serverLogSeq = 0;

async function connect(httpUrl) {
  const transport = httpUrl
    ? new StreamableHTTPClientTransport(new URL(httpUrl))
    : new StdioClientTransport({
        command: process.execPath,
        args: ["dist/index.js"],
        cwd: PROJECT_ROOT,
        // Force structured output on, and skip the ~13s eager warm-up (lazy on first use).
        env: { ...process.env, STRUCTURED_CONTENT: "true", MCP_SKIP_STARTUP_WARM: "1" },
        stderr: "pipe",
      });
  let partial = "";
  // Stays attached for the whole session: it also keeps the pipe drained.
  transport.stderr?.on("data", (chunk) => {
    const parts = (partial + chunk.toString()).split("\n");
    partial = parts.pop();
    for (const line of parts) {
      if (!line.trim()) continue;
      serverLog.push({ seq: ++serverLogSeq, line });
      if (serverLog.length > SERVER_LOG_KEEP) serverLog.shift();
    }
  });
  const client = new Client({ name: "rijks-mcp", version: "0.1" });
  try {
    await client.connect(transport);
  } catch (err) {
    const tail = serverLog.map((l) => l.line).join("\n");
    throw new Error(tail ? `${err?.message ?? err}\n${tail}` : (err?.message ?? String(err)), { cause: err });
  }
  return client;
}

// Server log lines above info level written after `since` (a serverLogSeq mark), as
// `server <level>: <message> — <error>`, minus any whose error the caller already shows
// (`known`). Waits briefly: stderr can trail the JSON-RPC response.
async function serverProblemsSince(since, known = "") {
  await new Promise((r) => setTimeout(r, 50));
  const out = [];
  for (const { seq, line } of serverLog) {
    if (seq <= since) continue;
    let rec = null;
    try { rec = JSON.parse(line); } catch { /* plain text line */ }
    if (rec && typeof rec === "object") {
      if (rec.level === "info" || rec.level === "debug") continue;
      if (rec.error && known.includes(rec.error)) continue;
      out.push(`server ${rec.level ?? "log"}: ${rec.message ?? line}${rec.error ? ` — ${rec.error}` : ""}`);
    } else {
      out.push(`server: ${line}`);
    }
  }
  return out;
}

// One tool call; on failure, append the server's own warn/error log lines (stdio only).
async function callWithDiagnosis(client, name, args) {
  const mark = serverLogSeq;
  try {
    const res = await client.callTool({ name, arguments: args });
    if (res.isError) res.serverProblems = await serverProblemsSince(mark, textOf(res));
    return res;
  } catch (err) {
    const problems = await serverProblemsSince(mark);
    if (problems.length) err.message = `${err?.message ?? err}\n${problems.join("\n")}`;
    throw err;
  }
}

const errorText = (res) => [textOf(res), ...(res.serverProblems ?? [])].join("\n");

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
      if (list.length && offset + list.length < total) parts.push(`pass --offset ${offset + list.length} for more`);
    } else {
      parts.push(`${list.length} shown (offset ${offset})`);
    }
  } else if (verbCfg.page === "full") {
    const total = data[verbCfg.total];
    parts.push(`${list.length} shown${typeof total === "number" ? ` of ${total}` : ""}`);
    if (typeof total === "number" && list.length < total) parts.push("pass --full for all");
  } else if (verbCfg.page === "token") {
    const total = verbCfg.total ? data[verbCfg.total] : undefined;
    parts.push(`${list.length} shown${typeof total === "number" ? ` of ${total}` : ""}`);
    if (data.resumptionToken) parts.push(`pass --resumption-token ${data.resumptionToken} for more`);
  } else {
    parts.push(`${list.length} shown`);
  }
  return parts.join("; ");
}

// The row list: `alt` replaces `list` when the tool filled it instead (search --compact → ids,
// provenance --creditLineQuery → creditLineResults).
function listKeyOf(verbCfg, data) {
  if (verbCfg.alt && Array.isArray(data[verbCfg.alt]) && data[verbCfg.alt].length && !data[verbCfg.list]?.length) {
    return verbCfg.alt;
  }
  return verbCfg.list ?? Object.keys(data).find((k) => Array.isArray(data[k]));
}

const fmtCount = (n) => Number(n).toLocaleString("en-US");

// Caveats the tools state in their text channel, which JSONL replaces — without these a
// capped or partial result reads as a complete one. Rebuilt from structured fields only.
function resultNotes(verbCfg, data, listKey) {
  const notes = [];
  if (data.totalArtworksCapped === true) {
    notes.push(`the total is a lower bound — counting stopped at ${fmtCount(data.totalArtworks)}; narrow the query for an exact figure`);
  }
  if (data.candidatesCapped === true) {
    notes.push(`partial — only the first window of ${fmtCount(data.totalCandidates)} text candidates was parsed, `
      + `so ${fmtCount(data.totalConfirmed)} confirmed is a lower bound; add a narrowing term`);
  }
  if (data.autoCompacted === true) {
    notes.push("rows are compact summaries — the full result exceeded the response-size limit; "
      + "lower --max (≤10) or pass --objectNumber for full event chains");
  }
  if (listKey === "creditLineResults") {
    notes.push("rows are credit-line matches (how the museum acquired the work), not parsed provenance");
  }
  if (data.enrichmentReview?.count) {
    const where = data.enrichmentReview.url ?? data.enrichmentReview.file;
    notes.push(`${fmtCount(data.enrichmentReview.count)} LLM-assisted record(s) in this result${where ? ` — review page: ${where}` : ""}`);
  }
  if (data.coverage?.withoutBucket) {
    notes.push(`${fmtCount(data.coverage.withoutBucket)} of ${fmtCount(data.total)} artworks have no ${data.dimension} value and are in no bucket`);
  }
  if (data.multiValued === true) {
    notes.push(`${data.dimension} is multi-valued — an artwork can count in several buckets, so counts need not sum to the total`);
  }
  for (const key of verbCfg.aside ?? []) {
    const v = data[key];
    if (v == null || (typeof v === "object" && !Object.keys(v).length)) continue;
    notes.push(`top-level \`${key}\` is not part of the rows — pass --json to read it`);
  }
  return notes;
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
  const listKey = listKeyOf(verbCfg, data);
  const list = Array.isArray(data[listKey]) ? data[listKey] : [];
  if (flags.table === true) {
    // Compact ids are bare strings; give them a column so the table has something to show.
    const rows = list.map((r) => (typeof r === "object" && r !== null ? project(r, fields) : { [listKey]: r }));
    process.stdout.write(renderTable(rows, fields) + "\n");
  } else {
    for (const row of list) process.stdout.write(JSON.stringify(project(row, fields)) + "\n");
  }
  if (!quiet) {
    process.stderr.write(paginationSummary(verbCfg, data, list, flags) + "\n");
    for (const n of resultNotes(verbCfg, data, listKey)) process.stderr.write(`note: ${n}\n`);
  }
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

// Read stdin to EOF and return the meaningful lines: trimmed, with blanks and
// `#`-comment lines dropped. Used by --stdin batch mode (one invocation per line).
async function readStdinLines() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks)
    .toString("utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
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
    "  --max N  (-n)    result cap → the command's own cap param (maxResults; topN for stats)",
    "  --json           full structuredContent payload, pretty-printed",
    "  --table          terse human-readable table",
    "  --quiet          suppress the stderr count/summary line",
    "  --show-call      print the resolved {tool, arguments} WITHOUT executing (cheap dry-run)",
    "  --stdin          batch: read the positional from stdin, one invocation per line (one connection)",
    "",
    "Transports:",
    "  HTTP (recommended): --http <url> or RIJKS_MCP_HTTP — a warm server; every call is instant.",
    "  stdio (default):    no --http; spawns `node dist/index.js` — needs `npm run build` + DBs in data/.",
    "",
    "Output:  list tools → JSONL · single-object tools → one compact JSON · counts+paging+notes → stderr.",
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
  }
  if (cfg.cap) lines.push("", `Aliases:  --max, -n  → ${cfg.cap}`);
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
    if (cfg.cap) entry.max = cfg.cap;
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
      const raw = a.replace(/^--?/, "").split("=")[0];
      const key = FLAG_ALIASES[raw] || raw;
      if (PRESCAN_VALUE.has(key) && !a.includes("=")) i++; // skip its value
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
    const { flags, positionals, missing } = tokenize(argv, boolSet);
    if (missing.length) throw missingValueError(missing[0], verb, tool.inputSchema?.properties ?? {});
    // The verb is always the first bare token; drop it so the rest map to tool params.
    const restPositionals = positionals[0] === verb ? positionals.slice(1) : positionals;

    // Batch mode: read the primary positional from stdin, one invocation per line
    // over this single connection. Other flags (--fields/--json/--max/…) apply per line.
    if (flags.stdin === true) {
      if (!cfg.pos) throw new UsageError(`--stdin needs a verb with a positional argument; ${verb} has none`);
      if (process.stdin.isTTY) throw new UsageError("--stdin set but stdin is a TTY — pipe input (e.g. `printf 'SK-C-5\\n' | rijks-mcp details --stdin`)");
      if (restPositionals.length) throw new UsageError(`--stdin supplies <${cfg.pos}>; drop the positional argument(s): ${restPositionals.map((p) => `"${p}"`).join(", ")}`);
      const lines = await readStdinLines();
      // Flag mistakes are the same on every line — report them once, before any call.
      if (lines.length) validateToolArgs(verb, tool.inputSchema, buildToolArgs(verb, cfg, tool.inputSchema, flags, [lines[0]]));
      let failures = 0;
      for (const line of lines) {
        const toolArgs = buildToolArgs(verb, cfg, tool.inputSchema, flags, [line]);
        if (flags["show-call"] === true) {
          process.stdout.write(JSON.stringify({ tool: cfg.tool, arguments: toolArgs }) + "\n");
          continue;
        }
        try {
          const res = await callWithDiagnosis(client, cfg.tool, toolArgs);
          if (res.isError) { process.stderr.write(`[${line}] ${errorText(res)}\n`); failures++; continue; }
          renderResult(res, cfg, flags);
        } catch (err) {
          process.stderr.write(`[${line}] Error: ${err?.message ?? err}\n`);
          failures++;
        }
      }
      if (failures) {
        process.stderr.write(`${failures} of ${lines.length} input(s) failed\n`);
        process.exitCode = 1;
      }
      return;
    }

    const toolArgs = buildToolArgs(verb, cfg, tool.inputSchema, flags, restPositionals);
    validateToolArgs(verb, tool.inputSchema, toolArgs);

    if (flags["show-call"] === true) {
      process.stdout.write(JSON.stringify({ tool: cfg.tool, arguments: toolArgs }, null, 2) + "\n");
      return;
    }

    const res = await callWithDiagnosis(client, cfg.tool, toolArgs);
    if (res.isError) {
      process.stderr.write(errorText(res) + "\n");
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
