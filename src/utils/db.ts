import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/** Project root: two levels up from dist/utils/db.js (or src/utils/db.ts). */
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Escape a value for safe FTS5 phrase matching. Returns null if input is empty after stripping.
 *  Strips FTS5 operators and bracket characters; preserves hyphens (safe inside quoted phrases). */
export function escapeFts5(value: string): string | null {
  const cleaned = value.replace(/[*^():{}[\]\\]/g, "").replace(/"/g, '""').trim();
  if (!cleaned) return null;
  return `"${cleaned}"`;
}

/** Escape a single token for FTS5 (strip operators, no phrase quoting).
 *  Returns null if input is empty after stripping. */
export function escapeFts5Token(value: string): string | null {
  const cleaned = value.replace(/[*^():{}[\]\\"]/g, "").trim();
  return cleaned || null;
}

/** Generate English morphological variants for a single word.
 *  Returns variants excluding the original. Minimum stem length: 3. */
export function generateMorphVariants(word: string): string[] {
  const w = word.toLowerCase();
  const variants = new Set<string>();

  // Plural → singular
  if (w.endsWith("ies") && w.length > 4) variants.add(w.slice(0, -3) + "y");
  if (w.endsWith("ses") && w.length > 4) variants.add(w.slice(0, -2));
  else if (w.endsWith("ches") || w.endsWith("shes") || w.endsWith("xes") || w.endsWith("zes"))
    variants.add(w.slice(0, -2));
  else if (w.endsWith("s") && !w.endsWith("ss") && w.length > 3) variants.add(w.slice(0, -1));

  // Singular → plural
  if (!w.endsWith("s") && w.length >= 3) variants.add(w + "s");

  // Gerund / present participle: -ing
  if (w.endsWith("ing") && w.length > 5) {
    variants.add(w.slice(0, -3));        // painting → paint
    variants.add(w.slice(0, -3) + "e");  // skating → skate
  }

  // Past tense: -ed
  if (w.endsWith("ied") && w.length > 4) variants.add(w.slice(0, -3) + "y");
  else if (w.endsWith("ed") && w.length > 4) {
    variants.add(w.slice(0, -2));        // painted → paint
    variants.add(w.slice(0, -1));        // caused → cause (strip d only — nah, -ed → root + e)
    variants.add(w.slice(0, -2) + "e");  // caused → cause
  }

  // Remove original and stems shorter than 3
  variants.delete(w);
  return [...variants].filter((v) => v.length >= 3);
}

/** Build an expanded FTS5 MATCH string with morphological variants.
 *  Returns null if phrase has >3 tokens or no expansion is possible. */
export function expandFtsQuery(phrase: string): string | null {
  const tokens = phrase.trim().split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0 || tokens.length > 3) return null;

  const groups: string[][] = [];
  let totalTerms = 0;
  for (const token of tokens) {
    const escaped = escapeFts5Token(token);
    if (!escaped) return null;
    const variants = generateMorphVariants(token)
      .map((v) => escapeFts5Token(v))
      .filter((v): v is string => v !== null);
    const group = [escaped, ...variants];
    groups.push(group);
    totalTerms += group.length;
  }

  // Cap at 8 total terms — trim variants from longest group first
  while (totalTerms > 8) {
    let longest = groups[0];
    for (const g of groups) if (g.length > longest.length) longest = g;
    if (longest.length <= 1) break; // can't trim further
    longest.pop();
    totalTerms--;
  }

  // Only expand if at least one group has variants
  const hasExpansion = groups.some((g) => g.length > 1);
  if (!hasExpansion) return null;

  const parts = groups.map((g) =>
    g.length === 1 ? g[0] : `(${g.join(" OR ")})`
  );
  return parts.join(" AND ");
}

/** Resolve a database path from environment variable or default data/ location.
 *  Returns null if the file doesn't exist at either location. */
export function resolveDbPath(envVarName: string, defaultFilename: string): string | null {
  const envPath = process.env[envVarName];
  if (envPath && fs.existsSync(envPath)) return envPath;

  const defaultPath = path.join(PROJECT_ROOT, "data", defaultFilename);
  if (fs.existsSync(defaultPath)) return defaultPath;

  return null;
}
