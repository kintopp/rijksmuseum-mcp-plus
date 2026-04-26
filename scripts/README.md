# Scripts

All scripts operate on the databases in `data/`. Python scripts use the `embeddings` conda env unless noted. Node scripts require `npm run build` first.

## Harvest & DB Build

The core pipeline that produces the two databases (vocabulary + embeddings) from scratch. Iconclass moved to its own service in v0.23.1 — see `legacy/` below.

| Script | Lang | Description |
|--------|------|-------------|
| `harvest-vocabulary-db.py` | Python | Full vocabulary DB builder. 6 phases: data dump parsing, OAI-PMH harvest (836K records), vocab resolution, Linked Art enrichment, post-processing (FTS5, importance, geocoding import, **offline-dump enrichment** — actor bios, wikidata, place/concept hierarchy, coordinate inheritance). Hours to run. Pass `--skip-enrichment` to bypass the dump-based enrichment step. |
| `compute_importance.py` | Python | Computes the `importance` column on artworks. Called by harvest Phase 3 but also runnable standalone. |
| `harvest-person-names.py` | Python | Harvests person name variants from Linked Art into `person_names` table + FTS5 index. |

## Enrichment & Backfill

Scripts that add data the harvest doesn't produce on its own. Results are captured in snapshot CSVs (see below).

| Script | Lang | Description |
|--------|------|-------------|
| `enrich-vocab-from-dumps.py` | Python | **LEGACY** (v0.24+). Enrichment (actor bios, wikidata links, place/concept hierarchy, coordinate inheritance) is now folded into `harvest-vocabulary-db.py` Phase 3 (`run_enrichment()`) and runs automatically. This script is retained for ad-hoc re-enrichment against an existing DB without a full re-harvest. See issue #242 part 3. |
| `backfill-dates.py` | Python | Backfills missing `date_earliest`/`date_latest` via Search API + Linked Art resolution. Hits live APIs. |
| `backfill-iiif-ids.py` | Python | Backfills `iiif_id` from OAI-PMH `edm:isShownBy` URLs. No extra HTTP beyond OAI-PMH pages. |
| `reimport-snapshots.py` | Python | Reimports all supplementary data from snapshot CSVs in `data/` after a fresh harvest. COALESCE semantics (fills NULLs only). Supports `--only actors|broader|geo|dates` and `--dry-run`. |

## Geocoding

| Script | Lang | Description |
|--------|------|-------------|
| `geocode_places.py` | Python | Multi-phase geocoding pipeline: GeoNames, Wikidata, Getty TGN, entity reconciliation, WHG fuzzy matching. Produces CSVs in `offline/geo/` (audit trail) and `data/backfills/` (active). |
| `batch_geocode.py` | Python | Batch geocode using external IDs already in the DB (Wikidata SPARQL, GeoNames API, Getty TGN). Simpler than `geocode_places.py`. |
| `map_depicted_places.py` | Python | Extracts depicted places, geocodes missing coords, generates an interactive Leaflet map. |

## Embeddings

| Script | Lang | Description |
|--------|------|-------------|
| `generate-embeddings-mps.py` | Python | Generates artwork embeddings locally using Apple MPS GPU. Streaming to SQLite. |
| `generate-vocabulary-embeddings-modal.py` | Python | Generates artwork embeddings on Modal cloud GPUs (A10) under different source text strategies. Production script for `no-subjects` strategy. |
| `generate-description-embeddings-modal.py` | Python | Generates description-only embeddings on Modal A10G. PCA dimensionality reduction (384→256), int8 quantisation. Writes `desc_embeddings` + `vec_desc_artworks` tables to embeddings DB. |
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
| `discover-linked-art-schema.py` | Python | Exhaustive Linked Art field-path analysis. Resolves sample artworks, walks JSON-LD trees, reports coverage/cardinality/anomalies. Run before harvests. |
| `provenance-sample-analysis.mjs` | Node | Analyses 100 stratified provenance records from vocab DB to catalogue patterns for PEG grammar design. |

## Provenance

### Parsing & Audit

| Script | Lang | Description |
|--------|------|-------------|
| `batch-parse-provenance.mjs` | Node | Batch parse provenance records from vocab DB. Runs Layer 1 (PEG parser) + Layer 2 (interpretation), populates `provenance_events` + `provenance_periods`. Supports `--dry-run`, `--limit`, `--layer1-only`. |
| `audit-provenance-batch.mjs` | Node | Automated parser audit via Anthropic Batches API. Six modes: `silent-errors`, `pattern-mining`, `semantic-catalogue`, `position-enrichment`, `structural-signals`, `type-classification`. Supports `--resume`, `--dry-run`, `--stratify`, `--model`, `--thinking`, `--records`. |
| `audit-disambiguate-parties.mjs` | Node | LLM-based party disambiguation: decomposes merged party text (213+ records) into structured sender/receiver/agent names. Outputs audit JSON. |

### Writebacks

Deterministic and LLM-informed write-back scripts that update `provenance_events` and `provenance_parties` tables. All support `--dry-run` and `--db PATH`.

