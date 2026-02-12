# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MCP (Model Context Protocol) server that wraps the Rijksmuseum Linked Open Data APIs, exposing artwork search, details, IIIF image access, and artist timelines as MCP tools. Supports both stdio and HTTP transports. Published to npm as `rijksmuseum-mcp-plus`.

**No API key required** — the Rijksmuseum's Linked Open Data APIs are fully open.

## Naming

- **npm package:** `rijksmuseum-mcp-plus` (no `+` allowed in npm names)
- **MCP server identity:** `rijksmuseum-mcp+` (in `serverInfo.name`, set in `src/index.ts`)
- **Distinct from** `mcp-server-rijksmuseum` by @r-huijts (legacy REST API, requires API key)

## Build & Run

```bash
npm install
npm run build          # build:ui (Vite) → tsc → outputs to ./dist
npm run build:ui       # Vite only — bundles apps/artwork-viewer → dist/apps/index.html
npm start              # stdio mode (default)
npm run serve          # HTTP mode on port 3000
PORT=8080 npm start    # HTTP mode on custom port
```

No test suite or linter is configured.

## Architecture

Dual-transport MCP server using `McpServer` from `@modelcontextprotocol/sdk`. Entry point: `src/index.ts`.

**Request flow:** MCP SDK dispatches → `registration.ts` tool callbacks → `RijksmuseumApiClient` or `OaiPmhClient` → returns formatted JSON.

**Data sources:**
- Search API: `https://data.rijksmuseum.nl/search/collection` — returns Linked Art URIs. Supported parameters: `title`, `creator`, `objectNumber`, `type`, `material`, `technique`, `creationDate`, `description`, `pageToken`. No general full-text search exists; unknown parameters are silently ignored and an unfiltered request returns the entire collection (837K+).
- Resolver: `https://id.rijksmuseum.nl/{numericId}` — returns Linked Art JSON-LD
- IIIF: `https://iiif.micr.io/{iiifId}/info.json` — image metadata and tiles
- OAI-PMH: `https://data.rijksmuseum.nl/oai` — curated sets, date-based change tracking, EDM metadata. 192 sets, 836K+ records, 50 records/page with base64 resumption tokens.

Key layers:
- **`src/index.ts`** — Dual-transport entry (stdio default, HTTP when `PORT` env or `--http` flag). HTTP mode uses Express + StreamableHTTPServerTransport with per-session McpServer instances.
- **`src/registration.ts`** — Registers 9 tools, 2 resources, 2 prompts. `get_artwork_image` uses `registerAppTool` from `@modelcontextprotocol/ext-apps/server` (links to MCP App viewer). Other tools use `McpServer.registerTool()` with Zod input schemas.
- **`src/api/RijksmuseumApiClient.ts`** — Axios client for Linked Art APIs. Static parsers extract fields from JSON-LD using AAT URIs. Vocabulary resolution via `resolveVocabTerm()` for bilingual labels + AAT/Wikidata equivalents. Bibliography parsing handles 3 entry types (structured refs, inline citations, BIBFRAME). Image chain follows 4 hops: Object → VisualItem → DigitalObject → IIIF.
- **`src/api/OaiPmhClient.ts`** — Axios + fast-xml-parser client for OAI-PMH endpoint. Parses EDM records with namespace-aware XML parsing. Provides `listSets()`, `listRecords()`, `listIdentifiers()` with resumption token pagination.
- **`src/types.ts`** — Linked Art primitives, Search API types, IIIF types, parsed output types, AAT constants.
- **`src/viewer.ts`** — Generates self-contained OpenSeadragon HTML for IIIF deep-zoom.
- **`src/utils/SystemIntegration.ts`** — Cross-platform browser opening.
- **`apps/artwork-viewer/`** — MCP Apps inline IIIF viewer (Vite + vite-plugin-singlefile + OpenSeadragon). Controls: zoom, rotate, flip, keyboard shortcuts overlay (`?`), conditional fullscreen (only when `document.fullscreenEnabled`). Built by `npm run build:ui` into `dist/apps/index.html`. Loaded at runtime by `registration.ts` via `fs.readFileSync`. The `tsconfig.json` excludes `apps/` so tsc doesn't compile it.

## Tools

| Tool | Description |
|---|---|
| `search_artwork` | Search by query (→title), title, creator, type, material, technique, creationDate, description. At least one filter required. Supports compact mode. |
| `get_artwork_details` | Full details by objectNumber (e.g. `SK-C-5`). 24 metadata categories including resolved vocabulary terms. 2 + ~17 HTTP calls (search + resolve object + parallel vocabulary resolution). |
| `get_artwork_bibliography` | Bibliography/references for an artwork. Plaintext citations. Summary (5) or full (100+). Resolves Schema.org Book records. |
| `get_artwork_image` | IIIF image info + inline MCP Apps viewer + optional base64 thumbnail. 4-6 HTTP calls for image chain. Uses `registerAppTool` with `_meta.ui.resourceUri`. |
| `get_artist_timeline` | Chronological timeline by creator name. N+1 calls (search + resolve each). |
| `open_in_browser` | Opens any URL in user's default browser. |
| `list_curated_sets` | List 192 curated collection sets (exhibitions, scholarly groupings). Optional name filter. Via OAI-PMH. |
| `browse_set` | Browse artworks in a curated set. Returns parsed EDM records with titles, creators, images. Pagination via resumptionToken. |
| `get_recent_changes` | Track additions/modifications by date range. Full EDM records or lightweight headers (identifiersOnly). Pagination via resumptionToken. |

## Conventions

- ESM (`"type": "module"` in package.json) with `.js` extensions in imports (TypeScript NodeNext resolution)
- Tool input validation via Zod schemas in `registration.ts`
- Linked Art fields are parsed using AAT (Art & Architecture Thesaurus) URIs — constants in `types.ts`
- Search results are resolved concurrently with `Promise.all` (default 10 items, max 25)
- English text preferred; falls back to Dutch, then any available language
- Image chain returns `null` gracefully if any step fails

## HTTP Endpoints (serve mode)

- `POST /mcp` — MCP protocol (Streamable HTTP with SSE)
- `GET /viewer?iiif={id}&title={title}` — OpenSeadragon IIIF viewer
- `GET /health` — Health check

## Linked Art Data Model Notes

- Artwork objects return **Linked Art** JSON-LD (`linked-art.json` context)
- Bibliographic records (`assigned_by` → resolved URIs) return **Schema.org** JSON-LD — different schema
- Vocabulary terms (`classified_as`, `made_of`, `technique`, etc.) are resolvable Linked Art URIs with bilingual labels (EN/NL) and `equivalent` mappings to Getty AAT, Wikidata
- `get_artwork_details` surfaces 24 metadata categories (everything except full bibliography). Vocabulary URIs are resolved in parallel via `Promise.allSettled` (~17 URIs batched into one round trip).
- `toDetail()` (static, no HTTP) provides base 12 categories; `toDetailEnriched()` (instance, async) adds 12 more via vocabulary resolution

## MCP Apps CSP

The artwork viewer runs in a sandboxed iframe. CSP has two separate domain lists:
- `resourceDomains` → `script-src`, `img-src`, `style-src` (static resources)
- `connectDomains` → `connect-src` (fetch/XHR/WebSocket)

OpenSeadragon needs both: XHR for `info.json`, `<img>` tags for tiles. Missing `connectDomains` causes silent failure (viewer loads but blank).

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `PORT` | HTTP port (presence triggers HTTP mode) | 3000 |
| `ALLOWED_ORIGINS` | CORS origins (comma-separated) | `*` |
