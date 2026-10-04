#!/usr/bin/env node
// Skill A/B on open-ended research prompts: does the skill widen or narrow how the
// model approaches a question? Each arm runs the same MCP server; skill arms get the
// SKILL.md body force-loaded into the system prompt (no trigger lottery) with its
// references/ readable from the cwd. Every arm gets the Read tool so rosters match.
//
//   node scripts/bench/skill-ab.mjs [--variant name=<skill dir>]... [--no-none]
//        [--runs N] [--only id,id] [--model sonnet|opus] [--concurrency N] [--budget <usd>]
//
// Default arms: "none" and "current" (docs/skills/rijksmuseum-mcp-plus). Always runs the
// local build (dist/index.js). Judge the output with skill-judge.mjs <results dir>.

import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { benchDir, LOCAL_SERVER, SKILL_DIR } from "./common.mjs";

const SERVER_NAME = "rijksmuseum";
const SYSTEM_NOTE =
  "You are answering a research question about the Rijksmuseum collection in a non-interactive session. " +
  "You cannot ask follow-up questions; use the tools available to you and give your best final answer.";

function parseArgs(argv) {
  const opts = { variants: [], none: true, runs: 2, only: null, model: "sonnet", concurrency: 3, budget: 3, timeoutSec: 1200 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    switch (a) {
      case "--variant": { const [name, dir] = next().split("="); opts.variants.push({ name, dir: path.resolve(dir) }); break; }
      case "--no-none": opts.none = false; break;
      case "--runs": opts.runs = Number(next()); break;
      case "--only": opts.only = next().split(","); break;
      case "--model": opts.model = next(); break;
      case "--concurrency": opts.concurrency = Number(next()); break;
      case "--budget": opts.budget = Number(next()); break;
      default: console.error(`Unknown flag: ${a}`); process.exit(2);
    }
  }
  if (!opts.variants.length) opts.variants.push({ name: "current", dir: SKILL_DIR });
  return opts;
}

const stripFrontmatter = (md) => md.replace(/^---\n[\s\S]*?\n---\n/, "");

function armSetup(arm) {
  const cwd = mkdtempSync(path.join(tmpdir(), `rijks-ab-${arm.name}-`));
  if (!arm.dir) return { cwd, system: SYSTEM_NOTE };
  cpSync(path.join(arm.dir, "references"), path.join(cwd, "references"), { recursive: true });
  const body = stripFrontmatter(readFileSync(path.join(arm.dir, "SKILL.md"), "utf8"));
  return {
    cwd,
    system: `${SYSTEM_NOTE}\n\nThe following research skill is loaded. Its references/ files are readable from the working directory.\n\n<skill>\n${body}\n</skill>`,
  };
}

function claudeArgs(prompt, setup, opts) {
  return [
    "-p", prompt,
    "--output-format", "stream-json", "--verbose",
    "--model", opts.model,
    "--append-system-prompt", setup.system,
    "--strict-mcp-config", "--no-session-persistence",
    "--permission-mode", "dontAsk",
    "--max-budget-usd", String(opts.budget),
    "--setting-sources", "", "--disable-slash-commands",
    "--mcp-config", JSON.stringify({ mcpServers: { [SERVER_NAME]: { type: "stdio", ...LOCAL_SERVER } } }),
    "--tools", "Read",
    "--allowedTools", `mcp__${SERVER_NAME}`, "Read",
  ];
}

function runClaude(args, cwd, timeoutSec) {
  return new Promise((resolve) => {
    const child = spawn("claude", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (d) => { stdout += d; });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutSec * 1000);
    child.on("close", () => { clearTimeout(timer); resolve(stdout); });
  });
}

function parseStream(stdout) {
  let result = null;
  const calls = [];
  for (const line of stdout.split("\n")) {
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === "result") result = ev;
    if (ev.type === "assistant") {
      for (const b of ev.message?.content ?? []) {
        if (b.type === "tool_use") calls.push({ tool: b.name.replace(`mcp__${SERVER_NAME}__`, ""), input: b.input });
      }
    }
  }
  return result && { result, calls };
}

// Strategy signature = tool + the set of parameters it was called with; distinct
// signatures approximate how many different routes into the data were tried.
function metrics(calls, answer) {
  const mcp = calls.filter((c) => c.tool !== "Read");
  const sigs = new Set(mcp.map((c) => `${c.tool}(${Object.keys(c.input ?? {}).sort().join(",")})`));
  const objects = new Set((answer.match(/\b[A-Z]{1,4}(?:-[A-Z0-9]+)+(?:\([^)]*\))?/g) ?? []).filter((s) => /\d/.test(s)));
  return {
    calls: mcp.length,
    distinctTools: new Set(mcp.map((c) => c.tool)).size,
    distinctSignatures: sigs.size,
    referenceReads: calls.length - mcp.length,
    objectNumbersCited: objects.size,
    answerChars: answer.length,
  };
}

async function pool(items, size, worker) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, size) }, async () => {
    while (next < items.length) await worker(items[next++]);
  }));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let prompts = JSON.parse(readFileSync(path.join(benchDir, "open-prompts.json"), "utf8"));
  if (opts.only) prompts = prompts.filter((p) => opts.only.includes(p.id));
  const arms = [...(opts.none ? [{ name: "none", dir: null }] : []), ...opts.variants];
  const setups = Object.fromEntries(arms.map((a) => [a.name, armSetup(a)]));

  const jobs = [];
  for (let run = 1; run <= opts.runs; run++)
    for (const p of prompts) for (const a of arms) jobs.push({ p, arm: a.name, run });

  const outDir = path.join(benchDir, "results", `ab-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}`);
  mkdirSync(outDir, { recursive: true });
  console.log(`${jobs.length} sessions (${arms.map((a) => a.name).join(", ")}) → ${path.relative(process.cwd(), outDir)}`);

  let total = 0;
  await pool(jobs, opts.concurrency, async ({ p, arm, run }) => {
    const parsed = parseStream(await runClaude(claudeArgs(p.prompt, setups[arm], opts), setups[arm].cwd, opts.timeoutSec));
    const base = `${p.id}__${arm}__run${run}`;
    if (!parsed) { console.log(`  ${base} ... ERROR`); return; }
    const answer = parsed.result.result ?? "";
    const m = metrics(parsed.calls, answer);
    total += parsed.result.total_cost_usd ?? 0;
    writeFileSync(path.join(outDir, `${base}.json`), JSON.stringify({
      prompt: p.id, arm, run, cost: parsed.result.total_cost_usd, turns: parsed.result.num_turns,
      subtype: parsed.result.subtype, metrics: m, calls: parsed.calls, answer,
    }, null, 2));
    console.log(`  ${base} ... $${(parsed.result.total_cost_usd ?? 0).toFixed(3)}, ${m.calls} calls, ${m.distinctSignatures} signatures, ${m.objectNumbersCited} objects`);
  });
  console.log(`Total $${total.toFixed(2)}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
