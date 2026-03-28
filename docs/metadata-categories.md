# Artwork Metadata Categories

The `get_artwork_details` tool returns up to **26 metadata categories** for each artwork. These are divided into groups internally: base categories parsed directly from the Linked Art JSON-LD object, enriched categories from vocabulary resolution (resolving Rijksmuseum vocabulary URIs to English labels with links to Getty AAT, Wikidata, and Iconclass), subject annotations derived from the VisualItem layer, and a parsed provenance chain. The bibliography count is a pointer to the separate `get_artwork_bibliography` tool. 

Nearly all categories have corresponding search parameters in `search_artwork` — see the [full search parameter reference](search-parameters.md) for filters grouped by type, or the [tool parameters reference](mcp-tool-parameters.md) for all tools.

---

## Identification

| # | Category | Field | Description |
|---|----------|-------|-------------|
| 1 | **Title variants** | `titles` | All known titles with language (`en`, `nl`, or `other`) and qualifier (`brief`, `full`, or `other` — former titles and other variants are classified as `other`). The collection is strictly bilingual (EN + NL). The brief English title is the primary display title. |
| 2 | **Object number** | `objectNumber` | The museum's inventory number (e.g. `SK-C-5` for The Night Watch). This is the primary identifier used across all tools. |
| 3 | **Persistent identifier** | `persistentId` | Stable handle.net URI for long-term citation (e.g. `http://hdl.handle.net/10934/RM0001.COLLECT.5216`). |
| 4 | **External identifiers** | `externalIds` | All identifiers attached to the object, mapped as `{ value: classificationUri }`. Includes the object number and any other cataloguing identifiers. |

## Creation

