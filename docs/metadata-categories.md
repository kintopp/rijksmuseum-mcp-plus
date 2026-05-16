# Artwork Metadata Categories

The `get_artwork_details` tool returns ~34 metadata fields for each artwork, grouped here into categories. All data is served from the local vocabulary database (built from periodic harvests of the Rijksmuseum's Linked Art, OAI-PMH, and Schema.org dump APIs). Categories include artwork identification, creation details with biographical data, physical characteristics, provenance with parsed ownership chains, iconographic subjects, curatorial context (themes, exhibitions, attribution evidence), hierarchical relations (parents/children for sketchbooks, albums, series), and rights information.

Nearly all categories have corresponding search parameters in `search_artwork` — see the [full search parameter reference](search-parameters.md) for filters grouped by type, or the [tool parameters reference](mcp-tool-parameters.md) for all tools.

---

## Identification

| # | Category | Field | Description |
|---|----------|-------|-------------|
| 1 | **Title variants** | `titles` | Array of title variants tagged by language (`en` / `nl` / `other`) and qualifier (`brief` / `full` / `display` / `former` / `other`). The primary display title is also flattened into the top-level `title` field. |
| 2 | **Object number** | `objectNumber` | The museum's inventory number (e.g. `SK-C-5` for The Night Watch). This is the primary identifier used across all tools. |
| 3 | **Persistent identifier** | `persistentId` | Stable handle.net URI for long-term citation (e.g. `http://hdl.handle.net/10934/RM0001.COLLECT.5216`). |
| 4 | **External identifiers** | `externalIds` | `{ handle, other }`. The `handle` is the persistent `hdl.handle.net` URI for the artwork; `other` is an array of non-handle external IDs (rare — a handful of rows DB-wide). For vocab-term cross-authority IDs (AAT, TGN, Wikidata, GeoNames, ULAN, VIAF, RKD, Iconclass) see the `vocabulary_external_ids` table — not exposed per artwork. |

## Creation

| # | Category | Field | Description |
|---|----------|-------|-------------|
| 5 | **Creator** | `creator` | Creator name or attribution statement in English (e.g. "Rembrandt van Rijn"). Falls back to Dutch if no English version exists. |
| 6 | **Date** | `date` | ISO-shaped creation date string (e.g. "1642"). Prefers English date labels; falls back to Dutch or raw year. |
| 7 | **Display date** | `dateDisplay` | Free-text Rijksmuseum-formatted date (e.g. "1642", "c. 1665–1667"). Use this for prose; use `date` for ISO-shaped output. |
| 8 | **Production details** | `production` | Structured list of all production participants. Each entry includes: `name` (English label from vocabulary), `role` (e.g. "painter", "printmaker"), `attributionQualifier` (e.g. "attributed to", "workshop of", or null for primary), `place` (e.g. "Amsterdam"), `actorUri` (vocabulary identifier), and an optional `personInfo` sub-object with biographical data: `birthYear`, `deathYear` (integers), `gender` (`"male"`, `"female"`, or null), and `wikidataId` (e.g. `"Q5598"`). Person info is available for creators whose records could be matched to the Rijksmuseum's actor authority files (~49K with life dates, ~15.5K with Wikidata IDs). Production participants are matched positionally (first creator gets first role/qualifier), which covers 95%+ of artworks. |

## Description

| # | Category | Field | Description |
|---|----------|-------|-------------|
| 9 | **Description** | `description` | General descriptive statement about the artwork (cataloguer-written, predominantly Dutch). |
| 10 | **Curatorial narrative** | `curatorialNarrative` | `{ en, nl }` object holding the museum wall text. Currently only the English version (`.en`) is populated by the harvest; `.nl` is always null. Distinct from the general description above. |

## Physical Characteristics

| # | Category | Field | Description |
|---|----------|-------|-------------|
| 11 | **Object types** | `objectTypes` | What the object is (e.g. "painting", "print", "drawing"). Each entry includes an English `label` and the vocabulary `id`. |
| 12 | **Materials** | `materials` | What the object is made of (e.g. "oil paint", "canvas"). Same format as object types. |
| 13 | **Technique statement** | `techniqueStatement` | Comma-separated list of technique labels from the vocabulary database (e.g. "oil paint (paint), canvas"). |
| 14 | **Dimension statement** | `dimensionStatement` | Human-readable dimensions text reconstructed from stored numeric values (e.g. "h 363 cm × w 437 cm"). |
| 15 | **Structured dimensions** | `dimensions` | Numeric dimension values with `type` (`height`, `width`, `depth`, `weight`, `diameter`), `value`, `unit` ("cm"), and `note`. Height and width are populated for nearly all artworks; depth/weight/diameter are sparse and mostly present for sculptures and three-dimensional objects. |
| 16 | **Extent text** | `extentText` | Verbose human-readable extent/dimensions string (`dcterms:extent`), distinct from the structured `dimensions` and the reconstructed `dimensionStatement`. |
| 17 | **Inscriptions** | `inscriptions` | All inscriptions, signatures, marks, or labels on the object. May include multiple entries (split on ` | ` delimiter from harvest). |

## Provenance & Context

| # | Category | Field | Description |
|---|----------|-------|-------------|
| 18 | **Provenance** | `provenance` | Raw ownership history text, classified under AAT [provenance statements](http://vocab.getty.edu/aat/300444174) (300444174). |
| 19 | **Provenance chain** | `provenanceChain` | Parsed provenance events extracted from the free-text `provenance` field above. Each event carries: `sequence`, `gap`, `uncertain`, `transferType` (sale/gift/bequest/confiscation/by_descent/widowhood/inheritance/restitution/…), `party.name`, `location`, `date` (`{ year, text }`), and `price` (`{ currency, amount, text }`). Available for ~48K artworks. **Now exposed in `structuredContent`** as well as in the rendered text channel — clients can re-derive counts, gaps, year spans, transfer-type histograms, and earliest-known-owner without re-parsing. For multi-artwork queries use the `search_provenance` tool. |
| 20 | **Credit line** | `creditLine` | Acknowledgement text for the current holding, classified under AAT [acknowledgments](http://vocab.getty.edu/aat/300026687) (300026687; also known as "credit line"). |
| 21 | **Current location** | `location` | Current museum room when the artwork is on display, as `{ roomId, floor, roomName }`. Null when the artwork is not on display or no room mapping exists. |
| 22 | **Collection sets** | `collectionSets` | Raw Rijksmuseum vocabulary URIs for the collections this object belongs to (from `member_of`). Also searchable via `search_artwork`'s `collectionSet` filter. |
| 23 | **Collection set labels** | `collectionSetLabels` | English names for each collection set from the vocabulary database. |

## Iconography

| # | Category | Field | Description |
|---|----------|-------|-------------|
| 24 | **Subjects** | `subjects` | Iconographic subject annotations, structured into three arrays: `iconclass` ([Iconclass](https://iconclass.org/) concepts — e.g. "civic guard", "group portrait"), `depictedPersons` (named individuals), and `depictedPlaces` (geographical locations). Each entry has `label` and `id` from the vocabulary database. Iconclass entries use the notation code as `id`. Not all artworks have subject annotations — objects without them return empty arrays. These subject terms are also searchable across the full collection via `search_artwork`'s `subject`, `iconclass`, `depictedPerson`, and `depictedPlace` filters. |

## Curatorial Context

| # | Category | Field | Description |
|---|----------|-------|-------------|
| 25 | **Themes** | `themes` / `themesTotalCount` | Curatorial thematic tags (overseas history, political history, costume, …). Each entry has `label` and `id`. Coverage ~7% of artworks. `themesTotalCount` reports the total before list capping. Also searchable via `search_artwork`'s `theme` filter. |
| 26 | **Exhibitions** | `exhibitions` / `exhibitionsTotalCount` | Exhibitions the artwork has appeared in, most-recent first. Each entry: `exhibitionId`, `titleEn`, `titleNl`, `dateStart`, `dateEnd`. `exhibitionsTotalCount` reports total before capping. |
| 27 | **Attribution evidence** | `attributionEvidence` | Evidence supporting attribution claims (signatures, inscriptions, monograms). Each entry: `partIndex` (upstream Linked Art ordering), `evidenceTypeAat`, `carriedByUri`, `labelText`. Artwork-level — `partIndex` does NOT map to `production[]` index. |

## Digital & Rights

| # | Category | Field | Description |
|---|----------|-------|-------------|
| 28 | **Web page** | `webPage` | URL of the artwork's page on the Rijksmuseum website (derived from the object number). |
| 29 | **License** | `license` | Rights/license URI (e.g. CC0 1.0, Public Domain Mark) from the `rights_lookup` table. Also searchable via `search_artwork`'s `license` filter. |

## Related Works

| # | Category | Field | Description |
|---|----------|-------|-------------|
| 30 | **Related objects** | `relatedObjects` / `relatedObjectsTotalCount` | Curator-declared co-production peer relations, restricted to the creator-invariant labels: `different example`, `production stadia`, `pendant`. Each entry: `relationship`, `objectNumber` (when the peer resolves in our DB), `title`, `objectUri` (original Linked Art URI), `iiifId` (powers in-viewer prev/next navigation when present). Capped at 25 entries — `relatedObjectsTotalCount` reports the full count. Other curator-declared edges (pair, set, recto/verso, original/reproduction, generic related-object) are exposed through `find_similar`'s Related Object channel rather than here. |
| 31 | **Parents** | `parents` | Parent records (e.g. the sketchbook this folio belongs to). Each entry: `objectNumber`, `title`. Empty for top-level objects. |
| 32 | **Children** | `children` / `childCount` | Child records (e.g. folios in a sketchbook, leaves in an album). `children` returns up to 25 entries ordered by object number; `childCount` reports the total. Use `search_artwork` to enumerate the full set. |

## Audit Timestamps

| # | Category | Field | Description |
|---|----------|-------|-------------|
| 33 | **Record created** | `recordCreated` | ISO 8601 timestamp of catalogue record creation. |
| 34 | **Record modified** | `recordModified` | ISO 8601 timestamp of the catalogue record's most recent modification. Also searchable via `search_artwork`'s `modifiedAfter` / `modifiedBefore` filters. |

---
#### Search-only filters

Note: The following `search_artwork` filters are searchable but have **no corresponding field** in the `get_artwork_details` response (the underlying data is not surfaced per-artwork):

| Filter | Description |
|---|---|
| `nearPlace` / `nearLat` / `nearLon` / `nearPlaceRadius` | Proximity search by place name or coordinates |
| `aboutActor` | Broader person search (depicted + creator vocabulary) |
| `hasProvenance` | Boolean — restrict to artworks with provenance records |
| `imageAvailable` | Boolean — restrict to artworks with a digital image |
| `expandPlaceHierarchy` | Boolean — expand place filters to include sub-places |
| `modifiedAfter` / `modifiedBefore` | Date-based change filters (corresponds to the `recordModified` field on the response) |

Demographic person filters (gender, birth/death year, birth/death place, profession) live on the separate [`search_persons`](mcp-tool-parameters.md#search_persons) tool — feed the returned vocab IDs into `search_artwork({creator})`.

---
## Data Model

These categories originate from the [Linked Art](https://linked.art/) data model, a community standard for describing cultural heritage objects as JSON-LD. The Rijksmuseum's Linked Open Data APIs serve artwork records in this format during the offline harvest, supplemented by OAI-PMH EDM records and Schema.org full-collection dumps. At runtime, all data is served from the local vocabulary database — no Linked Art resolution is performed.
