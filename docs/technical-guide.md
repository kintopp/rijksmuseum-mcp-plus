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

The vocabulary and embeddings databases are downloaded automatically on first start (~491 MB + ~584 MB compressed; ~1.9 GB + ~1.1 GB uncompressed). The server works without them, but [vocabulary-backed search parameters](search-parameters.md) and `semantic_search` won't be available. The embedding model (~130 MB) is also downloaded on first use. For Iconclass taxonomy navigation, use the dedicated [Iconclass MCP server](https://github.com/kintopp/rijksmuseum-iconclass-mcp).

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
| `GET /similar/:uuid` | find_similar HTML comparison pages (30-min TTL) |
| `GET /enrichment-review/:uuid` | LLM enrichment review pages (30-min TTL) |
| `GET /health` | Liveness check |
| `GET /ready` | Warm-up readiness flag (`{ ready, status: "warm" \| "warming" }`) — informational; not gated by Railway healthcheck |
| `GET /debug/memory` | RSS/heap snapshot plus per-DB SQLite mmap usage |

The included `railway.json` supports one-click deployment on [Railway](https://railway.app/). Railway sets `PORT` automatically.

#### CLI

A headless CLI (`scripts/cli.mjs`, exposed as `npm run cli` or the `rijks-mcp` bin — run `npm link` once to put it on your `PATH`) drives the server's stateless tools as an MCP *client* — so a CLI query returns exactly what an LLM would get, and it doubles as a debug/regression harness. It is JSON-first, aimed at agents and shell pipelines. The four viewer/stateful tools (`get_artwork_image`, `navigate_viewer`, `remount_viewer`, `poll_viewer_commands`) are out of scope.

##### CLI-only installation (per OS)

If you only want the `rijks-mcp` command line (not an MCP client integration), the tidiest path is the [`just`](https://github.com/casey/just) command runner over a clone. The `just cli <verb> …` recipe is the wrapper equivalent of the `npm run cli -- <verb> …` examples shown in this section.

**Prerequisites (all platforms):** [Node.js 24.x](https://nodejs.org) (`>=24.14.1 <25`) and the `just` runner. The native dependencies (`better-sqlite3`, `sharp`, `@huggingface/transformers`) ship prebuilt binaries for Windows/macOS/Linux on x64 and arm64, so no compiler is needed except on musl/Alpine.

Install `just`:

| OS | Command |
|---|---|
| macOS | `brew install just` |
| Linux | `apt install just` (or `cargo install just`, or a [prebuilt binary](https://github.com/casey/just/releases)) |
| Windows | `winget install --id Casey.Just` (or `scoop install just` / `choco install just`) |

Clone the repo — it ships a `justfile` at the root with `install`, `build`, `cli`, and `serve` recipes (and a commented-out `RIJKS_MCP_HTTP` line to switch to HTTP; run `just` with no arguments to list them):

```bash
git clone https://github.com/kintopp/rijksmuseum-mcp-plus.git
cd rijksmuseum-mcp-plus
```

Then:

```bash
just install         # stdio and HTTP both need this
just build           # stdio only — skip for HTTP
just cli search --query "tulip" --max 5
```

**Requirements per transport:**

| Transport | Needs | Notes |
|---|---|---|
| **stdio** (default) | `just install` + `just build` + the databases (~1.9 GB + ~1.1 GB on disk) | Selected when neither `--http` nor `RIJKS_MCP_HTTP` is set — the CLI spawns `node dist/index.js` itself (zero-config). The vocabulary and embeddings DBs download automatically to `data/` on the first `cli` run (fully local/offline afterwards); the embedding model (~130 MB) downloads on first `semantic`/`similar` use. |
| **HTTP** | `just install` + a reachable `/mcp` server | Selected via `--http <url>` or `RIJKS_MCP_HTTP` — talks to a running `npm run serve`/Railway server, warm so calls return instantly. No local build or DBs when targeting an already-running server; uncomment the `RIJKS_MCP_HTTP` line in the justfile (the public Railway instance, or your own `just serve`, which itself needs the full stdio setup). |

```bash
npm run cli -- search --query "tulip" --max 5 --fields objectNumber,title
npm run cli -- details SK-C-5 --json
npm run cli -- semantic "ships in a storm" --max 10
npm run cli -- inspect SK-C-5 --region pct:40,40,20,20 --out crop.jpg
npm run cli -- tools --json          # capabilities dump (the agent bootstrap)
npm run cli -- search --help         # flags for one command, generated from the live schema
```

- **Commands** are short verbs aliased to tools (`search`, `semantic`, `persons`, `provenance`, `inscriptions`, `details`, `stats`, `similar`, `browse-set`, `list-sets`, `changes`, `inspect`). The first positional maps to the tool's primary parameter; everything else is a `--flag`. Help and flag coercion are derived from the live `inputSchema`, so they never drift.
- **Output:** list tools emit JSONL on stdout (one object per line, `jq -c`-friendly); single-object tools emit one compact JSON object. `--json` prints the whole payload pretty; `--table` is a terse human view; `--fields a,b,c` projects keys (the main token lever). Counts, pagination hints (`--offset` / `--resumption-token`), and warnings go to stderr to keep stdout clean. `--show-call` prints the resolved `{tool, arguments}` without executing.
- **Exit codes:** `0` ok · `1` tool/connection error · `2` usage error. Tool errors preserve the server's prose routing hints (on stderr).

Smoke test: `npm run test:cli` (needs a built `dist/` + the DBs; hits live IIIF, so it is excluded from `npm test`/`test:all`).

See the [CLI guide](cli-guide.md) for the full command reference, output model, and pipeline recipes.

#### Tools

See [mcp-tool-parameters.md](mcp-tool-parameters.md) for the full parameter reference.

| Tool | Description |
|---|---|
| `search_artwork` | Search the collection using [32 search filters](search-parameters.md) including full-text fields, vocabulary labels, creator demographics, dimensions, geo proximity, place hierarchy expansion, curatorial themes, and source-channel taxonomy. Returns up to 25 results (max 50). Compact mode, facets, offset pagination, and `sortBy`/`sortOrder` (with universal `art_id` tiebreaker) supported. |
| `search_persons` | Search the ~290K person + ~12K group authority records by name (~700K name variants), gender, birth/death year, birth/death place, or profession. Returns vocab IDs to feed into `search_artwork({creator: …})` for works *by* a person, or `search_artwork({aboutActor: …})` for works *depicting* them. By default restricts to persons with ≥1 artwork in the collection. |
| `semantic_search` | Find artworks by meaning, concept, or theme using natural language. Returns up to 15 results (max 50) ranked by semantic similarity with reconstructed source text for grounding. Pre-filters: `type`, `material`, `technique`, `creationDate`, `dateMatch`, `creator`, `subject`, `iconclass`, `depictedPerson`, `depictedPlace`, `productionPlace`, `collectionSet`, `aboutActor`, `imageAvailable`. Requires embeddings database and embedding model. |
| `collection_stats` | Aggregate statistics, counts, and distributions across any dimension (artwork or provenance). Returns text tables plus a structured payload disclosing denominator/grouping/coverage semantics. Artwork dimensions: type, material, technique, creator, depictedPerson, depictedPlace, productionPlace, century, decade, height, width, theme, sourceType, exhibition, decadeModified. Provenance dimensions: transferType, transferCategory, provenanceDecade, provenanceLocation, party, partyPosition, currency, categoryMethod, positionMethod, parseMethod. Artwork filters: type, material, technique, creator, productionPlace, depictedPerson, depictedPlace, subject, iconclass, collectionSet, theme, sourceType, attributionQualifier, productionRole, sameRowMatching, imageAvailable, creationDateFrom/To. Provenance filters: hasProvenance, transferType, provenanceLocation, party, provenanceDateFrom/To, categoryMethod, positionMethod. All filters combine freely; event-level filters compose on the same event row, party-level filters on the same party row. |
| `get_artwork_details` | [34 metadata categories](metadata-categories.md) by object number (e.g. `SK-C-5`) or Linked Art URI. Returns titles, creator, date, description, curatorial narrative, dimensions, materials, production details (with creator life dates, gender, biographical notes, attribution qualifiers, and Wikidata IDs where available), provenance (raw text + parsed chain), inscriptions (raw text plus a query-time parse into per-segment marks/transcriptions and a per-object summary), iconographic subjects, and more. All data served from the local vocabulary database. |
| `get_artwork_image` | View an artwork in high resolution with an interactive deep-zoom viewer (zoom, pan, rotate, flip) via [MCP Apps](https://github.com/modelcontextprotocol/ext-apps). For LLM image analysis, use `inspect_artwork_image` instead. |
| `inspect_artwork_image` | Retrieve an artwork image or region as base64 for direct visual analysis by the LLM. Regions: `full`, `square`, `pct:x,y,w,h`, or `crop_pixels:x,y,w,h`. Size 200–2016 px, rotation (0/90/180/270), quality (default or grayscale). Optionally composites SVG overlays onto the returned region; out-of-bounds regions rejected with a structured warning. Auto-navigates the open viewer to the inspected region. |
| `navigate_viewer` | Navigate the artwork viewer to a specific region and/or add labeled visual overlays. Requires a `viewUUID` from a prior `get_artwork_image` call. Commands: `navigate`, `add_overlay` (with `relativeTo` for crop-local coordinates), `clear_overlays`. |
| `search_provenance` | Search ownership and provenance history across ~48K artworks with parsed provenance records. Filter by party, transfer type, date range, location, price/currency, provenance gaps, and cross-references. Two layers: raw events and interpreted ownership periods. Sorting by price, date, event count, or duration. Includes provenance-of-provenance metadata (parse method, LLM enrichment reasoning). |
| `search_inscriptions` | Structured search over inscriptions — collector's marks, signatures, dates, numbers, and transcribed text — parsed at query time from the catalogue's inscription field (no derived index). Filter by `collectorMark` (Lugt number), `transcribedText` (text written *on* the work), `inscriptionType`/`placement`/`technique` facets, or a blunt `text` match; `hasTranscribedText`/`excludeCollectorMarkOnly` strip ownership-stamp boilerplate. Facets combine within a single mark; each result carries `matchedInscriptions` (the gloss-deduped segments that matched). A query needs at least one narrowing filter, and a broad single facet trips a candidate cap (`candidatesCapped`, partial results). |
| `find_similar` | Find artworks similar to a given artwork across nine independent signals (Visual, Description, Iconclass, Lineage, Theme, Related Variant, Related Object, Depicted Person, Depicted Place) plus a Pooled column blending all nine. Returns structured per-signal rankings and a Pooled consensus, plus a `pageUrl` to a rendered HTML comparison page. Feature-gated via `ENABLE_FIND_SIMILAR`; the Theme channel is separately gated via `ENABLE_THEME_SIMILAR`. |
| `list_curated_sets` | List 193 curated collection sets (exhibitions, scholarly groupings, thematic collections). Optional name filter. DB-backed. |
| `browse_set` | Browse artworks in a curated set. DB-backed: returns DB-direct records with object numbers, titles, creators, dates, descriptions, extent text, image/IIIF URLs, and a stable lodUri. Pagination via resumption token. |
| `get_recent_changes` | Track additions and modifications by date range. Full EDM records or lightweight headers (`identifiersOnly`). Pagination via resumption token. |
| `remount_viewer` | App-only: switch the open viewer to a different artwork while preserving the `viewUUID`. Called by the viewer iframe during in-viewer related-artwork navigation; not invoked directly by agents. |
| `poll_viewer_commands` | App-only: poll for pending viewer navigation commands. Used by the artwork viewer; not called directly by agents. |

**Structured output:** all 16 tools return typed structured data (`structuredContent`) alongside the text summary. MCP clients that support `outputSchema` ([spec](https://modelcontextprotocol.io/specification/2025-11-25)) receive machine-readable results for richer UI rendering. Set `STRUCTURED_CONTENT=false` to disable if your client has compatibility issues.

#### Prompts and Resources

| Prompt / Resource | Description |
|---|---|
| `generate-artist-timeline` | Prompt: generate a chronological timeline of an artist's works in the collection using `search_artwork` with a creator filter, sorted by date. Default 25 works, max 50 — for prolific artists this is a small sample. |
| `generate-session-trace` | Prompt: create a debug trace of all tool calls made to the server during a conversation, formatted as timestamped JSONL for developer feedback. Optional session description argument. |
| `ui://rijksmuseum/artwork-viewer.html` | Resource: interactive IIIF deep-zoom viewer for Rijksmuseum artworks (MCP Apps) |

#### Architecture

```
src/
  index.ts                    — Dual-transport entry point (stdio + HTTP), warm-up, /health, /ready, /debug/memory
  registration.ts             — Tool/resource/prompt registration, hybrid search routing, module-scope viewerQueues + similarPages + enrichmentReviewPages Maps
  types.ts                    — IIIF and OAI-PMH types, AAT constants
  similarHtml.ts              — HTML template for find_similar comparison pages
  enrichmentReviewHtml.ts     — HTML review pages for LLM enrichments
  overlay-compositor.ts       — sharp-based SVG overlay rendering for inspect_artwork_image
  places.json                 — Bundled place gazetteer data
  provenance.ts               — Provenance event parsing + DB queries
  provenance-grammar.peggy    — PEG grammar for provenance text
  provenance-peg.ts           — PEG parser driver + regex fallback
  provenance-interpret.ts     — Event interpretation layer (ownership periods)
  api/
    RijksmuseumApiClient.ts   — IIIF image client (info.json, region/thumbnail base64)
    OaiPmhClient.ts           — OAI-PMH client (curated sets, EDM records, change tracking)
    VocabularyDb.ts           — SQLite vocabulary database (artwork details, image metadata, vocab search, full-text, dimension, date, geo proximity, provenance, find_similar, person search)
    EmbeddingsDb.ts           — sqlite-vec vector search (pure KNN + filtered KNN, plus desc_embeddings for description similarity)
    EmbeddingModel.ts         — HuggingFace Transformers embedding model (ONNX/WASM)
  utils/
    db.ts                     — Shared path resolution (PROJECT_ROOT, import.meta.url)
    ResponseCache.ts          — LRU+TTL cache (IIIF info.json responses)
    UsageStats.ts             — Tool call aggregation and periodic flush
    MemoryStats.ts            — RSS/heap + per-DB SQLite mmap snapshots; powers /debug/memory
apps/
  artwork-viewer/             — MCP Apps inline IIIF viewer (Vite + OpenSeadragon)
data/
  vocabulary.db               — Vocabulary database (built from OAI-PMH + Linked Art + Schema.org dumps, not in git)
  embeddings.db               — Artwork embeddings (~833K int8[384] vectors, not in git)
```

#### Data Sources

At runtime, the server only makes HTTP requests for IIIF images and OAI-PMH feeds. All artwork metadata is served from local databases. No authentication is required.

| API | URL | Purpose |
|---|---|---|
| IIIF Image API | `https://iiif.micr.io/{id}/info.json` | High-resolution image tiles (info.json + region/thumbnail fetch) |
| OAI-PMH | `https://data.rijksmuseum.nl/oai` | Curated sets, EDM metadata records, date-based change tracking. 193 sets, 834K+ records. |
| Visual Search | `https://www.rijksmuseum.nl/api/v1/collection/visualsearch` | Image-embedding nearest-neighbour candidates from the Rijksmuseum's own service. Powers the Visual channel of `find_similar`. |
| Iconclass (CC0) | `https://iconclass.org/` | ~1.3M iconographic classification notations. Accessed via the dedicated [Iconclass MCP server](https://github.com/kintopp/rijksmuseum-iconclass-mcp); Iconclass notation codes can be passed to `search_artwork`'s `iconclass` parameter. |

The following APIs are used only during the **offline harvest** (not at runtime):

| API | URL | Purpose |
|---|---|---|
| Search API | `https://data.rijksmuseum.nl/search/collection` | Resolves object numbers to Linked Art URIs during harvest |
| Linked Art resolver | `https://id.rijksmuseum.nl/{id}` | Object metadata and vocabulary terms as JSON-LD (harvest-time enrichment) |
| Schema.org dumps | `https://data.rijksmuseum.nl/dumps/` | Full-collection person, group, place, and concept dumps. Source for in-harvest person enrichment (gender, life dates, biographical notes, Wikidata IDs) and the `vocabulary_external_ids` cross-authority identifier table. |

**Vocabulary database:** A pre-built SQLite database maps ~418,000 controlled vocabulary terms to ~834,000 artworks via ~14.8 million mappings, built from OAI-PMH EDM records, Linked Art resolution, and Schema.org full-collection dumps. It is the single source of truth for artwork metadata at runtime, powering `get_artwork_details`, the [vocabulary-backed and full-text filters of `search_artwork`](search-parameters.md), date and dimension ranges, and geo-proximity search. It also powers `search_persons` over ~290,000 person and ~12,000 group authority records (~700,000 name variants) with biographical filters, and includes geocoded places sourced from [Getty TGN](https://www.getty.edu/research/tools/vocabularies/tgn/), [Wikidata](https://www.wikidata.org/), [GeoNames](https://www.geonames.org/), and the [World Historical Gazetteer](https://whgazetteer.org/), with coordinates retained only where a Rijksmuseum-supplied authority identifier deterministically resolves them (the earlier inferred and manual tiers were dropped to avoid unsourced placements). Provenance coverage spans ~48,500 artworks with parsed ownership chains (events, parties, transfers, dates, locations, prices), aligned with the AAM/CMOA notation standard.

**Embeddings database:** A pre-built SQLite database with two int8-384d tables. The primary `artwork_embeddings` table (~833,000 vectors, [`intfloat/multilingual-e5-small`](https://huggingface.co/intfloat/multilingual-e5-small)) is built from composite artwork text — title, inscriptions, description, curatorial narrative — and powers `semantic_search`. A second `desc_embeddings` table holds description-only vectors from the Dutch-tuned [`clips/e5-small-trm-nl`](https://huggingface.co/clips/e5-small-trm-nl) and powers the Description channel of `find_similar`; the Visual channel of `find_similar` is sourced separately from the Rijksmuseum's own image-embedding service. Vector search uses [sqlite-vec](https://github.com/asg017/sqlite-vec) with two paths: `vec0` virtual tables for pure KNN, and `vec_distance_cosine()` on regular tables for KNN pre-filtered through the vocabulary database. Source text is reconstructed from the vocabulary DB at query time rather than stored alongside the vectors.

#### Configuration

| Variable | Description | Default |
|---|---|---|
| `PORT` | HTTP server port (presence triggers HTTP mode) | `3000` |
| `ALLOWED_ORIGINS` | CORS origins (comma-separated) | `*` |
| `PUBLIC_URL` | Base URL for `/similar/:uuid` and `/enrichment-review/:uuid` links in HTTP mode (e.g. `https://example.up.railway.app`) | `http://localhost:$PORT` |
| `VOCAB_DB_PATH` | Path to vocabulary SQLite database | `data/vocabulary.db` |
| `VOCAB_DB_URL` | URL to download vocabulary DB on first start; gzip supported | *(none)* |
| `EMBEDDINGS_DB_PATH` | Path to embeddings SQLite database | `data/embeddings.db` |
| `EMBEDDINGS_DB_URL` | URL to download embeddings DB on first start; gzip supported | *(none)* |
| `EMBEDDING_MODEL_ID` | HuggingFace model ID for query embedding | `Xenova/multilingual-e5-small` |
| `HF_HOME` | HuggingFace cache directory (useful for persistent volumes in deployment) | *(system default)* |
| `ENABLE_FIND_SIMILAR` | Set to `"false"` to disable the `find_similar` tool | `true` |
| `ENABLE_THEME_SIMILAR` | Set to `"false"` to disable just the Theme channel inside `find_similar` (other channels keep working) | `true` |
| `STRUCTURED_CONTENT` | Set to `"false"` to disable structured output (workaround for clients with `outputSchema` bugs) | *(enabled)* |
| `USAGE_STATS_PATH` | Path to usage stats JSON file | `data/usage-stats.json` |
| `MCP_SKIP_STARTUP_WARM` | Set to `"1"` to skip the eager stdio warm-up so a one-shot starts in ~0.5s instead of ~13s (caches build lazily on first use); set automatically by the CLI's stdio transport | *(eager warm-up)* |
