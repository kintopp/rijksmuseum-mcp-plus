#!/usr/bin/env node
/**
 * warm-cache.mjs — Post-deployment cache warming script
 *
 * Connects to a rijksmuseum-mcp+ server via Streamable HTTP and exercises
 * tool calls defined in a TSV file to warm SQLite page cache, response cache,
 * and vocabulary cache.
 *
 * Usage:
 *   node scripts/warm-cache.mjs [--url URL] [--file PATH] [--concurrency N]
 *
 * Defaults:
 *   --url         https://rijksmuseum-mcp-plus-production.up.railway.app/mcp
 *   --file        scripts/warm-cache-prompts.tsv
 *   --concurrency 1 (sequential)
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_URL = "https://rijksmuseum-mcp-plus-production.up.railway.app/mcp";
const DEFAULT_FILE = resolve(__dirname, "warm-cache-prompts.tsv");

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { url: DEFAULT_URL, file: DEFAULT_FILE, concurrency: 1 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--url" && args[i + 1]) opts.url = args[++i];
    else if (args[i] === "--file" && args[i + 1]) opts.file = resolve(args[++i]);
    else if (args[i] === "--concurrency" && args[i + 1]) opts.concurrency = parseInt(args[++i], 10);
    else if (args[i] === "--help" || args[i] === "-h") {
      console.log("Usage: node scripts/warm-cache.mjs [--url URL] [--file PATH] [--concurrency N]");
      process.exit(0);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// TSV parser
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function runCall(client, { name, args }, index, total) {
  const label = `[${String(index + 1).padStart(String(total).length)}/${total}] ${name}`;
  const argsShort = JSON.stringify(args);
  const start = performance.now();
  try {
    const result = await client.callTool({ name, arguments: args });
    const ms = (performance.now() - start).toFixed(0);
    const isError = result.isError;
    if (isError) {
      const msg = result.content?.[0]?.text ?? "(no message)";
      console.log(`${label}  ${ms}ms  ERROR  ${argsShort}  → ${msg.slice(0, 120)}`);
      return false;
    }
    console.log(`${label}  ${ms}ms  OK  ${argsShort}`);
    return true;
  } catch (e) {
    const ms = (performance.now() - start).toFixed(0);
    console.log(`${label}  ${ms}ms  FAIL  ${argsShort}  → ${e.message?.slice(0, 120)}`);
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

  console.log(`Connecting to ${opts.url}`);
  console.log(`Loaded ${prompts.length} tool calls from ${opts.file}`);
  console.log(`Concurrency: ${opts.concurrency}\n`);

  // Connect MCP client
  const transport = new StreamableHTTPClientTransport(new URL(opts.url));
  const client = new Client({ name: "warm-cache", version: "1.0.0" });
  await client.connect(transport);
  console.log("Connected.\n");

  const totalStart = performance.now();
  let successes = 0;
  let failures = 0;

  if (opts.concurrency <= 1) {
    // Sequential
    for (let i = 0; i < prompts.length; i++) {
      const ok = await runCall(client, prompts[i], i, prompts.length);
      ok ? successes++ : failures++;
    }
  } else {
    // Concurrent with bounded parallelism
    let nextIdx = 0;
    const runNext = async () => {
      while (nextIdx < prompts.length) {
        const idx = nextIdx++;
        const ok = await runCall(client, prompts[idx], idx, prompts.length);
        ok ? successes++ : failures++;
      }
    };
    const workers = Array.from(
      { length: Math.min(opts.concurrency, prompts.length) },
      () => runNext()
    );
    await Promise.all(workers);
  }

  const totalMs = ((performance.now() - totalStart) / 1000).toFixed(1);

  console.log(`\n─── Summary ───`);
  console.log(`Total:     ${prompts.length} calls`);
  console.log(`Succeeded: ${successes}`);
  console.log(`Failed:    ${failures}`);
  console.log(`Time:      ${totalMs}s`);

  await client.close();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
