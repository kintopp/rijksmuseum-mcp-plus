# rijksmuseum-mcp+

An AI-powered interface to the [Rijksmuseum](https://www.rijksmuseum.nl/) collection. Search artworks, explore their history, view high-resolution images, and access scholarly references — all through natural conversation.

Built on the Rijksmuseum's [Linked Open Data APIs](https://data.rijksmuseum.nl/), the [Linked Art](https://linked.art/) and [Europeana Data Model](https://pro.europeana.eu/page/edm-documentation) (EDM) standards, and the [Model Context Protocol](https://modelcontextprotocol.io/) (MCP).

> This project was inspired by [@r-huijts/rijksmuseum-mcp](https://github.com/r-huijts/rijksmuseum-mcp), the original Rijksmuseum MCP server. That version used the museum's REST API which is no longer supported. This is a ground-up rewrite using the museum's newer Linked Open Data infrastructure and adds features like an interactive inline image viewer.

## Quick Start

The easiest way to try rijksmuseum-mcp+ is through the hosted version — no installation needed.

**Connect your MCP client to:**

```
https://rijksmuseum-mcp-plus-production.up.railway.app/mcp
```

Once connected, just ask questions in plain language. Here are some things you can try:

### Searching the collection

```
"Find Pieter Saenredam's paintings of church interiors"
"Show me woodcuts by Hokusai"
"Search for paintings from the 1640s"
"What porcelain objects are in the collection?"
"Find portraits depicting Willem van Oranje"
"Show me drawings by Gesina ter Borch"
"How many mezzotints are in the collection?"
"Search for paintings by Vermeer that have images available"
```

### Learning about specific artworks

Each artwork comes with up to 25 metadata categories — including curatorial narratives, materials, object types, production details, structured dimensions, provenance, iconographic subjects (Iconclass codes, depicted persons, and places), and links to external identifiers (Getty AAT, Wikidata, Iconclass). See [Artwork Metadata Categories](docs/metadata-categories.md) for a full catalogue of these categories.

```
"What inscriptions did Saenredam include on his painting of the Assendelft church?"
"Trace the provenance of Avercamp's Winter Landscape with Ice Skaters"
"What materials and techniques were used for the Shiva Nataraja (AK-MAK-187)?"
"Tell me about Rachel Ruysch's Still Life with Flowers in a Glass Vase"
"Show me the production details for The Windmill at Wijk bij Duurstede"
"What Iconclass subjects are depicted in The Night Watch?"
"Who are the depicted persons in Rembrandt's Anatomy Lesson of Dr Nicolaes Tulp?"
```

### Bibliographic references

The Rijksmuseum provides bibliography data for its artworks — from a handful of references for lesser-known works to over a hundred for the most studied pieces.

```
"Show me the bibliography for Saenredam's Assendelft church interior"
"Get scholarly references for the Shiva Nataraja (AK-MAK-187)"
"How many publications cite Avercamp's Winter Landscape with Ice Skaters?"
```

### Viewing high-resolution images

The server includes an interactive deep-zoom viewer that renders directly in your chat. You can zoom into brushstroke-level detail, pan across the canvas, and rotate the image — without leaving the conversation.

```
"Show me a high-resolution image of Avercamp's Winter Landscape with Ice Skaters"
"Let me zoom into the brushwork on Rachel Ruysch's flower painting"
"Show me the image for AK-MAK-187"
```

In clients that support [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) (e.g. [Claude Desktop](https://claude.com/download), [claude.ai](https://claude.ai)), you get an interactive viewer with zoom, pan, rotate, and flip controls, plus keyboard shortcuts. In other clients, you still get image URLs and an optional thumbnail.

### Exploring an artist's career

```
"Create a timeline of Hendrick Goltzius's works in the Rijksmuseum"
"Show me Gesina ter Borch's works in chronological order"
"Map out Jacob van Ruisdael's artistic development from the Rijksmuseum collection"
```

### Browsing curated sets

The Rijksmuseum organises its collection into 192 curated sets — exhibition groupings, scholarly themes, and curatorial selections. You can explore these sets and browse their contents.

```
"What curated sets cover VOC shipwreck archaeology?"
"Browse the Rijksprentenkabinet's Japanese print collection"
"Show me what's in the Rijksmuseum's selection of medieval illuminated manuscripts"
"Are there any curated sets devoted to surimono prints?"
```

Each record bridges directly to the full Linked Art tools — you can ask for details, images, or bibliography on anything you find.

### Tracking collection changes

The server exposes the museum's change-tracking feed, so you can see what's been recently added or updated.

```
"What has the Rijksmuseum added to its collection in the last month?"
"Show me recent acquisitions of Asian art"
"Have any Saenredam records been updated recently?"
```

### The LLM fills in the gaps

Because the MCP client is itself a large language model, you don't need to know the exact search terms, language, or spelling the API expects. The LLM bridges the gap using its background knowledge — translating, correcting, cross-referencing, and explaining when something falls outside the collection.

```
"Laat me De Bedreigde Zwaan zien"
```
*Translates from Dutch, identifies The Threatened Swan by Jan Asselijn (SK-A-4), and retrieves its details.*

```
"Find the dollhouse that inspired Jessie Burton's novel The Miniaturist"
```
*Knows the novel was inspired by Petronella Oortman's dollhouse (SK-A-4245) and searches by the Dutch catalogue title.*

```
"Show me works by the artist who taught Rembrandt"
```
*Identifies Pieter Lastman as Rembrandt's teacher and finds his 7 works in the collection.*

```
"What etchings by Hercules Seghers are in the collection?"
```
*Recognises "Seghers" as a common historical variant and searches under the Rijksmuseum's canonical spelling "Segers" (77 works).*

```
"Show me Vermeer's Girl with a Pearl Earring"
```
*Explains that this painting is at the Mauritshuis in The Hague, not the Rijksmuseum, and offers to show Vermeer works that are in the collection.*

---

## Technical Guide

The sections below are for developers who want to run the server locally, deploy it, or understand the architecture.

### Local Setup (stdio)

For use with Claude Desktop or other MCP clients that communicate over stdio:

```bash
git clone https://github.com/kintopp/rijksmuseum-mcp-plus.git
cd rijksmuseum-mcp-plus
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
| `get_artwork_details` | 25 metadata categories by object number (e.g. `SK-C-5`): titles, creator, date, curatorial narrative, materials, object type, production details, structured dimensions, provenance, credit line, inscriptions, iconographic subjects (Iconclass codes, depicted persons, depicted places), license, related objects, collection sets, persistent IDs, and more. Vocabulary terms are resolved to English labels with links to Getty AAT, Wikidata, and Iconclass. |
| `get_artwork_bibliography` | Scholarly references for an artwork. Summary (first 5) or full (100+ for major works). Resolves publication records with ISBNs and WorldCat links. |
| `get_artwork_image` | IIIF image info + interactive inline deep-zoom viewer via [MCP Apps](https://github.com/modelcontextprotocol/ext-apps). Falls back to JSON + optional base64 thumbnail in text-only clients. |
| `get_artist_timeline` | Chronological timeline of an artist's works in the collection. |
| `open_in_browser` | Open any URL (artwork page, image, viewer) in the user's default browser. |
| `list_curated_sets` | List 192 curated collection sets (exhibitions, scholarly groupings, thematic selections). Optional name filter. Via OAI-PMH. |
| `browse_set` | Browse artworks in a curated set. Returns EDM records with titles, creators, dates, images, IIIF URLs, and iconographic subjects (Iconclass, depicted persons, places). Pagination via resumption token. |
| `get_recent_changes` | Track additions and modifications by date range. Full EDM records (including subjects) or lightweight headers (`identifiersOnly`). Pagination via resumption token. |

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
    OaiPmhClient.ts           — OAI-PMH client (curated sets, EDM records, change tracking)
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
| OAI-PMH | `https://data.rijksmuseum.nl/oai` | Curated sets, EDM metadata records, date-based change tracking. 192 sets, 836K+ records. |

**Image discovery chain (4 HTTP hops):** Object `.shows` > VisualItem `.digitally_shown_by` > DigitalObject `.access_point` > IIIF info.json

**Vocabulary resolution:** Material, object type, technique, place, collection, and subject terms are Rijksmuseum vocabulary URIs. These are resolved in parallel to obtain English labels and links to external authorities (Getty AAT, Wikidata, Iconclass).

**Subject discovery chain:** Object `.shows` > VisualItem `.represents_instance_of_type` (Iconclass concepts) + `.represents` (depicted persons and places). Subject URIs are batched with the existing vocabulary resolution pass.

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

**Attribution:** The Rijksmuseum considers it good practice to provide attribution and/or source citation via a credit line and data citation, regardless of the licence applied.

See the Rijksmuseum's [information and data policy](https://data.rijksmuseum.nl/policy/information-and-data-policy) for the full terms.

## Authors

- [Arno Bosse](https://orcid.org/0000-0003-3681-1289) — [RISE, University of Basel](https://rise.unibas.ch/)
- Claude Code — [Anthropic](https://www.anthropic.com/)

## License

This project is licensed under the [MIT License](LICENSE).
