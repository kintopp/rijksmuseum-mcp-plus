# Search Parameters

`search_artwork` accepts 32 search filters and 7 output controls. At least one filter is required (parameters marked *modifier* narrow results but cannot be the sole filter). All filters combine freely with each other — results are the intersection (AND) of all active filters.

Parameters that accept arrays (marked **[]**) AND-combine their values: `subject: ["landscape", "seascape"]` returns artworks tagged with *both* subjects.

All searches are backed by a vocabulary database of ~418,000 controlled terms mapped to ~834,000 artworks via ~14.8 million mappings, enriched with creator biographical data (~49K life dates, ~64K gender annotations, ~15.5K Wikidata IDs) and a spatial place hierarchy (~23.9K authority-geocoded places). Demographic person filters (gender, birth/death year, birth/death place, profession) are exposed through the separate [`search_persons`](mcp-tool-parameters.md#search_persons) tool — feed the returned vocab IDs into `creator` here.

- [Ranking](#ranking)
- [Result limits and pagination](#result-limits-and-pagination)
- [1. Vocabulary label filters](#1-vocabulary-label-filters) (15 parameters)
- [2. Full-text search filters](#2-full-text-search-filters) (5 parameters)
- [3. Column and metadata filters](#3-column-and-metadata-filters) (12 parameters)
- [4. Output controls](#4-output-controls) (7 parameters)
- [Semantic search](#semantic-search)
- [Artwork detail fields](#artwork-detail-fields)

## Ranking

Results are ranked differently depending on which filters are active:

- **BM25** — when any full-text filter is active (`query`, `description`, `inscription`, `curatorialNarrative`, `textQuery`), results are ranked by text relevance.
- **Geographic proximity** — when `nearPlace` or `nearLat`/`nearLon` is active (without text filters), results are ranked by distance from the search point.
- **Importance** — when only vocabulary, column, or modifier filters are active, results are ordered by a composite importance score reflecting image availability, curatorial attention, and metadata richness.
- **Column sort** — `sort` overrides all of the above when set (see [Output controls](#4-output-controls)).

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
| `get_artwork_bibliography` | 5 | — | `full` | First 5 entries + `total`; `full: true` returns all (major works 100+) |
| `find_artworks_citing_publication` | 20 | — | `full` | First 20 + `total`; `full: true` returns all citing artworks |
| `get_conservation_history` | — | — | — | Single artwork lookup |

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
| `collectionSet` | string **[]** | Curated collection set by name. [193 sets](vocabulary-collection-sets.md). Use `list_curated_sets` to discover sets. | `"Rembrandt"` |

---

## 2. Full-text search filters

BM25-ranked search on FTS5 indexes. Exact word matching, no stemming (except `subject` above, which has morphological stemming). When any of these are active, results are ranked by text relevance.

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `query` | string | Search across all title variants (brief, full, former x EN/NL). ~826K artworks. Only ~4% of artworks have an English title (~35K of 834K). | `"Night Watch"` |
| `description` | string | Cataloguer descriptions (~510K artworks, 61% coverage). Compositional details, motifs, condition notes, attribution remarks. Dutch-language. | `"zwart krijt"` |
| `inscription` | string | Inscription texts (~500K artworks). Signatures, mottoes, dates on the object surface. | `"fecit"`, `"Rembrandt f."` |
| `curatorialNarrative` | string | Curatorial wall text (~14K artworks). Art-historical interpretation written by museum curators — distinct from `description`. | `"civic guard"` |

Ownership-history text is no longer searched from `search_artwork` — use the dedicated [`search_provenance`](mcp-tool-parameters.md#search_provenance) tool, which queries the parsed event/period structures with party-, transfer-type-, date-, location-, and price-based filters.

### Structured text query (`textQuery`)

The four flat filters above each match a single field, AND-combine, and treat their input as one literal phrase. When that is not enough — boolean either/or, either/or *across* fields, words near each other, or a word-stem wildcard — use the opt-in `textQuery` object instead. It compiles server-side into one BM25-ranked FTS5 query over the same four text fields (`title`, `description`, `inscription`, `curatorialNarrative`). Use it sparingly; for the common case the flat filters are simpler and more discoverable.

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `textQuery` | object | `{ must?: Clause[], should?: Clause[], mustNot?: Clause[] }` — `must`=AND, `should`=OR-group, `mustNot`=excluded. At least one `must`/`should` is required (a `mustNot`-only query is rejected). Each `Clause` targets one `field` (omit for all four) and OR-combines its terms. Combines freely with the structured filters (`type`, `creator`, `creationDate`, …). A malformed query is dropped with a `warnings` note rather than failing the search. | see below |

Clause keys (a clause carries one or more):

| Key | Meaning |
|-----|---------|
| `field` | One of `title`, `description`, `inscription`, `curatorialNarrative`. Omit to match all four. |
| `phrase` | Exact words in order. |
| `any` | List of tokens, matched as OR. |
| `prefix` | A stem; matches the stem plus any continuation (`sculp` also matches `sculptor`, `sculpsit`). |
| `anyPrefix` | List of stems, matched as OR. |
| `near` | `{ terms: [...], distance }` — terms within `distance` words of each other; a nested list inside `terms` offers alternatives at that position. |

Example — a theme written up differently per field, excluding history prints:

```json
{
  "should": [
    { "field": "description",        "phrase": "beeldenstorm" },
    { "field": "curatorialNarrative", "any": ["iconoclasm", "iconoclastic"] }
  ],
  "mustNot": [ { "field": "title", "phrase": "geschiedenis" } ]
}
```

---

## 3. Column and metadata filters

Direct filters on artwork table columns, JOIN-based demographic filters, and spatial queries.

### Date and image

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `creationDate` | string | Creation date. ~628K artworks with dates (3000 BCE–2025). Exact year or wildcard. | `"1642"`, `"16*"`, `"164*"` |
| `dateMatch` | string | How `creationDate` matches artwork date ranges. `"overlaps"` (default): artwork range overlaps query range — inclusive, but broadly-dated objects appear in multiple bins. `"within"`: artwork range falls entirely within query range — exclusive bins, but drops ~43% of collection with ranges >1 decade. `"midpoint"`: assigns each artwork to one bin by midpoint — every object counted exactly once. Best for statistical comparisons. | `"midpoint"` |
| `imageAvailable` | boolean | `true` = only artworks with a digital image (~730K); `false` = only those without one (~104K, e.g. un-photographed works on paper). *Modifier.* | `true` |
| `hasProvenance` | boolean | When `true`, only artworks with parsed provenance records (~48.5K of 834K). *Modifier.* | `true` |

### Dimensions

All values in centimeters. Both range parameters accept the same shape: `'10-50'` (between 10 and 50), `'10-'` (≥ 10), `'-50'` (≤ 50). Bounds are inclusive.

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `heightRange` | string | Height range in centimeters. | `"10-50"` |
| `widthRange` | string | Width range in centimeters. | `"-40"` |

### Same-row matching

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `sameRowMatching` | boolean | Constrain `creator` + `productionRole` to the *same* production row of the artwork (autograph detection). Without this flag the two filters evaluate independently across production rows, so reproductive prints and 19th-c. photographs catalogued under a master's name still match. Set true for "making" roles (painter, printmaker, etcher, …) when narrowing to autograph works; leave false (default) for relational roles like `"after painting by"`. Requires both `creator` and `productionRole`. The `creator` + `attributionQualifier` same-row conjunction is always on and doesn't need this flag. *Modifier.* | `true` |

### Geographic proximity

Searches both depicted and production places within the specified radius, using coordinates from ~23,900 authority-geocoded places (strict-authority policy since v0.40 — only `coord_method='deterministic'` rows from Rijks-supplied [Getty TGN](https://www.getty.edu/research/tools/vocabularies/tgn/) IDs are retained).

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `nearPlace` | string | Named location for proximity search. Only works for places that have been authority-geocoded. Supports multi-word names with geo-disambiguation. | `"Oude Kerk Amsterdam"` |
| `nearLat` | number | Latitude (-90 to 90). Use with `nearLon` for coordinate-based search. Always works (does not require authority-geocoded places). Takes precedence over `nearPlace` if both provided. | `52.3676` |
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
| `sort` | string | — | Order results by a column instead of relevance/importance. Forms: `'column'` or `'column:asc\|desc'` (default direction `desc`). Columns: `height` / `width` (cm), `dateEarliest` / `dateLatest` (year), `recordModified` (ISO date). Overrides BM25 and geo-proximity ordering when set; tie-broken by `art_id`. NULLs always sort last regardless of direction. Cannot be used alone — needs at least one substantive filter. |

---

## Semantic search

For concepts that cannot be expressed as structured vocabulary terms — atmosphere, emotion, composition, art-historical interpretation — use the `semantic_search` tool instead. It accepts free-text queries in any language and ranks all ~832,000 artworks by embedding similarity. It supports pre-filtering by `type`, `material`, `technique`, `creationDate`, `dateMatch`, `creator`, `subject`, `iconclass`, `depictedPerson`, `depictedPlace`, `productionPlace`, `collectionSet`, `aboutActor`, and `imageAvailable` — a subset of those listed above. See the [tool parameters reference](mcp-tool-parameters.md#semantic_search) for the full parameter list.

Each artwork's embedding is generated from a composite source text built from four metadata fields (the "no-subjects" strategy — subject vocabulary is excluded to avoid duplicating the structured search path):

| Component | Field | Description |
|-----------|-------|-------------|
| Title | `title` | Primary artwork title |
| Inscriptions | `inscription_text` | Transcribed text on the work (signatures, captions, dates); verso collector's-mark stamps and placeholder rows are stripped before embedding |
| Description | `description_text` | Cataloguer description (compositional details, motifs, condition) |
| Narrative | `narrative_text` | Curatorial wall text (art-historical interpretation) |

Fields are concatenated as `[Title] ... [Inscriptions] ... [Description] ... [Narrative] ...`, omitting any that are empty. Results include the reconstructed source text for grounding — use it to explain why a result matched or to flag false positives.

---

## Artwork detail fields

`get_artwork_details` returns the [full metadata category reference](metadata-categories.md) per artwork, plus summary fields (`id`, `title`, `creator`, `date`, `url`). Nearly all categories are also searchable collection-wide via corresponding `search_artwork` parameters — see the [metadata categories reference](metadata-categories.md) for the full list, including a table of search-only filters that have no corresponding return field.

Two companion single-artwork lookups return scholarly and forensic records that are not part of the search-filter set: [`get_artwork_bibliography`](mcp-tool-parameters.md#get_artwork_bibliography) (citations, linked publications, pages, ISBN — the `bibliographyCount` field on the detail record tells you whether any exist) and [`get_conservation_history`](mcp-tool-parameters.md#get_conservation_history) (technical examinations, restoration treatments, attribution-mark counts, a provenance excerpt). The reverse bibliography direction — which artworks cite a given publication — is [`find_artworks_citing_publication`](mcp-tool-parameters.md#find_artworks_citing_publication).
