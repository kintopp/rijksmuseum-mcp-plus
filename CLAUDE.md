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

**Request flow:** MCP SDK dispatches → `registration.ts` tool callbacks → `RijksmuseumApiClient` → returns formatted JSON.

**Data sources:**
- Search API: `https://data.rijksmuseum.nl/search/collection` — returns Linked Art URIs
- Resolver: `https://id.rijksmuseum.nl/{numericId}` — returns Linked Art JSON-LD
- IIIF: `https://iiif.micr.io/{iiifId}/info.json` — image metadata and tiles

Key layers:
- **`src/index.ts`** — Dual-transport entry (stdio default, HTTP when `PORT` env or `--http` flag). HTTP mode uses Express + StreamableHTTPServerTransport with per-session McpServer instances.
- **`src/registration.ts`** — Registers 5 tools, 2 resources, 2 prompts. `get_artwork_image` uses `registerAppTool` from `@modelcontextprotocol/ext-apps/server` (links to MCP App viewer). Other tools use `McpServer.registerTool()` with Zod input schemas.
- **`src/api/RijksmuseumApiClient.ts`** — Axios client for Linked Art APIs. Static parsers extract fields from JSON-LD using AAT URIs. Image chain follows 4 hops: Object → VisualItem → DigitalObject → IIIF.
- **`src/types.ts`** — Linked Art primitives, Search API types, IIIF types, parsed output types, AAT constants.
- **`src/viewer.ts`** — Generates self-contained OpenSeadragon HTML for IIIF deep-zoom.
- **`src/utils/SystemIntegration.ts`** — Cross-platform browser opening.
- **`apps/artwork-viewer/`** — MCP Apps inline IIIF viewer (Vite + vite-plugin-singlefile + OpenSeadragon). Built by `npm run build:ui` into `dist/apps/index.html`. Loaded at runtime by `registration.ts` via `fs.readFileSync`. The `tsconfig.json` excludes `apps/` so tsc doesn't compile it.

## Tools

| Tool | Description |
|---|---|
| `search_artwork` | Search by title, creator, type, material, technique, creationDate. Supports compact mode. |
| `get_artwork_details` | Full details by objectNumber (e.g. `SK-C-5`). 2 HTTP calls (search + resolve). |
| `get_artwork_image` | IIIF image info + inline MCP Apps viewer + optional base64 thumbnail. 4-6 HTTP calls for image chain. Uses `registerAppTool` with `_meta.ui.resourceUri`. |
| `get_artist_timeline` | Chronological timeline by creator name. N+1 calls (search + resolve each). |
| `open_in_browser` | Opens any URL in user's default browser. |

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

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `PORT` | HTTP port (presence triggers HTTP mode) | 3000 |
| `ALLOWED_ORIGINS` | CORS origins (comma-separated) | `*` |
