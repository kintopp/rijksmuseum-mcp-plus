![rijksmuseum logo](https://upload.wikimedia.org/wikipedia/commons/thumb/d/d1/Logo_Rijksmuseum.svg/799px-Logo_Rijksmuseum.svg.png)

# Rijksmuseum MCP Server

A Model Context Protocol (MCP) server that provides access to the Rijksmuseum's collection through natural language interactions. Built on the Rijksmuseum's Linked Open Data APIs — **no API key required**.

<a href="https://glama.ai/mcp/servers/4rmiexp64y"><img width="380" height="200" src="https://glama.ai/mcp/servers/4rmiexp64y/badge" alt="Rijksmuseum Server MCP server" /></a>

## Features

### 1. Search Artworks (`search_artwork`)
Search and filter artworks using:
- Title, creator name, object type
- Material, technique, creation date
- Wildcard date ranges (e.g. `16*` for all 1600s, `164*` for 1640s)
- Compact mode for fast counts without resolving details

### 2. Artwork Details (`get_artwork_details`)
Retrieve comprehensive information about a specific artwork by object number:
- Title, creator, creation date
- Description, technique, dimensions
- Provenance, credit line, inscriptions
- Gallery location, collection memberships

### 3. IIIF Image Access (`get_artwork_image`)
Get high-resolution image data via IIIF:
- Thumbnail and full-resolution URLs
- Image dimensions (width/height)
- Optional base64-encoded thumbnail
- Deep-zoom viewer URL (HTTP mode)

### 4. Artist Timeline (`get_artist_timeline`)
Generate chronological timelines of an artist's works in the collection.

### 5. Open in Browser (`open_in_browser`)
Open artwork pages, images, or the deep-zoom viewer in the user's default browser.

### Prompts
- **`analyze-artwork`** — Analyze an artwork's composition, style, and historical context
- **`generate-artist-timeline`** — Create a visual timeline of an artist's works

### Resources
- **`art://collection/popular`** — A curated selection of notable paintings

## Getting Started

### Using Claude Desktop (NPM)

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

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

No API key needed. Restart Claude Desktop after updating.

### From Source

```bash
git clone https://github.com/your-username/rijksmuseum-mcp.git
cd rijksmuseum-mcp
npm install
npm run build
```

Then update your Claude Desktop config:

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

For web deployment or remote access:

```bash
npm run serve                    # Starts on port 3000
PORT=8080 npm start              # Custom port (auto-detects HTTP mode)
```

Endpoints:
- `POST /mcp` — MCP protocol (Streamable HTTP with SSE)
- `GET /viewer?iiif={id}&title={title}` — OpenSeadragon IIIF deep-zoom viewer
- `GET /health` — Health check

### Railway Deployment

The included `railway.json` handles build and deploy. Railway automatically sets `PORT`, which triggers HTTP mode. No additional configuration needed.

## Architecture

```
src/
  index.ts                    — Dual-transport entry point (stdio + HTTP)
  registration.ts             — Tool/resource/prompt registration (Zod + McpServer)
  types.ts                    — Linked Art + IIIF + output types
  viewer.ts                   — OpenSeadragon HTML generator
  api/
    RijksmuseumApiClient.ts   — API client (Linked Art parsing, IIIF image chain)
  utils/
    SystemIntegration.ts      — Browser opening utility
```

**Data flow:** Search API → Linked Art JSON-LD resolution → parsed summaries/details

**Image chain (4 HTTP hops):** Object `.shows` → VisualItem `.digitally_shown_by` → DigitalObject `.access_point` → IIIF URL

## Configuration

| Variable | Description | Default |
|---|---|---|
| `PORT` | HTTP server port (presence triggers HTTP mode) | 3000 |
| `ALLOWED_ORIGINS` | CORS origins (comma-separated) | `*` |

No API key is needed — the Rijksmuseum Linked Open Data APIs are fully open.

## Example Queries

```
"Show me paintings by Rembrandt from the 1640s"
"Tell me everything about The Night Watch (SK-C-5)"
"Get a high-resolution image of Vermeer's Milkmaid"
"Create a timeline of Van Gogh's works in the Rijksmuseum"
"How many prints by Dürer are in the collection?"
```

## Contributing

Contributions are welcome! Please feel free to submit pull requests or create issues.

## License

This project is licensed under the MIT License - see the LICENSE file for details.
