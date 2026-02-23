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
"Find artworks with inscriptions mentioning 'fecit'"  
"Find artworks whose provenance mentions Napoleon"  
"Show me prints made after paintings by other artists"  
"Find artworks depicting places within 100m of the Oude Kerk in Amsterdam"
"What Iconclass codes relate to 'smell'?"
"Browse the Iconclass hierarchy for notation 73D73 (Man of Sorrows)"

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

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows).

```json
{
  "mcpServers": {
    "rijksmuseum": {
      "command": "node",
      "args": ["/absolute/path/to/rijksmuseum-mcp-plus/dist/index.js"],
      "env": {
        "STRUCTURED_CONTENT": "false"
      }
    }
  }
}
```

The vocabulary, Iconclass, and embeddings databases are downloaded automatically on first start (~398 MB + ~40 MB + ~389 MB compressed). The server works without them, but [vocabulary-backed search parameters](#vocabulary-backed-search-parameters), `lookup_iconclass`, and `semantic_search` won't be available. The embedding model (~80 MB) is also downloaded on first use. `STRUCTURED_CONTENT=false` disables structured output, which is needed for Claude Desktop compatibility.

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
| `POST /mcp` | MCP protocol (stateless Streamable HTTP) |
| `GET /viewer?iiif={id}&title={title}` | OpenSeadragon IIIF deep-zoom viewer |
| `GET /health` | Health check |

The included `railway.json` supports one-click deployment on [Railway](https://railway.app/). Railway sets `PORT` automatically.

#### Tools

| Tool | Description |
|---|---|
| `search_artwork` | Search the collection by creator, type, material, technique, date, title, description, and [30+ vocabulary-backed filters](docs/search-parameters.md) including subject, iconclass, depicted person/place, production place, provenance, inscription, curatorialNarrative, dimensions, and geo proximity. Returns up to 25 results (max 100). Compact mode and pagination supported. |
| `get_artwork_details` | [24 metadata categories](docs/metadata-categories.md) by object number (e.g. `SK-C-5`): titles, creator, date, description, curatorial narrative, dimensions, materials, production details, provenance, inscriptions, iconographic subjects, related objects, and more. Vocabulary terms resolved to English labels with links to Getty AAT, Wikidata, and Iconclass. |
| `get_artwork_bibliography` | Scholarly references for an artwork by its objectNumber (from `search_artwork`, `browse_set`, `get_recent_changes`, or `get_artwork_details`). Summary (first 5 + total count) by default, or full (100+ for major works — consider the context window). Resolves publication records with ISBNs and WorldCat links. |
| `get_artwork_image` | View an artwork in high resolution with an interactive deep-zoom viewer (zoom, pan, rotate, flip) via [MCP Apps](https://github.com/modelcontextprotocol/ext-apps). Not all artworks have images available. Downloadable images are available from the artwork's collection page on rijksmuseum.nl. Do not construct IIIF image URLs manually. For LLM image analysis, use the `analyse-artwork` prompt instead. |
| `get_artist_timeline` | Chronological timeline of an artist's works in the collection. Searches by creator name, resolves each result, and sorts by creation date. Each work includes an objectNumber for use with `get_artwork_details` or `get_artwork_image`. |
| `open_in_browser` | Open a URL in the user's default browser. Useful for opening an artwork's Rijksmuseum collection page, where a high-resolution image can be downloaded. |
| `list_curated_sets` | List 192 curated collection sets (exhibitions, scholarly groupings, thematic collections). Returns set identifiers that can be used with `browse_set` to explore their contents. Optional name filter. Via OAI-PMH. |
| `browse_set` | Browse artworks in a curated set. Returns EDM records with titles, creators, dates, images, IIIF URLs, and iconographic subjects (Iconclass, depicted persons, places). Each record includes an objectNumber for use with `get_artwork_details`, `get_artwork_image`, or `get_artwork_bibliography`. Pagination via resumption token. |
| `resolve_uri` | Resolve a Linked Art URI to full artwork details. Use when you have a URI from `relatedObjects` or other tool output and want to learn what that object is. Returns the same enriched detail as `get_artwork_details`. |
| `get_recent_changes` | Track additions and modifications by date range. Full EDM records (including subjects) or lightweight headers (`identifiersOnly`). Each record includes an objectNumber for use with `get_artwork_details`, `get_artwork_image`, or `get_artwork_bibliography`. Pagination via resumption token. |
| `lookup_iconclass` | Search or browse the Iconclass classification system (~40K notations, 13 languages). Discover notation codes by concept (e.g. 'smell' → `31A33`), then use with `search_artwork`'s `iconclass` parameter for precise subject searches. Browse mode shows hierarchy and children. |
| `semantic_search` | Find artworks by meaning, concept, or theme using natural language. Returns up to 25 results ranked by semantic similarity with reconstructed source text for grounding. Best for concepts that cannot be expressed as structured metadata — atmospheric qualities, compositional descriptions, art-historical interpretation, or cross-language queries. Filters: `type`, `material`, `technique`, `creationDate`, `creator`. Requires embeddings database and embedding model. |

**Structured output:** 9 of 12 tools return typed structured data (`structuredContent`) alongside the text summary. MCP clients that support `outputSchema` ([spec](https://modelcontextprotocol.io/specification/2025-11-25)) receive machine-readable results for richer UI rendering. Clients that don't support it simply use the text content. Set `STRUCTURED_CONTENT=false` to disable if your client has compatibility issues.

#### Prompts and Resources

| Prompt / Resource | Description |
|---|---|
| `analyse-artwork` | Share an artwork image with the AI so it can see and discuss it. The image is fetched server-side (via IIIF) and returned as base64 directly in the conversation. Use `get_artwork_details` for full metadata if needed. |
| `generate-artist-timeline` | Prompt: generate a chronological timeline of an artist's works in the collection. Default 25 works, max 100 — for prolific artists this is a small sample. |
| `top-100-artworks` | Prompt: the Rijksmuseum's official Top 100 masterpieces (curated set 260213). Fetches the full list with titles, creators, dates, types, and object numbers for further exploration. |
| `ui://rijksmuseum/artwork-viewer.html` | Resource: interactive IIIF deep-zoom viewer for Rijksmuseum artworks (MCP Apps) |

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
    VocabularyDb.ts           — SQLite vocabulary database (vocab term, full-text, dimension, date, and geo proximity search)
    IconclassDb.ts            — Iconclass notation search/browse (SQLite)
    EmbeddingsDb.ts           — sqlite-vec vector search (pure KNN + filtered KNN)
    EmbeddingModel.ts         — HuggingFace Transformers embedding model (ONNX/WASM)
  utils/
    db.ts                     — Shared path resolution (PROJECT_ROOT, import.meta.url)
    ResponseCache.ts          — LRU+TTL response cache
    UsageStats.ts             — Tool call aggregation and periodic flush
    SystemIntegration.ts      — Cross-platform browser opening
apps/
  artwork-viewer/             — MCP Apps inline IIIF viewer (Vite + OpenSeadragon)
data/
  vocabulary.db               — Vocabulary database (built from OAI-PMH + Linked Art harvest, not in git)
  iconclass.db                — Iconclass database (built from CC0 dump, not in git)
  embeddings.db               — Artwork embeddings (831K int8 vectors, not in git)
```

#### Data Sources

The server uses the Rijksmuseum's open APIs with no authentication required:

| API | URL | Purpose |
|---|---|---|
| Search API | `https://data.rijksmuseum.nl/search/collection` | Field-based search (title, creator, depicted person, type, material, technique, date, description, image availability), returns Linked Art URIs |
| Linked Art resolver | `https://id.rijksmuseum.nl/{id}` | Object metadata, vocabulary terms, and bibliography as JSON-LD |
| IIIF Image API | `https://iiif.micr.io/{id}/info.json` | High-resolution image tiles |
| OAI-PMH | `https://data.rijksmuseum.nl/oai` | Curated sets, EDM metadata records, date-based change tracking. 192 sets, 831K+ records. |
| Iconclass (CC0) | `https://iconclass.org/` | ~40K iconographic classification notations with labels in 13 languages and keywords. Powers `lookup_iconclass`. |

**Image discovery chain (4 HTTP hops):** Object `.shows` > VisualItem `.digitally_shown_by` > DigitalObject `.access_point` > IIIF info.json

**Vocabulary resolution:** Material, object type, technique, place, collection, and subject terms are Rijksmuseum vocabulary URIs. These are resolved in parallel to obtain English labels and links to external authorities (Getty AAT, Wikidata, Iconclass). See [Artwork Metadata Categories](docs/metadata-categories.md) for the full field reference.

**Subject discovery chain:** Object `.shows` > VisualItem `.represents_instance_of_type` (Iconclass concepts) + `.represents` (depicted persons and places). Subject URIs are batched with the existing vocabulary resolution pass.

**Vocabulary database:** A pre-built SQLite database maps 149,000 controlled vocabulary terms to 831,000 artworks via 12.8 million mappings. Built from OAI-PMH EDM records and Linked Art resolution (both vocabulary terms and full artwork records), it powers vocabulary-backed filters (`subject`, `iconclass`, `depictedPerson`, `depictedPlace`, `productionPlace`, `birthPlace`, `deathPlace`, `profession`, `collectionSet`, `license`, `productionRole`), cross-filters (`material`, `technique`, `type`, `creator`), full-text search on artwork texts (`inscription`, `provenance`, `creditLine`, `curatorialNarrative`, `title`), date range filtering (`creationDate`), numeric dimension ranges (`minHeight`/`maxHeight`/`minWidth`/`maxWidth`), and geo proximity search (`nearPlace`, `nearLat`/`nearLon`, `nearPlaceRadius`). Includes 20,828 geocoded places with coordinates from [Getty TGN](https://www.getty.edu/research/tools/vocabularies/tgn/), [Wikidata](https://www.wikidata.org/), [GeoNames](https://www.geonames.org/), and the [World Historical Gazetteer](https://whgazetteer.org/). Place name queries support fuzzy matching with geo-disambiguation for ambiguous names.

**Iconclass database:** A separate SQLite database contains 40,675 Iconclass notations with 279,000 texts in 13 languages and 780,000 keywords. Each notation includes a pre-computed count of matching Rijksmuseum artworks (cross-referenced from the vocabulary database). Powers the `lookup_iconclass` tool for concept search and hierarchy browsing.

**Embeddings database:** A pre-built SQLite database contains 831,667 int8-quantized embeddings (384 dimensions) generated by [`intfloat/multilingual-e5-small`](https://huggingface.co/intfloat/multilingual-e5-small) from composite artwork text (title, creator, subjects, curatorial narrative, inscriptions, description). Vector search uses [sqlite-vec](https://github.com/asg017/sqlite-vec) with dual paths: vec0 virtual table for pure KNN, and `vec_distance_cosine()` on a regular table for filtered KNN (pre-filtered by type, material, technique, date, or creator via the vocabulary database). Source text is not stored in the embeddings DB — it is reconstructed from the vocabulary database at query time, matching the original embedding generation format.

**Bibliography resolution:** Publication references resolve to Schema.org Book records (a different JSON-LD context from the Linked Art artwork data) with author, title, ISBN, and WorldCat links.

#### Configuration

| Variable | Description | Default |
|---|---|---|
| `PORT` | HTTP server port (presence triggers HTTP mode) | `3000` |
| `ALLOWED_ORIGINS` | CORS origins (comma-separated) | `*` |
| `PUBLIC_URL` | Base URL for viewer links in HTTP mode (e.g. `https://example.up.railway.app`) | `http://localhost:$PORT` |
| `VOCAB_DB_PATH` | Path to vocabulary SQLite database | `data/vocabulary.db` |
| `VOCAB_DB_URL` | URL to download vocabulary DB on first start; gzip supported | *(none)* |
| `ICONCLASS_DB_PATH` | Path to Iconclass SQLite database | `data/iconclass.db` |
| `ICONCLASS_DB_URL` | URL to download Iconclass DB on first start; gzip supported | *(none)* |
| `EMBEDDINGS_DB_PATH` | Path to embeddings SQLite database | `data/embeddings.db` |
| `EMBEDDINGS_DB_URL` | URL to download embeddings DB on first start; gzip supported | *(none)* |
| `EMBEDDING_MODEL_ID` | HuggingFace model ID for query embedding | `Xenova/multilingual-e5-small` |
| `HF_HOME` | HuggingFace cache directory (useful for persistent volumes in deployment) | *(system default)* |
| `STRUCTURED_CONTENT` | Set to `"false"` to disable structured output (workaround for clients with `outputSchema` bugs) | *(enabled)* |
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
