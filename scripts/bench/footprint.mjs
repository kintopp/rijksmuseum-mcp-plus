#!/usr/bin/env node
// Server token footprint: what the server itself puts in front of a model, independent
// of the host. Measures the tool catalogue (full definitions and the one-line leads a
// deferred catalogue shows), the response size of each prompt's probe calls in
// prompts.json, and the skill package. No model runs; counts come from the free
// token-counting endpoint when ANTHROPIC_API_KEY is set (env or the project .env),
// else from a chars/4 estimate.
//
//   node scripts/bench/footprint.mjs [--local | --server <url>] [--model <id>] [--json]

import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SERVER, headerHelp, loadPrompts, LOCAL_SERVER, projectRoot, serverLabel, SKILL_DIR } from "./common.mjs";

function parseArgs(argv) {
  const opts = { server: DEFAULT_SERVER, local: false, model: "claude-sonnet-5-5", json: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--server": opts.server = argv[++i]; break;
      case "--local": opts.local = true; break;
      case "--model": opts.model = argv[++i]; break;
      case "--json": opts.json = true; break;
      case "-h": case "--help": console.log(headerHelp(fileURLToPath(import.meta.url))); process.exit(0);
      default: console.error(`Unknown flag: ${argv[i]}`); process.exit(2);
    }
  }
  return opts;
}

// Counts are differences against an empty baseline request, so they exclude the fixed
// per-request framing but include the tool-use system prompt the API adds once tools exist.
function makeCounter(model) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { exact: false, text: async (t) => Math.ceil(t.length / 4), tools: async (tools) => Math.ceil(JSON.stringify(tools).length / 4) };
  }
  const client = new Anthropic();
  const messages = (t) => [{ role: "user", content: t || "." }];
  const raw = async (extra) => (await client.messages.countTokens({ model, messages: messages("."), ...extra })).input_tokens;
  let baseline; // one shared request, awaited by every parallel count
  const diff = async (extra) => {
    const [total, base] = await Promise.all([raw(extra), (baseline ??= raw({}))]);
    return total - base;
  };
  return {
    exact: true,
    text: (t) => diff({ messages: messages(t) }),
    tools: (tools) => diff({ tools }),
  };
}

const toApiTool = (t) => ({ name: t.name, description: t.description ?? "", input_schema: t.inputSchema });
const lead = (d = "") => d.split(/(?<=[.!?])\s/)[0];
const isAppOnly = (t) => {
  const vis = t._meta?.ui?.visibility;
  return Array.isArray(vis) && vis.length > 0 && !vis.includes("model");
};

async function connect(opts) {
  const transport = opts.local
    ? new StdioClientTransport({ ...LOCAL_SERVER, env: { ...process.env, ...LOCAL_SERVER.env }, stderr: "ignore" })
    : new StreamableHTTPClientTransport(new URL(opts.server));
  const client = new Client({ name: "rijks-footprint", version: "0.1" });
  await client.connect(transport);
  return client;
}

function skillParts() {
  const raw = readFileSync(path.join(SKILL_DIR, "SKILL.md"), "utf8");
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n/);
  return [
    { label: "SKILL.md frontmatter (always loaded)", text: fm ? fm[1] : "" },
    { label: "SKILL.md body (loaded on trigger)", text: fm ? raw.slice(fm[0].length) : raw },
    ...readdirSync(path.join(SKILL_DIR, "references")).sort().map((f) =>
      ({ label: `references/${f}`, text: readFileSync(path.join(SKILL_DIR, "references", f), "utf8") })),
  ];
}

async function measureServer(opts, count) {
  const client = await connect(opts);
  try {
    const visible = (await client.listTools()).tools.filter((t) => !isAppOnly(t));
    const probes = loadPrompts().flatMap((p) => (p.probes ?? []).map((probe) => ({ label: `${p.id}: ${probe.tool}`, ...probe })));
    const [fullDefinitions, leadsOnly, tools, probeResults] = await Promise.all([
      count.tools(visible.map(toApiTool)),
      count.text(visible.map((t) => `${t.name}: ${lead(t.description)}`).join("\n")),
      Promise.all(visible.map(async (t) => ({ name: t.name, tokens: await count.tools([toApiTool(t)]) }))),
      Promise.all(probes.map(async ({ label, tool, args }) => {
        try {
          const res = await client.callTool({ name: tool, arguments: args });
          const text = (res.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
          return { label, tool, isError: Boolean(res.isError), tokens: await count.text(text) };
        } catch (err) {
          return { label, tool, isError: true, error: String(err.message ?? err), tokens: 0 };
        }
      })),
    ]);
    return {
      catalogue: { toolCount: visible.length, fullDefinitions, leadsOnly },
      tools: tools.sort((a, b) => b.tokens - a.tokens),
      probes: probeResults,
    };
  } finally {
    await client.close();
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  try { process.loadEnvFile(path.join(projectRoot, ".env")); } catch { /* no .env */ }
  const count = makeCounter(opts.model);
  const [server, skill] = await Promise.all([
    measureServer(opts, count),
    Promise.all(skillParts().map(async ({ label, text }) => ({ label, tokens: await count.text(text) }))),
  ]);
  const report = { server: serverLabel(opts), model: opts.model, exact: count.exact, ...server, skill };

  if (opts.json) { console.log(JSON.stringify(report, null, 2)); return; }

  const n = (x) => x.toLocaleString("en-US").padStart(7);
  const unit = count.exact ? `tokens (${opts.model} token counter)` : "tokens (ESTIMATE: chars/4; set ANTHROPIC_API_KEY for exact counts)";
  console.log(`Server: ${report.server} | ${unit}\n`);
  console.log("Tool catalogue");
  console.log(`  ${n(report.catalogue.fullDefinitions)}  all ${report.catalogue.toolCount} model-visible tools, full definitions (loaded up front by hosts that don't defer tools)`);
  console.log(`  ${n(report.catalogue.leadsOnly)}  names + one-line leads only (roughly what a deferred tool catalogue shows)`);
  console.log(`\nPer tool (full definition${count.exact ? ", incl. the API's fixed tool-use preamble" : ""})`);
  for (const t of report.tools) console.log(`  ${n(t.tokens)}  ${t.name}`);
  console.log("\nResponse size of each prompt's probe calls (text content the model reads)");
  for (const p of report.probes) console.log(`  ${n(p.tokens)}  ${p.label}${p.isError ? `  [error${p.error ? `: ${p.error}` : ""}]` : ""}`);
  console.log("\nSkill package");
  for (const s of report.skill) console.log(`  ${n(s.tokens)}  ${s.label}`);
}

main().catch((err) => { console.error(err.message ?? err); process.exit(1); });
