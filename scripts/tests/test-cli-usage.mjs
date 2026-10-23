/**
 * CLI argument handling, help and exit codes (scripts/cli.mjs) — no tool is ever called.
 * Schema-dependent checks read the live tools/list of a stdio server on the fixture DB,
 * so this runs in CI (`dist/` only, no data/ DBs, no network).
 *
 * Failure modes guarded:
 *   - --max sent as maxResults to a tool whose cap is named differently (stats → topN),
 *     or to a tool with no cap at all → strict-schema rejection, exit 1 instead of 2.
 *   - a verb's `cap` naming a param its tool doesn't have (silent rename upstream).
 *   - an unknown flag / missing required param reaching the server (exit 1), or
 *     --show-call printing a call the server would reject.
 *   - a value flag swallowing the next flag as its value (`--query --max 3`).
 *   - an extra positional silently dropped.
 *   - a help example that no longer parses against the live schema.
 *   - help needing a server.
 *
 * Run:  node scripts/tests/test-cli-usage.mjs   (needs npm run build)
 */
import { fixtureCli, parseJson as parse } from "./cli-fixture.mjs";

const cli = fixtureCli("cli-usage");

let passed = 0;
let failed = 0;
function check(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.log(`  ✗ ${msg}`); }
}
const DEAD = ["--http", "http://127.0.0.1:1/mcp"];

console.log("\nCLI usage tests (fixture server)\n");

// ── Static paths: no server ────────────────────────────────────────────────────
// The tools manifest is read once (one server start) and reused below.
const [r0, v, u, compact] = await Promise.all([
  cli([...DEAD, "--help"]),
  cli([...DEAD, "stats", "--help"]),
  cli(["frobnicate"]),
  cli(["tools", "--compact"]),
]);
const manifestAll = parse(compact.stdout) ?? [];
// Tools absent from this server (Gemma-gated) come back with empty args.
const manifest = manifestAll.filter((m) => Object.keys(m.args).length);
{
  check(r0.code === 0 && /Usage: rijks-mcp/.test(r0.stdout) && !/Connection failed/.test(r0.stderr), "top-level --help renders without a server");
  check(v.code === 0 && /stats → collection_stats/.test(v.stdout) && /Aliases:  --max, -n  → topN/.test(v.stdout),
    "per-command --help degrades without a server and names the verb's own cap");
  check(u.code === 2 && /^Unknown command: frobnicate/.test(u.stderr), "unknown command → exit 2");
}

// ── --max resolves per verb ────────────────────────────────────────────────────
{
  const [r, n, d, ls] = await Promise.all([
    cli(["stats", "type", "--max", "3", "--show-call"]),
    cli(["search", "tulip", "-n", "2", "--show-call"]),
    cli(["details", "FX-1", "--max", "3"]),
    cli(["list-sets", "--max", "3", "--show-call"]),
  ]);
  check(r.code === 0 && parse(r.stdout)?.arguments?.topN === 3 && !("maxResults" in (parse(r.stdout)?.arguments ?? {})),
    "stats --max 3 → topN: 3");
  check(n.code === 0 && parse(n.stdout)?.arguments?.maxResults === 2, "search -n 2 → maxResults: 2");
  check(d.code === 2 && d.stderr === 'Error: --max/-n is not a flag for "details" — it has no result cap (see `rijks-mcp details --help`)\n',
    "details --max → exit 2 with the no-cap message");
  check(ls.code === 2 && ls.stdout === "", "list-sets --max → exit 2, nothing printed by --show-call");
}

// Every verb's cap must be a real param of its tool (tools --compact reports it as `max`).
{
  const bad = manifest.filter((m) => m.max && !(m.max in m.args)).map((m) => `${m.verb}:${m.max}`);
  const capped = manifest.filter((m) => m.max).length;
  check(compact.code === 0 && capped >= 8 && bad.length === 0, `every --max target is a schema param (${capped} capped verbs; bad: ${bad.join(", ") || "none"})`);
  const stats = manifest.find((m) => m.verb === "stats");
  check(stats?.max === "topN", "tools --compact reports stats' cap as topN");
}

