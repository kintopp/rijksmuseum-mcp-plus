# rijksmuseum-mcp+

An AI-powered ([Model Context Protocol](https://www.anthropic.com/news/model-context-protocol)) (MCP) interface to the [Rijksmuseum](https://www.rijksmuseum.nl/) collection. Search artworks, explore their history, view high-resolution images, and access scholarly references — all through natural conversation.

> This project was inspired by [@r-huijts/rijksmuseum-mcp](https://github.com/r-huijts/rijksmuseum-mcp), the original Rijksmuseum MCP server which used the museum's now unsupported REST API. 

rijksmuseum-mcp+ is based on the Rijksmuseum's [Linked Open Data APIs](https://data.rijksmuseum.nl/), the [Linked Art](https://linked.art/) and [Europeana Data Model](https://pro.europeana.eu/page/edm-documentation) (EDM) standards and also adds some new features (such as an [inline, interactive image viewer](docs/swan_sm.jpg)) made possible by  [recent enhancements](https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/) to the MCP standard.

## Quick Start

The easiest way to try rijksmuseum-mcp+ is with [Claude Desktop](https://claude.com/download) or [claude.ai](https://claude.ai) and the hosted version of the MCP server using the URL below. Note that this currently requires a paid [subscription](https://claude.com/pricing) from Anthropic. 
```
https://rijksmuseum-mcp-plus-production.up.railway.app/mcp
```
Goto Settings → Connectors → Add custom connector → paste the URL above. For more details, see Anthropic's [instructions](https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp#h_3d1a65aded). 

The rijksmuseum-mcp+ MCP server is also compatible with most open-source LLM client applications, such as [Jan.ai](https://jan.ai) which do not require a subscription. They can be used with a cheap, usage based API key from a LLM provider (e.g. from Anthropic, Mistral or OpenRouter) instead.

### Example Queries

"Show me a drawing by Gesina ter Borch"  
"Find Pieter Saenredam's paintings"  
"Find artworks depicting the Raid on the Medway"  
"What paintings depict Amalia van Solms?"  
"Search for winter landscapes from the 17th century"  
"Give me a list of the Rijksmuseum's curated collections"  
"Find all works made in Haarlem with the mezzotint technique"  
"Find artworks with inscriptions mentioning 'fecit'"  
"Find artworks whose provenance mentions Napoleon"  
"Show me prints made after paintings by other artists"  
"What objects were acquired as bequests?"  
"Find artworks depicting places within 100m of the Oude Kerk in Amsterdam"

_to be added: goals (technical and [research](docs/research-scenarios.md)), how it works, how to [search](docs/search-parameters.md)_

---

### Technical Guide

The sections below are for developers who want to run the server locally, deploy it, or understand the architecture.

#### Local Setup (stdio)

For use with Claude Desktop or other MCP clients that communicate over stdio:

```bash
git clone https://github.com/kintopp/rijksmuseum-mcp-plus.git
cd rijksmuseum-mcp-plus
npm install
npm run build
```

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows). If you already have other MCP servers configured, use [MCP Config Generator](https://mcp-conf-gen.pages.dev) to merge this entry into your existing file:

```json
{
  "mcpServers": {
    "rijksmuseum": {
      "command": "node",
      "args": ["/absolute/path/to/rijksmuseum-mcp-plus/dist/index.js"],
      "env": {
        "VOCAB_DB_URL": "https://github.com/kintopp/rijksmuseum-mcp-plus/releases/download/v0.12/vocabulary.db.gz"
      }
    }
  }
}
```

The server works without the vocabulary database, but [vocabulary-backed search parameters](#vocabulary-backed-search-parameters) won't be available. The `VOCAB_DB_URL` setting above enables automatic download (~664 MB compressed, ~2.8 GB uncompressed) on first start.

Restart your MCP client after updating the config.

#### HTTP Deployment

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

#### Tools

| Tool | Description |
|---|---|
| `search_artwork` | Search by query, title, creator, depicted person (`aboutActor`), type, material, technique, date, or description. Filter by image availability. At least one filter required. Supports wildcard date ranges (`16*` for 1600s) and compact mode for fast counts. Returns up to 25 results by default (max 100 via `maxResults`). Vocabulary-backed filters — `subject`, `iconclass`, `depictedPerson`, `depictedPlace`, `productionPlace`, `birthPlace`, `deathPlace`, `profession`, `collectionSet`, `license`, `inscription`, `provenance`, `creditLine`, `narrative`, `productionRole`, and dimension ranges (`minHeight`/`maxHeight`/`minWidth`/`maxWidth`) — enable subject, iconographic, biographical, textual, and physical search across 831,000 artworks. All filters can be freely combined for cross-field intersection queries. |
| `get_artwork_details` | [24 metadata categories](docs/metadata-categories.md) by object number (e.g. `SK-C-5`): titles, creator, date, curatorial narrative, materials, object type, production details, structured dimensions, provenance, credit line, inscriptions, iconographic subjects (Iconclass codes, depicted persons, depicted places), license, related objects, collection sets, persistent IDs, and more. Vocabulary terms are resolved to English labels with links to Getty AAT, Wikidata, and Iconclass. |
| `get_artwork_bibliography` | Scholarly references for an artwork. Summary (first 5) or full (100+ for major works). Resolves publication records with ISBNs and WorldCat links. |
| `get_artwork_image` | IIIF image info + interactive inline deep-zoom viewer via [MCP Apps](https://github.com/modelcontextprotocol/ext-apps). Returns viewer data (IIIF ID, dimensions, URLs) — no image content. For LLM image analysis, use the `analyse-artwork` prompt. |
| `get_artist_timeline` | Chronological timeline of an artist's works in the collection. |
| `open_in_browser` | Open any URL (artwork page, image, viewer) in the user's default browser. |
| `list_curated_sets` | List 192 curated collection sets (exhibitions, scholarly groupings, thematic selections). Optional name filter. Via OAI-PMH. |
| `browse_set` | Browse artworks in a curated set. Returns EDM records with titles, creators, dates, images, IIIF URLs, and iconographic subjects (Iconclass, depicted persons, places). Pagination via resumption token. |
| `resolve_uri` | Resolve a Linked Art URI to full artwork details. Use when `get_artwork_details` returns `relatedObjects` with URIs — pass them directly to learn what the related object is. Returns the same enriched detail as `get_artwork_details`. |
| `get_recent_changes` | Track additions and modifications by date range. Full EDM records (including subjects) or lightweight headers (`identifiersOnly`). Pagination via resumption token. |

#### Prompts and Resources

| Prompt / Resource | Description |
|---|---|
| `analyse-artwork` | Prompt: fetch high-resolution image and analyse visual content alongside key metadata (12 fields) |
| `generate-artist-timeline` | Prompt: create a visual timeline of an artist's works (max 100) |
| `top-100-artworks` | Prompt: explore the Rijksmuseum's Top 100 masterpieces (~133 works from curated set 260213) |
| `ui://rijksmuseum/artwork-viewer.html` | Resource: interactive IIIF viewer (MCP Apps) |

#### Architecture

```
src/
  index.ts                    — Dual-transport entry point (stdio + HTTP)
  registration.ts             — Tool/resource/prompt registration
  types.ts                    — Linked Art, IIIF, and output types
  viewer.ts                   — OpenSeadragon HTML generator (HTTP mode)
  api/
    RijksmuseumApiClient.ts   — Linked Art API client, vocabulary resolver, bibliography, IIIF image chain
    OaiPmhClient.ts           — OAI-PMH client (curated sets, EDM records, change tracking)
    VocabularyDb.ts           — SQLite vocabulary database for subject and iconographic search
  utils/
    ResponseCache.ts          — LRU+TTL response cache
    UsageStats.ts             — Tool call aggregation and periodic flush
    SystemIntegration.ts      — Cross-platform browser opening
apps/
  artwork-viewer/             — MCP Apps inline IIIF viewer (Vite + OpenSeadragon)
data/
  vocabulary.db               — Vocabulary database (built from OAI-PMH harvest, not in git)
```

#### Data Sources

The server uses the Rijksmuseum's open APIs with no authentication required:

| API | URL | Purpose |
|---|---|---|
| Search API | `https://data.rijksmuseum.nl/search/collection` | Field-based search (title, creator, depicted person, type, material, technique, date, description, image availability), returns Linked Art URIs |
| Linked Art resolver | `https://id.rijksmuseum.nl/{id}` | Object metadata, vocabulary terms, and bibliography as JSON-LD |
| IIIF Image API | `https://iiif.micr.io/{id}/info.json` | High-resolution image tiles |
| OAI-PMH | `https://data.rijksmuseum.nl/oai` | Curated sets, EDM metadata records, date-based change tracking. 192 sets, 836K+ records. |

**Image discovery chain (4 HTTP hops):** Object `.shows` > VisualItem `.digitally_shown_by` > DigitalObject `.access_point` > IIIF info.json

**Vocabulary resolution:** Material, object type, technique, place, collection, and subject terms are Rijksmuseum vocabulary URIs. These are resolved in parallel to obtain English labels and links to external authorities (Getty AAT, Wikidata, Iconclass). See [Artwork Metadata Categories](docs/metadata-categories.md) for the full field reference.

**Subject discovery chain:** Object `.shows` > VisualItem `.represents_instance_of_type` (Iconclass concepts) + `.represents` (depicted persons and places). Subject URIs are batched with the existing vocabulary resolution pass.

**Vocabulary database:** A pre-built SQLite database maps 149,000 controlled vocabulary terms to 831,000 artworks via 12.8 million mappings. Built from OAI-PMH EDM records and Linked Art resolution (both vocabulary terms and full artwork records), it powers 17 search filters: vocabulary-backed filters (`subject`, `iconclass`, `depictedPerson`, `depictedPlace`, `productionPlace`, `birthPlace`, `deathPlace`, `profession`, `collectionSet`, `license`, `productionRole`), full-text search on artwork texts (`inscription`, `provenance`, `creditLine`, `narrative`), and numeric dimension ranges (`minHeight`/`maxHeight`/`minWidth`/`maxWidth`). Includes 20,828 geocoded places with coordinates from [Getty TGN](https://www.getty.edu/research/tools/vocabularies/tgn/), [Wikidata](https://www.wikidata.org/), [GeoNames](https://www.geonames.org/), and the [World Historical Gazetteer](https://whgazetteer.org/).

**Bibliography resolution:** Publication references resolve to Schema.org Book records (a different JSON-LD context from the Linked Art artwork data) with author, title, ISBN, and WorldCat links.

#### Configuration

| Variable | Description | Default |
|---|---|---|
| `PORT` | HTTP server port (presence triggers HTTP mode) | `3000` |
| `ALLOWED_ORIGINS` | CORS origins (comma-separated) | `*` |
| `VOCAB_DB_PATH` | Path to vocabulary SQLite database | `data/vocabulary.db` |
| `VOCAB_DB_URL` | URL to download vocabulary DB on first start; gzip supported | *(none)* |
| `USAGE_STATS_PATH` | Path to usage stats JSON file | `data/usage-stats.json` |

---

### Data and Image Credits

Collection data and images are provided by the **[Rijksmuseum, Amsterdam](https://www.rijksmuseum.nl/)** via their [Linked Open Data APIs](https://data.rijksmuseum.nl/).

**Licensing:** Information and data that are no longer (or never were) protected by copyright carry the **Public Domain Mark** and/or **[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)**. Where the Rijksmuseum holds copyright, it generally waives its rights under CC0 1.0; in cases where it does exercise copyright, materials are made available under **[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)**. Materials under third-party copyright without express permission are not made available as open data. Individual licence designations appear on the [collection website](https://www.rijksmuseum.nl/en/rijksstudio).

**Attribution:** The Rijksmuseum considers it good practice to provide attribution and/or source citation via a credit line and data citation, regardless of the licence applied.

See the Rijksmuseum's [information and data policy](https://data.rijksmuseum.nl/policy/information-and-data-policy) for the full terms.

### Authors

[Arno Bosse](https://orcid.org/0000-0003-3681-1289) — [RISE, University of Basel](https://rise.unibas.ch/) with Claude Code [Anthropic](https://www.anthropic.com/).

### License

This project is licensed under the [MIT License](LICENSE).
