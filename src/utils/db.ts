import path from "node:path";
import fs from "node:fs";

/** Escape a value for safe FTS5 phrase matching. Returns null if input is empty after stripping.
 *  Strips FTS5 operators and bracket characters; preserves hyphens (safe inside quoted phrases). */
export function escapeFts5(value: string): string | null {
  const cleaned = value.replace(/[*^():{}[\]\\]/g, "").replace(/"/g, '""').trim();
  if (!cleaned) return null;
  return `"${cleaned}"`;
}

/** Resolve a database path from environment variable or default data/ location.
 *  Returns null if the file doesn't exist at either location. */
export function resolveDbPath(envVarName: string, defaultFilename: string): string | null {
  const envPath = process.env[envVarName];
  if (envPath && fs.existsSync(envPath)) return envPath;

  const defaultPath = path.join(process.cwd(), "data", defaultFilename);
  if (fs.existsSync(defaultPath)) return defaultPath;

  return null;
}
