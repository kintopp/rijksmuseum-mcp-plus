# Search Parameters

`search_artwork` accepts 33 search filters and 7 output controls. At least one filter is required (parameters marked *modifier* narrow results but cannot be the sole filter). Filters combine as an intersection (AND) of everything active, with one exception: proximity search overrides `depictedPlace`/`productionPlace` — see [Geographic proximity](#geographic-proximity).

Parameters that accept arrays (marked **[]**) AND-combine their values: `subject: ["landscape", "seascape"]` returns artworks tagged with *both* subjects.

All searches are backed by a vocabulary database of roughly 420K controlled terms mapped to about 830K artworks via some 15 million mappings, enriched with creator biographical data (life dates, gender, and Wikidata identifiers on a large minority of person records) and a spatial place hierarchy (about 24K authority-geocoded places). Demographic person filters (gender, birth/death year, birth/death place, profession) are exposed through the separate [`search_persons`](mcp-tool-parameters.md#search_persons) tool — feed the returned vocab IDs into `creator` here.

- [Ranking](#ranking)
- [Result limits and pagination](#result-limits-and-pagination)
- [1. Vocabulary label filters](#1-vocabulary-label-filters) (15 parameters)
- [2. Full-text search filters](#2-full-text-search-filters) (5 parameters)
- [3. Column and metadata filters](#3-column-and-metadata-filters) (13 parameters)
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
| `search_provenance` | 1 | 50 | `offset` | Each full-mode result includes the whole provenance chain, hence the default of 1; `compact: true` raises the default to 12. Response includes `totalArtworks`. |
| `search_persons` | 25 | 100 | `offset` | Authority-record search; feed `vocabId` into `search_artwork({creator})` |
| `search_inscriptions` | 20 | 100 | `offset` | Runtime parse; a broad single facet can trip the candidate cap (`candidatesCapped`) |
| `collection_stats` | 25 | 500 | `offset` | Returns compact text tables; high max for comprehensive distributions |
| `browse_set` | 10 | 50 | `resumptionToken` | Token is a stateless base64 offset over the local DB — **not** OAI-PMH, and not portable across DB upgrades |
| `get_recent_changes` | 10 | 50 | `resumptionToken` | Genuine OAI-PMH token-based pagination |
| `find_similar` | 20 | 50 | — | Results per similarity signal; not pageable |
| `get_artwork_details` | — | — | — | Single artwork lookup |
| `get_artwork_bibliography` | 5 | — | `full` | First 5 entries + `total`; `full: true` returns all (major works 100+) |
| `find_artworks_citing_publication` | 20 | — | `full` | First 20 + `total`; `full: true` returns all citing artworks |
| `get_conservation_history` | — | — | — | Single artwork lookup |

Tools with `offset` pagination return a total count in the response (`totalResults` or `totalArtworks`), allowing the client to page through the full result set. Token-paginated tools return an opaque `resumptionToken` with each page.

---

## 1. Vocabulary label filters

Match against the controlled-term vocabulary. Labels are bilingual (English and Dutch) — try the Dutch term if English returns no results (e.g. "fotograaf" instead of "photographer").

### Subject and iconography

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `subject` | string **[]** | Subject matter (Iconclass themes, depicted scenes). Primary parameter for concept searches — use before `description` or `curatorialNarrative`. Roughly 108K terms across the large majority of artworks. Exact word matching with a morphological fallback. | `"winter landscape"` |
| `iconclass` | string **[]** | Exact Iconclass notation code. More precise than `subject` — use the Iconclass server's search tool to discover codes by concept. Roughly 23K distinct notations are actually mapped to artworks here; the upstream thesaurus is far larger. | `"73D82"` |
| `depictedPerson` | string **[]** | Person depicted in the artwork — roughly 58K distinct persons across about 200K artworks. Matches against the full name-variant table, including historical forms. | `"Willem van Oranje"` |
| `depictedPlace` | string **[]** | Place depicted in the artwork — roughly 22K distinct places across the subject and spatial fields. Supports multi-word names with geo-disambiguation (e.g. "Oude Kerk Amsterdam" resolves to the Oude Kerk in Amsterdam). Distinct from `productionPlace` — a painting *depicting* Amsterdam may have been made in Haarlem. | `"Batavia"` |

### Production

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `creator` | string **[]** | Artist or maker name — present on the large majority of artworks, across roughly 70K distinct creator terms. Uses canonical name forms (e.g. "Rembrandt van Rijn"). | `"Rembrandt van Rijn"` |
| `aboutActor` | string | Broader person search across depicted persons *and* creators. More tolerant of cross-language name forms than `depictedPerson` (e.g. "Louis XIV" finds "Lodewijk XIV"). | `"Louis XIV"` |
| `productionPlace` | string **[]** | Where the artwork was made — roughly 10K distinct places. Supports multi-word names with geo-disambiguation. | `"Delft"` |
| `productionRole` | string **[]** | Role an actor played in creating *this specific work* — distinct from the person's profession (which lives on `search_persons`). See the [production-role vocabulary](vocabulary-production-roles.md) for the full list and current counts. Key terms: "print maker", "publisher", "after painting by". | `"after painting by"` |
| `attributionQualifier` | string **[]** | Attribution qualifier. 13 values (ordered by DB frequency): "primary", "undetermined", "after", "secondary", "possibly", "attributed to", "circle of", "workshop of", "copyist of", "manner of", "follower of", "falsification", "free-form". Mixes connoisseurship terms (workshop/circle/manner/follower/copyist of), editorial-confidence terms (attributed to, possibly, undetermined), and structural markers (primary, secondary, after, falsification, free-form). Combine with `creator` to narrow attribution. | `"workshop of"` |

### Object classification

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `type` | string **[]** | Object type (e.g. "painting", "print", "drawing", "photograph", "sculpture"). A few thousand terms. | `"painting"` |
| `material` | string **[]** | Material or support — see the [materials vocabulary](vocabulary-materials.md) for the full list and current counts (e.g. "canvas", "paper", "panel", "oil paint"). | `"panel"` |
| `technique` | string **[]** | Artistic technique. [967 terms](vocabulary-techniques.md) (e.g. "oil painting", "etching", "mezzotint"). | `"etching"` |

### Curatorial classification

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `theme` | string **[]** | Curatorial thematic tag (e.g. "overzeese geschiedenis", "economische geschiedenis", "costume"). Distinct from `subject` (Iconclass) and depicted persons/places — themes group works around collection-level narratives. ~7% of artworks have at least one theme; most labels are Dutch (~17% have curated English labels). | `"overzeese geschiedenis"` |
| `sourceType` | string **[]** | Source-channel classification reflecting the cataloguing source (distinct from `type`, which uses Linked Art object-classification vocabulary). 6 values, in descending frequency: `designs`, `drawings`, `paintings`, `prints (visual works)`, `sculpture (visual works)`, `photographs`. | `"paintings"` |

### Collection

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `collectionSet` | string **[]** | Curated collection set by name. [193 sets](vocabulary-collection-sets.md). Use `list_curated_sets` to discover sets. | `"Rembrandt"` |

---

## 2. Full-text search filters

BM25-ranked search on FTS5 indexes. Exact word matching, no stemming. When any of these are active, results are ranked by text relevance.

The vocabulary label filters above (`subject`, `creator`, `type`, `material`, and the rest) do have a morphological fallback, but only as a second pass: it fires when an exact FTS match returns nothing, accepts at most three input tokens, and expands to at most eight variants.

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `query` | string | Search across all title variants (brief, full, former x EN/NL) — present on essentially every artwork. Fewer than one in twenty has an English title, so a query in English may miss Dutch-only records. | `"Night Watch"` |
| `description` | string | Cataloguer descriptions (roughly 61% coverage). Compositional details, motifs, condition notes, attribution remarks. Dutch-language. | `"zwart krijt"` |
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
| `near` | `{ terms: [...], distance }` — terms within `distance` words of each other; a nested list inside `terms` offers alternatives at that position. Needs at least two term slots, and `distance` must be a positive integer. |

**Limits.** A compiled query may carry at most 32 terms in total; past that the entire `textQuery` is dropped and a warning is returned rather than the search failing. `near` alternatives count against the same budget, and they multiply — a three-slot `near` with three alternatives each expands to 27 terms, not 9. Each of `must`, `should` and `mustNot` needs at least one clause if present, and a clause whose terms all reduce to nothing after FTS escaping is silently discarded.

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
| `objectNumber` | string | Exact object identifier, or a wildcard pattern using `*` (any run of characters) and `?` (a single character). Case-sensitive, and a wildcard pattern needs at least two literal characters. Useful for walking an accession series. | `"SK-C-5"`, `"RP-P-1991-*"` |
| `creationDate` | string | Creation date — recorded for 99.9% of artworks, spanning 3300 BCE to the present. Exact year or wildcard; negative-year wildcards work too (`-5*` covers 5999–5000 BCE). | `"1642"`, `"16*"`, `"164*"` |
| `dateMatch` | string | *Modifier* — cannot be the sole filter. How `creationDate` matches artwork date ranges. `"overlaps"` (default): artwork range overlaps query range — inclusive, but broadly-dated objects appear in multiple bins. `"within"`: artwork range falls entirely within query range — exclusive bins, but drops ~43% of collection with ranges >1 decade. `"midpoint"`: assigns each artwork to one bin by midpoint — every object counted exactly once. Best for statistical comparisons. | `"midpoint"` |
| `imageAvailable` | boolean | `true` = only artworks with a digital image (roughly seven in eight); `false` = only those without one (e.g. un-photographed works on paper). *Modifier.* | `true` |
| `hasProvenance` | boolean | When `true`, only artworks with parsed provenance records (roughly 48K). *Modifier.* | `true` |

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

Searches within the specified radius using coordinates from roughly 24K authority-geocoded places (strict-authority policy since v0.40 — only `coord_method='deterministic'` rows from Rijks-supplied [Getty TGN](https://www.getty.edu/research/tools/vocabularies/tgn/) IDs are retained; in the current DB that is 100% of the geocoded set).

**Proximity overrides the other place filters.** When `nearPlace` or `nearLat`+`nearLon` is active, any `depictedPlace` or `productionPlace` in the same call is dropped and a warning is returned. The two cannot be combined.

**Coverage caveat.** The proximity condition is evaluated over the depicted-subject and `spatial` fields. `productionPlace` as a filter also spans the separate Linked Art production-place field, which proximity does **not** reach — so a work whose production place is recorded only there will not be found by radius, even though `productionPlace: "Delft"` finds it.

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `nearPlace` | string | Named location for proximity search. Only works for places that have been authority-geocoded. Supports multi-word names with geo-disambiguation. | `"Oude Kerk Amsterdam"` |
| `nearLat` | number | Latitude (-90 to 90). Use with `nearLon` for coordinate-based search. Always works (does not require authority-geocoded places). Takes precedence over `nearPlace` if both provided. | `52.3676` |
| `nearLon` | number | Longitude (-180 to 180). Use with `nearLat`. | `4.8945` |
| `nearPlaceRadius` | number | Radius in km (0.1–500, default 25). *Modifier* — cannot be the sole filter. | `15` |

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

For concepts that cannot be expressed as structured vocabulary terms — atmosphere, emotion, composition, art-historical interpretation — use the `semantic_search` tool instead. It accepts free-text queries in any language and ranks the whole embedded corpus by similarity. It supports pre-filtering by `type`, `material`, `technique`, `creationDate`, `dateMatch`, `creator`, `subject`, `iconclass`, `depictedPerson`, `depictedPlace`, `productionPlace`, `collectionSet`, `aboutActor`, and `imageAvailable` — a subset of those listed above. See the [tool parameters reference](mcp-tool-parameters.md#semantic_search) for the full parameter list.

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
