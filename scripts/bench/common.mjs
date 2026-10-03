// Shared by mcp-bench.mjs and footprint.mjs.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const benchDir = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(benchDir, "../..");
export const DEFAULT_SERVER = "https://rijksmuseum-mcp-plus-production.up.railway.app/mcp";
export const SKILL_DIR = path.join(projectRoot, "docs/skills/rijksmuseum-mcp-plus");

export const LOCAL_SERVER = {
  command: process.execPath,
  args: [path.join(projectRoot, "dist/index.js")],
  env: { MCP_SKIP_STARTUP_WARM: "1" },
};

export const serverLabel = (opts) => (opts.local ? "local stdio (dist/index.js)" : opts.server);

export const loadPrompts = () => JSON.parse(readFileSync(path.join(benchDir, "prompts.json"), "utf8"));

// The leading // comment block of a script, for --help.
export function headerHelp(file) {
  const lines = readFileSync(file, "utf8").split("\n").slice(1);
  const end = lines.findIndex((l) => !l.startsWith("//"));
  return lines.slice(0, end === -1 ? lines.length : end).map((l) => l.replace(/^\/\/ ?/, "")).join("\n");
}
