#!/usr/bin/env node
/**
 * warm-cache-local.mjs — Local cache warming / smoke-test script
 *
 * Spawns a local MCP server via stdio transport and exercises tool calls
 * defined in the same TSV file used by warm-cache.mjs. Unlike the HTTP
 * variant, this requires no running server — it launches `node dist/index.js`
 * directly. Useful for testing tools that depend on local-only databases
 * (e.g. iconclass.db not yet deployed to Railway).
 *
 * Usage:
 *   node scripts/warm-cache-local.mjs [--file PATH] [--concurrency N]
 *
 * Defaults:
 *   --file        scripts/warm-cache-prompts.tsv
 *   --concurrency 1 (sequential)
 *
 * Examples:
 *   node scripts/warm-cache-local.mjs                        # all prompts
 *   node scripts/warm-cache-local.mjs --concurrency 4        # parallel
 *   node scripts/warm-cache-local.mjs --file my-prompts.tsv  # custom prompts
 *
 * The prompt file is tab-separated: tool_name<TAB>json_args
 * Lines starting with # are comments; blank lines are ignored.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");

const DEFAULT_FILE = resolve(__dirname, "warm-cache-prompts.tsv");

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { file: DEFAULT_FILE, concurrency: 1 };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--file":        opts.file = resolve(args[++i]); break;
      case "--concurrency": opts.concurrency = parseInt(args[++i], 10); break;
      case "--help":
      case "-h":
        console.log("Usage: node scripts/warm-cache-local.mjs [--file PATH] [--concurrency N]");
        process.exit(0);
    }
  }
  return opts;
}

function parseTsv(filePath) {
  const lines = readFileSync(filePath, "utf-8").split("\n");
  const prompts = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const tabIdx = line.indexOf("\t");
    if (tabIdx === -1) {
      console.warn(`⚠ Skipping malformed line (no tab): ${line}`);
      continue;
    }
    const name = line.slice(0, tabIdx).trim();
    const argsStr = line.slice(tabIdx + 1).trim();
    try {
      const args = JSON.parse(argsStr);
      prompts.push({ name, args });
    } catch (e) {
      console.warn(`⚠ Skipping line with invalid JSON: ${line}`);
    }
  }
  return prompts;
}

async function runCall(client, { name, args }, index, total) {
  const label = `[${String(index + 1).padStart(String(total).length)}/${total}] ${name}`;
  const argsShort = JSON.stringify(args);
  const start = performance.now();
  try {
    const result = await client.callTool({ name, arguments: args });
    const ms = (performance.now() - start).toFixed(0);
    if (result.isError) {
      const msg = result.content?.[0]?.text ?? "(no message)";
      console.log(`${label}  ${ms}ms  ERROR  ${argsShort}  -> ${msg.slice(0, 120)}`);
      return false;
    }
    console.log(`${label}  ${ms}ms  OK  ${argsShort}`);
    return true;
  } catch (e) {
    const ms = (performance.now() - start).toFixed(0);
    console.log(`${label}  ${ms}ms  FAIL  ${argsShort}  -> ${e.message?.slice(0, 120)}`);
    return false;
  }
}

async function main() {
  const opts = parseArgs();
  const prompts = parseTsv(opts.file);

  if (prompts.length === 0) {
    console.error("No prompts found in", opts.file);
    process.exit(1);
  }

  console.log(`Spawning local server: node dist/index.js (stdio)`);
  console.log(`Loaded ${prompts.length} tool calls from ${opts.file}`);
  console.log(`Concurrency: ${opts.concurrency}\n`);

  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    cwd: PROJECT_ROOT,
  });
  const client = new Client({ name: "warm-cache-local", version: "1.0.0" });
  await client.connect(transport);
  console.log("Connected.\n");

  const totalStart = performance.now();
  let successes = 0;
  let failures = 0;

  let nextIdx = 0;
  async function worker() {
    while (nextIdx < prompts.length) {
      const idx = nextIdx++;
      const ok = await runCall(client, prompts[idx], idx, prompts.length);
      ok ? successes++ : failures++;
    }
  }
  const workerCount = Math.min(opts.concurrency, prompts.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const totalSec = ((performance.now() - totalStart) / 1000).toFixed(1);

  console.log(`\n--- Summary ---`);
  console.log(`Total:     ${prompts.length} calls`);
  console.log(`Succeeded: ${successes}`);
  console.log(`Failed:    ${failures}`);
  console.log(`Time:      ${totalSec}s`);

  await transport.close();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
