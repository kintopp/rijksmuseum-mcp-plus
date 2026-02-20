# Artwork Metadata Categories

The `get_artwork_details` tool returns **24 metadata categories** plus a bibliography count for each artwork. These are divided into groups internally: 12 base categories parsed directly from the Linked Art JSON-LD object, 11 enriched categories (6 from additional static parsing of the same object, 5 from vocabulary resolution — resolving Rijksmuseum vocabulary URIs to English labels with links to Getty AAT, Wikidata, and Iconclass), and 1 subject category derived from the VisualItem layer. The bibliography count is a pointer to the separate `get_artwork_bibliography` tool.

All categories are returned together in a single response.

Several of these categories have corresponding search parameters in `search_artwork`, allowing collection-wide discovery: titles (via `title`/`query`), curatorial narrative (via `narrative`), inscriptions (via `inscription`), provenance (via `provenance`), credit line (via `creditLine`), dimensions (via `minHeight`/`maxHeight`/`minWidth`/`maxWidth`), license (via `license`), collection sets (via `collectionSet`), and subjects (via `subject`, `iconclass`, `depictedPerson`, `depictedPlace`). Production details are searchable via `creator`, `productionPlace`, and `productionRole`.

---

## Identification

| # | Category | Field | Description |
|---|----------|-------|-------------|
| 1 | **Title variants** | `titles` | All known titles with language (`en` or `nl` — the collection is strictly bilingual) and qualifier (`brief`, `full`, or `former`). The brief English title is the primary display title. |
| 2 | **Object number** | `objectNumber` | The museum's inventory number (e.g. `SK-C-5` for The Night Watch). This is the primary identifier used across all tools. |
| 3 | **Persistent identifier** | `persistentId` | Stable handle.net URI for long-term citation (e.g. `http://hdl.handle.net/10934/RM0001.COLLECT.5216`). |
| 4 | **External identifiers** | `externalIds` | All identifiers attached to the object, mapped as `{ value: classificationUri }`. Includes the object number and any other cataloguing identifiers. |

## Creation

