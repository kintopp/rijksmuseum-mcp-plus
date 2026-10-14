/**
 * Spawn the built server (dist/index.js) over stdio on a freshly built fixture
 * vocab DB and return a connected MCP client. Needs ./dist.
 *
 * `name` picks the fixture file (fixture-<name>.db): each test needs its own,
 * because the builder deletes the file before seeding and the runner runs
 * tests in parallel.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFixture } from "./build-fixture-vocab-db.mjs";
import { resolveDbPath } from "../../dist/utils/db.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// Full roster with ENABLE_FIND_SIMILAR=true. Bump when a tool is added; it is
// pinned so a SHRINKING roster can't quietly shrink the gates that count it.
export const TOOL_COUNT = 20;

// No fixture stands in for the embeddings or Gemma DB, so semantic_search and
// multimodal_search register only where a real one exists (not in CI).
export const HAS_EMBEDDINGS_DB = resolveDbPath("EMBEDDINGS_DB_PATH", "embeddings.db") !== null;
export const HAS_GEMMA_DB = resolveDbPath("GEMMA_DB_PATH", "gemma.db") !== null;
export const EXPECTED_TOOL_COUNT = TOOL_COUNT - (HAS_EMBEDDINGS_DB ? 0 : 1) - (HAS_GEMMA_DB ? 0 : 1);

export async function connectFixtureClient(name, env = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(PROJECT_ROOT, "dist", "index.js")],
    env: {
      ...process.env,
      MCP_SKIP_STARTUP_WARM: "1",
      ENABLE_FIND_SIMILAR: "true",
      STRUCTURED_CONTENT: "true",
      VOCAB_DB_PATH: buildFixture(`fixture-${name}.db`),
      ...env,
    },
    stderr: "ignore",
  });
  const client = new Client({ name: `test-${name}`, version: "0.0.0" });
  await client.connect(transport);
  return client;
}
