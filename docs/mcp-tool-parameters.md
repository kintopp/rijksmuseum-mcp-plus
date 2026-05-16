Rijksmuseum MCP — Tool Parameters Reference

---

## search_artwork

The primary search tool. All filters can be freely combined. See [search-parameters.md](search-parameters.md) for the full reference with examples, coverage numbers, and ranking rules.

### Core filters
| Parameter | Description |
|---|---|
| `query` | General title search |
| `creator` | Artist name, e.g. `Rembrandt van Rijn` |
| `type` | Object type: `painting`, `print`, `drawing`, etc. |
| `material` | e.g. `canvas`, `paper`, `wood` |
| `technique` | e.g. `oil painting`, `etching` |
| `creationDate` | Exact year (`1642`) or wildcard (`16*`, `164*`) |
| `dateMatch` | How `creationDate` matches artwork date ranges: `overlaps` (default), `within`, or `midpoint` |

### Vocabulary-based filters
| Parameter | Description |
|---|---|
| `title` | Search all title variants (brief, full, former × EN/NL) |
| `subject` | Primary concept/theme search — searches ~833K artworks via Iconclass vocabulary. Start here for thematic queries |
| `iconclass` | Exact Iconclass notation code (e.g. `34B11` for dogs). More precise than `subject` |
| `description` | Full-text search on cataloguer descriptions (~510K artworks) |
| `curatorialNarrative` | Full-text search on museum wall text (~14K artworks) |
| `inscription` | Full-text search on inscription texts (signatures, mottoes, dates on objects) |
| `creditLine` | Full-text search on credit/donor lines |
| `depictedPerson` | Artworks depicting a named person |
| `depictedPlace` | Artworks depicting a named place |
| `productionPlace` | Place where the work was made |
| `productionRole` | e.g. `painter`, `printmaker`, `attributed to` |
| `theme` | Curatorial thematic tag (e.g. `overzeese geschiedenis`, `costume`). Distinct from `subject`/Iconclass. ~7% coverage, mostly Dutch labels. |
| `sourceType` | Source-channel classification (6 values: `designs`, `drawings`, `paintings`, `prints (visual works)`, `sculpture (visual works)`, `photographs`). Distinct from `type`. |
| `collectionSet` | Named curated collection set (use `list_curated_sets` to discover) |
| `license` | Rights filter: `publicdomain`, `zero` (CC0), `by` (CC BY) |

### Dimension filters
| Parameter | Description |
|---|---|
| `minWidth` | Minimum width in cm |
| `maxWidth` | Maximum width in cm |
| `minHeight` | Minimum height in cm |
| `maxHeight` | Maximum height in cm |

### Attribution filter
| Parameter | Description |
|---|---|
| `attributionQualifier` | Filter by attribution qualifier (13 values, ordered by frequency): `primary`, `undetermined`, `after`, `secondary`, `possibly`, `attributed to`, `circle of`, `workshop of`, `copyist of`, `manner of`, `follower of`, `falsification`, `free-form`. Combine with `creator` to narrow attribution. |

