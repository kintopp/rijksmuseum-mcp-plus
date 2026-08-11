# Artwork Metadata Categories

The `get_artwork_details` tool returns the full artwork record — 46 top-level fields, grouped here into 36 categories. All data is served from the local vocabulary database (built from periodic harvests of the Rijksmuseum's Linked Art, OAI-PMH, and Schema.org dump APIs). Categories include artwork identification (with work-level and entity-level external authority identifiers), creation details with biographical data, physical characteristics, provenance with parsed ownership chains, iconographic subjects, curatorial context (themes, exhibitions, attribution marks), hierarchical relations (parents/children for sketchbooks, albums, series), pointers into the artwork's conservation record and bibliography, and rights information.

Nearly all categories have corresponding search parameters in `search_artwork` — see the [full search parameter reference](search-parameters.md) for filters grouped by type, or the [tool parameters reference](mcp-tool-parameters.md) for all tools.

---

## Identification

| # | Category | Field | Description |
|---|----------|-------|-------------|
| 1 | **Title variants** | `titles` | Array of title variants tagged by language (`en` / `nl` / `other`) and qualifier (`brief` / `full` / `display` / `former` / `other`). The primary display title is also flattened into the top-level `title` field. |
| 2 | **Object number** | `objectNumber` / `id` | `objectNumber` is the museum's inventory number (e.g. `SK-C-5` for The Night Watch) and the primary identifier used across all tools. Alongside it, `id` carries the record's own minted Linked Art URI, `https://id.rijksmuseum.nl/{internal id}` — one of the two URI forms `get_artwork_details` accepts in its `uri` parameter. |
| 3 | **Persistent identifier** | `persistentId` | The harvested `hdl.handle.net` URI for the artwork, suitable for long-term citation. Always identical to `externalIds.handle`, and `null` for the small minority of records that carry no handle. The suffix is an upstream identifier with no relationship to any internal id — do not construct one. |
| 4 | **External identifiers** | `externalIds` / `equivalents` | Authority IDs at two levels. **Work-level** `externalIds` = `{ handle, other }`: the `handle` is the persistent `hdl.handle.net` URI for the artwork; `other` is an array of non-handle external IDs (rare — a handful of rows DB-wide). **Entity-level** `equivalents[]` carries cross-authority crosswalks on the vocabulary *terms* — present on `objectTypes[]`, `materials[]`, `production[]`, `subjects.depictedPersons[]`, `subjects.depictedPlaces[]`, `collectionSetLabels[]`, and `themes[]`. Each entry is a `{ authority, id, uri }` triple — AAT, TGN, Wikidata, GeoNames, ULAN, VIAF, RKD, plus the less common Iconclass, CERL, Biografisch Portaal and NYPL — and one term may carry several. Omitted when empty; Iconclass subjects carry none (resolve those notations via the Iconclass server). |

## Creation

| # | Category | Field | Description |
|---|----------|-------|-------------|
| 5 | **Creator** | `creator` | Creator name or attribution statement in English (e.g. "Rembrandt van Rijn"). Falls back to Dutch if no English version exists. |
| 6 | **Date** | `date` | Creation date derived from the integer `date_earliest`/`date_latest` columns — a single year (`"1642"`) or an en-dash range (`"1640–1650"`). No language preference is involved; for the cataloguer's free-text wording use `dateDisplay`. Empty string when nothing is recorded. |
| 7 | **Display date** | `dateDisplay` | Free-text Rijksmuseum-formatted date (e.g. "1642", "c. 1665–1667"). Use this for prose; use `date` for ISO-shaped output. |
| 8 | **Production details** | `production` | Structured list of all production participants. Each entry includes: `name` (English label from vocabulary), `role` (e.g. "painter", "printmaker"), `attributionQualifier` (e.g. "attributed to", "workshop of", or null for primary), `place` (e.g. "Amsterdam"), `actorUri` (vocabulary identifier), and an optional `personInfo` sub-object with biographical data: `birthYear`, `deathYear` (integers), `gender` (`"male"`, `"female"`, or null), and `wikidataId` (e.g. `"Q5598"`). Person info is available for creators matched to the Rijksmuseum's actor authority files — a large minority of person records carry life dates, and a comparable share carry Wikidata IDs. `role` and `attributionQualifier` are paired to each creator **by vocabulary id** (row-aware), not by list position; the positional zip survives only as a fallback for pre-v0.24 databases with no pair tables. `place` is still matched positionally and is left null when the counts disagree. |

## Description

| # | Category | Field | Description |
|---|----------|-------|-------------|
| 9 | **Description** | `description` | General descriptive statement about the artwork (cataloguer-written, predominantly Dutch). |
| 10 | **Curatorial narrative** | `curatorialNarrative` | `{ en, nl }` object holding the museum wall text. Currently only the English version (`.en`) is populated by the harvest; `.nl` is always null. Distinct from the general description above. |

## Physical Characteristics

| # | Category | Field | Description |
|---|----------|-------|-------------|
| 11 | **Object types** | `objectTypes` | What the object is (e.g. "painting", "print", "drawing"). Each entry includes an English `label` and the vocabulary `id`. The top-level `type` field is convenience sugar equal to `objectTypes[0]?.label`; `objectTypes[]` is authoritative. |
| 12 | **Materials** | `materials` | What the object is made of (e.g. "oil paint", "canvas"). Same format as object types. |
| 13 | **Technique statement** | `techniqueStatement` | Comma-separated list of technique labels from the vocabulary database (e.g. "engraving, etching"). Null when the artwork has no technique mappings — which is common, including for many paintings. |
| 14 | **Physical dimensions** | `physicalDimensions` | Human-readable dimensions text reconstructed from stored numeric values (e.g. "h 363 cm × w 437 cm"). Same value and key the viewer tools (`get_artwork_image` / `remount_viewer`) emit. (Renamed from `dimensionStatement` in v0.60.) |
| 15 | **Structured dimensions** | `dimensions` | Numeric dimension values with `type` (`height`, `width`, `depth`, `weight`, `diameter`), `value`, and `unit` — `"cm"` for every type except `weight`, which is `"g"`. Height and width are populated for nearly all artworks; depth/weight/diameter are sparse and mostly present for sculptures and three-dimensional objects. A `note` key is present but is currently always null. |
| 16 | **Extent text** | `extentText` | Verbose human-readable extent/dimensions string (`dcterms:extent`), distinct from the structured `dimensions` and the reconstructed `physicalDimensions`. **Returned only when you pass `verboseExtent: true`; `null` otherwise.** Nearly every artwork has one, so an absent value on a default call means the flag was not set, not that the data is missing. `browse_set` gates the same field behind its own `includeExtentText` flag. |
| 17 | **Inscriptions** | `inscriptions` / `parsedInscriptions` / `inscriptionSummary` | All inscriptions, signatures, marks, or labels on the object — raw text (`inscriptions`, multiple entries split on the ` | ` delimiter from harvest) plus a structured parse. `parsedInscriptions` is one entry per mark with `normalizedType`/`normalizedPlacement`/`normalizedTechnique`, `transcribedText[]` (quoted on-object text), Lugt `collectorMarks`, and `isCollectorMark`/`isPlaceholder` flags; `inscriptionSummary` is a per-artwork rollup (`hasTranscribedText`, `hasCollectorMarkOnly`, deduped marks/types/placements/techniques) to tell "object bears text" from verso collector-stamp boilerplate. Catalogue-entered data, not OCR. Searchable collection-wide via `search_inscriptions`. |

## Provenance & Context

| # | Category | Field | Description |
|---|----------|-------|-------------|
| 18 | **Provenance** | `provenance` | Raw ownership history text, classified under AAT [provenance statements](http://vocab.getty.edu/aat/300444174) (300444174). |
| 19 | **Provenance chain** | `provenanceChain` | Parsed provenance events extracted from the free-text `provenance` field above. Each event carries: `sequence`, `gap`, `uncertain`, `transferType` (sale/gift/bequest/confiscation/by_descent/widowhood/inheritance/restitution/…), `party.name`, `location`, `date` (`{ year, text }`), and `price` (`{ currency, amount, text }`). Available for ~48K artworks. **Now exposed in `structuredContent`** as well as in the rendered text channel — clients can re-derive counts, gaps, year spans, transfer-type histograms, and earliest-known-owner without re-parsing. For multi-artwork queries use the `search_provenance` tool. |
| 20 | **Credit line** | `creditLine` | Acknowledgement text for the current holding, classified under AAT [acknowledgments](http://vocab.getty.edu/aat/300026687) (300026687; also known as "credit line"). |
| 21 | **Current location** | `location` | Current museum room when the artwork is on display, as `{ roomId, floor, roomName }`. Null when the artwork is not on display or no room mapping exists. |
| 22 | **Collection sets** | `collectionSets` | Raw Rijksmuseum vocabulary IDs for the collections this object belongs to (from `member_of`) — bare numeric strings such as `"261231"`, not URIs. Also searchable via `search_artwork`'s `collectionSet` filter. |
| 23 | **Collection set labels** | `collectionSetLabels` | Resolved labels for each collection set, as `{ id, label }` (plus `equivalents` where present). The labels are **Dutch** — for set terms the vocabulary's English column simply mirrors the Dutch one (e.g. `keramiek (collectie)`, `poppenhuis`). |

## Iconography

| # | Category | Field | Description |
|---|----------|-------|-------------|
| 24 | **Subjects** | `subjects` | Iconographic subject annotations, structured into three arrays: `iconclass` ([Iconclass](https://iconclass.org/) concepts — e.g. "civic guard", "group portrait"), `depictedPersons` (named individuals), and `depictedPlaces` (geographical locations). Each entry has `label` and `id` from the vocabulary database. Iconclass entries use the notation code as `id`. Not all artworks have subject annotations — objects without them return empty arrays. **These three arrays are a filtered view, not the whole subject set:** terms typed as `event` or `group` (depicted historical events, organisations, families) and classifications without a notation are not surfaced here at all — together roughly 87K mappings. Because `search_artwork`'s `subject` filter searches the entire field with no type restriction, you can find an artwork *by* an event subject and then not see that subject on its detail record. |

## Curatorial Context

| # | Category | Field | Description |
|---|----------|-------|-------------|
| 25 | **Themes** | `themes` / `themesTotalCount` | Curatorial thematic tags (overseas history, political history, costume, …). Each entry has `label` and `id`. Coverage ~7% of artworks. `themesTotalCount` reports the total before list capping. Also searchable via `search_artwork`'s `theme` filter. |
| 26 | **Exhibitions** | `exhibitions` / `exhibitionsTotalCount` | Exhibitions the artwork has appeared in, most-recent first. Each entry: `exhibitionId`, `titleEn`, `titleNl`, `dateStart`, `dateEnd`. `exhibitionsTotalCount` reports total before capping. |

## Digital & Rights

| # | Category | Field | Description |
|---|----------|-------|-------------|
| 27 | **Web page** | `url` | URL of the artwork's page on the Rijksmuseum website (derived from the object number). |
| 28 | **License** | `license` | Rights/license URI from the `rights_lookup` table. Three values occur: Public Domain Mark 1.0 (the large majority), rightsstatements.org In Copyright, and CC0 1.0 (rare). Not a standalone search filter; returned on each result, and available as the `rights` dimension via `search_artwork`'s `facets` parameter (e.g. `facets: ["rights"]`) for a license breakdown of a result set. |

## Related Works

| # | Category | Field | Description |
|---|----------|-------|-------------|
| 29 | **Related objects** | `relatedObjects` / `relatedObjectsTotalCount` | Curator-declared creator-invariant peer relations (the same set surfaced as `find_similar`'s **Related Variant** channel), restricted to the labels: `different example`, `production stadia`, `pendant`. Each entry: `relationship`, `objectNumber` (when the peer resolves in our DB), `title`, `objectUri` (original Linked Art URI), `iiifId` (powers in-viewer prev/next navigation when present). Capped at 25 entries — `relatedObjectsTotalCount` reports the full count. Other curator-declared edges (pair, `pair (weapons)`, set, recto/verso, original/reproduction, product line, generic related-object) are exposed through `find_similar`'s Related Object channel rather than here. |
| 30 | **Physical relations** | `physicalRelations` / `physicalRelationsTotalCount` | Physical-companion objects — the artwork's frame(s) and pedestal, under the labels `object \| current frame`, `object \| former frame`, and `object \| pedestal`. Same entry shape as `relatedObjects` (`relationship`, `objectNumber`, `title`, `objectUri`, `iiifId`) and the same 25-entry cap (`physicalRelationsTotalCount` reports the full count). Deliberately kept distinct from `relatedObjects` (creator-invariant variants) and from `find_similar` groupings — `find_similar` treats frames/pedestals as companions, not similar artworks. Always present: an empty array when the object has no frame or pedestal. |
| 31 | **Parents** | `parents` | Parent records (e.g. the sketchbook this folio belongs to). Each entry: `objectNumber`, `title`. Empty for top-level objects. |
| 32 | **Children** | `children` / `childCount` | Child records (e.g. folios in a sketchbook, leaves in an album). `children` returns up to 25 entries ordered by object number; `childCount` reports the total. Use `search_artwork` to enumerate the full set. |

## Audit Timestamps

| # | Category | Field | Description |
|---|----------|-------|-------------|
| 33 | **Record created** | `recordCreated` | ISO 8601 timestamp of catalogue record creation. |
| 34 | **Record modified** | `recordModified` | ISO 8601 timestamp of the catalogue record's most recent modification. Not a range filter; order a result set by it with `search_artwork`'s `sort: 'recordModified:desc'`, or use `get_recent_changes` to list recently modified records. |

## Conservation & References

These two fields are *pointers* — a presence/count flag on the detail record that routes you to a dedicated single-artwork tool for the full data.

| # | Category | Field | Description |
|---|----------|-------|-------------|
| 35 | **Attribution marks** | `attributionMarks` | `{ signatures, inscriptions, total }` — the *count* of signature/inscription marks recorded on the object (presence only; the harvested rows carry no transcribed text and their carrier URIs do not resolve). Use `parsedInscriptions` / `search_inscriptions` for the actual transcriptions. The same count, alongside technical examinations and restoration treatments, is returned by [`get_conservation_history`](mcp-tool-parameters.md#get_conservation_history). |
| 36 | **Bibliography count** | `bibliographyCount` | Number of scholarly citations recorded for the artwork — a pointer, not the references themselves. Call [`get_artwork_bibliography`](mcp-tool-parameters.md#get_artwork_bibliography) for the entries (citation text, linked publication, pages, ISBN). Null when bibliography data is not present in this database. |

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
| `sourceType` | Source-channel classification (6 values). Backed by its own mapping field, but never surfaced on the detail record. |
| `sameRowMatching` | Boolean — constrain `creator` + `productionRole` to the same production row |
| `dateMatch` | How `creationDate` matches an artwork's date range |

One further asymmetry worth knowing: `production[].place` is read from the `spatial` (and, failing that, `birth_place`) field, whereas the `productionPlace` *filter* also spans the separate Linked Art production-place field — the larger of the two. A work whose production place is recorded only there is findable by filter but shows no `place` on its production entry. The same holds for depicted places, where the filter spans `subject` + `spatial` but `subjects.depictedPlaces` reads only `subject`.

Demographic person filters (gender, birth/death year, birth/death place, profession) are available on `search_persons` — and, for aggregate counts, directly on `collection_stats`, which carries `gender`, `profession`, `birthPlace` and `deathPlace` as first-class filters and dimensions. Only `search_artwork` lacks them; there, feed a `vocabId` from `search_persons` into `creator`.

---
## Data Model

These categories originate from the [Linked Art](https://linked.art/) data model, a community standard for describing cultural heritage objects as JSON-LD. The Rijksmuseum's Linked Open Data APIs serve artwork records in this format during the offline harvest, supplemented by OAI-PMH EDM records and Schema.org full-collection dumps. At runtime, all data is served from the local vocabulary database — no Linked Art resolution is performed.