| Script | Lang | Description |
|--------|------|-------------|
| `writeback-type-classifications.mjs` | Node | Writes back LLM type classifications for previously-unknown events. Sets `transfer_type` + `transfer_category` with `category_method = "llm_enrichment"`. |
| `writeback-position-enrichment.mjs` | Node | Writes back LLM position enrichment results: party positions and category updates. |
| `writeback-party-disambiguation.mjs` | Node | Writes back party disambiguation results: splits, renames, and deletes on `provenance_parties`. Syncs `parties` JSON column on events. |
| `writeback-transfer-category.mjs` | Node | Deterministic reclassification of 6,233 transfer/ambiguous events → ownership. |
| `writeback-missing-receivers.mjs` | Node | Extracts missing receiver parties from event text (#116) via deterministic patterns ("to the [Name]"). |
| `writeback-unsold-prices.mjs` | Node | Extracts prices from unsold/bought-in events (#161). Pattern: "bought in at fl. X". |
| `writeback-residual-nulls.mjs` | Node | Deterministic cleanup of remaining null-position party artifacts after LLM enrichment passes. |
| `writeback-event-reclassification.mjs` | Node | Writes back LLM event reclassifications: mark as non-provenance, merge with adjacent event, or merge alternatives with uncertainty flag. |
| `writeback-event-splitting.mjs` | Node | Writes back LLM event splits: replaces original event with multiple sub-events, re-sequences all events/parties for the artwork. |
| `writeback-field-corrections.mjs` | Node | Writes back LLM field corrections: truncated/wrong locations (#149/#119), missing receivers (#116). |
| `backfill-enrichment-reasoning.mjs` | Node | Backfills `enrichment_reasoning` column from all audit JSON files (type classification, position enrichment, party disambiguation). |

### Review & Collection

| Script | Lang | Description |
|--------|------|-------------|
| `generate-position-review.mjs` | Node | Generates HTML review page for position-enrichment LLM results. |
| `generate-disambig-review.mjs` | Node | Generates HTML review page for party-disambiguation LLM results. |
| `generate-structural-review.mjs` | Node | Generates HTML review page for LLM structural corrections (field corrections, event reclassifications, event splits). |
| `review-long-duration-periods.mjs` | Node | Generates HTML review page for long-duration periods (>200 years), classifying as legitimate vs artifact (#178). |
| `collect-round1-results.mjs` | Node | One-time: collects round 1 position-enrichment batch results from Anthropic API. |
| `collect-disambig-results.mjs` | Node | One-time: collects party-disambiguation batch results from Anthropic API. |

### Post-Reparse

| File | Description |
|------|-------------|
| `POST-REPARSE-STEPS.md` | Step-by-step guide for restoring LLM enrichments + manual corrections after a full re-parse (6 steps, strict order). |
| `manual-corrections-2026-03-23.csv` | Manual corrections CSV: hand-verified fixes for parser artifacts (lot numbers parsed as years, missing transfer types, etc.). Applied by `reimport-snapshots.py` or writeback scripts. |

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
| `RELEASE.md` | — | Full 3-phase release & deploy runbook (code push → DB upgrade → finalize). |
| `warm-cache.mjs` | Node | Post-deployment cache warming via Streamable HTTP. Uses `warm-cache-prompts.tsv`. |
| `warm-cache-local.mjs` | Node | Local cache warming via stdio transport. Same TSV, no running server needed. |
| `warm-cache-prompts.tsv` | Data | Tool call definitions used by both warm-cache scripts. |
| `insights-tui.mjs` | Node | TUI for reviewing and pruning `offline/INSIGHTS.md` entries. |

## Legacy (`legacy/`)

Scripts retained for reference but no longer part of any release path. Do not run as part of the v0.24+ pipeline.

| Script | Lang | Description |
|--------|------|-------------|
| `legacy/build-iconclass-db.py` | Python | Built the standalone `iconclass.db` from the CC0 Iconclass data dump + artwork counts from vocab DB. Iconclass moved to its own MCP service in v0.23.1 (`kintopp/rijksmuseum-iconclass-mcp`). Counts sidecar refresh now lives in that repo — see RELEASE.md Phase B-bis. |
| `legacy/generate-iconclass-embeddings-modal.py` | Python | Generated Iconclass notation embeddings on Modal. Same Iconclass-MCP split — embedding generation now belongs to that repo. |

## Tests (`tests/`)

Run with `node scripts/tests/<script>`. All use MCP SDK Client + StdioClientTransport. Use `run-all.mjs` to run all stdio tests in sequence.

| Script | Assertions | Description |
|--------|-----------|-------------|
| `run-all.mjs` | — | Test runner: executes all stdio test scripts in sequence (skips `test-http-viewer-queues.mjs`). |
| `test-inspect-navigate.mjs` | 115 | Full inspect/navigate/poll viewer workflow |
| `test-http-viewer-queues.mjs` | 16 | HTTP cross-request viewerQueue persistence (requires server on :3000) |
| `smoke-v019.mjs` | 25 | v0.19 feature smoke tests |
| `test-pure-functions.mjs` | 87 | Unit tests for exported pure functions |
| `test-fts-edge-cases.mjs` | — | FTS5 query escaping with tricky inputs |
| `test-new-filters.mjs` | 19 | v0.20 filters: creatorGender, creatorBornAfter/Before, expandPlaceHierarchy |
| `test-find-similar.mjs` | ~51 | All find_similar signal modes (Visual, Lineage, Iconclass, Description, Person, Place, Pooled). Requires `ENABLE_FIND_SIMILAR=true`. |
| `bench-find-similar.mjs` | — | Benchmark find_similar across diverse artworks to profile performance across signal profiles. |
| `test-description-similarity.mjs` | ~4 | Smoke test for find_similar description mode. Requires `ENABLE_FIND_SIMILAR=true`. |
| `test-attribution-qualifiers.mjs` | ~5 | Verifies `attributionQualifier` extraction from Linked Art `assigned_by[].classified_as`. |
| `test-provenance-parser.mjs` | ~39 | Unit tests for Layer 1 provenance parser functions (splitEvents, classifyTransfer, parseDate, parsePrice, etc.) |
| `test-provenance-peg.mjs` | ~45 | Tests for PEG parser (Layer 1) + interpretation (Layer 2) + temporal bounds. |
| `test-provenance-search.mjs` | ~76 | Integration tests for `search_provenance` tool: party lookup, transfer type filters, date ranges, cross-references, parse audit. |
| `test-query-plans.mjs` | 200+ | EXPLAIN QUERY PLAN validation — asserts the optimizer never uses `idx_mappings_field_vocab` as a covering-scan driver. |
| `test-totalcount.mjs` | ~16 | Smoke test: totalResults always present + selective/compact facets. |
| `test-v019-features.mjs` | — | Targeted tests for all v0.19 features |
| `test-svg-overlays.mjs` | — | Visual test for SVG overlay rendering on The Night Watch. Opens viewer, adds various overlay shapes. |
| `test-viewer-build.mjs` | — | Validates bundled viewer HTML is self-contained (no CDN dependencies) and within size budget. |
| `audit-schemas.mjs` | — | Schema audit: checks all outputSchemas for structural risk factors (anyOf/oneOf, $ref/$defs, nesting depth). |
| `validate-vocab-db.mjs` | — | Comprehensive vocab DB structure & integrity validation (13 checks: integrity, tables, FTS5, FK integrity, importance, server compat, etc.) |
| `generate-similarity-review.mjs` | — | Generates HTML review pages for find_similar results (outputs `similarity-review.html`). |
| `survey-persons.mjs` | — | Quick survey of `depictedPerson` vs `aboutActor` coverage. |
| `survey-persons-comprehensive.mjs` | — | Comprehensive 120-name survey across 12 categories. |
| `profile-cross-filters.mjs` | — | Cross-filter performance profiling |
| `profile-db-space.mjs` | — | DB space analysis |
| `test-classify-path.py` | 39 | Python unit tests for `discover-linked-art-schema.py`'s `classify_path()` — covers the context-aware `EVIDENCE_DATA_PARENTS` rule (#275), the multilingual `notation`/`@language`/`@value` scaffolding rule, and regression coverage of the v0.24 extractor paths added 2026-04-26. |

### v0.25 Stage A audit probes

Live-LA-API probe scripts used during the 2026-04-26 v0.25 schema-decisions session. Reusable for any per-path validation needed during Stage B implementation or future audit cycles.

| Script | Lang | Description |
|--------|------|-------------|
| `probe-motivated-by.py` | Python | Fetches Linked Art records and dumps `produced_by.part[].assigned_by[].motivated_by[]` payloads (S5 evidence-type characterisation). Pass object numbers as args. |
| `aggregate-probe.py` | Python | Aggregator for `probe-motivated-by.py` output: counts per object type, per AAT classification code, per bare-string variant. |
| `probe-modified-by.py` | Python | Fetches `modified_by[]` payloads (S4 conservation-events characterisation). Persists to `modified-by-samples.json` for re-use by `test-peg-modified-by.mjs`. |
| `test-peg-modified-by.mjs` | Node | PEG grammar feasibility test for `modified_by[]` payloads: categorises samples as A (clean fold) / B (partial) / C (fail). Verdict from the 2026-04-26 spike: 12.5% clean << 80% threshold → new table, not grammar fold. |
| `test-peg-modified-by.js` | Node | Earlier .js variant of the PEG feasibility test, kept for reference. |
| `inspect-suspicious-paths.py` | Python | Characterises the audit's suspicious IGNORED paths (notation as multilingual labels, `used_specific_object` as catalogues raisonnés AAT 300026061, `equivalent[]` as authority IDs). Handy for any future audit-output triage. |

Companion data + report artefacts in this directory (not scripts):

| File | Description |
|------|-------------|
| `modified-by-samples.json` | Captured `modified_by[]` payloads from the S4 spike (8 events, 5 artworks). |
| `peg-modified-by-results.json` | Per-sample A/B/C categorisation from `test-peg-modified-by.mjs`. |
| `S4-feasibility-report.md` | Full S4 spike report — sample inventory, vocabulary observed, recommendation, proposed table schema. |
