# Scripts

All scripts operate on the databases in `data/`. Python scripts use the `embeddings` conda env unless noted. Node scripts require `npm run build` first.

## Harvest & DB Build

The core pipeline that produces the two databases (vocabulary + embeddings) from scratch. Iconclass moved to its own service in v0.23.1 — see `legacy/` below.

| Script | Lang | Description |
|--------|------|-------------|
| `harvest-vocabulary-db.py` | Python | Full vocabulary DB builder. 6 phases: data dump parsing, OAI-PMH harvest (836K records), vocab resolution, Linked Art enrichment, post-processing (FTS5, importance, geocoding import, **offline-dump enrichment** — actor bios, wikidata, place/concept hierarchy, coordinate inheritance). Hours to run. Pass `--skip-enrichment` to bypass the dump-based enrichment step. |
| `compute_importance.py` | Python | Computes the `importance` column on artworks. Called by harvest Phase 3 but also runnable standalone. |
| `harvest-person-names.py` | Python | Targeted-refetch tool for LA-shape (21xxx) person name variants. Canonical population is in `harvest-vocabulary-db.py` (covers both 21xxx LA-shape and 31xxx Schema.org-shape via `INSERT OR IGNORE`); this script is for ad-hoc upstream-correction refetch only. Idempotent — never deletes. |
| `package-harvest-artifacts.sh` | Bash | Bundle post-harvest artifacts (report, log, audit JSON + CSVs) into a single tarball for transfer back from a remote harvest machine. Run from the repo root with the harvest version label, e.g. `scripts/package-harvest-artifacts.sh v0.27`. The DB is excluded by default — pass `--with-db` to include it. Closes #229B (audit transfer hygiene). |

## Enrichment & Backfill

Scripts that add data the harvest doesn't produce on its own. Results are captured in snapshot CSVs (see below).

