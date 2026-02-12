# Artwork Metadata Categories

The `get_artwork_details` tool returns up to **24 metadata categories** for each artwork. These are divided into two groups internally: 12 base categories parsed directly from the Linked Art JSON-LD object, and 12 enriched categories that require additional vocabulary resolution (resolving Rijksmuseum vocabulary URIs to English labels with links to Getty AAT and Wikidata).

All categories are returned together in a single response.

---

## Identification

| # | Category | Field | Description |
|---|----------|-------|-------------|
| 1 | **Title variants** | `titles` | All known titles with language (`en`, `nl`, `other`) and qualifier (`brief`, `full`, `other`). The brief English title is the primary display title. |
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
| 9 | **Curatorial narrative** | `curatorialNarrative` | Museum wall text / interpretive narrative, provided in both English (`.en`) and Dutch (`.nl`) where available. Extracted from `subject_of` parts classified as AAT "description" (300048722). |

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
| 19 | **Collection sets** | `collectionSets` | Raw Rijksmuseum vocabulary URIs for the collections this object belongs to (from `member_of`). |
| 20 | **Collection set labels** | `collectionSetLabels` | Resolved English names for each collection set, with AAT and Wikidata equivalents. |

## Digital & Rights

| # | Category | Field | Description |
|---|----------|-------|-------------|
| 21 | **Web page** | `webPage` | URL of the artwork's page on the Rijksmuseum website, extracted from `subject_of.digitally_carried_by` where the format is `text/html`. |
| 22 | **License** | `license` | Rights/license URI (e.g. CC0 1.0, Public Domain Mark), extracted from `subject_of.subject_to`. |

## Related Works

| # | Category | Field | Description |
|---|----------|-------|-------------|
| 23 | **Related objects** | `relatedObjects` | Links to related artworks, extracted from `attributed_by`. Each entry has a `relationship` label (in English) and an `objectUri` pointing to the related Linked Art record. |

## Bibliography

| # | Category | Field | Description |
|---|----------|-------|-------------|
| 24 | **Bibliography count** | `bibliographyCount` | Number of scholarly references associated with this artwork. This is a count only — use the `get_artwork_bibliography` tool to retrieve full citations in plaintext or BibTeX format. Major works like The Night Watch can have over 100 references. |

---

## Vocabulary Resolution

Categories marked with resolved terms (object types, materials, production details, collection set labels, structured dimension types) go through **vocabulary resolution**: each Rijksmuseum vocabulary URI is fetched to extract an English label and links to external authority files:

- **Getty AAT** (Art & Architecture Thesaurus) — standardised art terminology
- **Wikidata** — structured linked data

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

All vocabulary URIs for an artwork (~17 on average) are resolved in a single parallel batch.

## Data Model

These categories are derived from the [Linked Art](https://linked.art/) data model, a community standard for describing cultural heritage objects as JSON-LD. The Rijksmuseum's Linked Open Data APIs serve artwork records in this format. Classification of fields uses URIs from the [Getty Art & Architecture Thesaurus](https://www.getty.edu/research/tools/vocabularies/aat/) (AAT).
