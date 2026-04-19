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
| `provenance` | Full-text search on provenance/ownership history |
| `creditLine` | Full-text search on credit/donor lines |
| `depictedPerson` | Artworks depicting a named person |
| `depictedPlace` | Artworks depicting a named place |
| `productionPlace` | Place where the work was made |
| `birthPlace` | Artist's birth place |
| `deathPlace` | Artist's death place |
| `profession` | Artist's profession: `painter`, `draughtsman`, `sculptor`, etc. |
| `productionRole` | e.g. `painter`, `printmaker`, `attributed to` |
| `collectionSet` | Named curated collection set (use `list_curated_sets` to discover) |
| `license` | Rights filter: `publicdomain`, `zero` (CC0), `by` (CC BY) |

### Dimension filters
| Parameter | Description |
|---|---|
| `minWidth` | Minimum width in cm |
| `maxWidth` | Maximum width in cm |
| `minHeight` | Minimum height in cm |
| `maxHeight` | Maximum height in cm |

### Creator demographic filters
| Parameter | Description |
|---|---|
| `creatorGender` | Filter by creator gender: `male` or `female` (~64K of ~76K person entries have gender data) |
| `creatorBornAfter` | Filter to creators born in or after this year, e.g. `1800` (~49K person entries have birth year data) |
| `creatorBornBefore` | Filter to creators born in or before this year, e.g. `1700`. Combine with `creatorBornAfter` for a range |
| `attributionQualifier` | Filter by attribution qualifier: `primary`, `attributed to`, `workshop of`, `circle of`, `follower of`, `secondary`, `undetermined` |

### Place and proximity filters
| Parameter | Description |
|---|---|
| `expandPlaceHierarchy` | When `true`, place searches (`productionPlace`, `depictedPlace`, `birthPlace`, `deathPlace`) expand to include sub-places. E.g. `productionPlace: 'Netherlands'` includes Amsterdam, Delft, etc. (up to 3 levels) |
| `nearPlace` | Proximity search by place name |
| `nearLat` / `nearLon` | Proximity search by coordinates |
| `nearPlaceRadius` | Radius in km for proximity search (default 25) |

### Other filters
| Parameter | Description |
|---|---|
| `aboutActor` | Artworks about a person — broader recall than `depictedPerson`, searches both subject and creator vocabulary |
| `imageAvailable` | `true` to return only works with a digital image |
| `hasProvenance` | `true` to return only works with parsed provenance records (~48.5K of 833K) |
| `maxResults` | 1–50 (default 25) |
| `offset` | Skip this many results (for pagination) |
| `compact` | `true` returns IDs only without full metadata (faster) |
| `facets` | `true` for all facet dimensions, or an array of specific dimensions to compute |
| `facetLimit` | Maximum entries per facet dimension (1–50, default 5) |

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

Aggregate statistics, counts, and distributions across the collection. Returns formatted text tables.

| Parameter | Description |
|---|---|
| `dimension` | What to count/group by. Artwork: `type`, `material`, `technique`, `creator`, `depictedPerson`, `depictedPlace`, `productionPlace`, `century`, `decade`, `height`, `width`. Provenance: `transferType`, `transferCategory`, `provenanceDecade`, `provenanceLocation`, `party`, `partyPosition`, `currency`, `categoryMethod`, `positionMethod`, `parseMethod` |
| `topN` | Maximum entries to return (1–500, default 25) |
| `offset` | Skip this many entries (for pagination) |
| `binWidth` | Bin width for decade dimensions (default 10; use 50 or 100 for half-centuries or centuries) |
| `type` | Filter to artworks of this type |
| `material` | Filter by material |
| `technique` | Filter by technique |
| `creator` | Filter by creator (partial match) |
| `productionPlace` | Filter by production place (partial match) |
| `depictedPerson` | Filter by depicted person (partial match) |
| `depictedPlace` | Filter by depicted place (partial match) |
| `subject` | Filter by subject (partial match on Iconclass labels) |
| `iconclass` | Filter by exact Iconclass notation code (e.g. `73D82`) |
| `collectionSet` | Filter by curated set name (partial match) |
| `creatorGender` | Filter by creator gender: `male` or `female` |
| `creatorBornAfter` | Filter to creators born in or after this year |
| `creatorBornBefore` | Filter to creators born in or before this year |
| `imageAvailable` | Restrict to artworks with a digital image |
| `creationDateFrom` | Earliest creation year |
| `creationDateTo` | Latest creation year |
| `hasProvenance` | Restrict to artworks with provenance records |
| `transferType` | Filter by provenance transfer type |
| `location` | Filter by provenance location (partial match) |
| `party` | Filter by party/collector (partial match) |
| `dateFrom` | Earliest provenance event year |
| `dateTo` | Latest provenance event year |
| `categoryMethod` | Filter by category method |
| `positionMethod` | Filter by position method |

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
| `region` | IIIF region: `full` (default), `square`, `pct:x,y,w,h` (percentage), or `x,y,w,h` (pixels) |
| `size` | Width of returned image in pixels (200–2000, default 1200) |
| `rotation` | Clockwise rotation: `0`, `90`, `180`, or `270` |
| `quality` | `default` or `gray` (can help read inscriptions) |
| `navigateViewer` | Auto-navigate open viewer to inspected region (default `true`) |
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

| Parameter | Description |
|---|---|
| `query` | Filter sets by name (case-insensitive substring match) |

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
