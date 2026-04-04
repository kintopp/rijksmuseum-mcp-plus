# Artwork Metadata Categories

The `get_artwork_details` tool returns up to **24 metadata categories** for each artwork. All data is served from the local vocabulary database (built from periodic harvests of the Rijksmuseum's Linked Art and OAI-PMH APIs). Categories include artwork identification, creation details with biographical data, physical characteristics, provenance with parsed ownership chains, iconographic subjects, and rights information.

Nearly all categories have corresponding search parameters in `search_artwork` — see the [full search parameter reference](search-parameters.md) for filters grouped by type, or the [tool parameters reference](mcp-tool-parameters.md) for all tools.

---

## Identification

| # | Category | Field | Description |
|---|----------|-------|-------------|
| 1 | **Title variants** | `titles` | Title variants with language and qualifier tags. Currently returns an empty array — the vocabulary database stores combined title text (`title_all_text`) but not per-title language/qualifier tags. The primary display title is always available via the `title` field. |
| 2 | **Object number** | `objectNumber` | The museum's inventory number (e.g. `SK-C-5` for The Night Watch). This is the primary identifier used across all tools. |
| 3 | **Persistent identifier** | `persistentId` | Stable handle.net URI for long-term citation (e.g. `http://hdl.handle.net/10934/RM0001.COLLECT.5216`). |
| 4 | **External identifiers** | `externalIds` | Identifier map. Currently returns an empty object — structured identifier extraction requires the Linked Art resolver which is no longer used at runtime. The object number is always available via the `objectNumber` field. |

## Creation

| # | Category | Field | Description |
|---|----------|-------|-------------|
| 5 | **Creator** | `creator` | Creator name or attribution statement in English (e.g. "Rembrandt van Rijn"). Falls back to Dutch if no English version exists. |
| 6 | **Date** | `date` | Creation date as a human-readable string (e.g. "1642"). Prefers English date labels; falls back to Dutch or raw year. |
| 7 | **Production details** | `production` | Structured list of all production participants. Each entry includes: `name` (English label from vocabulary), `role` (e.g. "painter", "printmaker"), `attributionQualifier` (e.g. "attributed to", "workshop of", or null for primary), `place` (e.g. "Amsterdam"), `actorUri` (vocabulary identifier), and an optional `personInfo` sub-object with biographical data: `birthYear`, `deathYear` (integers), `gender` (`"male"`, `"female"`, or null), `bio` (biographical note, predominantly in Dutch), and `wikidataId` (e.g. `"Q5598"`). Person info is available for creators whose records could be matched to the Rijksmuseum's actor authority files (~49K with life dates, ~11K with biographical notes). Production participants are matched positionally (first creator gets first role/qualifier), which covers 95%+ of artworks. |

## Description

| # | Category | Field | Description |
|---|----------|-------|-------------|
| 8 | **Description** | `description` | General descriptive statement about the artwork. |
| 9 | **Curatorial narrative** | `curatorialNarrative` | Museum wall text / interpretive narrative. Currently only the English version (`.en`) is available from the vocabulary database; `.nl` is always null. Distinct from the general description above. |

## Physical Characteristics

| # | Category | Field | Description |
|---|----------|-------|-------------|
| 10 | **Object types** | `objectTypes` | What the object is (e.g. "painting", "print", "drawing"). Each entry includes an English `label` and the vocabulary `id`. |
| 11 | **Materials** | `materials` | What the object is made of (e.g. "oil paint", "canvas"). Same format as object types. |
| 12 | **Technique statement** | `techniqueStatement` | Comma-separated list of technique labels from the vocabulary database (e.g. "oil paint (paint), canvas"). |
| 13 | **Dimension statement** | `dimensionStatement` | Human-readable dimensions text reconstructed from stored height/width values (e.g. "h 363 cm × w 437 cm"). Depth and weight are not available. |
| 14 | **Structured dimensions** | `dimensions` | Numeric dimension values with type (e.g. "height", "width"), `value`, `unit` ("cm"), and `note` (always null — notes require Linked Art resolution). Only height and width are available from the vocabulary database. |
| 15 | **Inscriptions** | `inscriptions` | All inscriptions, signatures, marks, or labels on the object. May include multiple entries (split on ` | ` delimiter from harvest). |

## Provenance & Context

| # | Category | Field | Description |
|---|----------|-------|-------------|
| 16 | **Provenance** | `provenance` | Ownership history text, classified under AAT [provenance statements](http://vocab.getty.edu/aat/300444174) (300444174). |
| 17 | **Provenance chain** | `provenanceChain` | Parsed provenance events extracted from the free-text provenance field above. Each event includes: `party` (owner/collector name), `transferType` (e.g. sale, gift, bequest, confiscation), `date` (text + year), `location`, `price` (currency + amount), `uncertain` flag, and `gap` flag (indicating an undocumented period). Available for ~48K artworks. Included in the text response but excluded from the structured output schema (too large for some clients). For full provenance querying, use the `search_provenance` tool. |
| 18 | **Credit line** | `creditLine` | Acknowledgement text for the current holding, classified under AAT [acknowledgments](http://vocab.getty.edu/aat/300026687) (300026687; also known as "credit line"). |
| 19 | **Current location** | `location` | Physical location within the museum. Currently always null — location data is not harvested into the vocabulary database. |
| 20 | **Collection sets** | `collectionSets` | Raw Rijksmuseum vocabulary URIs for the collections this object belongs to (from `member_of`). Also searchable via `search_artwork`'s `collectionSet` filter. |
| 21 | **Collection set labels** | `collectionSetLabels` | English names for each collection set from the vocabulary database. |

## Iconography

| # | Category | Field | Description |
|---|----------|-------|-------------|
| 22 | **Subjects** | `subjects` | Iconographic subject annotations, structured into three arrays: `iconclass` ([Iconclass](https://iconclass.org/) concepts — e.g. "civic guard", "group portrait"), `depictedPersons` (named individuals), and `depictedPlaces` (geographical locations). Each entry has `label` and `id` from the vocabulary database. Iconclass entries use the notation code as `id`. Not all artworks have subject annotations — objects without them return empty arrays. These subject terms are also searchable across the full collection via `search_artwork`'s `subject`, `iconclass`, `depictedPerson`, and `depictedPlace` filters. |

## Digital & Rights

| # | Category | Field | Description |
|---|----------|-------|-------------|
| 23 | **Web page** | `webPage` | URL of the artwork's page on the Rijksmuseum website (derived from the object number). |
| 24 | **License** | `license` | Rights/license URI (e.g. CC0 1.0, Public Domain Mark) from the `rights_lookup` table. Also searchable via `search_artwork`'s `license` filter. |

## Related Works

| # | Category | Field | Description |
|---|----------|-------|-------------|
| 25 | **Related objects** | `relatedObjects` | Links to related artworks. Currently returns an empty array — related object extraction requires the Linked Art resolver which is no longer used at runtime. |

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

These categories originate from the [Linked Art](https://linked.art/) data model, a community standard for describing cultural heritage objects as JSON-LD. The Rijksmuseum's Linked Open Data APIs serve artwork records in this format during the offline harvest. At runtime, all data is served from the local vocabulary database — no Linked Art resolution is performed. Some fields that require runtime Linked Art resolution (title variants with language tags, external identifiers, current location, related objects) are absent or empty in the current implementation. A future re-harvest could capture these into the database.