| # | Category | Field | Description |
|---|----------|-------|-------------|
| 5 | **Creator** | `creator` | Creator name or attribution statement in English (e.g. "Rembrandt van Rijn"). Falls back to Dutch if no English version exists. |
| 6 | **Date** | `date` | Creation date as a human-readable string (e.g. "1642"). Prefers English date labels; falls back to Dutch or raw year. |
| 7 | **Production details** | `production` | Structured list of all production participants. Each entry includes: `name` (resolved label), `role` (e.g. "painter", "printmaker"), `place` (e.g. "Amsterdam"), and `actorUri` (link to the artist's Linked Art record). Resolved from vocabulary URIs. |

## Description

| # | Category | Field | Description |
|---|----------|-------|-------------|
| 8 | **Description** | `description` | General descriptive statement about the artwork, classified under AAT "description" (300435452). |
| 9 | **Curatorial narrative** | `curatorialNarrative` | Museum wall text / interpretive narrative, provided in both English (`.en`) and Dutch (`.nl`) where available. Extracted from `subject_of` parts classified as AAT "narrative" (300048722) — distinct from the general description (300435452) above. |

## Physical Characteristics

| # | Category | Field | Description |
|---|----------|-------|-------------|
| 10 | **Object types** | `objectTypes` | What the object is (e.g. "painting", "print", "drawing"). Each entry includes a resolved English `label`, the Rijksmuseum vocabulary `id`, and `equivalents` linking to Getty AAT and Wikidata URIs. |
| 11 | **Materials** | `materials` | What the object is made of (e.g. "oil paint", "canvas"). Same resolved format as object types, with AAT and Wikidata equivalents. |
| 12 | **Technique statement** | `techniqueStatement` | Free-text description of the technique used (AAT 300435429). |
| 13 | **Dimension statement** | `dimensionStatement` | Human-readable dimensions text (e.g. "h 363 cm x w 437 cm"). Classified under AAT "dimensions statement" (300435430). |
| 14 | **Structured dimensions** | `dimensions` | Numeric dimension values with resolved type labels (e.g. "height"), `value`, `unit` (e.g. "cm", "kg"), and optional `note`. Type labels are resolved from Rijksmuseum vocabulary URIs. |
| 15 | **Inscriptions** | `inscriptions` | All inscriptions, signatures, marks, or labels on the object. Classified under AAT "inscriptions" (300435414). May include multiple entries. |

## Provenance & Context

| # | Category | Field | Description |
|---|----------|-------|-------------|
| 16 | **Provenance** | `provenance` | Ownership history text, classified under AAT "provenance statement" (300444174). |
| 17 | **Credit line** | `creditLine` | Acknowledgement text for the current holding (AAT 300026687). |
| 18 | **Current location** | `location` | Physical location within the museum (e.g. gallery and room identifier). Parsed from `current_location.identified_by`. |
| 19 | **Collection sets** | `collectionSets` | Raw Rijksmuseum vocabulary URIs for the collections this object belongs to (from `member_of`). Also searchable via `search_artwork`'s `collectionSet` filter. |
| 20 | **Collection set labels** | `collectionSetLabels` | Resolved English names for each collection set, with AAT and Wikidata equivalents. |

## Iconography

| # | Category | Field | Description |
|---|----------|-------|-------------|
| 21 | **Subjects** | `subjects` | Iconographic subject annotations, structured into three arrays: `iconclass` ([Iconclass](https://iconclass.org/) concepts — e.g. "civic guard", "group portrait"), `depictedPersons` (named individuals), and `depictedPlaces` (geographical locations). Each entry is a resolved vocabulary term with `label`, `id`, and `equivalents` linking to Iconclass, Getty AAT, or Wikidata URIs. Derived from the VisualItem layer: Object `.shows` > VisualItem `.represents_instance_of_type` (concepts) + `.represents` (persons/places). Not all artworks have subject annotations — objects without them return empty arrays. These subject terms are also searchable across the full collection via `search_artwork`'s `subject`, `iconclass`, `depictedPerson`, and `depictedPlace` filters. |

## Digital & Rights

| # | Category | Field | Description |
|---|----------|-------|-------------|
| 22 | **Web page** | `webPage` | URL of the artwork's page on the Rijksmuseum website, extracted from `subject_of.digitally_carried_by` where the format is `text/html`. |
| 23 | **License** | `license` | Rights/license URI (e.g. CC0 1.0, Public Domain Mark), extracted from `subject_of.subject_to`. Also searchable via `search_artwork`'s `license` filter. |

## Related Works

| # | Category | Field | Description |
|---|----------|-------|-------------|
| 24 | **Related objects** | `relatedObjects` | Links to related artworks, extracted from `attributed_by`. Each entry has a `relationship` label (in English) and an `objectUri` pointing to the related Linked Art record. |

## Bibliography

| # | Category | Field | Description |
|---|----------|-------|-------------|
| 25 | **Bibliography count** | `bibliographyCount` | Number of scholarly references associated with this artwork. This is a count only — use the `get_artwork_bibliography` tool to retrieve full citations in plaintext. Major works like The Night Watch can have over 100 references. |

---

## Vocabulary Resolution

Categories marked with resolved terms (object types, materials, production details, collection set labels, structured dimension types, and subjects) go through **vocabulary resolution**: each Rijksmuseum vocabulary URI is fetched to extract an English label and links to external authority files:

- **Getty AAT** (Art & Architecture Thesaurus) — standardised art terminology
- **Wikidata** — structured linked data
- **Iconclass** — iconographic classification system for cultural heritage (subject annotations only)

For example, a material URI like `https://id.rijksmuseum.nl/vocabulary/material/13438` resolves to:

```json
{
  "id": "https://id.rijksmuseum.nl/vocabulary/material/13438",
  "label": "oil paint",
  "equivalents": {
    "aat": "http://vocab.getty.edu/aat/300015050",
    "wikidata": "http://www.wikidata.org/entity/Q296955"
  }
}
```

Subject URIs follow the same pattern but may include an `iconclass` equivalent instead of (or in addition to) AAT:

```json
{
  "id": "https://id.rijksmuseum.nl/vocabulary/subject/12345",
  "label": "civic guard",
  "equivalents": {
    "iconclass": "http://iconclass.org/45(+26)"
  }
}
```

All vocabulary and subject URIs for an artwork are resolved in a single parallel batch.

## Data Model

These categories are derived from the [Linked Art](https://linked.art/) data model, a community standard for describing cultural heritage objects as JSON-LD. The Rijksmuseum's Linked Open Data APIs serve artwork records in this format. Classification of fields uses URIs from the [Getty Art & Architecture Thesaurus](https://www.getty.edu/research/tools/vocabularies/aat/) (AAT).
