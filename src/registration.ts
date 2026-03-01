import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerAppTool,
  registerAppResource,
  getUiCapability,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { RijksmuseumApiClient } from "./api/RijksmuseumApiClient.js";
import { OaiPmhClient } from "./api/OaiPmhClient.js";
import { VocabularyDb } from "./api/VocabularyDb.js";
import { IconclassDb } from "./api/IconclassDb.js";
import { EmbeddingsDb, type SemanticSearchResult } from "./api/EmbeddingsDb.js";
import { EmbeddingModel } from "./api/EmbeddingModel.js";
import { UsageStats } from "./utils/UsageStats.js";
import { SystemIntegration } from "./utils/SystemIntegration.js";
import type { SearchParams } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ARTWORK_VIEWER_RESOURCE_URI = "ui://rijksmuseum/artwork-viewer.html";

/** Shared limits for maxResults / maxWorks across search_artwork and get_artist_timeline. */
const RESULTS_DEFAULT = 25;
const RESULTS_MAX = 100;

type ToolResponse = { content: [{ type: "text"; text: string }] };
type StructuredToolResponse = ToolResponse & { structuredContent: Record<string, unknown> };

function jsonResponse(data: unknown): ToolResponse {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function errorResponse(message: string) {
  const base = { content: [{ type: "text" as const, text: message }], isError: true as const };
  if (!EMIT_STRUCTURED) return base;
  return { ...base, structuredContent: { error: message } as Record<string, unknown> };
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
function formatSearchLine(r: { objectNumber: string; title: string; creator: string; date?: string; type?: string; nearestPlace?: string; distance_km?: number }, i: number): string {
  let line = `${i + 1}. ${r.objectNumber}`;
  if (r.type) line += ` | ${r.type}`;
  if (r.date) line += ` | ${r.date}`;
  line += ` | "${r.title}"`;
  if (r.creator) line += ` — ${r.creator}`;
  if (r.nearestPlace) line += ` [${r.nearestPlace}, ${r.distance_km?.toFixed(1)}km]`;
  return line;
}

/** Format a timeline entry as a compact one-liner for LLM content. */
function formatTimelineLine(t: { year: string; objectNumber: string; title: string; type?: string }, i: number): string {
  let line = `${i + 1}. ${t.year}  ${t.objectNumber}`;
  if (t.type) line += ` | ${t.type}`;
  line += `  "${t.title}"`;
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
        console.error(JSON.stringify({ tool: toolName, ms, ok: true, ...(input && { input }) }));
        stats?.record(toolName, ms, true);
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
  extra?: Record<string, unknown>
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

const ResolvedTermShape = z.object({
  id: z.string(),
  label: z.string(),
  equivalents: z.record(z.string()).optional(),
});

const SearchResultOutput = {
  totalResults: z.number().int().nullable().optional()
    .describe("Total matching artworks. Null/absent for complex cross-filter queries."),
  results: z.array(z.object({
    id: z.string().optional().describe("Linked Art URI (present for Search API results, absent for vocabulary results)."),
    objectNumber: z.string(),
    title: z.string(),
    creator: z.string(),
    date: z.string().optional(),
    type: z.string().optional(),
    url: z.string(),
    nearestPlace: z.string().optional(),
    distance_km: z.number().optional(),
  })).optional().describe("Artwork summaries. Absent when compact=true."),
  ids: z.array(z.string()).optional().describe("Artwork URIs (compact mode only)."),
  source: z.enum(["search_api", "vocabulary", "aboutActor-fallback"]).optional(),
  referencePlace: z.string().optional(),
  nextPageToken: z.string().optional(),
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
  objectTypes: z.array(ResolvedTermShape),
  materials: z.array(ResolvedTermShape),
  production: z.array(z.object({
    name: z.string(), role: z.string().nullable(), place: z.string().nullable(), actorUri: z.string(),
  })),
  collectionSetLabels: z.array(ResolvedTermShape),
  // Enriched Group C
  subjects: z.object({
    iconclass: z.array(ResolvedTermShape),
    depictedPersons: z.array(ResolvedTermShape),
    depictedPlaces: z.array(ResolvedTermShape),
  }),
  bibliographyCount: z.number().int(),
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

const TimelineOutput = {
  artist: z.string(),
  totalWorksInCollection: z.number().int(),
  timeline: z.array(z.object({
    id: z.string().describe("Linked Art URI."),
    objectNumber: z.string(),
    title: z.string(),
    creator: z.string(),
    year: z.string(),
    type: z.string().optional(),
    url: z.string(),
  })),
  warnings: z.array(z.string()).optional(),
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
  viewerUrl: z.string().optional(),
  viewUUID: z.string().optional().describe("Viewer session ID for use with navigate_viewer."),
  error: z.string().optional(),
};

const CropImageOutput = {
  objectNumber: z.string(),
  region: z.string(),
  requestedSize: z.number().int(),
  nativeWidth: z.number().int().optional(),
  nativeHeight: z.number().int().optional(),
  rotation: z.number().int(),
  quality: z.string(),
  fetchTimeMs: z.number().int().optional().describe("Time spent fetching from IIIF server (ms)"),
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

const IconclassEntryShape = z.object({
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
  entry: IconclassEntryShape.optional(),
  subtree: z.array(IconclassEntryShape).optional(),
  results: z.array(IconclassEntryShape.extend({ distance: z.number().optional() })).optional(),
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

const OpenInBrowserOutput = {
  opened: z.boolean(),
  url: z.string(),
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
  lastPolledAt: number;
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
  const vocabParamKeys = [
    "subject", "iconclass", "depictedPerson", "depictedPlace", "productionPlace",
    "birthPlace", "deathPlace", "profession", "collectionSet", "license",
    // Tier 2 (vocabulary DB v1.0+)
    "description", "inscription", "provenance", "creditLine", "curatorialNarrative", "productionRole",
    "minHeight", "maxHeight", "minWidth", "maxWidth",
    "nearPlace", "nearLat", "nearLon",
    "title",
  ] as const;
  // nearPlaceRadius excluded: its Zod default (25) would trigger
  // vocab routing on every query. Forwarded separately via allVocabKeys.

  // Keys that cross both paths: forwarded to vocab DB when a vocab param triggers routing
  const crossFilterKeys = ["material", "technique", "type", "creator"] as const;
  const hybridKeys = ["creationDate"] as const;
  const allVocabKeys = [...vocabParamKeys, "nearPlaceRadius", ...crossFilterKeys, ...hybridKeys];

  server.registerTool(
    "search_artwork",
    {
      title: "Search Artwork",
      description:
        "Search the Rijksmuseum collection. Returns artwork summaries with titles, creators, and dates. " +
        "Results are in cataloguing order, not ranked by relevance or importance — " +
        "for relevance-ranked results, use semantic_search instead. " +
        "At least one search filter is required. " +
        "Use specific filters for best results — there is no general full-text search across all metadata fields. " +
        "For concept or thematic searches (e.g. 'winter landscape', 'smell', 'crucifixion'), " +
        "ALWAYS start with subject — it searches 831K artworks tagged with structured Iconclass vocabulary " +
        "and has by far the highest recall for conceptual queries. " +
        "Use description for cataloguer observations (e.g. compositional details, specific motifs noted by specialists); " +
        "use curatorialNarrative for curatorial interpretation and art-historical context. " +
        "These three fields search different text corpora and can return complementary results. " +
        "For broader concept or theme discovery beyond structured vocabulary, use semantic_search — " +
        "but note that paintings are underrepresented there, so combine it with " +
        "search_artwork(type: 'painting', subject/creator: ...) for painting queries. " +
        "Each result includes an objectNumber for use with get_artwork_details (full metadata), " +
        "get_artwork_image (deep-zoom viewer), or get_artwork_bibliography (scholarly references)." +
        (vocabAvailable
          ? " Vocabulary-based filters (subject, iconclass, depictedPerson, depictedPlace, productionPlace, " +
            "birthPlace, deathPlace, profession, collectionSet, license, description, inscription, provenance, creditLine, " +
            "curatorialNarrative, productionRole, and dimension filters) " +
            "can be freely combined with each other and with creator, type, material, technique, creationDate, and query. " +
            "Vocabulary filters cannot be combined with imageAvailable or aboutActor. " +
            "Vocabulary labels are bilingual (English and Dutch); try the Dutch term if English returns no results " +
            "(e.g. 'fotograaf' instead of 'photographer'). " +
            "For proximity search, use nearPlace with a place name, or nearLat/nearLon with coordinates for arbitrary locations."
          : ""),
      inputSchema: z.object({
        query: z
          .string()
          .optional()
          .describe(
            "General search term — searches by title (equivalent to the title parameter). For more targeted results, use the specific field parameters instead (creator, description, subject, etc.)"
          ),
        title: z
          .string()
          .optional()
          .describe("Search by artwork title, matching against all title variants (brief, full, former × EN/NL). Requires vocabulary DB. For quick title lookups via the Search API (brief titles only), use the query parameter instead."),
        creator: z
          .string()
          .optional()
          .describe("Search by artist name, e.g. 'Rembrandt van Rijn'"),
        aboutActor: z
          .string()
          .optional()
          .describe(
            "Search for artworks depicting or about a person (not the creator). E.g. 'Willem van Oranje'. " +
            "Broader recall than depictedPerson — tolerant of cross-language name forms " +
            "(e.g. 'Louis XIV' finds 'Lodewijk XIV') and fuzzy name matching, but not combinable " +
            "with vocabulary filters (subject, depictedPlace, etc.). Uses the Search API. " +
            "depictedPerson is usually the better first choice (precise, combinable, with automatic " +
            "aboutActor fallback on 0 results); use aboutActor directly only for standalone broad person searches."
          ),
        type: z
          .string()
          .optional()
          .describe("Filter by object type: 'painting', 'print', 'drawing', etc."),
        material: z
          .string()
          .optional()
          .describe("Filter by material: 'canvas', 'paper', 'wood', etc."),
        technique: z
          .string()
          .optional()
          .describe("Filter by technique: 'oil painting', 'etching', etc."),
        creationDate: z
          .string()
          .optional()
          .describe(
            "Filter by creation date. Exact year ('1642') or wildcard ('16*' for 1600s, '164*' for 1640s)."
          ),
        description: z
          .string()
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
            "If true, only return artworks that have a digital image available. Not supported in vocabulary-based searches."
          ),
        // Vocabulary-backed params
        ...(vocabAvailable
          ? {
              subject: z
                .string()
                .min(1)
                .optional()
                .describe(
                  "PRIMARY parameter for concept or thematic searches — use this first, before description or curatorialNarrative. " +
                  "Searches 831K artworks by subject matter (Iconclass themes, depicted scenes). " +
                  "Exact word matching, no stemming — 'cat' won't match 'cats', 'crucifixion' won't match 'crucified'. " +
                  "If a subject query returns 0 results, try variant word forms (singular/plural, nominalized) " +
                  "or use lookup_iconclass to find the canonical Iconclass notation code for more reliable matching. " +
                  "Also covers historical events using Dutch labels (e.g. 'Tweede Wereldoorlog', 'Tachtigjarige Oorlog'). " +
                  "Subject matching does not distinguish primary from incidental/decorative subjects — " +
                  "a mortar with an Annunciation relief will match 'Annunciation'. Combine with type (e.g. type: 'painting') to filter. " +
                  "Requires vocabulary DB."
                ),
              iconclass: z
                .string()
                .min(1)
                .optional()
                .describe(
                  "Exact Iconclass notation code (e.g. '34B11' for dogs, '73D82' for Crucifixion). More precise than subject (exact code vs. label text) — use lookup_iconclass to discover codes by concept. Requires vocabulary DB."
                ),
              depictedPerson: z
                .string()
                .min(1)
                .optional()
                .describe(
                  "Search for artworks depicting a specific person by name (e.g. 'Willem van Oranje'). " +
                  "Matches against 210K name variants including historical forms. Combinable with all vocabulary filters. " +
                  "Falls back to aboutActor (Search API) automatically when no results are found. Requires vocabulary DB."
                ),
              depictedPlace: z
                .string()
                .min(1)
                .optional()
                .describe(
                  "Search for artworks depicting a specific place by name (e.g. 'Amsterdam'). " +
                  "Supports multi-word and ambiguous place names with geo-disambiguation (e.g. 'Oude Kerk Amsterdam'). " +
                  "Requires vocabulary DB."
                ),
              productionPlace: z
                .string()
                .min(1)
                .optional()
                .describe(
                  "Search for artworks produced in a specific place (e.g. 'Delft'). " +
                  "Supports multi-word and ambiguous place names with geo-disambiguation (e.g. 'Paleis van Justitie Den Haag'). " +
                  "Requires vocabulary DB."
                ),
              birthPlace: z
                .string()
                .min(1)
                .optional()
                .describe(
                  "Search by artist's birth place (e.g. 'Amsterdam'). Requires vocabulary DB."
                ),
              deathPlace: z
                .string()
                .min(1)
                .optional()
                .describe(
                  "Search by artist's death place (e.g. 'Paris'). Requires vocabulary DB."
                ),
              profession: z
                .string()
                .min(1)
                .optional()
                .describe(
                  "Search by artist's profession (e.g. 'painter', 'draughtsman', 'sculptor'). Requires vocabulary DB."
                ),
              collectionSet: z
                .string()
                .min(1)
                .optional()
                .describe(
                  "Search for artworks in curated collection sets by name (e.g. 'Rembrandt', 'Japanese'). " +
                  "Use list_curated_sets to discover available sets. Requires vocabulary DB."
                ),
              license: z
                .string()
                .min(1)
                .optional()
                .describe(
                  "Filter by license/rights. Common values: 'publicdomain', 'zero' (CC0), 'by' (CC BY). " +
                  "Matches against the rights URI. Requires vocabulary DB."
                ),
              inscription: z
                .string()
                .min(1)
                .optional()
                .describe(
                  "Full-text search on inscription texts (~500K artworks — signatures, mottoes, dates on the object surface, not conceptual content). " +
                  "Exact word matching, no stemming. E.g. 'Rembrandt f.' for signed works, Latin phrases. Requires vocabulary DB."
                ),
              provenance: z
                .string()
                .min(1)
                .optional()
                .describe(
                  "Full-text search on provenance/ownership history (e.g. 'Six' for the Six collection). " +
                  "Exact word matching, no stemming. Requires vocabulary DB."
                ),
              creditLine: z
                .string()
                .min(1)
                .optional()
                .describe(
                  "Full-text search on credit/donor lines (e.g. 'Drucker' for Drucker-Fraser bequest). " +
                  "Exact word matching, no stemming. Requires vocabulary DB."
                ),
              curatorialNarrative: z
                .string()
                .min(1)
                .optional()
                .describe(
                  "Full-text search on curatorial narrative (~14K artworks with museum wall text). " +
                  "Best for art-historical interpretation, exhibition context, and scholarly commentary — " +
                  "content written by curators that goes beyond what structured vocabulary captures. " +
                  "Exact word matching, no stemming. For broad concept searches, start with subject instead. Requires vocabulary DB."
                ),
              productionRole: z
                .string()
                .min(1)
                .optional()
                .describe(
                  "Search by production role (e.g. 'painter', 'printmaker', 'after painting by'). " +
                  "Covers craft roles and relational attribution, NOT attribution qualifiers " +
                  "(workshop of, follower of, circle of — these are not indexed). Requires vocabulary DB."
                ),
              minHeight: z
                .number()
                .optional()
                .describe(
                  "Minimum height in centimeters. Requires vocabulary DB."
                ),
              maxHeight: z
                .number()
                .optional()
                .describe(
                  "Maximum height in centimeters. Requires vocabulary DB."
                ),
              minWidth: z
                .number()
                .optional()
                .describe(
                  "Minimum width in centimeters. Requires vocabulary DB."
                ),
              maxWidth: z
                .number()
                .optional()
                .describe(
                  "Maximum width in centimeters. Requires vocabulary DB."
                ),
              nearPlace: z
                .string()
                .min(1)
                .optional()
                .describe(
                  "Search for artworks related to places near a named location (e.g. 'Leiden'). " +
                  "Supports multi-word place names with geo-disambiguation (e.g. 'Oude Kerk Amsterdam' resolves to the Oude Kerk in Amsterdam). " +
                  "Searches both depicted and production places within the specified radius. " +
                  "Requires vocabulary DB with geocoded places."
                ),
              nearLat: z
                .number()
                .min(-90)
                .max(90)
                .optional()
                .describe(
                  "Latitude for coordinate-based proximity search (-90 to 90). Use with nearLon. " +
                  "Alternative to nearPlace for searching near arbitrary locations. Requires vocabulary DB with geocoded places."
                ),
              nearLon: z
                .number()
                .min(-180)
                .max(180)
                .optional()
                .describe(
                  "Longitude for coordinate-based proximity search (-180 to 180). Use with nearLat. Requires vocabulary DB with geocoded places."
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
          .describe(`Maximum results to return (1-${RESULTS_MAX}, default ${RESULTS_DEFAULT})`),
        compact: z
          .boolean()
          .default(false)
          .describe(
            "If true, returns only total count and IDs without resolving details (faster). Only applies to Search API queries, not vocabulary-based searches."
          ),
        pageToken: z
          .string()
          .optional()
          .describe("Pagination token from a previous search result. Only applies to Search API queries, not vocabulary-based searches."),
      }).strict(),
      ...withOutputSchema(SearchResultOutput),
    },
    withLogging("search_artwork", async (args) => {
      const argsRecord = args as Record<string, unknown>;

      // Check if any vocabulary param is present -> route through VocabularyDb
      const hasVocabParam = vocabAvailable && vocabParamKeys.some(
        (k) => argsRecord[k] !== undefined
      );

      // Reject incompatible parameter combinations before routing (#27)
      // imageAvailable: false is a no-op — only true triggers the Search API image filter
      if (hasVocabParam) {
        const incompatible = (["imageAvailable", "aboutActor"] as const).filter(
          k => k === "imageAvailable" ? argsRecord[k] === true : argsRecord[k] !== undefined
        );
        if (incompatible.length > 0) {
          const vocabPresent = vocabParamKeys.filter(k => argsRecord[k] !== undefined);
          const hasAboutActor = incompatible.includes("aboutActor");
          const suggestion = hasAboutActor
            ? " Tip: use query instead of title to combine with aboutActor (query stays on the Search API path)."
            : "";
          return errorResponse(
            `${incompatible.join(", ")} cannot be combined with vocabulary filters (${vocabPresent.join(", ")}). ` +
            `Use them separately: ${incompatible.join("/")} route through the Search API, while vocabulary filters use a different search path.` +
            suggestion
          );
        }
      }

      if (hasVocabParam && vocabDb) {
        const vocabArgs: Record<string, unknown> = { maxResults: args.maxResults };
        for (const k of allVocabKeys) {
          if (argsRecord[k] !== undefined) vocabArgs[k] = argsRecord[k];
        }
        // Map query → title for vocab path (query searches by title on Search API too)
        if (argsRecord["query"] && !vocabArgs["title"]) {
          vocabArgs["title"] = argsRecord["query"];
        }
        const result = vocabDb.search(vocabArgs as any);

        // Warn about Search API-only filters silently dropped on the vocab path
        const droppedKeys = (["pageToken", "compact"] as const).filter(
          k => argsRecord[k] !== undefined && argsRecord[k] !== false
        );
        if (droppedKeys.length > 0) {
          result.warnings = [
            ...(result.warnings || []),
            `The following filters are not supported in vocabulary searches and were ignored: ${droppedKeys.join(", ")}.`
          ];
        }

        // Auto-fallback: depictedPerson 0 results → retry via aboutActor on Search API (#22)
        // Only when depictedPerson is the sole vocab-only filter (other filters may have
        // legitimately caused the 0 — retrying without them would give misleading results).
        if (result.results.length === 0 && argsRecord.depictedPerson) {
          const searchApiKeys = ["type", "material", "technique", "creationDate", "creator", "description"] as const;
          const vocabOnlyKeys = vocabParamKeys.filter(
            k => k !== "depictedPerson" && k !== "title" && !(searchApiKeys as readonly string[]).includes(k) && argsRecord[k] !== undefined
          );

          if (vocabOnlyKeys.length === 0) {
            const fallbackParams: SearchParams = {
              aboutActor: argsRecord.depictedPerson as string,
              maxResults: args.maxResults,
            };
            // Forward Search API-compatible filters
            for (const k of searchApiKeys) {
              if (argsRecord[k] !== undefined) (fallbackParams as any)[k] = argsRecord[k];
            }
            // Forward query (title search on the Search API path)
            if (argsRecord["query"]) fallbackParams.query = argsRecord["query"] as string;

            const fallbackResult = await api.searchAndResolve(fallbackParams);

            if (fallbackResult.totalResults > 0) {
              // Enrich with object types from vocab DB
              if (vocabDb) {
                const typeMap = vocabDb.lookupTypes(fallbackResult.results.map(r => r.objectNumber));
                for (const r of fallbackResult.results) {
                  if (!r.type) r.type = typeMap.get(r.objectNumber);
                }
              }

              const enriched = {
                ...fallbackResult,
                source: "aboutActor-fallback" as const,
                warnings: [
                  `depictedPerson:"${argsRecord.depictedPerson}" matched no results in the vocabulary database. ` +
                  `Showing ${fallbackResult.totalResults} results via aboutActor (Search API) instead.`,
                ],
              };

              const header = `${fallbackResult.results.length} results of ${fallbackResult.totalResults} total (aboutActor fallback)`;
              const lines = fallbackResult.results.map((r, i) => formatSearchLine(r, i));
              return structuredResponse(enriched, [header, ...lines].join("\n"));
            }
          }
        }

        const header = `${result.results.length} results` +
          (result.totalResults != null ? ` of ${result.totalResults} total` : '') +
          ` (vocabulary search)`;
        const truncationNote = result.totalResults != null && result.totalResults > result.results.length
          ? "\nNote: results are in catalogue order, not ranked by relevance. Add filters to narrow the set, or use semantic_search for concept-ranked results."
          : "";
        const lines = result.results.map((r, i) => formatSearchLine(r, i));
        return structuredResponse(result, [header, ...lines].join("\n") + truncationNote);
      }

      // Default: use Search API
      const result = args.compact
        ? await api.searchCompact(args)
        : await api.searchAndResolve(args);

      // Enrich resolved results with object type from vocab DB (free batch lookup)
      if (!args.compact && "results" in result && vocabDb) {
        const typeMap = vocabDb.lookupTypes(result.results.map(r => r.objectNumber));
        for (const r of result.results) {
          if (!r.type) r.type = typeMap.get(r.objectNumber);
        }
      }

      // Hint when creator search returns 0 — the API is accent-sensitive
      if (result.totalResults === 0 && args.creator) {
        const withWarnings = {
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
        ? "\nNote: results are not ranked by relevance. Use nextPageToken to see more, add filters to narrow, or use semantic_search for concept-ranked results."
        : "";
      const lines = ("results" in result ? result.results : []).map((r, i) => formatSearchLine(r, i));
      return structuredResponse(result, [header, ...lines].join("\n") + truncationNote);
    })
  );

  // ── get_artwork_details ─────────────────────────────────────────

  server.registerTool(
    "get_artwork_details",
    {
      title: "Get Artwork Details",
      description:
        "Get comprehensive details about a specific artwork by its object number (e.g. 'SK-C-5' for The Night Watch). " +
        "Returns 24 metadata categories including titles, creator, date, description, curatorial narrative, " +
        "dimensions (text + structured), materials, object type, production details, provenance, " +
        "credit line, inscriptions, license, related objects, collection sets, plus reference and location metadata. " +
        "Also reports the bibliography count — use get_artwork_bibliography for full citations. " +
        "The relatedObjects field contains Linked Art URIs — use resolve_uri to get full details of related works. " +
        "Use this tool on vocabulary search results to check dates, dimensions, or other fields not available in the search response.",
      inputSchema: z.object({
        objectNumber: z
          .string()
          .describe(
            "The object number of the artwork (e.g. 'SK-C-5', 'SK-A-3262')"
          ),
      }).strict(),
      ...withOutputSchema(ArtworkDetailOutput),
    },
    withLogging("get_artwork_details", async (args) => {
      const { uri, object } = await api.findByObjectNumber(args.objectNumber);
      const detail = await api.toDetailEnriched(object, uri);
      return structuredResponse(detail);
    })
  );

  // ── resolve_uri ────────────────────────────────────────────────

  server.registerTool(
    "resolve_uri",
    {
      title: "Resolve URI",
      description:
        "Resolve a Linked Art URI to full artwork details. " +
        "Use this when you have a URI from relatedObjects or other tool output " +
        "and want to learn what that object is. Returns the same enriched detail as get_artwork_details.",
      inputSchema: z.object({
        uri: z
          .string()
          .url()
          .describe(
            "A Linked Art URI (e.g. 'https://id.rijksmuseum.nl/200666460')"
          ),
      }).strict(),
      ...withOutputSchema(ArtworkDetailOutput),
    },
    withLogging("resolve_uri", async (args) => {
      const object = await api.resolveObject(args.uri);
      const detail = await api.toDetailEnriched(object, args.uri);
      return structuredResponse(detail);
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
      const result = await api.getBibliography(object, {
        limit: args.full ? 0 : 5,
      });
      return structuredResponse(result);
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
      const { object } = await api.findByObjectNumber(args.objectNumber);
      const imageInfo = await api.getImageInfo(object);

      if (!imageInfo) {
        return structuredResponse({
          objectNumber: args.objectNumber,
          error: "No image available for this artwork",
        }, "No image available for this artwork");
      }

      const title = RijksmuseumApiClient.parseTitle(object);
      const objectNumber = RijksmuseumApiClient.parseObjectNumber(object);

      if (httpPort) {
        const baseUrl = process.env.PUBLIC_URL || `http://localhost:${httpPort}`;
        imageInfo.viewerUrl = `${baseUrl}/viewer?iiif=${encodeURIComponent(imageInfo.iiifId)}&title=${encodeURIComponent(title)}`;
      }

      const viewUUID = randomUUID();
      viewerQueues.set(viewUUID, {
        commands: [],
        createdAt: Date.now(),
        lastAccess: Date.now(),
        lastPolledAt: Date.now(),
        objectNumber,
        imageWidth: imageInfo.width,
        imageHeight: imageInfo.height,
        activeOverlays: [],
      });

      const { thumbnailUrl, iiifId, fullUrl, ...imageData } = imageInfo;
      const viewerData = {
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

      return structuredResponse(viewerData);
    })
  );

  // ── inspect_artwork_image ──────────────────────────────────────────

  server.registerTool(
    "inspect_artwork_image",
    {
      title: "Inspect Artwork Image",
      description:
        "Fetch an artwork image or region as base64 for direct visual analysis. " +
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
        "This two-pass approach (broad inspect → close-up verify → overlay) produces " +
        "accurate placements; estimating coordinates from a full-image overview alone introduces " +
        "5–10% error for small or peripheral subjects due to limited pixel resolution.\n\n" +
        "Optionally, use navigate_viewer afterwards to zoom the viewer or add labeled " +
        "overlays highlighting regions of interest for the user.\n\n" +
        "This tool does not interact with the viewer session — calling it does not extend or affect the viewUUID lifetime.",
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
      }).strict(),
      ...withOutputSchema(CropImageOutput),
    },
    withLogging("inspect_artwork_image", async (args) => {
      const cropError = (error: string) => ({
        ...structuredResponse({
          objectNumber: args.objectNumber,
          region: args.region,
          requestedSize: args.size,
          rotation: args.rotation,
          quality: args.quality,
          error,
        }, error),
        isError: true as const,
      });

      try {
        const { object } = await api.findByObjectNumber(args.objectNumber);
        const imageInfo = await api.getImageInfo(object);

        // Refresh viewer TTL for this artwork
        for (const [, q] of viewerQueues) {
          if (q.objectNumber === args.objectNumber) q.lastAccess = Date.now();
        }

        if (!imageInfo) {
          return cropError("No image available for this artwork");
        }

        // Clamp size to region width — iiif.micr.io rejects upscaling.
        // For pct: regions, the IIIF server computes pixel bounds as
        // ceil(start) / floor(end), which can yield a region 1-2px narrower
        // than our floor(width * pct/100) estimate. Subtract 1 to avoid
        // hitting the exact boundary.
        let effectiveSize = args.size;
        if (imageInfo.width) {
          let regionWidth = imageInfo.width;
          const pctMatch = args.region.match(/^pct:([0-9.]+),([0-9.]+),([0-9.]+),([0-9.]+)$/);
          const pxMatch = args.region.match(/^(\d+),(\d+),(\d+),(\d+)$/);
          if (pctMatch) {
            regionWidth = Math.floor(imageInfo.width * parseFloat(pctMatch[3]) / 100) - 1;
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
        const caption = `"${title}" by ${creator} — ${args.objectNumber} (${regionLabel}, ${effectiveSize}px${sizeNote}, ${fetchTimeMs}ms)`;

        const content = [
          { type: "image" as const, data: base64, mimeType },
          { type: "text" as const, text: caption },
        ];

        if (!EMIT_STRUCTURED) return { content };
        return {
          content,
          structuredContent: {
            objectNumber: args.objectNumber,
            region: args.region,
            requestedSize: effectiveSize,
            nativeWidth: imageInfo.width,
            nativeHeight: imageInfo.height,
            rotation: args.rotation,
            quality: args.quality,
            fetchTimeMs,
          } as Record<string, unknown>,
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

  function regionToPixels(region: string, w: number, h: number): string | undefined {
    const m = region.match(/^pct:([0-9.]+),([0-9.]+),([0-9.]+),([0-9.]+)$/);
    if (!m) return undefined;
    const px = Math.round(parseFloat(m[1]) * w / 100);
    const py = Math.round(parseFloat(m[2]) * h / 100);
    const pw = Math.round(parseFloat(m[3]) * w / 100);
    const ph = Math.round(parseFloat(m[4]) * h / 100);
    return `${px},${py},${pw},${ph}`;
  }

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
        "Keep batches under 10 commands per call. The viewer session (viewUUID) remains active as long as " +
        "the viewer is open and polling (~30 minutes after the viewer closes or loses connection).",
      inputSchema: z.object({
        viewUUID: z.string().describe("Viewer UUID from a prior get_artwork_image call"),
        commands: z.array(z.object({
          action: z.enum(["navigate", "add_overlay", "clear_overlays"]),
          region: z.string().optional().describe("IIIF region (required for navigate/add_overlay): 'full', 'square', 'pct:x,y,w,h', or 'x,y,w,h'"),
          label: z.string().optional().describe("Label text for add_overlay"),
          color: z.string().optional().describe("CSS color for add_overlay border (default: orange)"),
        })).min(1).describe("Commands to execute in the viewer, in order"),
      }).strict(),
      ...withOutputSchema(NavigateViewerOutput),
    },
    withLogging("navigate_viewer", async (args) => {
      const queue = viewerQueues.get(args.viewUUID);
      if (!queue) {
        return {
          ...structuredResponse({
            viewUUID: args.viewUUID,
            queued: 0,
            error: "No active viewer for this UUID",
          }, "No active viewer for this UUID — open an artwork with get_artwork_image first"),
          isError: true as const,
        };
      }

      // Validate region on commands that require it
      for (const cmd of args.commands) {
        if (cmd.action === "navigate" || cmd.action === "add_overlay") {
          if (!cmd.region) {
            return {
              ...structuredResponse({
                viewUUID: args.viewUUID,
                queued: 0,
                error: `'${cmd.action}' requires a region. Use 'full', 'square', 'x,y,w,h', or 'pct:x,y,w,h'.`,
              }),
              isError: true as const,
            };
          }
          if (!IIIF_REGION_RE.test(cmd.region)) {
            return {
              ...structuredResponse({
                viewUUID: args.viewUUID,
                queued: 0,
                error: `Invalid region '${cmd.region}'. Use 'full', 'square', 'x,y,w,h', or 'pct:x,y,w,h'.`,
              }),
              isError: true as const,
            };
          }
        }
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

      const viewerConnected = (Date.now() - queue.lastPolledAt) < 5000;

      return structuredResponse({
        viewUUID: args.viewUUID,
        queued: args.commands.length,
        imageWidth: queue.imageWidth,
        imageHeight: queue.imageHeight,
        overlays: overlayDetails?.length ? overlayDetails : undefined,
        viewerConnected,
        currentOverlays: queue.activeOverlays.length ? queue.activeOverlays : undefined,
      });
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
      if (!queue) return structuredResponse({ commands: [] });
      queue.lastAccess = Date.now();
      queue.lastPolledAt = Date.now();
      const commands = queue.commands.splice(0);  // drain
      return structuredResponse({ commands });
    }
  );

  // ── get_artist_timeline ─────────────────────────────────────────

  server.registerTool(
    "get_artist_timeline",
    {
      title: "Get Artist Timeline",
      description:
        "Generate a chronological timeline of an artist's works in the Rijksmuseum collection. " +
        "Searches by creator name, resolves each result, and sorts by creation date. " +
        "Each work includes an objectNumber for use with get_artwork_details or get_artwork_image.",
      inputSchema: z.object({
        artist: z
          .string()
          .describe("Artist name, e.g. 'Rembrandt van Rijn', 'Johannes Vermeer'"),
        maxWorks: z
          .number()
          .int()
          .min(1)
          .max(RESULTS_MAX)
          .default(RESULTS_DEFAULT)
          .describe(`Maximum works to include (1-${RESULTS_MAX}, default ${RESULTS_DEFAULT})`),
      }).strict(),
      ...withOutputSchema(TimelineOutput),
    },
    withLogging("get_artist_timeline", async (args) => {
      const result = await api.searchAndResolve({
        creator: args.artist,
        maxResults: args.maxWorks,
      });

      const parseYear = (s: string): number => parseInt(s, 10) || 0;
      const timeline = result.results
        .map(({ date, ...rest }) => ({ year: date, ...rest }))
        .sort((a, b) => parseYear(a.year) - parseYear(b.year));

      const warnings = result.totalResults === 0
        ? ["No results found. The Rijksmuseum Search API is accent-sensitive for creator names " +
           "(e.g. 'Eugène Brands' not 'Eugene Brands'). Try the exact accented spelling."]
        : undefined;

      const response = {
        artist: args.artist,
        totalWorksInCollection: result.totalResults,
        timeline,
        ...(warnings ? { warnings } : {}),
      };

      const years = timeline.map(t => parseYear(t.year)).filter(y => y > 0);
      const rangeStr = years.length > 0 ? `, ${years[0]}–${years[years.length - 1]}` : '';
      const header = `${timeline.length} works by ${args.artist}` +
        (result.totalResults > 0 ? ` (${result.totalResults} total in collection)` : '') +
        rangeStr;
      const lines = timeline.map((t, i) => formatTimelineLine(t, i));
      return structuredResponse(response, [header, ...lines].join("\n"));
    })
  );

  // ── open_in_browser ─────────────────────────────────────────────

  server.registerTool(
    "open_in_browser",
    {
      title: "Open in Browser",
      description:
        "Open a URL in the user's default web browser. Useful for opening an artwork's Rijksmuseum collection page, " +
        "in environments where the interactive image viewer called with get_artwork_image is not available.",
      inputSchema: z.object({
        url: z
          .string()
          .url()
          .describe("The URL to open in the browser"),
      }).strict(),
      ...withOutputSchema(OpenInBrowserOutput),
    },
    withLogging("open_in_browser", async (args) => {
      try {
        await SystemIntegration.openInBrowser(args.url);
        return structuredResponse(
          { opened: true, url: args.url },
          `Opened in browser: ${args.url}`
        );
      } catch (err) {
        const message = `Failed to open browser: ${err instanceof Error ? err.message : String(err)}`;
        return {
          ...structuredResponse(
            { opened: false, url: args.url, error: message },
            message
          ),
          isError: true as const,
        };
      }
    })
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
        query: z
          .string()
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

      return structuredResponse({
        totalSets: sets.length,
        ...(q ? { filteredFrom: allSets.length, query: args.query } : {}),
        sets,
      });
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
        resumptionToken: z
          .string()
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

      return paginatedResponse(result, args.maxResults, "totalInSet", "browse_set");
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
        until: z
          .string()
          .optional()
          .describe(
            "End date in ISO 8601 format (defaults to now)"
          ),
        setSpec: z
          .string()
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
        resumptionToken: z
          .string()
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
      return paginatedResponse(result, args.maxResults, "totalChanges", "get_recent_changes", extra);
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
          query: z
            .string()
            .optional()
            .describe(
              "Text search across Iconclass labels and keywords in all 13 languages. " +
              "Exact word matching (no stemming): 'crucifixion' won't match 'crucified' — try word variants if needed. " +
              "Returns matching notations ranked by Rijksmuseum artwork count."
            ),
          notation: z
            .string()
            .optional()
            .describe(
              "Browse a specific Iconclass notation (e.g. '31A33' for smell). " +
              "Returns the entry with its hierarchy and direct children."
            ),
          semanticQuery: z
            .string()
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
          return structuredResponse(result, [header, ...lines].join("\n"));
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
          return structuredResponse(result, [header, ...lines].join("\n"));
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
        return structuredResponse(result, sections.join("\n"));
      })
    );
  }

  // ── semantic_search ──────────────────────────────────────────────

  if (embeddingsDb?.available && embeddingModel?.available) {
    server.registerTool(
      "semantic_search",
      {
        title: "Semantic Artwork Search",
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
          "Filter notes: Use type: 'painting' to restrict to the paintings collection. " +
          "Do NOT use technique: 'painting' for this purpose — it matches painted decoration on any object type " +
          "(ceramics, textiles, frames) and will return unexpected results.\n\n" +
          "Painting queries — two-step pattern: Paintings are systematically underrepresented in semantic results " +
          "because prints and drawings have denser subject tagging. For queries where paintings are the expected " +
          "result type, ALWAYS combine semantic_search with a follow-up search_artwork(type: 'painting', subject: ...) " +
          "or search_artwork(type: 'painting', creator: ...) call — do not wait to observe skew, as the absence " +
          "of key works is not visible in the returned results.\n\n" +
          "Multilingual: queries in Dutch, German, French and other languages are supported but may benefit " +
          "from a wider result window or English reformulation if canonical works are missing.",
        inputSchema: z.object({
          query: z.string().describe("Natural language concept query (e.g. 'winter landscape with ice skating')"),
          type: z.string().optional().describe("Filter by object type (e.g. 'painting', 'print')"),
          material: z.string().optional().describe("Filter by material (e.g. 'canvas', 'paper')"),
          technique: z.string().optional().describe("Filter by technique (e.g. 'etching', 'oil painting')"),
          creationDate: z.string().optional().describe("Filter by date — exact year ('1642') or wildcard ('16*')"),
          creator: z.string().optional().describe("Filter by artist name"),
          maxResults: z.number().int().min(1).max(100).default(25).optional()
            .describe("Number of results to return (default 25)"),
        }).strict(),
        ...withOutputSchema(SemanticSearchOutput),
      },
      withLogging("semantic_search", async (args) => {
        const maxResults = args.maxResults ?? RESULTS_DEFAULT;

        // 1. Embed query text
        const queryVec = await embeddingModel!.embed(args.query);

        // 2. Choose search path based on filters
        const hasFilters = args.type || args.material || args.technique || args.creationDate || args.creator;
        let candidates: SemanticSearchResult[];
        let filtersApplied = false;
        const warnings: string[] = [];

        if (hasFilters && vocabDb?.available) {
          // FILTERED PATH: pre-filter via vocab DB, then distance-rank
          const candidateArtIds = vocabDb.filterArtIds({
            type: args.type,
            material: args.material,
            technique: args.technique,
            creationDate: args.creationDate,
            creator: args.creator,
          });
          if (candidateArtIds === null) {
            // DB lacks integer mappings (text-schema) — fall back to pure KNN
            candidates = embeddingsDb!.search(queryVec, maxResults);
            warnings.push("Metadata filters ignored: vocabulary DB does not support filtered search. Results ranked by semantic similarity only.");
          } else if (candidateArtIds.length === 0) {
            return structuredResponse(
              { searchMode: "semantic+filtered", query: args.query, returnedCount: 0, results: [],
                warnings: ["No artworks match the specified filters."] },
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
              if (info.dateEarliest != null) {
                date = info.dateEarliest === info.dateLatest
                  ? String(info.dateEarliest)
                  : `${info.dateEarliest}–${info.dateLatest}`;
              }
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
        const data = {
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
        "Generate a chronological timeline of an artist's works in the collection. " +
        "Click on the artist's name in the image viewer to copy it. " +
        `Note: limited to ${RESULTS_MAX} works maximum — for prolific artists this is a small sample.`,
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
              `Use the get_artist_timeline tool with artist="${args.artist}"` +
              `${args.maxWorks ? ` and maxWorks=${args.maxWorks}` : ""} to get the data.\n\n` +
              `Note: the tool returns at most ${RESULTS_MAX} works. For prolific artists, this is a small sample of their collection.\n\n` +
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

}
