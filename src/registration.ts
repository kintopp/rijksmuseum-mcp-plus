import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerAppTool,
  registerAppResource,
  getUiCapability,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { RijksmuseumApiClient } from "./api/RijksmuseumApiClient.js";
import { OaiPmhClient } from "./api/OaiPmhClient.js";
import { VocabularyDb, FILTER_ART_IDS_KEYS, STATS_DIMENSION_NAMES, TITLE_LANGUAGES, TITLE_QUALIFIERS, DIMENSION_TYPES, formatDateRange, formatDimensions, pluralize, type ArtworkMeta, type ArtworkDetailFromDb, type DepictedSimilarResult, type ProvenanceSearchParams, type CollectionStatsParams, type BrowseSetRecord, type PersonSearchParams } from "./api/VocabularyDb.js";
import { EmbeddingsDb, type SemanticSearchResult } from "./api/EmbeddingsDb.js";
import { EmbeddingModel } from "./api/EmbeddingModel.js";
import { UsageStats } from "./utils/UsageStats.js";
import axios from "axios";
import { generateSimilarHtml, type SimilarCandidate, type SimilarPageData } from "./similarHtml.js";
import { generateEnrichmentReviewHtml, isLlmEnrichedEvent, isLlmEnrichedParty, type EnrichmentReviewData } from "./enrichmentReviewHtml.js";
import { parseProvenance } from "./provenance.js";
import { compositeOverlays, computeCropRect, readImageDimensions } from "./overlay-compositor.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ARTWORK_VIEWER_RESOURCE_URI = "ui://rijksmuseum/artwork-viewer.html";

// MCP tool annotations (behavioural hints; see issue #259).
// `destructiveHint` defaults to true in the spec, so omitting annotations mislabels read-only tools.
// `openWorldHint` is false on every tool: per the spec example (memory tool = closed,
// web search = open), this server's entire domain is the bounded ~834K-artwork
// Rijksmuseum corpus — including viewer tools, which target artworks from the same set.
const ANN_READ_CLOSED = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const ANN_VIEWER = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

/**
 * Per-tool result limits. Defaults reflect payload weight:
 * - 25: lightweight per-result data (title, creator, date, score)
 * -  1: very heavy per-result data (full provenance chains with events, parties, prices)
 * - 10: heavy per-result data (full OAI-PMH records)
 * - 15: medium (semantic scores plateau ~15)
 * - 20: enriched comparisons (similarity signals)
 *
 * collection_stats returns compact text tables — high default + max for comprehensive distributions.
 * search_provenance defaults to 1 because each artwork's full chain is large;
 *   totalArtworks in the response + offset enables paging when more are needed.
 *
 * Max caps: 50 for individual results, 100 for vocabulary, 500 for stats.
 */
const TOOL_LIMITS = {
  search_artwork:     { max: 50,  default: 25 },
  search_vocabulary:  { max: 100, default: 25 },
  semantic_search:    { max: 50,  default: 15 },
  search_provenance:  { max: 50,  default: 1 },
  browse_set:         { max: 50,  default: 10 },
  list_changes:       { max: 50,  default: 10 },
  find_similar:       { max: 50,  default: 20 },
  collection_stats:   { max: 500, default: 25 },
} as const;

/** Params that narrow results but are too broad to stand alone as the only filter. */
const MODIFIER_KEYS = new Set(["imageAvailable", "hasProvenance", "expandPlaceHierarchy", "modifiedAfter", "modifiedBefore"]);

/** Provenance filter categorization by layer support. */
const PROVENANCE_EVENT_ONLY_FILTERS = ["transferType", "excludeTransferType", "currency", "hasPrice", "hasGap", "relatedTo", "categoryMethod", "positionMethod"];
const PROVENANCE_PERIOD_ONLY_FILTERS = ["ownerName", "acquisitionMethod", "minDuration", "maxDuration", "periodLocation"];
const PROVENANCE_SHARED_FILTERS = ["party", "location", "dateFrom", "dateTo", "objectNumber", "creator"];
const PROVENANCE_ALL_FILTERS = [...PROVENANCE_SHARED_FILTERS, ...PROVENANCE_EVENT_ONLY_FILTERS, ...PROVENANCE_PERIOD_ONLY_FILTERS];

