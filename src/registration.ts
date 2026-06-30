import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerAppResource,
  getUiCapability,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RijksmuseumApiClient } from "./api/RijksmuseumApiClient.js";
import { OaiPmhClient } from "./api/OaiPmhClient.js";
import { VocabularyDb } from "./api/VocabularyDb.js";
import { EmbeddingsDb } from "./api/EmbeddingsDb.js";
import { EmbeddingModel } from "./api/EmbeddingModel.js";
import { UsageStats } from "./utils/UsageStats.js";
import {
  similarPages,
  enrichmentReviewPages,
} from "./registration/state.js";
import {
  regionToPixels,
  computeVerificationRegion,
  parsePctRegion,
  parseCropPixelsRegion,
  cropPixelsToIiifPixels,
  type OobWarning,
  oobError,
  checkRegionBounds,
  type DeliveryState,
  computeDeliveryState,
  projectToFullImage,
} from "./registration/geometry.js";
import {
  ARTWORK_VIEWER_RESOURCE_URI,
  stripNullCoerceBool,
  parseDimRange,
  parseSortParam,
  createLogger,
} from "./registration/helpers.js";

// Re-export the pure helpers that scripts/tests/test-pure-functions.mjs imports
// from dist/registration.js (that path must keep working). They live in
// ./registration/helpers.ts (imported above); the output schemas and
// visual-search functions are imported only by the individual tool registrars,
// not by this façade.
export { parseDimRange, parseSortParam, stripNullCoerceBool };


// Re-export the two state symbols that src/index.ts imports from this module.
// The rest of the module-scope state (viewerQueues, IIIF_REGION_RE, caches) lives
// in ./registration/state.ts and is consumed directly by the tool registrars.
export { similarPages, enrichmentReviewPages };

// Geometry helpers are in ./registration/geometry.ts — imported above.
// Re-export all geometry symbols (scripts/tests/test-pure-functions.mjs imports them
// from dist/registration.js and must not be modified):
export {
  regionToPixels,
  computeVerificationRegion,
  parsePctRegion,
  parseCropPixelsRegion,
  cropPixelsToIiifPixels,
  type OobWarning,
  oobError,
  checkRegionBounds,
  type DeliveryState,
  computeDeliveryState,
  projectToFullImage,
};

// ─── Tool family registrars (Phase 4 split) ─────────────────────────────────
// These helpers and all tool blocks were extracted to src/registration/tools/*.ts.
// This file is now a thin dispatcher.

import { registerSearchTools } from "./registration/tools/search.js";
import { registerDetailsTools } from "./registration/tools/details.js";
import { registerBibliographyTools } from "./registration/tools/bibliography.js";
import { registerConservationTools } from "./registration/tools/conservation.js";
import { registerViewerTools } from "./registration/tools/viewer.js";
import { registerSetsTools } from "./registration/tools/sets.js";
import { registerProvenanceTools } from "./registration/tools/provenance.js";
import { registerInscriptionsTools } from "./registration/tools/inscriptions.js";
import { registerStatsTools } from "./registration/tools/stats.js";
import { registerSimilarTools } from "./registration/tools/similar.js";
import { registerSemanticTools } from "./registration/tools/semantic.js";

// ─── Tools ──────────────────────────────────────────────────────────

function registerTools(
  server: McpServer,
  api: RijksmuseumApiClient,
  oai: OaiPmhClient,
  vocabDb: VocabularyDb | null,
  embeddingsDb: EmbeddingsDb | null,
  embeddingModel: EmbeddingModel | null,
  httpPort: number | undefined,
  withLogging: ReturnType<typeof createLogger>,
  stats?: UsageStats
): void {
  const publicBaseUrl = resolvePublicUrl(httpPort);

  registerSearchTools(server, vocabDb, withLogging, stats);
  registerDetailsTools(server, vocabDb, withLogging, stats);
  registerBibliographyTools(server, vocabDb, withLogging, stats);
  registerConservationTools(server, vocabDb, withLogging, stats);
  registerViewerTools(server, api, vocabDb, publicBaseUrl, withLogging, stats);
  registerSetsTools(server, oai, vocabDb, withLogging, stats);
  registerProvenanceTools(server, oai, vocabDb, publicBaseUrl, withLogging, stats);
  registerInscriptionsTools(server, vocabDb, withLogging, stats);
  registerStatsTools(server, vocabDb, embeddingsDb, embeddingModel, withLogging, stats);
  registerSimilarTools(server, vocabDb, embeddingsDb, publicBaseUrl, withLogging, stats);
  registerSemanticTools(server, embeddingsDb, embeddingModel, vocabDb, withLogging, stats);
}

// ─── MCP App Resource ────────────────────────────────────────────────

const VIEWER_FALLBACK_HTML = `<!DOCTYPE html>
<html><head><title>Artwork Viewer</title></head>
<body style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;">
<div style="text-align:center;color:#666;">
<h1>Viewer Not Built</h1><p>Run <code>npm run build:ui</code> to build the viewer.</p>
</div></body></html>`;

let viewerHtmlCache: string | null = null;

// Anchored to THIS module's location, not a shared helper's. registration.ts
// compiles to dist/registration.js, so __dirname is dist/ and the bundled
// viewer sits alongside at dist/apps/index.html. (Importing __dirname from
// registration/helpers.ts — one directory deeper — silently resolved to
// dist/dist/apps/index.html and served the "Viewer Not Built" fallback.)
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadViewerHtml(): string {
  if (viewerHtmlCache !== null) return viewerHtmlCache;
  const htmlPath = path.join(__dirname, "apps", "index.html");
  try {
    viewerHtmlCache = fs.readFileSync(htmlPath, "utf-8");
  } catch {
    viewerHtmlCache = VIEWER_FALLBACK_HTML;
  }
  return viewerHtmlCache;
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

// ─── Public entry points ─────────────────────────────────────────────

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
  registerTools(server, apiClient, oaiClient, vocabDb, embeddingsDb, embeddingModel, httpPort, createLogger(stats), stats);
  // The only MCP resource is the artwork viewer UI, registered next.
  registerAppViewerResource(server);

  // Log whether the connected client supports MCP Apps (SHOULD-level capability negotiation)
  server.server.oninitialized = () => {
    const clientCaps = server.server.getClientCapabilities();
    const uiCap = getUiCapability(clientCaps);
    if (uiCap) {
      console.error(`[mcp] Client supports MCP Apps (mimeTypes: ${uiCap.mimeTypes?.join(', ') ?? 'none'})`);
    }
  };
}
