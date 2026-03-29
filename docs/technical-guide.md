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
      "args": ["/absolute/path/to/rijksmuseum-mcp-plus/dist/index.js"]
    }
  }
}
```

The vocabulary, Iconclass, and embeddings databases are downloaded automatically on first start (~260 MB + ~51 MB + ~589 MB compressed). The server works without them, but [vocabulary-backed search parameters](search-parameters.md), `lookup_iconclass`, and `semantic_search` won't be available. The embedding model (~130 MB) is also downloaded on first use.

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
| `GET /similar/:uuid` | find_similar HTML comparison pages (30-min TTL) |
| `GET /enrichment-review/:uuid` | LLM enrichment review pages (30-min TTL) |
| `GET /health` | Health check |

The included `railway.json` supports one-click deployment on [Railway](https://railway.app/). Railway sets `PORT` automatically.

#### Tools

See [mcp-tool-parameters.md](mcp-tool-parameters.md) for the full parameter reference.

| Tool | Description |
|---|---|
| `search_artwork` | Search the collection using [39 search filters](search-parameters.md) including full-text fields, vocabulary labels, creator demographics, dimensions, geo proximity, and place hierarchy expansion. Returns up to 25 results (max 50). Compact mode, facets, and offset pagination supported. |
| `semantic_search` | Find artworks by meaning, concept, or theme using natural language. Returns up to 15 results (max 50) ranked by semantic similarity with reconstructed source text for grounding. Pre-filters: `type`, `material`, `technique`, `creationDate`, `dateMatch`, `creator`, `subject`, `iconclass`, `depictedPerson`, `depictedPlace`, `productionPlace`, `collectionSet`, `aboutActor`, `imageAvailable`. Requires embeddings database and embedding model. |
| `collection_stats` | Aggregate statistics, counts, and distributions across any dimension (artwork or provenance). Returns formatted text tables. Artwork dimensions: type, material, technique, creator, century, decade, etc. Provenance dimensions: transferType, party, location, decade, etc. Artwork filters: type, material, technique, creator, productionPlace, depictedPerson, depictedPlace, subject, iconclass, collectionSet, creatorGender, creatorBornAfter/Before, imageAvailable, creation date range. Provenance filters: transferType, location, party, date range, categoryMethod, positionMethod. All filters combine freely. |
| `get_artwork_details` | [26 metadata categories](metadata-categories.md) by object number (e.g. `SK-C-5`) or Linked Art URI. Returns titles, creator, date, description, curatorial narrative, dimensions, materials, production details (with creator life dates, gender, biographical notes, attribution qualifiers, and Wikidata IDs where available), provenance (raw text + parsed chain), inscriptions, iconographic subjects, related objects, and more. Vocabulary terms resolved to English labels with links to Getty AAT, Wikidata, and Iconclass. |
| `get_artwork_bibliography` | Scholarly references for an artwork by its objectNumber. Summary (first 5 + total count) by default, or full (100+ for major works). Resolves publication records with ISBNs and WorldCat links. |
| `get_artwork_image` | View an artwork in high resolution with an interactive deep-zoom viewer (zoom, pan, rotate, flip) via [MCP Apps](https://github.com/modelcontextprotocol/ext-apps). For LLM image analysis, use `inspect_artwork_image` instead. |
| `inspect_artwork_image` | Retrieve an artwork image or region as base64 for direct visual analysis by the LLM. Regions: `full`, `square`, `pct:x,y,w,h`, or `x,y,w,h`. Size 200–2000 px, rotation (0/90/180/270), quality (default or grayscale). Auto-navigates the open viewer to the inspected region. |
| `navigate_viewer` | Navigate the artwork viewer to a specific region and/or add labeled visual overlays. Requires a `viewUUID` from a prior `get_artwork_image` call. Commands: `navigate`, `add_overlay` (with `relativeTo` for crop-local coordinates), `clear_overlays`. |
| `search_provenance` | Search ownership and provenance history across ~48K artworks with parsed provenance records. Filter by party, transfer type, date range, location, price/currency, provenance gaps, and cross-references. Two layers: raw events and interpreted ownership periods. Sorting by price, date, event count, or duration. Includes provenance-of-provenance metadata (parse method, LLM enrichment reasoning). |
| `collection_stats` | (see above) |
| `find_similar` | Find artworks similar to a given artwork across five independent signals (Lineage, Iconclass, Description, Depicted Person, Depicted Place) plus a pooled column. Returns a URL/path to an HTML comparison page. Feature-gated via `ENABLE_FIND_SIMILAR`. |
| `lookup_iconclass` | Search or browse the Iconclass classification system (~40K notations, 13 languages). Three modes: keyword search (`query`), notation browsing (`notation`), or semantic concept search (`semanticQuery`). Discover notation codes by concept, then use with `search_artwork`'s `iconclass` parameter. |
| `list_curated_sets` | List 192 curated collection sets (exhibitions, scholarly groupings, thematic collections). Optional name filter. Via OAI-PMH. |
| `browse_set` | Browse artworks in a curated set. Returns EDM records with titles, creators, dates, images, IIIF URLs, and iconographic subjects. Pagination via resumption token. |
| `get_recent_changes` | Track additions and modifications by date range. Full EDM records or lightweight headers (`identifiersOnly`). Pagination via resumption token. |
| `poll_viewer_commands` | Internal: poll for pending viewer navigation commands. Used by the artwork viewer; not called directly by users. |

**Structured output:** 12 of 15 tools return typed structured data (`structuredContent`) alongside the text summary. `collection_stats` and `find_similar` return text only by design. MCP clients that support `outputSchema` ([spec](https://modelcontextprotocol.io/specification/2025-11-25)) receive machine-readable results for richer UI rendering. Set `STRUCTURED_CONTENT=false` to disable if your client has compatibility issues.

#### Prompts and Resources

| Prompt / Resource | Description |
|---|---|
| `generate-artist-timeline` | Prompt: generate a chronological timeline of an artist's works in the collection using `search_artwork` with a creator filter, sorted by date. Default 25 works, max 50 — for prolific artists this is a small sample. |
| `generate-session-trace` | Prompt: create a debug trace of all tool calls made to the server during a conversation, formatted as timestamped JSONL for developer feedback. Optional session description argument. |
| `ui://rijksmuseum/artwork-viewer.html` | Resource: interactive IIIF deep-zoom viewer for Rijksmuseum artworks (MCP Apps) |

