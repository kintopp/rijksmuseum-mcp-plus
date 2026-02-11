![Rijksmuseum logo](https://upload.wikimedia.org/wikipedia/commons/thumb/d/d1/Logo_Rijksmuseum.svg/799px-Logo_Rijksmuseum.svg.png)

# rijksmuseum-mcp+

An AI-powered interface to the [Rijksmuseum](https://www.rijksmuseum.nl/) collection. Search artworks, explore their history, view high-resolution images, and access scholarly references — all through natural conversation. No API key required.

Built on the Rijksmuseum's [Linked Open Data APIs](https://data.rijksmuseum.nl/) and the [Linked Art](https://linked.art/) data model using the [Model Context Protocol](https://modelcontextprotocol.io/) (MCP).

> This project was inspired by [@r-huijts/rijksmuseum-mcp](https://github.com/r-huijts/rijksmuseum-mcp), the original Rijksmuseum MCP server. That version uses the legacy REST API and requires an API key. This is a ground-up rewrite using the museum's newer Linked Open Data infrastructure and adds features like an interactive inline image viewer.

## Quick Start

The easiest way to try rijksmuseum-mcp+ is through the hosted version — no installation needed.

**Connect your MCP client to:**

```
https://rijksmuseum-mcp-plus.example.com/mcp
```

*(Placeholder URL — hosted version coming soon)*

Once connected, just ask questions in plain language. Here are some things you can try:

### Searching the collection

```
"Show me paintings by Rembrandt"
"Find drawings by Hokusai in the Rijksmuseum"
"Search for still life paintings from the 1600s"
"What prints by Albrecht Dürer are in the collection?"
"Show me artworks made with watercolour on paper"
"Find works by female artists from the 17th century"
"How many etchings by Rembrandt are there?"
```

### Learning about specific artworks

Each artwork comes with up to 24 metadata categories — including curatorial narratives, materials, object types, production details, structured dimensions, provenance, and links to external identifiers (Getty AAT, Wikidata).

```
"Tell me everything about The Night Watch"
"What's the story behind Vermeer's Milkmaid?"
"Describe the provenance of SK-A-4691"
"What materials and technique were used for The Jewish Bride?"
"What collections is The Night Watch part of?"
```

### Scholarly references

For major works, the Rijksmuseum provides extensive bibliography data — over 100 scholarly references for The Night Watch alone. You can browse citations in plain text or export them as BibTeX.

```
"Show me the bibliography for The Night Watch"
"Get all references for SK-C-5 in BibTeX format"
"How many scholarly publications mention The Milkmaid?"
```

### Viewing high-resolution images

The server includes an interactive deep-zoom viewer that renders directly in your chat. You can zoom into brushstroke-level detail, pan across the canvas, and rotate the image — without leaving the conversation.

```
"Show me a high-resolution image of The Night Watch"
"Let me zoom into the details of Vermeer's The Love Letter"
"Show me the image for SK-A-3262"
```

In clients that support [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) (e.g. Claude Desktop), you get an interactive OpenSeadragon IIIF viewer with zoom, pan, and rotate controls. In other clients, you still get image URLs and an optional thumbnail.

### Exploring an artist's career

```
"Create a timeline of Rembrandt's works in the Rijksmuseum"
"Show me Johannes Vermeer's works in chronological order"
"Map out Van Gogh's artistic development from the Rijksmuseum collection"
```

---

## Technical Guide

The sections below are for developers who want to run the server locally, deploy it, or understand the architecture.

### Local Setup (stdio)

For use with Claude Desktop or other MCP clients that communicate over stdio:

```bash
git clone https://github.com/your-username/rijksmuseum-mcp.git
cd rijksmuseum-mcp
npm install
npm run build
```

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "rijksmuseum": {
      "command": "node",
      "args": ["/absolute/path/to/rijksmuseum-mcp/dist/index.js"]
    }
  }
}
```

Or install from npm without cloning:

```json
{
  "mcpServers": {
    "rijksmuseum": {
      "command": "npx",
      "args": ["-y", "rijksmuseum-mcp-plus"]
    }
  }
}
```

Restart your MCP client after updating the config.

### HTTP Deployment

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

The included `railway.json` supports one-click deployment on [Railway](https://railway.app/). Railway sets `PORT` automatically.

### Tools

| Tool | Description |
|---|---|
| `search_artwork` | Search by query, title, creator, type, material, technique, date, or description. At least one filter required. Supports wildcard date ranges (`16*` for 1600s) and compact mode for fast counts. |
| `get_artwork_details` | 24 metadata categories by object number (e.g. `SK-C-5`): titles, creator, date, curatorial narrative, materials, object type, production details, structured dimensions, provenance, credit line, inscriptions, license, related objects, collection sets, persistent IDs, and more. Vocabulary terms are resolved to English labels with links to Getty AAT and Wikidata. |
| `get_artwork_bibliography` | Scholarly references for an artwork. Summary (first 5) or full (100+ for major works). Plaintext or BibTeX output. Resolves publication records with ISBNs and WorldCat links. |
| `get_artwork_image` | IIIF image info + interactive inline deep-zoom viewer via [MCP Apps](https://github.com/modelcontextprotocol/ext-apps). Falls back to JSON + optional base64 thumbnail in text-only clients. |
| `get_artist_timeline` | Chronological timeline of an artist's works in the collection. |
| `open_in_browser` | Open any URL (artwork page, image, viewer) in the user's default browser. |

### Prompts and Resources

| Prompt / Resource | Description |
|---|---|
| `analyze-artwork` | Prompt: analyze an artwork's composition, style, and historical context |
| `generate-artist-timeline` | Prompt: create a visual timeline of an artist's works |
| `art://collection/popular` | Resource: a curated selection of notable paintings |
| `ui://rijksmuseum/artwork-viewer.html` | Resource: interactive IIIF viewer (MCP Apps) |

### Architecture

```
src/
  index.ts                    — Dual-transport entry point (stdio + HTTP)
  registration.ts             — Tool/resource/prompt registration
  types.ts                    — Linked Art, IIIF, and output types
  viewer.ts                   — OpenSeadragon HTML generator (HTTP mode)
  api/
    RijksmuseumApiClient.ts   — Linked Art API client, vocabulary resolver, bibliography, IIIF image chain
  utils/
    SystemIntegration.ts      — Cross-platform browser opening
apps/
  artwork-viewer/             — MCP Apps inline IIIF viewer (Vite + OpenSeadragon)
```

### Data Sources

The server uses the Rijksmuseum's open APIs with no authentication required:

| API | URL | Purpose |
|---|---|---|
| Search API | `https://data.rijksmuseum.nl/search/collection` | Field-based search (title, creator, type, material, technique, date, description), returns Linked Art URIs |
| Linked Art resolver | `https://id.rijksmuseum.nl/{id}` | Object metadata, vocabulary terms, and bibliography as JSON-LD |
| IIIF Image API | `https://iiif.micr.io/{id}/info.json` | High-resolution image tiles |

**Image discovery chain (4 HTTP hops):** Object `.shows` > VisualItem `.digitally_shown_by` > DigitalObject `.access_point` > IIIF info.json

**Vocabulary resolution:** Material, object type, technique, place, and collection terms are Rijksmuseum vocabulary URIs. These are resolved in parallel to obtain English labels and links to external authorities (Getty AAT, Wikidata).

**Bibliography resolution:** Publication references resolve to Schema.org Book records (a different JSON-LD context from the Linked Art artwork data) with author, title, ISBN, and WorldCat links.

### Configuration

| Variable | Description | Default |
|---|---|---|
| `PORT` | HTTP server port (presence triggers HTTP mode) | `3000` |
| `ALLOWED_ORIGINS` | CORS origins (comma-separated) | `*` |

---

## Data and Image Credits

Collection data and images are provided by the **[Rijksmuseum, Amsterdam](https://www.rijksmuseum.nl/)** via their [Linked Open Data APIs](https://data.rijksmuseum.nl/).

**Licensing:** Information and data that are no longer (or never were) protected by copyright carry the **Public Domain Mark** and/or **[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)**. Where the Rijksmuseum holds copyright, it generally waives its rights under CC0 1.0; in cases where it does exercise copyright, materials are made available under **[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)**. Materials under third-party copyright without express permission are not made available as open data. Individual licence designations appear on the [collection website](https://www.rijksmuseum.nl/en/rijksstudio).

**Attribution:** The Rijksmuseum considers it good practice to provide attribution and/or source citation via a credit line and data citation, regardless of the licence applied. Even where not legally required, the museum asks that users credit the Rijksmuseum (and, where possible, its staff) as the original creator.

See the Rijksmuseum's [information and data policy](https://data.rijksmuseum.nl/policy/information-and-data-policy) for the full terms.

## Authors

- [Arno Bosse](https://orcid.org/0000-0003-3681-1289) — [RISE, University of Basel](https://rise.unibas.ch/)
- Claude Code — [Anthropic](https://www.anthropic.com/)

## License

This project is licensed under the [MIT License](LICENSE).