| Script | Lang | Description |
|--------|------|-------------|
| `enrich-vocab-from-dumps.py` | Python | **LEGACY** (v0.24+). Enrichment (actor bios, wikidata links, place/concept hierarchy, coordinate inheritance) is now folded into `harvest-vocabulary-db.py` Phase 3 (`run_enrichment()`) and runs automatically. This script is retained for ad-hoc re-enrichment against an existing DB without a full re-harvest. See issue #242 part 3. |
| `backfill-dates.py` | Python | Backfills missing `date_earliest`/`date_latest` via Search API + Linked Art resolution. Hits live APIs. |
| `backfill-iiif-ids.py` | Python | Backfills `iiif_id` from OAI-PMH `edm:isShownBy` URLs. No extra HTTP beyond OAI-PMH pages. |
| `reimport-snapshots.py` | Python | Reimports all supplementary data from snapshot CSVs in `data/` after a fresh harvest. COALESCE semantics (fills NULLs only). Supports `--only actors|broader|geo|dates` and `--dry-run`. |
| `backfills/2026-05-01-apply-theme-en-labels.py` | Python | Applies hand-curated English labels to top-100 theme vocab terms (#300). Reads `backfills/theme-en-labels-top-100.tsv`, idempotent (only writes where `label_en IS NULL`). Re-apply after every fresh harvest. |

## Shared modules (`lib/`)

Importable library modules (not standalone scripts) used by the harvest, geocoding, and provenance scripts. Resolved as a PEP 420 namespace package: importers put `scripts/` on `sys.path` and do `from lib import X` / `from lib.X import …`.

| Module | Lang | Description |
|--------|------|-------------|
| `lib/enrichment_methods.py` | Python | Detail-value vocabulary for `vocabulary.coord_method` + `coord_method_detail` (#218). Two-layer granularity: coarse `deterministic`/`inferred`/`manual`/NULL, fine 18 detail values. `DETAIL_TO_TIER` is the single source of truth — write sites call `tier_for(detail)` to derive the coarse tag. |
| `lib/enrichment_tiers.py` | Python | The three canonical tier string constants (`DETERMINISTIC` / `INFERRED` / `MANUAL`) + `assert_tier` / `VALID_TIERS`. The single point of truth the Python and `.mjs` twins both pin to. |
| `lib/altname_methods.py` | Python | `tier_for_row` semantics for person/group alt-name candidates (#268): exact matches stay deterministic; only reviewed fuzzy candidates are elevated to manual. |
| `lib/provenance_enrichment_methods.py` | Python | `METHOD_TO_TIER` for provenance event/party enrichment method literals. |
| `lib/provenance-enrichment-methods.mjs` | Node | JS twin of `provenance_enrichment_methods.py`, imported by the provenance `.mjs` writeback/audit scripts. `test-enrichment-tiers.py` asserts the two stay in sync. |
| `lib/placetype_map.py` | Python | `AAT_IS_AREAL` (206 entries) + `WD_IS_AREAL` (632 entries) areal-place classifier dicts. Append-only contract — never modify existing values. v0.25 extension 2026-04-26 added 129 AAT + 565 WD entries (100% TGN coverage, 89.7% Wikidata). |
| `lib/geo_math.py` | Python | Haversine + pairwise-distance helpers (`haversine_km`, `trimmed_pairwise_km`, `max_pairwise_km`) used by the coord-inheritance audit. |
| `lib/harvest_audit.py` | Python | Per-phase harvest audit framework (#222): `run_phase_audit`, `AuditResult`, table/summary formatters. |
| `lib/id-remap.mjs` | Node | `art_id` remap helper for `.mjs` scripts that survive a re-harvest. |

## Geocoding (`geocoding/`)

The place-geocoding subsystem — the multi-phase pipeline plus the apply/promote/backfill scripts and one-shot audit probes that grew up around the strict-authority-only policy. All under `scripts/geocoding/`. `harvest-placetypes.py` and `post_run_diagnostics.py` stay in `scripts/` (one is `harvest-` prefixed, the other is a general post-run report).

| Script | Lang | Description |
|--------|------|-------------|
| `geocoding/geocode_places.py` | Python | Multi-phase geocoding pipeline: GeoNames, Wikidata, Getty TGN, entity reconciliation, WHG fuzzy matching. `--propagate-coords` runs Step 7 (broader_id coord inheritance) by delegating to `harvest-vocabulary-db.py`'s `propagate_place_coordinates`. Produces CSVs in `offline/geo/` (audit trail) and `data/backfills/` (active). |
| `geocoding/batch_geocode.py` | Python | Batch geocode using external IDs already in the DB (Wikidata SPARQL, GeoNames API, Getty TGN, TGN-RDF revalidation). Simpler than `geocode_places.py`; its TGN-RDF parser/fetcher is reused by the `promote_*` scripts. |
| `geocoding/run_clean_regeo.py` | Python | Orchestrator: chains the 8-step clean re-geocode (placetypes → areal overrides → batch → geocode_places → propagate → broader-id audit → diagnostics → CSV export) with per-step retry + resume. |
| `geocoding/run_authority_only_geocode.py` | Python | Orchestrator for the strict authority-only re-geocode (no inferred-tier writes). |
| `geocoding/preflight_regeo.py` | Python | Pre-flight checker for a re-geocode run: required env vars, committed-file presence, DB schema/columns, disk space. `--skip-live-api` for offline checks. |
| `harvest-placetypes.py` *(in `scripts/`)* | Python | Populates `vocabulary.placetype` / `placetype_source` / `is_areal` via TGN + Wikidata SPARQL using `lib/placetype_map.py`. `--reclassify-only` re-applies an updated classifier without re-querying upstream. |
| `geocoding/apply_areal_overrides.py` + `areal_overrides.tsv` | Python + Data | Applies manual `is_areal=1` overrides from the curated 101-entry TSV to vocab rows whose centroid is meaningless for point queries (continents, oceans, historical polities, region-scale entities). `build_areal_overrides.py` regenerates the TSV from a seed + DB sweep. |
| `geocoding/apply_rijks_authority_coords.py` | Python | Writes coords for places whose Rijks-supplied authority ID (TGN/Wikidata/GeoNames) resolves to a point. |
| `geocoding/apply_tgn_areal_flag.py` | Python | Flags `is_areal=1` for places whose Rijks-supplied TGN ID is a region/polity. |
| `geocoding/apply_curated_coord_corrections.py` | Python | Applies hand-verified coord fixes from `data/backfills/curated-coord-corrections.csv`. |
| `geocoding/apply_curated_vei_additions.py` | Python | Adds curated `vocabulary_external_ids` rows from `data/backfills/curated-vei-additions.csv` (re-apply after every fresh harvest). |
| `geocoding/promote_inferred_via_rijks_tgn.py` / `promote_inferred_via_rijks_wikidata.py` | Python | Promote former `inferred`-tier coords to `deterministic` where a Rijks-supplied TGN / Wikidata ID actually backs the value. |
| `geocoding/promote_null_detail_via_authority.py` | Python | Recovers coords for NULL-detail rows that turn out to have an authority ID. |
| `geocoding/promote_snapshot_backfill_to_authority.py` | Python | Re-tiers v0.25-snapshot backfilled coords to `deterministic` where authority-traceable. |
| `geocoding/strip_non_authority_coords.py` | Python | The two-tier-policy enforcement step: NULLs every coord whose `coord_method` isn't `deterministic` (drops the entire `inferred` tier + the 8 `manual` centroids). VEI rows are preserved for a future re-geocode. |
| `geocoding/backfill_coord_method_authority.py` / `backfill_place_method_authority.py` | Python | Backfill `coord_method` / `external_id_method` audit-trail columns from existing data. |
| `geocoding/backfill_place_geo_from_v025.py` | Python | Pull `lat/lon/placetype/is_areal/coord_method` from a `vocabulary-v0.25-snapshot.db.gz` (used when Getty TGN is unreachable). |
| `geocoding/backfill_vei_from_la.py` | Python | Backfill `vocabulary_external_ids` from Linked Art payloads. |
| `geocoding/classify_tgn_discrepancies_by_rijks_authority.py` | Python | Triage TGN-RDF-vs-DB coord discrepancies by whether a Rijks authority ID backs the disputed value. |
| `geocoding/lookup_wikidata_coords_for_rijks_authority.py` | Python | Resolve Wikidata P625 for places with a Rijks-supplied Wikidata QID. |
| `geocoding/phase4_pip_validation.py` | Python | WOF point-in-polygon audit (read-only) — requires `duckdb`. Invoked by `geocode_places.py --phase 4-pip`. |
| `geocoding/fetch_country_qid_to_iso2.py` + `country_qid_to_iso2.tsv` | Python + Data | Regenerates / holds the Wikidata-country-QID → ISO-3166-1-alpha-2 lookup used by the geocoders. |
| `geocoding/export_backfill_csv.py` | Python | Exports the 16-column geocoded-places backfill CSV. |
| `geocoding/regeo_parent_fallback.py` | Python | Parent-fallback re-geocode pass (loads `geocode_places.py` as a module). |
| `geocoding/cold_rerun_clear.sql` | Data | The user-gated cold-reset SQL (wipes `lat`/`lon`/`coord_method` before a clean re-geocode). |
| `geocoding/_audit_*.py`, `geocoding/_probe_*.py`, `geocoding/_search_wikidata_for_outliers.py`, `geocoding/_summarize_wikidata_coord_diffs.py`, `geocoding/_list_nicolaaskerk_artworks.py` | Python | One-shot diagnostic probes from the strict-policy session (tier consistency, outlier context, TGN-vs-authority disagreements, Wikidata coord sanity, NULL-detail recoverability, …). The `_` prefix marks them as ephemeral. |

### v0.25 pre-harvest TGN audit (2026-04-26)

One-shot diagnostic probes + apply script that surfaced and fixed 13 obsolete-TGN-ID redirects via `dc:isReplacedBy` chains, and empirically dropped Phase 1c-direct from the v0.25 geocoding bundle. See `offline/drafts/v0.25-schema-decisions.md` § "#258 Phase 1c-direct dropped from v0.25 bundle" for the full lock context.

| Script | Lang | Description |
|--------|------|-------------|
| `geocoding/_tgn_direct_lookup.py` | Python | Probe: queries Getty SPARQL for direct `wgs:lat`/`wgs:long` on TGN entities in the no-coords gap. Returned 0% on the v0.24 131-row population — the empirical evidence that justified dropping Phase 1c-direct. |
| `geocoding/_tgn_obsolete_chain.py` | Python | Classifier: characterises the same 131-row gap as live-no-coords vs obsolete-with-replacement. Follows `dc:isReplacedBy` chains and re-queries replacements for coords. Surfaced the 13-row redirect fix. |
| `geocoding/_tgn_apply_redirect_fix.py` | Python | Apply: writes the 13 redirected coords to `vocabulary` with `coord_method='deterministic'` + `coord_method_detail='tgn_via_replacement'`, inserts the replacement TGN URIs into `vocabulary_external_ids`, exports audit log to `data/backfills/2026-04-26-tgn-redirect-fix.tsv`. Applied 2026-04-26 to local DB; recurring TGN-deprecation check deferred to `harvest-v0.25-deferred-work.md` §6 for v0.26+ cycles. |

## Embeddings

| Script | Lang | Description |
|--------|------|-------------|
| `generate-embeddings-mps.py` | Python | Generates artwork embeddings locally using Apple MPS GPU. Streaming to SQLite. |
| `generate-vocabulary-embeddings-modal.py` | Python | Generates artwork embeddings on Modal cloud GPUs (A10) under different source text strategies. Production script for `no-subjects` strategy. |
| `generate-description-embeddings-modal.py` | Python | Generates description-only embeddings on Modal A10G. PCA dimensionality reduction (384→256), int8 quantisation. Writes `desc_embeddings` + `vec_desc_artworks` tables to embeddings DB. |

(The original non-streaming generator, `generate-embeddings-outdated.py`, now lives in `legacy/` — see below.)

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
| `tests/profile-cross-filters.mjs` | Node | Profiles multi-filter vocab query performance with timing and `EXPLAIN QUERY PLAN`. |
| `tests/profile-db-space.mjs` | Node | Analyses table/column/index space usage via `dbstat`. |
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
| `legacy/test-iconclass-compliance.py` | Python | 40-case compliance suite (data integrity + MCP behaviour) for the standalone `iconclass.db`. Belongs with the Iconclass-MCP split above; kept here for reference only. |
| `legacy/generate-embeddings-outdated.py` | Python | **Superseded** by `generate-embeddings-mps.py`. Original non-streaming artwork-embedding generator. |
| `legacy/backfill-from-v23.1.mjs` | Node | One-time migration that carried supplementary columns forward from a v0.23.1 vocab DB into the v0.24 re-harvest. Not part of any current release path. |

## Tests (`tests/`)

Run with `node scripts/tests/<script>`. All use MCP SDK Client + StdioClientTransport. Use `run-all.mjs` to run all stdio tests in sequence.

| Script | Assertions | Description |
|--------|-----------|-------------|
| `run-all.mjs` | — | Test runner: executes all stdio test scripts in sequence (skips `test-http-viewer-queues.mjs`). |
| `test-inspect-navigate.mjs` | 115 | Full inspect/navigate/poll viewer workflow |
| `test-http-viewer-queues.mjs` | 16 | HTTP cross-request viewerQueue persistence (requires server on :3000) |
| `smoke-v019-deprecated.mjs` | 25 | **DEPRECATED.** v0.19 feature smoke tests; predates v0.27 clusters A–F. Kept for reference. |
| `test-pure-functions.mjs` | 87 | Unit tests for exported pure functions |
| `test-fts-edge-cases.mjs` | — | FTS5 query escaping with tricky inputs |
| `test-new-filters.mjs` | 19 | v0.20 filters: creatorGender, creatorBornAfter/Before, expandPlaceHierarchy |
| `test-find-similar.mjs` | ~51 | All find_similar signal modes (Visual, Lineage, Iconclass, Description, Person, Place, Pooled). Requires `ENABLE_FIND_SIMILAR=true`. |
| `bench-find-similar.mjs` | — | Benchmark find_similar across diverse artworks to profile performance across signal profiles. |
| `bench-thread-count.py` | — | Benchmarks harvest-style Linked Art HTTP resolution at 8–16 threads (success rate, latency percentiles, throughput) against a fixed artwork sample. Used to tune harvest concurrency. |
| `bench-thread-count-low.py` | — | Same benchmark at 1–8 threads — checks whether the ~10 req/s server cap holds at lower concurrency. |
| `test-description-similarity.mjs` | ~4 | Smoke test for find_similar description mode. Requires `ENABLE_FIND_SIMILAR=true`. |
| `test-attribution-qualifiers.mjs` | ~5 | Verifies `attributionQualifier` extraction from Linked Art `assigned_by[].classified_as`. |
| `test-provenance-parser.mjs` | ~39 | Unit tests for Layer 1 provenance parser functions (splitEvents, classifyTransfer, parseDate, parsePrice, etc.) |
| `test-provenance-peg.mjs` | ~45 | Tests for PEG parser (Layer 1) + interpretation (Layer 2) + temporal bounds. |
| `test-provenance-search.mjs` | ~76 | Integration tests for `search_provenance` tool: party lookup, transfer type filters, date ranges, cross-references, parse audit. |
| `test-query-plans.mjs` | 200+ | EXPLAIN QUERY PLAN validation — asserts the optimizer never uses `idx_mappings_field_vocab` as a covering-scan driver. |
| `test-totalcount.mjs` | ~16 | Smoke test: totalResults always present + selective/compact facets. |
| `test-v019-features-deprecated.mjs` | — | **DEPRECATED.** Targeted tests for v0.19 features; predates v0.27 clusters A–F. Kept for reference. |
| `test-svg-overlays.mjs` | — | Visual test for SVG overlay rendering on The Night Watch. Opens viewer, adds various overlay shapes. |
| `test-viewer-build.mjs` | — | Validates bundled viewer HTML is self-contained (no CDN dependencies) and within size budget. |
| `audit-schemas.mjs` | — | Schema audit: checks all outputSchemas for structural risk factors (anyOf/oneOf, $ref/$defs, nesting depth). |
| `validate-vocab-db.mjs` | — | Comprehensive vocab DB structure & integrity validation (13 checks: integrity, tables, FTS5, FK integrity, importance, server compat, etc.) |
| `generate-similarity-review.deprecated.mjs` | — | **DEPRECATED.** Multi-call per-mode review predates v0.27 — `find_similar` no longer accepts `mode` and produces a 9-channel HTML page in one call. Kept for reference; do not run. |
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