#### Architecture

```
src/
  index.ts                    — Dual-transport entry point (stdio + HTTP)
  registration.ts             — Tool/resource/prompt registration, hybrid search routing
  types.ts                    — Linked Art, IIIF, and output types
  viewer.ts                   — OpenSeadragon HTML generator (HTTP mode)
  similarHtml.ts              — HTML template for find_similar comparison pages
  enrichmentReviewHtml.ts     — HTML review pages for LLM enrichments
  provenance.ts               — Provenance event parsing + DB queries
  provenance-grammar.peggy    — PEG grammar for provenance text
  provenance-peg.ts           — PEG parser driver + regex fallback
  provenance-interpret.ts     — Event interpretation layer (ownership periods)
  api/
    RijksmuseumApiClient.ts   — Linked Art API client, vocabulary resolver, bibliography, IIIF image chain
    OaiPmhClient.ts           — OAI-PMH client (curated sets, EDM records, change tracking)
    VocabularyDb.ts           — SQLite vocabulary database (vocab term, full-text, dimension, date, and geo proximity search)
    IconclassDb.ts            — Iconclass notation search/browse (SQLite)
    EmbeddingsDb.ts           — sqlite-vec vector search (pure KNN + filtered KNN)
    EmbeddingModel.ts         — HuggingFace Transformers embedding model (ONNX/WASM)
  auth/
    StubOAuthProvider.ts      — No-op OAuth provider for Claude client compatibility
  utils/
    db.ts                     — Shared path resolution (PROJECT_ROOT, import.meta.url)
    ResponseCache.ts          — LRU+TTL response cache
    UsageStats.ts             — Tool call aggregation and periodic flush
apps/
  artwork-viewer/             — MCP Apps inline IIIF viewer (Vite + OpenSeadragon)
data/
  vocabulary.db               — Vocabulary database (built from OAI-PMH + Linked Art harvest, not in git)
  iconclass.db                — Iconclass database (built from CC0 dump, not in git)
  embeddings.db               — Artwork embeddings (~832K int8 vectors, not in git)
```

#### Data Sources

The server uses the Rijksmuseum's open APIs with no authentication required:

