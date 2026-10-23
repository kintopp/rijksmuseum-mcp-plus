/**
 * CLI output rendering over the real chain — CLI → MCP client → stdio → server → tool —
 * against the fixture vocab DB, so it runs in CI (`dist/` only, no data/ DBs, no network).
 * Image writing (`inspect --out`) needs live IIIF and stays in test-cli.mjs.
 *
 * Failure modes guarded:
 *   - stdout stops being pure JSONL (a summary, note or server log line lands there).
 *   - the server's own startup log leaks into the CLI's stderr.
 *   - a mode that fills a different list key (search --compact → ids) renders as
 *     "0 shown … pass --offset 0".
 *   - a capped/partial/multi-valued result reads as complete: the text-channel caveat is
 *     not restated as a `note:` line.
 *   - --quiet / --json / --fields / --table / --stdin contracts drift.
 *
 * Run:  node scripts/tests/test-cli-render.mjs   (needs npm run build)
 */
import { fixtureCli } from "./cli-fixture.mjs";

const cli = fixtureCli("cli-render");

let passed = 0;
let failed = 0;
function check(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.log(`  ✗ ${msg}`); }
}
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
const jsonl = (s) => s.trim().split("\n").filter(Boolean).map(parse);

console.log("\nCLI render tests (fixture server)\n");

const [list, quiet, json, table, compact, single, bib, stats, batch, batchFail] = await Promise.all([
  cli(["search", "--creator", "Rembrandt van Rijn", "--fields", "objectNumber"]),
  cli(["search", "--creator", "Rembrandt van Rijn", "--fields", "objectNumber", "--quiet"]),
  cli(["search", "--creator", "Rembrandt van Rijn", "--json"]),
  cli(["search", "--type", "painting", "--max", "2", "--table", "--fields", "objectNumber,title"]),
  cli(["search", "--type", "painting", "--compact", "--max", "2"]),
  cli(["details", "FX-1", "--fields", "objectNumber,title"]),
  cli(["bibliography", "FX-1", "--fields", "sequence"]),
  cli(["stats", "type"]),
  cli(["details", "--stdin", "--fields", "objectNumber"], { input: "FX-1\n# comment\n\nFX-2\n" }),
  cli(["details", "--stdin", "--fields", "objectNumber"], { input: "FX-1\nNOPE\n" }),
]);

// ── List tool → JSONL + stderr summary ─────────────────────────────────────────
check(list.code === 0 && JSON.stringify(jsonl(list.stdout)) === '[{"objectNumber":"FX-1"},{"objectNumber":"FX-6"}]',
  "list rows → one JSON object per stdout line, projected by --fields");
check(list.stderr === "2 shown (offset 0) of 2\n", "stderr carries only the count line — no server log lines");
check(quiet.code === 0 && quiet.stderr === "" && quiet.stdout === list.stdout, "--quiet drops the stderr summary, not the rows");

// ── --json passthrough ─────────────────────────────────────────────────────────
{
  const data = parse(json.stdout);
  check(json.code === 0 && data?.totalResults === 2 && Array.isArray(data?.results) && data.results.length === 2,
    "--json prints the whole structuredContent as one object");
  check(json.stderr === "", "--json emits no count line or notes");
}

// ── --table ────────────────────────────────────────────────────────────────────
{
  const lines = table.stdout.trimEnd().split("\n");
  check(table.code === 0 && /^objectNumber\s+title\s*$/.test(lines[0]) && /^-+\s+-+\s*$/.test(lines[1]),
    "--table prints a header and rule for the --fields columns");
  check(lines.length === 4 && /^FX-1\s+The Night Watch Study/.test(lines[2]), "--table prints one line per row");
  check(table.stderr === "2 shown (offset 0) of 5; pass --offset 2 for more\n", "paging hint names the next offset");
}

// ── Alternate list key (search --compact → ids) ────────────────────────────────
check(compact.code === 0 && JSON.stringify(jsonl(compact.stdout)) === '["FX-1","FX-2"]',
  "search --compact renders its ids as JSONL rows");
check(compact.stderr === "2 shown (offset 0) of 5; pass --offset 2 for more\n", "…and counts them, not the empty results list");

// ── Single-object tool ─────────────────────────────────────────────────────────
check(single.code === 0 && single.stdout === '{"objectNumber":"FX-1","title":"The Night Watch Study"}\n',
  "single-object tool → one compact JSON line, projected");

// ── `full` paging reports the total ────────────────────────────────────────────
check(bib.code === 0 && jsonl(bib.stdout).length === 3 && bib.stderr === "3 shown of 3\n",
  "bibliography summary shows N of total (no --full hint when complete)");

// ── Notes restate caveats the JSONL drops ──────────────────────────────────────
check(stats.code === 0 && stats.stderr === [
  "2 shown (offset 0) of 2",
  "note: 1 of 9 artworks have no type value and are in no bucket",
  "note: type is multi-valued — an artwork can count in several buckets, so counts need not sum to the total",
  "",
].join("\n"), "stats: empty-value coverage and multi-valued caveats become note: lines");
check(jsonl(stats.stdout).every((r) => r && "label" in r), "notes never reach stdout");

// ── --stdin batch ──────────────────────────────────────────────────────────────
check(batch.code === 0 && batch.stdout === '{"objectNumber":"FX-1"}\n{"objectNumber":"FX-2"}\n',
  "--stdin runs one call per line, skipping blanks and # comments");
check(batchFail.code === 1 && batchFail.stdout === '{"objectNumber":"FX-1"}\n', "--stdin keeps the good rows when one input fails");
check(batchFail.stderr === "[NOPE] Error in get_artwork_details: No artwork found: NOPE\n1 of 2 input(s) failed\n",
  "--stdin names the failing input, without repeating the server's log of the same error");

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
