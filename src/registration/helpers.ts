import { z } from "zod";
import { randomUUID } from "node:crypto";
import { SORT_COLUMNS, type SortColumn, type BrowseSetRecord, type ProvenanceArtworkResult } from "../api/VocabularyDb.js";
import { UsageStats } from "../utils/UsageStats.js";
import { buildContentBlocks, mirrorWarningsToText, type JsonTextOptions, type TextBlock } from "../utils/responseShape.js";

export const ARTWORK_VIEWER_RESOURCE_URI = "ui://rijksmuseum/artwork-viewer.html";

// MCP tool annotations (behavioural hints; see issue #259).
// `destructiveHint` defaults to true in the spec, so omitting annotations mislabels read-only tools.
// `openWorldHint` is false on every tool: per the spec example (memory tool = closed,
// web search = open), this server's entire domain is the bounded ~834K-artwork
// Rijksmuseum corpus — including viewer tools, which target artworks from the same set.
export const ANN_READ_CLOSED = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
export const ANN_VIEWER = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

/**
 * Per-tool result limits. Defaults reflect payload weight:
 * - 25: lightweight per-result data (title, creator, date, score)
 * -  1: very heavy per-result data (full provenance chains with events, parties, prices)
 * - 10: heavy records — full OAI-PMH/EDM records (get_recent_changes), or DB-backed records carrying a per-record description (browse_set)
 * - 15: medium — semantic scores plateau ~15, plus a reconstructed sourceText block per result
 * - 20: enriched comparisons (similarity signals)
 *
 * collection_stats returns compact text tables — high default + max for comprehensive distributions.
 * search_provenance defaults to 1 because each artwork's full chain is large;
 *   totalArtworks in the response + offset enables paging when more are needed.
 *
 * Max caps: 50 for individual results (100 for persons), 500 for stats.
 */
export const TOOL_LIMITS = {
  search_artwork:      { max: 50,  default: 25 },
  search_persons:      { max: 100, default: 25 },
  semantic_search:     { max: 50,  default: 15 },
  search_provenance:   { max: 50,  default: 1 },
  search_inscriptions: { max: 100, default: 20 },
  browse_set:          { max: 50,  default: 10 },
  get_recent_changes:  { max: 50,  default: 10 },
  find_similar:        { max: 50,  default: 20 },
  collection_stats:    { max: 500, default: 25 },
} as const;

/** Params that narrow results but are too broad to stand alone as the only filter. */
export const MODIFIER_KEYS = new Set(["imageAvailable", "hasProvenance", "expandPlaceHierarchy", "sameRowMatching", "compact"]);

/** Public compound params on search_artwork that get parsed into internal fields
 *  before forwarding to VocabularyDb — never passed through as-is. */
export const COMPOUND_PUBLIC_KEYS = new Set(["heightRange", "widthRange", "sort"]);

/** Provenance filter categorization by layer support. */
export const PROVENANCE_EVENT_ONLY_FILTERS = ["transferType", "excludeTransferType", "currency", "hasPrice", "hasGap", "relatedTo", "categoryMethod", "positionMethod"];
export const PROVENANCE_PERIOD_ONLY_FILTERS = ["ownerName", "acquisitionMethod", "minDuration", "maxDuration", "periodLocation"];
export const PROVENANCE_SHARED_FILTERS = ["party", "location", "dateFrom", "dateTo", "objectNumber", "creator"];
export const PROVENANCE_ALL_FILTERS = [...PROVENANCE_SHARED_FILTERS, ...PROVENANCE_EVENT_ONLY_FILTERS, ...PROVENANCE_PERIOD_ONLY_FILTERS];

/** Available facet dimensions for search_artwork. Single source of truth for preprocess + z.enum. */
export const FACET_DIMENSIONS = [
  "type", "material", "technique", "century", "rights", "imageAvailable",
  "creator", "depictedPerson", "depictedPlace", "productionPlace",
  "theme", "sourceType",
] as const;