| # | Category | Field | Description |
|---|----------|-------|-------------|
| 5 | **Creator** | `creator` | Creator name or attribution statement in English (e.g. "Rembrandt van Rijn"). Falls back to Dutch if no English version exists. |
| 6 | **Date** | `date` | Creation date as a human-readable string (e.g. "1642"). Prefers English date labels; falls back to Dutch or raw year. |
| 7 | **Production details** | `production` | Structured list of all production participants. Each entry includes: `name` (resolved label), `role` (e.g. "painter", "printmaker"), `attributionQualifier` (e.g. "attributed to", "workshop of", or null for primary), `place` (e.g. "Amsterdam"), `actorUri` (link to the artist's Linked Art record), and an optional `personInfo` sub-object with biographical data: `birthYear`, `deathYear` (integers), `gender` (`"male"`, `"female"`, or null), `bio` (biographical note, predominantly in Dutch), and `wikidataId` (e.g. `"Q5598"`). Person info is available for creators whose records could be matched to the Rijksmuseum's actor authority files (~49K with life dates, ~11K with biographical notes). Resolved from vocabulary URIs. |

## Description

| # | Category | Field | Description |
|---|----------|-------|-------------|
| 8 | **Description** | `description` | General descriptive statement about the artwork, classified under AAT [physical description](http://vocab.getty.edu/aat/300435452) (300435452). |
| 9 | **Curatorial narrative** | `curatorialNarrative` | Museum wall text / interpretive narrative, provided in both English (`.en`) and Dutch (`.nl`) where available. Extracted from `subject_of` parts classified as AAT [exhibit scripts](http://vocab.getty.edu/aat/300048722) (300048722) — distinct from the general description above. |

## Physical Characteristics

| # | Category | Field | Description |
|---|----------|-------|-------------|
| 10 | **Object types** | `objectTypes` | What the object is (e.g. "painting", "print", "drawing"). Each entry includes a resolved English `label`, the Rijksmuseum vocabulary `id`, and `equivalents` linking to Getty AAT and Wikidata URIs. |
| 11 | **Materials** | `materials` | What the object is made of (e.g. "oil paint", "canvas"). Same resolved format as object types, with AAT and Wikidata equivalents. |
| 12 | **Technique statement** | `techniqueStatement` | Free-text description of the technique used, classified under AAT [materials/technique description](http://vocab.getty.edu/aat/300435429) (300435429). |
| 13 | **Dimension statement** | `dimensionStatement` | Human-readable dimensions text (e.g. "h 363 cm x w 437 cm"), classified under AAT [dimensions description](http://vocab.getty.edu/aat/300435430) (300435430). |
| 14 | **Structured dimensions** | `dimensions` | Numeric dimension values with resolved type labels (e.g. "height"), `value`, `unit` (e.g. "cm", "kg"), and optional `note`. Type labels are resolved from Rijksmuseum vocabulary URIs. |
| 15 | **Inscriptions** | `inscriptions` | All inscriptions, signatures, marks, or labels on the object, classified under AAT [inscription description](http://vocab.getty.edu/aat/300435414) (300435414). May include multiple entries. |

## Provenance & Context

| # | Category | Field | Description |
|---|----------|-------|-------------|
| 16 | **Provenance** | `provenance` | Ownership history text, classified under AAT [provenance statements](http://vocab.getty.edu/aat/300444174) (300444174). |
| 17 | **Provenance chain** | `provenanceChain` | Parsed provenance events extracted from the free-text provenance field above. Each event includes: `party` (owner/collector name), `transferType` (e.g. sale, gift, bequest, confiscation), `date` (text + year), `location`, `price` (currency + amount), `uncertain` flag, and `gap` flag (indicating an undocumented period). Available for ~48K artworks. Included in the text response but excluded from the structured output schema (too large for some clients). For full provenance querying, use the `search_provenance` tool. |
| 18 | **Credit line** | `creditLine` | Acknowledgement text for the current holding, classified under AAT [acknowledgments](http://vocab.getty.edu/aat/300026687) (300026687; also known as "credit line"). |
| 19 | **Current location** | `location` | Physical location within the museum (e.g. gallery and room identifier). Parsed from `current_location.identified_by`. |
| 20 | **Collection sets** | `collectionSets` | Raw Rijksmuseum vocabulary URIs for the collections this object belongs to (from `member_of`). Also searchable via `search_artwork`'s `collectionSet` filter. |
| 21 | **Collection set labels** | `collectionSetLabels` | Resolved English names for each collection set, with AAT and Wikidata equivalents. |

## Iconography

| # | Category | Field | Description |
|---|----------|-------|-------------|
| 22 | **Subjects** | `subjects` | Iconographic subject annotations, structured into three arrays: `iconclass` ([Iconclass](https://iconclass.org/) concepts — e.g. "civic guard", "group portrait"), `depictedPersons` (named individuals), and `depictedPlaces` (geographical locations). Each entry is a resolved vocabulary term with `label`, `id`, and `equivalents` linking to Iconclass, Getty AAT, or Wikidata URIs. Derived from the VisualItem layer: Object `.shows` > VisualItem `.represents_instance_of_type` (concepts) + `.represents` (persons/places). Not all artworks have subject annotations — objects without them return empty arrays. These subject terms are also searchable across the full collection via `search_artwork`'s `subject`, `iconclass`, `depictedPerson`, and `depictedPlace` filters. |

## Digital & Rights

| # | Category | Field | Description |
|---|----------|-------|-------------|
| 23 | **Web page** | `webPage` | URL of the artwork's page on the Rijksmuseum website, extracted from `subject_of.digitally_carried_by` where the format is `text/html`. |
| 24 | **License** | `license` | Rights/license URI (e.g. CC0 1.0, Public Domain Mark), extracted from `subject_of.subject_to`. Also searchable via `search_artwork`'s `license` filter. |

## Related Works

| # | Category | Field | Description |
|---|----------|-------|-------------|
| 25 | **Related objects** | `relatedObjects` | Links to related artworks, extracted from `attributed_by`. Each entry has a `relationship` label (in English) and an `objectUri` pointing to the related Linked Art record. |

## Bibliography

| # | Category | Field | Description |
|---|----------|-------|-------------|
| 26 | **Bibliography count** | `bibliographyCount` | Number of scholarly references associated with this artwork. This is a count only — use the `get_artwork_bibliography` tool to retrieve full citations in plaintext. Major works like The Night Watch can have over 100 references. |

---
#### Search-only filters

Note: The following `search_artwork` filters are searchable but currently have **no corresponding field** in the `get_artwork_details` response and so don't get shown:

| Filter | Description |
|---|---|
| `birthPlace` | Artist's birth place |
| `deathPlace` | Artist's death place |
| `profession` | Artist's profession (e.g. `painter`, `draughtsman`) |
| `nearPlace` / `nearLat` / `nearLon` | Proximity search by place name or coordinates |
| `aboutActor` | Broader person search (depicted + creator vocabulary) |
| `hasProvenance` | Boolean — restrict to artworks with provenance records |
| `imageAvailable` | Boolean — restrict to artworks with a digital image |

---
## Data Model

These categories are derived from the [Linked Art](https://linked.art/) data model, a community standard for describing cultural heritage objects as JSON-LD. The Rijksmuseum's Linked Open Data APIs serve artwork records in this format. Classification of fields uses URIs from the [Getty Art & Architecture Thesaurus](https://www.getty.edu/research/tools/vocabularies/aat/) (AAT).
