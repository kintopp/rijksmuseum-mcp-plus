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
import { RijksmuseumApiClient } from "./api/RijksmuseumApiClient.js";
import { OaiPmhClient } from "./api/OaiPmhClient.js";
import { VocabularyDb } from "./api/VocabularyDb.js";
import { IconclassDb } from "./api/IconclassDb.js";
import { EmbeddingsDb, type SemanticSearchResult } from "./api/EmbeddingsDb.js";
import { EmbeddingModel } from "./api/EmbeddingModel.js";
import { TOP_100_SET } from "./types.js";
import { UsageStats } from "./utils/UsageStats.js";
import { SystemIntegration } from "./utils/SystemIntegration.js";

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
        const errResult: Record<string, unknown> = {
          content: [{ type: "text" as const, text: `Error in ${toolName}: ${error}` }],
          isError: true,
          ...(EMIT_STRUCTURED && { structuredContent: { error } }),
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
  registerPrompts(server, apiClient, oaiClient);

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
  source: z.enum(["search_api", "vocabulary"]).optional(),
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
  results: z.array(IconclassEntryShape).optional(),
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
    "nearPlace", "nearLat",
    "title",
  ] as const;
  // nearPlaceRadius, nearLon excluded: their Zod defaults/pairing would trigger
  // vocab routing on every query. Forwarded separately via allVocabKeys.

  // Keys that cross both paths: forwarded to vocab DB when a vocab param triggers routing
  const crossFilterKeys = ["material", "technique", "type", "creator"] as const;
  const hybridKeys = ["creationDate"] as const;
  const allVocabKeys = [...vocabParamKeys, "nearLon", "nearPlaceRadius", ...crossFilterKeys, ...hybridKeys];

  server.registerTool(
    "search_artwork",
    {
      title: "Search Artwork",
      description:
        "Search the Rijksmuseum collection. Returns artwork summaries with titles, creators, and dates. " +
        "At least one search filter is required. " +
        "Use specific filters for best results — there is no general full-text search across all metadata fields. " +
        "For concept or thematic searches (e.g. 'winter landscape', 'smell', 'crucifixion'), " +
        "ALWAYS start with subject — it searches 831K artworks tagged with structured Iconclass vocabulary " +
        "and has by far the highest recall for conceptual queries. " +
        "Use description for cataloguer observations (e.g. compositional details, specific motifs noted by specialists); " +
        "use curatorialNarrative for curatorial interpretation and art-historical context. " +
        "These three fields search different text corpora and can return complementary results. " +
        "Each result includes an objectNumber for use with get_artwork_details (full metadata), " +
        "get_artwork_image (deep-zoom viewer), or get_artwork_bibliography (scholarly references)." +
        (vocabAvailable
          ? " Vocabulary-based filters (subject, iconclass, depictedPerson, depictedPlace, productionPlace, " +
            "birthPlace, deathPlace, profession, collectionSet, license, description, inscription, provenance, creditLine, " +
            "curatorialNarrative, productionRole, and dimension filters) " +
            "can be freely combined with each other and with creator, type, material, technique, creationDate, and query. " +
            "Vocabulary filters cannot be combined with imageAvailable. " +
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
            "Uses the Search API. Cannot be combined with vocabulary filters."
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
                  "Exact word matching, no stemming (e.g. 'cat' matches 'cat' but not 'cats'). " +
                  "For variant forms, search separately or use iconclass for precise codes. Requires vocabulary DB."
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
                  "Search for artworks depicting a specific person by name (e.g. 'Willem van Oranje'). Requires vocabulary DB."
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
                  "Exact word matching, no stemming. E.g. 'Rembrandt f.' for signed works, Latin phrases. Requires vocabulary DB v1.0+."
                ),
              provenance: z
                .string()
                .min(1)
                .optional()
                .describe(
                  "Full-text search on provenance/ownership history (e.g. 'Six' for the Six collection). " +
                  "Exact word matching, no stemming. Requires vocabulary DB v1.0+."
                ),
              creditLine: z
                .string()
                .min(1)
                .optional()
                .describe(
                  "Full-text search on credit/donor lines (e.g. 'Drucker' for Drucker-Fraser bequest). " +
                  "Exact word matching, no stemming. Requires vocabulary DB v1.0+."
                ),
              curatorialNarrative: z
                .string()
                .min(1)
                .optional()
                .describe(
                  "Full-text search on curatorial narrative (~14K artworks with museum wall text). " +
                  "Best for art-historical interpretation, exhibition context, and scholarly commentary — " +
                  "content written by curators that goes beyond what structured vocabulary captures. " +
                  "Exact word matching, no stemming. For broad concept searches, start with subject instead. Requires vocabulary DB v1.0+."
                ),
              productionRole: z
                .string()
                .min(1)
                .optional()
                .describe(
                  "Search by production role (e.g. 'painter', 'printmaker', 'attributed to'). " +
                  "Requires vocabulary DB v1.0+."
                ),
              minHeight: z
                .number()
                .optional()
                .describe(
                  "Minimum height in centimeters. Requires vocabulary DB v1.0+."
                ),
              maxHeight: z
                .number()
                .optional()
                .describe(
                  "Maximum height in centimeters. Requires vocabulary DB v1.0+."
                ),
              minWidth: z
                .number()
                .optional()
                .describe(
                  "Minimum width in centimeters. Requires vocabulary DB v1.0+."
                ),
              maxWidth: z
                .number()
                .optional()
                .describe(
                  "Maximum width in centimeters. Requires vocabulary DB v1.0+."
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
      if (hasVocabParam) {
        const incompatible = (["imageAvailable", "aboutActor"] as const).filter(
          k => argsRecord[k] !== undefined
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

        const header = `${result.results.length} results` +
          (result.totalResults != null ? ` of ${result.totalResults} total` : '') +
          ` (vocabulary search)`;
        const lines = result.results.map((r, i) => formatSearchLine(r, i));
        return structuredResponse(result, [header, ...lines].join("\n"));
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

      const header = `${result.totalResults} results` +
        (args.creator ? ` for creator "${args.creator}"` : '') +
        (result.nextPageToken ? ` (page token: ${result.nextPageToken})` : '');
      const lines = ("results" in result ? result.results : []).map((r, i) => formatSearchLine(r, i));
      return structuredResponse(result, [header, ...lines].join("\n"));
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
    },
    withLogging("resolve_uri", async (args) => {
      const object = await api.resolveObject(args.uri);
      const detail = await api.toDetailEnriched(object, args.uri);
      return jsonResponse(detail);
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
        "Do not construct IIIF image URLs manually.",
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
      };

      return structuredResponse(viewerData);
    })
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
        "Open a URL in the user's default web browser. Useful for opening an artwork's Rijksmuseum collection page, where a high-resolution image can be downloaded.",
      inputSchema: z.object({
        url: z
          .string()
          .url()
          .describe("The URL to open in the browser"),
      }).strict(),
    },
    withLogging("open_in_browser", async (args) => {
      try {
        await SystemIntegration.openInBrowser(args.url);
        return {
          content: [
            {
              type: "text",
              text: `Opened in browser: ${args.url}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to open browser: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
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
    },
    withLogging("list_curated_sets", async (args) => {
      const allSets = await oai.listSets();
      const q = args.query?.toLowerCase();
      const sets = q
        ? allSets.filter((s) => s.name.toLowerCase().includes(q))
        : allSets;

      return jsonResponse({
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

  if (iconclassDb?.available) {
    const db = iconclassDb; // narrowed to non-null for the closure
    server.registerTool(
      "lookup_iconclass",
      {
        title: "Lookup Iconclass",
        description:
          "Search or browse the Iconclass classification system — a universal vocabulary for art subject matter (~40K notations across 13 languages). " +
          "Use this to discover Iconclass notation codes by concept (e.g. 'smell', 'crucifixion', 'Löwe'), " +
          "then pass the notation to search_artwork's iconclass parameter for precise results. " +
          "Artwork counts (rijksCount) are pre-computed and approximate; use search_artwork with the notation code for current results. " +
          "Provide either query (text search) or notation (browse subtree), not both.",
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
        if (args.query === undefined && args.notation === undefined) {
          return errorResponse("Either query or notation is required.");
        }
        if (args.query !== undefined && args.notation !== undefined) {
          return errorResponse("Provide either query or notation, not both.");
        }

        // Search mode
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
    const GROUNDING_COUNT = 5;
    const SOURCE_TEXT_WORD_CAP = 150;

    server.registerTool(
      "semantic_search",
      {
        title: "Semantic Artwork Search",
        description:
          "Find artworks by meaning, concept, or theme using natural language. " +
          "Returns top results ranked by semantic similarity with source text for grounding — " +
          "use this to explain why results are relevant or to flag false positives. " +
          "Best for: concepts/themes ('vanitas symbolism'), cross-language queries, " +
          "or when search_artwork returned 0 results. " +
          "Not for queries expressible as structured metadata (specific artists, dates, places, materials) — " +
          "use search_artwork for those. Filters (type, material, technique, creationDate, creator) " +
          "narrow candidates before semantic ranking.",
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
            if (filtered.warning) warnings.push(filtered.warning);
          }
        } else {
          // PURE KNN PATH: vec0 virtual table
          candidates = embeddingsDb!.search(queryVec, maxResults);
        }

        // 3. Batch-resolve metadata from vocab DB (single query, not per-result)
        const objectNumbers = candidates.map(c => c.objectNumber);
        const typeMap = vocabDb?.available ? vocabDb.lookupTypes(objectNumbers) : new Map<string, string>();

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
            sourceText: truncateWords(c.sourceText ?? undefined, SOURCE_TEXT_WORD_CAP) || undefined,
            url: `https://www.rijksmuseum.nl/en/collection/${c.objectNumber}`,
          };
        });

        // 4. Build two-tier text channel
        const mode = hasFilters ? "semantic+filtered" : "semantic";
        const header = `${Math.min(GROUNDING_COUNT, results.length)} semantic matches for "${args.query}" ` +
          `(${results.length} results, ${mode} mode)`;

        const groundedLines = results.slice(0, GROUNDING_COUNT).map((r, i) => {
          const oneLiner = formatSearchLine(r, i) + `  [${r.similarityScore.toFixed(2)}]`;
          const sourceText = r.sourceText; // already truncated in results.map()
          return sourceText ? `${oneLiner}\n   ${sourceText}` : oneLiner;
        });

        const compactLines = results.slice(GROUNDING_COUNT).map((r, i) =>
          formatSearchLine(r, i + GROUNDING_COUNT) + `  [${r.similarityScore.toFixed(2)}]`
        );

        const textParts = [header];
        if (groundedLines.length) textParts.push("\n── Top results with context ──\n" + groundedLines.join("\n\n"));
        if (compactLines.length) textParts.push("\n── More results ──\n" + compactLines.join("\n"));

        // 5. Return dual-channel response
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

/** Truncate text to maxWords, appending "…" if truncated. */
function truncateWords(text: string | undefined, maxWords: number): string {
  if (!text) return "";
  const words = text.split(/\s+/);
  if (words.length <= maxWords) return text;
  return words.slice(0, maxWords).join(" ") + "…";
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

function registerPrompts(server: McpServer, api: RijksmuseumApiClient, oai: OaiPmhClient): void {
  server.registerPrompt(
    "analyse-artwork",
    {
      title: "Analyse Artwork",
      description:
        "Visually analyse an artwork: retrieves its high-resolution image together with key metadata " +
        "(title, creator, date, description, technique, dimensions, materials, curatorial narrative, inscriptions, " +
        "depicted persons, depicted places, iconographic subjects, and production place). " +
        "The image is returned directly so the model can ground its analysis in what it sees.",
      argsSchema: {
        objectNumber: z
          .string()
          .describe("The object number of the artwork (e.g. 'SK-C-5')"),
        imageWidth: z
          .string()
          .optional()
          .describe("Image width in pixels (default: 1200)"),
      },
    },
    async (args) => {
      const parsed = parseInt(args.imageWidth ?? "", 10) || 1200;
      const width = Math.min(Math.max(parsed, 200), 2000);
      const { uri, object } = await api.findByObjectNumber(args.objectNumber);

      // Resolve image and full metadata in parallel
      const [imageInfo, detail] = await Promise.all([
        api.getImageInfo(object, width),
        api.toDetailEnriched(object, uri),
      ]);

      if (!imageInfo) {
        return {
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text: `No image is available for artwork ${args.objectNumber}.`,
              },
            },
          ],
        };
      }

      let base64: string;
      try {
        base64 = await api.fetchThumbnailBase64(imageInfo.iiifId, width);
      } catch {
        return {
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text: `Image could not be fetched for artwork ${args.objectNumber}. The IIIF server may be temporarily unavailable.`,
              },
            },
          ],
        };
      }

      // Build concise metadata context for the LLM
      const labels = (items: { label: string }[]): string =>
        items.map((i) => i.label).join(", ");

      const metaEntries: [string, string | undefined][] = [
        ["Title", detail.title],
        ["Creator", detail.creator],
        ["Date", detail.date || undefined],
        ["Description", detail.description ?? undefined],
        ["Technique", detail.techniqueStatement ?? undefined],
        ["Dimensions", detail.dimensionStatement ?? undefined],
        ["Materials", labels(detail.materials) || undefined],
        ["Curatorial narrative", detail.curatorialNarrative?.en ?? undefined],
        ["Inscriptions", detail.inscriptions.join(" | ") || undefined],
        ["Depicted persons", labels(detail.subjects.depictedPersons) || undefined],
        ["Depicted places", labels(detail.subjects.depictedPlaces) || undefined],
        ["Iconographic subjects", labels(detail.subjects.iconclass) || undefined],
        ["Production place", detail.production.map((p) => p.place).filter(Boolean).join(", ") || undefined],
      ];
      const meta = metaEntries
        .filter((entry): entry is [string, string] => entry[1] !== undefined)
        .map(([label, value]) => `${label}: ${value}`);

      return {
        messages: [
          {
            role: "user",
            content: {
              type: "image",
              data: base64,
              mimeType: "image/jpeg",
            },
          },
          {
            role: "user",
            content: {
              type: "text",
              text:
                `Examine the composition, colours, figures, setting, technique, and any notable details ` +
                `of "${detail.title}" by ${detail.creator} (${args.objectNumber}).\n\n` +
                `Artwork metadata:\n${meta.join("\n")}\n\n` +
                `Provide a detailed analysis covering:\n` +
                `- Visual composition and artistic technique\n` +
                `- Historical and cultural context\n` +
                `- Significance within the artist's body of work\n` +
                `- Notable details or symbolism`,
            },
          },
        ],
      };
    }
  );

  server.registerPrompt(
    "generate-artist-timeline",
    {
      title: "Artist Timeline",
      description:
        "Generate a chronological timeline of an artist's works in the collection. " +
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

  server.registerPrompt(
    "top-100-artworks",
    {
      title: "Top 100 Artworks",
      description:
        "The Rijksmuseum's official Top 100 masterpieces. Fetches the full curated list " +
        "with titles, creators, dates, types, and object numbers for further exploration.",
      argsSchema: {},
    },
    async () => {
      const records: unknown[] = [];
      const MAX_PAGES = 5;
      let pagesFollowed = 0;
      let result = await oai.listRecords({ set: TOP_100_SET });
      while (true) {
        records.push(...result.records);
        if (!result.resumptionToken || pagesFollowed >= MAX_PAGES) break;
        pagesFollowed++;
        result = await oai.listRecords({ resumptionToken: result.resumptionToken });
      }

      const listing = JSON.stringify(
        { totalArtworks: records.length, artworks: records },
        null,
        2
      );

      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                `Here is the Rijksmuseum's official Top 100 masterpieces collection (${records.length} works):\n\n` +
                `${listing}\n\n` +
                `Each artwork includes an objectNumber that can be used with get_artwork_details, ` +
                `get_artwork_image, or get_artwork_bibliography for deeper exploration.\n\n` +
                `Help the user explore this collection. You can:\n` +
                `- Summarise the highlights and themes\n` +
                `- Group works by artist, period, type, or subject\n` +
                `- Recommend specific works based on the user's interests\n` +
                `- Use the tools above to dive deeper into any individual artwork`,
            },
          },
        ],
      };
    }
  );
}
