/**
 * Smoke test for the headless CLI (scripts/cli.mjs, issue #368).
 *
 * Spawns `node scripts/cli.mjs <args>` as a child process over the cold-stdio
 * transport (self-contained — no running server needed), and asserts the
 * JSON-first output contract + exit codes (0 ok / 1 tool error / 2 usage error).
 *
 * Requires:  npm run build  (the CLI's stdio path spawns dist/index.js) + the DBs in data/.
 * Run:       node scripts/tests/test-cli.mjs   (or `npm run test:cli`)
 *
 * Excluded from `npm test` / `test:all` — it needs dist/ + DBs and hits live IIIF,
 * mirroring test-http-viewer-queues.mjs / test-inspect-navigate.mjs.
 */
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, statSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = path.join(PROJECT_ROOT, "scripts", "cli.mjs");

let passed = 0;
let failed = 0;
const failures = [];
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; failures.push(msg); console.log(`  ✗ ${msg}`); }
}
function section(name) {
  console.log(`\n${"═".repeat(60)}\n  ${name}\n${"═".repeat(60)}`);
}

/** Run the CLI; resolve with {code, stdout, stderr} (never rejects). */
function runCli(args, timeout = 90000) {
  // These are stdio smoke tests. Strip RIJKS_MCP_HTTP (the docs recommend exporting it, so it's
  // commonly set in dev shells / agents) so an exported Railway URL can't hijack the stdio path.
  // Tests that need HTTP pass --http explicitly, which overrides the env var inside the CLI.
  const { RIJKS_MCP_HTTP, ...env } = process.env;
  return new Promise((resolve) => {
    execFile("node", [CLI, ...args], { cwd: PROJECT_ROOT, timeout, maxBuffer: 64 * 1024 * 1024, env },
      (err, stdout, stderr) => {
        resolve({ code: err?.code ?? 0, killed: !!err?.killed, stdout: stdout ?? "", stderr: stderr ?? "" });
      });
  });
}

const jsonlRows = (s) => s.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

// ── 1. tools --json (capabilities dump; excludes viewer tools) ──────────────────
section("1. tools --json");
{
  const r = await runCli(["tools", "--json"]);
  assert(r.code === 0, "exit 0");
  let tools = [];
  try { tools = JSON.parse(r.stdout); } catch { /* fail below */ }
  assert(Array.isArray(tools) && tools.length === 12, `12 in-scope tools (got ${tools.length})`);
  const names = new Set(tools.map((t) => t.name));
  assert(names.has("search_artwork") && names.has("find_similar") && names.has("search_inscriptions"), "includes search_artwork + find_similar + search_inscriptions");
  const viewer = ["get_artwork_image", "navigate_viewer", "remount_viewer", "poll_viewer_commands"];
  assert(viewer.every((v) => !names.has(v)), "excludes all 4 viewer/stateful tools");
  assert(tools.every((t) => t.inputSchema && typeof t.inputSchema === "object"), "each entry carries an inputSchema");
}

// ── 2. details happy path + --fields projection (single-object JSON) ────────────
section("2. details SK-C-5 --fields objectNumber,title");
{
  const r = await runCli(["details", "SK-C-5", "--fields", "objectNumber,title"]);
  assert(r.code === 0, "exit 0");
  let obj = null;
  try { obj = JSON.parse(r.stdout.trim()); } catch { /* fail below */ }
  assert(obj && obj.objectNumber === "SK-C-5", `objectNumber === SK-C-5 (got ${obj?.objectNumber})`);
  assert(obj && typeof obj.title === "string" && obj.title.length > 0, "title present");
  assert(obj && Object.keys(obj).every((k) => k === "objectNumber" || k === "title"), "projection kept only requested fields");
}

// ── 3. list tool → JSONL + stderr count line ────────────────────────────────────
section("3. search --query tulip --max 3 --fields objectNumber,title");
{
  const r = await runCli(["search", "--query", "tulip", "--max", "3", "--fields", "objectNumber,title"]);
  assert(r.code === 0, "exit 0");
  let rows = [];
  try { rows = jsonlRows(r.stdout); } catch { /* fail below */ }
  assert(rows.length >= 1 && rows.length <= 3, `1–3 JSONL rows (got ${rows.length})`);
  assert(rows.every((row) => "objectNumber" in row), "each row is valid JSON with objectNumber");
  assert(/\bshown\b/.test(r.stderr), "stderr carries a count/pagination summary");
}

// ── 4. --show-call dry-run (resolves args, makes no tool call) ──────────────────
section("4. --show-call search --query tulip");
{
  const r = await runCli(["--show-call", "search", "--query", "tulip"]);
  assert(r.code === 0, "exit 0");
  let call = null;
  try { call = JSON.parse(r.stdout.trim()); } catch { /* fail below */ }
  assert(call && call.tool === "search_artwork", `resolved tool name (got ${call?.tool})`);
  assert(call && call.arguments && call.arguments.query === "tulip", "resolved positional/flag → query=tulip");
  assert(!/objectNumber/.test(r.stdout.replace(/"query"[^\n]*/g, "")), "no result rows emitted (dry-run)");
}

