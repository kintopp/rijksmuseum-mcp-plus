import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/** Project root: two levels up from dist/utils/db.js (or src/utils/db.ts). */
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Escape a value for safe FTS5 phrase matching. Returns null if input is empty after stripping.
 *  Strips FTS5 operators and bracket characters; preserves hyphens (safe inside quoted phrases). */
export function escapeFts5(value: string): string | null {
  const cleaned = value.replace(/[.*^():{}[\]\\]/g, "").replace(/"/g, '""').trim();
  if (!cleaned) return null;
  return `"${cleaned}"`;
}

/** Escape a single token for FTS5 (strip operators, quote to prevent
 *  reserved-word interpretation: AND, OR, NOT, NEAR).
 *  Returns null if input is empty after stripping. */
export function escapeFts5Token(value: string): string | null {
  const cleaned = value.replace(/[.*^():{}[\]\\"]/g, "").trim();
  return cleaned ? `"${cleaned}"` : null;
}

/** Generate English morphological variants for a single word.
 *  Returns variants excluding the original. Minimum stem length: 3. */
export function generateMorphVariants(word: string): string[] {
  const w = word.toLowerCase();
  const variants = new Set<string>();

  // Plural → singular (most-specific suffix first)
  if (w.endsWith("ies") && w.length > 4) variants.add(w.slice(0, -3) + "y");
  else if (w.endsWith("ches") || w.endsWith("shes") || w.endsWith("xes") || w.endsWith("zes"))
    variants.add(w.slice(0, -2));
  else if (w.endsWith("ses") && w.length > 4) variants.add(w.slice(0, -2));
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

// ── Structured text-query DSL → FTS5 MATCH compiler (#363) ──────────────
//
// Turns an opt-in structured request into ONE safe FTS5 MATCH string against
// the multi-column `artwork_texts_fts` table. The safety invariant is the same
// as `expandFtsQuery` above: operators (AND/OR/NOT/NEAR/*) and column filters
// are emitted by THIS code only; every user-supplied leaf term is passed through
// `escapeFts5`/`escapeFts5Token` first, so it can never break out of its quotes
// to inject an operator or probe a column.

/** Text fields a clause may target; maps to `artwork_texts_fts` columns. */
export const TEXT_QUERY_FIELD_COLUMNS: Record<string, string> = {
  title: "title_all_text",
  description: "description_text",
  inscription: "inscription_text",
  curatorialNarrative: "narrative_text",
};

/** Columns scoped when a clause omits `field` — deliberately excludes
 *  provenance_text/credit_line (provenance → search_provenance). */
const DEFAULT_TEXT_QUERY_COLUMNS = Object.values(TEXT_QUERY_FIELD_COLUMNS);

/** Cap on total leaf terms across the compiled query (after NEAR expansion).
 *  Higher than expandFtsQuery's auto-expansion cap of 8 — this is an explicit
 *  power feature — but still bounds query blow-up. Exceeding it is an error,
 *  never a silent truncation. */
export const TEXT_QUERY_MAX_TERMS = 32;

interface TextQueryNear {
  terms: (string | string[])[];
  distance: number;
}
interface TextQueryClause {
  field?: string;
  phrase?: string;
  any?: string[];
  anyPrefix?: string[];
  prefix?: string;
  near?: TextQueryNear;
}
export interface TextQueryDsl {
  must?: TextQueryClause[];
  should?: TextQueryClause[];
  mustNot?: TextQueryClause[];
}

/** A prefix term: escape the stem as a token, then append the FTS5 `*`. */
function prefixTerm(stem: string): string | null {
  const tok = escapeFts5Token(stem);
  return tok ? `${tok}*` : null;
}

/** Expand a NEAR spec into a (possibly OR-joined) FTS5 expression.
 *  FTS5's NEAR() takes plain phrase arguments only — no sub-expressions — so a
 *  slot offering alternatives (string[]) is expanded as an OR of flat NEAR()
 *  calls (the cartesian product across slots). Returns null on bad shape.
 *  Pushes each emitted phrase onto `termSink` for the global term cap. */
function compileNear(near: TextQueryNear, termSink: string[]): string | null {
  if (!Number.isInteger(near.distance) || near.distance <= 0) return null;
  if (!Array.isArray(near.terms) || near.terms.length < 2) return null;

  // Escape every slot's alternatives; drop empties; a slot with no surviving
  // alternative makes the whole NEAR void.
  const slots: string[][] = [];
  for (const slot of near.terms) {
    const raw = Array.isArray(slot) ? slot : [slot];
    const escaped = raw.map((s) => escapeFts5Token(s)).filter((s): s is string => s !== null);
    if (escaped.length === 0) return null;
    slots.push(escaped);
  }

  // Cartesian product → one flat NEAR() per combination.
  let combos: string[][] = [[]];
  for (const slot of slots) {
    const next: string[][] = [];
    for (const combo of combos) for (const alt of slot) next.push([...combo, alt]);
    combos = next;
  }

  const calls = combos.map((combo) => {
    combo.forEach((t) => termSink.push(t));
    return `NEAR(${combo.join(" ")}, ${near.distance})`;
  });
  // Un-parenthesised: the clause's column-scope wrapper provides the grouping,
  // and every term in a clause is OR-combined, so a flat OR list is correct.
  return calls.join(" OR ");
}

/** Compile one clause into a column-scoped, OR-combined FTS5 sub-expression.
 *  Every term the clause contributes (phrase, prefix, any/anyPrefix tokens,
 *  near expression) is OR-joined, then wrapped in `{cols} : ( … )`.
 *  Returns null if the clause yields no usable term, or a string error. */
function compileClause(
  clause: TextQueryClause,
  termSink: string[]
): { expr: string } | { error: string } | null {
  if (clause.field !== undefined && !(clause.field in TEXT_QUERY_FIELD_COLUMNS)) {
    return { error: `unknown textQuery field "${clause.field}"` };
  }
  const parts: string[] = [];

  if (clause.phrase) {
    const p = escapeFts5(clause.phrase);
    if (p) { parts.push(p); termSink.push(p); }
  }
  if (clause.prefix) {
    const p = prefixTerm(clause.prefix);
    if (p) { parts.push(p); termSink.push(p); }
  }
  for (const tok of clause.any ?? []) {
    const t = escapeFts5Token(tok);
    if (t) { parts.push(t); termSink.push(t); }
  }
  for (const stem of clause.anyPrefix ?? []) {
    const p = prefixTerm(stem);
    if (p) { parts.push(p); termSink.push(p); }
  }
  if (clause.near) {
    const n = compileNear(clause.near, termSink);
    if (n === null) return { error: "invalid near clause (needs ≥2 non-empty term slots and a positive distance)" };
    parts.push(n);
  }

  if (parts.length === 0) return null; // clause empty after escaping → skip
  // Every term in a clause is OR-combined; the `{cols} : ( … )` wrapper below
  // supplies the only grouping parens.
  const inner = parts.join(" OR ");

  const columns = clause.field
    ? [TEXT_QUERY_FIELD_COLUMNS[clause.field]]
    : DEFAULT_TEXT_QUERY_COLUMNS;
  return { expr: `{${columns.join(" ")}} : (${inner})` };
}

/** Compile a list of clauses, dropping empties. Returns the compiled exprs,
 *  or the first clause error encountered. */
function compileClauseList(
  clauses: TextQueryClause[],
  termSink: string[]
): { exprs: string[] } | { error: string } {
  const exprs: string[] = [];
  for (const c of clauses) {
    const r = compileClause(c, termSink);
    if (r === null) continue;
    if ("error" in r) return { error: r.error };
    exprs.push(r.expr);
  }
  return { exprs };
}

/** Compile the structured `textQuery` DSL into one FTS5 MATCH string (#363).
 *
 *  Assembly: `mustExpr AND (shouldGroup)` then `… NOT (n1 OR n2 …)`. FTS5's NOT
 *  is binary-only, so a mustNot-only query (no positive operand) is rejected.
 *
 *  Returns `{ match }` on success or `{ error }` for an empty/invalid query so
 *  the caller can downgrade to a warning rather than throw SQLITE_ERROR. */
export function compileTextQuery(dsl: TextQueryDsl): { match: string } | { error: string } {
  const must = dsl.must ?? [];
  const should = dsl.should ?? [];
  const mustNot = dsl.mustNot ?? [];
  if (must.length === 0 && should.length === 0) {
    return { error: "textQuery needs at least one must or should clause" };
  }

  const terms: string[] = [];
  const mustR = compileClauseList(must, terms);
  if ("error" in mustR) return mustR;
  const shouldR = compileClauseList(should, terms);
  if ("error" in shouldR) return shouldR;
  const mustNotR = compileClauseList(mustNot, terms);
  if ("error" in mustNotR) return mustNotR;

  if (terms.length > TEXT_QUERY_MAX_TERMS) {
    return { error: `textQuery expands to ${terms.length} terms (max ${TEXT_QUERY_MAX_TERMS}); narrow the query` };
  }

  // Positive part: must clauses AND-joined, plus the should group as one OR.
  const positiveParts: string[] = [...mustR.exprs];
  if (shouldR.exprs.length > 0) {
    positiveParts.push(shouldR.exprs.length === 1 ? shouldR.exprs[0] : `(${shouldR.exprs.join(" OR ")})`);
  }
  if (positiveParts.length === 0) {
    // Every positive clause escaped to empty (e.g. all-punctuation terms).
    return { error: "textQuery has no usable terms after escaping" };
  }
  let match = positiveParts.join(" AND ");

  // Negative part attaches via binary NOT to the whole positive expression.
  // FTS5 precedence is NOT > AND > OR, so a multi-part positive (top-level AND)
  // must be parenthesised before NOT; a single atomic part needs no wrap.
  if (mustNotR.exprs.length > 0) {
    const neg = mustNotR.exprs.length === 1 ? mustNotR.exprs[0] : `(${mustNotR.exprs.join(" OR ")})`;
    const pos = positiveParts.length > 1 ? `(${match})` : match;
    match = `${pos} NOT ${neg}`;
  }
  return { match };
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
