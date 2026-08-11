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

The vocabulary and embeddings databases are **not** bundled and are **not** fetched by default. The server downloads each one on first start only when you set its URL variable — `VOCAB_DB_URL` and `EMBEDDINGS_DB_URL` (see [Configuration](#configuration)) — pointing at the gzipped assets published on the [releases page](https://github.com/kintopp/rijksmuseum-mcp-plus/releases). Budget roughly 500 MiB + 580 MiB compressed, unpacking to about 2 GiB + 1.1 GiB on disk. Without them the server still starts, but [vocabulary-backed search parameters](search-parameters.md), `semantic_search`, and every other DB-backed tool are silently absent from `tools/list`. The embedding model (~130 MB) is downloaded on first use. For Iconclass taxonomy navigation, use the dedicated [Iconclass MCP server](https://github.com/kintopp/rijksmuseum-iconclass-mcp).

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
| `GET /debug/slow-queries` | Per-input timing stats (p50/p90/max plus phase splits), in-memory — resets on redeploy |

`GET /mcp` (and every other non-POST verb) returns **405** with an `Allow: POST` header. This is deliberate, not a bug: the `2025-11-25` spec permits declining to offer an SSE stream at the endpoint, and the post-`2025-11-25` draft removes the GET stream entirely, making 405 the prescribed behaviour. Clients probing for a listening stream will see it.

The included `railway.json` supports one-click deployment on [Railway](https://railway.app/). Railway sets `PORT` automatically.

#### CLI

A headless CLI (`scripts/cli.mjs`, exposed as `npm run cli` or the `rijks-mcp` bin — run `npm link` once to put it on your `PATH`) drives the server's stateless tools as an MCP *client* — so a CLI query returns exactly what an LLM would get, and it doubles as a debug/regression harness. It is JSON-first, aimed at agents and shell pipelines. The four viewer/stateful tools (`get_artwork_image`, `navigate_viewer`, `remount_viewer`, `poll_viewer_commands`) are out of scope.

##### CLI-only installation

If you only want the command line (not an MCP client integration), clone as in [Local Setup](#local-setup-stdio) above — the install is the same, except that `npm run build` is needed only for the stdio transport. Linking gives you `rijks-mcp <verb> …` in place of `npm run cli -- <verb> …`; the verbs and flags are identical.

**Prerequisites (all platforms):** [Node.js 24.x](https://nodejs.org) (`>=24.14.1 <25`). The native dependencies (`better-sqlite3`, `sharp`, `@huggingface/transformers`) ship prebuilt binaries for Windows/macOS/Linux on x64 and arm64, so no compiler is needed except on musl/Alpine.

```bash
npm install          # stdio and HTTP both need this
npm run build        # stdio only — skip for HTTP
npm link             # optional — puts `rijks-mcp` on your PATH
```

**Requirements per transport:**

| Transport | Needs | Notes |
|---|---|---|
| **stdio** (default) | `npm install` + `npm run build` + the databases (~2 GiB + ~1.1 GiB on disk) | Selected when neither `--http` nor `RIJKS_MCP_HTTP` is set — the CLI spawns `node dist/index.js` itself. The DBs download to `data/` on the first run **only if `VOCAB_DB_URL`/`EMBEDDINGS_DB_URL` are set** (fully local/offline afterwards); otherwise place the files at `data/` yourself. The embedding model (~130 MB) downloads on first `semantic`/`similar` use. |
| **HTTP** | `npm install` + a reachable `/mcp` server | Selected via `--http <url>` or the `RIJKS_MCP_HTTP` environment variable — talks to a running `npm run serve`/Railway server, warm so calls return instantly. No local build or DBs when targeting an already-running server (the public Railway instance, or your own `npm run serve`, which itself needs the full stdio setup). |

```bash
npm run cli -- search --query "tulip" --max 5 --fields objectNumber,title
npm run cli -- details SK-C-5 --json
npm run cli -- semantic "ships in a storm" --max 10
npm run cli -- inspect SK-C-5 --region pct:40,40,20,20 --out crop.jpg
npm run cli -- tools --json          # capabilities dump (the agent bootstrap)
npm run cli -- search --help         # flags for one command, generated from the live schema
```

- **Commands** are short verbs aliased to tools (`search`, `semantic`, `persons`, `provenance`, `inscriptions`, `details`, `bibliography`, `citing`, `conservation`, `stats`, `similar`, `browse-set`, `list-sets`, `changes`, `inspect`). The first positional maps to the tool's primary parameter; everything else is a `--flag`. Help and flag coercion are derived from the live `inputSchema`, so they never drift.
- **Output:** list tools emit JSONL on stdout (one object per line, `jq -c`-friendly); single-object tools emit one compact JSON object. `--json` prints the whole payload pretty; `--table` is a terse human view; `--fields a,b,c` projects keys (the main token lever). Counts, pagination hints (`--offset` / `--resumption-token`), and warnings go to stderr to keep stdout clean. `--show-call` prints the resolved `{tool, arguments}` without executing.
- **Exit codes:** `0` ok · `1` tool/connection error · `2` usage error. Tool errors preserve the server's prose routing hints (on stderr).

Smoke test: `npm run test:cli` (needs a built `dist/` + the DBs; hits live IIIF, so it is excluded from `npm test`/`test:all`).

See the [CLI guide](cli-guide.md) for the full command reference, output model, and pipeline recipes.

#### Tools

See [mcp-tool-parameters.md](mcp-tool-parameters.md) for the full parameter reference.

| Tool | Description |
|---|---|
| `search_artwork` | Search the collection using [33 search filters](search-parameters.md) including full-text fields, the structured `textQuery` DSL, object numbers with wildcards, vocabulary labels, creator demographics, dimensions, geo proximity, place hierarchy expansion, curatorial themes, and source-channel taxonomy. Filters combine freely, except that proximity search overrides `depictedPlace`/`productionPlace`. Returns up to 25 results (max 50). Compact mode, facets, offset pagination, and `sortBy`/`sortOrder` (with universal `art_id` tiebreaker) supported. |
| `search_persons` | Search the person and group authority records by name (variant-aware), gender, birth year, birth/death place, or profession. Returns vocab IDs to feed into `search_artwork({creator: …})` for works *by* a person, or `search_artwork({aboutActor: …})` for works *depicting* them. Each result also carries `nameVariants[]` and `equivalents[]` (external authority crosswalks — VIAF/ULAN/RKD/Wikidata) where present. By default restricts to persons with ≥1 artwork in the collection. |
| `semantic_search` | Find artworks by meaning, concept, or theme using natural language. Returns up to 15 results (max 50) ranked by semantic similarity with reconstructed source text for grounding. Pre-filters: `type`, `material`, `technique`, `creationDate`, `dateMatch`, `creator`, `subject`, `iconclass`, `depictedPerson`, `depictedPlace`, `productionPlace`, `collectionSet`, `aboutActor`, `imageAvailable`. Requires embeddings database and embedding model. |
| `collection_stats` | Aggregate statistics, counts, and distributions across any dimension (artwork or provenance). Returns text tables plus a structured payload disclosing denominator/grouping/coverage semantics. 34 dimensions in all. Artwork: type, material, technique, creator, productionRole, depictedPerson, depictedPlace, productionPlace, placeType, century, decade, height, width, theme, sourceType, exhibition, decadeModified, plus creator demographics (profession, birthPlace, deathPlace, gender, creatorBirthDecade, creatorBirthCentury). Provenance: transferType, transferCategory, provenanceDecade, provenanceLocation, party, partyRole, partyPosition, currency, categoryMethod, positionMethod, parseMethod. 53 filters, including the vocabulary set, creator demographics, presence flags (`hasInscription`, `hasNarrative`, `hasDimensions`, `hasExhibitions`, `hasExaminations`, and others), and the provenance tier. Demographic filters such as `gender` work directly here — no `search_persons` round-trip needed. All filters combine freely; event-level filters compose on the same event row, party-level filters on the same party row. |
| `get_artwork_details` | [metadata categories](metadata-categories.md) by object number (e.g. `SK-C-5`) or Linked Art URI. Returns titles, creator, date, description, curatorial narrative, dimensions, materials, production details (with creator life dates, gender, biographical notes, attribution qualifiers, and Wikidata IDs where available), provenance (raw text + parsed chain), inscriptions (raw text plus a query-time parse into per-segment marks/transcriptions and a per-object summary), iconographic subjects, related objects and frame/pedestal physical relations (`physicalRelations[]`), entity-level external authority crosswalks (`equivalents[]`), and more. All data served from the local vocabulary database. |
| `get_artwork_bibliography` | Scholarly references for one artwork by object number — citations with the linked publication, pages, and ISBN where known. Returns the first 5 entries plus a `total` count by default; `full: true` returns all (major works can carry 100+). |
| `find_artworks_citing_publication` | Reverse bibliography: artworks whose references cite a given publication, by its URI or bare id (e.g. a `publicationUri` from `get_artwork_bibliography`). Local and resolver-free. First 20 + total by default; `full: true` for all. |
| `get_conservation_history` | Conservation/forensics record for one artwork by object number — technical examinations (X-ray, dendrochronology, infrared, paint samples), restoration/conservation treatments, a count of recorded signature/inscription marks (use `search_inscriptions` for transcriptions), and a short provenance excerpt. |
| `get_artwork_image` | View an artwork in high resolution with an interactive deep-zoom viewer (zoom, pan, rotate, flip) via [MCP Apps](https://github.com/modelcontextprotocol/ext-apps). For LLM image analysis, use `inspect_artwork_image` instead. |
| `inspect_artwork_image` | Retrieve an artwork image or region as base64 for direct visual analysis by the LLM. Regions: `full`, `square`, `pct:x,y,w,h`, or `crop_pixels:x,y,w,h`. Size 200–2016 px, rotation (0/90/180/270), quality (default or grayscale). Out-of-bounds regions rejected with a structured warning. Auto-navigates the open viewer to the inspected region. |
| `navigate_viewer` | Zoom/pan the artwork viewer to a specific region. Requires a `viewUUID` from a prior `get_artwork_image` call. Single command type: `navigate` (with `relativeTo`/`relativeToSize` for crop-local coordinates from a prior `inspect_artwork_image` call). |
| `search_provenance` | Search ownership and provenance history across the roughly 48K artworks with parsed provenance records. Filter by party, transfer type, date range, location, price/currency, provenance gaps, and cross-references. Two layers: raw events and interpreted ownership periods. Sorting by price, date, event count, or duration. Includes provenance-of-provenance metadata (parse method, LLM enrichment reasoning). |
| `search_inscriptions` | Structured search over inscriptions — collector's marks, signatures, dates, numbers, and transcribed text — parsed at query time from the catalogue's inscription field (no derived index). Filter by `collectorMark` (Lugt number), `transcribedText` (text written *on* the work), `inscriptionType`/`placement`/`technique` facets, or a blunt `text` match; `hasTranscribedText`/`excludeCollectorMarkOnly` strip ownership-stamp boilerplate. Facets combine within a single mark; each result carries `matchedInscriptions` (the gloss-deduped segments that matched). A query needs at least one narrowing filter, and a broad single facet trips a candidate cap (`candidatesCapped`, partial results). |
| `find_similar` | Find artworks similar to a given artwork across nine independent signals (Visual, Description, Iconclass, Lineage, Theme, Related Variant, Related Object, Depicted Person, Depicted Place) plus a Pooled column blending all nine. Returns structured per-signal rankings and a Pooled consensus, plus a `pageUrl` to a rendered HTML comparison page. Feature-gated via `ENABLE_FIND_SIMILAR`; the Theme channel is separately gated via `ENABLE_THEME_SIMILAR`. |
| `list_curated_sets` | List the curated collection sets (exhibitions, scholarly groupings, thematic collections) — a couple of hundred in the current harvest. Optional name filter. DB-backed. |
| `browse_set` | Browse artworks in a curated set. DB-backed: returns DB-direct records with object numbers, titles, creators, dates, descriptions, extent text, image/IIIF URLs, and a stable lodUri. Pagination via resumption token. |
| `get_recent_changes` | Track additions and modifications by date range. Full EDM records or lightweight headers (`identifiersOnly`). Pagination via resumption token. |
| `remount_viewer` | App-only: switch the open viewer to a different artwork while preserving the `viewUUID`. Called by the viewer iframe during in-viewer related-artwork navigation; not invoked directly by agents. |
| `poll_viewer_commands` | App-only: poll for pending viewer navigation commands. Used by the artwork viewer; not called directly by agents. |

**Structured output:** all 19 tools return typed structured data (`structuredContent`) alongside the text summary. MCP clients that support `outputSchema` ([spec](https://modelcontextprotocol.io/specification/2025-11-25)) receive machine-readable results for richer UI rendering. Set `STRUCTURED_CONTENT=false` to disable if your client has compatibility issues.

#### Resources

The server declares `tools` and `resources` capabilities only — it registers no MCP prompts, so `prompts/list` is not advertised.

| Resource | Description |
|---|---|
| `ui://rijksmuseum/artwork-viewer.html` | Interactive IIIF deep-zoom viewer for Rijksmuseum artworks ([MCP Apps](https://github.com/modelcontextprotocol/ext-apps)). Bound to the `get_artwork_image` render tool via `_meta.ui.resourceUri`. |

#### Architecture

A request flows: MCP SDK → `registration.ts` dispatcher → a tool callback in `registration/tools/` → the data layer (`VocabularyDb` / `EmbeddingsDb` + `EmbeddingModel` / `RijksmuseumApiClient` / `OaiPmhClient`) → JSON.

**Entry and dispatch**

| Path | Role |
|---|---|
| `src/index.ts` | Dual-transport entry (stdio + HTTP). Express routes, `ensureDb` (URL-gated DB download), Origin + IP middleware, background warm-up, graceful shutdown |
| `src/registration.ts` | Thin dispatcher: calls the eleven `register*Tools()` functions and registers the viewer app resource. Re-exports helper/state symbols used by tests |

**Tool families** — `src/registration/tools/`, 19 tools total

| Path | Tools |
|---|---|
| `viewer.ts` | `get_artwork_image`, `inspect_artwork_image`, `navigate_viewer`, plus app-only `remount_viewer` and `poll_viewer_commands` |
| `search.ts` | `search_artwork`, `search_persons` — also owns hybrid routing and the "≥1 filter" guard |
| `provenance.ts` | `search_provenance`, `get_recent_changes` — the only OAI-PMH consumer |
| `bibliography.ts` | `get_artwork_bibliography`, `find_artworks_citing_publication` |
| `sets.ts` | `list_curated_sets`, `browse_set` (DB-backed) |
| `stats.ts` / `details.ts` / `similar.ts` / `semantic.ts` / `inscriptions.ts` / `conservation.ts` | one tool each |

**Registration support** — `src/registration/`

| Path | Role |
|---|---|
| `helpers.ts` | `TOOL_LIMITS`, `MODIFIER_KEYS`, `FACET_DIMENSIONS`, schema helpers, OAI pagination buffers, logging |
| `outputSchemas.ts` | Zod output schemas backing `structuredContent` / `outputSchema` |
| `geometry.ts` | IIIF/viewer region parsing, projection, bounds checks, delivery state |
| `state.ts` | Module-scope `viewerQueues` / `similarPages` / `enrichmentReviewPages` Maps, TTL sweepers, and the `collection_stats` + `semantic_search` caches. Must stay module-scope — HTTP re-registers tools per request |
| `visualSearch.ts` | `find_similar` Visual channel — the only live call to `rijksmuseum.nl` |

**Data layer** — `src/api/`

| Path | Role |
|---|---|
| `VocabularyDb.ts` | Vocabulary search, `VOCAB_FILTERS`, the Getty AAT URI constants, `reconstructSourceText()`, all SQL |
| `VocabularyDb.similarity.ts` | `findSimilarBy*` channel implementations |
| `OaiPmhClient.ts` | OAI-PMH XML/EDM — change tracking for `get_recent_changes` |
| `EmbeddingsDb.ts` | sqlite-vec KNN (vec0 pure / regular-table filtered) plus `desc_embeddings` |
| `RijksmuseumApiClient.ts` | IIIF image info + region fetch, response cache |
| `EmbeddingModel.ts` | HuggingFace Transformers query encoding (ONNX/WASM) |
| `vocab-format.ts` | Label and date-range formatting helpers |

**Domain modules** — `src/`: `provenance.ts` + `provenance-grammar.peggy` / `provenance-peg.ts` / `provenance-interpret.ts` (three-layer provenance parser), `inscriptions.ts` (query-time inscription parser), `similarHtml.ts` and `enrichmentReviewHtml.ts` (HTML page templates), `types.ts` (IIIF + OAI-PMH interfaces), `places.json` / `placetype-labels.json` / `placetypeLabels.ts` (place gazetteer).

**Utilities** — `src/utils/`: `db.ts` (path resolution, FTS5 escaping, the `textQuery` compiler), `responseShape.ts` (`mirrorWarningsToText` — sole owner of warnings→text rendering), `origin.ts` (Origin allowlist), `ResponseCache.ts` (LRU+TTL), `inflightCache.ts`, `lru.ts`, `UsageStats.ts`, `MemoryStats.ts`, `userAgent.ts`.

**Viewer** — `apps/artwork-viewer/` is the Vite source root for the inline MCP Apps IIIF viewer (OpenSeadragon), built to `dist/apps/`.

**Databases** — `data/vocabulary.db` (built from OAI-PMH + Linked Art + Schema.org dumps) and `data/embeddings.db` (int8[384] vectors). Neither is in git.

#### Data Sources

At runtime the server makes HTTP requests for IIIF images, OAI-PMH feeds, and — best-effort, for `find_similar`'s Visual channel only — the Rijksmuseum website's visual-search API. Every other path, including all metadata, search, and detail lookups, is served from local databases. No authentication is required.

| API | URL | Purpose |
|---|---|---|
| IIIF Image API | `https://iiif.micr.io/{id}/info.json` | High-resolution image tiles (info.json + region/thumbnail fetch) |
| OAI-PMH | `https://data.rijksmuseum.nl/oai` | EDM metadata records and date-based change tracking for `get_recent_changes`. Curated sets are **not** fetched here — `list_curated_sets` and `browse_set` read the local DB. |
| Visual Search | `https://www.rijksmuseum.nl/api/v1/collection/visualsearch` | Image-embedding nearest-neighbour candidates from the Rijksmuseum's own service. Powers the Visual channel of `find_similar`. |

Iconclass is **not** called by this server. Notation codes can be passed to `search_artwork`'s `iconclass` parameter, but taxonomy navigation lives in the dedicated [Iconclass MCP server](https://github.com/kintopp/rijksmuseum-iconclass-mcp) (~1.3M notations, CC0).

The following APIs are used only during the **offline harvest** (not at runtime):

| API | URL | Purpose |
|---|---|---|
| Search API | `https://data.rijksmuseum.nl/search/collection` | Resolves object numbers to Linked Art URIs during harvest |
| Linked Art resolver | `https://id.rijksmuseum.nl/{id}` | Object metadata and vocabulary terms as JSON-LD (harvest-time enrichment) |
| Schema.org dumps | `https://data.rijksmuseum.nl/dumps/` | Full-collection person, group, place, and concept dumps. Source for in-harvest person enrichment (gender, life dates, biographical notes, Wikidata IDs) and the `vocabulary_external_ids` cross-authority identifier table. |

**Vocabulary database:** A pre-built SQLite database maps roughly 420K controlled vocabulary terms to about 830K artworks via some 15 million mappings, built from OAI-PMH EDM records, Linked Art resolution, and Schema.org full-collection dumps. It is the single source of truth for artwork metadata at runtime, powering `get_artwork_details`, the [vocabulary-backed and full-text filters of `search_artwork`](search-parameters.md), date and dimension ranges, and geo-proximity search. It also powers `search_persons` over roughly 290K person and 12K group authority records (some 700K name variants) with biographical filters, and includes geocoded places sourced from [Getty TGN](https://www.getty.edu/research/tools/vocabularies/tgn/), [Wikidata](https://www.wikidata.org/), [GeoNames](https://www.geonames.org/), and the [World Historical Gazetteer](https://whgazetteer.org/), with coordinates retained only where a Rijksmuseum-supplied authority identifier deterministically resolves them (the earlier inferred and manual tiers were dropped to avoid unsourced placements). Provenance coverage spans roughly 48K artworks with parsed ownership chains (events, parties, transfers, dates, locations, prices), aligned with the AAM/CMOA notation standard.

**Embeddings database:** A pre-built SQLite database with two int8-384d tables. The primary `artwork_embeddings` table (about 830K vectors, [`intfloat/multilingual-e5-small`](https://huggingface.co/intfloat/multilingual-e5-small)) is built from composite artwork text — title, inscriptions, description, curatorial narrative — and powers `semantic_search`. A second `desc_embeddings` table holds description-only vectors from the Dutch-tuned [`clips/e5-small-trm-nl`](https://huggingface.co/clips/e5-small-trm-nl) and powers the Description channel of `find_similar`; the Visual channel of `find_similar` is sourced separately from the Rijksmuseum's own image-embedding service. Vector search uses [sqlite-vec](https://github.com/asg017/sqlite-vec) with two paths: `vec0` virtual tables for pure KNN, and `vec_distance_cosine()` on regular tables for KNN pre-filtered through the vocabulary database. Source text is reconstructed from the vocabulary DB at query time rather than stored alongside the vectors.

#### Configuration

| Variable | Description | Default |
|---|---|---|
| `PORT` | HTTP server port (presence triggers HTTP mode) | `3000` |
| `ALLOWED_ORIGINS` | CORS origins (comma-separated) | `*` |
| `MCP_ALLOWED_ORIGINS` | Server-side Origin allowlist for `/mcp` (DNS-rebinding mitigation, spec MUST). Comma-separated exact origins or hostname globs (`*.foo.example`); replaces defaults. Set to `*` to disable. Missing Origin / non-web schemes / localhost are always allowed. | `claude.ai`, `*.claude.ai`, `chatgpt.com`, `*.chatgpt.com`, `*.openai.com`, `mistral.ai`, `*.mistral.ai`, `unibas.ch`, `*.unibas.ch` |
| `MCP_BLOCKED_IPS` | Comma-separated client IPs denied on `/mcp` with 403 (abusive clients, sleep-defeating pingers). Proxy-aware — matches the whole forwarded chain, not just `req.ip`. Not a security boundary. | *(none)* |
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
| `MCP_TEXT_JSON_COMPAT` | **Deprecated, slated for removal — do not enable.** Appended a redundant serialized-JSON text block for clients that could not read `structuredContent`. | *(off)* |
| `USAGE_STATS_PATH` | Path to usage stats JSON file | `data/usage-stats.json` |
| `MCP_SKIP_STARTUP_WARM` | Set to `"1"` to skip the eager stdio warm-up so a one-shot starts in ~0.5s instead of ~13s (caches build lazily on first use); set automatically by the CLI's stdio transport | *(eager warm-up)* |
