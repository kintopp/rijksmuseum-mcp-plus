# Search Parameters

`search_artwork` accepts 37 search filters and 4 output controls. At least one filter is required (parameters marked *modifier* narrow results but cannot be the sole filter). All filters combine freely with each other — results are the intersection (AND) of all active filters.

Parameters that accept arrays (marked **[]**) AND-combine their values: `subject: ["landscape", "seascape"]` returns artworks tagged with *both* subjects.

All searches are backed by a vocabulary database of ~194,000 controlled terms mapped to ~832,000 artworks via ~13.5 million mappings, enriched with creator biographical data (~49K life dates, ~64K gender annotations) and a spatial place hierarchy (~31K geocoded places).

- [Ranking](#ranking)
- [1. Vocabulary label filters](#1-vocabulary-label-filters) (17 parameters)
- [2. Full-text search filters](#2-full-text-search-filters) (7 parameters)
- [3. Column and metadata filters](#3-column-and-metadata-filters) (13 parameters)
- [4. Output controls](#4-output-controls) (4 parameters)
- [Semantic search](#semantic-search)
- [Artwork detail fields](#artwork-detail-fields)

## Ranking

Results are ranked differently depending on which filters are active:

- **BM25** — when any full-text filter is active (`title`, `description`, `inscription`, `provenance`, `creditLine`, `curatorialNarrative`), results are ranked by text relevance.
- **Geographic proximity** — when `nearPlace` or `nearLat`/`nearLon` is active (without text filters), results are ranked by distance from the search point.
- **Importance** — when only vocabulary, column, or modifier filters are active, results are ordered by a composite importance score reflecting image availability, curatorial attention, and metadata richness.

---

## 1. Vocabulary label filters

Match against ~194,000 controlled terms. Labels are bilingual (English and Dutch) — try the Dutch term if English returns no results (e.g. "fotograaf" instead of "photographer").

### Subject and iconography

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `subject` | string **[]** | Subject matter (Iconclass themes, depicted scenes). Primary parameter for concept searches — use before `description` or `curatorialNarrative`. ~108K terms, ~722K artworks. Exact word matching with morphological stemming. | `"winter landscape"` |
| `iconclass` | string **[]** | Exact Iconclass notation code. More precise than `subject` — use `lookup_iconclass` to discover codes by concept. ~25K notation codes. | `"73D82"` |
| `depictedPerson` | string **[]** | Person depicted in the artwork. ~60K persons, ~217K artworks. Matches against 210K name variants including historical forms. | `"Willem van Oranje"` |
| `depictedPlace` | string **[]** | Place depicted in the artwork. 20,689 places. Supports multi-word names with geo-disambiguation (e.g. "Oude Kerk Amsterdam" resolves to the Oude Kerk in Amsterdam). Distinct from `productionPlace` — a painting *depicting* Amsterdam may have been made in Haarlem. | `"Batavia"` |

### Production

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `creator` | string **[]** | Artist or maker name. ~510K artworks, ~21K unique names. Uses canonical name forms (e.g. "Rembrandt van Rijn"). | `"Rembrandt van Rijn"` |
| `aboutActor` | string | Broader person search across depicted persons *and* creators. More tolerant of cross-language name forms than `depictedPerson` (e.g. "Louis XIV" finds "Lodewijk XIV"). | `"Louis XIV"` |
| `productionPlace` | string **[]** | Where the artwork was made. 9,002 places. Supports multi-word names with geo-disambiguation. | `"Delft"` |
| `productionRole` | string **[]** | Role an actor played in creating this specific work — distinct from `profession` (what the person *was*). [178 terms](vocabulary-production-roles.md). Key terms: "print maker" (382K), "publisher" (185K), "after painting by" (46K). | `"after painting by"` |
| `attributionQualifier` | string **[]** | Attribution qualifier. 7 values: "primary", "attributed to", "workshop of", "circle of", "follower of", "secondary", "undetermined". Combine with `creator` to narrow attribution. | `"workshop of"` |

### Creator biography

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `birthPlace` | string **[]** | Artist's place of birth. ~2K places, ~196K artworks. Search-only: not returned by `get_artwork_details`. | `"Leiden"` |
| `deathPlace` | string **[]** | Artist's place of death. ~1.3K places, ~180K artworks. Useful for tracking artist migration — compare `birthPlace: "Antwerp"` with `deathPlace: "Amsterdam"`. | `"Paris"` |
| `profession` | string **[]** | Artist's profession. [600 terms](vocabulary-professions.md), bilingual. Search-only: not returned by `get_artwork_details`. | `"printmaker"` |

### Object classification

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `type` | string **[]** | Object type. 4,385 terms (e.g. "painting", "print", "drawing", "photograph", "sculpture"). | `"painting"` |
| `material` | string **[]** | Material or support. [734 terms](vocabulary-materials.md) (e.g. "canvas", "paper", "panel", "oil paint"). | `"panel"` |
| `technique` | string **[]** | Artistic technique. [967 terms](vocabulary-techniques.md) (e.g. "oil painting", "etching", "mezzotint"). | `"etching"` |

### Collection

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `collectionSet` | string **[]** | Curated collection set by name. [192 sets](vocabulary-collection-sets.md). Use `list_curated_sets` to discover sets. | `"Rembrandt"` |
| `license` | string | Rights/license filter. Values: "publicdomain" ([PDM 1.0](http://creativecommons.org/publicdomain/mark/1.0/) — 728K), "zero" ([CC0 1.0](http://creativecommons.org/publicdomain/zero/1.0/) — 1.7K), "InC" ([In Copyright](http://rightsstatements.org/vocab/InC/1.0/) — 101K). | `"publicdomain"` |

---

## 2. Full-text search filters

BM25-ranked search on FTS5 indexes. Exact word matching, no stemming (except `subject` above, which has morphological stemming). When any of these are active, results are ranked by text relevance.

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `title` | string | Search across all title variants (brief, full, former x EN/NL). ~826K artworks. | `"Night Watch"` |
| `query` | string | Alias for `title`. Provided as a convenience for exploratory queries. When both are provided, `title` takes precedence. | `"Night Watch"` |
| `description` | string | Cataloguer descriptions (~510K artworks, 61% coverage). Compositional details, motifs, condition notes, attribution remarks. Dutch-language. | `"zwart krijt"` |
| `inscription` | string | Inscription texts (~500K artworks). Signatures, mottoes, dates on the object surface. | `"fecit"`, `"Rembrandt f."` |
| `provenance` | string | Ownership history (~48K artworks). Auction records, dealer transactions, collection transfers. Coverage weighted toward paintings and major works. | `"Napoleon"`, `"Goudstikker"` |
| `creditLine` | string | Credit/donor lines (~358K artworks). Acquisition mode — purchase, bequest, gift, loan. | `"Drucker"`, `"purchase"` |
| `curatorialNarrative` | string | Curatorial wall text (~14K artworks). Art-historical interpretation written by museum curators — distinct from `description`. | `"civic guard"` |

---

## 3. Column and metadata filters

Direct filters on artwork table columns, JOIN-based demographic filters, and spatial queries.

### Date and image

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `creationDate` | string | Creation date. ~628K artworks with dates (3000 BCE–2025). Exact year or wildcard. | `"1642"`, `"16*"`, `"164*"` |
| `imageAvailable` | boolean | When `true`, only artworks with a digital image (~728K artworks). *Modifier.* | `true` |

### Dimensions

All values in centimeters.

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `minHeight` | number | Minimum height. | `40` |
| `maxHeight` | number | Maximum height. | `50` |
| `minWidth` | number | Minimum width. | `300` |
| `maxWidth` | number | Maximum width. | `40` |

### Creator demographics

Based on enrichment data from Rijksmuseum actor authority files (~49K with life dates, ~64K with gender). *Modifiers* — cannot be the sole filter.

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `creatorGender` | string | Creator gender: "male" or "female". | `"female"` |
| `creatorBornAfter` | integer | Creators born in or after this year. Combine with `creatorBornBefore` for a range. | `1800` |
| `creatorBornBefore` | integer | Creators born in or before this year. | `1900` |

### Geographic proximity

Searches both depicted and production places within the specified radius, using coordinates from ~31,000 geocoded places ([Getty TGN](https://www.getty.edu/research/tools/vocabularies/tgn/), [Wikidata](https://www.wikidata.org/), [GeoNames](https://www.geonames.org/), [World Historical Gazetteer](https://whgazetteer.org/)).

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `nearPlace` | string | Named location for proximity search. Supports multi-word names with geo-disambiguation. | `"Oude Kerk Amsterdam"` |
| `nearLat` | number | Latitude (-90 to 90). Use with `nearLon` for coordinate-based search. Takes precedence over `nearPlace` if both provided. | `52.3676` |
| `nearLon` | number | Longitude (-180 to 180). Use with `nearLat`. | `4.8945` |
| `nearPlaceRadius` | number | Radius in km (0.1–500, default 25). | `15` |

### Place hierarchy

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `expandPlaceHierarchy` | boolean | Expand place filters (`productionPlace`, `depictedPlace`, `birthPlace`, `deathPlace`) to include sub-places in the administrative hierarchy, up to 3 levels deep. E.g. `productionPlace: "Netherlands"` includes Amsterdam, Delft, etc. *Modifier.* | `true` |

---

## 4. Output controls

Not filters — these control how results are returned.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `maxResults` | integer | 25 | Maximum results (1–50). All results include full metadata unless `compact` is true. |
| `compact` | boolean | `false` | Returns only total count and object IDs without resolving metadata (faster for counting). |
| `facets` | boolean | `false` | When results are truncated, includes top-5 counts per dimension (type, material, technique, century) to guide narrowing. Dimensions already filtered on are excluded. |

---

## Semantic search

For concepts that cannot be expressed as structured vocabulary terms — atmosphere, emotion, composition, art-historical interpretation — use the `semantic_search` tool instead. It accepts free-text queries in any language and ranks all ~831,000 artworks by embedding similarity. Its filters (`type`, `material`, `technique`, `creationDate`, `creator`, `collectionSet`, `aboutActor`, `iconclass`, `imageAvailable`) are a subset of those listed above. Results are most reliable when curatorial narrative texts discuss the relevant concept explicitly. See [Semantic Search](semantic-search.md) for full documentation.

---

## Artwork detail fields

`get_artwork_details` returns [24 metadata categories](metadata-categories.md) per artwork, plus summary fields (`id`, `title`, `creator`, `date`, `url`). Nearly all categories are also searchable collection-wide via corresponding `search_artwork` parameters. The exceptions are identifiers, current location, web page, related objects, and bibliography count.

| Field | What it contains | Notes |
|---|---|---|
| Object number (`objectNumber`) | Museum inventory number (e.g. `SK-C-5`) | Format encodes the collection: `SK` = paintings, `RP` = prints, `BK` = sculpture/applied art, `NG` = modern acquisitions. |
| Persistent identifier (`persistentId`) | Stable [Handle](https://www.handle.net/) URI | Permanent citation link. Use in publications and bibliographies. |
| External identifiers (`externalIds`) | All cataloguing identifiers | Includes the object number and any additional identifiers. |
| Title variants (`titles`) | All known titles with language and type | Each entry has language (`en`/`nl`) and qualifier (`brief`/`full`/`other`). Up to 6 variants. The brief English title is the primary display title. |
| Curatorial narrative (`curatorialNarrative`) | Museum wall text in EN and/or NL | Interpretive art-historical context written by curators. Distinct from `description`. |
| Description (`description`) | Cataloguer description (Dutch) | Compositional details, motifs, condition, attribution remarks. ~510K artworks. |
| Production details (`production`) | Structured creator, role, and place data | Each entry: `name`, `role`, `place`, `actorUri`, and optional `personInfo` (with `birthYear`, `deathYear`, `gender`, `bio`, `wikidataId`). Person info available for ~49K creators with life dates, ~11K with biographical notes. |
| Object types (`objectTypes`) | What the object is, with authority links | Resolved terms with [Getty AAT](https://www.getty.edu/research/tools/vocabularies/aat/) and [Wikidata](https://www.wikidata.org/) equivalents. |
| Materials (`materials`) | What it is made of, with authority links | Resolved terms with AAT and Wikidata equivalents. |
| Technique statement (`techniqueStatement`) | Free-text technique description | |
| Dimension statement (`dimensionStatement`) | Human-readable dimensions text | For numeric filtering, use `minHeight`/`maxHeight`/`minWidth`/`maxWidth`. |
| Structured dimensions (`dimensions`) | Numeric dimension values | Each entry: type label, numeric `value`, `unit` (cm/mm/kg/g/m), optional `note`. |
| Subjects (`subjects`) | Iconographic annotations | Three components: `iconclass`, `depictedPersons`, `depictedPlaces`. Each a resolved term with `label`, `id`, and `equivalents`. |
| Provenance (`provenance`) | Ownership history text | |
| Credit line (`creditLine`) | Acquisition acknowledgement | |
| Inscriptions (`inscriptions`) | Text transcribed from the object surface | May include multiple entries. |
| License (`license`) | Rights/license URI | CC0, Public Domain Mark, or In Copyright. |
| Collection sets (`collectionSets`, `collectionSetLabels`) | Curatorial groupings | Raw URIs and resolved English labels with authority equivalents. |
| Current location (`location`) | Gallery and room within the museum | May be absent for works in storage or on loan. |
| Web page (`webPage`) | Rijksmuseum website URL | |
| Related objects (`relatedObjects`) | Links to associated artworks | Each entry: `relationship` label and `objectUri`. |
| Bibliography count (`bibliographyCount`) | Number of scholarly references | Use `get_artwork_bibliography` for full citations. Major works can have 100+. |
