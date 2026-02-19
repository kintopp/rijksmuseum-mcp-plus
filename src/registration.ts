import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RijksmuseumApiClient } from "./api/RijksmuseumApiClient.js";
import { OaiPmhClient } from "./api/OaiPmhClient.js";
import { VocabularyDb } from "./api/VocabularyDb.js";
import { UsageStats } from "./utils/UsageStats.js";
import { SystemIntegration } from "./utils/SystemIntegration.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ARTWORK_VIEWER_RESOURCE_URI = "ui://rijksmuseum/artwork-viewer.html";

/** Shared limits for maxResults / maxWorks across search_artwork and get_artist_timeline. */
const RESULTS_DEFAULT = 25;
const RESULTS_MAX = 100;

function jsonResponse(data: unknown): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
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
        throw err;
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
): { content: [{ type: "text"; text: string }] } {
  const records = result.records.slice(0, maxResults);

  return jsonResponse({
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
  });
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
  httpPort?: number,
  stats?: UsageStats
): void {
  registerTools(server, apiClient, oaiClient, vocabDb, httpPort, createLogger(stats));
  registerResources(server);
  registerAppViewerResource(server);
  registerPrompts(server, apiClient, oaiClient);
}

// ─── Tools ──────────────────────────────────────────────────────────

function registerTools(
  server: McpServer,
  api: RijksmuseumApiClient,
  oai: OaiPmhClient,
  vocabDb: VocabularyDb | null,
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
    "inscription", "provenance", "creditLine", "narrative", "productionRole",
    "minHeight", "maxHeight", "minWidth", "maxWidth",
    "nearPlace", "nearLat",
  ] as const;
  // nearPlaceRadius, nearLon excluded: their Zod defaults/pairing would trigger
  // vocab routing on every query. Forwarded separately via allVocabKeys.

  // Keys that cross both paths: forwarded to vocab DB when a vocab param triggers routing
  const crossFilterKeys = ["material", "technique", "type", "creator"] as const;
  const hybridKeys = ["creationDate", "title"] as const;
  const allVocabKeys = [...vocabParamKeys, "nearLon", "nearPlaceRadius", ...crossFilterKeys, ...hybridKeys];

  server.registerTool(
    "search_artwork",
    {
      title: "Search Artwork",
      description:
        "Search the Rijksmuseum collection. Returns artwork summaries with titles, creators, and dates. " +
        "At least one search filter is required. " +
        "Use specific filters for best results — there is no general full-text search across all metadata fields." +
        (vocabAvailable
          ? " Vocabulary-based filters (subject, iconclass, depictedPerson, depictedPlace, productionPlace, " +
            "birthPlace, deathPlace, profession, collectionSet, license, and Tier 2 filters) " +
            "can be freely combined with each other and with creator, type, material, technique, creationDate, title, and query. " +
            "Vocabulary filters cannot be combined with description or imageAvailable. " +
            "Vocabulary labels are bilingual (English and Dutch); try the Dutch term if English returns no results " +
            "(e.g. 'fotograaf' instead of 'photographer'). " +
            "For proximity search, use nearPlace with a place name, or nearLat/nearLon with coordinates for arbitrary locations."
          : ""),
      inputSchema: z.object({
        query: z
          .string()
          .optional()
          .describe(
            "General search term — searches by title. For more targeted results, use the specific field parameters instead (title, creator, description, etc.)"
          ),
        title: z
          .string()
          .optional()
          .describe("Search by artwork title"),
        creator: z
          .string()
          .optional()
          .describe("Search by artist name, e.g. 'Rembrandt van Rijn'"),
        aboutActor: z
          .string()
          .optional()
          .describe(
            "Search for artworks depicting or about a person (not the creator). E.g. 'Willem van Oranje'. " +
            "Uses the Search API. Prefer depictedPerson (vocabulary-based) when available, as it covers more records."
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
          .describe("Search in artwork descriptions (e.g. subject matter, depicted scenes). Not supported in vocabulary-based searches."),
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
                  "Search by subject matter (Iconclass themes, depicted scenes). Uses word-boundary matching (e.g. 'cat' matches 'cat' but not 'Catharijnekerk'). For plural/variant forms, search separately or use iconclass for precise animal/theme codes. Requires vocabulary DB."
                ),
              iconclass: z
                .string()
                .min(1)
                .optional()
                .describe(
                  "Exact Iconclass notation code (e.g. '34B11' for dogs, '73D82' for Crucifixion). Requires vocabulary DB."
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
                  "Search for artworks depicting a specific place by name (e.g. 'Amsterdam'). Requires vocabulary DB."
                ),
              productionPlace: z
                .string()
                .min(1)
                .optional()
                .describe(
                  "Search for artworks produced in a specific place (e.g. 'Delft'). Requires vocabulary DB."
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
                  "Full-text search on inscription texts (e.g. 'Rembrandt f.' for signed works, Latin phrases). " +
                  "Requires vocabulary DB v1.0+."
                ),
              provenance: z
                .string()
                .min(1)
                .optional()
                .describe(
                  "Full-text search on provenance/ownership history (e.g. 'Six' for the Six collection). " +
                  "Requires vocabulary DB v1.0+."
                ),
              creditLine: z
                .string()
                .min(1)
                .optional()
                .describe(
                  "Full-text search on credit/donor lines (e.g. 'Drucker' for Drucker-Fraser bequest). " +
                  "Requires vocabulary DB v1.0+."
                ),
              narrative: z
                .string()
                .min(1)
                .optional()
                .describe(
                  "Full-text search on curatorial narrative (museum wall text — interpretive, art-historical context). " +
                  "Requires vocabulary DB v1.0+."
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
    },
    withLogging("search_artwork", async (args) => {
      const argsRecord = args as Record<string, unknown>;

      // Check if any vocabulary param is present -> route through VocabularyDb
      const hasVocabParam = vocabAvailable && vocabParamKeys.some(
        (k) => argsRecord[k] !== undefined
      );

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

        // Warn about Search API-only filters that were silently dropped
        const searchOnlyKeys = ["aboutActor", "description", "imageAvailable", "compact", "pageToken"] as const;
        const droppedKeys = searchOnlyKeys.filter(k => argsRecord[k] !== undefined);
        if (droppedKeys.length > 0) {
          result.warnings = [
            ...(result.warnings || []),
            `The following filters are not supported in vocabulary searches and were ignored: ${droppedKeys.join(", ")}.`
          ];
        }

        return jsonResponse(result);
      }

      // Default: use Search API
      const result = args.compact
        ? await api.searchCompact(args)
        : await api.searchAndResolve(args);

      // Hint when creator search returns 0 — the API is accent-sensitive
      if (result.totalResults === 0 && args.creator) {
        return jsonResponse({
          ...result,
          warnings: [
            "No results found. The Rijksmuseum Search API is accent-sensitive for creator names " +
            "(e.g. 'Eugène Brands' not 'Eugene Brands'). Try the exact accented spelling.",
          ],
        });
      }

      return jsonResponse(result);
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
        "Use this tool on vocabulary search results to check dates, dimensions, or other fields not available in the search response.",
      inputSchema: z.object({
        objectNumber: z
          .string()
          .describe(
            "The object number of the artwork (e.g. 'SK-C-5', 'SK-A-3262')"
          ),
      }).strict(),
    },
    withLogging("get_artwork_details", async (args) => {
      const { uri, object } = await api.findByObjectNumber(args.objectNumber);
      const detail = await api.toDetailEnriched(object, uri);
      return jsonResponse(detail);
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
        "Get bibliography and scholarly references for an artwork. " +
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
    },
    withLogging("get_artwork_bibliography", async (args) => {
      const { object } = await api.findByObjectNumber(args.objectNumber);
      const result = await api.getBibliography(object, {
        limit: args.full ? 0 : 5,
      });
      return jsonResponse(result);
    })
  );

  // ── get_artwork_image (MCP App with inline IIIF viewer) ────────

  registerAppTool(
    server,
    "get_artwork_image",
    {
      title: "Get Artwork Image",
      description:
        "Get IIIF image information for an artwork, including deep-zoom viewing. " +
        "In supported clients, shows an interactive inline IIIF viewer with zoom/pan/rotate. " +
        "Not all artworks have images available.",
      inputSchema: z.object({
        objectNumber: z
          .string()
          .describe("The object number of the artwork (e.g. 'SK-C-5')"),
      }).strict() as z.ZodTypeAny,
      _meta: {
        ui: { resourceUri: ARTWORK_VIEWER_RESOURCE_URI },
      },
    },
    withLogging("get_artwork_image", async (args) => {
      const { object } = await api.findByObjectNumber(args.objectNumber);
      const imageInfo = await api.getImageInfo(object);

      if (!imageInfo) {
        return jsonResponse({
          objectNumber: args.objectNumber,
          error: "No image available for this artwork",
        });
      }

      const title = RijksmuseumApiClient.parseTitle(object);
      const objectNumber = RijksmuseumApiClient.parseObjectNumber(object);

      if (httpPort) {
        const baseUrl = process.env.PUBLIC_URL || `http://localhost:${httpPort}`;
        imageInfo.viewerUrl = `${baseUrl}/viewer?iiif=${encodeURIComponent(imageInfo.iiifId)}&title=${encodeURIComponent(title)}`;
      }

      const { thumbnailUrl, ...imageData } = imageInfo;
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

      return jsonResponse(viewerData);
    })
  );

  // ── get_artist_timeline ─────────────────────────────────────────

  server.registerTool(
    "get_artist_timeline",
    {
      title: "Get Artist Timeline",
      description:
        "Generate a chronological timeline of an artist's works in the Rijksmuseum collection. " +
        "Searches by creator name, resolves each result, and sorts by creation date.",
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
    },
    withLogging("get_artist_timeline", async (args) => {
      const result = await api.searchAndResolve({
        creator: args.artist,
        maxResults: args.maxWorks,
      });

      const timeline = result.results
        .map(({ date, ...rest }) => ({ year: date, ...rest }))
        .sort((a, b) => (parseInt(a.year, 10) || 0) - (parseInt(b.year, 10) || 0));

      const response: Record<string, unknown> = {
        artist: args.artist,
        totalWorksInCollection: result.totalResults,
        timeline,
      };

      if (result.totalResults === 0) {
        response.warnings = [
          "No results found. The Rijksmuseum Search API is accent-sensitive for creator names " +
          "(e.g. 'Eugène Brands' not 'Eugene Brands'). Try the exact accented spelling.",
        ];
      }

      return jsonResponse(response);
    })
  );

  // ── open_in_browser ─────────────────────────────────────────────

  server.registerTool(
    "open_in_browser",
    {
      title: "Open in Browser",
      description:
        "Open a URL in the user's default web browser. Useful for opening artwork pages, IIIF images, or the deep-zoom viewer.",
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
        "Fetch a high-resolution image of an artwork and analyse its visual content alongside key metadata " +
        "(title, creator, date, technique, dimensions, materials, curatorial narrative, inscriptions, subjects, and production place). " +
        "Returns the image directly so the model can ground its analysis in what it sees.",
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
      let result = await oai.listRecords({ set: "260213" });
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
