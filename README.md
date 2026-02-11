![Rijksmuseum logo](https://upload.wikimedia.org/wikipedia/commons/thumb/d/d1/Logo_Rijksmuseum.svg/799px-Logo_Rijksmuseum.svg.png)

# Rijksmuseum MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server for exploring the Rijksmuseum collection through conversational AI. Built on the Rijksmuseum's [Linked Open Data APIs](https://data.rijksmuseum.nl/) and the [Linked Art](https://linked.art/) data model — **no API key required**.

Inspired by [@r-huijts/rijksmuseum-mcp](https://github.com/r-huijts/rijksmuseum-mcp), the original Rijksmuseum MCP server (which uses the legacy REST API and requires an API key). This version is a ground-up rewrite using the museum's newer Linked Open Data infrastructure.

<a href="https://glama.ai/mcp/servers/4rmiexp64y"><img width="380" height="200" src="https://glama.ai/mcp/servers/4rmiexp64y/badge" alt="Rijksmuseum MCP server" /></a>

## Features

### Tools

| Tool | Description |
|---|---|
| `search_artwork` | Search by title, creator, type, material, technique, date. Supports wildcard date ranges (`16*` for 1600s) and compact mode for fast counts. |
| `get_artwork_details` | Full details by object number (e.g. `SK-C-5`): title, creator, date, description, technique, dimensions, provenance, credit line, inscriptions. |
| `get_artwork_image` | IIIF image info + interactive inline deep-zoom viewer ([MCP Apps](https://github.com/anthropics/mcp-apps)). Falls back to JSON + optional base64 thumbnail in text-only clients. |
| `get_artist_timeline` | Chronological timeline of an artist's works in the collection. |
| `open_in_browser` | Open any URL (artwork page, image, viewer) in the user's default browser. |

### Prompts

| Prompt | Description |
|---|---|
| `analyze-artwork` | Analyze an artwork's composition, style, and historical context |
| `generate-artist-timeline` | Create a visual timeline of an artist's works |

### Resources

| URI | Description |
|---|---|
| `art://collection/popular` | A curated selection of notable paintings |
| `ui://rijksmuseum/artwork-viewer.html` | Interactive IIIF viewer (MCP Apps) |

### Inline Artwork Viewer

The `get_artwork_image` tool includes an [MCP Apps](https://github.com/anthropics/mcp-apps) integration that renders an interactive OpenSeadragon IIIF deep-zoom viewer directly inline in the chat. In supported clients (e.g. Claude Desktop), you get a full artwork viewer with zoom, pan, and rotate controls — no browser needed. In text-only clients, the tool still returns structured JSON with image URLs and an optional base64 thumbnail.

## Getting Started

### Claude Desktop (NPX)

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "rijksmuseum": {
      "command": "npx",
      "args": ["-y", "mcp-server-rijksmuseum"]
    }
  }
}
```

Restart Claude Desktop after updating. No API key needed.

### From Source

```bash
git clone https://github.com/your-username/rijksmuseum-mcp.git
cd rijksmuseum-mcp
npm install
npm run build
```

Then point your MCP client at the built server:

```json
{
  "mcpServers": {
    "rijksmuseum": {
      "command": "node",
      "args": ["/path/to/rijksmuseum-mcp/dist/index.js"]
    }
  }
}
```

### HTTP Mode

For web deployment, remote access, or non-stdio clients:

```bash
npm run serve                    # Starts on port 3000
PORT=8080 npm start              # Custom port
```

HTTP mode activates automatically when `PORT` is set or `--http` is passed.

| Endpoint | Description |
|---|---|
| `POST /mcp` | MCP protocol (Streamable HTTP with SSE) |
| `GET /viewer?iiif={id}&title={title}` | OpenSeadragon IIIF deep-zoom viewer |
| `GET /health` | Health check |

### Railway Deployment

The included `railway.json` handles build and deploy. Railway sets `PORT` automatically, which triggers HTTP mode. No additional configuration needed.

## Architecture

```
src/
  index.ts                    — Dual-transport entry point (stdio + HTTP)
  registration.ts             — Tool/resource/prompt registration
  types.ts                    — Linked Art, IIIF, and output types
  viewer.ts                   — OpenSeadragon HTML generator (HTTP mode)
  api/
    RijksmuseumApiClient.ts   — Linked Art API client + IIIF image chain
  utils/
    SystemIntegration.ts      — Cross-platform browser opening
apps/
  artwork-viewer/             — MCP Apps inline IIIF viewer (Vite + OpenSeadragon)
```

**Data sources:**

| API | URL | Purpose |
|---|---|---|
| Search API | `https://data.rijksmuseum.nl/search/collection` | Full-text search, returns Linked Art URIs |
| Linked Art resolver | `https://id.rijksmuseum.nl/{id}` | Object metadata as JSON-LD |
| IIIF Image API | `https://iiif.micr.io/{id}/info.json` | High-resolution image tiles |

**Image chain (4 HTTP hops):** Object `.shows` > VisualItem `.digitally_shown_by` > DigitalObject `.access_point` > IIIF info.json

## Configuration

| Variable | Description | Default |
|---|---|---|
| `PORT` | HTTP server port (presence triggers HTTP mode) | `3000` |
| `ALLOWED_ORIGINS` | CORS origins (comma-separated) | `*` |

No API key is needed — the Rijksmuseum Linked Open Data APIs are fully open.

## Example Queries

```
"Show me paintings by Rembrandt from the 1640s"
"Tell me everything about The Night Watch (SK-C-5)"
"Show me a high-resolution image of Vermeer's Milkmaid"
"Create a timeline of Van Gogh's works in the Rijksmuseum"
"How many prints by Dürer are in the collection?"
```

## Data and Image Credits

Collection data and images are provided by the **[Rijksmuseum, Amsterdam](https://www.rijksmuseum.nl/)** via their [Linked Open Data APIs](https://data.rijksmuseum.nl/).

**Licensing:** Information and data that are no longer (or never were) protected by copyright carry the **Public Domain Mark** and/or **[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)**. Where the Rijksmuseum holds copyright, it generally waives its rights under CC0 1.0; in cases where it does exercise copyright, materials are made available under **[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)**. Materials under third-party copyright without express permission are not made available as open data. Individual licence designations appear on the [collection website](https://www.rijksmuseum.nl/en/rijksstudio).

**Attribution:** The Rijksmuseum considers it good practice to provide attribution and/or source citation via a credit line and data citation, regardless of the licence applied. Even where not legally required, the museum asks that users credit the Rijksmuseum (and, where possible, its staff) as the original creator.

See the Rijksmuseum's [information and data policy](https://data.rijksmuseum.nl/policy/information-and-data-policy) for the full terms.

## Authors

- [Arno Bosse](https://orcid.org/0000-0003-3681-1289) — [RISE, University of Basel](https://rise.unibas.ch/)
- Claude Code — [Anthropic](https://www.anthropic.com/)

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.
