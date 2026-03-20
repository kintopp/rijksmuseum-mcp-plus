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
import { VocabularyDb, FILTER_ART_IDS_KEYS, formatDateRange, pluralize, type DepictedSimilarResult, type ProvenanceSearchParams } from "./api/VocabularyDb.js";
import { IconclassDb } from "./api/IconclassDb.js";
import { EmbeddingsDb, type SemanticSearchResult } from "./api/EmbeddingsDb.js";
import { EmbeddingModel } from "./api/EmbeddingModel.js";
import { UsageStats } from "./utils/UsageStats.js";
import axios from "axios";
import { generateSimilarHtml, type SimilarCandidate, type SimilarPageData } from "./similarHtml.js";
import type { SearchParams, LinkedArtObject } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ARTWORK_VIEWER_RESOURCE_URI = "ui://rijksmuseum/artwork-viewer.html";

/** Shared limits for maxResults across search_artwork, lookup_iconclass, and semantic_search. */
const RESULTS_DEFAULT = 25;
const RESULTS_MAX = 50;

/** Params that narrow results but are too broad to stand alone as the only filter. */
const MODIFIER_KEYS = new Set(["imageAvailable", "creatorGender", "creatorBornAfter", "creatorBornBefore", "expandPlaceHierarchy"]);

/** Available facet dimensions for search_artwork. Single source of truth for preprocess + z.enum. */
const FACET_DIMENSIONS = ["type", "material", "technique", "century", "creatorGender", "rights", "imageAvailable"] as const;

/** Preprocess: strip JSON null / "null" string / "" → undefined BEFORE Zod validates.
 *  claude.ai sends actual JSON null for every optional string param the LLM omits.
 *  z.string().optional() rejects null (only accepts string | undefined), so the
 *  null must be converted before type-checking.  Using factory functions (not shared
 *  constants) so each field gets a unique Zod instance — zod-to-json-schema deduplicates
 *  by identity, and shared instances caused $ref pointers that claude.ai cannot resolve. */
const stripNull = (v: unknown) =>
  (v === null || v === undefined || v === "null" || v === "") ? undefined : v;