// ── 5. usage error → exit 2 ─────────────────────────────────────────────────────
section("5. unknown command → exit 2");
{
  const r = await runCli(["frobnicate"]);
  assert(r.code === 2, `exit 2 (got ${r.code})`);
  assert(r.stderr.length > 0, "stderr explains the error");
}

// ── 6. tool/validation error → exit 1 ───────────────────────────────────────────
section("6. invalid enum (stats --dimension bogus) → exit 1");
{
  const r = await runCli(["stats", "--dimension", "not_a_real_dimension"]);
  assert(r.code === 1, `exit 1 (got ${r.code})`);
  assert(r.stderr.length > 0, "stderr carries the error message");
}

// ── 7. inspect --out writes image bytes ─────────────────────────────────────────
section("7. inspect SK-C-5 --region ... --out <tmp>");
{
  const out = path.join(os.tmpdir(), `rijks-mcp-smoke-${process.pid}.jpg`);
  rmSync(out, { force: true });
  const r = await runCli(["inspect", "SK-C-5", "--region", "pct:40,40,20,20", "--out", out], 120000);
  assert(r.code === 0, `exit 0 (got ${r.code}${r.killed ? ", timed out" : ""})`);
  assert(existsSync(out) && statSync(out).size > 0, "image file written with non-zero size");
  rmSync(out, { force: true });
}

// ── 8. object param (textQuery) accepts a JSON literal ──────────────────────────
section("8. textQuery JSON literal");
{
  const tq = '{"must":[{"field":"title","phrase":"tulip"}]}';
  // 8a: --show-call parses the JSON into an object (not a passthrough string)
  const r = await runCli(["--show-call", "search", "--textQuery", tq]);
  assert(r.code === 0, "exit 0 (valid JSON)");
  let call = null;
  try { call = JSON.parse(r.stdout.trim()); } catch { /* fail below */ }
  const tqArg = call?.arguments?.textQuery;
  assert(tqArg && typeof tqArg === "object" && !Array.isArray(tqArg), "textQuery resolved to an object (parsed, not a string)");
  assert(Array.isArray(tqArg?.must) && tqArg.must[0]?.field === "title", "nested DSL preserved (must[0].field === title)");
  // 8b: malformed JSON → usage error (exit 2), naming the flag
  const bad = await runCli(["search", "--textQuery", "not-json"]);
  assert(bad.code === 2, `exit 2 on malformed JSON (got ${bad.code})`);
  assert(/textQuery/.test(bad.stderr), "stderr names the offending flag");
}

// ── 9. tools --compact (compact capability manifest for agent bootstrap) ────────
section("9. tools --compact");
{
  const r = await runCli(["tools", "--compact"]);
  assert(r.code === 0, "exit 0");
  let manifest = [];
  try { manifest = JSON.parse(r.stdout); } catch { /* fail below */ }
  assert(Array.isArray(manifest) && manifest.length === 12, `12 in-scope tools (got ${manifest.length})`);
  const search = manifest.find((m) => m.tool === "search_artwork");
  assert(search && search.verb === "search" && search.positional === "query", "search entry: verb + positional");
  assert(search && search.result === "results" && search.page === "offset", "search entry: result/list key + paging");
  assert(search && search.args && search.args.query === "string", "args carry name→type (query: string), no schema");
  const details = manifest.find((m) => m.tool === "get_artwork_details");
  assert(details && details.result === "single", "single-object tool reports result:single");
  // Required args are marked with a trailing "!" — find_similar requires objectNumber.
  const similar = manifest.find((m) => m.tool === "find_similar");
  assert(similar && /!$/.test(similar.args.objectNumber ?? ""), "required arg marked with trailing '!'");
  // No descriptions or full JSON Schemas → far smaller than `tools --json`.
  const full = await runCli(["tools", "--json"]);
  assert(r.stdout.length * 3 < full.stdout.length, `compact is much smaller than --json (${r.stdout.length} vs ${full.stdout.length} bytes)`);
  // Collision guard: the `tools` verb's --compact flag must NOT shadow search_artwork's own
  // `compact` tool param — `search --compact` has to forward compact:true to the tool.
  const sc = await runCli(["search", "--query", "tulip", "--compact", "--show-call"]);
  let call = null;
  try { call = JSON.parse(sc.stdout.trim()); } catch { /* fail below */ }
  assert(call?.arguments?.compact === true, "search --compact forwards compact:true (not eaten as a CLI global)");
}

