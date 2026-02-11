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
import { SystemIntegration } from "./utils/SystemIntegration.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ARTWORK_VIEWER_RESOURCE_URI = "ui://rijksmuseum/artwork-viewer.html";

/**
 * Register all tools, resources, and prompts on the given McpServer.
 * `httpPort` is provided when running in HTTP mode so viewer URLs can be generated.
 */
export function registerAll(
  server: McpServer,
  apiClient: RijksmuseumApiClient,
  httpPort?: number
): void {
  registerTools(server, apiClient, httpPort);
  registerResources(server, apiClient);
  registerAppViewerResource(server);
  registerPrompts(server);
}

// ─── Tools ──────────────────────────────────────────────────────────

function registerTools(
  server: McpServer,
  api: RijksmuseumApiClient,
  httpPort?: number
): void {
  // ── search_artwork ──────────────────────────────────────────────

  server.registerTool(
    "search_artwork",
    {
      description:
        "Search the Rijksmuseum collection. Returns artwork summaries with titles, creators, and dates. " +
        "Supports filtering by title, creator, type, material, technique, and creation date. " +
        "Use creationDate with wildcards for ranges (e.g. '16*' for 1600s, '164*' for 1640s).",
      inputSchema: {
        title: z
          .string()
          .optional()
          .describe("Search by artwork title"),
        creator: z
          .string()
          .optional()
          .describe("Search by artist name, e.g. 'Rembrandt van Rijn'"),
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
            "If true, returns only total count and IDs without resolving details (faster)"
          ),
        pageToken: z
          .string()
          .optional()
          .describe("Pagination token from a previous search result"),
      },
    },
    async (args) => {
      if (args.compact) {
        const result = await api.searchCompact(args);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      const result = await api.searchAndResolve(args);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  // ── get_artwork_details ─────────────────────────────────────────

  server.registerTool(
    "get_artwork_details",
    {
      description:
        "Get comprehensive details about a specific artwork by its object number (e.g. 'SK-C-5' for The Night Watch). " +
        "Returns title, creator, date, description, technique, dimensions, provenance, credit line, inscriptions, and more.",
      inputSchema: {
        objectNumber: z
          .string()
          .describe(
            "The object number of the artwork (e.g. 'SK-C-5', 'SK-A-3262')"
          ),
      },
    },
    async (args) => {
      const { uri, object } = await api.findByObjectNumber(args.objectNumber);
      const detail = RijksmuseumApiClient.toDetail(object, uri);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(detail, null, 2),
          },
        ],
      };
    }
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
    async (args) => {
      const { uri, object } = await api.findByObjectNumber(args.objectNumber);
      const imageInfo = await api.getImageInfo(object);

      if (!imageInfo) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  objectNumber: args.objectNumber,
                  error: "No image available for this artwork",
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // Add viewer URL if running in HTTP mode
      if (httpPort) {
        const title = RijksmuseumApiClient.parseTitle(object);
        imageInfo.viewerUrl = `http://localhost:${httpPort}/viewer?iiif=${encodeURIComponent(imageInfo.iiifId)}&title=${encodeURIComponent(title)}`;
      }

      // Enrich with artwork metadata for the MCP App viewer
      const title = RijksmuseumApiClient.parseTitle(object);
      const creator = RijksmuseumApiClient.parseCreator(object);
      const date = RijksmuseumApiClient.parseDate(object);
      const objectNumber = RijksmuseumApiClient.parseObjectNumber(object);
      const collectionUrl = `https://www.rijksmuseum.nl/en/collection/${objectNumber}`;

      const viewerData = {
        ...imageInfo,
        objectNumber,
        title,
        creator,
        date,
        collectionUrl,
      };

      const contentBlocks: Array<
        | { type: "text"; text: string }
        | { type: "image"; data: string; mimeType: string }
      > = [
        {
          type: "text" as const,
          text: JSON.stringify(viewerData, null, 2),
        },
      ];

      // Optionally fetch and include thumbnail for non-MCP-Apps clients
      if (args.includeThumbnail) {
        const base64 = await api.fetchThumbnailBase64(imageInfo.iiifId, 200);
        contentBlocks.push({
          type: "image" as const,
          data: base64,
          mimeType: "image/jpeg",
        });
      }

      return { content: contentBlocks };
    }
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
    async (args) => {
      const result = await api.searchAndResolve({
        creator: args.artist,
        maxResults: args.maxWorks,
      });

      // Sort by date and map to timeline entries
      const timeline: Array<{
        year: string;
        title: string;
        objectNumber: string;
        creator: string;
        id: string;
        url: string;
      }> = result.results
        .map((r) => ({
          year: r.date,
          title: r.title,
          objectNumber: r.objectNumber,
          creator: r.creator,
          id: r.id,
          url: r.url,
        }))
        .sort((a, b) => {
          const yearA = parseInt(a.year) || 0;
          const yearB = parseInt(b.year) || 0;
          return yearA - yearB;
        });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                artist: args.artist,
                totalWorksInCollection: result.totalResults,
                timeline,
              },
              null,
              2
            ),
          },
        ],
      };
    }
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
    async (args) => {
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
    }
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

function registerAppViewerResource(server: McpServer): void {
  const loadViewerHtml = (): string => {
    const htmlPath = path.join(__dirname, "..", "dist", "apps", "index.html");
    try {
      return fs.readFileSync(htmlPath, "utf-8");
    } catch {
      return `<!DOCTYPE html>
<html><head><title>Artwork Viewer</title></head>
<body style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;">
<div style="text-align:center;color:#666;">
<h1>Viewer Not Built</h1><p>Run <code>npm run build:ui</code> to build the viewer.</p>
</div></body></html>`;
    }
  };

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
          role: "user" as const,
          content: {
            type: "text" as const,
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
          role: "user" as const,
          content: {
            type: "text" as const,
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
