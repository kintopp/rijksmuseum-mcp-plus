Rijksmuseum MCP — Tool Parameters Reference

---

## search_artwork

The primary search tool. Vocabulary-based filters can be freely combined with each other and with the core filters below.

### Core filters
| Parameter | Description |
|---|---|
| `query` | General title search |
| `creator` | Artist name, e.g. `Rembrandt van Rijn` |
| `type` | Object type: `painting`, `print`, `drawing`, etc. |
| `material` | e.g. `canvas`, `paper`, `wood` |
| `technique` | e.g. `oil painting`, `etching` |
| `creationDate` | Exact year (`1642`) or wildcard (`16*`, `164*`) |

### Vocabulary-based filters
| Parameter | Description |
|---|---|
| `title` | Search all title variants (brief, full, former × EN/NL) |
| `subject` | Primary concept/theme search — searches ~832K artworks via Iconclass vocabulary. Start here for thematic queries |
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
| `maxResults` | 1–50 (default 25) |
| `compact` | `true` returns IDs only without full metadata (faster) |
| `pageToken` | Pagination token from a previous result |

---

## semantic_search

Natural language / concept-based search. Best for atmospheric, thematic, or art-historical queries.

| Parameter | Description |
|---|---|
| `query` | Natural language concept, e.g. `vanitas symbolism`, `artist gazing at the viewer` |
| `type` | Object type filter, e.g. `painting` (use this, not `technique: painting`) |
| `creator` | Filter by artist name |
| `material` | Filter by material |
| `technique` | Filter by technique |
| `creationDate` | Exact year or wildcard |
| `collectionSet` | Filter by curated set name |
| `aboutActor` | Filter by person (depicted or creator) |
| `iconclass` | Filter by Iconclass notation code |
| `imageAvailable` | `true` to restrict to artworks with images |
| `maxResults` | 1–50 (default 15) |

---

## lookup_iconclass

Search or browse the Iconclass subject classification vocabulary. Provide either `query` or `notation`, not both.

| Parameter | Description |
|---|---|
| `query` | Text search across Iconclass labels in all 13 languages |
| `notation` | Browse a specific Iconclass notation and its children (e.g. `31A33`) |
| `lang` | Preferred language for labels (default `en`; supports en, nl, de, fr, it, es, pt, fi, cz, hu, pl, jp, zh) |
| `maxResults` | 1–50 (default 25) |

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

## get_artwork_bibliography

| Parameter | Description |
|---|---|
| `objectNumber` | Object identifier |
| `full` | `true` to return all citations; default returns first 5 with total count |

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