| API | URL | Purpose |
|---|---|---|
| Search API | `https://data.rijksmuseum.nl/search/collection` | Fallback only: resolves object numbers to Linked Art URIs when the vocabulary database is unavailable. All primary search is handled by the local vocabulary database. |
| Linked Art resolver | `https://id.rijksmuseum.nl/{id}` | Object metadata, vocabulary terms, and bibliography as JSON-LD |
| IIIF Image API | `https://iiif.micr.io/{id}/info.json` | High-resolution image tiles |
| OAI-PMH | `https://data.rijksmuseum.nl/oai` | Curated sets, EDM metadata records, date-based change tracking. 192 sets, 832K+ records. |
| Iconclass (CC0) | `https://iconclass.org/` | ~40K iconographic classification notations with labels in 13 languages and keywords. Powers `lookup_iconclass`. |

**Image discovery chain (4 HTTP hops):** Object `.shows` > VisualItem `.digitally_shown_by` > DigitalObject `.access_point` > IIIF info.json

**Vocabulary resolution:** Material, object type, technique, place, collection, and subject terms are Rijksmuseum vocabulary URIs. These are resolved in parallel to obtain English labels and links to external authorities (Getty AAT, Wikidata, Iconclass). See [Artwork Metadata Categories](metadata-categories.md) for the full field reference.

**Subject discovery chain:** Object `.shows` > VisualItem `.represents_instance_of_type` (Iconclass concepts) + `.represents` (depicted persons and places). Subject URIs are batched with the existing vocabulary resolution pass.

**Vocabulary database:** A pre-built SQLite database maps ~194,000 controlled vocabulary terms to ~832,000 artworks via ~13.7 million mappings. Built from OAI-PMH EDM records and Linked Art resolution (both vocabulary terms and full artwork records), it powers vocabulary-backed filters (`subject`, `iconclass`, `depictedPerson`, `depictedPlace`, `productionPlace`, `birthPlace`, `deathPlace`, `profession`, `collectionSet`, `license`, `productionRole`, `attributionQualifier`), cross-filters (`material`, `technique`, `type`, `creator`), full-text search on artwork texts (`inscription`, `provenance`, `creditLine`, `curatorialNarrative`, `title`, `description`), date range filtering (`creationDate` with `dateMatch` modes), numeric dimension ranges (`minHeight`/`maxHeight`/`minWidth`/`maxWidth`), and geo proximity search (`nearPlace`, `nearLat`/`nearLon`, `nearPlaceRadius`). Includes ~31,000 geocoded places (96% coverage) with coordinates from [Getty TGN](https://www.getty.edu/research/tools/vocabularies/tgn/), [Wikidata](https://www.wikidata.org/), [GeoNames](https://www.geonames.org/), and the [World Historical Gazetteer](https://whgazetteer.org/), supplemented by coordinate inheritance from parent places via a spatial hierarchy. Place name queries support fuzzy matching with geo-disambiguation for ambiguous names. The database also contains biographical data for ~49,000 creators (birth/death years), ~64,000 gender annotations, ~11,000 biographical notes, and ~5,000 Wikidata identifiers, enriched from Rijksmuseum actor authority files and data dumps. Provenance data covers ~48,000 artworks with parsed ownership chains (events, parties, transfer types, dates, locations, prices).

**Iconclass database:** A separate SQLite database contains ~41,000 Iconclass notations with ~279,000 texts in 13 languages and ~780,000 keywords. Each notation includes a pre-computed count of matching Rijksmuseum artworks (cross-referenced from the vocabulary database). Powers the `lookup_iconclass` tool for keyword search, hierarchy browsing, and semantic concept search.

**Embeddings database:** A pre-built SQLite database contains ~832,000 int8-quantized embeddings (384 dimensions) generated by [`intfloat/multilingual-e5-small`](https://huggingface.co/intfloat/multilingual-e5-small) from composite artwork text (title, inscriptions, description, curatorial narrative — subjects and creator names deliberately excluded). Vector search uses [sqlite-vec](https://github.com/asg017/sqlite-vec) with dual paths: vec0 virtual table for pure KNN, and `vec_distance_cosine()` on a regular table for filtered KNN (pre-filtered by type, material, technique, date, creator, subject, iconclass, depictedPerson, depictedPlace, productionPlace, collectionSet, aboutActor, or imageAvailable via the vocabulary database). Source text is not stored in the embeddings DB — it is reconstructed from the vocabulary database at query time, matching the original embedding generation format.

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
| `ENABLE_FIND_SIMILAR` | Set to `"false"` to disable the `find_similar` tool | `true` |
| `STRUCTURED_CONTENT` | Set to `"false"` to disable structured output (workaround for clients with `outputSchema` bugs) | *(enabled)* |
| `USAGE_STATS_PATH` | Path to usage stats JSON file | `data/usage-stats.json` |