/** Preprocess: strip JSON null / "null" string / "" → undefined BEFORE Zod validates.
 *  claude.ai sends actual JSON null for every optional string param the LLM omits.
 *  z.string().optional() rejects null (only accepts string | undefined), so the
 *  null must be converted before type-checking.  Using factory functions (not shared
 *  constants) so each field gets a unique Zod instance — zod-to-json-schema deduplicates
 *  by identity, and shared instances caused $ref pointers that claude.ai cannot resolve. */
export const stripNull = (v: unknown) =>
  (v === null || v === undefined || v === "null" || v === "") ? undefined : v;

/** Preprocessor for boolean input fields. Composes stripNull with string-coerce
 *  for "true"/"false" — defence in depth against client wrappers that may
 *  serialize booleans as strings (the bug shape reported in the 2026-05-19
 *  transcript, never reproduced in controlled testing but cheap to hedge).
 *  Lowercase only — strict canonical form. */
export const stripNullCoerceBool = (v: unknown) => {
  const stripped = stripNull(v);
  if (stripped === "true") return true;
  if (stripped === "false") return false;
  return stripped;
};

/** Normalize null/arrays into string | string[] | undefined. */
export function normalizeStringOrArray(v: unknown): unknown {
  if (v === null || v === undefined || v === "null" || v === "") return undefined;
  if (typeof v === "string") {
    const trimmed = v.trim();
    return trimmed === "" ? undefined : trimmed;
  }
  // Array: strip nulls/empties
  if (Array.isArray(v)) {
    const cleaned = v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map(x => x.trim());
    return cleaned.length === 0 ? undefined : cleaned.length === 1 ? cleaned[0] : cleaned;
  }
  return v; // let Zod reject unsupported types
}
export const stringOrArray = () => z.preprocess(
  normalizeStringOrArray,
  z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
);
export const optStr = () => z.preprocess(stripNull, z.string().optional());
export const optMinStr = () => z.preprocess(stripNull, z.string().min(1).optional());

// #363: structured textQuery DSL schema. Built via factories so each of
// must/should/mustNot gets a *distinct* clause-schema instance — sharing one
// instance would make zod-to-json-schema emit $defs/$ref, which the inputSchema
// conformance test forbids (must stay $ref-free).
export const textQueryClauseSchema = () =>
  z.object({
    field: z.enum(["title", "description", "inscription", "curatorialNarrative"]).optional(),
    phrase: z.string().min(1).optional(),
    any: z.array(z.string().min(1)).min(1).optional(),
    anyPrefix: z.array(z.string().min(1)).min(1).optional(),
    prefix: z.string().min(1).optional(),
    near: z.object({
      terms: z.array(z.union([z.string().min(1), z.array(z.string().min(1)).min(1)])).min(2),
      distance: z.number().int().positive(),
    }).strict().optional(),
  }).strict();
export const textQuerySchema = () =>
  z.object({
    must: z.array(textQueryClauseSchema()).min(1).optional(),
    should: z.array(textQueryClauseSchema()).min(1).optional(),
    mustNot: z.array(textQueryClauseSchema()).min(1).optional(),
  }).strict();

export type ToolResponse = { content: TextBlock[] };
export type StructuredToolResponse = ToolResponse & { structuredContent: Record<string, unknown> };

/** Infer a TypeScript type from a Zod shape (plain object of ZodTypes used for outputSchema). */
export type InferOutput<T extends Record<string, z.ZodTypeAny>> = z.infer<z.ZodObject<T>>;