// ── 10. top-level help is connection-free (never touches the server) ────────────
section("10. --help is offline-safe + curated");
{
  // A dead --http URL would surface as "Connection failed" IF help connected at all.
  // Top-level help must render purely from the static table — no connect, no error.
  const r = await runCli(["--http", "http://127.0.0.1:1/mcp", "--help"]);
  assert(r.code === 0, `exit 0 (got ${r.code})`);
  assert(!/Connection failed/.test(r.stderr), "no connection attempt (stderr clean)");
  assert(/Usage: rijks-mcp/.test(r.stdout) && /Commands:/.test(r.stdout), "static usage frame printed");
  assert(/Common flags:/.test(r.stdout) && /Transports:/.test(r.stdout), "Common flags + Transports blocks present");
  assert(/RIJKS_MCP_HTTP/.test(r.stdout), "mentions the RIJKS_MCP_HTTP env var");
  // Curated one-liners, not truncated tool-description fragments.
  assert(/Cap with --topN/.test(r.stdout), "stats line is the curated summary (not a clipped tool desc)");
}

// ── 11. per-command --help: schema-derived flags + enrichments (live server) ────
section("11. <command> --help enrichments");
{
  const r = await runCli(["stats", "--help"]);
  assert(r.code === 0, "exit 0");
  assert(/--dimension <string> \(required\)/.test(r.stdout), "required flag marked");
  assert(/see `tools --json`|\{[^}]*\}/.test(r.stdout), "enum values shown inline or punted to `tools --json`");
  assert(/^Example:/m.test(r.stdout) && /rijks-mcp stats/.test(r.stdout), "worked example present");
  // search has maxResults → the --max/-n alias must be documented.
  const s = await runCli(["search", "--help"]);
  assert(/Aliases:\s*--max, -n\s*→\s*maxResults/.test(s.stdout), "search --help documents the --max/-n alias");
}

// ── 12. per-command --help degrades without a server (static verb info + hint) ──
section("12. <command> --help with no reachable server");
{
  const r = await runCli(["--http", "http://127.0.0.1:1/mcp", "search", "--help"]);
  assert(r.code === 0, `exit 0 (got ${r.code})`);
  assert(/search → search_artwork/.test(r.stdout), "static verb header rendered");
  assert(/Example:/.test(r.stdout) && /schema-derived and needs a server/.test(r.stdout), "example + schema-needs-server hint");
}

// ── 13. `tools --help` is offline-safe (built-in command, static help) ──────────
section("13. tools --help is offline-safe");
{
  // `tools` isn't in VERBS, but it's advertised in the usage — its --help must render
  // statically, not connect (a dead --http must not surface as "Connection failed").
  const r = await runCli(["--http", "http://127.0.0.1:1/mcp", "tools", "--help"]);
  assert(r.code === 0, `exit 0 (got ${r.code})`);
  assert(!/Connection failed/.test(r.stderr), "no connection attempt (stderr clean)");
  assert(/Usage: rijks-mcp tools \[--compact\|--json\]/.test(r.stdout), "static tools usage printed");
  assert(/--compact/.test(r.stdout) && /--json/.test(r.stdout), "documents both output modes");
}

// ── 14. inscriptions verb: positional → text, JSONL rows, pagination summary ────
section("14. inscriptions --transcribedText Rembrandt");
{
  // --show-call: the first positional must map to the verb's `text` param.
  const dry = await runCli(["--show-call", "inscriptions", "Rembrandt"]);
  assert(dry.code === 0, "exit 0 (show-call)");
  let call = null;
  try { call = JSON.parse(dry.stdout.trim()); } catch { /* fail below */ }
  assert(call && call.tool === "search_inscriptions", `resolved tool name (got ${call?.tool})`);
  assert(call && call.arguments && call.arguments.text === "Rembrandt", "positional → text=Rembrandt");

  // Live query: list-tool JSONL + stderr pagination summary (guards list/total/page wiring).
  const r = await runCli(["inscriptions", "--transcribedText", "Rembrandt", "--max", "3", "--fields", "objectNumber,title"]);
  assert(r.code === 0, "exit 0 (live)");
  let rows = [];
  try { rows = jsonlRows(r.stdout); } catch { /* fail below */ }
  assert(rows.length >= 1 && rows.length <= 3, `1–3 JSONL rows (got ${rows.length})`);
  assert(rows.every((row) => "objectNumber" in row), "each row is valid JSON with objectNumber");
  assert(/\bshown\b/.test(r.stderr), "stderr carries a count/pagination summary");
}

// ── Summary ─────────────────────────────────────────────────────────────────────
console.log(`\n${"═".repeat(60)}`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failed) { console.log("  Failures:\n" + failures.map((f) => `   - ${f}`).join("\n")); }
console.log("═".repeat(60));
process.exit(failed ? 1 : 0);
