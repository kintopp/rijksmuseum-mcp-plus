/**
 * Run scripts/cli.mjs as a child process whose stdio server reads a freshly built
 * fixture vocab DB (FX-1…FX-9). Needs ./dist.
 *
 * `name` picks the fixture file (fixture-<name>.db) — one per test file, since the
 * runner runs tests in parallel and the builder deletes the file before seeding.
 */
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildFixture } from "./build-fixture-vocab-db.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = path.join(PROJECT_ROOT, "scripts", "cli.mjs");

export function fixtureCli(name) {
  // RIJKS_MCP_HTTP would send every call to a remote server instead of the fixture.
  const { RIJKS_MCP_HTTP, ...base } = process.env;
  const env = { ...base, VOCAB_DB_PATH: buildFixture(`fixture-${name}.db`), ENABLE_FIND_SIMILAR: "true" };
  /** Resolve with {code, stdout, stderr}; never rejects. `input` is piped to stdin. */
  return (args, { input } = {}) => new Promise((resolve) => {
    const child = execFile(process.execPath, [CLI, ...args], { cwd: PROJECT_ROOT, env, timeout: 60000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout: stdout ?? "", stderr: stderr ?? "" }));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}
