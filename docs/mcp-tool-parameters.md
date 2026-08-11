# Rijksmuseum MCP — Tool Parameters Reference

Every tool's `inputSchema` is **strict**: an unrecognised parameter is rejected outright (`-32602`), not silently ignored. Spelling and case matter, and so does using a documented enum member rather than a near-miss.

Parameters marked **required** must be supplied; everything else is optional. The two app-only viewer helpers (`remount_viewer`, `poll_viewer_commands`) are hidden from agents and omitted here.

---

## search_artwork

The primary search tool. Filters combine freely, with one exception: proximity search (`nearPlace` / `nearLat`+`nearLon`) **overrides** `depictedPlace` and `productionPlace` — if either is also set it is dropped and a warning is returned. At least one substantive filter is required; see [Filters that cannot stand alone](#filters-that-cannot-stand-alone). See [search-parameters.md](search-parameters.md) for the full reference with examples, coverage numbers, and ranking rules.

### Core filters
| Parameter | Description |
|---|---|
| `query` | General title search |
| `objectNumber` | Exact object identifier (`SK-C-5`), or a wildcard pattern using `*` (any run) and `?` (single character), e.g. `RP-P-1991-*`. Case-sensitive; wildcard patterns need at least two literal characters. |
| `creator` | Artist name, e.g. `Rembrandt van Rijn` |
| `type` | Object type: `painting`, `print`, `drawing`, etc. |
| `material` | e.g. `canvas`, `paper`, `wood` |
| `technique` | e.g. `oil painting`, `etching` |
| `creationDate` | Exact year (`1642`) or wildcard (`16*`, `164*`) |
| `dateMatch` | How `creationDate` matches artwork date ranges: `overlaps` (default), `within`, or `midpoint`. Modifier — cannot be the only filter. |

### Vocabulary-based filters
| Parameter | Description |
|---|---|
| `subject` | Primary concept/theme search — searches the whole collection via Iconclass vocabulary. Start here for thematic queries |
| `iconclass` | Exact Iconclass notation code (e.g. `34B11` for dogs). More precise than `subject` |
| `description` | Full-text search on cataloguer descriptions (Dutch, roughly 60% coverage) |
| `curatorialNarrative` | Full-text search on museum wall text (English, a small curated subset) |
| `inscription` | Full-text search on inscription texts (signatures, mottoes, dates on objects) |
| `textQuery` | Advanced structured boolean/phrase/proximity/prefix search over the four text fields. Opt-in object `{ must?, should?, mustNot? }`; use only when the flat text filters can't express the query (cross-field OR, NOT, NEAR, word-stem prefix). See [search-parameters.md](search-parameters.md#structured-text-query-textquery). |
| `depictedPerson` | Artworks depicting a named person |
| `depictedPlace` | Artworks depicting a named place |
| `productionPlace` | Place where the work was made |
| `productionRole` | e.g. `painter`, `printmaker`, `attributed to` |
| `theme` | Curatorial thematic tag (e.g. `overzeese geschiedenis`, `costume`). Distinct from `subject`/Iconclass. ~7% coverage, mostly Dutch labels. |
| `sourceType` | Source-channel classification (6 values: `designs`, `drawings`, `paintings`, `prints (visual works)`, `sculpture (visual works)`, `photographs`). Distinct from `type`. |
| `collectionSet` | Named curated collection set (use `list_curated_sets` to discover) |

### Dimension filters
| Parameter | Description |
|---|---|
| `heightRange` | Height range in cm. Forms: `10-50`, `10-` (≥ 10), `-50` (≤ 50). Inclusive bounds; 0.0 sentinels excluded from upper-bound matches. |
| `widthRange` | Width range in cm. Same form as `heightRange` (`10-50`, `10-`, `-50`). |

### Attribution filter
| Parameter | Description |
|---|---|
| `attributionQualifier` | Filter by attribution qualifier (13 values, ordered by frequency): `primary`, `undetermined`, `after`, `secondary`, `possibly`, `attributed to`, `circle of`, `workshop of`, `copyist of`, `manner of`, `follower of`, `falsification`, `free-form`. Combine with `creator` to narrow attribution. |

> Demographic person filters (gender, birth/death year, birth/death place, profession) live on the [`search_persons`](#search_persons) tool — feed the returned vocab IDs into `creator` here.

### Place and proximity filters
| Parameter | Description |
|---|---|
| `expandPlaceHierarchy` | When `true`, place searches (`productionPlace`, `depictedPlace`) expand to include sub-places. E.g. `productionPlace: 'Netherlands'` includes Amsterdam, Delft, etc. (up to 3 levels) |
| `nearPlace` | Proximity search by place name. Overrides `depictedPlace`/`productionPlace`. Matches depicted places and the spatial field, so it reaches most but not all production places. Only the authority-geocoded subset of places carries coordinates. |
| `nearLat` / `nearLon` | Proximity search by explicit coordinates (`nearLat` -90..90, `nearLon` -180..180). Always available, unlike `nearPlace`. Supply both. |
| `nearPlaceRadius` | Radius in km for proximity search (0.1-500, default 25). Modifier — cannot be the only filter. |

### Other filters
| Parameter | Description |
|---|---|
| `aboutActor` | Artworks about a person — broader recall than `depictedPerson`, searches both subject and creator vocabulary |
| `imageAvailable` | `true` = only works with a digital image; `false` = only those without one |
| `hasProvenance` | `true` to return only works with parsed provenance records (roughly 48K) |
| `sameRowMatching` | Constrain `creator` + `productionRole` to the *same* production row (autograph detection). For "making" roles only — leave default off for "after X by" relational roles. Requires both `creator` and `productionRole`. |

### Output controls
| Parameter | Description |
|---|---|
| `maxResults` | 1–50 (default 25) |
| `offset` | Skip this many results (for pagination) |
| `compact` | `true` returns IDs only without full metadata (faster) |
| `facets` | `true` for all facet dimensions, or an array of specific dimensions to compute. Available: `type`, `material`, `technique`, `century`, `rights`, `imageAvailable`, `creator`, `depictedPerson`, `depictedPlace`, `productionPlace`, `theme`, `sourceType` |
| `facetLimit` | Maximum entries per facet dimension (1–50, default 5) |
| `groupBy` | Set to `parent` to collapse component records (sketchbook folios, album leaves, print-series sheets) under their parent. Parent gains `groupedChildCount`. |
| `sort` | Order results by a column with optional direction: `height`, `height:desc`, `dateEarliest:asc`, `recordModified:desc`, etc. Columns: `height`, `width`, `dateEarliest`, `dateLatest`, `recordModified`. Direction defaults to `desc`; NULLs always sort last. Overrides BM25/geo ordering when set; tie-broken by `art_id`. |

### Filters that cannot stand alone

`search_artwork` refuses a call that carries no substantive filter, with the error *"At least one search filter is required"*. These parameters qualify or shape an existing filter and do **not** satisfy that requirement on their own:

`imageAvailable` · `hasProvenance` · `expandPlaceHierarchy` · `sameRowMatching` · `compact` · `dateMatch` · `nearPlaceRadius` · `sort` · `maxResults` · `offset` · `facets` · `facetLimit` · `groupBy`

So `{ imageAvailable: true }` is an error, while `{ type: "painting", imageAvailable: true }` is fine.

`search_provenance` enforces the same rule against its own filter set — `layer`, `sortBy`, `sortOrder`, `maxResults` and `offset` do not count. `search_inscriptions` likewise requires at least one narrowing filter.

---

## search_persons

Search the person and group authority records by name (variant-aware, several hundred thousand variants), demographic (gender, birth/death year) or structural (birth/death place, profession) criteria. Returns vocab IDs to feed into `search_artwork({creator: <vocabId>})` for works *by* them, or `search_artwork({aboutActor: <name>})` for works *depicting* them. Each result also carries `nameVariants[]` (deduplicated alternate/inverted name forms) and `equivalents[]` (external authority crosswalks — VIAF, ULAN, RKD, Wikidata — each a `{ authority, id, uri }` triple); both are omitted when empty.

| Parameter | Description |
|---|---|
| `name` | Phrase or token match against the full name-variant table. Tries exact phrase first, then token AND with stop-word stripping. |
| `gender` | Categorical: `female`, `male`, or other normalised values. Returns 0 rows if person enrichment is absent on the DB. |
| `bornAfter` | Birth year ≥ this value (integer). Birth year only — there is no death-year filter. |
| `bornBefore` | Birth year ≤ this value (integer) |
| `birthPlace` | Place name (string or array, AND-combined). Resolved by pivot through creator-mapped artworks. |
| `deathPlace` | Place name (string or array, AND-combined) |
| `profession` | Profession (e.g. `painter`, `engraver`; string or array, AND-combined) |
| `hasArtworks` | Restrict to persons appearing as creator on ≥1 artwork. Default `true`. |
| `unused` | Return only persons with no Linked Open Data link at all (neither maker nor subject). Overrides `hasArtworks`. |
| `maxResults` | 1–100 (default 25) |
| `offset` | Skip this many results (for pagination) |

---

## semantic_search

Natural language / concept-based search. Best for atmospheric, thematic, or art-historical queries.

| Parameter | Description |
|---|---|
| `query` | **Required.** Natural language concept, e.g. `vanitas symbolism`, `artist gazing at the viewer` |
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

Filters are applied *before* semantic ranking. A single very broad filter (`type: 'print'`, `material: 'paper'`) can push the candidate set past the internal exact-ranking limit; ranking then falls back to an approximate pass over a near-optimal subset and a warning is returned. Pair a broad filter with a narrower one for exact ranking.

---

## collection_stats

Aggregate statistics, counts, and distributions across the collection. Returns text tables plus a structured payload (denominator/grouping/coverage semantics disclosed in the output schema). Artwork filters and provenance filters combine freely; event-level provenance filters compose on the same event row, party-level filters on the same party row.

### Core
| Parameter | Description |
|---|---|
| `dimension` | **Required.** What to count/group by — a closed enum of 34 values, so a near-miss name is rejected outright. **Artwork:** `type`, `material`, `technique`, `creator`, `productionRole`, `depictedPerson`, `depictedPlace`, `productionPlace`, `placeType`, `sourceType`, `century`, `decade`, `height`, `width`, `theme`, `exhibition`, `decadeModified` (record_modified bucketed by decade, clamped 1990–2030). **Creator demographics:** `profession`, `birthPlace`, `deathPlace`, `gender`, `creatorBirthDecade`, `creatorBirthCentury`. **Provenance:** `transferType`, `transferCategory`, `provenanceDecade`, `provenanceLocation`, `party`, `partyRole`, `partyPosition`, `currency`, `categoryMethod`, `positionMethod`, `parseMethod`. |
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
| `attributionQualifier` | Filter by attribution qualifier (`primary`, `attributed to`, `workshop of`, `circle of`, etc. — 13 values). Combined with `creator`, same-row matching is enforced automatically. |
| `productionRole` | Filter by production role (e.g. `painter`, `draughtsman`, `print maker`, `after painting by`). Combine with `creator` + `sameRowMatching=true` for autograph narrowing. |
| `sameRowMatching` | Constrain `creator` + `productionRole` to the *same* production row (autograph detection). Required for accurate autograph counts on making roles; leave default-false for "after X by" relational roles. |
| `imageAvailable` | Restrict to artworks with a digital image |
| `creationDateFrom` | Earliest creation year (inclusive) |
| `creationDateTo` | Latest creation year (inclusive) |

### Creator demographic filters

These work directly here — no `search_persons` round-trip is needed to count by gender or profession.

| Parameter | Description |
|---|---|
| `gender` | Filter to artworks whose creator has this gender (e.g. `female`) |
| `profession` | Filter by creator profession (e.g. `painter`, `engraver`) |
| `birthPlace` | Filter by creator birth place (partial match) |
| `deathPlace` | Filter by creator death place (partial match) |
| `placeType` | Filter by place-type classification (e.g. `city`, `country`) |

### Presence filters

Booleans that restrict the denominator to artworks carrying (or lacking) a given kind of record.

| Parameter | Description |
|---|---|
| `hasInscription` | Artworks with a non-empty inscription field |
| `hasNarrative` | Artworks with English curatorial wall text |
| `hasDimensions` | Artworks with recorded physical dimensions |
| `hasExhibitions` | Artworks with exhibition history |
| `hasExaminations` | Artworks with technical examination records |
| `hasModifications` | Artworks with recorded conservation/restoration modifications |
| `hasExternalIds` | Artworks with external authority identifiers |
| `hasAltNames` | Artworks whose creator carries alternate name forms |
| `hasParent` | Component records that belong to a parent object |
| `hasWikidataCreator` | Artworks whose creator has a Wikidata identifier |
| `exhibition` | Filter by exhibition name (partial match) |

### Provenance filters
| Parameter | Description |
|---|---|
| `hasProvenance` | Restrict to artworks with provenance records (roughly 48K) |
| `transferType` | [events] Filter to artworks with at least one provenance event of this transfer type |
| `provenanceLocation` | [events] Filter by provenance event location (partial match) |
| `party` | [parties] Filter to artworks involving this party/collector (partial match) |
| `provenanceDateFrom` | [events] Earliest provenance event year (inclusive) |
| `provenanceDateTo` | [events] Latest provenance event year (inclusive) |
| `categoryMethod` | [events] Filter by category method (e.g. `llm_enrichment`) |
| `positionMethod` | [parties] Filter by position method (e.g. `llm_enrichment`). When combined with `party`, both filters must hold on the same party row. |
| `partyRole` | [parties] Filter by the role a party played in the transfer |
| `parseMethod` | [events] Filter by how the event was parsed (e.g. `peg`, `regex`, `llm_enrichment`) |
| `unsold` | [events] Restrict to events flagged as unsold lots |
| `uncertain` | [events] Restrict to events flagged uncertain |
| `gap` | [events] Restrict to events marking a provenance gap |
| `crossRef` | [events] Restrict to events that cross-reference another object |

---

## search_provenance

Search ownership and provenance history across the roughly 48K artworks with parsed provenance records.

### Core filters
| Parameter | Description |
|---|---|
| `layer` | Data layer: `events` (default, raw parsed events) or `periods` (interpreted ownership periods with durations) |
| `objectNumber` | Full provenance chain for a specific artwork (fast local lookup) |
| `party` | Owner, collector, or dealer name (partial match, e.g. `Six`, `Rothschild`) |
| `creator` | Artist name (partial match, e.g. `Rembrandt`) |
| `location` | City or place name (partial match) |
| `dateFrom` | Earliest year (inclusive) |
| `dateTo` | Latest year (inclusive) |
| `creditLineQuery` | FALLBACK — standalone free-text search over the unstructured credit-line field of artworks *lacking* parsed provenance. Ignores all other filters; returns matches in `creditLineResults` (not `results`). Use as a second step when structured search finds no parsed provenance. |

### Event-layer filters

These are rejected with an error when combined with `layer: 'periods'`.

| Parameter | Description |
|---|---|
| `transferType` | Type of ownership transfer (single value or array). Closed enum, 19 values: `collection`, `sale`, `by_descent`, `gift`, `transfer`, `loan`, `bequest`, `widowhood`, `recuperation`, `commission`, `deposit`, `restitution`, `confiscation`, `exchange`, `inventory`, `theft`, `looting`, `inheritance`, `unknown` |
| `excludeTransferType` | Exclude artworks that have any event of this type (artwork-level negation). Same 19 values. |
| `currency` | Price currency. Closed enum, 15 values: `guilders`, `euros`, `pounds`, `francs`, `dollars`, `livres`, `napoleons`, `deutschmarks`, `reichsmarks`, `swiss_francs`, `guineas`, `belgian_francs`, `yen`, `marks`, `louis_d_or`. Currency codes such as `NLG` or `fl` are rejected. |
| `hasPrice` | Only events with recorded prices |
| `hasGap` | Only artworks with provenance gaps |
| `relatedTo` | Reverse cross-reference: find artworks whose provenance references this object number |
| `categoryMethod` | How transfer category was determined: `type_mapping`, `llm_enrichment`, `rule:transfer_is_ownership` |

### Period-layer filters
| Parameter | Description |
|---|---|
| `ownerName` | Owner name (partial match) |
| `acquisitionMethod` | Acquisition method. Same closed 19-value enum as `transferType`. |
| `periodLocation` | Place name on the ownership-period record (45% populated). Preferred over `location` when scoping a periods-layer query — distinguishable from event-level location. AND-combined with `location` when both are supplied. |
| `minDuration` | Minimum ownership years |
| `maxDuration` | Maximum ownership years |

### Party-layer filters

Also event-only — rejected with `layer: 'periods'`.

| Parameter | Description |
|---|---|
| `positionMethod` | How party positions were determined: `role_mapping`, `type_mapping`, `llm_enrichment`, `llm_disambiguation` |

### Sorting and pagination
| Parameter | Description |
|---|---|
| `sortBy` | Sort by: `price`, `dateYear`, `eventCount`, `duration` (periods only) |
| `sortOrder` | `asc` or `desc` (default `desc`) |
| `offset` | Skip this many artworks |
| `maxResults` | 1–50. Default **1** in full mode, **12** when `compact: true` — each full-mode artwork includes its entire chain. |
| `compact` | `true` omits the per-artwork event/period arrays, returning a summary rollup plus one-line matched events. Also raises the default `maxResults` to 12. The server may apply this automatically on a large response and set `autoCompacted` in the output. |
| `facets` | **Boolean**, not a list. `true` computes all five provenance facets (transfer type, decade, location, transfer category, party position). Passing an array is rejected. |

---

## search_inscriptions

Structured search over artwork inscriptions — collector's marks, signatures, dates, transcribed text. Catalogue-entered data (not OCR), dominated by verso collector's-mark stamps. Runtime parse with no derived index: at least one narrowing filter is required, and a single broad facet may trip the candidate cap and return partial results (`candidatesCapped: true`).

| Parameter | Description |
|---|---|
| `text` | Blunt full-text match over the entire inscription blob (all segments, marks included). Use `transcribedText` for on-object text only. |
| `transcribedText` | Find works whose transcribed (quoted) text contains this string — signatures, captions, dates actually written on the work. Substring, case-insensitive. |
| `inscriptionType` | Normalized type (string or array, OR-combined). Documented values: `collector's mark`, `signature`, `signature and date`, `inscription`, `annotation`, `number`, `date`, `title`, `name`, `monogram`, `watermark`, `stamp`, `maker's mark`, `seal`, `circumscription`. Open set — other values match the raw catalogued token. |
| `placement` | Surface placement: `recto` or `verso` (string or array). ~⅔ of inscriptions are on the verso. |
| `technique` | Normalized technique (string or array, OR-combined). Documented values: `stamped`, `handwritten`, `printed`, `engraved`, `etched`, `pencil`, `pen`, `chalk`, `embossed`, `struck`, `typed`. |
| `collectorMark` | Lugt collector-mark reference — `Lugt 240`, `Lugt 2228`, or just the number `240`. |
| `hasTranscribedText` | `true` = only works with ≥1 transcribed string; `false` = only works without. |
| `excludeCollectorMarkOnly` | `true` drops works whose inscriptions are pure collector-mark boilerplate (marks but no transcribed text). |
| `isPlaceholder` | Filter on type-label-only placeholder rows (e.g. `datum \| date` with no value). `true` = only placeholders; `false` = exclude them. |
| `offset` | Skip this many confirmed artworks (pagination) |
| `maxResults` | 1–100 (default 20) |

---

## get_artwork_details

| Parameter | Description |
|---|---|
| `objectNumber` | Object identifier, e.g. `SK-C-5`. Supply **exactly one** of `objectNumber` or `uri` - omitting both, or passing both, is an error. |
| `uri` | Linked Art URI, e.g. `https://id.rijksmuseum.nl/200666460` (from `relatedObjects`, or the record's own `id`). Must be a well-formed URL; a bare id is rejected. |
| `verboseExtent` | `true` adds the free-text `extentText` dimension string. **Default false**, so `extentText` is `null` on an ordinary call even though nearly every artwork has one. |

---

## get_artwork_bibliography

Scholarly references for one artwork by object number — citations with the linked publication, pages, and ISBN where known. Returns the first 5 entries plus a `total` count by default; `full: true` returns all (major works can carry 100+).

| Parameter | Description |
|---|---|
| `objectNumber` | **Required.** Object identifier, e.g. `SK-C-5` |
| `full` | `true` returns ALL entries (may be 100+); default returns the first 5 + a `total` count |

---

## find_artworks_citing_publication

Reverse bibliography — artworks whose references cite a given publication. Local and resolver-free. Pass the `publicationUri` from a `get_artwork_bibliography` entry (e.g. `https://id.rijksmuseum.nl/301154354`) or the bare numeric id.

| Parameter | Description |
|---|---|
| `publication` | **Required.** Publication URI (`https://id.rijksmuseum.nl/301…`) or the bare publication id |
| `full` | `true` returns ALL citing artworks; default returns the first 20 + a `total` count |

---

## get_conservation_history

Conservation / forensics record for one artwork by object number — technical examinations (X-ray, dendrochronology, infrared, paint samples), restoration and conservation treatments, a count of recorded signature/inscription marks, and a short provenance excerpt. Not for general metadata (use [`get_artwork_details`](#get_artwork_details)); not for transcribed inscriptions (use [`search_inscriptions`](#search_inscriptions)).

| Parameter | Description |
|---|---|
| `objectNumber` | **Required.** Object identifier, e.g. `SK-C-5` |

---

## get_artwork_image

| Parameter | Description |
|---|---|
| `objectNumber` | **Required.** Object identifier, e.g. `SK-C-5` |

---

## inspect_artwork_image

Fetch an artwork image or region as base64 for direct visual analysis by the LLM.

| Parameter | Description |
|---|---|
| `objectNumber` | **Required.** Object identifier, e.g. `SK-C-5` |
| `region` | IIIF region: `full` (default), `square`, `pct:x,y,w,h` (percentage), `crop_pixels:x,y,w,h` (pixels of the full image; use with `nativeWidth`/`nativeHeight` from a prior response), or `x,y,w,h` (legacy IIIF pixels) |
| `size` | Width of returned image in pixels (200–2016, default 1568). Defaults align to multiples of 28 for clean LLM coordinate handling (1568 = Sonnet 4.6's native cap; 2016 = max for Opus 4.7 per-image token budget). |
| `rotation` | Clockwise rotation: `0`, `90`, `180`, or `270` |
| `quality` | `default` or `gray` (can help read inscriptions) |
| `navigateViewer` | Auto-navigate open viewer to inspected region (default `true`) |
| `viewUUID` | Target a specific viewer session (auto-discovered when omitted) |

---

## navigate_viewer

Zoom/pan an already-open artwork viewer to a specific region.

| Parameter | Description |
|---|---|
| `viewUUID` | **Required.** Viewer UUID from a prior `get_artwork_image` call |
| `commands` | **Required.** Array of commands, at least one, executed in order. Keep a batch to roughly ten or fewer. Each has: |
| ↳ `action` | `navigate` (zoom/pan to `region`) |
| ↳ `region` | IIIF region (required) |
| ↳ `relativeTo` | Crop region from a prior `inspect_artwork_image` — coordinates in `region` are projected from crop-local to full-image space |
| ↳ `relativeToSize` | `{ width, height }` — actual pixel dimensions of the inspected crop (copy from `cropPixelWidth`/`cropPixelHeight`). Required when `relativeTo` is set and `region` uses `crop_pixels:`. |

---

## find_similar

Find artworks similar to a given artwork across nine independent signals plus a Pooled consensus column. Returns the full per-signal rankings as structured output *and* a `pageUrl` to a rendered HTML comparison page. Feature-gated via `ENABLE_FIND_SIMILAR`; the Theme channel is separately gated via `ENABLE_THEME_SIMILAR`, so it can be absent while the others work.

| Parameter | Description |
|---|---|
| `objectNumber` | **Required.** Object number of the artwork to find similar works for |
| `maxResults` | Results per signal mode (1–50, default 20) |

---

## list_curated_sets

Discover curated collection sets — a couple of hundred in the current harvest. Results carry `memberCount`, top `dominantTypes`, top `dominantCenturies`, and a `category` heuristic (`object_type` / `iconographic` / `album` / `sub_collection` / `umbrella`).

| Parameter | Description |
|---|---|
| `query` | Filter sets by name (case-insensitive substring match) |
| `sortBy` | `name` (alphabetical, default), `size` (smallest first), `size_desc` (largest first) |
| `minMembers` | Filter to sets with at least this many members |
| `maxMembers` | Filter to sets with at most this many members. Use ~100,000 to exclude the umbrella sets that contain most of the collection ("Alle gepubliceerde objecten", "Entire Public Domain Set"). |
| `includeStats` | Include `memberCount`/`dominantTypes`/`dominantCenturies`/`category` (default `true`). Set `false` for the lightweight legacy shape. |

---

## browse_set

| Parameter | Description |
|---|---|
| `setSpec` | Set identifier from `list_curated_sets` |
| `maxResults` | 1–50 (default 10) |
| `resumptionToken` | Pagination token from a previous result (overrides `setSpec`) |
| `includeExtentText` | Include the verbose `extentText` (`dcterms:extent`) per record. Default `false` — it is large and not rendered in the text channel. |

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