/** Normalize null/arrays into string | string[] | undefined. */
function normalizeStringOrArray(v: unknown): string | string[] | undefined {
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
  return String(v);
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

function jsonResponse(data: unknown): ToolResponse {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

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
function formatSearchLine(r: { objectNumber: string; title: string; creator: string; date?: string; type?: string; url?: string; nearestPlace?: string; distance_km?: number }, i: number): string {
  let line = `${i + 1}. ${r.objectNumber}`;
  if (r.type) line += ` | ${r.type}`;
  if (r.date) line += ` | ${r.date}`;
  line += ` | "${r.title}"`;
  if (r.creator) line += ` — ${r.creator}`;
  if (r.nearestPlace) line += ` [${r.nearestPlace}, ${r.distance_km?.toFixed(1)}km]`;
  if (r.url) line += ` ${r.url}`;
  return line;
}

/** Format faceted counts as a compact "Narrow by:" block for LLM content. */
function formatFacets(facets: Record<string, Array<{ label: string; count: number }>>): string {
  const lines: string[] = ["Narrow by:"];
  for (const [dim, entries] of Object.entries(facets)) {
    const dimLabel = dim.charAt(0).toUpperCase() + dim.slice(1);
    const items = entries.map(e => `${e.label} (${e.count.toLocaleString()})`).join(", ");
    lines.push(`  ${dimLabel}: ${items}`);
  }
  return lines.join("\n");
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

/** Resolve an objectNumber to the Rijksmuseum website's objectNodeId (hex hash).
 *  Returns null if the artwork is not in the website search index. */
async function resolveObjectNodeId(objectNumber: string): Promise<string | null> {
  try {
    const resp = await axios.get("https://www.rijksmuseum.nl/api/v1/collection/search", {
      params: { query: objectNumber, language: "en", pageSize: 5 },
      timeout: 5000,
    });
    const objs: VisualSearchArtObject[] = resp.data?.artObjects ?? [];
    const match = objs.find(o => o.objectNumber === objectNumber);
    return match?.objectNodeId ?? null;
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

    return {
      candidates,
      totalResults: hasMore ? maxResults + 1 : objs.length, // indicate "more available"
      searchUrl,
    };
  } catch {
    return { candidates: [], totalResults: 0, searchUrl };
  }
}

/** Format artwork detail as a compact key-value summary for LLM content (Tier 3). */
function formatDetailSummary(d: InferOutput<typeof ArtworkDetailOutput>): string {
  const lines: string[] = [];
  lines.push(`${d.objectNumber} — ${d.title}`);
  lines.push(`${d.creator}${d.date ? `, ${d.date}` : ""}`);
  if (d.techniqueStatement || d.dimensionStatement) {
    lines.push([d.techniqueStatement, d.dimensionStatement].filter(Boolean).join(", "));
  }
  if (d.location) lines.push(d.location);
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
    const primaryBio = d.production[0]?.personInfo?.bio;
    if (primaryBio) lines.push(`Bio: ${primaryBio}`);
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
      const priceFmt = last.price ? `${last.price.currency} ${last.price.amount?.toLocaleString("en") ?? last.price.text}` : null;
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

  if (d.bibliographyCount) lines.push(`\nBibliography: ${d.bibliographyCount} entries`);
  lines.push(`URL: ${d.url}`);

  return lines.join("\n");
}

/** Format a bibliography entry as a compact one-liner (Tier 2). */
function formatBibliographyLine(e: { citation: string; pages?: string }, i: number): string {
  let line = `${i + 1}. ${truncate(e.citation, 100)}`;
  if (e.pages) line += ` ${e.pages}`;
  return line;
}

/** Format a curated set as a compact one-liner (Tier 2). */
function formatSetLine(s: { setSpec: string; name: string }, i: number): string {
  return `${i + 1}. ${s.setSpec} | ${s.name}`;
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

/** Format an OAI-PMH paginated list result into a tool response. */
function paginatedResponse(
  result: { records: unknown[]; completeListSize: number | null; resumptionToken: string | null },
  maxResults: number,
  totalLabel: string,
  toolName: string,
  extra?: Record<string, unknown>,
  formatLine?: (record: Record<string, unknown>, index: number) => string
): ToolResponse | StructuredToolResponse {
  const records = result.records.slice(0, maxResults);

  const data: Record<string, unknown> = {
    ...(result.completeListSize != null ? { [totalLabel]: result.completeListSize } : {}),
    returnedCount: records.length,
    ...extra,
    records,
    ...(result.resumptionToken
      ? {
          resumptionToken: result.resumptionToken,
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
    if (result.resumptionToken) parts.push("[resumptionToken available for next page]");
    return structuredResponse(data, parts.join("\n"));
  }
  return structuredResponse(data);
}

/**
 * Register all tools, resources, and prompts on the given McpServer.
 * `httpPort` is provided when running in HTTP mode so viewer URLs can be generated.
 */
export function registerAll(
  server: McpServer,
  apiClient: RijksmuseumApiClient,
  oaiClient: OaiPmhClient,
  vocabDb: VocabularyDb | null,
  iconclassDb: IconclassDb | null,
  embeddingsDb: EmbeddingsDb | null,
  embeddingModel: EmbeddingModel | null,
  httpPort?: number,
  stats?: UsageStats
): void {
  registerTools(server, apiClient, oaiClient, vocabDb, iconclassDb, embeddingsDb, embeddingModel, httpPort, createLogger(stats));
  registerResources(server);
  registerAppViewerResource(server);
  registerPrompts(server, apiClient);

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
    id: z.string().optional().describe("Linked Art URI (present only when vocabulary DB is unavailable)."),
    objectNumber: z.string(),
    title: z.string(),
    creator: z.string(),
    date: z.string().optional(),
    type: z.string().optional(),
    url: z.string(),
    nearestPlace: z.string().optional(),
    distance_km: z.number().optional(),
  })).optional().describe("Artwork summaries. Absent when compact=true."),
  ids: z.array(z.string()).optional().describe("Object numbers (compact mode)."),
  source: z.enum(["vocabulary", "search_api"]).optional(),
  referencePlace: z.string().optional(),
  facets: z.record(z.string(), z.array(z.object({
    label: z.string(),
    count: z.number().int(),
  }))).optional().describe("Top-5 counts per dimension when results are truncated and facets=true."),
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
  url: z.string(),
  // ArtworkDetail fields
  description: z.string().nullable(),
  techniqueStatement: z.string().nullable(),
  dimensionStatement: z.string().nullable(),
  provenance: z.string().nullable(),
  creditLine: z.string().nullable(),
  inscriptions: z.array(z.string()),
  location: z.string().nullable(),
  collectionSets: z.array(z.string()),
  externalIds: z.record(z.string()),
  // Enriched Group A
  titles: z.array(z.object({
    title: z.string(),
    language: z.enum(["en", "nl", "other"]),
    qualifier: z.enum(["brief", "full", "other"]),
  })),
  curatorialNarrative: z.object({ en: z.string().nullable(), nl: z.string().nullable() }),
  license: z.string().nullable(),
  webPage: z.string().nullable(),
  dimensions: z.array(z.object({
    type: z.string(), value: z.union([z.number(), z.string()]), unit: z.string(), note: z.string().nullable(),
  })),
  relatedObjects: z.array(z.object({
    relationship: z.string(), objectUri: z.string(),
  })),
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
      bio: z.string().nullable(),
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
  bibliographyCount: z.number().int(),
  provenanceChain: z.array(z.object({
    sequence: z.number().int(),
    rawText: z.string(),
    gap: z.boolean(),
    party: z.object({
      name: z.string(),
      dates: z.string().nullable(),
      uncertain: z.boolean(),
      role: z.string().nullable(),
    }).nullable(),
    transferType: z.enum(["sale", "inheritance", "bequest", "commission", "purchase",
      "confiscation", "recuperation", "loan", "transfer", "collection", "gift",
      "auction", "exchange", "deposit", "seizure", "restitution", "donation", "inventory", "unknown"]),
    date: z.object({
      text: z.string(),
      year: z.number().int().nullable(),
      approximate: z.boolean(),
      qualifier: z.enum(["before", "after", "circa"]).nullable(),
    }).nullable(),
    location: z.string().nullable(),
    price: z.object({
      text: z.string(),
      amount: z.number().nullable(),
      currency: z.string(),
    }).nullable(),
    saleDetails: z.string().nullable(),
    citations: z.array(z.object({ text: z.string() })),
    uncertain: z.boolean(),
  })).nullable(),
  error: z.string().optional(),
};

const BibliographyOutput = {
  objectNumber: z.string(),
  total: z.number().int(),
  entries: z.array(z.object({
    sequence: z.number().int().nullable(),
    citation: z.string(),
    publicationUri: z.string().optional(),
    pages: z.string().optional(),
    isbn: z.union([z.string(), z.array(z.string())]).optional(),
    worldcatUri: z.string().optional(),
    libraryUrl: z.string().optional(),
  })),
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
  fullUrl: z.string().optional().describe("Direct IIIF image URL (full resolution). For programmatic use — not rendered inline."),
  iiifInfoUrl: z.string().optional(),
  viewerUrl: z.string().optional(),
  viewUUID: z.string().optional().describe("Viewer session ID for use with navigate_viewer."),
  error: z.string().optional(),
};

const InspectImageOutput = {
  objectNumber: z.string(),
  region: z.string(),
  requestedSize: z.number().int(),
  nativeWidth: z.number().int().optional(),
  nativeHeight: z.number().int().optional(),
  rotation: z.number().int(),
  quality: z.string(),
  fetchTimeMs: z.number().int().optional().describe("Time spent fetching from IIIF server (ms)"),
  viewUUID: z.string().optional().describe("Active viewer session ID (if a viewer is open for this artwork)"),
  viewerNavigated: z.boolean().optional().describe("Whether the viewer was auto-navigated to the inspected region"),
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
  ...PaginatedBase,
  totalInSet: z.number().int().optional(),
};

const RecentChangesOutput = {
  ...PaginatedBase,
  totalChanges: z.number().int().optional(),
  identifiersOnly: z.boolean().optional(),
};

/** Factory — unique Zod instances per call to prevent $ref deduplication. */
const IconclassEntryShape = () => z.object({
  notation: z.string(),
  text: z.string(),
  path: z.array(z.object({ notation: z.string(), text: z.string() })),
  children: z.array(z.string()),
  refs: z.array(z.string()),
  rijksCount: z.number().int(),
  keywords: z.array(z.string()),
});

const LookupIconclassOutput = {
  query: z.string().optional(),
  totalResults: z.number().int().optional(),
  notation: z.string().optional(),
  entry: IconclassEntryShape().optional(),
  subtree: z.array(IconclassEntryShape()).optional(),
  results: z.array(IconclassEntryShape().extend({ distance: z.number().optional() })).optional(),
  countsAsOf: z.string().nullable().optional()
    .describe("Date when rijksCount values were computed (ISO 8601)."),
  error: z.string().optional(),
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

const FindSimilarOutput = {
  mode: z.enum(["iconclass", "lineage", "depicted_person", "description"]),
  queryObjectNumber: z.string(),
  queryTitle: z.string(),
  querySignals: z.array(z.object({
    label: z.string(),
    notation: z.string().optional(),
    depth: z.number().int().optional(),
    strength: z.number().optional(),
  })).describe("Query artwork's Iconclass notations (iconclass mode) or lineage pairs (lineage mode)."),
  returnedCount: z.number().int(),
  results: z.array(z.object({
    rank: z.number().int(),
    objectNumber: z.string(),
    title: z.string(),
    creator: z.string(),
    date: z.string().optional(),
    type: z.string().optional(),
    score: z.number(),
    sharedMotifs: z.array(z.object({
      notation: z.string(),
      label: z.string(),
      weight: z.number(),
    })).optional().describe("Shared Iconclass notations (iconclass mode only)."),
    sharedLineage: z.array(z.object({
      qualifierLabel: z.string(),
      creatorLabel: z.string(),
      strength: z.number(),
    })).optional().describe("Shared (qualifier, creator) pairs (lineage mode only)."),
    sharedPersons: z.array(z.object({
      label: z.string(),
      weight: z.number(),
    })).optional().describe("Shared depicted persons (depicted_person mode only)."),
    descriptionExcerpt: z.string().optional().describe("Candidate's catalogue description in Dutch (description mode only). Use these to re-rank: discard candidates whose descriptions are similar only due to generic structural phrases."),
    url: z.string(),
  })),
  queryDescription: z.string().optional().describe("Query artwork's catalogue description (description mode only)."),
  rerankerNote: z.string().optional().describe("Instructions for LLM re-ranking (description mode only)."),
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
  })),
  error: z.string().optional(),
};

// ─── Shared IIIF region validation ───────────────────────────────────

const IIIF_REGION_RE = /^(full|square|\d+,\d+,\d+,\d+|pct:[0-9.]+,[0-9.]+,[0-9.]+,[0-9.]+)$/;

// ─── Viewer command queue (module-scoped — survives across HTTP requests) ─

interface ViewerCommand {
  action: "navigate" | "add_overlay" | "clear_overlays";
  region?: string;
  relativeTo?: string;
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
const viewerQueues = new Map<string, ViewerQueue>();

// Sweep stale queues every 60s (viewers that disconnected without teardown)
setInterval(() => {
  const now = Date.now();
  for (const [id, q] of viewerQueues) {
    if (now - q.lastAccess > 1_800_000) viewerQueues.delete(id);
  }
}, 60_000).unref();

/** Module-scope storage for generated similar-artworks HTML pages. TTL 30 min. */
export const similarPages = new Map<string, { html: string; lastAccess: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [id, page] of similarPages) {
    if (now - page.lastAccess > 1_800_000) similarPages.delete(id);
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
/** Project crop-local coordinates to full-image space. Both must be pct: format. */
export function projectToFullImage(local: string, relativeTo: string): string | null {
  const l = parsePctRegion(local);
  const o = parsePctRegion(relativeTo);
  if (!l || !o) return null;
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
  iconclassDb: IconclassDb | null,
  embeddingsDb: EmbeddingsDb | null,
  embeddingModel: EmbeddingModel | null,
  httpPort: number | undefined,
  withLogging: ReturnType<typeof createLogger>
): void {
  // ── search_artwork ──────────────────────────────────────────────

  // Vocabulary-backed search params (require vocabulary DB)
  const vocabAvailable = vocabDb?.available ?? false;
  // All search parameters that the vocab DB handles.
  // With vocab-DB-only routing (v0.19), every parameter routes through the vocab DB.
  const vocabParamKeys = [
    "subject", "iconclass", "depictedPerson", "depictedPlace", "productionPlace",
    "birthPlace", "deathPlace", "profession", "collectionSet", "license",
    // Tier 2 (vocabulary DB v1.0+)
    "description", "inscription", "provenance", "creditLine", "curatorialNarrative", "productionRole", "attributionQualifier",
    "minHeight", "maxHeight", "minWidth", "maxWidth",
    "nearPlace", "nearLat", "nearLon",
    "title",
    "material", "technique", "type", "creator",
    "creationDate",
    "imageAvailable",
    "aboutActor",
    // Creator demographic filters (require person enrichment)
    "creatorGender", "creatorBornAfter", "creatorBornBefore",
    // Place hierarchy
    "expandPlaceHierarchy",
  ] as const;
  // nearPlaceRadius excluded from routing key check: its Zod default (25) would trigger
  // on every query. Forwarded separately.
  const allVocabKeys = [...vocabParamKeys, "nearPlaceRadius", "dateMatch"] as const;

  server.registerTool(
    "search_artwork",
    {
      title: "Search Artwork",
      description:
        "Search the Rijksmuseum collection. Returns artwork summaries with titles, creators, and dates. " +
        "Every response includes totalResults (exact count of all matching artworks, not just the returned page). " +
        "Use compact=true with facets=true for efficient counting and breakdowns (e.g. gender ratios by decade). " +
        "Results are ranked by relevance when text search (description, title, etc.) or geographic proximity is used; " +
        "otherwise results are ordered by importance (image availability, curatorial attention, metadata richness). " +
        "For concept-ranked results, use semantic_search. " +
        "At least one search filter is required. " +
        "Use specific filters for best results — there is no general full-text search across all metadata fields. " +
        "For concept or thematic searches (e.g. 'winter landscape', 'smell', 'crucifixion'), " +
        "ALWAYS start with subject — it searches ~832K artworks tagged with structured Iconclass vocabulary " +
        "and has by far the highest recall for conceptual queries. " +
        "Use description for cataloguer observations (e.g. compositional details, specific motifs noted by specialists); " +
        "use curatorialNarrative for curatorial interpretation and art-historical context. " +
        "These three fields search different text corpora and can return complementary results. " +
        "For broader concept or theme discovery beyond structured vocabulary, use semantic_search — " +
        "but note that paintings are underrepresented there, so combine it with " +
        "search_artwork(type: 'painting', subject/creator: ...) for painting queries. " +
        "Array values are AND-combined (e.g. subject: ['landscape', 'seascape'] finds artworks with both subjects). " +
        "Each result includes an objectNumber for follow-up calls: " +
        "get_artwork_details (full metadata), get_artwork_bibliography (scholarly references), " +
        "or get_artwork_image (deep-zoom viewer — only when the user asks to see, show, or view an artwork; " +
        "do not open the viewer for list/count/summary requests)." +
        (vocabAvailable
          ? " All parameters can be freely combined with each other. " +
            "Vocabulary labels are bilingual (English and Dutch); try the Dutch term if English returns no results " +
            "(e.g. 'fotograaf' instead of 'photographer'). " +
            "For proximity search, use nearPlace with a place name, or nearLat/nearLon with coordinates for arbitrary locations. " +
            "For provenance analytics: use provenance parameter for collection-wide keyword counts (e.g. provenance='Führermuseum' returns totalResults=843). " +
            "Combine with facets for cross-tabulation. Use creditLine for acquisition channel analysis (e.g. 'gift', 'bequest', 'Vereniging Rembrandt')."
          : ""),
      inputSchema: z.object({
        query: optStr()
          .optional()
          .describe(
            "General search term — maps to title search in the vocabulary database (equivalent to the title parameter). For more targeted results, use the specific field parameters instead (creator, description, subject, etc.)"
          ),
        title: optStr()
          .optional()
          .describe("Search by artwork title, matching against all title variants (brief, full, former × EN/NL). Equivalent to query but explicit."),
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
                  "or use lookup_iconclass to find the canonical Iconclass notation code for more reliable matching. " +
                  "Also covers historical events using Dutch labels (e.g. 'Tweede Wereldoorlog', 'Tachtigjarige Oorlog'). " +
                  "Subject matching does not distinguish primary from incidental/decorative subjects — " +
                  "a mortar with an Annunciation relief will match 'Annunciation'. Combine with type (e.g. type: 'painting') to filter."
                ),
              iconclass: stringOrArray()
                .optional()
                .describe(
                  "Exact Iconclass notation code (e.g. '34B11' for dogs, '73D82' for Crucifixion). More precise than subject (exact code vs. label text) — use lookup_iconclass to discover codes by concept."
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
              birthPlace: stringOrArray()
                .optional()
                .describe(
                  "Search by artist's birth place (e.g. 'Amsterdam')."
                ),
              deathPlace: stringOrArray()
                .optional()
                .describe(
                  "Search by artist's death place (e.g. 'Paris')."
                ),
              profession: stringOrArray()
                .optional()
                .describe(
                  "Search by artist's profession (e.g. 'painter', 'draughtsman', 'sculptor')."
                ),
              collectionSet: stringOrArray()
                .optional()
                .describe(
                  "Search for artworks in curated collection sets by name (e.g. 'Rembrandt', 'Japanese'). " +
                  "Use list_curated_sets to discover available sets."
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
              provenance: optMinStr()
                .optional()
                .describe(
                  "Full-text search on provenance/ownership history (e.g. 'Six' for the Six collection). " +
                  "Exact word matching, no stemming."
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
                  "Filter by attribution qualifier: 'primary', 'attributed to', 'workshop of', " +
                  "'circle of', 'follower of', 'secondary', 'undetermined'. " +
                  "Combine with creator to narrow attribution (e.g. attributionQualifier: 'workshop of' + creator: 'Rembrandt')."
                ),
              creatorGender: optMinStr()
                .optional()
                .describe(
                  "Filter by creator gender: 'male' or 'female'. " +
                  "Coverage: ~64K of ~76K person entries have gender data. " +
                  "Cannot be used alone — combine with at least one other filter (e.g. type: 'painting', creationDate: '17*')."
                ),
              creatorBornAfter: z.preprocess(stripNull, z
                .number()
                .int()
                .optional()
                .describe(
                  "Filter to creators born in or after this year (e.g. 1800). " +
                  "Coverage: ~49K person entries have birth year data. " +
                  "Cannot be used alone — combine with at least one other filter."
                )),
              creatorBornBefore: z.preprocess(stripNull, z
                .number()
                .int()
                .optional()
                .describe(
                  "Filter to creators born in or before this year (e.g. 1700). " +
                  "Combine with creatorBornAfter for a range (e.g. born 1600–1700). " +
                  "Cannot be used alone — combine with at least one other filter."
                )),
              expandPlaceHierarchy: z.preprocess(stripNull, z
                .boolean()
                .optional()
                .describe(
                  "When true, place searches (productionPlace, depictedPlace, birthPlace, deathPlace) " +
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
          .max(RESULTS_MAX)
          .default(RESULTS_DEFAULT)
          .describe(`Maximum results to return (1-${RESULTS_MAX}, default ${RESULTS_DEFAULT}). All results include full metadata.`),
        facets: z.preprocess(
          (v) => {
            if (v === true) return [...FACET_DIMENSIONS];
            if (v === false || v === null || v === undefined) return undefined;
            return v;
          },
          z.array(z.enum(FACET_DIMENSIONS)).optional(),
        ).describe(
            "Facet dimensions to compute when results are truncated. " +
            "Pass an array of dimension names (e.g. [\"creatorGender\", \"rights\"]) to compute only those, " +
            "or true for all dimensions. " +
            `Available: ${FACET_DIMENSIONS.join(", ")}. ` +
            "Dimensions already filtered on are excluded automatically."
          ),
        compact: z
          .boolean()
          .default(false)
          .describe(
            "If true, returns only total count and IDs without resolving details (faster)."
          ),
        pageToken: optStr()
          .optional()
          .describe("Deprecated. Pagination is not supported in the current search backend. Use maxResults to control result count."),
      }).strict(),
      ...withOutputSchema(SearchResultOutput),
    },
    withLogging("search_artwork", async (args) => {
      const argsRecord = args as Record<string, unknown>;

      // Route ALL queries through vocab DB when available (v0.19 vocab-DB-only routing)
      if (vocabAvailable && vocabDb) {
        // At least one substantive filter required (prevent unfiltered full-collection scans).
        const hasAnyFilter = vocabParamKeys.some(k =>
            !MODIFIER_KEYS.has(k) && argsRecord[k] !== undefined
          ) || argsRecord["query"] !== undefined;
        if (!hasAnyFilter) {
          return errorResponse(
            "At least one search filter is required (creatorGender, creatorBornAfter/Before, imageAvailable, " +
            "and expandPlaceHierarchy are modifiers that cannot be used alone). " +
            "Add a filter like subject, creator, type, material, technique, depictedPerson, or creationDate. " +
            "For concept-based search, try semantic_search instead."
          );
        }

        const vocabArgs: Record<string, unknown> = { maxResults: args.maxResults };
        for (const k of allVocabKeys) {
          if (argsRecord[k] !== undefined) vocabArgs[k] = argsRecord[k];
        }
        if (args.facets) vocabArgs["facets"] = args.facets;
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
          if (compactResult.facets) textParts.push(formatFacets(compactResult.facets));
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

        const header = `${result.results.length} results` +
          (result.totalResults != null ? ` of ${result.totalResults} total` : '') +
          ` (vocabulary search)`;
        const textParts: string[] = [header];
        if (result.facets) textParts.push(formatFacets(result.facets));
        textParts.push(...result.results.map((r, i) => formatSearchLine(r, i)));
        const structured: InferOutput<typeof SearchResultOutput> = result;
        return structuredResponse(structured, textParts.join("\n"));
      }

      // Degraded fallback: use Search API when vocab DB is unavailable
      // Search API only accepts single strings — take first element from arrays
      const first = (v: unknown) => Array.isArray(v) ? v[0] as string : v as string | undefined;
      const searchArgs: SearchParams = {
        ...args,
        creator: first(args.creator),
        type: first(args.type),
        material: first(args.material),
        technique: first(args.technique),
      };
      const result = args.compact
        ? await api.searchCompact(searchArgs)
        : await api.searchAndResolve(searchArgs);

      // Enrich resolved results with object type from vocab DB (free batch lookup)
      if (!args.compact && "results" in result && vocabDb) {
        const typeMap = vocabDb.lookupTypes(result.results.map(r => r.objectNumber));
        for (const r of result.results) {
          if (!r.type) r.type = typeMap.get(r.objectNumber);
        }
      }

      // Hint when creator search returns 0 — the API is accent-sensitive
      if (result.totalResults === 0 && args.creator) {
        const withWarnings: InferOutput<typeof SearchResultOutput> = {
          ...result,
          warnings: [
            "No results found. The Rijksmuseum Search API is accent-sensitive for creator names " +
            "(e.g. 'Eugène Brands' not 'Eugene Brands'). Try the exact accented spelling.",
          ],
        };
        return structuredResponse(withWarnings, "0 results");
      }

      const resultCount = "results" in result ? result.results.length : (result.ids?.length ?? 0);
      const header = `${result.totalResults} results` +
        (args.creator ? ` for creator "${args.creator}"` : '') +
        (result.nextPageToken ? ` (page token: ${result.nextPageToken})` : '');
      const truncationNote = result.totalResults > resultCount && resultCount > 0
        ? "\nNote: results are not ranked by relevance. Add filters to narrow, or use semantic_search for concept-ranked results."
        : "";
      const lines = ("results" in result ? result.results : []).map((r, i) => formatSearchLine(r, i));
      if ("ids" in result && result.ids?.length && lines.length === 0) {
        lines.push(result.ids.join(", "));
      }
      const { nextPageToken, ...structured } = result;
      const apiData: InferOutput<typeof SearchResultOutput> = { ...structured, source: "search_api" as const };
      return structuredResponse(apiData, [header, ...lines].join("\n") + truncationNote);
    })
  );

  // ── get_artwork_details ─────────────────────────────────────────

  server.registerTool(
    "get_artwork_details",
    {
      title: "Get Artwork Details",
      description:
        "Get comprehensive details about a specific artwork by its object number (e.g. 'SK-C-5' for The Night Watch) " +
        "or by its Linked Art URI (e.g. from relatedObjects). Provide exactly one of objectNumber or uri. " +
        "Returns 24 metadata categories including titles, creator, date, description, curatorial narrative, " +
        "dimensions (text + structured), materials, object type, production details (with creator life dates, " +
        "gender, bio, and Wikidata ID where available), provenance, " +
        "credit line, inscriptions, license, related objects, collection sets, plus reference and location metadata. " +
        "Also reports the bibliography count — use get_artwork_bibliography for full citations. " +
        "The relatedObjects field contains Linked Art URIs — pass them as uri to get full details of related works. " +
        "Use this tool on vocabulary search results to check dates, dimensions, or other fields not available in the search response.",
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
      const count = (args.objectNumber ? 1 : 0) + (args.uri ? 1 : 0);
      if (count !== 1) throw new Error("Provide exactly one of objectNumber or uri.");
      let resolvedUri: string;
      let object: LinkedArtObject;
      if (args.objectNumber) {
        const found = await api.findByObjectNumber(args.objectNumber);
        resolvedUri = found.uri;
        object = found.object;
      } else {
        resolvedUri = args.uri!;
        object = await api.resolveObject(resolvedUri);
      }
      const detail: InferOutput<typeof ArtworkDetailOutput> = await api.toDetailEnriched(object, resolvedUri);
      // Enrich production entries with person info from vocab DB
      if (vocabDb?.available && detail.production.length > 0) {
        const idToParticipant = new Map(
          detail.production.flatMap(p => {
            const id = p.actorUri.split("/").pop();
            return id ? [[id, p] as const] : [];
          })
        );
        const personMap = vocabDb.lookupPersonInfo([...idToParticipant.keys()]);
        for (const [id, p] of idToParticipant) {
          const info = personMap.get(id);
          if (info) p.personInfo = info;
        }
      }
      return structuredResponse(detail, formatDetailSummary(detail));
    })
  );

  // ── get_artwork_bibliography ───────────────────────────────────

  server.registerTool(
    "get_artwork_bibliography",
    {
      title: "Get Artwork Bibliography",
      description:
        "Get bibliography and scholarly references for an artwork by its objectNumber " +
        "(from search_artwork, browse_set, get_recent_changes, or get_artwork_details). " +
        "By default returns a summary (total count + first 5 citations). " +
        "Set full=true to retrieve all citations (can be 100+ entries for major works — consider the context window).",
      inputSchema: z.object({
        objectNumber: z
          .string()
          .describe(
            "The object number of the artwork (e.g. 'SK-C-5')"
          ),
        full: z
          .boolean()
          .default(false)
          .describe(
            "If true, returns ALL bibliography entries (may be 100+). Default: first 5 entries with total count."
          ),
      }).strict(),
      ...withOutputSchema(BibliographyOutput),
    },
    withLogging("get_artwork_bibliography", async (args) => {
      const { object } = await api.findByObjectNumber(args.objectNumber);
      const result: InferOutput<typeof BibliographyOutput> = await api.getBibliography(object, {
        limit: args.full ? 0 : 5,
      });
      const header = `${result.objectNumber} — ${result.total} bibliography entries`;
      const lines = result.entries.map((e, i) => formatBibliographyLine(e, i));
      return structuredResponse(result, [header, ...lines].join("\n"));
    })
  );

  // ── get_artwork_image (MCP App with inline IIIF viewer) ────────

  registerAppTool(
    server,
    "get_artwork_image",
    {
      title: "Get Artwork Image",
      description:
        "View an artwork in high resolution with an interactive deep-zoom viewer (zoom, pan, rotate, flip). " +
        "Use ONLY when the user explicitly wants to see or view an artwork — " +
        "do not call this for list, summary, count, or text-only requests. " +
        "Not all artworks have images available. " +
        "Downloadable images are available from the artwork's collection page on rijksmuseum.nl. " +
        "Do not construct IIIF image URLs manually. " +
        "Note: this tool returns metadata and a viewer link, not the image bytes themselves. " +
        "IIIF image URLs cannot be fetched via web_fetch or curl — do not attempt to download the image. " +
        "To get the actual image bytes for visual analysis, use inspect_artwork_image instead.",
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
      // Resolve image info (fast path: 1 req) in parallel with object metadata (2 reqs).
      // Falls back to 4-step image chain when no cached IIIF ID or fast path fails.
      const cachedIiifId = vocabDb?.lookupIiifId(args.objectNumber) ?? null;
      const [fastImageInfo, { object }] = await Promise.all([
        cachedIiifId ? api.getImageInfoFast(cachedIiifId) : Promise.resolve(null),
        api.findByObjectNumber(args.objectNumber),
      ]);
      const resolvedImageInfo = fastImageInfo ?? await api.getImageInfo(object);

      if (!resolvedImageInfo) {
        const errorData: InferOutput<typeof ImageInfoOutput> = {
          objectNumber: args.objectNumber,
          error: "No image available for this artwork",
        };
        return structuredResponse(errorData, "No image available for this artwork");
      }

      const title = RijksmuseumApiClient.parseTitle(object);
      const objectNumber = RijksmuseumApiClient.parseObjectNumber(object);

      if (httpPort) {
        const baseUrl = process.env.PUBLIC_URL || `http://localhost:${httpPort}`;
        resolvedImageInfo.viewerUrl = `${baseUrl}/viewer?iiif=${encodeURIComponent(resolvedImageInfo.iiifId)}&title=${encodeURIComponent(title)}`;
      }

      const viewUUID = randomUUID();
      viewerQueues.set(viewUUID, {
        commands: [],
        createdAt: Date.now(),
        lastAccess: Date.now(),
        objectNumber,
        imageWidth: resolvedImageInfo.width,
        imageHeight: resolvedImageInfo.height,
        activeOverlays: [],
      });

      const { thumbnailUrl, iiifId, ...imageData } = resolvedImageInfo;
      const viewerData: InferOutput<typeof ImageInfoOutput> = {
        ...imageData,
        objectNumber,
        title,
        creator: RijksmuseumApiClient.parseCreator(object),
        date: RijksmuseumApiClient.parseDate(object),
        license: RijksmuseumApiClient.parseLicense(object),
        physicalDimensions: RijksmuseumApiClient.parseDimensionStatement(object),
        collectionUrl: `https://www.rijksmuseum.nl/en/collection/${objectNumber}`,
        viewUUID,
      };

      const dims = viewerData.width && viewerData.height ? ` | ${viewerData.width}×${viewerData.height}px` : "";
      const text = `${objectNumber} — "${title}" by ${viewerData.creator ?? "unknown"}${dims} | viewUUID: ${viewUUID}`;
      return structuredResponse(viewerData, text);
    })
  );

  // ── inspect_artwork_image ──────────────────────────────────────────

  server.registerTool(
    "inspect_artwork_image",
    {
      title: "Inspect Artwork Image",
      description:
        "Fetch an artwork image or region as base64 for direct visual analysis. " +
        "Use ONLY when visual analysis is needed (e.g. identifying details, reading inscriptions, " +
        "comparing compositions) — not for listing or summarising artworks. " +
        "Returns image bytes in the tool response — the LLM can see and reason " +
        "about the image immediately.\n\n" +
        "Use with region 'full' (default) to inspect the complete artwork, or specify a " +
        "region to zoom into details, read inscriptions, or examine specific areas.\n\n" +
        "Region coordinates: 'pct:x,y,w,h' (percentage of full image, recommended) " +
        "or 'x,y,w,h' (pixel coordinates). Quick reference:\n" +
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
            { message: "Invalid IIIF region. Use 'full', 'square', 'x,y,w,h' (pixels), or 'pct:x,y,w,h' (percentages)." }
          )
          .describe("IIIF region: 'full', 'square', 'pct:x,y,w,h' (percentage), or 'x,y,w,h' (pixels). E.g. 'pct:0,60,40,40' for bottom-left 40%."),
        size: z
          .number()
          .int()
          .min(200)
          .max(2000)
          .default(1200)
          .describe("Width of returned image in pixels (200-2000, default 1200)"),
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
      }).strict(),
      ...withOutputSchema(InspectImageOutput),
    },
    withLogging("inspect_artwork_image", async (args) => {
      const cropError = (error: string) => {
        const data: InferOutput<typeof InspectImageOutput> = {
          objectNumber: args.objectNumber,
          region: args.region,
          requestedSize: args.size,
          rotation: args.rotation,
          quality: args.quality,
          error,
        };
        return {
          ...structuredResponse(data, error),
          isError: true as const,
        };
      };

      try {
        // Resolve image info (fast path: 1 req) in parallel with object metadata (2 reqs).
        const cachedIiifId = vocabDb?.lookupIiifId(args.objectNumber) ?? null;
        const [fastImageInfo, { object }] = await Promise.all([
          cachedIiifId ? api.getImageInfoFast(cachedIiifId) : Promise.resolve(null),
          api.findByObjectNumber(args.objectNumber),
        ]);
        const imageInfo = fastImageInfo ?? await api.getImageInfo(object);

        // Find active viewer for this artwork and refresh TTL
        let activeViewUUID: string | undefined;
        for (const [uuid, q] of viewerQueues) {
          if (q.objectNumber === args.objectNumber) {
            q.lastAccess = Date.now();
            activeViewUUID = uuid;
          }
        }

        if (!imageInfo) {
          return cropError("No image available for this artwork");
        }

        // Clamp size to region width — iiif.micr.io rejects upscaling.
        // For pct: regions, the IIIF server's internal rounding (implementation-
        // specific) can yield a pixel region up to 3px narrower than our
        // estimate. Subtract 3 to avoid hitting the boundary.
        let effectiveSize = args.size;
        if (imageInfo.width) {
          let regionWidth = imageInfo.width;
          const pctMatch = args.region.match(/^pct:([0-9.]+),([0-9.]+),([0-9.]+),([0-9.]+)$/);
          const pxMatch = args.region.match(/^(\d+),(\d+),(\d+),(\d+)$/);
          if (pctMatch) {
            regionWidth = Math.floor(imageInfo.width * parseFloat(pctMatch[3]) / 100) - 3;
          } else if (pxMatch) {
            regionWidth = parseInt(pxMatch[3]);
          } else if (args.region === "square") {
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
            args.region,
            effectiveSize,
            args.rotation,
            args.quality,
          ));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return cropError(`Failed to fetch image: ${message}`);
        }
        const fetchTimeMs = Math.round(performance.now() - fetchStart);

        const title = RijksmuseumApiClient.parseTitle(object);
        const creator = RijksmuseumApiClient.parseCreator(object);
        const regionLabel = args.region === "full" ? "full image" : `region ${args.region}`;
        const sizeNote = effectiveSize < args.size ? ` (clamped from ${args.size}px — upscaling not supported)` : "";

        // Auto-navigate viewer to inspected region (non-full only)
        let viewerNavigated = false;
        if (args.navigateViewer && activeViewUUID && args.region !== "full") {
          const queue = viewerQueues.get(activeViewUUID);
          if (queue) {
            queue.commands.push({ action: "navigate", region: args.region });
            queue.lastAccess = Date.now();
            viewerNavigated = true;
          }
        }

        const captionParts = [
          `"${title}" by ${creator} — ${args.objectNumber}`,
          `(${regionLabel}, ${effectiveSize}px${sizeNote}, ${fetchTimeMs}ms)`,
        ];
        if (viewerNavigated) captionParts.push("| viewer navigated");
        else if (activeViewUUID) captionParts.push(`| viewer open (${activeViewUUID.slice(0, 8)})`);
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
          rotation: args.rotation,
          quality: args.quality,
          fetchTimeMs,
          viewUUID: activeViewUUID,
          viewerNavigated: viewerNavigated || undefined,
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
    viewerConnected: z.boolean().optional(),
    currentOverlays: z.array(z.object({
      label: z.string().optional(),
      region: z.string(),
      color: z.string().optional(),
    })).optional(),
    error: z.string().optional(),
  };

  server.registerTool(
    "navigate_viewer",
    {
      title: "Navigate Viewer",
      description:
        "Navigate the artwork viewer to a specific region and/or add visual overlays. " +
        "Requires a viewUUID from a prior get_artwork_image call (the viewer must be open). " +
        "Can be used after inspect_artwork_image to show the user what you found. " +
        "Commands execute in order: typically clear_overlays → navigate → add_overlay.\n\n" +
        "All region coordinates are in full-image space (percentages or pixels of the original image), " +
        "not relative to the current viewport. The same pct:x,y,w,h used in inspect_artwork_image " +
        "will target the identical area in the viewer.\n\n" +
        "For accurate overlay placement: inspect the target area with inspect_artwork_image first, " +
        "verify the region contains what you expect, then use the same or refined coordinates here. " +
        "Do not estimate overlay positions from memory — always inspect first.\n\n" +
        "Overlays persist in the viewer until clear_overlays is issued — each call appends to the existing set. " +
        "Keep batches under 10 commands per call. The viewer session (viewUUID) remains active for " +
        "30 minutes of idle inactivity — any polling or navigation resets the clock.\n\n" +
        "Coordinate shortcut: when placing overlays based on a prior inspect_artwork_image crop, " +
        "use 'relativeTo' with the crop's region string. Specify 'region' as coordinates within " +
        "the crop's local space (pct: format) and the server projects to full-image space " +
        "deterministically — eliminates manual coordinate conversion math.",
      inputSchema: z.object({
        viewUUID: z.string().describe("Viewer UUID from a prior get_artwork_image call"),
        commands: z.array(z.object({
          action: z.enum(["navigate", "add_overlay", "clear_overlays"]),
          region: optStr().optional().describe("IIIF region (required for navigate/add_overlay): 'full', 'square', 'pct:x,y,w,h', or 'x,y,w,h'"),
          relativeTo: optStr().optional().describe(
            "Crop region from a prior inspect_artwork_image call. When provided, " +
            "'region' is interpreted as coordinates within that crop's local space " +
            "and projected to full-image space by the server. Both must use pct: format."
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
            return navError(`'${cmd.action}' requires a region. Use 'full', 'square', 'x,y,w,h', or 'pct:x,y,w,h'.`);
          }
          if (!IIIF_REGION_RE.test(cmd.region)) {
            return navError(`Invalid region '${cmd.region}'. Use 'full', 'square', 'x,y,w,h', or 'pct:x,y,w,h'.`);
          }
        }
        if (cmd.relativeTo && !parsePctRegion(cmd.relativeTo)) {
          return navError(`Invalid relativeTo '${cmd.relativeTo}'. Must be in pct:x,y,w,h format.`);
        }
      }

      // Project relativeTo coordinates to full-image space
      for (const cmd of args.commands) {
        if (cmd.relativeTo && cmd.region) {
          const projected = projectToFullImage(cmd.region, cmd.relativeTo);
          if (!projected) {
            return navError(`relativeTo requires both 'region' and 'relativeTo' in pct: format. Got region='${cmd.region}', relativeTo='${cmd.relativeTo}'.`);
          }
          cmd.region = projected;
        }
        delete cmd.relativeTo; // Never forward to viewer
      }

      queue.commands.push(...args.commands);
      queue.lastAccess = Date.now();

      // Maintain server-side shadow overlay list
      for (const cmd of args.commands) {
        if (cmd.action === "clear_overlays") queue.activeOverlays = [];
        else if (cmd.action === "add_overlay") {
          queue.activeOverlays.push({ label: cmd.label, region: cmd.region!, color: cmd.color });
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

      const viewerConnected = queue.lastPolledAt != null && (Date.now() - queue.lastPolledAt) < 5000;

      const navData: InferOutput<typeof NavigateViewerOutput> = {
        viewUUID: args.viewUUID,
        queued: args.commands.length,
        imageWidth: queue.imageWidth,
        imageHeight: queue.imageHeight,
        overlays: overlayDetails?.length ? overlayDetails : undefined,
        viewerConnected,
        currentOverlays: queue.activeOverlays.length ? queue.activeOverlays : undefined,
      };
      const connStatus = viewerConnected ? "connected" : "not connected";
      const overlayCount = queue.activeOverlays.length;
      const text = `Queued ${args.commands.length} commands for viewer ${args.viewUUID.slice(0, 8)} (${connStatus})${overlayCount ? ` | ${overlayCount} active overlays` : ""}`;
      return structuredResponse(navData, text);
    })
  );

  // ── poll_viewer_commands (app-only) ───────────────────────────

  registerAppTool(
    server,
    "poll_viewer_commands",
    {
      title: "Poll Viewer Commands",
      description: "Internal: poll for pending viewer navigation commands",
      inputSchema: z.object({
        viewUUID: z.string(),
      }).strict() as z.ZodTypeAny,
      _meta: {
        ui: {
          resourceUri: ARTWORK_VIEWER_RESOURCE_URI,
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
      description:
        "List curated collection sets from the Rijksmuseum (exhibitions, scholarly groupings, thematic collections). " +
        "Returns set identifiers that can be used with browse_set to explore their contents. " +
        "Optionally filter by name substring.",
      inputSchema: z.object({
        query: optStr()
          .optional()
          .describe(
            "Filter sets by name (case-insensitive substring match). E.g. 'painting', 'Rembrandt', 'Japanese'"
          ),
      }).strict(),
      ...withOutputSchema(CuratedSetsOutput),
    },
    withLogging("list_curated_sets", async (args) => {
      const allSets = await oai.listSets();
      const q = args.query?.toLowerCase();
      const sets = q
        ? allSets.filter((s) => s.name.toLowerCase().includes(q))
        : allSets;

      const data: InferOutput<typeof CuratedSetsOutput> = {
        totalSets: sets.length,
        ...(q ? { filteredFrom: allSets.length, query: args.query } : {}),
        sets,
      };
      const headerParts = [`${sets.length} sets`];
      if (q) headerParts.push(`filtered from ${allSets.length}, query: "${args.query}"`);
      const header = headerParts.join(" (") + (q ? ")" : "");
      const lines = sets.map((s, i) => formatSetLine(s, i));
      return structuredResponse(data, [header, ...lines].join("\n"));
    })
  );

  // ── browse_set ──────────────────────────────────────────────────

  server.registerTool(
    "browse_set",
    {
      title: "Browse Set",
      description:
        "Browse artworks in a curated collection set. Returns parsed EDM records with titles, creators, dates, " +
        "image URLs, and IIIF service URLs. Each record includes an objectNumber that can be used with " +
        "get_artwork_details, get_artwork_image, or get_artwork_bibliography for full Linked Art data. " +
        "Supports pagination via resumptionToken.",
      inputSchema: z.object({
        setSpec: z
          .string()
          .describe(
            "Set identifier from list_curated_sets (e.g. '26121')"
          ),
        maxResults: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(10)
          .describe("Maximum records to return (1-50, default 10)"),
        resumptionToken: optStr()
          .optional()
          .describe(
            "Pagination token from a previous browse_set result. When provided, setSpec is ignored."
          ),
      }).strict(),
      ...withOutputSchema(BrowseSetOutput),
    },
    withLogging("browse_set", async (args) => {
      const result = args.resumptionToken
        ? await oai.listRecords({ resumptionToken: args.resumptionToken })
        : await oai.listRecords({ set: args.setSpec });

      return paginatedResponse(result, args.maxResults, "totalInSet", "browse_set", undefined, formatRecordLine);
    })
  );

  // ── get_recent_changes ──────────────────────────────────────────

  server.registerTool(
    "get_recent_changes",
    {
      title: "Get Recent Changes",
      description:
        "Track recent additions and modifications to the Rijksmuseum collection. " +
        "Returns records changed within a date range. Use identifiersOnly=true for a lightweight " +
        "listing (headers only, no full metadata). Each record includes an objectNumber for use with " +
        "get_artwork_details, get_artwork_image, or get_artwork_bibliography.",
      inputSchema: z.object({
        from: z
          .string()
          .describe(
            "Start date in ISO 8601 format (e.g. '2026-02-01T00:00:00Z' or '2026-02-01')"
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
            "If true, returns only record headers (identifier, datestamp, set memberships) — much faster"
          ),
        maxResults: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(10)
          .describe("Maximum records to return (1-50, default 10)"),
        resumptionToken: optStr()
          .optional()
          .describe(
            "Pagination token from a previous get_recent_changes result. When provided, all other filters are ignored."
          ),
      }).strict(),
      ...withOutputSchema(RecentChangesOutput),
    },
    withLogging("get_recent_changes", async (args) => {
      const opts = {
        from: args.from,
        until: args.until,
        set: args.setSpec,
        resumptionToken: args.resumptionToken,
      };

      const result = args.identifiersOnly
        ? await oai.listIdentifiers(opts)
        : await oai.listRecords(opts);

      const extra = args.identifiersOnly ? { identifiersOnly: true } : undefined;
      return paginatedResponse(result, args.maxResults, "totalChanges", "get_recent_changes", extra, formatRecordLine);
    })
  );

  // ── lookup_iconclass ────────────────────────────────────────────
  // Guarded: tool only registered when iconclassDb is loaded. This is safe because
  // initIconclassDb() completes before createServer() in both stdio and HTTP boot paths.
  // Semantic search path is only available when both embeddingModel and iconclass embeddings
  // are present — the tool gracefully degrades to FTS-only when they aren't.

  if (iconclassDb?.available) {
    const db = iconclassDb; // narrowed to non-null for the closure
    const semanticAvailable = db.embeddingsAvailable && embeddingModel?.available;
    server.registerTool(
      "lookup_iconclass",
      {
        title: "Lookup Iconclass",
        description:
          "Search or browse the Iconclass classification system — a universal vocabulary for art subject matter (~40K notations across 13 languages). " +
          "Use this to discover Iconclass notation codes by concept (e.g. 'smell', 'crucifixion', 'Löwe'), " +
          "then pass the notation to search_artwork's iconclass parameter for precise results. " +
          "Artwork counts (rijksCount) are pre-computed and approximate; use search_artwork with the notation code for current results.\n\n" +
          "Three modes (provide exactly one of query, notation, or semanticQuery):\n" +
          "• query — FTS5 keyword search (exact word match, no stemming)\n" +
          "• notation — browse a specific notation and its children\n" +
          "• semanticQuery — find notations by meaning/concept (e.g. 'domestic animals' finds dogs, cats, horses)" +
          (semanticAvailable ? "" : " [currently unavailable — embeddings not loaded]"),
        inputSchema: z.object({
          query: optStr()
            .optional()
            .describe(
              "Text search across Iconclass labels and keywords in all 13 languages. " +
              "Exact word matching (no stemming): 'crucifixion' won't match 'crucified' — try word variants if needed. " +
              "Returns matching notations ranked by Rijksmuseum artwork count."
            ),
          notation: optStr()
            .optional()
            .describe(
              "Browse a specific Iconclass notation (e.g. '31A33' for smell). " +
              "Returns the entry with its hierarchy and direct children."
            ),
          semanticQuery: optStr()
            .optional()
            .describe(
              "Semantic concept search across Iconclass — finds notations by meaning rather than exact words. " +
              "Use when keyword search fails or for broad conceptual queries (e.g. 'domestic animals', 'religious suffering')."
            ),
          onlyWithArtworks: z
            .boolean()
            .default(false)
            .optional()
            .describe(
              "Only return notations that have artworks in the Rijksmuseum collection (rijks_count > 0). " +
              "Only applies to semanticQuery mode."
            ),
          lang: z
            .string()
            .default("en")
            .describe("Preferred language for labels (default: 'en'). Available: en, nl, de, fr, it, es, pt, fi, cz, hu, pl, jp, zh."),
          maxResults: z
            .number()
            .int()
            .min(1)
            .max(RESULTS_MAX)
            .default(RESULTS_DEFAULT)
            .describe(`Maximum results for search mode (1-${RESULTS_MAX}, default ${RESULTS_DEFAULT}).`),
        }).strict(),
        ...withOutputSchema(LookupIconclassOutput),
      },
      withLogging("lookup_iconclass", async (args) => {
        const modes = [args.query, args.notation, args.semanticQuery].filter(v => v !== undefined);
        if (modes.length === 0) {
          return errorResponse("Provide exactly one of: query, notation, or semanticQuery.");
        }
        if (modes.length > 1) {
          return errorResponse("Provide exactly one of: query, notation, or semanticQuery — not multiple.");
        }

        // Semantic search mode
        if (args.semanticQuery !== undefined) {
          if (!embeddingModel?.available || !db.embeddingsAvailable) {
            return errorResponse(
              "Semantic search requires Iconclass embeddings and an embedding model (not available in current deployment). " +
              "Use query (keyword search) or notation (browse) instead."
            );
          }

          const queryVec = await embeddingModel.embed(args.semanticQuery);
          // Reject if query vector dimensions don't match the iconclass embedding index
          if (queryVec.length !== db.embeddingDimensions) {
            return errorResponse(
              `Iconclass semantic search requires ${db.embeddingDimensions}-dimensional query vectors, but the embedding model produced ${queryVec.length}d. ` +
              "This can happen when artwork embeddings use MRL truncation to a different dimension. " +
              "Use query (keyword search) or notation (browse) instead."
            );
          }
          const result = db.semanticSearch(queryVec, args.maxResults, args.lang, args.onlyWithArtworks ?? false);
          if (!result) {
            return errorResponse("Semantic search failed — embeddings may be corrupted.");
          }
          result.query = args.semanticQuery;

          const suffix = args.onlyWithArtworks ? " (with artworks only)" : "";
          const header = `${result.results.length} semantic Iconclass matches for "${args.semanticQuery}"${suffix}`;
          const lines = result.results.map((e, i) => {
            const similarity = Math.round((1 - e.distance) * 1000) / 1000;
            let line = `${i + 1}. [${similarity}] ${e.notation} (${e.rijksCount} artworks) "${e.text}"`;
            if (e.path.length > 0) line += ` [${e.path.map((p) => p.notation).join(" > ")}]`;
            return line;
          });
          const data: InferOutput<typeof LookupIconclassOutput> = result;
          return structuredResponse(data, [header, ...lines].join("\n"));
        }

        // FTS search mode
        if (args.query !== undefined) {
          const result = db.search(args.query, args.maxResults, args.lang);

          const header = `${result.results.length} of ${result.totalResults} Iconclass matches for "${args.query}"`;
          const lines = result.results.map((e, i) => {
            let line = `${i + 1}. ${e.notation} (${e.rijksCount} artworks) "${e.text}"`;
            if (e.path.length > 0) line += ` [${e.path.map((p) => p.notation).join(" > ")}]`;
            return line;
          });
          const data: InferOutput<typeof LookupIconclassOutput> = result;
          return structuredResponse(data, [header, ...lines].join("\n"));
        }

        // Browse mode
        const result = db.browse(args.notation!, args.lang);
        if (!result) {
          return errorResponse(`Notation "${args.notation}" not found in Iconclass.`);
        }

        const { entry, subtree } = result;
        const pathStr = entry.path.length > 0
          ? entry.path.map((p) => `${p.notation} "${p.text}"`).join(" > ") + " > "
          : "";
        const header = `${pathStr}${entry.notation} "${entry.text}" (${entry.rijksCount} artworks)`;
        const sections = [header];
        if (entry.keywords.length > 0) {
          sections.push(`Keywords: ${entry.keywords.join(", ")}`);
        }
        if (subtree.length > 0) {
          const childLines = subtree.map((c) =>
            `  ${c.notation} (${c.rijksCount}) "${c.text}"`
          );
          sections.push(`Children (${childLines.length}):`, ...childLines);
        }
        const browseData: InferOutput<typeof LookupIconclassOutput> = result;
        return structuredResponse(browseData, sections.join("\n"));
      })
    );
  }

  // ── search_provenance (conditionally registered when provenance tables exist) ──

  const PROVENANCE_TRANSFER_TYPES = [
    "sale", "inheritance", "bequest", "commission", "purchase",
    "confiscation", "recuperation", "restitution",
    "loan", "transfer", "collection", "gift",
    "deposit", "exchange", "auction", "seizure", "donation", "inventory",
    "unknown",
  ] as const;

  const ProvenanceSearchOutput = {
    totalArtworks: z.number().int()
      .describe("Number of artworks with matching provenance events/periods. Capped at 10,001 — see totalArtworksCapped."),
    totalArtworksCapped: z.boolean().optional()
      .describe("True when the actual total exceeds 10,001. Use search_artwork with provenance parameter for exact collection-wide counts."),
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
        uncertain: z.boolean(),
        parties: z.array(z.object({
          name: z.string(),
          dates: z.string().nullable(),
          uncertain: z.boolean(),
          role: z.string().nullable(),
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
        parseMethod: z.enum(["peg", "regex_fallback", "cross_ref"]),
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
    warnings: z.array(z.string()).optional(),
    error: z.string().optional(),
  };

  if (vocabAvailable && vocabDb!.hasProvenanceTables) {
    server.registerTool(
      "search_provenance",
      {
        title: "Search Provenance",
        description:
          "Search ownership and provenance history across ~48K artworks with parsed provenance records. " +
          "Returns full provenance chains grouped by artwork, with matching events flagged. " +
          "Each chain tells the complete ownership story: collectors, sales, inheritances, gifts, " +
          "confiscations, and restitutions, with dates, locations, prices, and citations. " +
          "Use objectNumber for a single artwork's chain (fast local lookup, no network). " +
          "Use party to trace a collector or dealer across artworks (e.g. 'Six', 'Rothschild'). " +
          "Use relatedTo for reverse cross-references — find all works sharing provenance with a given object " +
          "(pendants, album sheets, dollhouse contents). " +
          "Combine transferType, dateFrom/dateTo, location for pattern discovery " +
          "(e.g. confiscations 1940–1945, sales in Paris). " +
          "Each event includes parseMethod (peg, regex_fallback, cross_ref) indicating parse confidence. " +
          "Use hasGap to find artworks with gaps in their provenance chain — red flags for wartime displacement or undocumented transfers. " +
          "For collection-wide counting or keyword searches that don't map to structured fields, " +
          "use search_artwork's provenance parameter (full-text search on raw provenance text) instead. " +
          "For collection-wide statistics, use search_artwork's provenance parameter (keyword search returning totalResults counts) " +
          "combined with facets and creditLine for cross-tabulation by type, material, or century. " +
          "The provenance + creditLine + compact + facets pattern enables collector profiling and acquisition channel analysis. " +
          "At least one filter is required.",
        inputSchema: z.object({
          layer: z.preprocess(stripNull,
            z.enum(["events", "periods"]).default("events").optional(),
          ).describe("Data layer. 'events' (default): raw parsed provenance events (Layer 1). 'periods': interpreted ownership periods with durations (Layer 2)."),
          party: optStr().describe("Owner, collector, or dealer name (partial match, e.g. 'Six', 'Rothschild', 'Westendorp')."),
          transferType: z.preprocess(
            normalizeStringOrArray,
            z.union([z.enum(PROVENANCE_TRANSFER_TYPES), z.array(z.enum(PROVENANCE_TRANSFER_TYPES))]).optional(),
          ).describe("Type of ownership transfer (single or array). Use excludeTransferType for set difference (e.g. confiscated but never restituted). Well-populated: sale (24K), collection (17K), inheritance (17K), loan (6K), transfer (5K), gift (4K), purchase (2K). Rare: bequest, recuperation, commission, deposit, restitution, confiscation, exchange. Currently empty: auction, seizure, donation, inventory."),
          excludeTransferType: z.preprocess(
            normalizeStringOrArray,
            z.union([z.enum(PROVENANCE_TRANSFER_TYPES), z.array(z.enum(PROVENANCE_TRANSFER_TYPES))]).optional(),
          ).describe("Exclude artworks that have ANY event of this type. Artwork-level negation (e.g. confiscated but never restituted)."),
          ownerName: optStr().describe("Owner name (partial match). Only used with layer='periods'."),
          acquisitionMethod: z.preprocess(stripNull,
            z.enum(PROVENANCE_TRANSFER_TYPES).optional(),
          ).describe("Acquisition method filter (exact match). Only used with layer='periods'."),
          location: optStr().describe("City or place name (partial match, e.g. 'Amsterdam', 'Paris', 'London')."),
          dateFrom: z.preprocess(stripNull, z.number().int().optional())
            .describe("Earliest year (inclusive) for provenance event/period dates."),
          dateTo: z.preprocess(stripNull, z.number().int().optional())
            .describe("Latest year (inclusive) for provenance event/period dates."),
          objectNumber: optStr().describe("Get full provenance chain for a specific artwork (e.g. 'SK-A-2344'). Fast local lookup."),
          creator: optStr().describe("Artist name (partial match on creator, e.g. 'Rembrandt', 'Vermeer')."),
          currency: z.preprocess(stripNull,
            z.enum(["guilders", "pounds", "francs", "livres", "napoléons", "deutschmarks", "reichsmarks", "swiss_francs"]).optional(),
          ).describe("Price currency filter (exact match). Only used with layer='events'."),
          hasPrice: z.preprocess(stripNull, z.boolean().optional())
            .describe("If true, only events with recorded prices. Only used with layer='events'."),
          hasGap: z.preprocess(stripNull, z.boolean().optional())
            .describe("If true, only artworks with provenance gaps (undocumented periods). Only used with layer='events'."),
          relatedTo: optStr().describe("Reverse cross-reference: find all artworks whose provenance references this object number (e.g. 'BK-14656'). Only used with layer='events'."),
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
            z.number().int().min(1).max(50).default(10).optional(),
          ).describe("Maximum artworks to return (1–50, default 10). Each artwork includes its full chain."),
        }).strict(),
        ...withOutputSchema(ProvenanceSearchOutput),
      },
      withLogging("search_provenance", async (args: Record<string, unknown>) => {
        const layer = (args.layer as string | undefined) ?? "events";
        const params: ProvenanceSearchParams = {
          maxResults: (args.maxResults as number | undefined) ?? 10,
          layer: layer as "events" | "periods",
        };
        if (args.party) params.party = args.party as string;
        if (args.transferType) params.transferType = args.transferType as string | string[];
        if (args.excludeTransferType) params.excludeTransferType = args.excludeTransferType as string | string[];
        if (args.ownerName) params.ownerName = args.ownerName as string;
        if (args.acquisitionMethod) params.acquisitionMethod = args.acquisitionMethod as string;
        if (args.location) params.location = args.location as string;
        if (args.dateFrom != null) params.dateFrom = args.dateFrom as number;
        if (args.dateTo != null) params.dateTo = args.dateTo as number;
        if (args.objectNumber) params.objectNumber = args.objectNumber as string;
        if (args.creator) params.creator = args.creator as string;
        if (args.currency) params.currency = args.currency as string;
        if (args.hasPrice != null) params.hasPrice = args.hasPrice as boolean;
        if (args.hasGap != null) params.hasGap = args.hasGap as boolean;
        if (args.relatedTo) params.relatedTo = args.relatedTo as string;
        if (args.minDuration != null) params.minDuration = args.minDuration as number;
        if (args.maxDuration != null) params.maxDuration = args.maxDuration as number;
        if (args.sortBy) params.sortBy = args.sortBy as ProvenanceSearchParams["sortBy"];
        if (args.sortOrder) params.sortOrder = args.sortOrder as "asc" | "desc";
        if (args.offset != null) params.offset = args.offset as number;

        // At least one substantive filter required
        const hasFilter = ["party", "transferType", "excludeTransferType", "location", "dateFrom", "dateTo",
          "objectNumber", "creator", "currency", "hasPrice", "hasGap", "relatedTo",
          "ownerName", "acquisitionMethod", "minDuration", "maxDuration"]
          .some(k => (params as Record<string, unknown>)[k] !== undefined);
        if (!hasFilter) {
          return errorResponse(
            "At least one search filter is required (e.g. party, transferType, location, dateFrom/dateTo, creator, objectNumber, " +
            "ownerName, acquisitionMethod, minDuration). Modifiers like sortBy, sortOrder, maxResults, offset, and layer do not count. " +
            "Tip: use a broad filter such as dateFrom: 1400 for collection-wide ranking.",
          );
        }

        // Route on layer
        const result = layer === "periods"
          ? vocabDb!.searchProvenancePeriods(params)
          : vocabDb!.searchProvenance(params);

        // Text channel
        const lines: string[] = [];
        lines.push(`${pluralize(result.totalArtworks, "artwork")} with matching provenance`);
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
              if (e.transferType !== "unknown") parts.push(e.transferType);
              if (partyNames) parts.push(partyNames);
              if (e.dateExpression) parts.push(e.dateExpression);
              else if (e.dateYear) parts.push(String(e.dateYear));
              if (e.location) parts.push(e.location);
              if (e.price) parts.push(`${e.price.currency} ${e.price.amount.toLocaleString()}`);
              if (e.isCrossRef && e.crossRefTarget) parts.push(`→ see ${e.crossRefTarget}`);
              lines.push(`  ${marker} ${e.sequence}. ${parts.length > 0 ? parts.join(" | ") : e.rawText}`);
            }
          }
        }

        const data: InferOutput<typeof ProvenanceSearchOutput> = result;
        return structuredResponse(data, lines.join("\n"));
      })
    );
  }

  // ── find_similar (feature-gated, set ENABLE_FIND_SIMILAR=true to register) ──

  if (vocabAvailable && vocabDb!.available && process.env.ENABLE_FIND_SIMILAR === "true") {
    server.registerTool(
      "find_similar",
      {
        title: "Find Similar Artworks",
        description:
          "Find artworks similar to a given artwork. Generates a visual comparison page with IIIF thumbnails " +
          "showing five independent similarity signals (Lineage, Iconclass, Description, Depicted Person, Depicted Place) plus a pooled column.\n\n" +
          "IMPORTANT: The result is a file path or URL to an HTML page. " +
          "Your ONLY job is to show the user the path/URL so they can open it in a browser. " +
          "Do NOT attempt to open, read, fetch, summarise, or characterise the page contents. " +
          "Do NOT make additional tool calls to look up the same artworks. " +
          "Simply present the link and explain that it contains a visual comparison page.",
        inputSchema: z.object({
          objectNumber: z.string().describe("Object number of the artwork to find similar works for (e.g. 'SK-A-1718')."),
          maxResults: z.preprocess(stripNull, z.number().int().min(1).max(RESULTS_MAX).default(20).optional())
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

        /** Convert a mode's raw results (which include artId) into SimilarCandidate[].
         *  Single batch lookup for iiif_ids + types — no per-result queries. */
        function toCandidates(
          results: { artId: number; objectNumber: string; title: string; creator: string; date?: string; score: number; url: string; detail?: string }[],
        ): SimilarCandidate[] {
          if (results.length === 0) return [];
          const artIds = results.map(r => r.artId);
          const meta = vocabDb!.batchLookupByArtId(artIds);
          const types = vocabDb!.batchLookupTypesByArtId(artIds);
          return results.map(r => {
            const m = meta.get(r.artId);
            return {
              objectNumber: r.objectNumber,
              title: r.title,
              creator: r.creator,
              ...(r.date && { date: r.date }),
              ...(types.has(r.artId) && { type: types.get(r.artId) }),
              iiifId: m?.iiifId ?? undefined,
              score: r.score,
              url: r.url,
              ...(r.detail && { detail: r.detail }),
            };
          });
        }

        // Iconclass
        const icResult = vocabDb!.findSimilarByIconclass(args.objectNumber, maxResults);
        const icCandidates = toCandidates(
          (icResult?.results ?? []).map(r => ({
            ...r,
            detail: r.sharedMotifs.map(m => `${m.notation} ${m.label}`).join(", "),
          })),
        );
        // Enrich with per-card Iconclass notations
        for (let i = 0; i < icCandidates.length; i++) {
          const src = icResult?.results[i];
          if (src) icCandidates[i].sharedNotations = src.sharedMotifs.map(m => m.notation);
        }

        // Lineage
        const liResult = vocabDb!.findSimilarByLineage(args.objectNumber, maxResults);
        const liCandidates = toCandidates(
          (liResult?.results ?? []).map(r => ({
            ...r,
            detail: r.sharedLineage.map(l => `${l.qualifierLabel} ${l.creatorLabel}`).join(", "),
          })),
        );
        // Enrich with per-card qualifier metadata
        for (let i = 0; i < liCandidates.length; i++) {
          const src = liResult?.results[i];
          if (src && src.sharedLineage.length > 0) {
            const primary = src.sharedLineage[0]; // highest-strength qualifier
            liCandidates[i].qualifierLabel = primary.qualifierLabel;
            liCandidates[i].qualifierUri = primary.qualifierUri;
            liCandidates[i].qualifierCreator = primary.creatorLabel;
          }
        }

        // Description
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

        // Depicted Person & Place — shared enrichment pattern
        function toDepictedCandidates(result: DepictedSimilarResult | null): SimilarCandidate[] {
          const candidates = toCandidates(
            (result?.results ?? []).map(r => ({
              ...r,
              detail: r.sharedTerms.map(t => t.label).join(", "),
            })),
          );
          for (let i = 0; i < candidates.length; i++) {
            const src = result?.results[i];
            if (src) {
              candidates[i].sharedTerms = src.sharedTerms.map(t => ({
                label: t.label,
                ...(t.wikidataUri && { wikidataUri: t.wikidataUri }),
              }));
            }
          }
          return candidates;
        }

        const dpResult = vocabDb!.findSimilarByDepictedPerson(args.objectNumber, maxResults);
        const dpCandidates = toDepictedCandidates(dpResult);

        const dplResult = vocabDb!.findSimilarByDepictedPlace(args.objectNumber, maxResults);
        const dplCandidates = toDepictedCandidates(dplResult);

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
          },
          modes: {
            iconclass: icCandidates,
            lineage: liCandidates,
            description: descCandidates,
            ...(visualCandidates.length > 0 && { visual: visualCandidates }),
            ...(dpCandidates.length > 0 && { depictedPerson: dpCandidates }),
            ...(dplCandidates.length > 0 && { depictedPlace: dplCandidates }),
          },
          poolThreshold: 3,
          generatedAt: new Date().toISOString().slice(0, 16).replace("T", " "),
          ...(visualSearchUrl && { visualSearchUrl }),
          ...(visualTotalResults && { visualTotalResults }),
        };

        const html = generateSimilarHtml(pageData);

        // Build response URL or file path
        let pageLocation: string;
        const pageUUID = randomUUID();
        if (httpPort) {
          // HTTP mode — store in memory, serve at /similar/:uuid
          similarPages.set(pageUUID, { html, lastAccess: Date.now() });
          const baseUrl = process.env.PUBLIC_URL || `http://localhost:${httpPort}`;
          pageLocation = `${baseUrl}/similar/${pageUUID}`;
        } else {
          // stdio mode — write to OS temp directory (no HTTP server to serve from)
          const filePath = path.join(os.tmpdir(), `rijksmuseum-similar-${pageUUID}.html`);
          fs.writeFileSync(filePath, html, "utf-8");
          pageLocation = filePath;
        }

        // Summary counts
        const counts = [
          ...(visualCandidates.length > 0 ? [`Visual: ${visualCandidates.length}`] : []),
          `Lineage: ${liCandidates.length}`,
          `Iconclass: ${icCandidates.length}`,
          `Description: ${descCandidates.length}`,
          `Person: ${dpCandidates.length}`,
          `Place: ${dplCandidates.length}`,
        ];
        const poolThreshold = pageData.poolThreshold;
        // Count pooled entries
        const allObjNums = new Map<string, number>();
        for (const mode of [visualCandidates, icCandidates, liCandidates, descCandidates, dpCandidates, dplCandidates]) {
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
        description:
          "Find artworks by meaning, concept, or theme using natural language. " +
          "Returns results ranked by semantic similarity with source text for grounding — " +
          "use this to explain why results are relevant or to flag false positives.\n\n" +
          "Best for: concepts or themes that cannot be expressed as structured metadata — " +
          "atmospheric qualities ('vanitas symbolism', 'sense of loneliness'), compositional descriptions " +
          "('artist gazing directly at the viewer'), art-historical concepts ('cultural exchange under VOC trade'), " +
          "or cross-language queries. Results are most reliable when the Rijksmuseum's curatorial narrative texts " +
          "discuss the relevant concept explicitly; purely emotional or stylistic concepts (e.g. chiaroscuro, " +
          "desolation) may yield lower precision because catalogue descriptions often do not use that language.\n\n" +
          "Not for: queries expressible as structured metadata (specific artists, dates, places, materials) — " +
          "use search_artwork for those.\n\n" +
          "Filter notes: Supports pre-filtering by subject, depictedPerson, depictedPlace, productionPlace, " +
          "collectionSet, aboutActor, iconclass, and imageAvailable in addition to type, material, technique, creator, and creationDate. " +
          "Use type: 'painting' to restrict to the paintings collection. " +
          "Do NOT use technique: 'painting' for this purpose — it matches painted decoration on any object type " +
          "(ceramics, textiles, frames) and will return unexpected results.\n\n" +
          "Painting queries — two-step pattern: Paintings are underrepresented in semantic results " +
          "because prints and drawings outnumber them ~77:1 in the collection. For queries where paintings are the expected " +
          "result type, ALWAYS combine semantic_search with a follow-up search_artwork(type: 'painting', subject: ...) " +
          "or search_artwork(type: 'painting', creator: ...) call — do not wait to observe skew, as the absence " +
          "of key works is not visible in the returned results.\n\n" +
          "Multilingual: queries in Dutch, German, French and other languages are supported but may benefit " +
          "from a wider result window or English reformulation if canonical works are missing.",
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
          maxResults: z.number().int().min(1).max(RESULTS_MAX).default(15).optional()
            .describe("Number of results to return (default 15). Similarity scores plateau after ~15 results; request more only if needed."),
        }).strict(),
        ...withOutputSchema(SemanticSearchOutput),
      },
      withLogging("semantic_search", async (args) => {
        const maxResults = args.maxResults ?? 15;

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
            // DB lacks integer mappings (text-schema) — fall back to pure KNN
            candidates = embeddingsDb!.search(queryVec, maxResults);
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
            const filtered = embeddingsDb!.searchFiltered(queryVec, candidateArtIds, maxResults);
            candidates = filtered.results;
            filtersApplied = true;
            if (filtered.warning) warnings.push(filtered.warning);
          }
        } else {
          // PURE KNN PATH: vec0 virtual table
          candidates = embeddingsDb!.search(queryVec, maxResults);
          if (hasFilters) {
            warnings.push("Metadata filters ignored: vocabulary DB is not available. Results ranked by semantic similarity only.");
          }
        }

        // 3. Batch-resolve metadata from vocab DB (single query, not per-result)
        const objectNumbers = candidates.map(c => c.objectNumber);
        const typeMap = vocabDb?.available ? vocabDb.lookupTypes(objectNumbers) : new Map<string, string>();

        // 4. Reconstruct source text for all results (grounding context)
        const allArtIds = candidates.map(c => c.artId);
        const sourceTextMap = vocabDb?.available
          ? vocabDb.reconstructSourceText(allArtIds)
          : new Map<number, string>();

        const results = candidates.map((c, i) => {
          const similarity = Math.round((1 - c.distance) * 1000) / 1000;

          let title = "", creator = "", date: string | undefined;
          if (vocabDb?.available) {
            const info = vocabDb.lookupArtwork(c.objectNumber);
            if (info) {
              title = info.title || "";
              creator = info.creator || "";
              date = formatDateRange(info.dateEarliest, info.dateLatest);
            }
          }

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

function registerAppViewerResource(server: McpServer): void {
  registerAppResource(
    server,
    "Rijksmuseum Artwork Viewer",
    ARTWORK_VIEWER_RESOURCE_URI,
    {
      description:
        "Interactive IIIF deep-zoom viewer for Rijksmuseum artworks",
      mimeType: RESOURCE_MIME_TYPE,
    },
    async () => ({
      contents: [
        {
          uri: ARTWORK_VIEWER_RESOURCE_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: loadViewerHtml(),
          _meta: {
            ui: {
              csp: {
                resourceDomains: [
                  "https://iiif.micr.io",
                  "https://cdn.jsdelivr.net",
                  "https://unpkg.com",
                ],
                connectDomains: [
                  "https://iiif.micr.io",
                ],
              },
              permissions: {
                clipboardWrite: {},
              },
              prefersBorder: false,
            },
          },
        },
      ],
    })
  );
}

// ─── Prompts ────────────────────────────────────────────────────────

function registerPrompts(server: McpServer, api: RijksmuseumApiClient): void {
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
          .describe(`Maximum number of works to include (1-${RESULTS_MAX}, default: ${RESULTS_DEFAULT})`),
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
              `Note: search returns at most ${RESULTS_MAX} works. For prolific artists, this is a small sample of their collection.\n\n` +
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