export function errorResponse(message: string) {
  // Never emit structuredContent here — a bare { error } won't conform to
  // any tool's outputSchema (which has required fields like totalResults,
  // results, etc.) and causes the SDK to reject with -32602.
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

/** Return both structured content (for apps/typed clients) and text content (for LLMs).
 *  Set STRUCTURED_CONTENT=false to omit structuredContent (workaround for client bugs). */
export const EMIT_STRUCTURED = process.env.STRUCTURED_CONTENT !== "false";

/**
 * DEPRECATED (compat shim). When true, every human-summary response ALSO carries
 * a verbatim serialized-JSON text block (size-guarded by buildContentBlocks).
 * Its ONLY purpose is to hand parseable JSON to a *model* whose host cannot
 * surface `structuredContent` (claude.ai / Claude Desktop today). Once those
 * clients read structuredContent, this block is token-for-token redundancy and
 * should be removed. Off by default; slated for deletion — do not build new
 * behaviour on it.
 *
 * SCOPE: this deprecation covers only the GLOBAL default below. The per-call
 * `jsonText` option (forced by paginatedResponse for full OAI records, and by
 * citation/source tools) is a SEPARATE, still-live mechanism — not deprecated. */
export const JSON_TEXT_COMPAT = process.env.MCP_TEXT_JSON_COMPAT === "true";

/**
 * Bytes reserved from SAFE_RESULT_BUDGET for the search_provenance non-compact
 * TEXT channel + JSON-RPC framing when deciding whether to auto-downgrade to
 * compact. We measure the (large, variable) structuredContent exactly; the text
 * channel is the small, bounded term (~24K at maxResults 50) so a fixed reserve
 * is enough. Comparing structuredContent against (budget − reserve) keeps the
 * whole result under SAFE_RESULT_BUDGET. Tunable; raise if a very verbose query
 * is observed to slip over.
 */
export const PROVENANCE_TEXT_RESERVE = 30_000;

export function structuredResponse(
  data: object,
  textContent?: string,
  opts?: JsonTextOptions,
): ToolResponse | StructuredToolResponse {
  // When jsonTextData is supplied, the text-channel JSON copy carries that
  // (trimmed) object while structuredContent keeps the full `data`; the guard
  // then needs the full payload's size, not the trimmed copy's.
  const textPayload = opts?.jsonTextData ?? data;
  const humanText = mirrorWarningsToText(data, textContent);
  const content = buildContentBlocks(textPayload, humanText, {
    jsonText: opts?.jsonText ?? JSON_TEXT_COMPAT,
    maxJsonTextBytes: opts?.maxJsonTextBytes,
    structuredContentEmitted: EMIT_STRUCTURED,
    ...(opts?.jsonTextData && EMIT_STRUCTURED
      ? { structuredPayloadBytes: Buffer.byteLength(JSON.stringify(data), "utf8") }
      : {}),
  });
  if (!EMIT_STRUCTURED) {
    return { content };
  }
  return { content, structuredContent: data as Record<string, unknown> };
}

/** Conditionally attach an outputSchema when structured content is enabled. */
export function withOutputSchema<T>(schema: T): { outputSchema: T } | Record<never, never> {
  return EMIT_STRUCTURED ? { outputSchema: schema } : {};
}

/** Format a search result as a compact one-liner for LLM content. */
export function formatSearchLine(r: { objectNumber: string; title: string; creator: string; date?: string; type?: string; url?: string; nearestPlace?: string; distance_km?: number; groupedChildCount?: number }, i: number): string {
  let line = `${i + 1}. ${r.objectNumber}`;
  if (r.type) line += ` | ${r.type}`;
  if (r.date) line += ` | ${r.date}`;
  line += ` | "${r.title}"`;
  if (r.creator) line += ` — ${r.creator}`;
  if (r.nearestPlace) line += ` [${r.nearestPlace}, ${r.distance_km?.toFixed(1)}km]`;
  if (r.groupedChildCount) line += ` (+${r.groupedChildCount} children collapsed)`;
  if (r.url) line += ` ${r.url}`;
  return line;
}

/**
 * Detect component-record clustering in search results.
 * When ≥3 results share an object number prefix before '(' (e.g. folio records
 * from the same sketchbook), return a warning string. Returns undefined otherwise.
 */
export function detectComponentClustering(objectNumbers: string[]): string | undefined {
  const groups = new Map<string, number>();
  for (const on of objectNumbers) {
    const parenIdx = on.indexOf("(");
    if (parenIdx > 0) {
      const prefix = on.slice(0, parenIdx).replace(/-$/, ""); // trim trailing dash
      groups.set(prefix, (groups.get(prefix) ?? 0) + 1);
    }
  }
  const clusters: string[] = [];
  for (const [prefix, count] of groups) {
    if (count >= 3) clusters.push(`${count} results are folios/components of ${prefix}`);
  }
  if (clusters.length === 0) return undefined;
  return "Note: " + clusters.join("; ") + ". Add filters to narrow, or inspect the parent object directly.";
}

/** Format faceted counts as a compact "Narrow by:" block for LLM content. */
export function formatFacets(facets: Record<string, Array<{ label: string; count: number; percentage?: number }>>): string {
  const lines: string[] = ["Narrow by:"];
  for (const [dim, entries] of Object.entries(facets)) {
    const dimLabel = dim.charAt(0).toUpperCase() + dim.slice(1);
    const items = entries.map(e => {
      const pct = e.percentage != null ? `, ${e.percentage.toFixed(1)}%` : "";
      return `${e.label} (${e.count.toLocaleString()}${pct})`;
    }).join(", ");
    lines.push(`  ${dimLabel}: ${items}`);
  }
  return lines.join("\n");
}

/** Add percentage to each facet entry based on the sum of counts in that dimension. */
export function addPercentages(facets: Record<string, Array<{ label: string; count: number; percentage?: number }>>): void {
  for (const entries of Object.values(facets)) {
    const total = entries.reduce((sum, e) => sum + e.count, 0);
    if (total > 0) {
      for (const e of entries) {
        e.percentage = Math.round((e.count / total) * 1000) / 10;
      }
    }
  }
}

/** Truncate a string to maxLen, appending "..." if truncated. */
export function truncate(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : s.slice(0, maxLen - 3) + "...";
}

/** Truncate a description snippet to maxLen on a word boundary, appending " […]" if truncated. */
export function truncateSnippet(s: string | undefined, maxLen: number): string | undefined {
  if (!s) return undefined;
  if (s.length <= maxLen) return s;
  const cut = s.lastIndexOf(" ", maxLen);
  return (cut > 0 ? s.slice(0, cut) : s.slice(0, maxLen)) + " […]";
}

const DIM_RANGE_RE = /^(\d+(?:\.\d+)?)?-(\d+(?:\.\d+)?)?$/;
const SORT_PARAM_RE = /^([A-Za-z]+)(?::(asc|desc))?$/;
const SORT_COLUMN_SET = new Set<string>(SORT_COLUMNS);

/** Parse search_artwork `heightRange` / `widthRange` strings: '10-50', '10-', '-50'. */
export function parseDimRange(input: unknown): { min?: number; max?: number } | null {
  if (typeof input !== "string") return null;
  const m = input.match(DIM_RANGE_RE);
  if (!m) return null;
  const min = m[1] ? parseFloat(m[1]) : undefined;
  const max = m[2] ? parseFloat(m[2]) : undefined;
  if (min == null && max == null) return null;
  return { min, max };
}

/** Parse search_artwork `sort` string: 'column' or 'column:asc|desc' (default desc). */
export function parseSortParam(input: unknown): { sortBy: SortColumn; sortOrder: "asc" | "desc" } | null {
  if (typeof input !== "string") return null;
  const m = input.match(SORT_PARAM_RE);
  if (!m) return null;
  if (!SORT_COLUMN_SET.has(m[1])) return null;
  return { sortBy: m[1] as SortColumn, sortOrder: (m[2] as "asc" | "desc") ?? "desc" };
}

/**
 * Render a classification-method code as a compact text-channel tag, or null
 * if it equals the parser default (so the formatter can omit it). Lossless on
 * `rule:*` qualifiers; abbreviates `llm_*` → `llm:*`; strips the
 * `llm_structural:` prefix on correction codes.
 */
export function compactMethodTag(method: string | null | undefined, defaultMethod?: string): string | null {
  if (!method) return null;
  if (defaultMethod && method === defaultMethod) return null;
  if (method.startsWith("llm_structural:")) return method.slice("llm_structural:".length);
  if (method.startsWith("llm_")) return "llm:" + method.slice("llm_".length);
  return method;
}

/** #386 compact-mode rollup of a provenance chain — fixed-size summary derived from the
 *  full event list (events are sequence-ordered). Used by both the structured and text
 *  channels so they stay in sync. */
export function provenanceCompactSummary(art: ProvenanceArtworkResult) {
  const years = art.events.map(e => e.dateYear).filter((y): y is number => y != null);
  const names = art.events.flatMap(e => e.parties.map(p => p.name)).filter(Boolean);
  const transferTypes = [...new Set(
    art.events.map(e => e.transferType).filter(t => t !== "unknown" && t !== "non_provenance"),
  )];
  return {
    eventCount: art.eventCount,
    matchedEventCount: art.matchedEventCount,
    yearSpan: [years.length ? Math.min(...years) : null, years.length ? Math.max(...years) : null] as (number | null)[],
    transferTypes,
    firstOwner: names[0] ?? null,
    lastOwner: names.length ? names[names.length - 1] : null,
    hasGap: art.events.some(e => e.gap === true),
    hasPrice: art.events.some(e => e.price != null),
  };
}

/** #386 lean matched-event one-liners for compact mode (names with role annotation, trimmed rawText). */
export function provenanceMatchedEvents(art: ProvenanceArtworkResult) {
  return art.events.filter(e => e.matched).map(e => ({
    sequence: e.sequence,
    transferType: e.transferType,
    parties: e.parties.map(p => (p.role ? `${p.name} (${p.role})` : p.name)),
    dateExpression: e.dateExpression,
    location: e.location,
    price: e.price,
    rawText: e.rawText.trim(),
  }));
}

/** Format a curated set as a compact one-liner (Tier 2). */
export function formatSetLine(
  s: {
    setSpec: string;
    name: string;
    lodUri?: string;
    memberCount?: number;
    dominantTypes?: { label: string; count: number }[];
    category?: string | null;
  },
  i: number,
): string {
  let line = `${i + 1}. ${s.setSpec} | ${s.name}`;
  if (s.memberCount != null) line += ` | ${s.memberCount.toLocaleString()} members`;
  if (s.category) line += ` | ${s.category}`;
  if (s.dominantTypes && s.dominantTypes.length > 0) {
    const top = s.dominantTypes.slice(0, 2).map(t => t.label).join(", ");
    line += ` | ${top}`;
  }
  if (s.lodUri) line += ` | ${s.lodUri}`;
  return line;
}

/** Stateless base64 token: "<setSpec>\t<offset>". Tokens are not portable across
 *  server versions — pre-v0.27 OAI-PMH tokens fail to decode here, by design. */
export function encodeBrowseSetToken(setSpec: string, offset: number): string {
  return Buffer.from(`${setSpec}\t${offset}`, "utf8").toString("base64");
}
export function decodeBrowseSetToken(token: string): { setSpec: string; offset: number } | null {
  try {
    const decoded = Buffer.from(token, "base64").toString("utf8");
    const tab = decoded.indexOf("\t");
    if (tab < 0) return null;
    const setSpec = decoded.slice(0, tab);
    const offset = parseInt(decoded.slice(tab + 1), 10);
    if (!setSpec || isNaN(offset) || offset < 0) return null;
    return { setSpec, offset };
  } catch {
    return null;
  }
}

/** Format a DB-backed browse_set record as a compact one-liner (Tier 2). */
export function formatBrowseSetRecord(r: BrowseSetRecord, i: number): string {
  let line = `${i + 1}. ${r.objectNumber}`;
  if (r.title) line += ` | "${r.title}"`;
  if (r.creator) line += ` — ${r.creator}`;
  if (r.date) line += ` (${r.date})`;
  if (r.hasImage) line += " [image]";
  return line;
}

/** Format an OAI-PMH record as a compact one-liner (Tier 2). */
export function formatRecordLine(r: Record<string, unknown>, i: number): string {
  const deleted = r.deleted === true;
  // Deleted records carry no objectNumber (no metadata block); fall back to the
  // LOD URI (full mode) or header identifier (identifiersOnly mode).
  const obj = (r.objectNumber as string) || (r.lodUri as string) || (r.identifier as string) || "?";
  const title = (r.title as string) || "";
  const creator = r.creator && typeof r.creator === "object" && (r.creator as Record<string, unknown>).name
    ? (r.creator as Record<string, unknown>).name as string
    : "";
  const type = (r.type as string) || "";
  const datestamp = (r.datestamp as string) || "";
  let line = `${i + 1}. ${deleted ? "[DELETED] " : ""}${obj}`;
  if (datestamp) line += ` | ${datestamp}`;
  if (type) line += ` | ${type}`;
  if (title) line += ` | "${title}"`;
  if (creator) line += ` — ${creator}`;
  return line;
}

/** Stable canonical key for a tool's input (sorted keys). Full-length by default so it's a
 *  collision-free cache key; pass `maxLen` to cap it for the per-input latency map (where a
 *  rare long-input collision only merges latency buckets, but a cache collision would serve a
 *  wrong result). */
export function canonicalInputKey(input: unknown, maxLen?: number): string {
  if (input == null || typeof input !== "object") return String(input);
  const obj = input as Record<string, unknown>;
  const parts = Object.keys(obj)
    .filter(k => obj[k] !== undefined)
    .sort()
    .map(k => `${k}=${JSON.stringify(obj[k])}`);
  const s = parts.join("&");
  return maxLen != null && s.length > maxLen ? s.slice(0, maxLen) : s;
}

/** Create a logging wrapper that records timing to stderr and optional UsageStats. */
export function createLogger(stats?: UsageStats) {
  return function withLogging<A extends unknown[], R>(
    toolName: string,
    fn: (...args: A) => Promise<R>
  ): (...args: A) => Promise<R> {
    return async (...args: A): Promise<R> => {
      // Log tool input params (args[0]); skip args[1] which is MCP session metadata
      const input = args[0] && typeof args[0] === "object" ? args[0] : undefined;
      const start = performance.now();
      try {
        const result = await fn(...args);
        const ms = Math.round(performance.now() - start);
        const ok = !(result && typeof result === "object" && "isError" in result && (result as Record<string, unknown>).isError);
        console.error(JSON.stringify({ tool: toolName, ms, ok, ...(input && { input }) }));
        stats?.record(toolName, ms, ok);
        stats?.recordInput(toolName, canonicalInputKey(input, 300), ms);
        return result;
      } catch (err) {
        const ms = Math.round(performance.now() - start);
        const error = err instanceof Error ? err.message : String(err);
        console.error(JSON.stringify({ tool: toolName, ms, ok: false, error, ...(input && { input }) }));
        stats?.record(toolName, ms, false);
        stats?.recordInput(toolName, canonicalInputKey(input, 300), ms);
        // Do NOT emit structuredContent here — a bare { error } fails SDK
        // validation against any outputSchema with required fields (-32602).
        // Tools that need schema-conformant errors handle them internally.
        const errResult: Record<string, unknown> = {
          content: [{ type: "text" as const, text: `Error in ${toolName}: ${error}` }],
          isError: true,
        };
        return errResult as R;
      }
    };
  };
}

/**
 * Server-side OAI page buffer. When `maxResults` truncates an upstream page,
 * the remainder is stored here keyed by a server-generated token. The next
 * continuation drains the buffer before fetching a new upstream page.
 * TTL: 30 minutes, swept every 60s.
 */
interface OaiPageBuffer {
  remainder: unknown[];
  upstreamToken: string | null;
  completeListSize: number | null;
  identifiersOnly?: boolean;
  toolName: string;
  lastAccess: number;
}
const oaiPageBuffers = new Map<string, OaiPageBuffer>();
setInterval(() => {
  const now = Date.now();
  for (const [id, buf] of oaiPageBuffers) {
    if (now - buf.lastAccess > 1_800_000) oaiPageBuffers.delete(id);
  }
}, 60_000).unref();

/** Format an OAI-PMH paginated list result into a tool response. */
export function paginatedResponse(
  result: { records: unknown[]; completeListSize: number | null; resumptionToken: string | null },
  maxResults: number,
  totalLabel: string,
  toolName: string,
  extra?: Record<string, unknown>,
  formatLine?: (record: Record<string, unknown>, index: number) => string,
  identifiersOnly?: boolean,
): ToolResponse | StructuredToolResponse {
  const records = result.records.splice(0, maxResults);
  const overflow = result.records; // splice mutated: remainder is what's left

  // Build server-side continuation token when there are buffered records or an upstream token
  let serverToken: string | null = null;
  const hasMore = overflow.length > 0 || result.resumptionToken;
  if (hasMore) {
    serverToken = randomUUID();
    oaiPageBuffers.set(serverToken, {
      remainder: overflow,
      upstreamToken: result.resumptionToken,
      completeListSize: result.completeListSize,
      identifiersOnly: identifiersOnly || undefined,
      toolName,
      lastAccess: Date.now(),
    });
  }

  const data: Record<string, unknown> = {
    ...(result.completeListSize != null ? { [totalLabel]: result.completeListSize } : {}),
    returnedCount: records.length,
    ...extra,
    records,
    ...(serverToken
      ? {
          resumptionToken: serverToken,
          hint: `Pass this resumptionToken to ${toolName} to get the next page.`,
        }
      : {}),
  };

  if (formatLine) {
    const total = result.completeListSize;
    const header = total != null
      ? `${records.length} of ${total} records`
      : `${records.length} records`;
    const lines = records.map((r, i) => formatLine(r as Record<string, unknown>, i));
    const parts = [header, ...lines];
    if (serverToken) parts.push("[resumptionToken available for next page]");
    // jsonText only for full records — they drop materials/dates/authority links
    // from the one-liner. The lean identifiersOnly listing stays prose-only.
    return structuredResponse(data, parts.join("\n"), { jsonText: !identifiersOnly });
  }
  return structuredResponse(data);
}

/**
 * Drain an OAI page buffer or fetch a fresh upstream page.
 * Shared by browse_set and get_recent_changes to avoid duplicating buffer-drain logic.
 */
export async function drainOaiBuffer(
  buffered: OaiPageBuffer,
  maxResults: number,
  totalLabel: string,
  toolName: string,
  fetchUpstream: (token: string) => Promise<{ records: unknown[]; completeListSize: number | null; resumptionToken: string | null }>,
  extra?: Record<string, unknown>,
  formatLine?: (record: Record<string, unknown>, index: number) => string,
): Promise<ToolResponse | StructuredToolResponse> {
  const identifiers = buffered.identifiersOnly;
  if (buffered.remainder.length >= maxResults || !buffered.upstreamToken) {
    return paginatedResponse(
      { records: buffered.remainder, completeListSize: buffered.completeListSize, resumptionToken: buffered.upstreamToken },
      maxResults, totalLabel, toolName, extra, formatLine, identifiers,
    );
  }
  // Buffer too small — fetch next upstream page and prepend remainder
  const upstream = await fetchUpstream(buffered.upstreamToken);
  const merged = { records: [...buffered.remainder, ...upstream.records], completeListSize: upstream.completeListSize ?? buffered.completeListSize, resumptionToken: upstream.resumptionToken };
  return paginatedResponse(merged, maxResults, totalLabel, toolName, extra, formatLine, identifiers);
}

/**
 * Look up and validate a server-side OAI continuation token.
 * Returns the buffer if valid, an error response if invalid, or undefined if not a server token.
 * Does NOT delete the buffer entry — entries expire via TTL (#142: retry-safe).
 */
export function resolveOaiBuffer(
  token: string | undefined,
  expectedTool: string,
): { buffered: OaiPageBuffer } | { error: ReturnType<typeof errorResponse> } | undefined {
  if (!token) return undefined;
  const buffered = oaiPageBuffers.get(token);
  if (!buffered) {
    // Token looks like a server UUID but isn't in the buffer — expired or wrong instance
    // Only treat UUIDs as server tokens; raw OAI tokens are longer/different format
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) {
      return { error: errorResponse("Continuation token expired or not found. Please start a new query.") };
    }
    return undefined; // Not a server token — let it pass through as upstream OAI token
  }
  if (buffered.toolName !== expectedTool) {
    return { error: errorResponse(`This continuation token belongs to ${buffered.toolName}, not ${expectedTool}.`) };
  }
  buffered.lastAccess = Date.now(); // refresh TTL on access
  return { buffered };
}
