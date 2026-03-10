# Scripts

All scripts operate on the databases in `data/`. Python scripts use the `embeddings` conda env unless noted. Node scripts require `npm run build` first.

## Harvest & DB Build

The core pipeline that produces the three databases from scratch.

| Script | Lang | Description |
|--------|------|-------------|
| `harvest-vocabulary-db.py` | Python | Full vocabulary DB builder. 6 phases: data dump parsing, OAI-PMH harvest (836K records), vocab resolution, Linked Art enrichment, post-processing (FTS5, importance, geocoding import). Hours to run. |
| `build-iconclass-db.py` | Python | Builds `iconclass.db` from the CC0 Iconclass data dump + artwork counts from vocab DB. |
| `compute_importance.py` | Python | Computes the `importance` column on artworks. Called by harvest Phase 3 but also runnable standalone. |
| `harvest-person-names.py` | Python | Harvests person name variants from Linked Art into `person_names` table + FTS5 index. |

## Enrichment & Backfill

Scripts that add data the harvest doesn't produce on its own. Results are captured in snapshot CSVs (see below).

| Script | Lang | Description |
|--------|------|-------------|
| `enrich-vocab-from-dumps.py` | Python | Enriches vocab DB from Rijksmuseum data dumps: actor bios (birth/death/gender/bio/wikidata), place hierarchy (`broader_id`), coordinate inheritance. Requires files in `offline/data-dumps/`. |
| `backfill-dates.py` | Python | Backfills missing `date_earliest`/`date_latest` via Search API + Linked Art resolution. Hits live APIs. |
| `backfill-iiif-ids.py` | Python | Backfills `iiif_id` from OAI-PMH `edm:isShownBy` URLs. No extra HTTP beyond OAI-PMH pages. |
| `reimport-snapshots.py` | Python | Reimports all supplementary data from snapshot CSVs in `data/` after a fresh harvest. COALESCE semantics (fills NULLs only). Supports `--only actors|broader|geo|dates` and `--dry-run`. |

## Geocoding

| Script | Lang | Description |
|--------|------|-------------|
| `geocode_places.py` | Python | Multi-phase geocoding pipeline: GeoNames, Wikidata, Getty TGN, entity reconciliation, WHG fuzzy matching. Produces CSVs in `offline/geo/` (audit trail) and `data/geo/` (active). |
| `batch_geocode.py` | Python | Batch geocode using external IDs already in the DB (Wikidata SPARQL, GeoNames API, Getty TGN). Simpler than `geocode_places.py`. |
| `map_depicted_places.py` | Python | Extracts depicted places, geocodes missing coords, generates an interactive Leaflet map. |

## Embeddings

| Script | Lang | Description |
|--------|------|-------------|
| `generate-embeddings-mps.py` | Python | Generates artwork embeddings locally using Apple MPS GPU. Streaming to SQLite. |
| `generate-vocabulary-embeddings-modal.py` | Python | Generates artwork embeddings on Modal cloud GPUs (A10) under different source text strategies. Production script for `no-subjects` strategy. |
| `generate-iconclass-embeddings-modal.py` | Python | Generates Iconclass notation embeddings on Modal cloud GPU. |
| `generate-embeddings-outdated.py` | Python | **Superseded** by `generate-embeddings-mps.py`. Original non-streaming version. |

## Analysis & Probing

Read-only scripts that inspect data without modifying it.

| Script | Lang | Description |
|--------|------|-------------|
| `probe-harvest.py` | Python | Dry-run harvest probe: samples artworks, resolves live via Linked Art, reports shape anomalies + data drift. No writes. |
| `probe-maker-relations.py` | Python | Probes `produced_by` structures to map Rijksmuseum website maker sub-types to Linked Art patterns. |
| `explore-embedding-clusters.py` | Python | UMAP + HDBSCAN clustering of sampled embeddings. Outputs to `offline/explorations/embedding-clusters/`. |
| `explore-smell-clusters.py` | Python | Smell-focused embedding cluster analysis. Outputs interactive HTML. |
| `generate-cluster-viz.py` | Python | Generates interactive Plotly HTML from pre-computed cluster data. |
| `survey-persons.mjs` | Node | Quick survey of `depictedPerson` vs `aboutActor` coverage. |
| `survey-persons-comprehensive.mjs` | Node | Comprehensive 120-name survey across 12 categories. |

## Profiling & Diagnostics

| Script | Lang | Description |
|--------|------|-------------|
| `profile-cross-filters.mjs` | Node | Profiles multi-filter vocab query performance with timing and `EXPLAIN QUERY PLAN`. |
| `profile-db-space.mjs` | Node | Analyses table/column/index space usage via `dbstat`. |
| `analyse-railway-logs.sh` | Bash | Fetches Railway logs via CLI, passes to `.py` for analysis. |
| `analyse-railway-logs.py` | Python | Produces 7-section markdown report from Railway deployment logs. |
| `generate-session-trace.py` | Python | Generates debug traces from Claude Desktop MCP logs. |

## Operations

| Script | Lang | Description |
|--------|------|-------------|
| `warm-cache.mjs` | Node | Post-deployment cache warming via Streamable HTTP. Uses `warm-cache-prompts.tsv`. |
| `warm-cache-local.mjs` | Node | Local cache warming via stdio transport. Same TSV, no running server needed. |
| `warm-cache-prompts.tsv` | Data | Tool call definitions used by both warm-cache scripts. |
| `insights-tui.mjs` | Node | TUI for reviewing and pruning `offline/INSIGHTS.md` entries. |

## Tests (`tests/`)

Run with `node scripts/tests/<script>`. All use MCP SDK Client + StdioClientTransport.

| Script | Assertions | Description |
|--------|-----------|-------------|
| `test-inspect-navigate.mjs` | 115 | Full inspect/navigate/poll viewer workflow |
| `test-http-viewer-queues.mjs` | 16 | HTTP cross-request viewerQueue persistence (requires server on :3000) |
| `smoke-v019.mjs` | 25 | v0.19 feature smoke tests |
| `test-pure-functions.mjs` | 87 | Unit tests for exported pure functions |
| `test-fts-edge-cases.mjs` | — | FTS5 query escaping with tricky inputs |
| `test-new-filters.mjs` | 19 | v0.20 filters: creatorGender, creatorBornAfter/Before, expandPlaceHierarchy |
| `test-v019-features.mjs` | — | Targeted tests for all v0.19 features |
| `profile-cross-filters.mjs` | — | Cross-filter performance profiling |
| `profile-db-space.mjs` | — | DB space analysis |
