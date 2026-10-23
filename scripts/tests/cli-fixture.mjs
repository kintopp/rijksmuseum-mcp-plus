/**
 * Shared helpers for the CLI tests: run scripts/cli.mjs as a child process, optionally
 * with its stdio server reading a freshly built fixture vocab DB (FX-1…FX-9). Needs ./dist.
 */
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildFixture } from "./build-fixture-vocab-db.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = path.join(PROJECT_ROOT, "scripts", "cli.mjs");

/** Resolve with {code, killed, stdout, stderr}; never rejects. `input` is piped to stdin. */
export function runCli(args, { env = {}, input, timeout = 90000 } = {}) {
  // An exported RIJKS_MCP_HTTP would send every call to a remote server instead of the
  // stdio child; tests that want HTTP pass --http, which overrides it inside the CLI.
  const { RIJKS_MCP_HTTP, ...base } = process.env;
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [CLI, ...args],
      { cwd: PROJECT_ROOT, env: { ...base, ...env }, timeout, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({
        code: err ? (err.code ?? 1) : 0, killed: !!err?.killed, stdout: stdout ?? "", stderr: stderr ?? "",
      }));
    child.stdin.end(input);
  });
}

/**
 * `runCli` bound to a fixture DB. `name` picks the fixture file (fixture-<name>.db) — one per
 * test file, since the runner runs tests in parallel and the builder deletes the file first.
 */
export function fixtureCli(name) {
  const env = { VOCAB_DB_PATH: buildFixture(`fixture-${name}.db`), ENABLE_FIND_SIMILAR: "true" };
  return (args, opts = {}) => runCli(args, { env, timeout: 60000, ...opts });
}

export const parseJson = (s) => { try { return JSON.parse(s); } catch { return null; } };
export const jsonlRows = (s) => s.trim().split("\n").filter(Boolean).map(parseJson);