> Demographic person filters (gender, birth/death year, birth/death place, profession) live on the [`search_persons`](#search_persons) tool — feed the returned vocab IDs into `creator` here.

### Place and proximity filters
| Parameter | Description |
|---|---|
| `expandPlaceHierarchy` | When `true`, place searches (`productionPlace`, `depictedPlace`) expand to include sub-places. E.g. `productionPlace: 'Netherlands'` includes Amsterdam, Delft, etc. (up to 3 levels) |
| `nearPlace` | Proximity search by place name |
| `nearLat` / `nearLon` | Proximity search by coordinates |
| `nearPlaceRadius` | Radius in km for proximity search (default 25) |

### Other filters
| Parameter | Description |
|---|---|
| `aboutActor` | Artworks about a person — broader recall than `depictedPerson`, searches both subject and creator vocabulary |
| `imageAvailable` | `true` to return only works with a digital image |
| `hasProvenance` | `true` to return only works with parsed provenance records (~48.5K of 834K) |
| `modifiedAfter` | ISO 8601 date — only records modified at or after this date (e.g. `2024-01-01`). Combine with any other filter to ask "what changed since …?" |
| `modifiedBefore` | ISO 8601 date — only records modified at or before this date |

### Output controls
| Parameter | Description |
|---|---|
| `maxResults` | 1–50 (default 25) |
| `offset` | Skip this many results (for pagination) |
| `compact` | `true` returns IDs only without full metadata (faster) |
| `facets` | `true` for all facet dimensions, or an array of specific dimensions to compute. Available: `type`, `material`, `technique`, `century`, `rights`, `imageAvailable`, `creator`, `depictedPerson`, `depictedPlace`, `productionPlace`, `theme`, `sourceType` |
| `facetLimit` | Maximum entries per facet dimension (1–50, default 5) |
| `groupBy` | Set to `parent` to collapse component records (sketchbook folios, album leaves, print-series sheets) under their parent. Parent gains `groupedChildCount`. |
| `sortBy` | Order by a column instead of relevance/importance: `height`, `width`, `dateEarliest`, `dateLatest`, `recordModified`. Overrides BM25/geo ordering when set; tie-broken by `art_id`. |
| `sortOrder` | `asc` or `desc` (default `desc`). NULLs always sort last. |
| `pageToken` | Opaque continuation token from a previous response (stable deep pagination on sorted queries) |

---

## search_persons

Search the ~290K person + ~12K group authority records by name (~700K name variants), demographic (gender, birth/death year) or structural (birth/death place, profession) criteria. Returns vocab IDs to feed into `search_artwork({creator: <vocabId>})` for works *by* them, or `search_artwork({aboutActor: <name>})` for works *depicting* them.

| Parameter | Description |
|---|---|
| `name` | Phrase or token match against ~700K name variants. Tries exact phrase first, then token AND with stop-word stripping. |
| `gender` | Categorical: `female`, `male`, or other normalised values. Returns 0 rows if person enrichment is absent on the DB. |
| `bornAfter` | Birth year ≥ this value (integer) |
| `bornBefore` | Birth year ≤ this value (integer) |
| `birthPlace` | Place name (string or array, AND-combined). Resolved by pivot through creator-mapped artworks. |
| `deathPlace` | Place name (string or array, AND-combined) |
| `profession` | Profession (e.g. `painter`, `engraver`; string or array, AND-combined) |
| `hasArtworks` | Restrict to persons appearing as creator on ≥1 artwork. Default `true`. |
| `maxResults` | 1–100 (default 25) |
| `offset` | Skip this many results (for pagination) |

---

## semantic_search

Natural language / concept-based search. Best for atmospheric, thematic, or art-historical queries.

| Parameter | Description |
|---|---|
| `query` | Natural language concept, e.g. `vanitas symbolism`, `artist gazing at the viewer` |
| `type` | Object type filter, e.g. `painting` (string or array) |
| `material` | Filter by material (string or array) |
| `technique` | Filter by technique (string or array) |
| `creator` | Filter by artist name (string or array) |
| `creationDate` | Exact year or wildcard |
| `dateMatch` | Date matching mode: `overlaps`, `within`, or `midpoint` |
| `subject` | Pre-filter by subject before semantic ranking (string or array) |
| `iconclass` | Pre-filter by Iconclass notation (string or array) |
| `depictedPerson` | Pre-filter by depicted person (string or array) |
| `depictedPlace` | Pre-filter by depicted place (string or array) |
| `productionPlace` | Pre-filter by production place (string or array) |
| `collectionSet` | Pre-filter by collection set (string or array) |
| `aboutActor` | Pre-filter by person (depicted or creator) |
| `imageAvailable` | `true` to restrict to artworks with images |
| `maxResults` | 1–50 (default 15) |
| `offset` | Skip this many results (for pagination) |

---

## collection_stats

Aggregate statistics, counts, and distributions across the collection. Returns text tables plus a structured payload (denominator/grouping/coverage semantics disclosed in the output schema). Artwork filters and provenance filters combine freely; event-level provenance filters compose on the same event row, party-level filters on the same party row.

### Core
| Parameter | Description |
|---|---|
| `dimension` | What to count/group by. **Artwork:** `type`, `material`, `technique`, `creator`, `depictedPerson`, `depictedPlace`, `productionPlace`, `century`, `decade`, `height`, `width`, `theme`, `sourceType`, `exhibition`, `decadeModified` (record_modified bucketed by decade, clamped 1990–2030). **Provenance:** `transferType`, `transferCategory`, `provenanceDecade`, `provenanceLocation`, `party`, `partyPosition`, `currency`, `categoryMethod`, `positionMethod`, `parseMethod`. |
| `topN` | Maximum entries to return (1–500, default 25) |
| `offset` | Skip this many entries (for pagination) |
| `binWidth` | Bin width for binned dimensions. Unit follows the dimension's natural unit: years for `decade`/`provenanceDecade` (default 10), centimeters for `height`/`width` (default 10). `century` is hardcoded to 100-year buckets; `decadeModified` is hardcoded to 10-year buckets. |
| `sortBy` | Override the dimension's default ordering: `count` (desc) or `label` (asc). Echoed back as `ordering` in structured output. |

### Artwork filters
| Parameter | Description |
|---|---|
| `type` | Filter to artworks of this type |
| `material` | Filter by material |
| `technique` | Filter by technique |
| `creator` | Filter by creator (partial match) |
| `productionPlace` | Filter by production place (partial match). Areal places (continents/oceans/empires) are excluded from depictedPlace/productionPlace rollups. |
| `depictedPerson` | Filter by depicted person (partial match) |
| `depictedPlace` | Filter by depicted place (partial match) |
| `subject` | Filter by subject (partial match on Iconclass labels) |
| `iconclass` | Filter by exact Iconclass notation code (e.g. `73D82`) |
| `collectionSet` | Filter by curated set name (partial match) |
| `theme` | Filter by curatorial thematic tag (partial match) |
| `sourceType` | Filter by source-channel taxonomy (e.g. `designs`, `paintings`, `prints (visual works)`) |
| `imageAvailable` | Restrict to artworks with a digital image |
| `creationDateFrom` | Earliest creation year (inclusive) |
| `creationDateTo` | Latest creation year (inclusive) |

### Provenance filters
| Parameter | Description |
|---|---|
| `hasProvenance` | Restrict to artworks with provenance records (~48K of 834K) |
| `transferType` | [events] Filter to artworks with at least one provenance event of this transfer type |
| `provenanceLocation` | [events] Filter by provenance event location (partial match) |
| `party` | [parties] Filter to artworks involving this party/collector (partial match) |
| `provenanceDateFrom` | [events] Earliest provenance event year (inclusive) |
| `provenanceDateTo` | [events] Latest provenance event year (inclusive) |
| `categoryMethod` | [events] Filter by category method (e.g. `llm_enrichment`) |
| `positionMethod` | [parties] Filter by position method (e.g. `llm_enrichment`). When combined with `party`, both filters must hold on the same party row. |

> Demographic-filtered counts (e.g. female artists by century) go through [`search_persons`](#search_persons) first to resolve vocab IDs; pass the IDs as `creator` here.

---

## search_provenance

Search ownership and provenance history across ~48K artworks with parsed provenance records.

### Core filters
| Parameter | Description |
|---|---|
| `layer` | Data layer: `events` (default, raw parsed events) or `periods` (interpreted ownership periods with durations) |
| `objectNumber` | Full provenance chain for a specific artwork (fast local lookup) |
| `party` | Owner, collector, or dealer name (partial match, e.g. `Six`, `Rothschild`) |
| `creator` | Artist name (partial match, e.g. `Rembrandt`) |
| `transferType` | Type of ownership transfer (single value or array). Values: `collection`, `sale`, `by_descent`, `gift`, `transfer`, `loan`, `bequest`, `widowhood`, `recuperation`, `commission`, `deposit`, `restitution`, `confiscation`, `exchange`, `inventory`, `theft`, `looting`, `inheritance` |
| `excludeTransferType` | Exclude artworks that have any event of this type (artwork-level negation) |
| `location` | City or place name (partial match) |
| `dateFrom` | Earliest year (inclusive) |
| `dateTo` | Latest year (inclusive) |

### Event-layer filters
| Parameter | Description |
|---|---|
| `currency` | Price currency filter (exact match) |
| `hasPrice` | Only events with recorded prices |
| `hasGap` | Only artworks with provenance gaps |
| `relatedTo` | Reverse cross-reference: find artworks whose provenance references this object number |

### Period-layer filters
| Parameter | Description |
|---|---|
| `ownerName` | Owner name (partial match) |
| `acquisitionMethod` | Acquisition method (exact match) |
| `periodLocation` | Place name on the ownership-period record (45% populated). Preferred over `location` when scoping a periods-layer query — distinguishable from event-level location. AND-combined with `location` when both are supplied. |
| `minDuration` | Minimum ownership years |
| `maxDuration` | Maximum ownership years |

### Provenance-of-provenance filters
| Parameter | Description |
|---|---|
| `categoryMethod` | How transfer category was determined: `type_mapping`, `llm_enrichment`, `rule:transfer_is_ownership` |
| `positionMethod` | How party positions were determined: `role_mapping`, `type_mapping`, `llm_enrichment`, `llm_disambiguation` |

### Sorting and pagination
| Parameter | Description |
|---|---|
| `sortBy` | Sort by: `price`, `dateYear`, `eventCount`, `duration` (periods only) |
| `sortOrder` | `asc` or `desc` (default `desc`) |
| `offset` | Skip this many artworks |
| `maxResults` | 1–50 (default 1 — each artwork includes its full chain) |
| `facets` | Compute provenance facets: `transferType`, `decade`, `location`, `transferCategory`, `partyPosition` |

---

## get_artwork_details

| Parameter | Description |
|---|---|
| `objectNumber` | Object identifier, e.g. `SK-C-5` (provide this or `uri`, not both) |
| `uri` | Linked Art URI, e.g. `https://id.rijksmuseum.nl/200666460` (from `relatedObjects`) |

---

## get_artwork_image

| Parameter | Description |
|---|---|
| `objectNumber` | Object identifier, e.g. `SK-C-5` |

---

## inspect_artwork_image

Fetch an artwork image or region as base64 for direct visual analysis by the LLM.

| Parameter | Description |
|---|---|
| `objectNumber` | Object identifier, e.g. `SK-C-5` |
| `region` | IIIF region: `full` (default), `square`, `pct:x,y,w,h` (percentage), `crop_pixels:x,y,w,h` (pixels of the full image; use with `nativeWidth`/`nativeHeight` from a prior response), or `x,y,w,h` (legacy IIIF pixels) |
| `size` | Width of returned image in pixels (200–2016, default 1568). Defaults align to multiples of 28 for clean LLM coordinate handling (1568 = Sonnet 4.6's native cap; 2016 = max for Opus 4.7 per-image token budget). |
| `rotation` | Clockwise rotation: `0`, `90`, `180`, or `270` |
| `quality` | `default` or `gray` (can help read inscriptions) |
| `navigateViewer` | Auto-navigate open viewer to inspected region (default `true`) |
| `show_overlays` | Composite active-viewer overlays onto the returned crop (default `false`; response width is clamped to 448 px when enabled) |
| `viewUUID` | Target a specific viewer session (auto-discovered when omitted) |

---

## navigate_viewer

Navigate the artwork viewer to a specific region and/or add visual overlays.

| Parameter | Description |
|---|---|
| `viewUUID` | Viewer UUID from a prior `get_artwork_image` call |
| `commands` | Array of commands (executed in order), each with: |
| ↳ `action` | `navigate`, `add_overlay`, or `clear_overlays` |
| ↳ `region` | IIIF region (required for `navigate`/`add_overlay`) |
| ↳ `relativeTo` | Crop region from a prior `inspect_artwork_image` — coordinates in `region` are projected from crop-local to full-image space |
| ↳ `label` | Label text (for `add_overlay`) |
| ↳ `color` | CSS color for overlay border (default: orange) |

---

## find_similar

Find artworks similar to a given artwork across multiple signals (feature-gated via `ENABLE_FIND_SIMILAR`). Returns a URL/path to an HTML comparison page.

| Parameter | Description |
|---|---|
| `objectNumber` | Object number of the artwork to find similar works for |
| `maxResults` | Results per signal mode (1–50, default 20) |

---

## list_curated_sets

Discover curated collection sets (193 total). Results carry `memberCount`, top `dominantTypes`, top `dominantCenturies`, and a `category` heuristic (`object_type` / `iconographic` / `album` / `sub_collection` / `umbrella`).

| Parameter | Description |
|---|---|
| `query` | Filter sets by name (case-insensitive substring match) |
| `sortBy` | `name` (alphabetical, default), `size` (smallest first), `size_desc` (largest first) |
| `minMembers` | Filter to sets with at least this many members |
| `maxMembers` | Filter to sets with at most this many members. Use ~100,000 to exclude umbrella sets like "Alle gepubliceerde objecten" (834K) and "Entire Public Domain Set" (732K). |
| `includeStats` | Include `memberCount`/`dominantTypes`/`dominantCenturies`/`category` (default `true`). Set `false` for the lightweight legacy shape. |

---

## browse_set

| Parameter | Description |
|---|---|
| `setSpec` | Set identifier from `list_curated_sets` |
| `maxResults` | 1–50 (default 10) |
| `resumptionToken` | Pagination token from a previous result (overrides `setSpec`) |

---

## get_recent_changes

| Parameter | Description |
|---|---|
| `from` | Start date in ISO 8601 format, e.g. `2026-02-01` |
| `until` | End date in ISO 8601 format (defaults to now) |
| `setSpec` | Restrict to changes within a specific set |
| `maxResults` | 1–50 (default 10) |
| `identifiersOnly` | `true` returns headers only — much faster |
| `resumptionToken` | Pagination token from a previous result |
