<!--
Draft release notes for v0.24. Not committed.
-->

## v0.24.0

First full re-harvest (April 16, 2026) since v0.21. Backward-compatible with v0.23.1 — no tool-schema changes, no removed tools.

### Highlights

- **Image annotation with self-verification:** `inspect_artwork_image` can now draw overlays on the returned IIIF region and rejects out-of-bounds coordinates with a structured warning. An LLM can propose a region, see the annotated result, and correct itself.
- **Provenance corrections:** LLM-audited fixes for truncated locations, phantom events, bequest chains, and multi-transfer sequences. 
- **Improved geo enrichments:** coordinates, hierarchy, and external IDs re-derived from TGN, Wikidata, GeoNames, and World Historical Gazetteer. Every enriched field carries a provenance tag (`authority` / `derived` / `manual`).
- **In-harvest vocabulary additions:** person records gain birth/death years, gender, short bio, and Wikidata ID at harvest time rather than via a separate pass. These new vocabulary additions aren't yet queryable (deferred to v0.25).

### Image annotation

- `inspect_artwork_image` now optionally composites SVG overlays onto the returned region
- `crop_pixels:x,y,w,h` region format alongside `pct:` and IIIF native (`full`, `square`)
- Out-of-bounds regions rejected with structured warning rather than silent clipping
- Size defaults raised (1200 → 1568 px, max 2000 → 2016) for higher-fidelity detail inspection; matches Claude's divisible-by-28 preference. 1568 px long edge matches the highest resolution that Claude Sonnet can work with.
- Overlay harness in `scripts/tests/overlay-harness-*` for ground-truth metrics

### Provenance

- LLM-driven field corrections, event reclassifications, and event splitting applied across the corpus
- Every LLM or rule-based correction carries an `enrichment_reasoning` string
- `provenance_text_hash` (SHA-256) added on `artworks` for change detection on future re-harvests
- Non-cross-ref unknown-type events reduced to single digits; null-position parties eliminated

### Geography

- Three-tier coordinate provenance: `authority` (TGN/GeoNames/Wikidata/AAT lookup), `derived` (WHG reconciliation, parent fallback, validation fix), `manual` (reviewer-accepted)
- Dateline longitude bug fixed — no more places 40,000 km off
- Constituent-country areal flagging — England, Scotland, Wales, Northern Ireland no longer share a centroid with their parent country
- WHG country-context filter reduces cross-border false positives
- TGN + Wikidata SPARQL side-pass for place type classification

### Vocabulary

- **Schema.org dumps ingested alongside CIDOC-CRM/Linked Art.** The two feeds sit in separate Rijksmuseum ID namespaces and are complementary rather than overlapping. Net result: persons grew from ~121K to ~291K (+140%), places from ~32K to ~37K (+14%), and `organisation` is now a distinct type with ~28K entries (previously absent).
- Person enrichment added to the harvest (`birth_year`, `death_year`, `gender`, `bio`, `wikidata_id`)
- Place hierarchy (`broader_id`) populated from TGN/Wikidata parent links
- Multi-authority external IDs surfaced via new `vocabulary_external_ids` table (AAT, TGN, Wikidata, GeoNames, ULAN, VIAF, RKD)
- **Group vs Person fix:** organisations, ships, and institutions (e.g. VOC) now typed `group`, not `person` — previously, ~12K rows  were misclassified in depicted-person searches

### Embeddings

- Regenerated against the v0.24 vocab DB (vocab embeddings and description embeddings)
- Description embeddings restored to full 384d (v0.22 used PCA-compressed 256d)
- `vec0` phantom cleanup — surgical fix on 16 records; fixing the generator-script deferred to v0.25

### DB sizes

- `vocabulary.db`: 1.4 GB uncompressed, 385 MB gzipped
- `embeddings.db`: 2.0 GB uncompressed, 1.1 GB gzipped

### Companion Iconclass MCP server

Iconclass is no longer embedded in this server. It now lives in a standalone companion — [rijksmuseum-iconclass-mcp](https://github.com/kintopp/rijksmuseum-iconclass-mcp) — covering ~1.3M notations across 13 languages, with semantic and keyword search, hierarchical browsing, batch notation resolution, and per-collection presence counts so you can see which notations actually have artworks in a given collection. 

