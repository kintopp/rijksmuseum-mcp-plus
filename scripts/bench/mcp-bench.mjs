#!/usr/bin/env node
// Token/cost benchmark: runs each prompt through headless Claude Code with the
// Rijksmuseum MCP server ("mcp" arm), with web tools only ("baseline" arm), and
// optionally with the server plus the skill from docs/skills ("mcp+skill" arm).
// Cost is Claude Code's own total_cost_usd, which is computed at API list price
// even when the session itself is billed to a subscription.
//
//   node scripts/bench/mcp-bench.mjs [--model sonnet|opus|both] [--runs N]
//        [--only id,id] [--arms mcp,baseline,mcp+skill] [--skill] [--server <url>]
//        [--effort <level>] [--concurrency N] [--budget <usd>] [--cold] [--dry-run]
//
// Targets the local dist/ build over stdio unless --server is given, so benchmark
// bursts don't load the production server.
//
// Before measuring, one trivial session per arm and model warms the prompt cache with
// that arm's system prompt and tool descriptions, so measured sessions don't depend on
// run order; its cost is reported separately as the entry cost. --cold skips it.

import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { benchDir, DEFAULT_SERVER, headerHelp, loadPrompts, LOCAL_SERVER, serverLabel, SKILL_DIR } from "./common.mjs";

// Aliases resolve to the latest model of each family inside Claude Code.
// Effort defaults mirror each model's API default (Sonnet: high, Opus: medium).
const MODELS = {
  sonnet: { alias: "sonnet", effort: "high" },
  opus: { alias: "opus", effort: "medium" },
};
const SERVER_NAME = "rijksmuseum";
// The skill arm loads the skill from its cwd's .claude/skills, so project settings must be on.
// Claude Code can't drop its built-in skills without also dropping ours, so their listing
// (~3.5K tokens) rides along in that arm only. Read is for the skill's references/ files.
const ARMS = {
  mcp: { mcp: true, skill: false, tools: [], compareTo: ["baseline"] },
  "mcp+skill": { mcp: true, skill: true, tools: ["Skill", "Read"], compareTo: ["baseline", "mcp"] },
  baseline: { mcp: false, skill: false, tools: ["WebSearch", "WebFetch"], compareTo: [] },
};
const SYSTEM_NOTE =
  "You are answering a research question about the Rijksmuseum collection in a non-interactive session. " +
  "You cannot ask follow-up questions; use the tools available to you and give your best final answer.";

function parseArgs(argv) {
  const opts = {
    model: "sonnet", runs: 1, only: null, arms: ["mcp", "baseline"], server: DEFAULT_SERVER,
    local: true, effort: null, concurrency: 1, budget: 3, timeoutSec: 900, dryRun: false, cold: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--model": opts.model = next(); break;
      case "--runs": opts.runs = Number(next()); break;
      case "--only": opts.only = next().split(","); break;
      case "--arms": opts.arms = next().split(","); break;
      case "--skill": if (!opts.arms.includes("mcp+skill")) opts.arms.push("mcp+skill"); break;
      case "--server": opts.server = next(); opts.local = false; break;
      case "--local": opts.local = true; break;
      case "--effort": opts.effort = next(); break;
      case "--concurrency": opts.concurrency = Number(next()); break;
      case "--budget": opts.budget = Number(next()); break;
      case "--timeout": opts.timeoutSec = Number(next()); break;
      case "--dry-run": opts.dryRun = true; break;
      case "--cold": opts.cold = true; break;
      case "-h": case "--help": console.log(headerHelp(fileURLToPath(import.meta.url))); process.exit(0);
      default: console.error(`Unknown flag: ${a}`); process.exit(2);
    }
  }
  const models = opts.model === "both" ? ["sonnet", "opus"] : [opts.model];
  for (const m of models) if (!MODELS[m]) { console.error(`--model must be sonnet, opus or both`); process.exit(2); }
  for (const arm of opts.arms) if (!ARMS[arm]) { console.error(`Unknown arm: ${arm} (use ${Object.keys(ARMS).join(", ")})`); process.exit(2); }
  return { ...opts, models };
}

function mcpConfig(opts) {
  const server = opts.local ? { type: "stdio", ...LOCAL_SERVER } : { type: "http", url: opts.server };
  return JSON.stringify({ mcpServers: { [SERVER_NAME]: server } });
}

