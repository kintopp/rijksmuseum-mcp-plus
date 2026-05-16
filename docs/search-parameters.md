# Search Parameters

`search_artwork` accepts 37 search filters and 9 output controls. At least one filter is required (parameters marked *modifier* narrow results but cannot be the sole filter). All filters combine freely with each other — results are the intersection (AND) of all active filters.

Parameters that accept arrays (marked **[]**) AND-combine their values: `subject: ["landscape", "seascape"]` returns artworks tagged with *both* subjects.

All searches are backed by a vocabulary database of ~418,000 controlled terms mapped to ~834,000 artworks via ~14.8 million mappings, enriched with creator biographical data (~49K life dates, ~64K gender annotations, ~15.5K Wikidata IDs) and a spatial place hierarchy (~29.7K geocoded places, 81% of known places). Demographic person filters (gender, birth/death year, birth/death place, profession) are exposed through the separate [`search_persons`](mcp-tool-parameters.md#search_persons) tool — feed the returned vocab IDs into `creator` here.

- [Ranking](#ranking)
- [Result limits and pagination](#result-limits-and-pagination)
- [1. Vocabulary label filters](#1-vocabulary-label-filters) (16 parameters)
- [2. Full-text search filters](#2-full-text-search-filters) (6 parameters)
- [3. Column and metadata filters](#3-column-and-metadata-filters) (15 parameters)
- [4. Output controls](#4-output-controls) (9 parameters)
- [Semantic search](#semantic-search)
- [Artwork detail fields](#artwork-detail-fields)

## Ranking

Results are ranked differently depending on which filters are active:

- **BM25** — when any full-text filter is active (`title`, `description`, `inscription`, `creditLine`, `curatorialNarrative`), results are ranked by text relevance.
- **Geographic proximity** — when `nearPlace` or `nearLat`/`nearLon` is active (without text filters), results are ranked by distance from the search point.
- **Importance** — when only vocabulary, column, or modifier filters are active, results are ordered by a composite importance score reflecting image availability, curatorial attention, and metadata richness.
- **Column sort** — `sortBy` overrides all of the above when set (see [Output controls](#4-output-controls)).

---

## Result limits and pagination

| Tool | Default | Max | Pagination | Notes |
|------|---------|-----|------------|-------|
| `search_artwork` | 25 | 50 | `offset` | Response includes `totalResults` for the full match count |
| `semantic_search` | 15 | 50 | `offset` | Similarity scores plateau after ~15 results |
| `search_provenance` | 1 | 50 | `offset` | Each result includes the full provenance chain; response includes `totalArtworks` |
| `collection_stats` | 25 | 500 | `offset` | Returns compact text tables; high max for comprehensive distributions |
| `browse_set` | 10 | 50 | `resumptionToken` | OAI-PMH token-based pagination |
| `get_recent_changes` | 10 | 50 | `resumptionToken` | OAI-PMH token-based pagination |
| `find_similar` | 20 | 50 | — | Results per similarity signal; not pageable |
| `get_artwork_details` | — | — | — | Single artwork lookup |

Tools with `offset` pagination return a total count in the response (`totalResults` or `totalArtworks`), allowing the client to page through the full result set. OAI-PMH tools use opaque `resumptionToken` values returned with each page.

---

## 1. Vocabulary label filters

Match against ~417,000 controlled terms. Labels are bilingual (English and Dutch) — try the Dutch term if English returns no results (e.g. "fotograaf" instead of "photographer").

### Subject and iconography

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `subject` | string **[]** | Subject matter (Iconclass themes, depicted scenes). Primary parameter for concept searches — use before `description` or `curatorialNarrative`. ~108K terms, ~722K artworks. Exact word matching with morphological stemming. | `"winter landscape"` |
| `iconclass` | string **[]** | Exact Iconclass notation code. More precise than `subject` — use the Iconclass server's search tool to discover codes by concept. ~25K notation codes. | `"73D82"` |
| `depictedPerson` | string **[]** | Person depicted in the artwork. ~60K persons, ~217K artworks. Matches against 210K name variants including historical forms. | `"Willem van Oranje"` |
| `depictedPlace` | string **[]** | Place depicted in the artwork. 20,689 places. Supports multi-word names with geo-disambiguation (e.g. "Oude Kerk Amsterdam" resolves to the Oude Kerk in Amsterdam). Distinct from `productionPlace` — a painting *depicting* Amsterdam may have been made in Haarlem. | `"Batavia"` |

### Production

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `creator` | string **[]** | Artist or maker name. ~510K artworks, ~21K unique names. Uses canonical name forms (e.g. "Rembrandt van Rijn"). | `"Rembrandt van Rijn"` |
| `aboutActor` | string | Broader person search across depicted persons *and* creators. More tolerant of cross-language name forms than `depictedPerson` (e.g. "Louis XIV" finds "Lodewijk XIV"). | `"Louis XIV"` |
| `productionPlace` | string **[]** | Where the artwork was made. 9,002 places. Supports multi-word names with geo-disambiguation. | `"Delft"` |
| `productionRole` | string **[]** | Role an actor played in creating *this specific work* — distinct from the person's profession (which lives on `search_persons`). [178 terms](vocabulary-production-roles.md). Key terms: "print maker" (382K), "publisher" (185K), "after painting by" (46K). | `"after painting by"` |
| `attributionQualifier` | string **[]** | Attribution qualifier. 13 values (ordered by DB frequency): "primary", "undetermined", "after", "secondary", "possibly", "attributed to", "circle of", "workshop of", "copyist of", "manner of", "follower of", "falsification", "free-form". Mixes connoisseurship terms (workshop/circle/manner/follower/copyist of), editorial-confidence terms (attributed to, possibly, undetermined), and structural markers (primary, secondary, after, falsification, free-form). Combine with `creator` to narrow attribution. | `"workshop of"` |

### Object classification

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `type` | string **[]** | Object type. 4,385 terms (e.g. "painting", "print", "drawing", "photograph", "sculpture"). | `"painting"` |
| `material` | string **[]** | Material or support. [734 terms](vocabulary-materials.md) (e.g. "canvas", "paper", "panel", "oil paint"). | `"panel"` |
| `technique` | string **[]** | Artistic technique. [967 terms](vocabulary-techniques.md) (e.g. "oil painting", "etching", "mezzotint"). | `"etching"` |

### Curatorial classification

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `theme` | string **[]** | Curatorial thematic tag (e.g. "overzeese geschiedenis", "economische geschiedenis", "costume"). Distinct from `subject` (Iconclass) and depicted persons/places — themes group works around collection-level narratives. ~7% of artworks have at least one theme; most labels are Dutch (~17% have curated English labels). | `"overzeese geschiedenis"` |
| `sourceType` | string **[]** | Source-channel classification reflecting the cataloguing source (distinct from `type`, which uses Linked Art object-classification vocabulary). 6 values: `designs` (90K), `drawings` (49K), `paintings` (46K), `prints (visual works)` (19K), `sculpture (visual works)` (5K), `photographs` (3K). | `"paintings"` |

### Collection

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `collectionSet` | string **[]** | Curated collection set by name. [192 sets](vocabulary-collection-sets.md). Use `list_curated_sets` to discover sets. | `"Rembrandt"` |
| `license` | string | Rights/license filter. Values: "publicdomain" ([PDM 1.0](http://creativecommons.org/publicdomain/mark/1.0/) — 728K), "zero" ([CC0 1.0](http://creativecommons.org/publicdomain/zero/1.0/) — 1.7K), "InC" ([In Copyright](http://rightsstatements.org/vocab/InC/1.0/) — 101K). Uses substring matching, so "by" also works for CC BY. | `"publicdomain"` |

---

## 2. Full-text search filters

BM25-ranked search on FTS5 indexes. Exact word matching, no stemming (except `subject` above, which has morphological stemming). When any of these are active, results are ranked by text relevance.

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `title` | string | Search across all title variants (brief, full, former x EN/NL). ~826K artworks. | `"Night Watch"` |
| `query` | string | Alias for `title`. Provided as a convenience for exploratory queries. When both are provided, `title` takes precedence. | `"Night Watch"` |
| `description` | string | Cataloguer descriptions (~510K artworks, 61% coverage). Compositional details, motifs, condition notes, attribution remarks. Dutch-language. | `"zwart krijt"` |
| `inscription` | string | Inscription texts (~500K artworks). Signatures, mottoes, dates on the object surface. | `"fecit"`, `"Rembrandt f."` |
| `creditLine` | string | Credit/donor lines (~358K artworks). Acquisition mode — purchase, bequest, gift, loan. | `"Drucker"`, `"purchase"` |
| `curatorialNarrative` | string | Curatorial wall text (~14K artworks). Art-historical interpretation written by museum curators — distinct from `description`. | `"civic guard"` |

Ownership-history text is no longer searched from `search_artwork` — use the dedicated [`search_provenance`](mcp-tool-parameters.md#search_provenance) tool, which queries the parsed event/period structures with party-, transfer-type-, date-, location-, and price-based filters.

---

## 3. Column and metadata filters

Direct filters on artwork table columns, JOIN-based demographic filters, and spatial queries.

### Date and image

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `creationDate` | string | Creation date. ~628K artworks with dates (3000 BCE–2025). Exact year or wildcard. | `"1642"`, `"16*"`, `"164*"` |
| `dateMatch` | string | How `creationDate` matches artwork date ranges. `"overlaps"` (default): artwork range overlaps query range — inclusive, but broadly-dated objects appear in multiple bins. `"within"`: artwork range falls entirely within query range — exclusive bins, but drops ~43% of collection with ranges >1 decade. `"midpoint"`: assigns each artwork to one bin by midpoint — every object counted exactly once. Best for statistical comparisons. | `"midpoint"` |
| `imageAvailable` | boolean | When `true`, only artworks with a digital image (~728K artworks). *Modifier.* | `true` |
| `hasProvenance` | boolean | When `true`, only artworks with parsed provenance records (~48.5K of 834K). *Modifier.* | `true` |
| `modifiedAfter` | string | ISO 8601 date — only records whose catalogue entry was last modified at or after this date. Powers "what changed since YYYY-MM-DD?" without OAI-PMH resumption tokens; combinable with any other filter. *Modifier.* | `"2024-01-01"` |
| `modifiedBefore` | string | ISO 8601 date — only records whose catalogue entry was last modified at or before this date. *Modifier.* | `"2025-12-31"` |

### Dimensions

All values in centimeters.

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `minHeight` | number | Minimum height. | `40` |
| `maxHeight` | number | Maximum height. | `50` |
| `minWidth` | number | Minimum width. | `300` |
| `maxWidth` | number | Maximum width. | `40` |

### Geographic proximity

Searches both depicted and production places within the specified radius, using coordinates from ~29,700 geocoded places ([Getty TGN](https://www.getty.edu/research/tools/vocabularies/tgn/), [Wikidata](https://www.wikidata.org/), [GeoNames](https://www.geonames.org/), [World Historical Gazetteer](https://whgazetteer.org/)).

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `nearPlace` | string | Named location for proximity search. Supports multi-word names with geo-disambiguation. | `"Oude Kerk Amsterdam"` |
| `nearLat` | number | Latitude (-90 to 90). Use with `nearLon` for coordinate-based search. Takes precedence over `nearPlace` if both provided. | `52.3676` |
| `nearLon` | number | Longitude (-180 to 180). Use with `nearLat`. | `4.8945` |
| `nearPlaceRadius` | number | Radius in km (0.1–500, default 25). | `15` |

### Place hierarchy

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `expandPlaceHierarchy` | boolean | Expand place filters (`productionPlace`, `depictedPlace`) to include sub-places in the administrative hierarchy, up to 3 levels deep. E.g. `productionPlace: "Netherlands"` includes Amsterdam, Delft, etc. *Modifier.* | `true` |

---

## 4. Output controls

Not filters — these control how results are returned.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `maxResults` | integer | 25 | Maximum results (1–50). All results include full metadata unless `compact` is true. |
| `offset` | integer | 0 | Skip this many results (for pagination). Use with `maxResults`. |
| `compact` | boolean | `false` | Returns only total count and object IDs without resolving metadata (faster for counting). |
| `facets` | boolean or string[] | — | Compute facet counts when results are truncated. Pass `true` for all dimensions, or an array of specific dimension names. Available dimensions: `type`, `material`, `technique`, `century`, `rights`, `imageAvailable`, `creator`, `depictedPerson`, `depictedPlace`, `productionPlace`, `theme`, `sourceType`. Dimensions already filtered on are excluded automatically. |
| `facetLimit` | integer | 5 | Maximum entries per facet dimension (1–50). |
| `groupBy` | string | — | Set to `parent` to collapse component records under their parent (sketchbook folios, album leaves, print-series sheets). Children whose parent is also a hit are dropped; the parent gains a `groupedChildCount`. Children whose parent isn't a hit remain in the result. |
| `sortBy` | string | — | Order results by a column instead of relevance/importance. Values: `height` / `width` (cm), `dateEarliest` / `dateLatest` (year), `recordModified` (ISO date). Overrides BM25 and geo-proximity ordering when set; tie-broken by `art_id`. Cannot be used alone — needs at least one substantive filter. |
| `sortOrder` | string | `desc` | Sort direction when `sortBy` is set: `asc` or `desc`. NULLs always sort last regardless of direction. |
| `pageToken` | string | — | Opaque continuation token returned by a previous response (used for stable deep pagination on sorted queries). |

---

## Semantic search

For concepts that cannot be expressed as structured vocabulary terms — atmosphere, emotion, composition, art-historical interpretation — use the `semantic_search` tool instead. It accepts free-text queries in any language and ranks all ~833,000 artworks by embedding similarity. It supports pre-filtering by `type`, `material`, `technique`, `creationDate`, `dateMatch`, `creator`, `subject`, `iconclass`, `depictedPerson`, `depictedPlace`, `productionPlace`, `collectionSet`, `aboutActor`, and `imageAvailable` — a subset of those listed above. See the [tool parameters reference](mcp-tool-parameters.md#semantic_search) for the full parameter list.

Each artwork's embedding is generated from a composite source text built from four metadata fields (the "no-subjects" strategy — subject vocabulary is excluded to avoid duplicating the structured search path):

| Component | Field | Description |
|-----------|-------|-------------|
| Title | `title` | Primary artwork title |
| Inscriptions | `inscription_text` | Transcribed text from the object surface |
| Description | `description_text` | Cataloguer description (compositional details, motifs, condition) |
| Narrative | `narrative_text` | Curatorial wall text (art-historical interpretation) |

Fields are concatenated as `[Title] ... [Inscriptions] ... [Description] ... [Narrative] ...`, omitting any that are empty. Results include the reconstructed source text for grounding — use it to explain why a result matched or to flag false positives.

---

## Artwork detail fields

`get_artwork_details` returns the [full metadata category reference](metadata-categories.md) per artwork, plus summary fields (`id`, `title`, `creator`, `date`, `url`). Nearly all categories are also searchable collection-wide via corresponding `search_artwork` parameters — see the [metadata categories reference](metadata-categories.md) for the full list, including a table of search-only filters that have no corresponding return field.