// ── Validation before --show-call / callTool ───────────────────────────────────
{
  const [r, k, q, e, sw, tail] = await Promise.all([
    cli(["browse-set", "--resumption_token", "abc", "--show-call"]),
    cli(["browse-set", "--resumption-token", "abc", "--show-call"]),
    cli(["conservation", "--show-call"]),
    cli(["conservation", "", "--show-call"]),
    cli(["search", "--query", "--max", "3", "--show-call"]),
    cli(["search", "tulip", "--qeury"]),
  ]);
  const [x, neg, tq, bs, ok] = await Promise.all([
    cli(["details", "FX-1", "FX-2", "--show-call"]),
    cli(["search", "--nearLat", "52.37", "--nearLon", "-4.9", "--show-call"]),
    cli(["search", "--textQuery", "not-json"]),
    cli(["details", "--stdin", "--bogus", "1"], { input: "FX-1\nFX-2\n" }),
    cli(["stats", "--dimension", "not_a_dimension"]),
  ]);
  check(r.code === 2 && r.stdout === "", "unknown flag with --show-call → exit 2, no call printed");
  check(r.stderr.startsWith('Error: --resumption_token is not a flag for "browse-set". Did you mean --resumptionToken? Tool flags: --setSpec, '),
    "unknown flag names the near miss (dash/underscore/case-insensitive) and lists the tool's flags");
  check(k.code === 0 && parse(k.stdout)?.arguments?.resumptionToken === "abc", "kebab-case --resumption-token still resolves");

  check(q.code === 2 && q.stderr === 'Error: "conservation" requires <objectNumber> (positional or --objectNumber) — see `rijks-mcp conservation --help`\n',
    "missing required param → exit 2 naming the positional");
  check(e.code === 2 && /requires <objectNumber>/.test(e.stderr), "empty positional is dropped, not sent as \"\"");

  check(sw.code === 2 && sw.stderr === "Error: --query expects a value (see `rijks-mcp search --help`)\n",
    "value flag followed by a flag → 'expects a value', not swallowed");
  check(tail.code === 2 && /^Error: --qeury is not a flag for "search"\./.test(tail.stderr), "value-less unknown flag reads as an unknown flag");

  check(x.code === 2 && x.stderr === 'Error: unexpected extra argument(s): "FX-2" — "details" takes a single <objectNumber> positional; pass other values as flags\n',
    "extra positional → exit 2");
  check(neg.code === 0 && parse(neg.stdout)?.arguments?.nearLon === -4.9, "a negative number is a value, not a flag");

  check(tq.code === 2 && /--textQuery expects a JSON object/.test(tq.stderr), "malformed JSON object param → exit 2");

  check(bs.code === 2 && bs.stdout === "" && /^Error: --bogus is not a flag for "details"/.test(bs.stderr),
    "--stdin reports a flag mistake once, before any call");

  check(ok.code === 1 && /Invalid option/.test(ok.stderr), "a schema-valid key with a bad value is still a tool error (exit 1)");
}

// ── Every help example parses against the live schema ──────────────────────────
// A shell-ish split of the example line (double quotes only), cut at the first pipe.
function exampleArgv(line) {
  const cmd = line.replace(/^rijks-mcp\s+/, "").split(" | ")[0];
  return [...cmd.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
}
{
  const registered = new Set(manifest.map((t) => t.verb));
  const verbs = manifestAll.map((t) => t.verb);
  check(verbs.length >= 14, `tools --compact lists the verbs (${verbs.length})`);
  // Each spawn starts a server, so run them a few at a time; report in verb order.
  const results = new Array(verbs.length);
  let next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < verbs.length) {
      const i = next++;
      const verb = verbs[i];
      // The static (no-server) help carries the same example and costs no server start.
      const help = await cli([...DEAD, verb, "--help"]);
      const line = help.stdout.split("\nExample:\n  ")[1]?.split("\n")[0];
      if (!line) { results[i] = [false, `${verb}: --help has an example`]; continue; }
      if (!registered.has(verb)) continue;
      const r = await cli([...exampleArgv(line), "--show-call"]);
      results[i] = [r.code === 0 && !!parse(r.stdout)?.tool, `${verb}: example passes --show-call (${r.code === 0 ? "ok" : r.stderr.trim()})`];
    }
  }));
  for (const res of results) if (res) check(...res);
}

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