function claudeArgs(job, opts) {
  const arm = ARMS[job.arm];
  return [
    "-p", job.prompt.prompt,
    "--output-format", "stream-json", "--verbose",
    "--model", MODELS[job.model].alias,
    "--effort", opts.effort ?? MODELS[job.model].effort,
    "--append-system-prompt", SYSTEM_NOTE,
    // Isolate from the user's settings, hooks, skills and MCP servers so all arms start equal.
    "--strict-mcp-config",
    "--no-session-persistence",
    "--permission-mode", "dontAsk",
    "--max-budget-usd", String(opts.budget),
    ...(arm.skill ? ["--setting-sources", "project"] : ["--setting-sources", "", "--disable-slash-commands"]),
    ...(arm.mcp ? ["--mcp-config", mcpConfig(opts)] : []),
    "--tools", arm.tools.join(","),
    "--allowedTools", ...(arm.mcp ? [`mcp__${SERVER_NAME}`] : []), ...arm.tools,
  ];
}

function runClaude(args, cwd, timeoutSec) {
  return new Promise((resolve) => {
    const child = spawn("claude", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutSec * 1000);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function parseStream(stdout) {
  let result = null;
  const toolCalls = {};
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === "result") result = ev;
    if (ev.type === "assistant") {
      for (const block of ev.message?.content ?? []) {
        if (block.type === "tool_use") {
          const name = block.name.replace(`mcp__${SERVER_NAME}__`, "");
          toolCalls[name] = (toolCalls[name] ?? 0) + 1;
        }
      }
    }
  }
  return result ? { result, toolCalls } : null;
}

function summarise(result, toolCalls) {
  let tokens = 0;
  const models = [];
  for (const [model, u] of Object.entries(result.modelUsage ?? {})) {
    models.push(model);
    tokens += (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0);
  }
  return {
    tokens,
    cost: result.total_cost_usd ?? 0,
    turns: result.num_turns ?? 0,
    seconds: Math.round((result.duration_ms ?? 0) / 1000),
    models,
    toolCalls,
    nCalls: sum(Object.values(toolCalls)),
    subtype: result.subtype,
    isError: Boolean(result.is_error),
  };
}

const missingExpect = (text, expect) => expect.filter((re) => !new RegExp(re, "i").test(text ?? ""));
const jobLabel = (job) => `${job.prompt.id} / ${job.arm} / ${job.model} / run ${job.run}`;
const fmtInt = (n) => n.toLocaleString("en-US");
const fmtUsd = (n) => `$${n.toFixed(3)}`;
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => sum(xs) / (xs.length || 1);

async function pool(items, size, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.max(1, size) }, async () => {
    while (next < items.length) await worker(items[next++]);
  });
  await Promise.all(runners);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let prompts = loadPrompts();
  if (opts.only) prompts = prompts.filter((p) => opts.only.includes(p.id));
  if (!prompts.length) { console.error("No prompts selected"); process.exit(2); }

  const jobs = [];
  for (let run = 1; run <= opts.runs; run++)
    for (const prompt of prompts)
      for (const model of opts.models)
        for (const arm of opts.arms) jobs.push({ prompt, model, arm, run });

  const effortLabel = opts.models.map((m) => `${m}=${opts.effort ?? MODELS[m].effort}`).join(", ");
  console.log(`Server: ${serverLabel(opts)} | ${prompts.length} prompt(s) x ${opts.models.length} model(s) x ${opts.arms.length} arm(s) x ${opts.runs} run(s) = ${jobs.length} sessions`);
  console.log(`Effort: ${effortLabel} | Cost: API list price (Claude Code total_cost_usd), per-session cap $${opts.budget}`);

  if (opts.dryRun) {
    for (const job of jobs) console.log(`\n${jobLabel(job)}\n  claude ${claudeArgs(job, opts).map((a) => JSON.stringify(a)).join(" ")}`);
    return;
  }
  const outDir = path.join(benchDir, "results", new Date().toISOString().slice(0, 19).replace(/:/g, "-"));
  mkdirSync(outDir, { recursive: true });
  console.log(`Results: ${path.relative(process.cwd(), outDir)}\n`);

  // An empty cwd keeps the project CLAUDE.md and git status out of every session.
  const plainCwd = mkdtempSync(path.join(tmpdir(), "rijks-bench-"));
  const skillCwd = mkdtempSync(path.join(tmpdir(), "rijks-bench-skill-"));
  cpSync(SKILL_DIR, path.join(skillCwd, ".claude/skills/rijksmuseum-mcp-plus"), { recursive: true });

  const runJob = async (job) => {
    const out = await runClaude(claudeArgs(job, opts), ARMS[job.arm].skill ? skillCwd : plainCwd, opts.timeoutSec);
    return { ...out, parsed: parseStream(out.stdout) };
  };

  // Every warm-up must finish before measuring starts; each warms a distinct prefix, so they
  // can run in parallel. Only the shared prefix (system prompt + tools) warms; the skill body
  // loads mid-conversation.
  let warmupTotal = 0;
  if (!opts.cold) {
    const warmJobs = opts.models.flatMap((model) => opts.arms.map((arm) =>
      ({ prompt: { id: "warmup", prompt: "Reply with just: ok" }, model, arm, run: 0 })));
    const warm = await Promise.all(warmJobs.map(async (job) => {
      const cost = (await runJob(job)).parsed?.result.total_cost_usd ?? null;
      warmupTotal += cost ?? 0;
      return `${job.arm}${opts.models.length > 1 ? ` (${job.model})` : ""} ${cost === null ? "failed" : fmtUsd(cost)}`;
    }));
    console.log(`Cache warm-up (entry cost): ${warm.join(" · ")}\n`);
  }

  const rows = [];
  await pool(jobs, opts.concurrency, async (job) => {
    const { code, signal, stdout, stderr, parsed } = await runJob(job);
    const base = `${job.prompt.id}__${job.arm}__${job.model}__run${job.run}`;
    if (!parsed) {
      writeFileSync(path.join(outDir, `${base}.err.txt`), `exit ${code} ${signal ?? ""}\n${stderr}\n${stdout}`);
      console.log(`  ${jobLabel(job)} ... ERROR (exit ${code}${signal ? `, ${signal}` : ""}; see ${base}.err.txt)`);
      rows.push({ job, s: null, passed: false, verdict: "error" });
      return;
    }
    const { result, toolCalls } = parsed;
    writeFileSync(path.join(outDir, `${base}.json`), JSON.stringify({ ...result, toolCalls }, null, 2));
    const s = summarise(result, toolCalls);
    const missing = missingExpect(result.result, job.prompt.expect);
    const passed = !s.isError && missing.length === 0;
    const verdict = s.isError ? `session ${s.subtype}`
      : passed ? "expect ok" : `expect FAIL (missing ${missing.map((m) => `/${m}/`).join(", ")})`;
    const skillNote = ARMS[job.arm].skill ? (toolCalls.Skill ? ", skill loaded" : ", skill NOT loaded") : "";
    rows.push({ job, s, passed, verdict });
    console.log(`  ${jobLabel(job)} ... ${fmtInt(s.tokens)} tokens, ${fmtUsd(s.cost)}, ${s.turns} turns, ${s.nCalls} tool calls, ${s.seconds}s${skillNote}, ${verdict}`);
  });

  const csv = ["prompt,tier,arm,model,run,tokens,cost_usd,turns,seconds,models_used,tool_calls,verdict"];
  for (const { job, s, verdict } of rows) {
    csv.push([job.prompt.id, job.prompt.tier, job.arm, job.model, job.run,
      s?.tokens ?? "", s?.cost.toFixed(4) ?? "", s?.turns ?? "", s?.seconds ?? "",
      s?.models.join("+") ?? "",
      JSON.stringify(s ? Object.entries(s.toolCalls).map(([k, v]) => `${k}:${v}`).join(" ") : ""),
      JSON.stringify(verdict)].join(","));
  }
  writeFileSync(path.join(outDir, "summary.csv"), csv.join("\n") + "\n");

  console.log("\nMeans (passed = expectation met / runs):");
  for (const prompt of prompts) {
    for (const model of opts.models) {
      const byArm = {};
      for (const arm of opts.arms) {
        const ok = rows.filter((r) => r.job.prompt.id === prompt.id && r.job.model === model && r.job.arm === arm && r.s);
        if (!ok.length) continue;
        const avg = (k) => mean(ok.map((r) => r.s[k]));
        byArm[arm] = { tokens: avg("tokens"), cost: avg("cost") };
        console.log(`  ${prompt.id} / ${arm} / ${model} ... ${fmtInt(Math.round(byArm[arm].tokens))} tokens, ${fmtUsd(byArm[arm].cost)}, ` +
          `${avg("turns").toFixed(1)} turns, ${Math.round(avg("seconds"))}s, passed ${ok.filter((r) => r.passed).length}/${ok.length}`);
      }
      for (const a of opts.arms) {
        for (const b of ARMS[a].compareTo) {
          if (byArm[a] && byArm[b]) {
            console.log(`    ${a}/${b}: ${(byArm[a].tokens / byArm[b].tokens).toFixed(2)}x tokens, ${(byArm[a].cost / byArm[b].cost).toFixed(2)}x cost`);
          }
        }
      }
    }
  }
  console.log(`\nTotal at API list price: ${fmtUsd(sum(rows.map((r) => r.s?.cost ?? 0)))} across ${rows.length} sessions` +
    (opts.cold ? "" : `, plus ${fmtUsd(warmupTotal)} cache warm-up`));
}

main().catch((err) => { console.error(err); process.exit(1); });