/** Available facet dimensions for search_artwork. Single source of truth for preprocess + z.enum. */
const FACET_DIMENSIONS = [
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
const stripNull = (v: unknown) =>
  (v === null || v === undefined || v === "null" || v === "") ? undefined : v;

/** Normalize null/arrays into string | string[] | undefined. */
function normalizeStringOrArray(v: unknown): unknown {
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
const stringOrArray = () => z.preprocess(
  normalizeStringOrArray,
  z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
);
const optStr = () => z.preprocess(stripNull, z.string().optional());
const optMinStr = () => z.preprocess(stripNull, z.string().min(1).optional());

type ToolResponse = { content: [{ type: "text"; text: string }] };
type StructuredToolResponse = ToolResponse & { structuredContent: Record<string, unknown> };

/** Infer a TypeScript type from a Zod shape (plain object of ZodTypes used for outputSchema). */
type InferOutput<T extends Record<string, z.ZodTypeAny>> = z.infer<z.ZodObject<T>>;

function errorResponse(message: string) {
  // Never emit structuredContent here — a bare { error } won't conform to
  // any tool's outputSchema (which has required fields like totalResults,
  // results, etc.) and causes the SDK to reject with -32602.
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

/** Return both structured content (for apps/typed clients) and text content (for LLMs).
 *  Set STRUCTURED_CONTENT=false to omit structuredContent (workaround for client bugs). */
const EMIT_STRUCTURED = process.env.STRUCTURED_CONTENT !== "false";

function structuredResponse(data: object, textContent?: string): ToolResponse | StructuredToolResponse {
  const text = textContent ?? JSON.stringify(data, null, 2);
  if (!EMIT_STRUCTURED) {
    return { content: [{ type: "text", text }] };
  }
  return {
    content: [{ type: "text", text }],
    structuredContent: data as Record<string, unknown>,
  };
}

/** Conditionally attach an outputSchema when structured content is enabled. */
function withOutputSchema<T>(schema: T): { outputSchema: T } | Record<never, never> {
  return EMIT_STRUCTURED ? { outputSchema: schema } : {};
}

/** Format a search result as a compact one-liner for LLM content. */
function formatSearchLine(r: { objectNumber: string; title: string; creator: string; date?: string; type?: string; url?: string; nearestPlace?: string; distance_km?: number; groupedChildCount?: number }, i: number): string {
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
function detectComponentClustering(objectNumbers: string[]): string | undefined {
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
function formatFacets(facets: Record<string, Array<{ label: string; count: number; percentage?: number }>>): string {
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
function addPercentages(facets: Record<string, Array<{ label: string; count: number; percentage?: number }>>): void {
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
function truncate(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : s.slice(0, maxLen - 3) + "...";
}

/** Truncate a description snippet to maxLen on a word boundary, appending " [\u2026]" if truncated. */
function truncateSnippet(s: string | undefined, maxLen: number): string | undefined {
  if (!s) return undefined;
  if (s.length <= maxLen) return s;
  const cut = s.lastIndexOf(" ", maxLen);
  return (cut > 0 ? s.slice(0, cut) : s.slice(0, maxLen)) + " [\u2026]";
}

// ─── Rijksmuseum visual search (website API) ─────────────────────────

interface VisualSearchArtObject {
  objectNumber: string;
  title: string;
  makerSubtitleLine: string;
  objectNodeId: string;
  micrioImage?: { micrioId: string } | null;
}

// Module-scope caches for visual search HTTP calls (objectNumber→nodeId is
// essentially immutable; visual results are stable for the duration of a session).
const nodeIdCache = new Map<string, { value: string | null; expiresAt: number }>();
const visualCache = new Map<string, { value: { candidates: SimilarCandidate[]; totalResults: number; searchUrl: string }; expiresAt: number }>();
const NODE_ID_TTL = 60 * 60_000;  // 1 hour (mapping is immutable)
const VISUAL_TTL = 30 * 60_000;   // 30 min (matches similarPages TTL)

/** Resolve an objectNumber to the Rijksmuseum website's objectNodeId (hex hash).
 *  Returns null if the artwork is not in the website search index. */
async function resolveObjectNodeId(objectNumber: string): Promise<string | null> {
  const cached = nodeIdCache.get(objectNumber);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  try {
    const resp = await axios.get("https://www.rijksmuseum.nl/api/v1/collection/search", {
      params: { query: objectNumber, language: "en", pageSize: 5 },
      timeout: 5000,
    });
    const objs: VisualSearchArtObject[] = resp.data?.artObjects ?? [];
    const match = objs.find(o => o.objectNumber === objectNumber);
    const nodeId = match?.objectNodeId ?? null;
    nodeIdCache.set(objectNumber, { value: nodeId, expiresAt: Date.now() + NODE_ID_TTL });
    return nodeId;
  } catch {
    return null;
  }
}

/** Fetch visual similarity results from the Rijksmuseum website API.
 *  Returns candidates + total count + visual search URL, or empty on failure. */
async function fetchVisualSimilar(
  objectNodeId: string,
  maxResults: number,
): Promise<{ candidates: SimilarCandidate[]; totalResults: number; searchUrl: string }> {
  const cacheKey = `${objectNodeId}:${maxResults}`;
  const cached = visualCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const searchUrl = `https://www.rijksmuseum.nl/en/collection/visual/search?objectNodeId=${objectNodeId}`;
  try {
    const resp = await axios.get("https://www.rijksmuseum.nl/api/v1/collection/visualsearch", {
      params: { objectNodeId, language: "en", page: 1, pageSize: maxResults },
      timeout: 8000,
    });
    const objs: VisualSearchArtObject[] = resp.data?.artObjects ?? [];
    const hasMore: boolean = resp.data?.hasMoreResults ?? false;

    const candidates: SimilarCandidate[] = objs.map((o, i) => {
      // Extract creator from makerSubtitleLine (format: "Creator Name, date")
      const creator = o.makerSubtitleLine?.split(",")[0]?.trim() ?? "";
      // IIIF thumbnail via micrio — same pattern as our own thumbnails
      const iiifId = o.micrioImage?.micrioId ?? undefined;
      return {
        objectNumber: o.objectNumber,
        title: o.title ?? "",
        creator,
        iiifId,
        score: maxResults - i, // rank-order score (no similarity scores from API)
        url: `https://www.rijksmuseum.nl/en/collection/${o.objectNumber}`,
      };
    });

    const result = {
      candidates,
      totalResults: hasMore ? maxResults + 1 : objs.length, // indicate "more available"
      searchUrl,
    };
    visualCache.set(cacheKey, { value: result, expiresAt: Date.now() + VISUAL_TTL });
    return result;
  } catch {
    return { candidates: [], totalResults: 0, searchUrl };
  }
}

interface ProvenanceChainEvent {
  sequence: number;
  gap: boolean;
  uncertain: boolean;
  transferType: string;
  party: { name: string } | null;
  location: string | null;
  date: { year: number | null; text: string } | null;
  price: { currency: string; amount: number | null; text: string } | null;
}
type DetailWithChain = (InferOutput<typeof ArtworkDetailOutput> | ArtworkDetailFromDb) & { provenanceChain?: ProvenanceChainEvent[] | null };

/** Format artwork detail as a compact key-value summary for LLM content (Tier 3). */
function formatDetailSummary(d: DetailWithChain): string {
  const lines: string[] = [];
  lines.push(`${d.objectNumber} — ${d.title}`);
  lines.push(`${d.creator}${d.date ? `, ${d.date}` : ""}`);
  if (d.techniqueStatement || d.dimensionStatement) {
    lines.push([d.techniqueStatement, d.dimensionStatement].filter(Boolean).join(", "));
  }
  if (d.location) {
    const parts = [d.location.floor, d.location.roomName, `room ${d.location.roomId}`].filter(Boolean);
    lines.push(parts.join(", "));
  }
  lines.push("");

  const termLabels = (arr: { label: string }[], max = 5) => {
    const labels = arr.map((t) => t.label);
    return labels.length <= max ? labels.join(", ") : labels.slice(0, max).join(", ") + ` ...and ${labels.length - max} more`;
  };

  if (d.objectTypes.length) lines.push(`Types: ${termLabels(d.objectTypes)}`);
  if (d.materials.length) lines.push(`Materials: ${termLabels(d.materials)}`);
  if (d.subjects.iconclass.length) lines.push(`Iconclass: ${d.subjects.iconclass.map((t) => t.id).join(" | ")}`);
  if (d.subjects.depictedPersons.length) lines.push(`Depicted persons: ${termLabels(d.subjects.depictedPersons)}`);
  if (d.subjects.depictedPlaces.length) lines.push(`Depicted places: ${termLabels(d.subjects.depictedPlaces)}`);
  if (d.production.length) {
    const parts = d.production.map((p) => {
      let s = p.attributionQualifier && p.attributionQualifier !== "primary"
        ? `${p.attributionQualifier} ${p.name}` : p.name;
      const pi = p.personInfo;
      if (pi?.birthYear != null || pi?.deathYear != null) {
        s += ` (${pi.birthYear ?? "?"}–${pi.deathYear ?? "?"})`;
      }
      if (p.role) s += ` [${p.role}]`;
      if (p.place) s += `, ${p.place}`;
      return s;
    });
    lines.push(`Production: ${parts.join("; ")}`);
  }

  if (d.description) lines.push(`\n[Description] ${d.description}`);
  if (d.curatorialNarrative.en) lines.push(`[Narrative] ${d.curatorialNarrative.en}`);
  else if (d.curatorialNarrative.nl) lines.push(`[Narrative] ${d.curatorialNarrative.nl}`);
  if (d.inscriptions.length) lines.push(`[Inscriptions] ${d.inscriptions.join("; ")}`);
  if (d.provenance) lines.push(`[Provenance] ${d.provenance}`);
  if (d.provenanceChain?.length) {
    const evts = d.provenanceChain;
    const count = evts.length;
    const gaps = evts.filter(e => e.gap).length;
    const first = evts[0];
    const last = evts[count - 1];
    const years = evts.map(e => e.date?.year).filter((y): y is number => y != null);
    const span = years.length >= 2 ? `${Math.min(...years)}–${Math.max(...years)}` : years.length === 1 ? `${years[0]}` : "";
    lines.push(`[Provenance parsed] ${count} events${gaps ? `, ${pluralize(gaps, "gap")}` : ""}${span ? ` (${span})` : ""}`);

    // Acquisition: how the museum got it (last event)
    if (last) {
      const priceFmt = last.price
        ? `${last.price.currency} ${last.price.amount?.toLocaleString("en") ?? last.price.text}`
        : null;
      const parts = [last.transferType !== "unknown" ? last.transferType : null, last.date?.text, priceFmt].filter(Boolean);
      if (parts.length) lines.push(`  Acquired: ${parts.join(", ")}`);
    }
    // Chain shape: transfer type counts
    const typeCounts = new Map<string, number>();
    for (const e of evts) {
      if (e.transferType !== "unknown") typeCounts.set(e.transferType, (typeCounts.get(e.transferType) ?? 0) + 1);
    }
    const notable = [...typeCounts.entries()].filter(([, n]) => n > 0).map(([t, n]) => n > 1 ? pluralize(n, t) : t);
    if (gaps) notable.push(pluralize(gaps, "gap"));
    if (notable.length) lines.push(`  Chain: ${notable.join(", ")}`);
    // Earliest known owner
    if (first?.party) {
      let earliest = first.party.name;
      if (first.location) earliest += `, ${first.location}`;
      if (first.uncertain) earliest += " (uncertain)";
      lines.push(`  Earliest: ${earliest}`);
    }
  }
  if (d.creditLine) lines.push(`[Credit line] ${d.creditLine}`);

  // Track A: title variants beyond the primary
  if (d.titles && d.titles.length > 0) {
    const byQual = new Map<string, string[]>();
    for (const t of d.titles) {
      const key = `${t.qualifier}/${t.language}`;
      if (!byQual.has(key)) byQual.set(key, []);
      byQual.get(key)!.push(t.title);
    }
    const compact = [...byQual.entries()]
      .map(([k, ts]) => `${k}: ${ts[0]}${ts.length > 1 ? ` (+${ts.length - 1})` : ""}`)
      .join(" | ");
    lines.push(`[Titles] (${d.titles.length} variants) ${compact}`);
  }

  // Track B: parent / child hierarchy
  if (d.parents && d.parents.length > 0) {
    const ps = d.parents.map(p => `${p.objectNumber} — "${p.title}"`).join("; ");
    lines.push(`[Parent] ${ps}`);
  }
  if (d.childCount && d.childCount > 0 && d.children) {
    const preview = d.children.slice(0, 5).map(c => c.objectNumber).join(", ");
    const more = d.childCount > d.children.length ? ` ...and ${d.childCount - d.children.length} more` : "";
    const overflow = d.children.length > 5 ? ` (+${d.children.length - 5} in preview)` : "";
    lines.push(`[Children] (${d.childCount}) ${preview}${overflow}${more}`);
  }

  // Track C: peer artwork relations grouped by relationship type
  if (d.relatedObjectsTotalCount && d.relatedObjectsTotalCount > 0 && d.relatedObjects) {
    const byType = new Map<string, string[]>();
    for (const r of d.relatedObjects) {
      const handle = r.objectNumber ?? r.objectUri;
      if (!byType.has(r.relationship)) byType.set(r.relationship, []);
      byType.get(r.relationship)!.push(handle);
    }
    const groups = [...byType.entries()]
      .map(([rel, ids]) => `${rel}: ${ids.slice(0, 4).join(", ")}${ids.length > 4 ? ` (+${ids.length - 4})` : ""}`)
      .join(" | ");
    const cap = d.relatedObjectsTotalCount > d.relatedObjects.length
      ? ` (showing ${d.relatedObjects.length} of ${d.relatedObjectsTotalCount})` : "";
    lines.push(`[Co-productions]${cap} ${groups}`);
  }

  lines.push(`URL: ${d.url}`);

  return lines.join("\n");
}

/**
 * Render a classification-method code as a compact text-channel tag, or null
 * if it equals the parser default (so the formatter can omit it). Lossless on
 * `rule:*` qualifiers; abbreviates `llm_*` → `llm:*`; strips the
 * `llm_structural:` prefix on correction codes.
 */
function compactMethodTag(method: string | null | undefined, defaultMethod?: string): string | null {
  if (!method) return null;
  if (defaultMethod && method === defaultMethod) return null;
  if (method.startsWith("llm_structural:")) return method.slice("llm_structural:".length);
  if (method.startsWith("llm_")) return "llm:" + method.slice("llm_".length);
  return method;
}

/** Format a curated set as a compact one-liner (Tier 2). */
function formatSetLine(
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
function encodeBrowseSetToken(setSpec: string, offset: number): string {
  return Buffer.from(`${setSpec}\t${offset}`, "utf8").toString("base64");
}
function decodeBrowseSetToken(token: string): { setSpec: string; offset: number } | null {
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
function formatBrowseSetRecord(r: BrowseSetRecord, i: number): string {
  let line = `${i + 1}. ${r.objectNumber}`;
  if (r.title) line += ` | "${r.title}"`;
  if (r.creator) line += ` — ${r.creator}`;
  if (r.date) line += ` (${r.date})`;
  if (r.hasImage) line += " [image]";
  return line;
}

/** Format an OAI-PMH record as a compact one-liner (Tier 2). */
function formatRecordLine(r: Record<string, unknown>, i: number): string {
  const obj = (r.objectNumber as string) || "?";
  const title = (r.title as string) || "";
  const creator = r.creator && typeof r.creator === "object" && (r.creator as Record<string, unknown>).name
    ? (r.creator as Record<string, unknown>).name as string
    : "";
  const type = (r.type as string) || "";
  const datestamp = (r.datestamp as string) || "";
  let line = `${i + 1}. ${obj}`;
  if (datestamp) line += ` | ${datestamp}`;
  if (type) line += ` | ${type}`;
  if (title) line += ` | "${title}"`;
  if (creator) line += ` — ${creator}`;
  return line;
}

/** Create a logging wrapper that records timing to stderr and optional UsageStats. */
function createLogger(stats?: UsageStats) {
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
        return result;
      } catch (err) {
        const ms = Math.round(performance.now() - start);
        const error = err instanceof Error ? err.message : String(err);
        console.error(JSON.stringify({ tool: toolName, ms, ok: false, error, ...(input && { input }) }));
        stats?.record(toolName, ms, false);
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
function paginatedResponse(
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
    return structuredResponse(data, parts.join("\n"));
  }
  return structuredResponse(data);
}

/**
 * Drain an OAI page buffer or fetch a fresh upstream page.
 * Shared by browse_set and get_recent_changes to avoid duplicating buffer-drain logic.
 */
async function drainOaiBuffer(
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
function resolveOaiBuffer(
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

/**
 * Register all tools, resources, and prompts on the given McpServer.
 * `httpPort` is provided when running in HTTP mode so viewer URLs can be generated.
 */
/** Resolve the public base URL from environment. Used by both index.ts and registerTools. */
export function resolvePublicUrl(httpPort?: number): string | undefined {
  if (!httpPort) return undefined;
  return process.env.PUBLIC_URL
    || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${httpPort}`);
}

export function registerAll(
  server: McpServer,
  apiClient: RijksmuseumApiClient,
  oaiClient: OaiPmhClient,
  vocabDb: VocabularyDb | null,
  embeddingsDb: EmbeddingsDb | null,
  embeddingModel: EmbeddingModel | null,
  httpPort?: number,
  stats?: UsageStats
): void {
  registerTools(server, apiClient, oaiClient, vocabDb, embeddingsDb, embeddingModel, httpPort, createLogger(stats));
  registerResources(server);
  registerAppViewerResource(server);
  registerPrompts(server);

  // Log whether the connected client supports MCP Apps (SHOULD-level capability negotiation)
  server.server.oninitialized = () => {
    const clientCaps = server.server.getClientCapabilities();
    const uiCap = getUiCapability(clientCaps);
    if (uiCap) {
      console.error(`[mcp] Client supports MCP Apps (mimeTypes: ${uiCap.mimeTypes?.join(', ') ?? 'none'})`);
    }
  };
}

// ─── Output Schemas (Zod raw shapes for outputSchema) ───────────────

/** Factory — each call returns a unique Zod instance so zod-to-json-schema
 *  won't deduplicate into $ref pointers (which claude.ai cannot resolve). */
const ResolvedTermShape = () => z.object({
  id: z.string(),
  label: z.string(),
  equivalents: z.record(z.string()).optional(),
});

const SearchResultOutput = {
  totalResults: z.number().int().nullable().optional()
    .describe("Total matching artworks (always present when vocabulary DB is available). Use with compact=true for efficient counting."),
  results: z.array(z.object({
    objectNumber: z.string(),
    title: z.string(),
    creator: z.string(),
    date: z.string().optional(),
    type: z.string().optional(),
    url: z.string(),
    nearestPlace: z.string().optional(),
    distance_km: z.number().optional(),
    groupedChildCount: z.number().int().positive().optional()
      .describe("Set on parent records when groupBy='parent' collapses children into them."),
  })).optional().describe("Artwork summaries. Absent when compact=true."),
  ids: z.array(z.string()).optional().describe("Object numbers (compact mode)."),
  source: z.literal("vocabulary").optional(),
  referencePlace: z.string().optional(),
  facets: z.record(z.string(), z.array(z.object({
    label: z.string(),
    count: z.number().int(),
    percentage: z.number().optional(),
  }))).optional().describe("Counts per dimension (configurable via facetLimit, default top-5). Computed when results are truncated and facets is set."),
  warnings: z.array(z.string()).optional(),
  error: z.string().optional(),
};

const ArtworkDetailOutput = {
  // ArtworkSummary base
  id: z.string(),
  objectNumber: z.string(),
  title: z.string(),
  creator: z.string(),
  date: z.string(),
  type: z.string().optional(),
  url: z.string(),
  // ArtworkDetail fields
  description: z.string().nullable(),
  techniqueStatement: z.string().nullable(),
  dimensionStatement: z.string().nullable(),
  provenance: z.string().nullable(),
  provenanceChain: z.array(z.object({
    sequence: z.number().int(),
    gap: z.boolean(),
    uncertain: z.boolean(),
    transferType: z.string().describe("Normalized transfer type: sale, inheritance, by_descent, widowhood, bequest, commission, confiscation, theft, looting, recuperation, loan, transfer, collection, gift, exchange, deposit, restitution, inventory, or unknown."),
    party: z.object({
      name: z.string(),
    }).nullable(),
    location: z.string().nullable(),
    date: z.object({
      year: z.number().int().nullable().describe("Best-effort single year; null if the date couldn't be reduced to a year."),
      text: z.string().describe("Original date expression as it appeared in the source."),
    }).nullable(),
    price: z.object({
      currency: z.string(),
      amount: z.number().nullable(),
      text: z.string(),
    }).nullable(),
  })).nullable()
    .describe("Parsed provenance events derived from the raw `provenance` string via the project's PEG parser. Null when no provenance text is available. Clients can re-derive counts, gaps, year spans, transfer-type histograms, and earliest-known-owner from this array; the text channel renders a summary built from the same data."),
  creditLine: z.string().nullable(),
  inscriptions: z.array(z.string()),
  location: z.object({
    roomId: z.string(),
    floor: z.string().nullable(),
    roomName: z.string().nullable(),
  }).nullable().describe("Current museum room (resolved via current_location → museum_rooms join). Null if not on display."),
  collectionSets: z.array(z.string()),
  externalIds: z.object({
    handle: z.string().nullable().describe("Persistent handle URI (hdl.handle.net)."),
    other: z.array(z.string()).describe("Non-handle external IDs (rare — 14 rows DB-wide as of v0.26)."),
  }),
  // Enriched Group A
  titles: z.array(z.object({
    title: z.string(),
    language: z.enum(TITLE_LANGUAGES),
    qualifier: z.enum(TITLE_QUALIFIERS),
  })),
  curatorialNarrative: z.object({ en: z.string().nullable(), nl: z.string().nullable() }),
  license: z.string().nullable(),
  webPage: z.string().nullable(),
  dimensions: z.array(z.object({
    type: z.enum(DIMENSION_TYPES), value: z.union([z.number(), z.string()]), unit: z.string(), note: z.string().nullable(),
  })),
  relatedObjects: z.array(z.object({
    relationship: z.string().describe("English relationship label: 'different example', 'production stadia', or 'pendant'."),
    objectNumber: z.string().nullable().describe("Peer artwork's object number when it resolves to a row in our DB; null for unresolved Linked Art URIs."),
    title: z.string().nullable().describe("Peer artwork's title when resolved; null otherwise."),
    objectUri: z.string().describe("Original Linked Art URI from the harvest. Pass to get_artwork_details(uri=…) for full peer metadata."),
    iiifId: z.string().nullable().describe("Peer artwork's IIIF identifier when resolved and the peer carries an image; null otherwise. Powers in-viewer prev/next navigation."),
  })).describe("Co-production peer relations — restricted to creator-invariant curator-declared edges ('different example' / 'production stadia' / 'pendant'). Other curator-declared relationships (pair, set, recto|verso, original|reproduction, related object) are exposed via find_similar's Related Object channel rather than here. Capped at 25 entries — see relatedObjectsTotalCount."),
  relatedObjectsTotalCount: z.number().int().nonnegative().describe("Total co-production-relation count before capping. Equals relatedObjects.length when ≤ 25."),
  parents: z.array(z.object({
    objectNumber: z.string(),
    title: z.string(),
  })).describe("Parent records (e.g. the sketchbook this folio belongs to). Empty for top-level objects."),
  childCount: z.number().int().nonnegative().describe("Total number of child records (e.g. folios in a sketchbook). 0 for non-parent objects."),
  children: z.array(z.object({
    objectNumber: z.string(),
    title: z.string(),
  })).describe("Up to 25 child records, ordered by object_number. Use search_artwork to enumerate the full set."),
  persistentId: z.string().nullable(),
  // Enriched Group B
  objectTypes: z.array(ResolvedTermShape()),
  materials: z.array(ResolvedTermShape()),
  production: z.array(z.object({
    name: z.string(), role: z.string().nullable(), attributionQualifier: z.string().nullable(), place: z.string().nullable(), actorUri: z.string(),
    personInfo: z.object({
      birthYear: z.number().int().nullable(),
      deathYear: z.number().int().nullable(),
      gender: z.string().nullable(),
      wikidataId: z.string().nullable(),
    }).optional(),
  })),
  collectionSetLabels: z.array(ResolvedTermShape()),
  // Enriched Group C
  subjects: z.object({
    iconclass: z.array(ResolvedTermShape()),
    depictedPersons: z.array(ResolvedTermShape()),
    depictedPlaces: z.array(ResolvedTermShape()),
  }),
  // Enriched Group D — v0.27 (#291)
  dateDisplay: z.string().nullable()
    .describe("Free-text Rijksmuseum-formatted display date (e.g. '1642', 'c. 1665-1667'). Use this for prose; date for ISO-shaped output."),
  extentText: z.string().nullable()
    .describe("Free-text extent / dimensions string (dcterms:extent). Verbose human-readable form."),
  recordCreated: z.string().nullable()
    .describe("ISO 8601 timestamp of catalogue record creation."),
  recordModified: z.string().nullable()
    .describe("ISO 8601 timestamp of catalogue record's most recent modification."),
  themes: z.array(ResolvedTermShape())
    .describe("Curatorial thematic tags (overseas history, political history, costume, …)."),
  themesTotalCount: z.number().int().nonnegative(),
  exhibitions: z.array(z.object({
    exhibitionId: z.number().int(),
    titleEn: z.string().nullable(),
    titleNl: z.string().nullable(),
    dateStart: z.string().nullable(),
    dateEnd: z.string().nullable(),
  })).describe("Exhibitions this artwork has appeared in. Most-recent first."),
  exhibitionsTotalCount: z.number().int().nonnegative(),
  attributionEvidence: z.array(z.object({
    partIndex: z.number().int().nonnegative()
      .describe("Upstream LinkedArt part index (preserved for future correlation; do not assume it maps to production[] index)."),
    evidenceTypeAat: z.string().nullable()
      .describe("AAT URI for evidence type (signature, inscription, ...). Labels not yet harvested."),
    carriedByUri: z.string().nullable()
      .describe("Linked Art URI of the inscription/signature object."),
    labelText: z.string().nullable()
      .describe("Free-text label of the evidence (e.g. transcribed signature)."),
  })).describe("Evidence supporting attribution claims (signatures, inscriptions, monograms, …). Artwork-level — partIndex preserves upstream ordering but does NOT map to production[] index."),
  error: z.string().optional(),
};

const ImageInfoOutput = {
  objectNumber: z.string(),
  title: z.string().optional(),
  creator: z.string().nullable().optional(),
  date: z.string().nullable().optional(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  license: z.string().nullable().optional(),
  physicalDimensions: z.string().nullable().optional(),
  collectionUrl: z.string().optional(),
  iiifInfoUrl: z.string().optional(),
  viewUUID: z.string().optional().describe("Viewer session ID for use with navigate_viewer."),
  error: z.string().optional(),
};

const InspectImageOutput = {
  objectNumber: z.string(),
  region: z.string(),
  requestedSize: z.number().int(),
  nativeWidth: z.number().int().optional(),
  nativeHeight: z.number().int().optional(),
  cropPixelWidth: z.number().int().optional()
    .describe("Actual width in pixels of the returned inspect image/crop. Use with cropPixelHeight for crop-local pixel overlays."),
  cropPixelHeight: z.number().int().optional()
    .describe("Actual height in pixels of the returned inspect image/crop. Use with cropPixelWidth for crop-local pixel overlays."),
  cropRegion: z.string().optional()
    .describe("Normalized IIIF region used for the fetch; crop_pixels: inputs are normalized to plain IIIF pixel regions."),
  rotation: z.number().int(),
  quality: z.string(),
  fetchTimeMs: z.number().int().optional().describe("Time spent fetching from IIIF server (ms)"),
  viewUUID: z.string().optional().describe("Active viewer session ID (if a viewer is open for this artwork)"),
  viewerNavigated: z.boolean().optional().describe("Whether the viewer was auto-navigated to the inspected region"),
  overlaysRendered: z.number().int().optional().describe("Number of viewer overlays composited onto the returned image (show_overlays only)"),
  overlaysSkipped: z.number().int().optional().describe("Number of viewer overlays that fell outside the inspected region and were not drawn (show_overlays only)"),
  overlaysError: z.string().optional().describe("Reason the composite couldn't proceed when show_overlays was requested (e.g. 'no_active_viewer', 'compositor_failed')"),
  error: z.string().optional(),
};

const PaginatedBase = {
  returnedCount: z.number().int(),
  records: z.array(z.record(z.unknown())),
  resumptionToken: z.string().optional(),
  hint: z.string().optional(),
  error: z.string().optional(),
};

const BrowseSetOutput = {
  records: z.array(z.object({
    objectNumber: z.string(),
    title: z.string(),
    creator: z.string(),
    date: z.string(),
    description: z.string().optional(),
    dimensions: z.string().optional(),
    datestamp: z.string().optional(),
    hasImage: z.boolean(),
    imageUrl: z.string().optional(),
    iiifServiceUrl: z.string().optional(),
    edmType: z.string().optional(),
    lodUri: z.string(),
    url: z.string(),
  })),
  totalInSet: z.number().int().optional(),
  resumptionToken: z.string().optional(),
  error: z.string().optional(),
};

const RecentChangesOutput = {
  ...PaginatedBase,
  totalChanges: z.number().int().optional(),
  identifiersOnly: z.boolean().optional(),
};

const SemanticSearchOutput = {
  searchMode: z.enum(["semantic", "semantic+filtered"]),
  query: z.string(),
  returnedCount: z.number().int(),
  results: z.array(z.object({
    rank: z.number().int(),
    objectNumber: z.string(),
    title: z.string(),
    creator: z.string(),
    date: z.string().optional(),
    type: z.string().optional(),
    similarityScore: z.number(),
    sourceText: z.string().optional(),
    url: z.string(),
  })),
  warnings: z.array(z.string()).optional(),
  error: z.string().optional(),
};

const CuratedSetsOutput = {
  totalSets: z.number().int(),
  filteredFrom: z.number().int().optional(),
  query: z.string().optional(),
  sets: z.array(z.object({
    setSpec: z.string(),
    name: z.string(),
    lodUri: z.string(),
    memberCount: z.number().int().optional(),
    dominantTypes: z.array(z.object({
      label: z.string(),
      count: z.number().int(),
    })).optional(),
    dominantCenturies: z.array(z.object({
      century: z.string(),
      count: z.number().int(),
    })).optional(),
    category: z.enum(["object_type", "iconographic", "album", "sub_collection", "umbrella"]).nullable().optional(),
  })),
  error: z.string().optional(),
};

// ─── Shared IIIF region validation ───────────────────────────────────

const IIIF_REGION_RE = /^(full|square|\d+,\d+,\d+,\d+|pct:[0-9.]+,[0-9.]+,[0-9.]+,[0-9.]+|crop_pixels:\d+,\d+,\d+,\d+)$/;

// ─── Viewer command queue (module-scoped — survives across HTTP requests) ─

interface ViewerCommand {
  action: "navigate" | "add_overlay" | "clear_overlays";
  region?: string;
  relativeTo?: string;
  relativeToSize?: CropLocalSize;
  label?: string;
  color?: string;
}
interface OverlayEntry {
  label?: string;
  region: string;
  color?: string;
}
interface ViewerQueue {
  commands: ViewerCommand[];
  createdAt: number;
  lastAccess: number;
  lastPolledAt?: number;
  objectNumber: string;
  imageWidth?: number;
  imageHeight?: number;
  activeOverlays: OverlayEntry[];
}
/** Start a 60s interval that deletes entries older than `ttlMs` from a Map. */
function sweepTtlMap<T extends { lastAccess: number }>(map: Map<string, T>, ttlMs = 1_800_000): void {
  setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of map) {
      if (now - entry.lastAccess > ttlMs) map.delete(id);
    }
  }, 60_000).unref();
}

const viewerQueues = new Map<string, ViewerQueue>();
sweepTtlMap(viewerQueues);

const ACTIVE_OVERLAYS_CAP = 64;

export const similarPages = new Map<string, { html: string; lastAccess: number }>();
sweepTtlMap(similarPages);

export const enrichmentReviewPages = new Map<string, { html: string; lastAccess: number }>();
sweepTtlMap(enrichmentReviewPages);

/** Stdio-mode temp files for find_similar. Swept on same 30-min TTL. */
const similarTempFiles = new Map<string, number>(); // path → createdAt
setInterval(() => {
  const now = Date.now();
  for (const [filePath, createdAt] of similarTempFiles) {
    if (now - createdAt > 1_800_000) {
      try { fs.unlinkSync(filePath); } catch { /* already gone */ }
      similarTempFiles.delete(filePath);
    }
  }
}, 60_000).unref();

// ─── Geometry helpers (pure) ─────────────────────────────────────────

// Exported for testing
export function regionToPixels(region: string, w: number, h: number): string | undefined {
  const p = parsePctRegion(region);
  if (!p) return undefined;
  return `${Math.round(p[0] * w / 100)},${Math.round(p[1] * h / 100)},${Math.round(p[2] * w / 100)},${Math.round(p[3] * h / 100)}`;
}

// Exported for testing
export function parsePctRegion(region: string): [number, number, number, number] | null {
  const m = region.match(/^pct:([0-9.]+),([0-9.]+),([0-9.]+),([0-9.]+)$/);
  if (!m) return null;
  return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]), parseFloat(m[4])];
}

// Exported for testing
export function parseCropPixelsRegion(region: string): [number, number, number, number] | null {
  const m = region.match(/^crop_pixels:(\d+),(\d+),(\d+),(\d+)$/);
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10), parseInt(m[4], 10)];
}

// Exported for testing
/** Strip `crop_pixels:` prefix, return plain IIIF pixel region. */
export function cropPixelsToIiifPixels(region: string): string | null {
  const p = parseCropPixelsRegion(region);
  if (!p) return null;
  return `${p[0]},${p[1]},${p[2]},${p[3]}`;
}

export interface OobWarning {
  warning: "overlay_region_out_of_bounds";
  details: {
    requested: string;
    clamped_to: string;
    issue: string;
    valid_range: string;
  };
}

/** Shape an out-of-bounds error: `emit` returns a tool error in the caller's format. */
function oobError<E>(oob: OobWarning, hint: string, emit: (error: string, text?: string) => E): E {
  const payload = JSON.stringify(oob, null, 2);
  return emit(`overlay_region_out_of_bounds: ${oob.details.issue}`, `${payload}\n\n${hint}`);
}

// Exported for testing
/**
 * Validate region bounds. Returns null if in-bounds (or bounds-check skipped).
 * For pct: always checkable. For crop_pixels/plain-pixels: requires imgW/imgH.
 */
export function checkRegionBounds(
  region: string,
  imgW?: number,
  imgH?: number,
): OobWarning | null {
  if (region === "full" || region === "square") return null;

  const pct = parsePctRegion(region);
  if (pct) {
    const [x, y, w, h] = pct;
    const issues: string[] = [];
    if (x < 0 || x > 100) issues.push(`x=${x} outside 0–100`);
    if (y < 0 || y > 100) issues.push(`y=${y} outside 0–100`);
    if (w <= 0) issues.push(`w=${w} must be > 0`);
    if (h <= 0) issues.push(`h=${h} must be > 0`);
    if (x + w > 100.01) issues.push(`x+w=${(x + w).toFixed(2)} exceeds 100`);
    if (y + h > 100.01) issues.push(`y+h=${(y + h).toFixed(2)} exceeds 100`);
    if (issues.length === 0) return null;
    const cx = Math.max(0, Math.min(100, x));
    const cy = Math.max(0, Math.min(100, y));
    const cw = Math.max(0, Math.min(100 - cx, w));
    const ch = Math.max(0, Math.min(100 - cy, h));
    return {
      warning: "overlay_region_out_of_bounds",
      details: {
        requested: region,
        clamped_to: `pct:${cx},${cy},${cw},${ch}`,
        issue: issues.join("; "),
        valid_range: "each value must be between 0 and 100, and x+w, y+h must not exceed 100",
      },
    };
  }

  // crop_pixels: or plain IIIF pixels
  const cp = parseCropPixelsRegion(region);
  const plainPixels = region.match(/^(\d+),(\d+),(\d+),(\d+)$/);
  const pixelMatch: [number, number, number, number] | null =
    cp ?? (plainPixels
      ? [parseInt(plainPixels[1], 10), parseInt(plainPixels[2], 10), parseInt(plainPixels[3], 10), parseInt(plainPixels[4], 10)]
      : null);
  if (!pixelMatch) return null;
  const [x, y, w, h] = pixelMatch;
  const issues: string[] = [];
  if (w <= 0) issues.push(`w=${w} must be > 0`);
  if (h <= 0) issues.push(`h=${h} must be > 0`);
  if (imgW != null && imgH != null) {
    if (x < 0 || x >= imgW) issues.push(`x=${x} outside 0–${imgW - 1}`);
    if (y < 0 || y >= imgH) issues.push(`y=${y} outside 0–${imgH - 1}`);
    if (x + w > imgW) issues.push(`x+w=${x + w} exceeds imageWidth=${imgW}`);
    if (y + h > imgH) issues.push(`y+h=${y + h} exceeds imageHeight=${imgH}`);
  }
  if (issues.length === 0) return null;
  const prefix = cp ? "crop_pixels:" : "";
  const cx = imgW != null ? Math.max(0, Math.min(imgW - 1, x)) : x;
  const cy = imgH != null ? Math.max(0, Math.min(imgH - 1, y)) : y;
  const cw = imgW != null ? Math.max(0, Math.min(imgW - cx, w)) : Math.max(0, w);
  const ch = imgH != null ? Math.max(0, Math.min(imgH - cy, h)) : Math.max(0, h);
  return {
    warning: "overlay_region_out_of_bounds",
    details: {
      requested: region,
      clamped_to: `${prefix}${cx},${cy},${cw},${ch}`,
      issue: issues.join("; "),
      valid_range: imgW != null
        ? `x in [0, ${imgW}), y in [0, ${imgH}), x+w ≤ ${imgW}, y+h ≤ ${imgH}, w>0, h>0`
        : "w>0, h>0 (image dimensions unknown — open the viewer with get_artwork_image for stricter checking)",
    },
  };
}

/**
 * Classify how a navigate_viewer call's commands will reach the iframe,
 * given the queue's last-poll timestamp. Pure for unit testing.
 *
 *   delivered_recently         — iframe polled within `recentMs` and will drain on its next tick
 *   queued_waiting_for_viewer  — iframe has polled before but not recently (typical when scrolled offscreen)
 *   no_live_viewer_seen        — no poll has been recorded for this UUID yet
 */
export type DeliveryState =
  | "delivered_recently"
  | "queued_waiting_for_viewer"
  | "no_live_viewer_seen";

export function computeDeliveryState(
  lastPolledAtMs: number | undefined,
  nowMs: number,
  recentMs = 5000,
): DeliveryState {
  if (lastPolledAtMs == null) return "no_live_viewer_seen";
  if (nowMs - lastPolledAtMs < recentMs) return "delivered_recently";
  return "queued_waiting_for_viewer";
}

// Exported for testing
interface CropLocalSize {
  width: number;
  height: number;
}

// Exported for testing
/** Project crop-local pct or crop-local pixel coordinates to full-image pct space. */
export function projectToFullImage(local: string, relativeTo: string, localSize?: CropLocalSize): string | null {
  const o = parsePctRegion(relativeTo);
  if (!o) return null;
  const pct = parsePctRegion(local);
  const px = parseCropPixelsRegion(local);
  if (!pct && !px) return null;
  if (px && !localSize) return null;

  const l = pct ?? [
    (px![0] / localSize!.width) * 100,
    (px![1] / localSize!.height) * 100,
    (px![2] / localSize!.width) * 100,
    (px![3] / localSize!.height) * 100,
  ];
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const fx = round2(o[0] + (l[0] / 100) * o[2]);
  const fy = round2(o[1] + (l[1] / 100) * o[3]);
  const fw = round2((l[2] / 100) * o[2]);
  const fh = round2((l[3] / 100) * o[3]);
  return `pct:${fx},${fy},${fw},${fh}`;
}

// ─── Tools ──────────────────────────────────────────────────────────

function registerTools(
  server: McpServer,
  api: RijksmuseumApiClient,
  oai: OaiPmhClient,
  vocabDb: VocabularyDb | null,
  embeddingsDb: EmbeddingsDb | null,
  embeddingModel: EmbeddingModel | null,
  httpPort: number | undefined,
  withLogging: ReturnType<typeof createLogger>
): void {
  const publicBaseUrl = resolvePublicUrl(httpPort);

  // ── search_artwork ──────────────────────────────────────────────

  // Vocabulary-backed search params (require vocabulary DB)
  const vocabAvailable = vocabDb?.available ?? false;
  // All search parameters that the vocab DB handles.
  // With vocab-DB-only routing (v0.19), every parameter routes through the vocab DB.
  const vocabParamKeys = [
    "subject", "iconclass", "depictedPerson", "depictedPlace", "productionPlace",
    "collectionSet", "license",
    // Tier 2 (vocabulary DB v1.0+)
    "description", "inscription", "creditLine", "curatorialNarrative", "productionRole", "attributionQualifier",
    "minHeight", "maxHeight", "minWidth", "maxWidth",
    "nearPlace", "nearLat", "nearLon",
    "title",
    "material", "technique", "type", "creator",
    "creationDate",
    "imageAvailable",
    "hasProvenance",
    "aboutActor",
    // Place hierarchy
    "expandPlaceHierarchy",
    // v0.27 — curatorial theme + source-channel taxonomy + record-modified date range
    "theme", "sourceType", "modifiedAfter", "modifiedBefore",
  ] as const;
  // nearPlaceRadius excluded from routing key check: its Zod default (25) would trigger
  // on every query. Forwarded separately. sortBy/sortOrder are also forwarded but never
  // count as substantive filters for the "at-least-one-filter-required" check.
  const allVocabKeys = [...vocabParamKeys, "nearPlaceRadius", "dateMatch", "sortBy", "sortOrder"] as const;

  server.registerTool(
    "search_artwork",
    {
      title: "Search Artwork",
      annotations: ANN_READ_CLOSED,
      description:
        "Use when you have specific filter criteria (subject, material, technique, dates, place, person, theme, …) and want artworks matching ALL filters. " +
        "Returns artwork summaries with titles, creators, and dates; every response includes totalResults (exact match count, not just the returned page). " +
        "Not for free-text concept queries — use semantic_search for those. " +
        "Not for artwork-to-artwork similarity — use find_similar with an objectNumber. " +
        "For demographic person queries (gender, born/died, profession, birth/death place), use search_persons first to get a vocabId, then pass it as creator here. " +
        "For provenance text and ownership history, use search_provenance. " +
        "For aggregate counts and distributions, prefer collection_stats — one call vs compact=true loops.\n\n" +
        "Ranking: relevance (BM25) when text search (description, title, etc.) or geographic proximity is used; otherwise importance (image availability, curatorial attention, metadata richness). " +
        "For concept-ranked results, use semantic_search.\n\n" +
        "At least one filter is required. There is no full-text search across all metadata. " +
        "For concept or thematic searches (e.g. 'winter landscape', 'smell', 'crucifixion'), ALWAYS start with subject — it searches ~832K artworks tagged with structured Iconclass vocabulary and has by far the highest recall for conceptual queries. " +
        "Use description for cataloguer observations (compositional details, specific motifs); use curatorialNarrative for curatorial interpretation and art-historical context. These three corpora can return complementary results. " +
        "For broader concept discovery beyond structured vocabulary, use semantic_search — but combine it with search_artwork(type: 'painting', …) for painting queries since paintings are underrepresented there.\n\n" +
        "Array values are AND-combined (e.g. subject: ['landscape', 'seascape'] finds artworks with both). " +
        "If many results share an object-number prefix (e.g. multiple folios of one sketchbook), a `warnings` note flags it; narrow with type/material filters or treat the shared prefix as the unit. " +
        "Each result carries an objectNumber for follow-up calls to get_artwork_details (full metadata) or get_artwork_image (deep-zoom viewer — only when the user asks to see, show, or view an artwork; do not open the viewer for list/count/summary requests)." +
        (vocabAvailable
          ? " All parameters combine freely. Vocabulary labels are bilingual (English and Dutch); try the Dutch term if English returns no results (e.g. 'fotograaf' instead of 'photographer'). " +
            "For proximity search, use nearPlace with a place name, or nearLat/nearLon for arbitrary locations. " +
            "Use creditLine for acquisition channel analysis (e.g. 'gift', 'bequest', 'Vereniging Rembrandt'). " +
            "v0.27 added theme, sourceType, modifiedAfter, modifiedBefore filters; removed the per-tool provenance text filter and 6 demographic creator filters (use search_persons → creator: <vocabId> instead)."
          : ""),
      inputSchema: z.object({
        query: optStr()
          .optional()
          .describe(
            "General search term — maps to title search in the vocabulary database (equivalent to the title parameter). For more targeted results, use the specific field parameters instead (creator, description, subject, etc.)"
          ),
        title: optStr()
          .optional()
          .describe("Search by artwork title, matching against all title variants (brief, full, former × EN/NL). Equivalent to query but explicit. Note: only ~4% of artworks have an English title (~35K of 833K)."),
        creator: stringOrArray()
          .optional()
          .describe("Search by artist name, e.g. 'Rembrandt van Rijn'."),
        aboutActor: optStr()
          .optional()
          .describe(
            "Search for artworks depicting or about a person (not the creator). E.g. 'Willem van Oranje'. " +
            "Broader recall than depictedPerson — searches both subject and creator vocabulary, tolerant of " +
            "cross-language name forms (e.g. 'Louis XIV' finds 'Lodewijk XIV'). Combinable with all other filters. " +
            "depictedPerson is usually the better first choice (precise, depicted persons only); " +
            "use aboutActor for broader person matching across depicted persons and creators."
          ),
        type: stringOrArray()
          .optional()
          .describe("Filter by object type: 'painting', 'print', 'drawing', etc."),
        material: stringOrArray()
          .optional()
          .describe("Filter by material: 'canvas', 'paper', 'wood', etc."),
        technique: stringOrArray()
          .optional()
          .describe("Filter by technique: 'oil painting', 'etching', etc."),
        creationDate: optStr()
          .optional()
          .describe(
            "Filter by creation date. Exact year ('1642') or wildcard ('16*' for 1600s, '164*' for 1640s)."
          ),
        dateMatch: z.preprocess(stripNull,
          z.enum(["overlaps", "within", "midpoint"]).optional(),
        ).describe(
            "How creationDate matches artwork date ranges. " +
            "\"overlaps\" (default): artwork range overlaps query range — inclusive, but objects with broad ranges appear in multiple bins. " +
            "\"within\": artwork range falls entirely within query range — exclusive bins, but drops broadly-dated objects (~43% of collection spans >1 decade). " +
            "\"midpoint\": assigns each artwork to one bin by midpoint of its date range — every object counted exactly once with no data loss. Best for statistical comparisons and charts."
          ),
        description: optStr()
          .optional()
          .describe(
            "Full-text search on artwork descriptions (~510K artworks, 61% coverage). " +
            "Cataloguer observations including compositional details, motifs, physical condition, and attribution remarks. " +
            "Exact word matching, no stemming."
          ),
        imageAvailable: z
          .boolean()
          .optional()
          .describe(
            "If true, only return artworks that have a digital image available. " +
            "Cannot be used alone — combine with at least one other filter."
          ),
        hasProvenance: z
          .boolean()
          .optional()
          .describe(
            "If true, only return artworks that have parsed provenance records (~48K of 832K). " +
            "Combine with other filters for cross-domain queries (e.g. type='painting' + hasProvenance=true). " +
            "Cannot be used alone — combine with at least one other filter."
          ),
        modifiedAfter: optMinStr()
          .optional()
          .describe(
            "ISO 8601 date — return only artworks whose catalogue record was last modified at or after " +
            "this date (e.g. '2024-01-01'). Powers \"what changed since YYYY-MM-DD?\" without OAI-PMH. " +
            "Cannot be used alone — combine with at least one other filter."
          ),
        modifiedBefore: optMinStr()
          .optional()
          .describe(
            "ISO 8601 date — return only artworks whose catalogue record was last modified at or before this date. " +
            "Cannot be used alone — combine with at least one other filter."
          ),
        // Vocabulary-backed params
        ...(vocabAvailable
          ? {
              subject: stringOrArray()
                .optional()
                .describe(
                  "PRIMARY parameter for concept or thematic searches — use this first, before description or curatorialNarrative. " +
                  "Searches ~832K artworks by subject matter (Iconclass themes, depicted scenes). " +
                  "Has basic English morphological expansion (singular/plural, -ing, -ed) as a fallback — " +
                  "'cat' matches 'cats' and 'painting' matches 'paint', but unrelated derivations like " +
                  "'crucifixion' vs 'crucified' are not linked. " +
                  "If a subject query returns 0 results, try different word forms " +
                  "or use the Iconclass server's search tool to find the canonical Iconclass notation code for more reliable matching. " +
                  "Also covers historical events using Dutch labels (e.g. 'Tweede Wereldoorlog', 'Tachtigjarige Oorlog'). " +
                  "Subject matching does not distinguish primary from incidental/decorative subjects — " +
                  "a mortar with an Annunciation relief will match 'Annunciation'. Combine with type (e.g. type: 'painting') to filter."
                ),
              iconclass: stringOrArray()
                .optional()
                .describe(
                  "Exact Iconclass notation code (e.g. '34B11' for dogs, '73D82' for Crucifixion). More precise than subject (exact code vs. label text) — use the Iconclass server's search tool to discover codes by concept."
                ),
              depictedPerson: stringOrArray()
                .optional()
                .describe(
                  "Search for artworks depicting a specific person by name (e.g. 'Willem van Oranje'). " +
                  "Matches against 210K name variants including historical forms. Combinable with all vocabulary filters. " +
                  "Searches depicted persons only; use aboutActor for broader person matching (depicted + creators)."
                ),
              depictedPlace: stringOrArray()
                .optional()
                .describe(
                  "Search for artworks depicting a specific place by name (e.g. 'Amsterdam'). " +
                  "Supports multi-word and ambiguous place names with geo-disambiguation (e.g. 'Oude Kerk Amsterdam')."
                ),
              productionPlace: stringOrArray()
                .optional()
                .describe(
                  "Search for artworks produced in a specific place (e.g. 'Delft'). " +
                  "Supports multi-word and ambiguous place names with geo-disambiguation (e.g. 'Paleis van Justitie Den Haag')."
                ),
              collectionSet: stringOrArray()
                .optional()
                .describe(
                  "Search for artworks in curated collection sets by name (e.g. 'Rembrandt', 'Japanese'). " +
                  "Use list_curated_sets to discover available sets."
                ),
              theme: stringOrArray()
                .optional()
                .describe(
                  "Curatorial thematic tag (e.g. 'overzeese geschiedenis', 'economische geschiedenis', 'costume'). " +
                  "Distinct from subject (Iconclass) and depicted persons/places — themes group works around " +
                  "collection-level narratives. ~7% of artworks have at least one theme; coverage is skewed " +
                  "to historical-collection works. Most theme labels are Dutch (~17% have curated English labels)."
                ),
              sourceType: stringOrArray()
                .optional()
                .describe(
                  "Source-channel classification: 'designs' (90K), 'drawings' (49K), 'paintings' (46K), " +
                  "'prints (visual works)' (19K), 'sculpture (visual works)' (5K), 'photographs' (3K). " +
                  "Distinct from `type` — sourceType reflects the cataloguing source, while type uses " +
                  "Linked Art object-classification vocabulary."
                ),
              license: optMinStr()
                .optional()
                .describe(
                  "Filter by license/rights. Common values: 'publicdomain', 'zero' (CC0), 'by' (CC BY). " +
                  "Matches against the rights URI."
                ),
              inscription: optMinStr()
                .optional()
                .describe(
                  "Full-text search on inscription texts (~500K artworks — signatures, mottoes, dates on the object surface, not conceptual content). " +
                  "Exact word matching, no stemming. E.g. 'Rembrandt f.' for signed works, Latin phrases."
                ),
              creditLine: optMinStr()
                .optional()
                .describe(
                  "Full-text search on credit/donor lines (e.g. 'Drucker' for Drucker-Fraser bequest). " +
                  "Exact word matching, no stemming."
                ),
              curatorialNarrative: optMinStr()
                .optional()
                .describe(
                  "Full-text search on curatorial narrative (~14K artworks with museum wall text). " +
                  "Best for art-historical interpretation, exhibition context, and scholarly commentary — " +
                  "content written by curators that goes beyond what structured vocabulary captures. " +
                  "Exact word matching, no stemming. For broad concept searches, start with subject instead."
                ),
              productionRole: stringOrArray()
                .optional()
                .describe(
                  "Search by production role (e.g. 'painter', 'printmaker', 'after painting by'). " +
                  "Covers craft roles and relational attribution terms. " +
                  "For attribution qualifiers (workshop of, follower of, circle of), use attributionQualifier instead."
                ),
              attributionQualifier: stringOrArray()
                .optional()
                .describe(
                  "Filter by attribution qualifier. Full enumerated set (13 values, ordered by DB frequency): " +
                  "'primary', 'undetermined', 'after', 'secondary', 'possibly', 'attributed to', " +
                  "'circle of', 'workshop of', 'copyist of', 'manner of', 'follower of', 'falsification', 'free-form'. " +
                  "Mixes connoisseurship terms (workshop of, circle of, follower of, manner of, copyist of), " +
                  "editorial-confidence terms (attributed to, possibly, undetermined), and structural markers (primary, secondary, after, falsification, free-form). " +
                  "Combine with creator to narrow attribution (e.g. attributionQualifier: 'workshop of' + creator: 'Rembrandt')."
                ),
              expandPlaceHierarchy: z.preprocess(stripNull, z
                .boolean()
                .optional()
                .describe(
                  "When true, place searches (productionPlace, depictedPlace) " +
                  "expand to include sub-places in the administrative hierarchy. " +
                  "E.g. productionPlace: 'Netherlands' with expandPlaceHierarchy: true includes Amsterdam, Delft, etc. " +
                  "Expansion follows up to 3 levels of parent→child relationships. " +
                  "Requires a place filter — cannot be used alone."
                )),
              minHeight: z
                .number()
                .optional()
                .describe(
                  "Minimum height in centimeters."
                ),
              maxHeight: z
                .number()
                .optional()
                .describe(
                  "Maximum height in centimeters."
                ),
              minWidth: z
                .number()
                .optional()
                .describe(
                  "Minimum width in centimeters."
                ),
              maxWidth: z
                .number()
                .optional()
                .describe(
                  "Maximum width in centimeters."
                ),
              nearPlace: optMinStr()
                .optional()
                .describe(
                  "Search for artworks related to places near a named location (e.g. 'Leiden'). " +
                  "Supports multi-word place names with geo-disambiguation (e.g. 'Oude Kerk Amsterdam' resolves to the Oude Kerk in Amsterdam). " +
                  "Searches both depicted and production places within the specified radius."
                ),
              nearLat: z
                .number()
                .min(-90)
                .max(90)
                .optional()
                .describe(
                  "Latitude for coordinate-based proximity search (-90 to 90). Use with nearLon. " +
                  "Alternative to nearPlace for searching near arbitrary locations."
                ),
              nearLon: z
                .number()
                .min(-180)
                .max(180)
                .optional()
                .describe(
                  "Longitude for coordinate-based proximity search (-180 to 180). Use with nearLat."
                ),
              nearPlaceRadius: z
                .number()
                .min(0.1)
                .max(500)
                .default(25)
                .describe(
                  "Radius in kilometers for nearPlace or nearLat/nearLon search (0.1-500, default 25)."
                ),
            }
          : {}),
        maxResults: z
          .number()
          .int()
          .min(1)
          .max(TOOL_LIMITS.search_artwork.max)
          .default(TOOL_LIMITS.search_artwork.default)
          .describe(`Maximum results to return (1-${TOOL_LIMITS.search_artwork.max}, default ${TOOL_LIMITS.search_artwork.default}). All results include full metadata.`),
        offset: z.preprocess(stripNull, z.number().int().min(0).default(0).optional())
          .describe("Skip this many results (for pagination). Use with maxResults."),
        facets: z.preprocess(
          (v) => {
            if (v === true) return [...FACET_DIMENSIONS];
            if (v === false || v === null || v === undefined) return undefined;
            return v;
          },
          z.array(z.enum(FACET_DIMENSIONS)).optional(),
        ).describe(
            "Facet dimensions to compute when results are truncated. " +
            "Pass an array of dimension names (e.g. [\"theme\", \"rights\"]) to compute only those, " +
            "or true for all dimensions. " +
            `Available: ${FACET_DIMENSIONS.join(", ")}. ` +
            "Dimensions already filtered on are excluded automatically."
          ),
        facetLimit: z.preprocess(stripNull, z.number().int().min(1).max(50).default(5).optional())
          .describe("Maximum entries per facet dimension (1–50, default 5)."),
        compact: z
          .boolean()
          .default(false)
          .describe(
            "If true, returns only total count and IDs without resolving details (faster)."
          ),
        groupBy: z
          .enum(["parent"])
          .optional()
          .describe(
            "Collapse component records under their parent (sketchbook folios, album pages, print-series leaves). " +
            "When 'parent' is set, any child record that appears in the result alongside its parent is dropped, " +
            "and the parent gains a `groupedChildCount`. Only collapses when both child and parent match the query " +
            "— children whose parent isn't a hit remain in the result. Applied after the BM25 page is selected, " +
            "so a parent that ranks below the maxResults cutoff won't pull its children in. Closes #28.",
          ),
        sortBy: z
          .enum(["height", "width", "dateEarliest", "dateLatest", "recordModified"])
          .optional()
          .describe(
            "Order results by a column instead of relevance/importance. " +
            "Overrides BM25 (text-match) and geo-proximity ordering when set. Cannot be used alone — needs at least one substantive filter.\n\n" +
            "Values: " +
            "'height' / 'width' (cm — 95% / 94% coverage; 0.0 sentinels are folded to NULL and ordered last), " +
            "'dateEarliest' / 'dateLatest' (year — 99.9% coverage; bracket the dating range, useful for hedged datings like 'c. 1660–1665'), " +
            "'recordModified' (ISO date — 62% coverage; ~7 implausibly future-dated rows lead a 'desc' sort, ~2K pre-1990 rows lead an 'asc' sort)."
          ),
        sortOrder: z
          .enum(["asc", "desc"])
          .optional()
          .describe(
            "Sort direction (default 'desc'). NULLs always sort last regardless of direction. " +
            "Examples: largest paintings → sortBy='height', sortOrder='desc'; earliest works → sortBy='dateEarliest', sortOrder='asc'; " +
            "most recently catalogued → sortBy='recordModified', sortOrder='desc'."
          ),
        pageToken: optStr()
          .optional()
          .describe("Deprecated. Pagination is not supported in the current search backend. Use maxResults to control result count."),
      }).strict(),
      ...withOutputSchema(SearchResultOutput),
    },
    withLogging("search_artwork", async (args) => {
      if (!vocabAvailable || !vocabDb) {
        return errorResponse(
          "search_artwork requires the vocabulary database. " +
          "Ensure VOCAB_DB_PATH or VOCAB_DB_URL is configured."
        );
      }

      const argsRecord = args as Record<string, unknown>;

      // At least one substantive filter required (prevent unfiltered full-collection scans).
      const hasAnyFilter = vocabParamKeys.some(k =>
          !MODIFIER_KEYS.has(k) && argsRecord[k] !== undefined
        ) || argsRecord["query"] !== undefined;
      if (!hasAnyFilter) {
        return errorResponse(
          "At least one search filter is required (imageAvailable, hasProvenance, modifiedAfter/Before, " +
          "and expandPlaceHierarchy are modifiers that cannot be used alone). " +
          "Add a filter like subject, creator, type, material, technique, depictedPerson, or creationDate. " +
          "For demographic queries (gender, birth/death place, profession), use search_persons → search_artwork({creator: <vocabId>}). " +
          "For concept-based search, try semantic_search instead."
        );
      }

      const vocabArgs: Record<string, unknown> = { maxResults: args.maxResults, offset: args.offset };
      for (const k of allVocabKeys) {
        if (argsRecord[k] !== undefined) vocabArgs[k] = argsRecord[k];
      }
      if (args.facets) vocabArgs["facets"] = args.facets;
      if (args.facetLimit != null) vocabArgs["facetLimit"] = args.facetLimit;
      // Map query → title for vocab path (query searches by title)
      if (argsRecord["query"] && !vocabArgs["title"]) {
        vocabArgs["title"] = argsRecord["query"];
      }

      // Warn on deprecated pageToken (applies to both compact and full paths)
      const pageTokenWarning = argsRecord["pageToken"]
        ? "pageToken is deprecated — use maxResults to control result count."
        : undefined;

      // Compact mode: return only IDs without enrichment
      if (args.compact) {
        const compactResult = vocabDb.searchCompact(vocabArgs as any);
        if (pageTokenWarning) {
          compactResult.warnings = [...(compactResult.warnings || []), pageTokenWarning];
        }

        const header = (compactResult.totalResults != null
          ? `${compactResult.totalResults} results`
          : `${compactResult.ids.length} results`) + " (compact)";
        const textParts: string[] = [header];
        if (compactResult.facets) {
          addPercentages(compactResult.facets);
          textParts.push(formatFacets(compactResult.facets));
        }
        if (compactResult.ids.length) textParts.push(compactResult.ids.join(", "));
        if (compactResult.warnings?.length) textParts.push(...compactResult.warnings.map(w => `⚠ ${w}`));
        const data: InferOutput<typeof SearchResultOutput> = compactResult;
        return structuredResponse(data, textParts.join("\n"));
      }

      const result = vocabDb.search(vocabArgs as any);
      if (pageTokenWarning) {
        result.warnings = [...(result.warnings || []), pageTokenWarning];
      }

      // Suggest aboutActor when depictedPerson returns 0 results
      if (result.results.length === 0 && argsRecord.depictedPerson) {
        result.warnings = [...(result.warnings || []),
          `depictedPerson:"${argsRecord.depictedPerson}" matched no results. ` +
          `Try aboutActor for broader person matching (searches both depicted persons and creators).`];
      }

      // groupBy=parent: collapse children whose parent is also in the result set.
      // Structural fix for #28; replaces the prefix-string heuristic when the user opts in.
      let groupedAway = 0;
      if (args.groupBy === "parent" && result.results.length > 0) {
        const objectNumbers = result.results.map(r => r.objectNumber);
        const childToParent = vocabDb.findParentGroupings(objectNumbers);
        if (childToParent.size > 0) {
          const childCountByParent = new Map<string, number>();
          for (const parentObj of childToParent.values()) {
            childCountByParent.set(parentObj, (childCountByParent.get(parentObj) ?? 0) + 1);
          }
          const filtered: typeof result.results = [];
          for (const r of result.results) {
            if (childToParent.has(r.objectNumber)) {
              groupedAway++;
              continue;
            }
            const absorbed = childCountByParent.get(r.objectNumber);
            filtered.push(absorbed ? { ...r, groupedChildCount: absorbed } : r);
          }
          result.results = filtered;
        }
      }

      // Detect component-record clustering (sketchbook folios, album pages, etc.)
      // Skip when groupBy=parent already handled it structurally.
      if (args.groupBy !== "parent") {
        const clusterNote = detectComponentClustering(result.results.map(r => r.objectNumber));
        if (clusterNote) result.warnings = [...(result.warnings || []), clusterNote];
      } else if (groupedAway > 0) {
        result.warnings = [...(result.warnings || []),
          `groupBy=parent collapsed ${groupedAway} child record(s) into ${result.results.filter(r => "groupedChildCount" in r).length} parent(s).`];
      }

      const header = `${result.results.length} results` +
        (result.totalResults != null ? ` of ${result.totalResults} total` : '') +
        ` (vocabulary search)`;
      const textParts: string[] = [header];
      if (result.facets) {
        addPercentages(result.facets);
        textParts.push(formatFacets(result.facets));
      }
      textParts.push(...result.results.map((r, i) => formatSearchLine(r, i)));
      if (result.warnings?.length) textParts.push(...result.warnings.map(w => `⚠ ${w}`));
      const structured: InferOutput<typeof SearchResultOutput> = result;
      return structuredResponse(structured, textParts.join("\n"));
    })
  );

  // ── search_persons ──────────────────────────────────────────────

  if (vocabAvailable) {
    const PersonSearchOutput = {
      totalResults: z.number().int().nonnegative(),
      persons: z.array(z.object({
        vocabId: z.string(),
        label: z.string(),
        labelEn: z.string().nullable(),
        labelNl: z.string().nullable(),
        birthYear: z.number().int().nullable(),
        deathYear: z.number().int().nullable(),
        gender: z.string().nullable(),
        wikidataId: z.string().nullable(),
        artworkCount: z.number().int().optional(),
      })),
      warnings: z.array(z.string()).optional(),
    };

    server.registerTool(
      "search_persons",
      {
        title: "Search Persons",
        annotations: ANN_READ_CLOSED,
        description:
          "Use when the user has a demographic or structural query about persons (artists, depicted figures, donors): " +
          "gender, birth/death year, birth/death place, profession. " +
          "Returns vocab IDs to feed into search_artwork({creator: <vocabId>}) for works by them, " +
          "or search_artwork({aboutActor: <name>}) for works depicting them. " +
          "Two-step pattern: search_persons → search_artwork. " +
          "Examples: 'female impressionist painters born after 1850' or 'Dutch painters who died in Italy'.\n\n" +
          "Not for free-text concept queries — use semantic_search. " +
          "Not for filter-based artwork search by a known creator name — use search_artwork({creator: <name>}) directly.\n\n" +
          "By default restricts to persons with ≥1 artwork in the collection (~60K of ~290K). " +
          "Coverage note (v0.27): demographic filters (gender, bornAfter, bornBefore) require person-enrichment to be present on the vocabulary DB; " +
          "on a freshly harvested DB without person enrichment they return zero rows. Name search and structural filters (birthPlace / deathPlace / profession) work on any harvest.",
        inputSchema: z.object({
          name: optMinStr().optional()
            .describe("Phrase or token match against ~700K name variants (~290K persons). Tries exact phrase first, then token AND with stop-word stripping."),
          gender: optMinStr().optional()
            .describe("Categorical: 'female', 'male', or other normalised values. Returns 0 rows if person enrichment is absent."),
          bornAfter: z.preprocess(stripNull, z.number().int().optional())
            .describe("Birth year ≥ this value. Returns 0 rows if person enrichment is absent."),
          bornBefore: z.preprocess(stripNull, z.number().int().optional())
            .describe("Birth year ≤ this value. Returns 0 rows if person enrichment is absent."),
          birthPlace: stringOrArray().optional()
            .describe("Place name (vocab + FTS match). Multi-value AND. Resolved by pivot through creator-mapped artworks."),
          deathPlace: stringOrArray().optional()
            .describe("Place name. Multi-value AND. Resolved by pivot through creator-mapped artworks."),
          profession: stringOrArray().optional()
            .describe("Profession (e.g. 'painter', 'engraver'). Multi-value AND. Resolved by pivot through creator-mapped artworks."),
          hasArtworks: z.preprocess(stripNull, z.boolean().optional().default(true))
            .describe("Restrict to persons appearing as creator on ≥1 artwork. Default true."),
          maxResults: z.number().int().min(1).max(100).default(25)
            .describe("Maximum persons to return (1-100, default 25)."),
          offset: z.preprocess(stripNull, z.number().int().min(0).default(0).optional())
            .describe("Skip this many results (for pagination)."),
        }).strict(),
        ...withOutputSchema(PersonSearchOutput),
      },
      withLogging("search_persons", async (args) => {
        if (!vocabDb) {
          return errorResponse("search_persons requires the vocabulary database.");
        }
        const a = args as Record<string, unknown>;
        const params: PersonSearchParams = {};
        if (a.name) params.name = a.name as string;
        if (a.gender) params.gender = a.gender as string;
        if (a.bornAfter != null) params.bornAfter = a.bornAfter as number;
        if (a.bornBefore != null) params.bornBefore = a.bornBefore as number;
        if (a.birthPlace) params.birthPlace = a.birthPlace as string | string[];
        if (a.deathPlace) params.deathPlace = a.deathPlace as string | string[];
        if (a.profession) params.profession = a.profession as string | string[];
        if (a.hasArtworks != null) params.hasArtworks = a.hasArtworks as boolean;
        params.maxResults = a.maxResults as number ?? 25;
        if (a.offset != null) params.offset = a.offset as number;

        const result = vocabDb.searchPersons(params);

        const lines: string[] = [];
        lines.push(`${result.totalResults} person${result.totalResults === 1 ? "" : "s"} found`);
        if (result.totalResults > result.persons.length) {
          lines.push(`Showing ${result.persons.length} (offset ${params.offset ?? 0}).`);
        }
        for (let i = 0; i < result.persons.length; i++) {
          const p = result.persons[i];
          let line = `${i + 1}. ${p.label} (${p.vocabId})`;
          const lifespan = (p.birthYear || p.deathYear) ? ` ${p.birthYear ?? "?"}–${p.deathYear ?? "?"}` : "";
          line += lifespan;
          if (p.gender) line += ` · ${p.gender}`;
          if (p.artworkCount != null) line += ` · ${p.artworkCount} works`;
          if (p.wikidataId) line += ` · Q${p.wikidataId.replace(/^Q/, "")}`;
          lines.push(line);
        }
        if (result.warnings?.length) {
          lines.push(...result.warnings.map(w => `⚠ ${w}`));
        }

        return structuredResponse(result, lines.join("\n"));
      })
    );
  }

  // ── get_artwork_details ─────────────────────────────────────────

  server.registerTool(
    "get_artwork_details",
    {
      title: "Get Artwork Details",
      annotations: ANN_READ_CLOSED,
      description:
        "Use when you need full metadata for a SINGLE artwork (e.g. after a search_artwork / semantic_search / find_similar result, or when the user names a specific objectNumber). " +
        "Provide exactly one of objectNumber (e.g. 'SK-C-5' for The Night Watch) or uri (a Linked Art URI from relatedObjects).\n\n" +
        "Returns metadata including titles (primary plus the full set of variants with language and qualifier — Dutch/English brief/full/display/former), " +
        "creator, date, dateDisplay (free-text form), description, curatorial narrative, dimensions (text + structured: height/width/depth/weight/diameter where present), " +
        "extentText, materials, object type, production details (with creator life dates, gender, and Wikidata ID where available), provenance, credit line, inscriptions, license, " +
        "related objects (each carrying objectNumber + iiifId for in-viewer navigation), themes, exhibitions, attributionEvidence, externalIds (handle + other), " +
        "location (museum room when on display, as { roomId, floor, roomName }), recordCreated/recordModified timestamps, plus collection sets and reference metadata. " +
        "The relatedObjects field carries each peer's objectNumber (canonical handle) plus a Linked Art objectUri; pass either form back here, objectNumber preferred.\n\n" +
        "Not for filter-based discovery — use search_artwork. Not for similarity discovery — use find_similar. Not for aggregate counts — use collection_stats.",
      inputSchema: z.object({
        objectNumber: optStr()
          .optional()
          .describe(
            "The object number of the artwork (e.g. 'SK-C-5', 'SK-A-3262')"
          ),
        uri: z
          .string()
          .url()
          .optional()
          .describe(
            "A Linked Art URI (e.g. 'https://id.rijksmuseum.nl/200666460')"
          ),
      }).strict(),
      ...withOutputSchema(ArtworkDetailOutput),
    },
    withLogging("get_artwork_details", async (args) => {
      if (!vocabDb?.available) {
        return errorResponse("get_artwork_details requires the vocabulary database.");
      }
      const count = (args.objectNumber ? 1 : 0) + (args.uri ? 1 : 0);
      if (count !== 1) throw new Error("Provide exactly one of objectNumber or uri.");

      let objNum: string;
      if (args.objectNumber) {
        objNum = args.objectNumber;
      } else {
        const segment = args.uri!.split("/").pop()!;
        // Two URI flavours land here. (a) URIs minted by this server in the `id`
        // field of get_artwork_details — segment = local art_id. (b) URIs harvested
        // from upstream Linked Art payloads (related_la_uri / parent_la_uri) —
        // segment = upstream entity ID, a different ID space. Try (a) first; fall
        // back to (b) by probing the harvest tables for the URI.
        if (/^\d+$/.test(segment)) {
          const resolved = vocabDb.getObjectNumberByArtId(Number(segment))
            ?? vocabDb.getObjectNumberByLinkedArtUri(args.uri!);
          if (!resolved) throw new Error(`No artwork found for URI: ${args.uri}`);
          objNum = resolved;
        } else {
          objNum = segment;
        }
      }
      const detail = vocabDb.getArtworkDetail(objNum);
      if (!detail) throw new Error(`No artwork found: ${objNum}`);

      const provenanceChain: ProvenanceChainEvent[] | null = detail.provenance
        ? parseProvenance(detail.provenance).events.map(e => ({
            sequence: e.sequence,
            gap: e.gap,
            uncertain: e.uncertain,
            transferType: e.transferType,
            party: e.party ? { name: e.party.name } : null,
            location: e.location,
            date: e.date ? { year: e.date.year, text: e.date.text } : null,
            price: e.price
              ? { currency: e.price.currency, amount: e.price.amount, text: e.price.text }
              : null,
          }))
        : null;

      const text = formatDetailSummary({ ...detail, provenanceChain });
      return structuredResponse({ ...detail, provenanceChain }, text);
    })
  );

  // ── get_artwork_image (MCP App with inline IIIF viewer) ────────

  // Single source of truth for the vocab-lookup + IIIF-resolve prelude shared by
  // get_artwork_image, remount_viewer, and inspect_artwork_image. Callers that
  // need viewer-payload shaping go through resolveArtworkImagePayload below;
  // inspect_artwork_image consumes the raw artwork + imageInfo for IIIF region
  // math.
  type ArtworkMetadata = NonNullable<ReturnType<VocabularyDb["lookupImageMetadata"]>>;
  type ImageInfo = NonNullable<Awaited<ReturnType<RijksmuseumApiClient["getImageInfoFast"]>>>;
  type ArtworkAndImage =
    | { ok: false; reason: "no_artwork" | "no_image"; error: string }
    | { ok: true; artwork: ArtworkMetadata; imageInfo: ImageInfo };

  const loadArtworkAndImageInfo = async (objectNumber: string): Promise<ArtworkAndImage> => {
    const artwork = vocabDb?.lookupImageMetadata(objectNumber);
    if (!artwork) return { ok: false, reason: "no_artwork", error: "No artwork found for this object number" };
    const imageInfo = artwork.iiifId ? await api.getImageInfoFast(artwork.iiifId) : null;
    if (!imageInfo) return { ok: false, reason: "no_image", error: "No image available for this artwork" };
    return { ok: true, artwork, imageInfo };
  };

  // Shape the ImageInfoOutput payload sans viewUUID. Callers add the UUID and
  // finalise the text-channel narration.
  type ArtworkImagePayload =
    | { ok: false; error: string }
    | {
        ok: true;
        data: Omit<InferOutput<typeof ImageInfoOutput>, "viewUUID">;
        width: number;
        height: number;
        narrationPrefix: string;
      };
  const resolveArtworkImagePayload = async (objectNumber: string): Promise<ArtworkImagePayload> => {
    const loaded = await loadArtworkAndImageInfo(objectNumber);
    if (!loaded.ok) return { ok: false, error: loaded.error };
    const { artwork, imageInfo } = loaded;

    const physicalDimensions = formatDimensions(artwork.heightCm, artwork.widthCm);
    const { thumbnailUrl, iiifId, ...imageData } = imageInfo;
    const data: Omit<InferOutput<typeof ImageInfoOutput>, "viewUUID"> = {
      ...imageData,
      objectNumber: artwork.objectNumber,
      title: artwork.title,
      creator: artwork.creator,
      date: artwork.date,
      license: artwork.license,
      physicalDimensions,
      collectionUrl: `https://www.rijksmuseum.nl/en/collection/${artwork.objectNumber}`,
    };
    const dims = data.width && data.height ? ` | ${data.width}×${data.height}px` : "";
    const licenseTag = artwork.license ? ` [${artwork.license}]` : "";
    const narrationPrefix = `${artwork.objectNumber} — "${artwork.title}" by ${artwork.creator}${dims}${licenseTag}`;
    return { ok: true, data, width: imageInfo.width, height: imageInfo.height, narrationPrefix };
  };

  registerAppTool(
    server,
    "get_artwork_image",
    {
      title: "Get Artwork Image",
      annotations: ANN_VIEWER,
      description:
        "Use ONLY when the user explicitly wants to see, show, or view an artwork — opens an interactive deep-zoom viewer (zoom, pan, rotate, flip, j/k/l navigation between related artworks). " +
        "Do NOT call for list, summary, count, or text-only requests. " +
        "Not for visual analysis by the LLM — use inspect_artwork_image to get image bytes. " +
        "Not all artworks have images available. " +
        "Returns metadata and a viewer link, not the image bytes themselves; do not construct or fetch IIIF image URLs manually (downloadable images are on rijksmuseum.nl).",
      inputSchema: z.object({
        objectNumber: z
          .string()
          .describe("The object number of the artwork (e.g. 'SK-C-5')"),
      }).strict() as z.ZodTypeAny,
      ...withOutputSchema(ImageInfoOutput),
      _meta: {
        ui: { resourceUri: ARTWORK_VIEWER_RESOURCE_URI },
      },
    },
    withLogging("get_artwork_image", async (args) => {
      const payload = await resolveArtworkImagePayload(args.objectNumber);
      if (!payload.ok) {
        const errorData: InferOutput<typeof ImageInfoOutput> = {
          objectNumber: args.objectNumber,
          error: payload.error,
        };
        // Signal failure with isError so the agent treats it as such and the
        // viewer iframe surfaces the real reason ("No artwork found" / "No image
        // available") instead of a generic fallback. Mirrors remount_viewer and
        // inspect_artwork_image's no_artwork path.
        return { ...structuredResponse(errorData, payload.error), isError: true as const };
      }

      const viewUUID = randomUUID();
      viewerQueues.set(viewUUID, {
        commands: [],
        createdAt: Date.now(),
        lastAccess: Date.now(),
        objectNumber: payload.data.objectNumber,
        imageWidth: payload.width,
        imageHeight: payload.height,
        activeOverlays: [],
      });

      const viewerData: InferOutput<typeof ImageInfoOutput> = { ...payload.data, viewUUID };
      const text = `${payload.narrationPrefix} | viewUUID: ${viewUUID}`;
      return structuredResponse(viewerData, text);
    })
  );

  // ── remount_viewer (app-only, hidden from agent tools/list) ─────
  //
  // In-viewer related-artwork navigation calls this to swap the artwork
  // *without* minting a fresh viewUUID. Preserving the UUID keeps the
  // agent's stored navigate_viewer target valid across in-viewer
  // navigation (issue #310). Spec basis: SEP-1865 § "Resource Discovery
  // → Visibility" (visibility:["app"]) + § "Standard MCP Messages →
  // Tools" (tools/call from a View to an app-only tool).

  registerAppTool(
    server,
    "remount_viewer",
    {
      title: "Remount Viewer",
      annotations: ANN_VIEWER,
      description:
        "Internal: switch the viewer to a different artwork while preserving the viewUUID. " +
        "Called by the artwork-viewer iframe during in-viewer related navigation. " +
        "Overlays are cleared on remount because their coordinates belong to the previous artwork.",
      inputSchema: z.object({
        viewUUID: z.string().describe("Existing viewer UUID returned by a prior get_artwork_image call"),
        objectNumber: z.string().describe("Object number of the artwork to remount into the viewer"),
      }).strict() as z.ZodTypeAny,
      ...withOutputSchema(ImageInfoOutput),
      // No ui.resourceUri here: this is an app-only tool (visibility:["app"]),
      // and a template binding on a tool the user never sees is contradictory.
      // The iframe consumes the result directly via app.callServerTool(); it
      // never relies on the host re-rendering a resource. ChatGPT warns when a
      // template is bound to a hidden tool ("templates tied to hidden tools
      // won't be usable") — the binding lives on get_artwork_image only.
      _meta: {
        ui: {
          visibility: ["app"],
        },
      },
    },
    withLogging("remount_viewer", async (args) => {
      const queue = viewerQueues.get(args.viewUUID);
      if (!queue) {
        const errorData: InferOutput<typeof ImageInfoOutput> = {
          objectNumber: args.objectNumber,
          error: "No active viewer for this UUID",
        };
        return {
          ...structuredResponse(errorData, "No active viewer — call get_artwork_image to start a new session"),
          isError: true as const,
        };
      }

      const payload = await resolveArtworkImagePayload(args.objectNumber);
      if (!payload.ok) {
        const errorData: InferOutput<typeof ImageInfoOutput> = {
          objectNumber: args.objectNumber,
          error: payload.error,
        };
        return {
          ...structuredResponse(errorData, payload.error),
          isError: true as const,
        };
      }

      // Atomic queue update — UUID and identity preserved, content swapped.
      // Do NOT touch lastPolledAt: the iframe is already polling this UUID
      // and will pick up the new artwork's image on its next render cycle.
      queue.objectNumber = payload.data.objectNumber;
      queue.imageWidth = payload.width;
      queue.imageHeight = payload.height;
      queue.activeOverlays = [];
      queue.lastAccess = Date.now();

      const viewerData: InferOutput<typeof ImageInfoOutput> = { ...payload.data, viewUUID: args.viewUUID };
      const text = `Remounted viewer ${args.viewUUID.slice(0, 8)} → ${payload.data.objectNumber}`;
      return structuredResponse(viewerData, text);
    })
  );

  // ── inspect_artwork_image ──────────────────────────────────────────

  server.registerTool(
    "inspect_artwork_image",
    {
      title: "Inspect Artwork Image",
      annotations: ANN_READ_CLOSED,
      description:
        "Use when YOU (the LLM) need to look at an artwork image or region for visual analysis — identifying details, reading inscriptions, comparing compositions, planning overlays. " +
        "Returns image bytes (base64) in the tool response — the LLM can see and reason about the image immediately. " +
        "Not for the user to view — use get_artwork_image for the interactive viewer. " +
        "Not for listing or summarising artworks — use search_artwork.\n\n" +
        "Use with region 'full' (default) to inspect the complete artwork, or specify a " +
        "region to zoom into details, read inscriptions, or examine specific areas. " +
        "The response includes cropPixelWidth/cropPixelHeight: the actual pixel dimensions " +
        "of the returned image. Use those with navigate_viewer's relativeToSize when placing " +
        "crop-local crop_pixels overlays.\n\n" +
        "Region coordinates: 'pct:x,y,w,h' (percentage of full image, recommended), " +
        "'crop_pixels:x,y,w,h' (pixel coordinates of the full image — use with " +
        "nativeWidth/nativeHeight from a prior response), or 'x,y,w,h' (legacy IIIF " +
        "pixels, equivalent to crop_pixels). Quick reference:\n" +
        "- Top-left quarter: pct:0,0,50,50\n" +
        "- Bottom-right quarter: pct:50,50,50,50\n" +
        "- Center strip: pct:25,25,50,50\n" +
        "- Full image: full (default)\n" +
        "- For multi-panel works: use physical dimensions from get_artwork_details to estimate panel percentages, then inspect individual panels with close-up crops.\n\n" +
        "Best practice for overlay placement: ALWAYS inspect before overlaying. " +
        "Start with region 'full' to understand the layout, then use close-up crops (600–800px) " +
        "to pinpoint specific features before calling navigate_viewer with add_overlay. " +
        "Use navigate_viewer's 'relativeTo' parameter to place overlays using crop-local coordinates — " +
        "the server handles the projection to full-image space, avoiding manual coordinate math.\n\n" +
        "Auto-navigation: when a viewer is open for this artwork, the viewer automatically zooms " +
        "to the inspected region (navigateViewer defaults to true, no effect when region is 'full'). " +
        "This keeps the viewer in sync with your analysis — no separate navigate_viewer call needed for basic zoom. " +
        "Use navigate_viewer separately only when you need overlays, labels, or clear_overlays.\n\n" +
        "The response includes the active viewUUID (if any) for follow-up navigate_viewer calls.",
      inputSchema: z.object({
        objectNumber: z
          .string()
          .describe("The object number of the artwork (e.g. 'SK-C-5')"),
        region: z
          .string()
          .default("full")
          .refine(
            (v) => IIIF_REGION_RE.test(v),
            { message: "Invalid IIIF region. Use 'full', 'square', 'x,y,w,h' (pixels), 'pct:x,y,w,h' (percentages), or 'crop_pixels:x,y,w,h' (explicit full-image pixels)." }
          )
          .describe("IIIF region: 'full', 'square', 'pct:x,y,w,h' (percentage), 'crop_pixels:x,y,w,h' (pixels of the full image — use with nativeWidth/nativeHeight from a prior response), or 'x,y,w,h' (legacy IIIF pixels, equivalent to crop_pixels). E.g. 'pct:0,60,40,40' for bottom-left 40%."),
        size: z
          .number()
          .int()
          .min(200)
          .max(2016)
          .default(1568)
          .describe("Width of returned image in pixels (200–2016, default 1568). Defaults align to multiples of 28 for clean LLM coordinate handling: 1568 is Sonnet 4.6's native resolution cap, 2016 is the highest ×28 multiple that stays within Opus 4.7's per-image token budget across common aspect ratios."),
        rotation: z
          .union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)])
          .default(0)
          .describe("Clockwise rotation in degrees"),
        quality: z
          .enum(["default", "gray"])
          .default("default")
          .describe("Image quality — 'gray' can help read inscriptions or signatures"),
        navigateViewer: z
          .boolean()
          .default(true)
          .describe("Auto-navigate the open viewer to the inspected region (default: true). Only effective when a viewer is open for this artwork."),
        show_overlays: z
          .boolean()
          .default(false)
          .describe("Composite active-viewer overlays onto the returned crop (opt-in). Response size is clamped to 448 px when enabled."),
        viewUUID: optStr()
          .optional()
          .describe("Target a specific viewer session (from get_artwork_image). When omitted, auto-discovers a viewer for this artwork."),
      }).strict(),
      ...withOutputSchema(InspectImageOutput),
    },
    withLogging("inspect_artwork_image", async (args) => {
      const cropError = (error: string, text?: string) => {
        const data: InferOutput<typeof InspectImageOutput> = {
          objectNumber: args.objectNumber,
          region: args.region,
          requestedSize: args.size,
          rotation: args.rotation,
          quality: args.quality,
          error,
        };
        return {
          ...structuredResponse(data, text ?? error),
          isError: true as const,
        };
      };

      try {
        const loaded = await loadArtworkAndImageInfo(args.objectNumber);
        if (!loaded.ok && loaded.reason === "no_artwork") {
          return cropError(loaded.error);
        }

        // Find active viewer — prefer explicit viewUUID, else pick the most
        // recently accessed queue for this artwork. Recency tie-break is safe
        // for reads (inspect) even though it would be risky for writes; if the
        // caller just placed overlays via navigate_viewer, that queue will be
        // the most recent by construction.
        let activeViewUUID: string | undefined;
        if (args.viewUUID) {
          const q = viewerQueues.get(args.viewUUID);
          if (q && q.objectNumber === args.objectNumber) {
            activeViewUUID = args.viewUUID;
            q.lastAccess = Date.now();
          }
          // don't navigate wrong viewer
        } else {
          // Tie-break on lastAccess using `>=` so the later-inserted viewer wins
          // when two calls landed in the same millisecond (Map iterates in
          // insertion order — later insertions appear later in the loop).
          let bestLastAccess = -Infinity;
          for (const [uuid, q] of viewerQueues) {
            if (q.objectNumber === args.objectNumber && q.lastAccess >= bestLastAccess) {
              activeViewUUID = uuid;
              bestLastAccess = q.lastAccess;
            }
          }
          if (activeViewUUID) {
            viewerQueues.get(activeViewUUID)!.lastAccess = Date.now();
          }
        }

        if (!loaded.ok) {
          return cropError(loaded.error);
        }
        const { artwork, imageInfo } = loaded;

        // show_overlays on region="full" hits a degenerate case: at the 448 px
        // clamp, a feature-scale overlay shrinks to a few pixels and reveals
        // nothing. Nudge the caller to inspect a feature-scale region instead.
        if (args.show_overlays && args.region === "full") {
          return cropError(
            "show_overlays_on_full_not_supported",
            "show_overlays_on_full_not_supported: show_overlays is a feature-scale verification aid — at the 448 px clamp, small overlays on a full-image view shrink below visual threshold. Inspect a region that encloses the overlay(s) you want to check (e.g. 'pct:' around the target area).",
          );
        }

        // Checked before prefix stripping so `requested` in the warning echoes
        // the user's exact input, not the normalized form.
        {
          const oob = checkRegionBounds(args.region, imageInfo.width, imageInfo.height);
          if (oob) {
            return oobError(oob, "Your coordinates fall outside valid bounds — please re-examine the region and retry with a corrected bounding box.", cropError);
          }
        }

        const iiifRegion = args.region.startsWith("crop_pixels:")
          ? (cropPixelsToIiifPixels(args.region) ?? args.region)
          : args.region;

        // iiif.micr.io rejects upscaling; pct regions suffer from implementation-
        // specific rounding that can yield up to 3px less than the ideal pixel
        // width, so we subtract 3 to stay inside the boundary. The 448 clamp
        // when show_overlays is on is an LLM-only context-cost guard.
        let effectiveSize = args.show_overlays ? Math.min(args.size, 448) : args.size;
        if (imageInfo.width) {
          let regionWidth = imageInfo.width;
          const pctMatch = iiifRegion.match(/^pct:([0-9.]+),([0-9.]+),([0-9.]+),([0-9.]+)$/);
          const pxMatch = iiifRegion.match(/^(\d+),(\d+),(\d+),(\d+)$/);
          if (pctMatch) {
            regionWidth = Math.max(1, Math.floor(imageInfo.width * parseFloat(pctMatch[3]) / 100) - 3);
          } else if (pxMatch) {
            regionWidth = parseInt(pxMatch[3]);
          } else if (iiifRegion === "square") {
            regionWidth = Math.min(imageInfo.width, imageInfo.height ?? imageInfo.width);
          }
          // region === "full" keeps regionWidth = imageInfo.width
          if (effectiveSize > regionWidth) effectiveSize = regionWidth;
        }

        let base64: string;
        let mimeType: string;
        const fetchStart = performance.now();
        try {
          ({ data: base64, mimeType } = await api.fetchRegionBase64(
            imageInfo.iiifId,
            iiifRegion,
            effectiveSize,
            args.rotation,
            args.quality,
          ));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return cropError(`Failed to fetch image: ${message}`);
        }
        const fetchTimeMs = Math.round(performance.now() - fetchStart);
        let imageBuffer: Buffer<ArrayBufferLike> = Buffer.from(base64, "base64");
        let cropPixelWidth: number | undefined;
        let cropPixelHeight: number | undefined;

        let overlaysRendered: number | undefined;
        let overlaysSkipped: number | undefined;
        let overlaysError: string | undefined;
        if (args.show_overlays && imageInfo.width && imageInfo.height) {
          const queueForOverlays = activeViewUUID ? viewerQueues.get(activeViewUUID) : undefined;
          if (!queueForOverlays) {
            overlaysError = "no_active_viewer";
            overlaysRendered = 0;
            overlaysSkipped = 0;
          } else {
            const overlays = queueForOverlays.activeOverlays;
            const cropRect = computeCropRect(iiifRegion, imageInfo.width, imageInfo.height);
            if (overlays.length > 0 && cropRect) {
              const frame = { rect: cropRect, imageWidth: imageInfo.width, imageHeight: imageInfo.height };
              try {
                const composite = await compositeOverlays(imageBuffer, overlays, frame);
                imageBuffer = composite.buffer;
                base64 = imageBuffer.toString("base64");
                mimeType = composite.mimeType;
                overlaysRendered = composite.rendered;
                overlaysSkipped = composite.skipped;
                cropPixelWidth = composite.width;
                cropPixelHeight = composite.height;
              } catch (err) {
                // Non-fatal: return the plain crop and flag so the failure
                // isn't indistinguishable from "all overlays fell outside".
                const message = err instanceof Error ? err.message : String(err);
                console.warn(`[inspect_artwork_image] overlay composite failed: ${message}`);
                overlaysError = "compositor_failed";
                overlaysRendered = 0;
                overlaysSkipped = overlays.length;
              }
            } else {
              overlaysRendered = 0;
              overlaysSkipped = 0;
            }
          }
        }

        // Fallback when the composite path didn't run or didn't expose dims.
        // Non-fatal on error: image bytes remain valid for the content response.
        if (cropPixelWidth == null || cropPixelHeight == null) {
          try {
            ({ width: cropPixelWidth, height: cropPixelHeight } = await readImageDimensions(imageBuffer));
          } catch { /* keep dims undefined */ }
        }

        const regionLabel = args.region === "full" ? "full image" : `region ${args.region}`;
        const sizeNote = effectiveSize < args.size ? ` (clamped from ${args.size}px — upscaling not supported)` : "";

        // Auto-navigate viewer to inspected region (non-full only)
        let viewerNavigated = false;
        if (args.navigateViewer && activeViewUUID && iiifRegion !== "full") {
          const queue = viewerQueues.get(activeViewUUID);
          if (queue) {
            queue.commands.push({ action: "navigate", region: iiifRegion });
            queue.lastAccess = Date.now();
            viewerNavigated = true;
          }
        }

        const captionParts = [
          `"${artwork.title}" by ${artwork.creator} — ${args.objectNumber}`,
          `(${regionLabel}, ${effectiveSize}px${sizeNote}, ${fetchTimeMs}ms)`,
        ];
        if (imageInfo.width && imageInfo.height) {
          captionParts.push(`| native ${imageInfo.width}×${imageInfo.height}px`);
        }
        if (cropPixelWidth && cropPixelHeight) {
          captionParts.push(`| crop ${cropPixelWidth}×${cropPixelHeight}px`);
        }
        if (viewerNavigated) captionParts.push("| viewer navigated");
        else if (activeViewUUID) captionParts.push(`| viewer open (${activeViewUUID.slice(0, 8)})`);
        if (overlaysRendered != null) {
          const errNote = overlaysError ? ` (${overlaysError})` : "";
          captionParts.push(`| overlays: ${overlaysRendered} rendered, ${overlaysSkipped} skipped${errNote}`);
        }
        const caption = captionParts.join(" ");

        const content = [
          { type: "image" as const, data: base64, mimeType },
          { type: "text" as const, text: caption },
        ];

        if (!EMIT_STRUCTURED) return { content };
        const inspectData: InferOutput<typeof InspectImageOutput> = {
          objectNumber: args.objectNumber,
          region: args.region,
          requestedSize: effectiveSize,
          nativeWidth: imageInfo.width,
          nativeHeight: imageInfo.height,
          cropPixelWidth,
          cropPixelHeight,
          cropRegion: iiifRegion,
          rotation: args.rotation,
          quality: args.quality,
          fetchTimeMs,
          viewUUID: activeViewUUID,
          viewerNavigated: viewerNavigated || undefined,
          overlaysRendered,
          overlaysSkipped,
          overlaysError,
        };
        return {
          content,
          structuredContent: inspectData as Record<string, unknown>,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return cropError(`Failed to process artwork: ${message}`);
      }
    })
  );

  // ── navigate_viewer ────────────────────────────────────────────

  const NavigateViewerOutput = {
    viewUUID: z.string(),
    queued: z.number().int(),
    imageWidth: z.number().int().optional(),
    imageHeight: z.number().int().optional(),
    overlays: z.array(z.object({
      label: z.string().optional(),
      region: z.string(),
      pixelRect: z.string().optional(),
    })).optional(),
    currentOverlays: z.array(z.object({
      label: z.string().optional(),
      region: z.string(),
      color: z.string().optional(),
    })).optional(),
    pendingCommandCount: z.number().int().optional()
      .describe("Commands sitting in the queue that the iframe has not yet drained."),
    lastPolledAt: z.string().optional()
      .describe("ISO timestamp of the iframe's last poll. Absent if the iframe has never polled this session."),
    recentlyPolledByViewer: z.boolean().optional()
      .describe("True if the iframe polled within the last 5s."),
    deliveryState: z.enum(["delivered_recently", "queued_waiting_for_viewer", "no_live_viewer_seen"]).optional()
      .describe("Server's view of command delivery: delivered, queued for an existing-but-offscreen viewer, or no viewer ever connected."),
    error: z.string().optional(),
  };

  server.registerTool(
    "navigate_viewer",
    {
      title: "Navigate Viewer",
      annotations: ANN_VIEWER,
      description:
        "Use after inspect_artwork_image when you want to draw the user's attention to a specific region of the open viewer (zoom there, add a labelled overlay, or clear overlays). " +
        "Requires a viewUUID from a prior get_artwork_image call (the viewer must be open). " +
        "Not for opening the viewer — use get_artwork_image. Not for visual analysis — use inspect_artwork_image. " +
        "Commands execute in order: typically clear_overlays → navigate → add_overlay.\n\n" +
        "By default, region coordinates are in full-image space (percentages or pixels of the original image), " +
        "not relative to the current viewport. The same pct:x,y,w,h used in inspect_artwork_image " +
        "will target the identical area in the viewer. Exception: when a command includes relativeTo, " +
        "region is interpreted in that inspected crop's local coordinate space.\n\n" +
        "For accurate overlay placement: inspect the target area with inspect_artwork_image first, " +
        "verify the region contains what you expect, then use the same or refined coordinates here. " +
        "Do not estimate overlay positions from memory — always inspect first.\n\n" +
        "Region formats:\n" +
        "- 'pct:x,y,w,h' — percentage of full image.\n" +
        "- 'crop_pixels:x,y,w,h' — pixel coordinates of the full image. Use nativeWidth/nativeHeight " +
        "returned by inspect_artwork_image to bound values. When used with relativeTo + relativeToSize, " +
        "crop_pixels is instead interpreted as pixels within that inspected crop.\n" +
        "- 'x,y,w,h' — equivalent to crop_pixels: (legacy IIIF form, kept for compatibility).\n" +
        "- 'full' | 'square' — whole image shortcuts.\n\n" +
        "Out-of-bounds regions are rejected with an `overlay_region_out_of_bounds` warning — " +
        "correct the coordinates and retry.\n\n" +
        "Overlays persist in the viewer until clear_overlays is issued — each call appends to the existing set. " +
        "Keep batches under 10 commands per call. The viewer session (viewUUID) remains active for " +
        "30 minutes of idle inactivity — any polling or navigation resets the clock.\n\n" +
        "Coordinate shortcut: when placing overlays based on a prior inspect_artwork_image crop, " +
        "use 'relativeTo' with the crop's region string. Specify 'region' as coordinates within " +
        "the crop's local space and the server projects to full-image space deterministically. " +
        "Use pct:x,y,w,h for crop-local percentages, or crop_pixels:x,y,w,h plus " +
        "relativeToSize:{width: cropPixelWidth, height: cropPixelHeight} from inspect_artwork_image " +
        "for crop-local rendered pixels. Crop-local pixels are preferred for tight detail boxes.\n\n" +
        "Response field deliveryState reports whether the iframe drained the commands immediately " +
        "(`delivered_recently`), the iframe exists but hasn't polled recently and the commands are " +
        "queued (`queued_waiting_for_viewer` — typical when scrolled out of view), or no iframe has " +
        "connected yet (`no_live_viewer_seen`). In the queued case, overlay state is preserved " +
        "server-side and will apply automatically when the viewer resumes polling — do not narrate " +
        "this as a delivery failure to the user.",
      inputSchema: z.object({
        viewUUID: z.string().describe("Viewer UUID from a prior get_artwork_image call"),
        commands: z.array(z.object({
          action: z.enum(["navigate", "add_overlay", "clear_overlays"]),
          region: optStr().optional().describe("IIIF region (required for navigate/add_overlay): 'full', 'square', 'pct:x,y,w,h', 'crop_pixels:x,y,w,h', or 'x,y,w,h'"),
          relativeTo: optStr().optional().describe(
            "Crop region from a prior inspect_artwork_image call. When provided, " +
            "'region' is interpreted as coordinates within that crop's local space " +
            "and projected to full-image space by the server. Use pct: region values directly, " +
            "or crop_pixels: values with relativeToSize from inspect_artwork_image."
          ),
          relativeToSize: z.object({
            width: z.number().int().positive(),
            height: z.number().int().positive(),
          }).strict().optional().describe(
            "Actual pixel dimensions of the inspected crop, copied from inspect_artwork_image " +
            "cropPixelWidth/cropPixelHeight. Required when relativeTo is set and region uses crop_pixels:."
          ),
          label: optStr().optional().describe("Label text for add_overlay"),
          color: optStr().optional().describe("CSS color for add_overlay border (default: orange)"),
        })).min(1).describe("Commands to execute in the viewer, in order"),
      }).strict(),
      ...withOutputSchema(NavigateViewerOutput),
    },
    withLogging("navigate_viewer", async (args) => {
      const navError = (error: string, text?: string) => {
        const data: InferOutput<typeof NavigateViewerOutput> = {
          viewUUID: args.viewUUID, queued: 0, error,
        };
        return { ...structuredResponse(data, text ?? error), isError: true as const };
      };

      // Retry briefly — claude.ai sends get_artwork_image and navigate_viewer
      // as concurrent HTTP POSTs. The Map lookup (0ms) can race ahead of the
      // artwork resolution (~25-30ms) that sets the UUID. Three retries at
      // 100ms intervals cover this with generous margin.
      let queue = viewerQueues.get(args.viewUUID);
      if (!queue) {
        for (let i = 0; i < 3; i++) {
          await new Promise((r) => setTimeout(r, 100));
          queue = viewerQueues.get(args.viewUUID);
          if (queue) break;
        }
      }
      if (!queue) {
        return navError(
          "No active viewer for this UUID",
          "No active viewer for this UUID — open an artwork with get_artwork_image first",
        );
      }

      // Validate region on commands that require it
      for (const cmd of args.commands) {
        if (cmd.action === "navigate" || cmd.action === "add_overlay") {
          if (!cmd.region) {
            return navError(`'${cmd.action}' requires a region. Use 'full', 'square', 'x,y,w,h', 'pct:x,y,w,h', or 'crop_pixels:x,y,w,h'.`);
          }
          if (!IIIF_REGION_RE.test(cmd.region)) {
            return navError(`Invalid region '${cmd.region}'. Use 'full', 'square', 'x,y,w,h', 'pct:x,y,w,h', or 'crop_pixels:x,y,w,h'.`);
          }
        }
        if (cmd.relativeTo && !parsePctRegion(cmd.relativeTo)) {
          return navError(`Invalid relativeTo '${cmd.relativeTo}'. Must be in pct:x,y,w,h format.`);
        }
        if (cmd.relativeToSize && !cmd.relativeTo) {
          return navError("relativeToSize requires relativeTo. Use it with a crop region from inspect_artwork_image.");
        }
        if (cmd.relativeTo && cmd.region?.startsWith("crop_pixels:") && !cmd.relativeToSize) {
          return navError("relativeTo + crop_pixels requires relativeToSize. Copy { width: cropPixelWidth, height: cropPixelHeight } from the inspect_artwork_image response.");
        }
        if (cmd.relativeTo && cmd.relativeToSize && !cmd.region?.startsWith("crop_pixels:")) {
          return navError("relativeToSize is only valid when region uses crop_pixels:. Omit relativeToSize for pct: crop-local coordinates.");
        }
      }

      // OOB check — reject rather than silent-clamp (P7, #247).
      // Skip when relativeTo is used: the projected coordinates are validated
      // post-projection (see below).
      for (const cmd of args.commands) {
        if (cmd.action !== "navigate" && cmd.action !== "add_overlay") continue;
        if (!cmd.region) continue;
        if (cmd.relativeTo) continue;
        const oob = checkRegionBounds(cmd.region, queue.imageWidth, queue.imageHeight);
        if (oob) {
          return oobError(oob, "Your coordinates fall outside valid bounds — please re-examine the image and return a corrected bounding box.", navError);
        }
      }

      // Project relativeTo coordinates to full-image space
      for (const cmd of args.commands) {
        if (cmd.relativeTo && cmd.region) {
          if (cmd.region.startsWith("crop_pixels:") && cmd.relativeToSize) {
            const localOob = checkRegionBounds(cmd.region, cmd.relativeToSize.width, cmd.relativeToSize.height);
            if (localOob) {
              return oobError(localOob, "Your crop-local pixel coordinates fall outside the inspected crop dimensions — please re-examine the crop and return a corrected bounding box.", navError);
            }
          }
          const projected = projectToFullImage(cmd.region, cmd.relativeTo, cmd.relativeToSize);
          if (!projected) {
            return navError(`relativeTo requires 'relativeTo' in pct: format and 'region' in pct: format, or crop_pixels: format with relativeToSize. Got region='${cmd.region}', relativeTo='${cmd.relativeTo}'.`);
          }
          cmd.region = projected;
          const oobPost = checkRegionBounds(cmd.region);
          if (oobPost) {
            return oobError(oobPost, "Projected coordinates fall outside 0-100 — the source region or relativeTo box extends outside the image.", navError);
          }
        }
        delete cmd.relativeTo; // Never forward to viewer
        delete cmd.relativeToSize; // Never forward to viewer
      }

      // Strip crop_pixels: prefix before forwarding — viewer understands plain IIIF pixels (P2, #247)
      for (const cmd of args.commands) {
        if (cmd.region?.startsWith("crop_pixels:")) {
          const plain = cropPixelsToIiifPixels(cmd.region);
          if (plain) cmd.region = plain;
        }
      }

      queue.commands.push(...args.commands);
      queue.lastAccess = Date.now();

      // Maintain server-side shadow overlay list. Capped at 64 so a long
      // session can't grow the array unboundedly — the compositor iterates
      // all entries on every show_overlays call.
      for (const cmd of args.commands) {
        if (cmd.action === "clear_overlays") queue.activeOverlays = [];
        else if (cmd.action === "add_overlay") {
          queue.activeOverlays.push({ label: cmd.label, region: cmd.region!, color: cmd.color });
          if (queue.activeOverlays.length > ACTIVE_OVERLAYS_CAP) {
            queue.activeOverlays = queue.activeOverlays.slice(-ACTIVE_OVERLAYS_CAP);
          }
        }
      }

      const overlayDetails = (queue.imageWidth && queue.imageHeight)
        ? args.commands
            .filter((c) => c.action === "add_overlay")
            .map((c) => ({
              label: c.label,
              region: c.region!,
              pixelRect: regionToPixels(c.region!, queue.imageWidth!, queue.imageHeight!),
            }))
        : undefined;

      const now = Date.now();
      const deliveryState = computeDeliveryState(queue.lastPolledAt, now);
      const recentlyPolledByViewer = deliveryState === "delivered_recently";

      const navData: InferOutput<typeof NavigateViewerOutput> = {
        viewUUID: args.viewUUID,
        queued: args.commands.length,
        imageWidth: queue.imageWidth,
        imageHeight: queue.imageHeight,
        overlays: overlayDetails?.length ? overlayDetails : undefined,
        currentOverlays: queue.activeOverlays.length ? queue.activeOverlays : undefined,
        pendingCommandCount: queue.commands.length,
        lastPolledAt: queue.lastPolledAt != null ? new Date(queue.lastPolledAt).toISOString() : undefined,
        recentlyPolledByViewer,
        deliveryState,
      };

      const overlayCount = queue.activeOverlays.length;
      const overlayClause = overlayCount ? ` | ${overlayCount} active overlays` : "";
      const shortUuid = args.viewUUID.slice(0, 8);
      const text = (() => {
        switch (deliveryState) {
          case "delivered_recently":
            return `Delivered ${args.commands.length} commands to active viewer ${shortUuid}${overlayClause}`;
          case "queued_waiting_for_viewer":
            return `Queued ${args.commands.length} commands for viewer ${shortUuid} (offscreen or paused — overlay state preserved, will apply when viewer resumes polling)${overlayClause}`;
          case "no_live_viewer_seen":
            return `Queued ${args.commands.length} commands for viewer ${shortUuid} (no viewer has connected yet)${overlayClause}`;
        }
      })();
      return structuredResponse(navData, text);
    })
  );

  // ── poll_viewer_commands (app-only) ───────────────────────────

  // Mirrors the ViewerCommand interface — the queue holds navigate_viewer's
  // input commands plus inspect_artwork_image's internal auto-zoom push.
  const PollViewerCommandsOutput = {
    commands: z.array(z.object({
      action: z.enum(["navigate", "add_overlay", "clear_overlays"]),
      region: z.string().optional(),
      relativeTo: z.string().optional(),
      label: z.string().optional(),
      color: z.string().optional(),
    })).describe("Pending viewer commands drained from the queue, in order. Empty when nothing is queued."),
  };

  registerAppTool(
    server,
    "poll_viewer_commands",
    {
      title: "Poll Viewer Commands",
      annotations: ANN_VIEWER,
      description: "Internal: poll for pending viewer navigation commands",
      inputSchema: z.object({
        viewUUID: z.string(),
      }).strict() as z.ZodTypeAny,
      ...withOutputSchema(PollViewerCommandsOutput),
      // App-only tool (visibility:["app"]) — no ui.resourceUri. The iframe polls
      // this via app.callServerTool() and reads the result directly; it never
      // needs the host to render a template for it. Avoids ChatGPT's
      // "templates tied to hidden tools won't be usable" warning.
      _meta: {
        ui: {
          visibility: ["app"],
        },
      },
    },
    async (args) => {
      const queue = viewerQueues.get(args.viewUUID);
      if (!queue) return structuredResponse({ commands: [] }, "No pending commands");
      queue.lastAccess = Date.now();
      queue.lastPolledAt = Date.now();
      const commands = queue.commands.splice(0);  // drain
      const text = commands.length ? `${commands.length} commands polled` : "No pending commands";
      return structuredResponse({ commands }, text);
    }
  );

  // ── list_curated_sets ───────────────────────────────────────────

  server.registerTool(
    "list_curated_sets",
    {
      title: "List Curated Sets",
      annotations: ANN_READ_CLOSED,
      description:
        "Use when you want to discover curated collection sets (193 total) ranging from substantive sub-collections " +
        "(drawings, paintings, photographs) through iconographic groupings to umbrella sets (Alle gepubliceerde objecten = 834K members). " +
        "Each result carries memberCount, top dominantTypes, top dominantCenturies by membership, and a category heuristic " +
        "(object_type / iconographic / album / sub_collection / umbrella) so you can pick the right scope. " +
        "Use minMembers: 100, maxMembers: 200000 to avoid umbrella sets when the user wants a substantive subset. " +
        "Pair with browse_set(setSpec) to enumerate members. " +
        "Not for keyword search across artworks — use search_artwork. Not for aggregate counts — use collection_stats.",
      inputSchema: z.object({
        query: optStr()
          .optional()
          .describe(
            "Filter sets by name (case-insensitive substring match). E.g. 'painting', 'Rembrandt', 'Japanese'"
          ),
        sortBy: z.preprocess(stripNull, z.enum(["name", "size", "size_desc"]).optional())
          .describe("Sort order: 'name' (alphabetical, default), 'size' (smallest first), 'size_desc' (largest first)."),
        minMembers: z.preprocess(stripNull, z.number().int().min(0).optional())
          .describe("Filter to sets with at least this many members."),
        maxMembers: z.preprocess(stripNull, z.number().int().min(0).optional())
          .describe("Filter to sets with at most this many members. Use ~100,000 to exclude umbrella sets like 'Alle gepubliceerde objecten' (834K) and 'Entire Public Domain Set' (732K)."),
        includeStats: z.preprocess(stripNull, z.boolean().optional())
          .describe("Include memberCount, dominantTypes, dominantCenturies, category. Default true. Set false for the lightweight legacy shape."),
      }).strict(),
      ...withOutputSchema(CuratedSetsOutput),
    },
    withLogging("list_curated_sets", async (args) => {
      const result = vocabDb!.listCuratedSets({
        query: args.query,
        sortBy: args.sortBy,
        minMembers: args.minMembers,
        maxMembers: args.maxMembers,
        includeStats: args.includeStats,
      });

      const data: InferOutput<typeof CuratedSetsOutput> = result;
      const headerParts: string[] = [`${result.totalSets} sets`];
      if (result.filteredFrom != null) {
        const filters: string[] = [];
        if (args.query) filters.push(`query: "${args.query}"`);
        if (args.minMembers != null) filters.push(`minMembers=${args.minMembers}`);
        if (args.maxMembers != null) filters.push(`maxMembers=${args.maxMembers}`);
        headerParts.push(`filtered from ${result.filteredFrom}` + (filters.length > 0 ? `, ${filters.join(", ")}` : ""));
      }
      const header = headerParts.length > 1
        ? `${headerParts[0]} (${headerParts.slice(1).join("; ")})`
        : headerParts[0];
      const lines = result.sets.map((s, i) => formatSetLine(s, i));
      return structuredResponse(data, [header, ...lines].join("\n"));
    })
  );

  // ── browse_set ──────────────────────────────────────────────────

  server.registerTool(
    "browse_set",
    {
      title: "Browse Set",
      annotations: ANN_READ_CLOSED,
      description:
        "Use when you have a setSpec (from list_curated_sets) and want to enumerate its member artworks. " +
        "DB-backed since v0.27 (~600× faster than the prior OAI-PMH path; warm calls in tens of ms). " +
        "Returns DB-direct records with objectNumber, title, creator, date (display + earliest/latest), description, dimensions, datestamp, image/IIIF URLs, and a stable lodUri. " +
        "For multi-row vocab (subjects, materials, type taxonomy, full set memberships), follow up with get_artwork_details on the returned objectNumber. " +
        "Supports pagination via resumptionToken (stateless base64; not portable across pre-v0.27 deploys). " +
        "Not for set discovery — use list_curated_sets first.",
      inputSchema: z.object({
        setSpec: optStr()
          .optional()
          .describe(
            "Set identifier from list_curated_sets (e.g. '26121'). Required for initial request, ignored when resumptionToken is provided."
          ),
        maxResults: z
          .number()
          .int()
          .min(1)
          .max(TOOL_LIMITS.browse_set.max)
          .default(TOOL_LIMITS.browse_set.default)
          .describe(`Maximum records to return (1-${TOOL_LIMITS.browse_set.max}, default ${TOOL_LIMITS.browse_set.default})`),
        resumptionToken: optStr()
          .optional()
          .describe(
            "Pagination token from a previous browse_set result. When provided, setSpec is ignored."
          ),
      }).strict(),
      ...withOutputSchema(BrowseSetOutput),
    },
    withLogging("browse_set", async (args) => {
      if (!args.resumptionToken && !args.setSpec) {
        return errorResponse("Either setSpec or resumptionToken is required.");
      }

      let setSpec: string;
      let offset: number;
      if (args.resumptionToken) {
        const decoded = decodeBrowseSetToken(args.resumptionToken);
        if (!decoded) {
          return errorResponse(
            "Invalid resumptionToken. Tokens are not portable across server restarts or pre-v0.27 → v0.27 upgrades. " +
            "Re-issue the original setSpec call to get a fresh token.",
          );
        }
        setSpec = decoded.setSpec;
        offset = decoded.offset;
      } else {
        setSpec = args.setSpec!;
        offset = 0;
      }

      const result = vocabDb!.browseSet(setSpec, args.maxResults, offset);
      const nextOffset = offset + result.records.length;
      const hasMore = nextOffset < result.totalInSet;
      const resumptionToken = hasMore ? encodeBrowseSetToken(setSpec, nextOffset) : undefined;

      const data = {
        records: result.records,
        totalInSet: result.totalInSet,
        ...(resumptionToken && { resumptionToken }),
      };
      const headerBits = [`${result.records.length} records`];
      if (result.totalInSet > 0) headerBits.push(`offset ${offset}–${nextOffset - 1} of ${result.totalInSet}`);
      const header = headerBits.join(" — ");
      const lines = result.records.map((r, i) => formatBrowseSetRecord(r, offset + i));
      return structuredResponse(data, [header, ...lines].join("\n"));
    })
  );

  // ── get_recent_changes ──────────────────────────────────────────

  server.registerTool(
    "get_recent_changes",
    {
      title: "Get Recent Changes",
      annotations: ANN_READ_CLOSED,
      description:
        "Use when you need OAI-PMH delta semantics specifically — tracking what changed since a known harvest checkpoint, with resumption-token pagination. " +
        "Returns records changed within a date range. Use identifiersOnly=true for a lightweight listing (headers only, no full metadata). " +
        "Each record includes an objectNumber for follow-up calls to get_artwork_details or get_artwork_image. " +
        "For static date-modified filtering across the collection, prefer search_artwork({modifiedAfter: <ISO date>}) — same data, no resumption tokens, combinable with other filters.",
      inputSchema: z.object({
        from: optStr()
          .optional()
          .describe(
            "Start date in ISO 8601 format (e.g. '2026-02-01T00:00:00Z' or '2026-02-01'). Required for initial request, ignored when resumptionToken is provided."
          ),
        until: optStr()
          .optional()
          .describe(
            "End date in ISO 8601 format (defaults to now)"
          ),
        setSpec: optStr()
          .optional()
          .describe("Restrict to changes within a specific set"),
        identifiersOnly: z
          .boolean()
          .default(false)
          .describe(
            "If true, returns only record headers (identifier, datestamp, set memberships) — much faster. Preserved automatically across continuation pages."
          ),
        maxResults: z
          .number()
          .int()
          .min(1)
          .max(TOOL_LIMITS.list_changes.max)
          .default(TOOL_LIMITS.list_changes.default)
          .describe(`Maximum records to return (1-${TOOL_LIMITS.list_changes.max}, default ${TOOL_LIMITS.list_changes.default})`),
        resumptionToken: optStr()
          .optional()
          .describe(
            "Pagination token from a previous get_recent_changes result. When provided, all other filters are ignored."
          ),
      }).strict(),
      ...withOutputSchema(RecentChangesOutput),
    },
    withLogging("get_recent_changes", async (args) => {
      if (!args.resumptionToken && !args.from) {
        return errorResponse("Either from or resumptionToken is required.");
      }

      const fetchByMode = (token: string, identifiers?: boolean) =>
        identifiers
          ? oai.listIdentifiers({ resumptionToken: token })
          : oai.listRecords({ resumptionToken: token });

      const resolved = resolveOaiBuffer(args.resumptionToken, "get_recent_changes");
      if (resolved && "error" in resolved) return resolved.error;
      if (resolved) {
        const useIdentifiers = resolved.buffered.identifiersOnly ?? args.identifiersOnly;
        const extra = useIdentifiers ? { identifiersOnly: true } : undefined;
        return drainOaiBuffer(
          resolved.buffered, args.maxResults, "totalChanges", "get_recent_changes",
          (token) => fetchByMode(token, useIdentifiers),
          extra, formatRecordLine,
        );
      }

      const opts = {
        from: args.from,
        until: args.until,
        set: args.setSpec,
        resumptionToken: args.resumptionToken,
      };

      const useIdentifiers = args.identifiersOnly;
      const result = useIdentifiers
        ? await oai.listIdentifiers(opts)
        : await oai.listRecords(opts);

      const extra = useIdentifiers ? { identifiersOnly: true } : undefined;
      return paginatedResponse(result, args.maxResults, "totalChanges", "get_recent_changes", extra, formatRecordLine, useIdentifiers);
    })
  );

  // ── search_provenance (conditionally registered when provenance tables exist) ──

  const PROVENANCE_TRANSFER_TYPES = [
    "sale", "inheritance", "by_descent", "widowhood", "bequest", "commission",
    "confiscation", "theft", "looting", "recuperation", "restitution",
    "loan", "transfer", "collection", "gift",
    "deposit", "exchange", "inventory",
    "unknown",
  ] as const;

  const ProvenanceSearchOutput = {
    totalArtworks: z.number().int()
      .describe("Number of artworks with matching provenance events/periods. Capped at 50,000 — see totalArtworksCapped."),
    totalArtworksCapped: z.boolean().optional()
      .describe("True when the actual total reaches the 50,000 cap. Narrow the search to bring the total under the cap if you need an exact figure."),
    results: z.array(z.object({
      objectNumber: z.string(),
      title: z.string(),
      creator: z.string(),
      date: z.string().optional(),
      url: z.string(),
      eventCount: z.number().int(),
      matchedEventCount: z.number().int(),
      events: z.array(z.object({
        sequence: z.number().int(),
        rawText: z.string(),
        gap: z.boolean(),
        transferType: z.string(),
        unsold: z.boolean()
          .describe("True if this sale event was unsold, bought in, or withdrawn at auction. Only meaningful when transferType is 'sale'."),
        batchPrice: z.boolean()
          .describe("True if the price is a batch/en bloc total for multiple artworks, not an individual price. Filter these out when ranking by price."),
        transferCategory: z.enum(["ownership", "custody", "ambiguous"]).nullable()
          .describe("Whether this transfer involves ownership change, custody change, or is ambiguous."),
        uncertain: z.boolean(),
        parties: z.array(z.object({
          name: z.string(),
          dates: z.string().nullable(),
          uncertain: z.boolean(),
          role: z.string().nullable(),
          position: z.enum(["sender", "receiver", "agent"]).nullable()
            .describe("Party's position in the transfer: sender (relinquishes), receiver (acquires), agent (facilitates)."),
          positionMethod: z.string().nullable().optional()
            .describe("How position was determined: role_mapping (parser), llm_enrichment (LLM-classified), llm_disambiguation (LLM-decomposed from merged text)."),
          enrichmentReasoning: z.string().nullable().optional()
            .describe("LLM reasoning for position assignment (only present for llm_enrichment/llm_disambiguation)."),
        })),
        dateExpression: z.string().nullable(),
        dateYear: z.number().int().nullable(),
        dateQualifier: z.string().nullable(),
        location: z.string().nullable(),
        price: z.object({
          amount: z.number(),
          currency: z.string(),
        }).nullable(),
        saleDetails: z.string().nullable(),
        citations: z.array(z.object({ text: z.string() })),
        isCrossRef: z.boolean(),
        crossRefTarget: z.string().nullable(),
        // #268: the fine-axis literals below mirror scripts/provenance-enrichment-methods.mjs
        // (and its Python twin scripts/provenance_enrichment_methods.py). Any rename or
        // addition must be made there first; the writebacks are the source of truth for
        // what lands in the DB.
        parseMethod: z.enum(["peg", "regex_fallback", "cross_ref", "credit_line", "llm_structural"]),
        categoryMethod: z.string().nullable().optional()
          .describe("How transfer_category was determined: type_mapping (parser), llm_enrichment, rule:transfer_is_ownership."),
        correctionMethod: z.string().nullable().optional()
          .describe("LLM structural correction applied: llm_structural:#149 (location), llm_structural:#87 (reclassification), llm_structural:#125 (event split), etc."),
        enrichmentReasoning: z.string().nullable().optional()
          .describe("LLM reasoning for type/category classification or structural correction."),
        matched: z.boolean().describe("True if this event matched the search criteria."),
      })),
      periods: z.array(z.object({
        sequence: z.number().int(),
        ownerName: z.string().nullable(),
        ownerDates: z.string().nullable(),
        location: z.string().nullable(),
        acquisitionMethod: z.string().nullable(),
        acquisitionFrom: z.string().nullable(),
        beginYear: z.number().int().nullable(),
        beginYearLatest: z.number().int().nullable(),
        endYear: z.number().int().nullable(),
        duration: z.number().int().nullable().describe("Ownership duration in years (endYear - beginYear), null if unknown."),
        derivation: z.record(z.string()).describe("How each field was derived from source events."),
        uncertain: z.boolean(),
        citations: z.array(z.object({ text: z.string() })),
        sourceEvents: z.array(z.number().int()),
        matched: z.boolean().describe("True if this period matched the search criteria."),
      })).optional().describe("Ownership periods (Layer 2 interpretation). Present when layer='periods'."),
      periodCount: z.number().int().optional(),
      matchedPeriodCount: z.number().int().optional(),
    })),
    facets: z.record(z.string(), z.array(z.object({
      label: z.string(),
      count: z.number().int(),
      percentage: z.number().optional(),
    }))).optional().describe("Provenance facets when facets=true. Dimensions: transferType, decade, location, transferCategory, partyPosition."),
    warnings: z.array(z.string()).optional(),
    error: z.string().optional(),
  };

  if (vocabAvailable && vocabDb!.hasProvenanceTables) {
    server.registerTool(
      "search_provenance",
      {
        title: "Search Provenance",
        annotations: ANN_READ_CLOSED,
        description:
          "Use when the user has a provenance question — ownership history, collectors, sales, inheritances, gifts, confiscations, restitutions, " +
          "or a search across the parsed provenance corpus (~48K artworks with structured records). " +
          "Returns full provenance chains grouped by artwork, with matching events flagged.\n\n" +
          "Not for catalogue keyword search — use search_artwork. " +
          "Not for aggregate provenance counts — use collection_stats with provenance dimensions/filters. " +
          "v0.27 added periodLocation (period-level location filter, preferred over location at layer='periods' for clarity).\n\n" +
          "Each chain tells the complete ownership story: collectors, sales, inheritances, gifts, confiscations, and restitutions, with dates, locations, prices, and citations.\n\n" +
          "Use objectNumber for a single artwork's chain (fast local lookup, no network). " +
          "Use party to trace a collector or dealer across artworks (e.g. 'Six', 'Rothschild'). " +
          "Use relatedTo for reverse cross-references — find all works sharing provenance with a given object " +
          "(pendants, album sheets, dollhouse contents). " +
          "Combine transferType, dateFrom/dateTo, location for pattern discovery " +
          "(e.g. confiscations 1940–1945, sales in Paris).\n\n" +
          "IMPORTANT flags on events:\n" +
          "- unsold: true means this sale event was unsold/bought-in/withdrawn at auction — no ownership transfer occurred. " +
          "Filter these when analysing actual sales.\n" +
          "- batchPrice: true means the price is an en bloc/batch total for multiple artworks, not an individual price. " +
          "Filter these when ranking or comparing prices — they massively distort rankings.\n\n" +
          "Every record carries provenance-of-provenance metadata: parseMethod shows how the event was parsed " +
          "(peg, regex_fallback, cross_ref, credit_line, llm_structural), categoryMethod/positionMethod show how classifications " +
          "and party positions were determined (type_mapping, role_mapping, llm_enrichment, llm_disambiguation, " +
          "rule:transfer_is_ownership), correctionMethod (llm_structural:#NNN) shows LLM structural corrections " +
          "(location fixes, event reclassification, event splitting), and enrichmentReasoning provides the LLM's reasoning " +
          "for any non-deterministic decision. Parties have position (sender/receiver/agent) indicating their role in the transfer.\n\n" +
          "IMPORTANT: When results contain LLM-enriched records, the response text ends with a REVIEW_URL or REVIEW_FILE line. " +
          "You MUST copy this URL or file path verbatim into your response as a clickable link or openable path. " +
          "Do NOT omit it, paraphrase it, summarise it, or refer to it indirectly (e.g. 'see the link above'). " +
          "The user cannot see tool output — if you do not include the path, they have no way to find the review page.\n\n" +
          "Use hasGap to find artworks with gaps in their provenance chain — red flags for wartime displacement or undocumented transfers. " +
          "Only the parsed provenance fields exposed below are searchable; raw-text full-text search across provenance was removed in v0.27. " +
          "For the last link in the chain — how the Rijksmuseum acquired it (donor, fund, bequest) — " +
          "also check search_artwork's creditLine parameter. CreditLine covers ~358K artworks (vs ~48K with provenance) " +
          "and often names donors or funds absent from the provenance chain (e.g. 'Drucker-Fraser', 'Vereniging Rembrandt'). " +
          "At least one filter is required.",
        inputSchema: z.object({
          layer: z.preprocess(stripNull,
            z.enum(["events", "periods"]).default("events").optional(),
          ).describe("Data layer. 'events' (default): raw parsed provenance events (Layer 1). 'periods': interpreted ownership periods with durations (Layer 2)."),
          party: optStr().describe("Owner, collector, or dealer name (partial match, e.g. 'Six', 'Rothschild', 'Westendorp')."),
          transferType: z.preprocess(
            normalizeStringOrArray,
            z.union([z.enum(PROVENANCE_TRANSFER_TYPES), z.array(z.enum(PROVENANCE_TRANSFER_TYPES))]).optional(),
          ).describe("Type of ownership transfer (single or array). Use excludeTransferType for set difference (e.g. confiscated but never restituted). Well-populated: collection (18.5K), sale (15.6K — includes unsold, filter with unsold flag), by_descent (13.7K), gift (10.7K), transfer (6.2K), loan (6.3K), bequest (4.4K), widowhood (3.4K). Rare: recuperation, commission, deposit, restitution, confiscation, exchange, inventory, theft, looting. Generic: inheritance (when specific relationship unknown)."),
          excludeTransferType: z.preprocess(
            normalizeStringOrArray,
            z.union([z.enum(PROVENANCE_TRANSFER_TYPES), z.array(z.enum(PROVENANCE_TRANSFER_TYPES))]).optional(),
          ).describe("Exclude artworks that have ANY event of this type. Artwork-level negation (e.g. confiscated but never restituted)."),
          ownerName: optStr().describe("Owner name (partial match). Only used with layer='periods'."),
          acquisitionMethod: z.preprocess(stripNull,
            z.enum(PROVENANCE_TRANSFER_TYPES).optional(),
          ).describe("Acquisition method filter (exact match). Only used with layer='periods'."),
          location: optStr().describe("City or place name (partial match, e.g. 'Amsterdam', 'Paris', 'London')."),
          periodLocation: optStr().describe(
            "Place name on the ownership-period record (e.g. 'Amsterdam', 'Paris'). " +
            "Filters against provenance_periods.location (45% populated). " +
            "Preferred over location when scoping a periods-layer query — distinguishable from event-level location. " +
            "AND-combined with location when both are supplied. Only used with layer='periods'.",
          ),
          dateFrom: z.preprocess(stripNull, z.number().int().optional())
            .describe("Earliest year (inclusive) for provenance event/period dates."),
          dateTo: z.preprocess(stripNull, z.number().int().optional())
            .describe("Latest year (inclusive) for provenance event/period dates."),
          objectNumber: optStr().describe("Get full provenance chain for a specific artwork (e.g. 'SK-A-2344'). Fast local lookup."),
          creator: optStr().describe("Artist name (partial match on creator, e.g. 'Rembrandt', 'Vermeer')."),
          currency: z.preprocess(stripNull,
            z.enum(["guilders", "euros", "pounds", "francs", "dollars", "livres", "napoléons", "deutschmarks", "reichsmarks", "swiss_francs", "guineas", "belgian_francs", "yen", "marks", "louis_d_or"]).optional(),
          ).describe("Price currency filter (exact match). Only used with layer='events'."),
          hasPrice: z.preprocess(stripNull, z.boolean().optional())
            .describe("If true, only events with recorded prices. Only used with layer='events'."),
          hasGap: z.preprocess(stripNull, z.boolean().optional())
            .describe("If true, only artworks with provenance gaps (undocumented periods). Only used with layer='events'."),
          relatedTo: optStr().describe("Reverse cross-reference: find all artworks whose provenance references this object number (e.g. 'BK-14656'). Only used with layer='events'."),
          categoryMethod: optStr().describe(
            "Filter events by how transfer_category was determined. Values: type_mapping (parser-assigned), " +
            "llm_enrichment (LLM-classified), rule:transfer_is_ownership (deterministic rule). " +
            "Use categoryMethod='llm_enrichment' to find artworks with LLM-mediated type classifications.",
          ),
          positionMethod: optStr().describe(
            "Filter by how party positions (sender/receiver/agent) were determined. Values: role_mapping (parser), " +
            "type_mapping (from transfer type), llm_enrichment (LLM-classified), llm_disambiguation (LLM-decomposed from merged text). " +
            "Use positionMethod='llm_enrichment' to find artworks with LLM-mediated party positions.",
          ),
          minDuration: z.preprocess(stripNull, z.number().int().min(1).optional())
            .describe("Minimum ownership years. Only used with layer='periods'."),
          maxDuration: z.preprocess(stripNull, z.number().int().min(1).optional())
            .describe("Maximum ownership years. Only used with layer='periods'."),
          sortBy: z.preprocess(stripNull,
            z.enum(["price", "dateYear", "eventCount", "duration"]).optional(),
          ).describe("Sort results by this dimension. Use sortBy to rank results (e.g. highest prices, longest ownership). 'duration' only works with layer='periods'."),
          sortOrder: z.preprocess(stripNull,
            z.enum(["asc", "desc"]).default("desc").optional(),
          ).describe("Sort direction (default 'desc')."),
          offset: z.preprocess(stripNull,
            z.number().int().min(0).default(0).optional(),
          ).describe("Skip this many artworks (for pagination). Use with maxResults."),
          maxResults: z.preprocess(stripNull,
            z.number().int().min(1).max(TOOL_LIMITS.search_provenance.max).default(TOOL_LIMITS.search_provenance.default).optional(),
          ).describe(`Maximum artworks to return (1–${TOOL_LIMITS.search_provenance.max}, default ${TOOL_LIMITS.search_provenance.default}). Each artwork includes its full chain.`),
          facets: z.preprocess(stripNull, z.boolean().optional())
            .describe("If true, compute provenance facets: transferType, decade, location, transferCategory, partyPosition."),
        }).strict(),
        ...withOutputSchema(ProvenanceSearchOutput),
      },
      withLogging("search_provenance", async (args: Record<string, unknown>) => {
        const layer = (args.layer as string | undefined) ?? "events";
        const params: ProvenanceSearchParams = {
          maxResults: (args.maxResults as number | undefined) ?? TOOL_LIMITS.search_provenance.default,
          layer: layer as "events" | "periods",
        };
        if (args.party) params.party = args.party as string;
        if (args.transferType) params.transferType = args.transferType as string | string[];
        if (args.excludeTransferType) params.excludeTransferType = args.excludeTransferType as string | string[];
        if (args.ownerName) params.ownerName = args.ownerName as string;
        if (args.acquisitionMethod) params.acquisitionMethod = args.acquisitionMethod as string;
        if (args.location) params.location = args.location as string;
        if (args.periodLocation) params.periodLocation = args.periodLocation as string;
        if (args.dateFrom != null) params.dateFrom = args.dateFrom as number;
        if (args.dateTo != null) params.dateTo = args.dateTo as number;
        if (args.objectNumber) params.objectNumber = args.objectNumber as string;
        if (args.creator) params.creator = args.creator as string;
        if (args.currency) params.currency = args.currency as string;
        if (args.hasPrice != null) params.hasPrice = args.hasPrice as boolean;
        if (args.hasGap != null) params.hasGap = args.hasGap as boolean;
        if (args.relatedTo) params.relatedTo = args.relatedTo as string;
        if (args.categoryMethod) params.categoryMethod = args.categoryMethod as string;
        if (args.positionMethod) params.positionMethod = args.positionMethod as string;
        if (args.minDuration != null) params.minDuration = args.minDuration as number;
        if (args.maxDuration != null) params.maxDuration = args.maxDuration as number;
        if (args.sortBy) params.sortBy = args.sortBy as ProvenanceSearchParams["sortBy"];
        if (args.sortOrder) params.sortOrder = args.sortOrder as "asc" | "desc";
        if (args.offset != null) params.offset = args.offset as number;
        if (args.facets) params.facets = true;

        // At least one substantive filter required
        const hasFilter = PROVENANCE_ALL_FILTERS
          .some(k => (params as Record<string, unknown>)[k] !== undefined);
        if (!hasFilter) {
          return errorResponse(
            "At least one search filter is required (e.g. party, transferType, location, dateFrom/dateTo, creator, objectNumber, " +
            "ownerName, acquisitionMethod, minDuration). Modifiers like sortBy, sortOrder, maxResults, offset, and layer do not count. " +
            "Tip: use a broad filter such as dateFrom: 1400 for collection-wide ranking.",
          );
        }

        // Reject filters that the chosen layer does not implement
        const ignoredFilters = (layer === "periods" ? PROVENANCE_EVENT_ONLY_FILTERS : PROVENANCE_PERIOD_ONLY_FILTERS)
          .filter(k => (params as Record<string, unknown>)[k] !== undefined);
        if (ignoredFilters.length > 0) {
          return errorResponse(
            `The "${layer}" layer does not support these filters: ${ignoredFilters.join(", ")}. ` +
            (layer === "periods"
              ? `Switch to layer="events" for event-level filters, or use: ${[...PROVENANCE_SHARED_FILTERS, ...PROVENANCE_PERIOD_ONLY_FILTERS].join(", ")}.`
              : `Switch to layer="periods" for period-level filters, or use: ${[...PROVENANCE_SHARED_FILTERS, ...PROVENANCE_EVENT_ONLY_FILTERS].join(", ")}.`),
          );
        }

        // Route on layer
        const result = layer === "periods"
          ? vocabDb!.searchProvenancePeriods(params)
          : vocabDb!.searchProvenance(params);

        // Text channel
        const lines: string[] = [];
        if (result.totalArtworksCapped) {
          lines.push(`≥${result.totalArtworks.toLocaleString()} artworks with matching provenance (capped — narrow the query for an exact total)`);
        } else {
          lines.push(`${pluralize(result.totalArtworks, "artwork")} with matching provenance`);
        }
        for (const artwork of result.results) {
          lines.push("");
          lines.push(`${artwork.objectNumber} | "${artwork.title}" — ${artwork.creator}${artwork.date ? ` (${artwork.date})` : ""}`);
          lines.push(`  ${artwork.url}`);

          if (layer === "periods" && artwork.periods) {
            // Format periods
            for (const p of artwork.periods) {
              const marker = p.matched ? ">>>" : "   ";
              const parts: string[] = [];
              if (p.ownerName) parts.push(p.ownerName);
              if (p.acquisitionMethod) parts.push(p.acquisitionMethod);
              const yearRange = p.beginYear != null || p.endYear != null
                ? `${p.beginYear ?? "?"}–${p.endYear ?? "?"}`
                : null;
              if (yearRange) {
                const durStr = p.duration != null ? ` (${p.duration} yrs)` : "";
                parts.push(yearRange + durStr);
              }
              if (p.location) parts.push(p.location);
              lines.push(`  ${marker} ${p.sequence}. ${parts.join(" | ")}`);
            }
          } else {
            // Format events
            for (const e of artwork.events) {
              const marker = e.matched ? ">>>" : "   ";
              const partyNames = e.parties.map(p => p.name).join(", ");
              const parts: string[] = [];
              if (e.transferType !== "unknown") parts.push(e.unsold ? `${e.transferType} (unsold)` : e.transferType);
              if (partyNames) parts.push(partyNames);
              if (e.dateExpression) parts.push(e.dateExpression);
              else if (e.dateYear) parts.push(String(e.dateYear));
              if (e.location) parts.push(e.location);
              if (e.price) parts.push(`${e.price.currency} ${e.price.amount.toLocaleString()}${e.batchPrice ? " (batch)" : ""}`);
              if (e.isCrossRef && e.crossRefTarget) parts.push(`→ see ${e.crossRefTarget}`);
              const meta: string[] = [];
              const parseT = compactMethodTag(e.parseMethod, "peg");
              if (parseT) meta.push(`parse=${parseT}`);
              if (e.transferCategory) {
                const catT = compactMethodTag(e.categoryMethod, "type_mapping");
                meta.push(catT ? `cat=${e.transferCategory}/${catT}` : `cat=${e.transferCategory}`);
              }
              const fixT = compactMethodTag(e.correctionMethod);
              if (fixT) meta.push(`fix=${fixT}`);
              const partyPosTags: string[] = [];
              for (const p of e.parties) {
                const posT = compactMethodTag(p.positionMethod, "role_mapping");
                if (posT) partyPosTags.push(`${p.name}@${posT}`);
              }
              if (partyPosTags.length) meta.push(`pos:${partyPosTags.join(",")}`);
              const suffix = meta.length ? `  [${meta.join(" | ")}]` : "";
              lines.push(`  ${marker} ${e.sequence}. ${parts.length > 0 ? parts.join(" | ") : e.rawText}${suffix}`);
            }
          }
        }

        // Enrichment review: only generate page when LLM-mediated items exist,
        // but include rule-based enrichments on the page for context
        if (layer === "events") {
          let llmEvents = 0;
          let llmParties = 0;
          for (const art of result.results) {
            for (const e of art.events) {
              if (isLlmEnrichedEvent(e)) llmEvents++;
              for (const p of e.parties) {
                if (isLlmEnrichedParty(p)) llmParties++;
              }
            }
          }

          if (llmEvents > 0 || llmParties > 0) {
            // Build query summary for display
            const queryParts: string[] = [];
            if (params.party) queryParts.push(`party="${params.party}"`);
            if (params.transferType) queryParts.push(`type=${Array.isArray(params.transferType) ? params.transferType.join(",") : params.transferType}`);
            if (params.location) queryParts.push(`location="${params.location}"`);
            if (params.dateFrom != null || params.dateTo != null) queryParts.push(`date=${params.dateFrom ?? "?"}–${params.dateTo ?? "?"}`);
            if (params.objectNumber) queryParts.push(`objectNumber=${params.objectNumber}`);
            if (params.creator) queryParts.push(`creator="${params.creator}"`);

            const reviewData: EnrichmentReviewData = {
              query: queryParts.join(", ") || "(all filters)",
              artworks: result.results.map(art => ({
                objectNumber: art.objectNumber,
                title: art.title,
                creator: art.creator,
                events: art.events.map(e => ({
                  sequence: e.sequence,
                  rawText: e.rawText,
                  gap: e.gap,
                  transferType: e.transferType,
                  unsold: e.unsold,
                  batchPrice: e.batchPrice,
                  dateYear: e.dateYear,
                  categoryMethod: e.categoryMethod ?? null,
                  correctionMethod: e.correctionMethod ?? null,
                  enrichmentReasoning: e.enrichmentReasoning ?? null,
                  parties: e.parties.map(p => ({
                    name: p.name,
                    role: p.role,
                    position: p.position,
                    positionMethod: p.positionMethod ?? null,
                    enrichmentReasoning: p.enrichmentReasoning ?? null,
                  })),
                })),
              })),
            };

            const html = generateEnrichmentReviewHtml(reviewData);
            const uuid = randomUUID();

            if (httpPort) {
              enrichmentReviewPages.set(uuid, { html, lastAccess: Date.now() });
              const reviewUrl = `${publicBaseUrl}/enrichment-review/${uuid}`;
              lines.push("");
              lines.push(`ENRICHMENT REVIEW: ${llmEvents + llmParties} LLM-assisted result${(llmEvents + llmParties) !== 1 ? "s" : ""}.`);
              lines.push(`REVIEW_URL: ${reviewUrl}`);
              lines.push("INSTRUCTION: You MUST include the REVIEW_URL above as a clickable link in your response. Do NOT omit it, summarize it, or refer to it indirectly. Copy the full URL verbatim.");
            } else {
              const filePath = path.join(os.tmpdir(), `rijksmuseum-enrichment-review-${uuid}.html`);
              fs.writeFileSync(filePath, html, "utf-8");
              lines.push("");
              lines.push(`ENRICHMENT REVIEW: ${llmEvents + llmParties} LLM-assisted result${(llmEvents + llmParties) !== 1 ? "s" : ""}.`);
              lines.push(`REVIEW_FILE: ${filePath}`);
              lines.push("INSTRUCTION: You MUST include the REVIEW_FILE path above in your response so the user can open it. Do NOT omit it, summarize it, or refer to it indirectly. Copy the full path verbatim.");
            }
          }
        }

        // Add percentages to provenance facets and format in text output
        if (result.facets) {
          addPercentages(result.facets);
          lines.push("");
          lines.push(formatFacets(result.facets));
        }

        const data: InferOutput<typeof ProvenanceSearchOutput> = result;
        return structuredResponse(data, lines.join("\n"));
      })
    );
  }

  // ── collection_stats (analytics/aggregation) ──────────────────────

  if (vocabAvailable) {
    const STATS_DIMENSIONS = STATS_DIMENSION_NAMES;

    server.registerTool(
      "collection_stats",
      {
        title: "Collection Statistics",
        annotations: ANN_READ_CLOSED,
        description:
          "Use when the user wants aggregate counts, percentages, or distributions across the collection (one call instead of search_artwork(compact=true) loops). " +
          "Returns formatted text tables — no structured output schema. " +
          "Not for individual artwork lookup — use get_artwork_details. Not for similarity — use find_similar.\n\n" +
          "Examples:\n" +
          "- \"What types of artworks have provenance?\" → dimension='type', hasProvenance=true\n" +
          "- \"Transfer type distribution for Rembrandt\" → dimension='transferType', creator='Rembrandt'\n" +
          "- \"Top 20 depicted persons\" → dimension='depictedPerson', topN=20\n" +
          "- \"Sales by decade 1600–1900\" → dimension='provenanceDecade', transferType='sale', dateFrom=1600, dateTo=1900\n" +
          "- \"How many artworks have LLM-mediated interpretations?\" → dimension='categoryMethod'\n\n" +
          "Artwork dimensions: type, material, technique, creator, depictedPerson, depictedPlace, productionPlace, century, decade, height, width, " +
          "theme (thematic vocab — labels in NL until #300 backfill), sourceType (cataloguing-channel taxonomy — 6 values), " +
          "exhibition (top exhibitions by member count), decadeModified (record_modified bucketed by decade, clamped to 1990–2030).\n" +
          "Provenance dimensions: transferType, transferCategory, provenanceDecade, provenanceLocation, party, partyPosition, " +
          "currency, categoryMethod, positionMethod, parseMethod.\n\n" +
          "Filters from both domains combine freely. Artwork filters narrow the artwork set; provenance filters " +
          "further restrict to artworks matching those provenance criteria. " +
          "For demographic-filtered counts (e.g. female artists by century), first run search_persons to get vocab IDs, then pass them as creator here.",
        inputSchema: z.object({
          dimension: z.enum(STATS_DIMENSIONS as unknown as [string, ...string[]])
            .describe("What to count/group by."),
          topN: z.preprocess(stripNull, z.number().int().min(1).max(TOOL_LIMITS.collection_stats.max).default(TOOL_LIMITS.collection_stats.default).optional())
            .describe(`Maximum entries to return (1–${TOOL_LIMITS.collection_stats.max}, default ${TOOL_LIMITS.collection_stats.default}).`),
          offset: z.preprocess(stripNull, z.number().int().min(0).default(0).optional())
            .describe("Skip this many entries (for pagination). Use with topN."),
          binWidth: z.preprocess(stripNull, z.number().int().min(1).default(10).optional())
            .describe("Bin width for decade dimensions (default 10 = decades, use 50 for half-centuries, 100 for centuries)."),
          // Artwork filters
          type: optStr().describe("Filter to artworks of this type (e.g. 'painting', 'print')."),
          material: optStr().describe("Filter to artworks with this material."),
          technique: optStr().describe("Filter to artworks with this technique."),
          creator: optStr().describe("Filter to artworks by this creator (partial match)."),
          productionPlace: optStr().describe("Filter to artworks produced in this place (partial match)."),
          depictedPerson: optStr().describe("Filter to artworks depicting this person (partial match)."),
          depictedPlace: optStr().describe("Filter to artworks depicting this place (partial match)."),
          subject: optStr().describe("Filter to artworks with this subject (partial match on Iconclass labels)."),
          iconclass: optStr().describe("Filter by exact Iconclass notation code (e.g. '73D82')."),
          collectionSet: optStr().describe("Filter to artworks in this curated set (partial match on set name)."),
          theme: optStr().describe("Filter to artworks tagged with this curatorial theme (partial match)."),
          sourceType: optStr().describe("Filter by source-channel taxonomy: 'designs', 'drawings', 'paintings', 'prints (visual works)', 'sculpture (visual works)', 'photographs'."),
          imageAvailable: z.preprocess(stripNull, z.boolean().optional())
            .describe("If true, restrict to artworks with a digital image."),
          creationDateFrom: z.preprocess(stripNull, z.number().int().optional())
            .describe("Earliest creation year (inclusive)."),
          creationDateTo: z.preprocess(stripNull, z.number().int().optional())
            .describe("Latest creation year (inclusive)."),
          // Provenance filters
          hasProvenance: z.preprocess(stripNull, z.boolean().optional())
            .describe("If true, restrict to artworks with provenance records (~48K of 832K)."),
          transferType: optStr().describe("Filter to artworks with this provenance transfer type (e.g. 'sale', 'confiscation')."),
          location: optStr().describe("Filter to artworks with provenance events in this location (partial match)."),
          party: optStr().describe("Filter to artworks involving this party/collector (partial match)."),
          dateFrom: z.preprocess(stripNull, z.number().int().optional())
            .describe("Earliest provenance event year (inclusive)."),
          dateTo: z.preprocess(stripNull, z.number().int().optional())
            .describe("Latest provenance event year (inclusive)."),
          categoryMethod: optStr().describe("Filter by category method (e.g. 'llm_enrichment')."),
          positionMethod: optStr().describe("Filter by position method (e.g. 'llm_enrichment')."),
        }).strict(),
        // No outputSchema — text-only output by design.
      },
      withLogging("collection_stats", async (args: Record<string, unknown>) => {
        const params: CollectionStatsParams = {
          dimension: args.dimension as string,
        };
        if (args.topN != null) params.topN = args.topN as number;
        if (args.offset != null) params.offset = args.offset as number;
        if (args.binWidth != null) params.binWidth = args.binWidth as number;
        if (args.type) params.type = args.type as string;
        if (args.material) params.material = args.material as string;
        if (args.technique) params.technique = args.technique as string;
        if (args.creator) params.creator = args.creator as string;
        if (args.productionPlace) params.productionPlace = args.productionPlace as string;
        if (args.depictedPerson) params.depictedPerson = args.depictedPerson as string;
        if (args.depictedPlace) params.depictedPlace = args.depictedPlace as string;
        if (args.subject) params.subject = args.subject as string;
        if (args.iconclass) params.iconclass = args.iconclass as string;
        if (args.collectionSet) params.collectionSet = args.collectionSet as string;
        if (args.theme) params.theme = args.theme as string;
        if (args.sourceType) params.sourceType = args.sourceType as string;
        if (args.imageAvailable != null) params.imageAvailable = args.imageAvailable as boolean;
        if (args.creationDateFrom != null) params.creationDateFrom = args.creationDateFrom as number;
        if (args.creationDateTo != null) params.creationDateTo = args.creationDateTo as number;
        if (args.hasProvenance != null) params.hasProvenance = args.hasProvenance as boolean;
        if (args.transferType) params.transferType = args.transferType as string;
        if (args.location) params.location = args.location as string;
        if (args.party) params.party = args.party as string;
        if (args.dateFrom != null) params.dateFrom = args.dateFrom as number;
        if (args.dateTo != null) params.dateTo = args.dateTo as number;
        if (args.categoryMethod) params.categoryMethod = args.categoryMethod as string;
        if (args.positionMethod) params.positionMethod = args.positionMethod as string;

        const result = vocabDb!.computeCollectionStats(params);

        // Format as text table
        const lines: string[] = [];
        const filterParts: string[] = [];
        if (params.type) filterParts.push(`type=${params.type}`);
        if (params.material) filterParts.push(`material=${params.material}`);
        if (params.technique) filterParts.push(`technique=${params.technique}`);
        if (params.creator) filterParts.push(`creator=${params.creator}`);
        if (params.productionPlace) filterParts.push(`productionPlace=${params.productionPlace}`);
        if (params.depictedPerson) filterParts.push(`depictedPerson=${params.depictedPerson}`);
        if (params.depictedPlace) filterParts.push(`depictedPlace=${params.depictedPlace}`);
        if (params.subject) filterParts.push(`subject=${params.subject}`);
        if (params.iconclass) filterParts.push(`iconclass=${params.iconclass}`);
        if (params.collectionSet) filterParts.push(`collectionSet=${params.collectionSet}`);
        if (params.theme) filterParts.push(`theme=${params.theme}`);
        if (params.sourceType) filterParts.push(`sourceType=${params.sourceType}`);
        if (params.imageAvailable) filterParts.push("imageAvailable");
        if (params.creationDateFrom != null || params.creationDateTo != null) {
          filterParts.push(`created ${params.creationDateFrom ?? "..."}–${params.creationDateTo ?? "..."}`);
        }
        if (params.hasProvenance) filterParts.push("hasProvenance");
        if (params.transferType) filterParts.push(`transferType=${params.transferType}`);
        if (params.location) filterParts.push(`location=${params.location}`);
        if (params.party) filterParts.push(`party=${params.party}`);
        if (params.dateFrom != null || params.dateTo != null) {
          filterParts.push(`provenance ${params.dateFrom ?? "..."}–${params.dateTo ?? "..."}`);
        }
        if (params.categoryMethod) filterParts.push(`categoryMethod=${params.categoryMethod}`);
        if (params.positionMethod) filterParts.push(`positionMethod=${params.positionMethod}`);

        const filterStr = filterParts.length > 0 ? ` (${filterParts.join(", ")})` : "";
        lines.push(`${result.dimension} distribution${filterStr}:`);
        lines.push(`Total artworks: ${result.total.toLocaleString()}`);
        if (result.totalDistinct > result.entries.length + result.offset) {
          const from = result.offset + 1;
          const to = result.offset + result.entries.length;
          lines.push(`Showing entries ${from}–${to} of ${result.totalDistinct} distinct values`);
        }
        lines.push("");

        if (result.entries.length === 0) {
          lines.push("  (no data)");
        } else {
          // Determine column widths for alignment
          const maxLabel = Math.max(...result.entries.map(e => e.label.length));
          const maxCount = Math.max(...result.entries.map(e => e.count.toLocaleString().length));
          for (const e of result.entries) {
            const pct = e.percentage != null ? `  (${e.percentage.toFixed(1)}%)` : "";
            lines.push(`  ${e.label.padEnd(maxLabel)}  ${e.count.toLocaleString().padStart(maxCount)}${pct}`);
          }
        }

        if (result.warnings) {
          lines.push("");
          for (const w of result.warnings) lines.push(`Warning: ${w}`);
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      })
    );
  }

  // ── find_similar (on by default; set ENABLE_FIND_SIMILAR=false to disable) ──

  if (vocabAvailable && process.env.ENABLE_FIND_SIMILAR !== "false") {
    server.registerTool(
      "find_similar",
      {
        title: "Find Similar Artworks",
        annotations: ANN_READ_CLOSED,
        description:
          "Use when the user has a SPECIFIC artwork (objectNumber) and wants others like it. " +
          "Generates an HTML comparison page with IIIF thumbnails across 9 independent similarity channels: " +
          "Visual (image-embedding nearest neighbours), Related Co-Production (creator-invariant curator-declared edges: pendants, production stadia, different examples), " +
          "Related Object (other curator-declared edges: pairs, sets, recto/verso, reproductions, general related-object links — tiered weights), " +
          "Lineage (creator + assignment-qualifier overlap), Iconclass (subject-notation overlap), Description (Dutch-description embedding similarity), " +
          "Theme (curatorial-theme set overlap, IDF-weighted), Depicted Person, and Depicted Place — plus a Pooled column blending all nine.\n\n" +
          "Not for free-text concept queries — use semantic_search. " +
          "Not for filter-based search — use search_artwork.\n\n" +
          "IMPORTANT: The result is a file path or URL to an HTML page. " +
          "Your ONLY job is to show the user the path/URL so they can open it in a browser. " +
          "Do NOT attempt to open, read, fetch, summarise, or characterise the page contents. " +
          "Do NOT make additional tool calls to look up the same artworks. " +
          "Simply present the link and explain that it contains a visual comparison page.",
        inputSchema: z.object({
          objectNumber: z.string().describe("Object number of the artwork to find similar works for (e.g. 'SK-A-1718')."),
          maxResults: z.preprocess(stripNull, z.number().int().min(1).max(TOOL_LIMITS.find_similar.max).default(TOOL_LIMITS.find_similar.default).optional())
            .describe("Number of results per signal mode (default 20, max 50)."),
        }).strict(),
        // No outputSchema — returns a URL/path to an HTML comparison page, not structured data.
      },
      withLogging("find_similar", async (args) => {
        const maxResults = args.maxResults ?? 20;

        // Resolve query artwork metadata + iiif_id
        const artRow = vocabDb!.lookupArtId(args.objectNumber);
        if (!artRow) return errorResponse(`Artwork "${args.objectNumber}" not found.`);
        const queryMeta = vocabDb!.batchLookupByArtId([artRow.artId]);
        const queryInfo = queryMeta.get(artRow.artId);
        const queryTypeMap = vocabDb!.batchLookupTypesByArtId([artRow.artId]);
        const queryDescMap = vocabDb!.batchLookupDescriptionsByArtId([artRow.artId]);

        const queryDate = formatDateRange(queryInfo?.dateEarliest, queryInfo?.dateLatest);

        // Start visual search HTTP resolution concurrently with sync DB work
        const nodeIdPromise = resolveObjectNodeId(args.objectNumber);

        // ── Run all 4 signals ──────────────────────────────────────

        // Iconclass
        const icResult = vocabDb!.findSimilarByIconclass(args.objectNumber, maxResults);
        const icCandidates: SimilarCandidate[] = (icResult?.results ?? []).map(r => ({
          objectNumber: r.objectNumber,
          title: r.title,
          creator: r.creator,
          ...(r.date && { date: r.date }),
          ...(r.type && { type: r.type }),
          iiifId: r.iiifId,
          score: r.score,
          url: r.url,
          detail: r.sharedMotifs.map(m => `${m.notation} ${m.label}`).join(", "),
          sharedNotations: r.sharedMotifs.map(m => m.notation),
        }));

        // Lineage
        const liResult = vocabDb!.findSimilarByLineage(args.objectNumber, maxResults);
        const liCandidates: SimilarCandidate[] = (liResult?.results ?? []).map(r => {
          const primary = r.sharedLineage[0]; // highest-strength qualifier (sorted by VocabularyDb)
          return {
            objectNumber: r.objectNumber,
            title: r.title,
            creator: r.creator,
            ...(r.date && { date: r.date }),
            ...(r.type && { type: r.type }),
            iiifId: r.iiifId,
            score: r.score,
            url: r.url,
            detail: r.sharedLineage.map(l => `${l.qualifierLabel} ${l.creatorLabel}`).join(", "),
            ...(primary && {
              qualifierLabel: primary.qualifierLabel,
              qualifierUri: primary.qualifierUri,
              qualifierCreator: primary.creatorLabel,
            }),
          };
        });

        // Description — needs its own batch lookups (descriptions not in findSimilarBy* results)
        let descCandidates: SimilarCandidate[] = [];
        if (embeddingsDb?.descriptionAvailable) {
          const descResults = embeddingsDb.searchDescriptionSimilar(artRow.artId, maxResults);
          if (descResults.length > 0) {
            const descArtIds = descResults.map(r => r.artId);
            const descMeta = vocabDb!.batchLookupByArtId(descArtIds);
            const descTypes = vocabDb!.batchLookupTypesByArtId(descArtIds);
            const descTexts = vocabDb!.batchLookupDescriptionsByArtId(descArtIds);
            descCandidates = descResults.map(r => {
              const m = descMeta.get(r.artId);
              const date = formatDateRange(m?.dateEarliest, m?.dateLatest);
              return {
                objectNumber: r.objectNumber,
                title: m?.title ?? "",
                creator: m?.creator ?? "",
                ...(date && { date }),
                ...(descTypes.has(r.artId) && { type: descTypes.get(r.artId) }),
                iiifId: m?.iiifId ?? undefined,
                score: r.similarity,
                url: `https://www.rijksmuseum.nl/en/collection/${r.objectNumber}`,
                detail: truncate(descTexts.get(r.artId) ?? "", 200),
                descSnippet: truncateSnippet(descTexts.get(r.artId), 160),
              };
            });
          }
        }

        // Depicted Person & Place — map directly from enriched findSimilarBy* results
        function toDepictedCandidates(result: DepictedSimilarResult | null): SimilarCandidate[] {
          return (result?.results ?? []).map(r => ({
            objectNumber: r.objectNumber,
            title: r.title,
            creator: r.creator,
            ...(r.date && { date: r.date }),
            ...(r.type && { type: r.type }),
            iiifId: r.iiifId,
            score: r.score,
            url: r.url,
            detail: r.sharedTerms.map(t => t.label).join(", "),
            sharedTerms: r.sharedTerms.map(t => ({
              label: t.label,
              ...(t.wikidataUri && { wikidataUri: t.wikidataUri }),
            })),
          }));
        }

        const dpResult = vocabDb!.findSimilarByDepictedPerson(args.objectNumber, maxResults);
        const dpCandidates = toDepictedCandidates(dpResult);

        const dplResult = vocabDb!.findSimilarByDepictedPlace(args.objectNumber, maxResults);
        const dplCandidates = toDepictedCandidates(dplResult);

        // Theme (#294) — gated to allow disabling without taking down find_similar
        const themeEnabled = process.env.ENABLE_THEME_SIMILAR !== "false";
        const thResult = themeEnabled
          ? vocabDb!.findSimilarByTheme(args.objectNumber, maxResults)
          : null;
        const thCandidates = toDepictedCandidates(thResult);

        // Related Co-Production (#293) — creator-invariant curator-declared edges
        // ('different example' / 'production stadia' / 'pendant'), fixed score=10
        const cpResult = vocabDb!.findSimilarByCoProduction(args.objectNumber, maxResults);
        const cpCandidates = toDepictedCandidates(cpResult);

        // Related Object — other curator-declared edges (pair / set / recto|verso /
        // reproduction / catch-all related object), tiered scores 2-6.
        const roResult = vocabDb!.findSimilarByRelatedObject(args.objectNumber, maxResults);
        const roCandidates = toDepictedCandidates(roResult);

        // Visual (Rijksmuseum website API — best-effort, never blocks other signals)
        // nodeIdPromise was started concurrently with the sync DB signals above
        let visualCandidates: SimilarCandidate[] = [];
        let visualSearchUrl: string | undefined;
        let visualTotalResults: number | undefined;
        try {
          const nodeId = await nodeIdPromise;
          if (nodeId) {
            const visual = await fetchVisualSimilar(nodeId, maxResults);
            visualCandidates = visual.candidates;
            visualSearchUrl = visual.searchUrl;
            visualTotalResults = visual.totalResults;
          }
        } catch {
          // Visual search is best-effort — silently continue without it
        }

        // ── Generate HTML page ─────────────────────────────────────

        const pageData: SimilarPageData = {
          query: {
            objectNumber: args.objectNumber,
            title: artRow.title,
            creator: artRow.creator,
            date: queryDate,
            type: queryTypeMap.get(artRow.artId),
            iiifId: queryInfo?.iiifId ?? undefined,
            description: queryDescMap.get(artRow.artId),
            iconclassCodes: icResult?.queryNotations.map(n => ({ notation: n.notation, label: n.label })),
            lineageQualifiers: liResult?.queryLineage.map(q => ({
              label: q.qualifierLabel,
              aatUri: q.qualifierUri,
              creator: q.creatorLabel,
            })),
            depictedPersons: dpResult?.queryTerms.map(t => ({ label: t.label, ...(t.wikidataUri && { wikidataUri: t.wikidataUri }) })),
            depictedPlaces: dplResult?.queryTerms.map(t => ({ label: t.label, ...(t.wikidataUri && { wikidataUri: t.wikidataUri }) })),
            themes: thResult?.queryTerms.map(t => t.label),
            coProductionLabels: cpResult?.queryTerms.map(t => t.label),
            relatedObjectLabels: roResult?.queryTerms.map(t => t.label),
          },
          modes: {
            iconclass: icCandidates,
            lineage: liCandidates,
            description: descCandidates,
            ...(visualCandidates.length > 0 && { visual: visualCandidates }),
            ...(thCandidates.length > 0 && { theme: thCandidates }),
            ...(cpCandidates.length > 0 && { coProduction: cpCandidates }),
            ...(roCandidates.length > 0 && { relatedObject: roCandidates }),
            ...(dpCandidates.length > 0 && { depictedPerson: dpCandidates }),
            ...(dplCandidates.length > 0 && { depictedPlace: dplCandidates }),
          },
          poolThreshold: 4,
          generatedAt: new Date().toISOString().slice(0, 16).replace("T", " "),
          ...(visualSearchUrl && { visualSearchUrl }),
          ...(visualTotalResults && { visualTotalResults }),
        };

        const html = generateSimilarHtml(pageData);

        // Build response URL or file path
        let pageLocation: string;
        const pageUUID = randomUUID();
        if (publicBaseUrl) {
          // HTTP mode — store in memory, serve at /similar/:uuid
          similarPages.set(pageUUID, { html, lastAccess: Date.now() });
          pageLocation = `${publicBaseUrl}/similar/${pageUUID}`;
        } else {
          // stdio mode — write to OS temp directory (no HTTP server to serve from)
          const filePath = path.join(os.tmpdir(), `rijksmuseum-similar-${pageUUID}.html`);
          fs.writeFileSync(filePath, html, "utf-8");
          similarTempFiles.set(filePath, Date.now());
          pageLocation = filePath;
        }

        // Summary counts
        const counts = [
          ...(visualCandidates.length > 0 ? [`Visual: ${visualCandidates.length}`] : []),
          `Co-Production: ${cpCandidates.length}`,
          `Related: ${roCandidates.length}`,
          `Lineage: ${liCandidates.length}`,
          `Iconclass: ${icCandidates.length}`,
          `Description: ${descCandidates.length}`,
          `Theme: ${thCandidates.length}`,
          `Person: ${dpCandidates.length}`,
          `Place: ${dplCandidates.length}`,
        ];
        const poolThreshold = pageData.poolThreshold;
        // Count pooled entries
        const allObjNums = new Map<string, number>();
        for (const mode of [visualCandidates, icCandidates, liCandidates, descCandidates, thCandidates, cpCandidates, roCandidates, dpCandidates, dplCandidates]) {
          for (const c of mode) {
            allObjNums.set(c.objectNumber, (allObjNums.get(c.objectNumber) ?? 0) + 1);
          }
        }
        const pooledN = [...allObjNums.values()].filter(n => n >= poolThreshold).length;

        const textLines = [
          `Similar to "${artRow.title}" (${args.objectNumber})`,
          counts.join(" | ") + ` | Pooled (${poolThreshold}+): ${pooledN}`,
          "",
          pageLocation,
        ];

        return { content: [{ type: "text" as const, text: textLines.join("\n") }] };
      })
    );
  }

  // ── semantic_search ──────────────────────────────────────────────

  if (embeddingsDb?.available && embeddingModel?.available) {
    server.registerTool(
      "semantic_search",
      {
        title: "Semantic Search",
        annotations: ANN_READ_CLOSED,
        description:
          "Use when the user has a free-text concept ('solitude', 'industrial revolution', 'maritime trade', 'vanitas symbolism') and no specific filter criteria. " +
          "Returns artworks ranked by Dutch-description embedding similarity to the query, with source text for grounding — " +
          "use that text to explain why results are relevant or to flag false positives.\n\n" +
          "Not for queries expressible as structured metadata (specific artists, dates, places, materials) — use search_artwork for those. " +
          "Not for artwork-to-artwork similarity — use find_similar with an objectNumber.\n\n" +
          "Best for concepts that resist structured metadata: atmospheric qualities ('sense of loneliness'), compositional descriptions " +
          "('artist gazing directly at the viewer'), art-historical concepts ('cultural exchange under VOC trade'), or cross-language queries. " +
          "Results are most reliable when the Rijksmuseum's curatorial narrative texts discuss the relevant concept explicitly; " +
          "purely emotional or stylistic concepts (e.g. chiaroscuro, desolation) may yield lower precision because catalogue descriptions " +
          "often do not use that language.\n\n" +
          "Filter notes: supports pre-filtering by subject, depictedPerson, depictedPlace, productionPlace, collectionSet, aboutActor, iconclass, and imageAvailable " +
          "in addition to type, material, technique, creator, and creationDate. " +
          "Use type: 'painting' to restrict to the paintings collection. Do NOT use technique: 'painting' — it matches painted decoration on any object type " +
          "(ceramics, textiles, frames) and will return unexpected results.\n\n" +
          "Painting queries — two-step pattern: paintings are underrepresented (prints and drawings outnumber them ~77:1). " +
          "For queries where paintings are the expected result type, ALWAYS combine semantic_search with a follow-up " +
          "search_artwork(type: 'painting', subject: …) or search_artwork(type: 'painting', creator: …) — do not wait to observe skew, " +
          "as the absence of key works is not visible in the returned results.\n\n" +
          "Multilingual: queries in Dutch, German, French and other languages are supported but may benefit from a wider result window " +
          "or English reformulation if canonical works are missing.",
        inputSchema: z.object({
          query: z.string().describe("Natural language concept query (e.g. 'winter landscape with ice skating')"),
          type: stringOrArray().optional().describe("Filter by object type (e.g. 'painting', 'print')."),
          material: stringOrArray().optional().describe("Filter by material (e.g. 'canvas', 'paper')."),
          technique: stringOrArray().optional().describe("Filter by technique (e.g. 'etching', 'oil painting')."),
          creationDate: optStr().optional().describe("Filter by date — exact year ('1642') or wildcard ('16*')"),
          dateMatch: z.preprocess(stripNull,
            z.enum(["overlaps", "within", "midpoint"]).optional(),
          ).describe("Date matching mode — see search_artwork for details."),
          creator: stringOrArray().optional().describe("Filter by artist name."),
          subject: stringOrArray().optional().describe("Pre-filter by subject before semantic ranking."),
          iconclass: stringOrArray().optional().describe("Pre-filter by Iconclass notation before semantic ranking."),
          depictedPerson: stringOrArray().optional().describe("Pre-filter by depicted person before semantic ranking."),
          depictedPlace: stringOrArray().optional().describe("Pre-filter by depicted place before semantic ranking."),
          productionPlace: stringOrArray().optional().describe("Pre-filter by production place before semantic ranking."),
          collectionSet: stringOrArray().optional().describe("Pre-filter by collection set before semantic ranking."),
          aboutActor: optStr().optional().describe("Pre-filter by person (depicted or creator) before semantic ranking"),
          imageAvailable: z.boolean().optional().describe("Pre-filter to artworks with images"),
          maxResults: z.number().int().min(1).max(TOOL_LIMITS.semantic_search.max).default(TOOL_LIMITS.semantic_search.default).optional()
            .describe("Number of results to return (default 15). Similarity scores plateau after ~15 results; request more only if needed."),
          offset: z.number().int().min(0).default(0).optional()
            .describe("Skip this many results (for pagination). Use with maxResults."),
        }).strict(),
        ...withOutputSchema(SemanticSearchOutput),
      },
      withLogging("semantic_search", async (args) => {
        const maxResults = args.maxResults ?? TOOL_LIMITS.semantic_search.default;
        const userOffset = args.offset ?? 0;
        const fetchLimit = maxResults + userOffset;

        // 1. Embed query text
        const queryVec = await embeddingModel!.embed(args.query);

        // 2. Choose search path based on filters
        const filterParams: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(args)) {
          if (val !== undefined && FILTER_ART_IDS_KEYS.has(key)) {
            filterParams[key] = val;
          }
        }
        const hasFilters = Object.keys(filterParams).length > 0;
        let candidates: SemanticSearchResult[];
        let filtersApplied = false;
        const warnings: string[] = [];

        if (hasFilters && vocabDb?.available) {
          // FILTERED PATH: pre-filter via vocab DB, then distance-rank
          const candidateArtIds = vocabDb.filterArtIds(filterParams);
          if (candidateArtIds === null) {
            // No effective filters — fall back to pure KNN
            candidates = embeddingsDb!.search(queryVec, fetchLimit);
            warnings.push("Metadata filters ignored: vocabulary DB does not support filtered search. Results ranked by semantic similarity only.");
          } else if (candidateArtIds.length === 0) {
            const emptyData: InferOutput<typeof SemanticSearchOutput> = {
              searchMode: "semantic+filtered", query: args.query, returnedCount: 0, results: [],
              warnings: ["No artworks match the specified filters."],
            };
            return structuredResponse(
              emptyData,
              `0 semantic matches for "${args.query}" (no filter matches)`
            );
          } else {
            const filtered = embeddingsDb!.searchFiltered(queryVec, candidateArtIds, fetchLimit);
            candidates = filtered.results;
            filtersApplied = true;
            if (filtered.warning) warnings.push(filtered.warning);
          }
        } else {
          // PURE KNN PATH: vec0 virtual table
          candidates = embeddingsDb!.search(queryVec, fetchLimit);
          if (hasFilters) {
            warnings.push("Metadata filters ignored: vocabulary DB is not available. Results ranked by semantic similarity only.");
          }
        }

        // Apply offset + truncate to user's requested page
        if (userOffset > 0) candidates.splice(0, userOffset);
        if (candidates.length > maxResults) candidates.splice(maxResults);

        // 3. Batch-resolve metadata from vocab DB (single query, not per-result)
        const objectNumbers = candidates.map(c => c.objectNumber);
        const typeMap = vocabDb?.available ? vocabDb.lookupTypes(objectNumbers) : new Map<string, string>();

        // 4. Reconstruct source text for all results (grounding context)
        const allArtIds = candidates.map(c => c.artId);
        const sourceTextMap = vocabDb?.available
          ? vocabDb.reconstructSourceText(allArtIds)
          : new Map<number, string>();

        // Batch-resolve artwork metadata (single chunked query instead of N point lookups)
        const metaMap = vocabDb?.available
          ? vocabDb.batchLookupByArtId(allArtIds)
          : new Map<number, ArtworkMeta>();

        const results = candidates.map((c, i) => {
          const similarity = Math.round((1 - c.distance) * 1000) / 1000;

          const meta = metaMap.get(c.artId);
          const title = meta?.title || "";
          const creator = meta?.creator || "";
          const date = meta ? formatDateRange(meta.dateEarliest, meta.dateLatest) : undefined;

          return {
            rank: i + 1,
            objectNumber: c.objectNumber,
            title,
            creator,
            ...(date && { date }),
            ...(typeMap.has(c.objectNumber) && { type: typeMap.get(c.objectNumber) }),
            similarityScore: similarity,
            sourceText: sourceTextMap.get(c.artId),
            url: `https://www.rijksmuseum.nl/en/collection/${c.objectNumber}`,
          };
        });

        // 5. Build text channel
        const mode = filtersApplied ? "semantic+filtered" : "semantic";
        const header = `${results.length} semantic matches for "${args.query}" (${mode} mode)`;

        const resultLines = results.map((r, i) => {
          const oneLiner = formatSearchLine(r, i) + `  [${r.similarityScore.toFixed(2)}]`;
          const sourceText = r.sourceText;
          return sourceText ? `${oneLiner}\n   ${sourceText}` : oneLiner;
        });

        const textParts = [header];
        if (resultLines.length) textParts.push("\n" + resultLines.join("\n\n"));

        // Detect component-record clustering (sketchbook folios, album pages, etc.)
        const clusterNote = detectComponentClustering(results.map(r => r.objectNumber));
        if (clusterNote) warnings.push(clusterNote);

        // 6. Return dual-channel response
        const data: InferOutput<typeof SemanticSearchOutput> = {
          searchMode: mode,
          query: args.query,
          returnedCount: results.length,
          results,
          ...(warnings.length > 0 && { warnings }),
        };
        if (warnings.length) textParts.push("\n[WARNING] " + warnings.join("\n[WARNING] "));
        return structuredResponse(data, textParts.join("\n"));
      })
    );
  }
}

// ─── Resources ──────────────────────────────────────────────────────

function registerResources(
  server: McpServer,
): void {
  // Resources registered by registerAppViewerResource() only; others converted to prompts.
  void server;
}

// ─── MCP App Resource ────────────────────────────────────────────────

const VIEWER_FALLBACK_HTML = `<!DOCTYPE html>
<html><head><title>Artwork Viewer</title></head>
<body style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;">
<div style="text-align:center;color:#666;">
<h1>Viewer Not Built</h1><p>Run <code>npm run build:ui</code> to build the viewer.</p>
</div></body></html>`;

function loadViewerHtml(): string {
  const htmlPath = path.join(__dirname, "..", "dist", "apps", "index.html");
  try {
    return fs.readFileSync(htmlPath, "utf-8");
  } catch {
    return VIEWER_FALLBACK_HTML;
  }
}

// Single source of truth for the viewer's UI resource metadata. Declared both
// on the resources/list entry (so hosts can review CSP/permissions at
// connection time) and on the resources/read content item (the authoritative
// copy — content-item _meta.ui takes precedence per the MCP Apps spec). The
// bundle is a self-contained single file (vite-plugin-singlefile), so the only
// external origin is the IIIF image server: tiles load as <img> (img-src →
// resourceDomains) and info.json via fetch (connect-src → connectDomains).
const ARTWORK_VIEWER_UI_META = {
  csp: {
    resourceDomains: ["https://iiif.micr.io"],
    connectDomains: ["https://iiif.micr.io"],
  },
  permissions: {
    clipboardWrite: {},
  },
  prefersBorder: false,
} as const;

function registerAppViewerResource(server: McpServer): void {
  registerAppResource(
    server,
    "Rijksmuseum Artwork Viewer",
    ARTWORK_VIEWER_RESOURCE_URI,
    {
      description:
        "Interactive IIIF deep-zoom viewer for Rijksmuseum artworks",
      mimeType: RESOURCE_MIME_TYPE,
      _meta: { ui: ARTWORK_VIEWER_UI_META },
    },
    async () => ({
      contents: [
        {
          uri: ARTWORK_VIEWER_RESOURCE_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: loadViewerHtml(),
          _meta: { ui: ARTWORK_VIEWER_UI_META },
        },
      ],
    })
  );
}

// ─── Prompts ────────────────────────────────────────────────────────

function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "generate-artist-timeline",
    {
      title: "Artist Timeline",
      description:
        "Generate a chronological timeline of an artist's works in the collection.",
      argsSchema: {
        artist: z.string().describe("Name of the artist"),
        maxWorks: z
          .string()
          .optional()
          .describe(`Maximum number of works to include (1-${TOOL_LIMITS.search_artwork.max}, default: ${TOOL_LIMITS.search_artwork.default})`),
      },
    },
    async (args) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Create a visual timeline showing the chronological progression of ${args.artist}'s most notable works` +
              `${args.maxWorks ? ` (limited to ${args.maxWorks} works)` : ""}.\n\n` +
              `Use search_artwork with creator="${args.artist}"` +
              `${args.maxWorks ? ` and maxResults=${args.maxWorks}` : ""} to get the data, then sort by date.\n\n` +
              `Note: search returns at most ${TOOL_LIMITS.search_artwork.max} works. For prolific artists, this is a small sample of their collection.\n\n` +
              `For each work, include:\n` +
              `- Year of creation\n` +
              `- Title of the work\n` +
              `- A brief description of its significance\n\n` +
              `Format as a visually appealing chronological progression using markdown.`,
          },
        },
      ],
    })
  );

  server.registerPrompt(
    "generate-session-trace",
    {
      title: "Session Debug Trace",
      description:
        "Developer Feedback: Creates a record of interactions between the AI assistant " +
        "and the rijksmuseum-mcp+ server for debugging purposes.",
      argsSchema: {
        description: z
          .string()
          .optional()
          .describe("Optional: brief description of what you were trying to do in this session"),
      },
    },
    async (args) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Review all tool calls made to the rijksmuseum-mcp+ server during this conversation and output a debug trace.\n\n` +
              (args.description
                ? `Session context: ${args.description}\n\n`
                : "") +
              `**Privacy:** Include ONLY tool calls made to this MCP server and client-side tool discovery calls (e.g. tool_search/ToolSearch) that loaded its tools. ` +
              `Do NOT include any user messages, your own reasoning, or any other conversation content — ` +
              `the user may have discussed private topics earlier in this conversation that must not appear in the trace. ` +
              `The trace must contain nothing beyond the tool call data.\n\n` +
              `**Output format:** Create a downloadable markdown artifact. ` +
              `The file should be named \`session-trace-YYYY-MM-DD.md\` using today's date.\n\n` +
              `The markdown file must contain:\n` +
              `1. A heading: \`# Session Trace — YYYY-MM-DD\`\n` +
              (args.description
                ? `2. A line: \`Session: ${args.description}\`\n`
                : "") +
              `${args.description ? "3" : "2"}. A fenced code block (language: jsonl) with one JSON object per line.\n\n` +
              `Each JSONL line must have these fields:\n` +
              `- "timestamp": ISO 8601 UTC (use sequential timestamps 1 second apart)\n` +
              `- "tool": the bare tool name without any server prefix — e.g. "search_artwork", not "Rijksmuseum:search_artwork"\n` +
              `- "input": the arguments object passed to the tool. Omit keys whose value was null — do not include them.\n` +
              `- "ok": true if the tool succeeded, false if it returned an error\n` +
              `- "ms": 0 (latency is not available from conversation context)\n` +
              `- "result_summary": 1–2 sentence summary of the result\n\n` +
              `**result_summary rules:**\n` +
              `- For search/semantic_search: include totalResults and first 3 object numbers\n` +
              `- For artwork details: include title, creator, date\n` +
              `- For inspect_artwork_image: note region and that image was returned (omit base64 data entirely)\n` +
              `- For errors: include the error message\n` +
              `- For all others: summarize the key information returned\n\n` +
              `After the artifact, politely ask the user to review the trace before sharing it, ` +
              `to make sure it contains only the tool call data and nothing personal.`,
          },
        },
      ],
    })
  );

}
