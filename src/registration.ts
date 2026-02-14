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
      const start = performance.now();
      try {
        const result = await fn(...args);
        const ms = Math.round(performance.now() - start);
        console.error(JSON.stringify({ tool: toolName, ms, ok: true }));
        stats?.record(toolName, ms, true);
        return result;
      } catch (err) {
        const ms = Math.round(performance.now() - start);
        const error = err instanceof Error ? err.message : String(err);
        console.error(JSON.stringify({ tool: toolName, ms, ok: false, error }));
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
  registerResources(server, apiClient);
  registerAppViewerResource(server);
  registerPrompts(server);
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
  const vocabParamKeys = ["subject", "iconclass", "depictedPerson", "depictedPlace", "productionPlace", "birthPlace", "deathPlace", "profession"] as const;

  server.registerTool(
    "search_artwork",
    {
      description:
        "Search the Rijksmuseum collection. Returns artwork summaries with titles, creators, and dates. " +
        "At least one search filter is required. " +
        "Available filters: query (searches titles), title, creator, aboutActor (depicted person), type, material, technique, creationDate, description, imageAvailable. " +
        "Use specific filters for best results — there is no general full-text search across all metadata fields. " +
        "Use creationDate with wildcards for ranges (e.g. '16*' for 1600s, '164*' for 1640s)." +
        (vocabAvailable
          ? " Additional vocabulary-based filters: subject (text search on subject labels like Iconclass themes), " +
            "iconclass (exact Iconclass notation code, e.g. '34B11' for dogs), " +
            "depictedPerson (text search on depicted person names — more comprehensive than aboutActor), " +
            "depictedPlace (text search on depicted place names), " +
            "productionPlace (text search on production place names), " +
            "birthPlace (search by artist's birth place), " +
            "deathPlace (search by artist's death place), " +
            "profession (search by artist's profession, e.g. 'painter', 'draughtsman'). " +
            "Vocabulary labels are bilingual (English and Dutch); some terms only have Dutch labels, so try the Dutch term if English returns no results (e.g. 'fotograaf' instead of 'photographer'). " +
            "Vocabulary filters can be freely combined with each other and with creator, type, material, and technique for cross-field queries (e.g. subject='dogs' + type='painting', or profession='painter' + birthPlace='Amsterdam'). " +
            "Note: compact and pageToken do not apply to vocabulary-based searches."
          : ""),
      inputSchema: {
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
            "Filter by creation date. Exact year ('1642') or wildcard ('16*' for 1600s, '164*' for 1640s)"
          ),
        description: z
          .string()
          .optional()
          .describe("Search in artwork descriptions (e.g. subject matter, depicted scenes)"),
        imageAvailable: z
          .boolean()
          .optional()
          .describe(
            "If true, only return artworks that have a digital image available"
          ),
        // Vocabulary-backed params
        ...(vocabAvailable
          ? {
              subject: z
                .string()
                .min(1)
                .optional()
                .describe(
                  "Search by subject matter (Iconclass themes, depicted scenes). Text search on subject labels. Requires vocabulary DB."
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
            }
          : {}),
        maxResults: z
          .number()
          .int()
          .min(1)
          .max(25)
          .default(10)
          .describe("Maximum results to return (1-25, default 10)"),
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
      },
    },
    withLogging("search_artwork", async (args) => {
      // Check if any vocabulary param is present -> route through VocabularyDb
      const hasVocabParam = vocabAvailable && vocabParamKeys.some(
        (k) => (args as Record<string, unknown>)[k] !== undefined
      );

      if (hasVocabParam && vocabDb) {
        const crossFilterKeys = ["material", "technique", "type", "creator"] as const;
        const allVocabKeys = [...vocabParamKeys, ...crossFilterKeys];
        const vocabArgs: Record<string, unknown> = { maxResults: args.maxResults };
        for (const k of allVocabKeys) {
          const val = (args as Record<string, unknown>)[k];
          if (val !== undefined) vocabArgs[k] = val;
        }
        return jsonResponse(vocabDb.search(vocabArgs as any));
      }

      // Default: use Search API
      const result = args.compact
        ? await api.searchCompact(args)
        : await api.searchAndResolve(args);
      return jsonResponse(result);
    })
  );

  // ── get_artwork_details ─────────────────────────────────────────

  server.registerTool(
    "get_artwork_details",
    {
      description:
        "Get comprehensive details about a specific artwork by its object number (e.g. 'SK-C-5' for The Night Watch). " +
        "Returns 24 metadata categories including titles, creator, date, description, curatorial narrative, " +
        "dimensions (text + structured), materials, object type, production details, provenance, " +
        "credit line, inscriptions, license, related objects, collection sets, plus reference and location metadata. " +
        "Also reports the bibliography count — use get_artwork_bibliography for full citations.",
      inputSchema: {
        objectNumber: z
          .string()
          .describe(
            "The object number of the artwork (e.g. 'SK-C-5', 'SK-A-3262')"
          ),
      },
    },
    withLogging("get_artwork_details", async (args) => {
      const { uri, object } = await api.findByObjectNumber(args.objectNumber);
      const detail = await api.toDetailEnriched(object, uri);
      return jsonResponse(detail);
    })
  );

  // ── get_artwork_bibliography ───────────────────────────────────

  server.registerTool(
    "get_artwork_bibliography",
    {
      description:
        "Get bibliography and scholarly references for an artwork. " +
        "By default returns a summary (total count + first 5 citations). " +
        "Set full=true to retrieve all citations (can be 100+ entries for major works — consider the context window).",
      inputSchema: {
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
      },
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
      description:
        "Get IIIF image information for an artwork, including URLs for thumbnails, full-resolution images, and deep-zoom viewing. " +
        "In supported clients, shows an interactive inline IIIF viewer with zoom/pan/rotate. " +
        "Optionally include a base64-encoded thumbnail. Not all artworks have images available.",
      inputSchema: {
        objectNumber: z
          .string()
          .describe("The object number of the artwork (e.g. 'SK-C-5')"),
        includeThumbnail: z
          .boolean()
          .default(false)
          .describe(
            "If true, includes a small base64-encoded JPEG thumbnail (~200px, 5-10KB)"
          ),
      },
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
        imageInfo.viewerUrl = `http://localhost:${httpPort}/viewer?iiif=${encodeURIComponent(imageInfo.iiifId)}&title=${encodeURIComponent(title)}`;
      }

      const viewerData = {
        ...imageInfo,
        objectNumber,
        title,
        creator: RijksmuseumApiClient.parseCreator(object),
        date: RijksmuseumApiClient.parseDate(object),
        collectionUrl: `https://www.rijksmuseum.nl/en/collection/${objectNumber}`,
      };

      const contentBlocks: Array<
        | { type: "text"; text: string }
        | { type: "image"; data: string; mimeType: string }
      > = [{ type: "text", text: JSON.stringify(viewerData, null, 2) }];

      if (args.includeThumbnail) {
        const base64 = await api.fetchThumbnailBase64(imageInfo.iiifId, 200);
        contentBlocks.push({
          type: "image",
          data: base64,
          mimeType: "image/jpeg",
        });
      }

      return { content: contentBlocks };
    })
  );

  // ── get_artist_timeline ─────────────────────────────────────────

  server.registerTool(
    "get_artist_timeline",
    {
      description:
        "Generate a chronological timeline of an artist's works in the Rijksmuseum collection. " +
        "Searches by creator name, resolves each result, and sorts by creation date.",
      inputSchema: {
        artist: z
          .string()
          .describe("Artist name, e.g. 'Rembrandt van Rijn', 'Johannes Vermeer'"),
        maxWorks: z
          .number()
          .int()
          .min(1)
          .max(25)
          .default(10)
          .describe("Maximum works to include (1-25, default 10)"),
      },
    },
    withLogging("get_artist_timeline", async (args) => {
      const result = await api.searchAndResolve({
        creator: args.artist,
        maxResults: args.maxWorks,
      });

      const timeline = result.results
        .map(({ date, ...rest }) => ({ year: date, ...rest }))
        .sort((a, b) => (parseInt(a.year, 10) || 0) - (parseInt(b.year, 10) || 0));

      return jsonResponse({
        artist: args.artist,
        totalWorksInCollection: result.totalResults,
        timeline,
      });
    })
  );

  // ── open_in_browser ─────────────────────────────────────────────

  server.registerTool(
    "open_in_browser",
    {
      description:
        "Open a URL in the user's default web browser. Useful for opening artwork pages, IIIF images, or the deep-zoom viewer.",
      inputSchema: {
        url: z
          .string()
          .url()
          .describe("The URL to open in the browser"),
      },
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
      description:
        "List curated collection sets from the Rijksmuseum (exhibitions, scholarly groupings, thematic collections). " +
        "Returns set identifiers that can be used with browse_set to explore their contents. " +
        "Optionally filter by name substring.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe(
            "Filter sets by name (case-insensitive substring match). E.g. 'painting', 'Rembrandt', 'Japanese'"
          ),
      },
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
      description:
        "Browse artworks in a curated collection set. Returns parsed EDM records with titles, creators, dates, " +
        "image URLs, and IIIF service URLs. Each record includes an objectNumber that can be used with " +
        "get_artwork_details, get_artwork_image, or get_artwork_bibliography for full Linked Art data. " +
        "Supports pagination via resumptionToken.",
      inputSchema: {
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
      },
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
      description:
        "Track recent additions and modifications to the Rijksmuseum collection. " +
        "Returns records changed within a date range. Use identifiersOnly=true for a lightweight " +
        "listing (headers only, no full metadata). Each record includes an objectNumber for use with " +
        "get_artwork_details, get_artwork_image, or get_artwork_bibliography.",
      inputSchema: {
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
      },
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
  api: RijksmuseumApiClient
): void {
  server.registerResource(
    "popular_artworks",
    "art://collection/popular",
    {
      description: "A curated selection of notable artworks from the Rijksmuseum collection",
      mimeType: "application/json",
    },
    async () => {
      const result = await api.searchAndResolve({
        type: "painting",
        maxResults: 10,
      });
      return {
        contents: [
          {
            uri: "art://collection/popular",
            mimeType: "application/json",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );
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
            },
          },
        },
      ],
    })
  );
}

// ─── Prompts ────────────────────────────────────────────────────────

function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "analyze-artwork",
    {
      description:
        "Analyze an artwork's composition, style, and historical context",
      argsSchema: {
        artworkId: z
          .string()
          .describe("The object number of the artwork to analyze (e.g. 'SK-C-5')"),
      },
    },
    async (args) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Analyze the composition, style, and historical context of artwork ${args.artworkId}. ` +
              `First use the get_artwork_details tool with objectNumber="${args.artworkId}" to retrieve the artwork data, ` +
              `then provide a detailed analysis covering:\n` +
              `- Visual composition and artistic technique\n` +
              `- Historical and cultural context\n` +
              `- Significance within the artist's body of work\n` +
              `- Notable details or symbolism`,
          },
        },
      ],
    })
  );

  server.registerPrompt(
    "generate-artist-timeline",
    {
      description:
        "Generate a chronological timeline of an artist's most notable works",
      argsSchema: {
        artist: z.string().describe("Name of the artist"),
        maxWorks: z
          .string()
          .optional()
          .describe("Maximum number of works to include (default: 10)"),
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
