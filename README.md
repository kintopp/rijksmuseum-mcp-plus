# rijksmuseum-mcp+

An AI-powered ([Model Context Protocol](https://modelcontextprotocol.io/)) (MCP) interface to the [Rijksmuseum](https://www.rijksmuseum.nl/) collection. Search artworks, explore their history, view high-resolution images, and access scholarly references — all through natural conversation.

> This project was inspired by [@r-huijts/rijksmuseum-mcp](https://github.com/r-huijts/rijksmuseum-mcp), the original Rijksmuseum MCP server which used the museum's now unsupported REST API. 

rijksmuseum-mcp+ is a ground-up rewrite which draws on the Rijksmuseum's [Linked Open Data APIs](https://data.rijksmuseum.nl/), the [Linked Art](https://linked.art/) and [Europeana Data Model](https://pro.europeana.eu/page/edm-documentation) (EDM) standards and also adds new features (such as an [inline, interactive image viewer](docs/swan_sm.jpg) made possible by recent enhancements to the MCP standard.

## Quick Start

The easiest way to try rijksmuseum-mcp+ is with [Claude Desktop](https://claude.com/download) or [claude.ai](https://claude.ai) and the hosted version of the MCP server. But note that both require a Pro or better [subscription](https://claude.com/pricing). 
```
https://rijksmuseum-mcp-plus-production.up.railway.app/mcp
```
Goto Settings → Connectors → Add custom connector → paste the URL above. For more details, see Anthropic's [instructions](https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp#h_3d1a65aded). It is also compatible with many open-source clients, such as [Jan.ai](https://jan.ai) which don't require a paid subscription (either via an API key or with the use of a local model).

### Example Queries

"Show me a drawing by Gesina ter Borch"  
"Find Pieter Saenredam's paintings"  
"Show me woodcuts by Hokusai"  
"Find artworks depicting the Raid on the Medway"  
"What paintings depict Amalia van Solms?"  
"Search for winter landscapes from the 17th century"  
"Give me a list of the Rijksmuseum's curated collections"  
"Show me works about the sense of smell"  
"Find all works made in Haarlem with the mezzotint technique"  
"Find artworks with inscriptions mentioning 'fecit'"  
"Which works have the Vereniging Rembrandt in their credit line?"  
"Find artworks whose provenance mentions Napoleon"  
"Show me prints made after paintings by other artists"  
"What objects were acquired as bequests?"  

## Searchable metadata categories

#### Rijksmuseum Search API

These parameters query the [Rijksmuseum Search API](https://data.rijksmuseum.nl/) directly. The API uses [Linked Art](https://linked.art/) JSON-LD, with field classifications drawn from the [Getty Art & Architecture Thesaurus](https://www.getty.edu/research/tools/vocabularies/aat/) (AAT). 

| Search Parameter | What it queries | Notes |
|---|---|---|
| `query` | Artwork title | ~837K artworks. Maps to the Search API's `title` parameter. Functionally identical to the `title` filter below — both perform the same bag-of-words token match on brief titles. Provided as a convenience alias for exploratory queries where the user thinks of it as a general search term. |
| `title` | Artwork title | ~826K artworks with titles. Same Search API `title` parameter as `query` above. Takes precedence when both are supplied. Matches against brief titles classified as [AAT 300417207](http://vocab.getty.edu/aat/300417207). Note: the Search API only indexes brief titles — full, former, and other title variants are not searched. |
| `creator` | Artist or maker name | ~510K artworks, ~21K unique names. Matches against the `produced_by.part[].carried_out_by` field. Use the museum's canonical name form (e.g. "Rembrandt van Rijn", not "Rembrandt Harmensz. van Rijn"). Variant historical spellings may not match — the LLM can help resolve these. |
| `creationDate` | Year or date range of creation | ~628K artworks with dates (3000 BCE–2025). Supports wildcards: `1642` (exact year), `164*` (1640–1649), `16*` (1600–1699). Matches the `produced_by.timespan` field. Cannot be combined with vocabulary-backed filters in a single query; use `get_artwork_details` to verify dates on vocab search results. |
| `description` | Free-text description of the artwork | ~292K artworks with descriptions. Matches the `referred_to_by` field classified as [AAT 300435452](http://vocab.getty.edu/aat/300435452) (description). Cannot be combined with vocabulary-backed filters. |
| `type` | Object type | 4,385 terms. Values follow Rijksmuseum vocabulary terms (e.g. `painting`, `print`, `drawing`, `photograph`, `sculpture`). Terms resolve to [AAT](https://www.getty.edu/research/tools/vocabularies/aat/) equivalents — e.g. "painting" → [AAT 300033618](http://vocab.getty.edu/aat/300033618). |
| `material` | Material or support | [725 terms](docs/vocabulary-materials.md). Values follow Rijksmuseum vocabulary terms (e.g. `canvas`, `paper`, `panel`, `oil paint`, `copper`). Terms resolve to AAT equivalents — e.g. "oil paint" → [AAT 300015050](http://vocab.getty.edu/aat/300015050). |
| `technique` | Artistic technique | [964 terms](docs/vocabulary-techniques.md). Values follow Rijksmuseum vocabulary terms (e.g. `oil painting`, `etching`, `engraving`, `mezzotint`, `woodcut`). Terms resolve to AAT equivalents — e.g. "etching" → [AAT 300053241](http://vocab.getty.edu/aat/300053241). |
| `aboutActor` | Person depicted or referenced | ~1.3K artworks with actor references. Searches free-text references to persons. Less comprehensive than the vocabulary-backed `depictedPerson` filter (~217K artworks), which draws on controlled name authority records. Use `depictedPerson` when available. |
| `imageAvailable` | Whether a digital image exists | Boolean filter (`true`/`false`). Useful for restricting results to artworks that can be examined via `get_artwork_image`. ~728K artworks have public domain images. |

#### Vocabulary database

These parameters draw on a pre-built vocabulary database (~2.6 GB SQLite, [downloadable from releases](https://github.com/kintopp/rijksmuseum-mcp-plus/releases)) derived from OAI-PMH harvests and Linked Art resolution of the full Rijksmuseum collection. The database maps 149,000 controlled vocabulary terms to 832,000 artworks via 12.8 million mappings, enabling structured search by iconography, geography, biography, text content, and physical dimensions.

Vocabulary-backed filters can be freely combined with each other (e.g. `depictedPerson` + `productionPlace` + `type`), but cannot (in this version) be combined with `creationDate`, `description`, `query`, `title`, or `imageAvailable` in a single query. To filter vocabulary results by date, retrieve the results first and then check dates via `get_artwork_details`.

| Search Parameter | What it queries | Notes |
|---|---|---|
| `subject` | Iconographic subject labels | ~108K terms, ~722K artworks. Searches [Iconclass](https://iconclass.org/) subject terms by label text (e.g. `vanitas`, `winter landscape`, `civic guard`). Uses word-boundary matching — `cat` matches "cat" but not "Catharijnekerk". Iconclass is the standard iconographic classification system for cultural heritage; its hierarchical notation encodes subjects from broad themes to specific scenes. See the [Iconclass browser](https://iconclass.org/en) for the full hierarchy. |
| `iconclass` | Iconclass notation code | ~25K notation codes. Exact match on the alphanumeric [Iconclass](https://iconclass.org/) notation (e.g. `34B11` for dogs, `73D82` for the Crucifixion, `45(+26)` for civic guard pieces). Use the [Iconclass browser](https://iconclass.org/en) to find notation codes. More precise than `subject` label search. |
| `depictedPerson` | Named person depicted | ~60K persons, ~217K artworks. Searches controlled name authority records for persons represented in the artwork (e.g. `Willem van Oranje`, `Maria Stuart`). Drawn from the Linked Art `shows.represents` field on VisualItem entities. More comprehensive than `aboutActor` because it uses the structured vocabulary rather than free-text matching. |
| `depictedPlace` | Named place depicted | 20,689 places. Searches controlled place names for locations shown in the artwork (e.g. `Amsterdam`, `Batavia`). Drawn from the Linked Art `shows.represents` field. Includes 20,828 geocoded places with coordinates from [Getty TGN](https://www.getty.edu/research/tools/vocabularies/tgn/), [Wikidata](https://www.wikidata.org/), [GeoNames](https://www.geonames.org/), and the [World Historical Gazetteer](https://whgazetteer.org/). Distinct from `productionPlace` — a painting *depicting* Amsterdam may have been made in Haarlem. |
| `productionPlace` | Place where the work was made | 9,002 places. Searches controlled place names for production locations (e.g. `Delft`, `Antwerp`, `Kyoto`). Drawn from the Linked Art `produced_by.part[].took_place_at` field. Same geocoded place vocabulary as `depictedPlace`. Note: may not match every `production[].place` value in artwork details, as the vocabulary database and live resolution can differ slightly. |
| `birthPlace` | Artist's place of birth | ~2K places, ~196K artworks. Searches biographical place data for the creator's birth location (e.g. `Leiden`, `Haarlem`). Derived from EDM creator records in the OAI-PMH harvest. Search-only: not returned by `get_artwork_details` (use it to *find* artists from a place, then examine their works individually). |
| `deathPlace` | Artist's place of death | ~1.3K places, ~180K artworks. Searches biographical place data for the creator's death location (e.g. `Amsterdam`, `Paris`). Same source and limitations as `birthPlace`. Useful for tracking artist migration patterns — compare `birthPlace: "Antwerp"` with `deathPlace: "Amsterdam"` to find Flemish artists who moved north. |
| `profession` | Artist's profession | [600 terms](docs/vocabulary-professions.md), bilingual (English and Dutch). Examples: `painter`, `draughtsman`, `printmaker`, `photographer`, `sculptor`, `architect`, `goldsmith`. Try the Dutch term if English returns no results (e.g. `fotograaf` instead of `photographer`). Search-only: not returned by `get_artwork_details`. Useful for finding artists by role rather than name — e.g. `profession: "architect"` with `productionPlace: "Amsterdam"`. |
| `collectionSet` | Curated collection set name | [192 sets](docs/vocabulary-collection-sets.md) defined by Rijksmuseum curators — thematic groupings, exhibition selections, and scholarly collections (e.g. `Rembrandt`, `Japanese`, `Delftware`). Matches by name substring. Also discoverable via the `list_curated_sets` tool, which returns set identifiers for use with `browse_set`. |
| `license` | Rights/license designation | [3 values](docs/vocabulary-license.md): `publicdomain` ([Public Domain Mark 1.0](http://creativecommons.org/publicdomain/mark/1.0/) — 728K works), `zero` ([CC0 1.0](http://creativecommons.org/publicdomain/zero/1.0/) — 1.7K works), `InC` ([In Copyright](http://rightsstatements.org/vocab/InC/1.0/) — 101K works). Uses [RightsStatements.org](https://rightsstatements.org/) and Creative Commons URIs. Essential for researchers planning publications or digital projects. |
| `inscription` | Transcribed text on the object surface | Full-text search across ~500K artworks with transcribed inscriptions. Classified under [AAT 300435414](http://vocab.getty.edu/aat/300435414) (inscriptions). Covers signatures, dates, dedications, mottoes, stamps, and labels physically present on the object. Examples: `fecit` (Latin "made [this]"), `Rembrandt f.`, `anno 1642`. |
| `provenance` | Ownership history text | Full-text search across ~48K artworks with recorded provenance. Classified under [AAT 300444174](http://vocab.getty.edu/aat/300444174) (provenance statement). Covers auction records, dealer transactions, collection transfers, and restitution notes. Examples: `Napoleon`, `Six`, `Rothschild`, `Goudstikker`. Coverage is weighted toward paintings and major works. |
| `creditLine` | Acquisition mode and acknowledgement | Full-text search across ~358K artworks with credit lines. Classified under [AAT 300026687](http://vocab.getty.edu/aat/300026687) (credit line). Records how the museum acquired the work — purchase, bequest, gift, loan, state allocation. Examples: `purchase`, `bequest`, `Vereniging Rembrandt`, `Drucker`. |
| `narrative` | Curatorial narrative (museum wall text) | Full-text search across ~14K artworks with curatorial narratives. Classified under [AAT 300048722](http://vocab.getty.edu/aat/300048722) (essays). Harvested from the Linked Art `subject_of` field — distinct from the Search API's `description` parameter (AAT 300435452), which queries a different, broader text field via `referred_to_by`. These are interpretive, art-historical texts written by museum curators — equivalent to the wall labels in the galleries. Available in English and/or Dutch. |
| `productionRole` | Role in production | [176 terms](docs/vocabulary-production-roles.md), bilingual. Specifies the role an actor played in creating the work — distinct from `profession` (what the person *was*) vs. production role (what they *did* for this specific work). Key terms: `print maker` (382K mappings), `publisher` (185K), `printer` (67K), `after painting by` (46K), `after design by` (60K). Enables questions like "find prints published by Claes Jansz. Visscher" or "find works made after paintings by other artists". |
| `minHeight` / `maxHeight` | Height range in centimetres | Numeric range filter on structured dimensions classified under [AAT 300055644](http://vocab.getty.edu/aat/300055644) (height). Values are in centimetres. Use to find objects of specific sizes — e.g. miniature portraits (`maxHeight: 15`), monumental paintings (`minHeight: 200`). |
| `minWidth` / `maxWidth` | Width range in centimetres | Numeric range filter on structured dimensions classified under [AAT 300055647](http://vocab.getty.edu/aat/300055647) (width). Values are in centimetres. Combine with height for aspect ratio or standard format research — e.g. panel size clusters in Dutch workshop practice. |

#### Geographic proximity search

| Search Parameter | What it queries | Notes |
|---|---|---|
| `nearPlace` | Artworks related to places near a named location | Searches both depicted and production places within a radius of the named location (e.g. `nearPlace: "Leiden"`). Uses the Haversine formula against 20,828 geocoded places with coordinates from [Getty TGN](https://www.getty.edu/research/tools/vocabularies/tgn/), [Wikidata](https://www.wikidata.org/), [GeoNames](https://www.geonames.org/), and the [World Historical Gazetteer](https://whgazetteer.org/). |
| `nearLat` | Latitude for coordinate-based proximity search | Use with `nearLon` as an alternative to `nearPlace` for searching near arbitrary locations (e.g. `nearLat: 52.37, nearLon: 4.89`). Range: -90 to 90. If both `nearLat`/`nearLon` and `nearPlace` are provided, coordinates take precedence. |
| `nearLon` | Longitude for coordinate-based proximity search | Use with `nearLat`. Range: -180 to 180. |
| `nearPlaceRadius` | Search radius in kilometres | Default: 25 km, range: 0.1–500 km. Controls the geographic scope of `nearPlace` and `nearLat`/`nearLon` queries. |

### Non-searchable metadata categories

These fields are returned by `get_artwork_details` (which provides [24 metadata categories](docs/metadata-categories.md) per artwork) but cannot be used as search filters.

| Field | What it contains | Notes |
|---|---|---|
| Object number (`objectNumber`) | Museum inventory number (e.g. `SK-C-5`) | The primary identifier across all tools — use it with `get_artwork_details`, `get_artwork_bibliography`, and `get_artwork_image`. Format encodes the collection: `SK` = paintings (*Schilderijen Kabinet*), `RP` = prints (*Rijksprentenkabinet*), `BK` = sculpture/applied art (*Beeldhouwkunst*), `NG` = modern acquisitions (*Nagelaten Gift*). |
| Persistent identifier (`persistentId`) | Stable [Handle](https://www.handle.net/) URI | Permanent citation link (e.g. `http://hdl.handle.net/10934/RM0001.COLLECT.5216`). Unlike web URLs, Handle URIs are guaranteed to resolve long-term. Use in publications and bibliographies. |
| External identifiers (`externalIds`) | All cataloguing identifiers | Mapped as `{ value: classificationUri }`. Includes the object number and any additional identifiers assigned during cataloguing. |
| Title variants (`titles`) | All known titles with language and type | Each entry has a language (`en` or `nl` — the collection is strictly bilingual) and qualifier (`brief`, `full`, or `former`). Up to 6 variants per artwork. The brief English title is the primary display title; ~71% of artworks have Dutch-only titles. Classified under [AAT 300417207](http://vocab.getty.edu/aat/300417207) (brief title), [AAT 300417200](http://vocab.getty.edu/aat/300417200) (full title), and `rm:22015528` (former title). Note: the Search API's `query`/`title` parameters only match against brief titles; full and former titles are not indexed. |
| Curatorial narrative (`curatorialNarrative`) | Museum wall text in English and/or Dutch | Interpretive art-historical context written by curators. Harvested from the Linked Art `subject_of` field, classified under [AAT 300048722](http://vocab.getty.edu/aat/300048722) (essay). Distinct from `description` (Search API), which comes from `referred_to_by` and is classified under [AAT 300435452](http://vocab.getty.edu/aat/300435452). Searchable via the `narrative` filter above (~14K artworks), but the full text is only returned here. |
| Production details (`production`) | Structured creator, role, and place data | Each participant entry includes `name` (resolved label), `role` (e.g. "painter"), `place` (e.g. "Amsterdam"), and `actorUri` (link to the artist's Linked Art record). Creator, place, and role are individually searchable via the filters above; the structured production record provides the full context. |
| Object types (`objectTypes`) | What the object is, with authority links | Resolved vocabulary terms (e.g. "painting", "print") with equivalents linking to [Getty AAT](https://www.getty.edu/research/tools/vocabularies/aat/) and [Wikidata](https://www.wikidata.org/). |
| Materials (`materials`) | What the object is made of, with authority links | Resolved vocabulary terms (e.g. "oil paint", "canvas") with AAT and Wikidata equivalents. |
| Technique statement (`techniqueStatement`) | Free-text technique description | Classified under [AAT 300435429](http://vocab.getty.edu/aat/300435429) (technique statement). |
| Dimension statement (`dimensionStatement`) | Human-readable dimensions text | Classified under [AAT 300435430](http://vocab.getty.edu/aat/300435430) (dimensions statement). For numeric filtering, use `minHeight`/`maxHeight`/`minWidth`/`maxWidth` above. |
| Structured dimensions (`dimensions`) | Numeric dimension values | Each entry has a resolved type label (e.g. "height"), numeric `value`, `unit` (cm, mm, kg, g, m), and optional `note`. Units map to AAT concepts — e.g. cm → [AAT 300379098](http://vocab.getty.edu/aat/300379098). |
| Subjects (`subjects`) | Iconographic annotations | Three arrays: `iconclass` ([Iconclass](https://iconclass.org/) concepts), `depictedPersons` (named individuals), `depictedPlaces` (geographic locations). Each entry is a resolved term with `label`, `id`, and `equivalents` linking to Iconclass, AAT, or Wikidata URIs. Derived from the Linked Art VisualItem layer. Searchable via `subject`, `iconclass`, `depictedPerson`, and `depictedPlace` filters above. |
| Provenance (`provenance`) | Ownership history text | Classified under [AAT 300444174](http://vocab.getty.edu/aat/300444174). Searchable via the `provenance` filter above; the full text is returned here. |
| Credit line (`creditLine`) | Acquisition acknowledgement | Classified under [AAT 300026687](http://vocab.getty.edu/aat/300026687). Searchable via the `creditLine` filter above; the full text is returned here. |
| Inscriptions (`inscriptions`) | Text transcribed from the object surface | Classified under [AAT 300435414](http://vocab.getty.edu/aat/300435414). May include multiple entries (signatures, dates, labels, stamps). Searchable via the `inscription` filter above. |
| License (`license`) | Rights/license URI | CC0, Public Domain Mark, or In Copyright. Also searchable via the `license` filter above. |
| Collection sets (`collectionSets`, `collectionSetLabels`) | Curatorial groupings | Raw vocabulary URIs and resolved English labels with AAT and Wikidata equivalents. Also searchable via `collectionSet` above and discoverable via `list_curated_sets`. |
| Current location (`location`) | Gallery and room within the museum | Physical location identifier parsed from Linked Art `current_location`. Indicates whether the work is currently on display and where. |
| Web page (`webPage`) | Rijksmuseum website URL | Link to the artwork's page on [rijksmuseum.nl](https://www.rijksmuseum.nl/en/collection). |
| Related objects (`relatedObjects`) | Links to associated artworks | Each entry has a `relationship` label (in English) and an `objectUri` pointing to the related Linked Art record. Pass URIs to `resolve_uri` to retrieve full details of the related object. |
| Bibliography count (`bibliographyCount`) | Number of scholarly references | A count only — use `get_artwork_bibliography` for full citations. Major works can have 100+ references (e.g. *The Night Watch*). |

## Example Research Scenarios

- [Searching the Collection](#searching-the-collection)
- [Subject and Iconographic Search](#subject-and-iconographic-search)
- [Artwork Details and Metadata](#artwork-details-and-metadata)
- [Bibliographic References](#bibliographic-references)
- [High-Resolution Images](#high-resolution-images)
- [Artist Timelines](#artist-timelines)
- [Curated Sets](#curated-sets)
- [Collection Changes](#collection-changes)
- [The LLM fills in the gaps](#the-llm-fills-in-the-gaps)

### Searching the Collection

The `search_artwork` tool combines filters — creator, type, material, technique, date (with wildcards), description, depicted person (`aboutActor`), and image availability — that can be composed to answer questions no single filter handles alone.

#### 1. Mapping an Artist's Output Across Media

**Research question:** What is the actual distribution of Rembrandt's works in the Rijksmuseum across painting, printmaking, and drawing — and how does this challenge popular perceptions of him as primarily a painter?

**How the tools enable it:**
- `search_artwork` with `creator: "Rembrandt"` and `compact: true` for a total count
- Repeat with `type: "painting"`, then `type: "print"`, then `type: "drawing"` to get counts per medium
- Follow up with `get_artwork_details` on selected works from each category

**Why it matters:** The Rijksmuseum holds ~30 Rembrandt paintings but over 1,000 prints and hundreds of drawings. Most students encounter Rembrandt through a handful of iconic canvases. Seeing the actual proportions reframes his practice as fundamentally graphic.

#### 2. Material Culture Beyond the Canon

**Research question:** What is the scope of the Rijksmuseum's non-European holdings? How are Indonesian, Japanese, Chinese, and Indian objects distributed across media, and where were they produced?

**How the tools enable it:**
- `search_artwork` with `productionPlace: "Japan"` and `compact: true`, then repeat for `"China"`, `"Java"`, `"India"` to map the geographic distribution
- Cross-reference with `type` filters to distinguish ceramics, textiles, prints, and metalwork
- Use `depictedPlace` to find works that *represent* these places, regardless of where they were made — separating objects produced in Asia from European depictions of Asia
- Use `imageAvailable: true` to assess digitisation coverage

**Why it matters:** The Rijksmuseum positions itself as a museum of Dutch art *and* history, which includes centuries of global trade. The combination of `productionPlace` and `depictedPlace` enables a crucial distinction: objects *from* Asia versus European images *of* Asia.

#### 3. Tracking the Adoption of Artistic Techniques

**Research question:** When did etching overtake engraving as the dominant printmaking technique in the Netherlands, and how do lesser-known techniques — mezzotint, aquatint, woodcut — appear in the Rijksmuseum collection over time?

**How the tools enable it:**
- `search_artwork` with `type: "print"`, `technique: "engraving"`, `creationDate: "15*"`, `compact: true` — repeat for `"16*"` and `"17*"`
- Compare with `technique: "etching"` across the same date ranges
- Extend to `technique: "mezzotint"`, `"woodcut"`, `"aquatint"` to map the full technical repertoire
- Use `get_artwork_details` on selected works from each technique to examine materials and production context

**Why it matters:** The shift from engraving to etching is a defining transition in European printmaking. Date-wildcard queries make this transition quantifiable at collection scale, and the results reveal whether the Rijksmuseum's holdings reflect the standard chronology or complicate it.

---

### Subject and Iconographic Search

`search_artwork` includes seventeen database-backed filters — `subject`, `iconclass`, `depictedPerson`, `depictedPlace`, `productionPlace`, `birthPlace`, `deathPlace`, `profession`, `collectionSet`, `license`, `inscription`, `provenance`, `creditLine`, `narrative`, `productionRole`, and dimension ranges — drawn from a pre-built vocabulary database of 149,000 controlled terms mapped to 831,000 artworks via 12.8 million mappings. These enable searches by what is depicted, where it was made, who made it (including biographical attributes and production roles), what is written on it, what the museum says about it, and how large it is.

#### 4. Mapping the Visual Rhetoric of the Stadholders

**Research question:** How were the successive Princes of Orange visually represented across different media, and can we trace shifts in propaganda strategy from Maurice to William III?

**How the tools enable it:**
- `search_artwork` with `depictedPerson: "Maurice"` and `compact: true`, then repeat for `"Frederick Henry"`, `"William II"`, `"William III"`
- For each stadholder, filter by `type: "painting"` vs `type: "print"` vs `type: "medal"` to map the media distribution
- Use `get_artwork_details` on selected results to compare how each ruler was staged — martial, dynastic, classical

**Why it matters:** The Orange-Nassau dynasty used visual media strategically, but the balance between painted portraits (diplomatic gifts, court display) and printed imagery (popular circulation, political pamphlets) shifted across generations. A depicted-person search makes this media strategy empirically visible.

#### 5. Production Geography and the Network of Printmaking Cities

**Research question:** Which cities dominate the Rijksmuseum's printmaking holdings, and how do the principal printmakers differ between Haarlem, Amsterdam, Leiden, and Antwerp?

**How the tools enable it:**
- `search_artwork` with `type: "print"`, `productionPlace: "Haarlem"` to get all Haarlem-produced prints — repeat for `"Amsterdam"`, `"Leiden"`, `"Antwerp"`
- Compare total counts to map the relative weight of each centre in the collection
- Use `get_artwork_details` on a sample from each city to identify the key printmakers and date ranges — production place and date are not searchable together, so details must be checked per work
- Cross-reference with `profession: "printmaker"` and `birthPlace: "Haarlem"` to distinguish artists born in a city from those who merely worked there

**Why it matters:** Haarlem was the dominant centre of printmaking in the late 16th century until Amsterdam overtook it in the 17th. Production-place queries reveal the relative weight of each city in the collection, and comparing the leading printmakers at each centre surfaces secondary figures whose role may have been overlooked.

#### 6. Iconographic Traditions Across Media

**Research question:** How does the iconography of *vanitas* function differently in painting versus printmaking? Do the same symbolic conventions — skulls, hourglasses, extinguished candles, musical instruments — appear with equal frequency in both media?

**How the tools enable it:**
- `search_artwork` with `subject: "vanitas"` and `type: "painting"` to get all vanitas paintings — repeat with `type: "print"` to compare
- Use `get_artwork_details` on a sample from each group to compare which specific vanitas motifs appear, and to check dates for chronological patterns (subject and date are not searchable together)
- Cross-reference with `creator` to identify whether certain artists specialised in vanitas imagery across media or confined it to one

**Why it matters:** A subject-based search that crosses media boundaries enables systematic comparison of how a single iconographic tradition was adapted to different formats — the intimate painted still life versus the widely circulated print — without requiring extensive manual catalogue work.

#### 7. Colonial Visual Culture: Representing the East Indies

**Research question:** How did Dutch artists represent the East Indies, and does the production location — metropole versus colony — correlate with differences in how these places were depicted?

**How the tools enable it:**
- `search_artwork` with `depictedPlace: "Batavia"` to find all works showing the colonial capital
- Extend to `depictedPlace: "Java"`, `"Sumatra"`, `"Dutch East Indies"`
- Cross-reference with `productionPlace: "Amsterdam"` vs `productionPlace: "Batavia"` to separate metropolitan and colonial viewpoints
- Use `get_artwork_details` to examine medium, date, and descriptive context

**Why it matters:** Dutch colonial visual culture is an active area of research, but the question of *where* images of the colonies were produced is methodologically significant. The combination of `depictedPlace` and `productionPlace` makes this metropolitan-colonial distinction searchable for the first time at collection scale.

---

### Artwork Details and Metadata

`get_artwork_details` returns [24 metadata categories](docs/metadata-categories.md) per artwork — far more than a typical museum search interface exposes. This depth enables object-level research that would otherwise require on-site catalogue consultation.

#### 8. Provenance as Historical Evidence

**Research question:** What can the ownership history of Vermeer's *The Milkmaid* tell us about the painting's changing reputation from the 17th century to the present?

**How the tools enable it:**
- `get_artwork_details` with `objectNumber: "SK-A-2344"` returns the full provenance chain
- Cross-reference owners and sale dates with the bibliography via `get_artwork_bibliography`
- Use `get_artwork_image` to examine the painting alongside the provenance narrative

**Why it matters:** When a work changes hands at auction, is gifted to a museum, or passes through a dealer's inventory, each transaction reflects contemporary taste and valuation. The structured provenance data makes these transactions traceable.

#### 9. Reading Inscriptions as Primary Sources

**Research question:** What textual information did Pieter Saenredam embed in his church interior paintings, and do the inscriptions serve documentary, devotional, or artistic purposes?

**How the tools enable it:**
- `search_artwork` with `inscription: "Saenredam"` to find all works with inscriptions mentioning the artist — or use `creator: "Pieter Saenredam"` and `type: "painting"` for his full oeuvre
- `get_artwork_details` on each result — the inscriptions category captures text transcribed from the painting surface
- Compare inscription content across works: dates, church names, biblical texts, artist signatures

**Why it matters:** Saenredam's inscriptions are unusually rich — they often include the exact date he made the preliminary drawing and the date he completed the painting, sometimes years apart. The `inscription` filter enables full-text search across ~500,000 artworks with transcribed inscriptions, making this information discoverable collection-wide.

#### 10. Dimensions as Evidence for Workshop Practice

**Research question:** Were there standard panel sizes used in Dutch workshops? Can we identify clusters of dimensions that suggest pre-prepared supports from panel makers?

**How the tools enable it:**
- `search_artwork` with `type: "painting"`, `material: "panel"`, and dimension ranges (e.g. `minHeight: 40`, `maxHeight: 50`, `minWidth: 30`, `maxWidth: 40`) to find panels of a specific size cluster
- Compare across size ranges to identify recurring dimensions that suggest standard panel formats
- `get_artwork_details` on results to check exact measurements, creator, date, and production context — dimension ranges and date are not searchable together, so dates must be verified per work

**Why it matters:** The dimension filters make it possible to search by physical size directly, rather than retrieving all works and filtering manually. The Rijksmuseum's structured dimension data can corroborate (or challenge) what we know from guild records about panel maker standards.

#### 11. Vocabulary Terms and External Authority Links

**Research question:** What material and object-type terms does the Rijksmuseum use for its batik holdings, and which of those terms have equivalents in the Getty Art & Architecture Thesaurus?

**How the tools enable it:**
- `search_artwork` with `material: "batik"` or `type: "textile"` combined with `description: "Indonesia"`
- `get_artwork_details` on results — materials and object types are resolved to English labels, each with links to Getty AAT and Wikidata where equivalents exist
- List the distinct vocabulary terms, noting which carry AAT mappings and which are Rijksmuseum-only

**Why it matters:** Controlled vocabularies shape how collections are discovered. The resolved vocabulary terms in the detail output make it visible which Rijksmuseum classifications align with international standards and which do not — without needing to consult the AAT directly.

#### 12. Credit Lines and Acquisition Context

**Research question:** How did the Rijksmuseum acquire its core Rembrandt collection? What proportion came through purchase, bequest, or state allocation, and when?

**How the tools enable it:**
- `search_artwork` with `creditLine: "purchase"` and `creator: "Rembrandt"` to find works acquired by purchase — repeat with `"bequest"`, `"gift"`, `"loan"`
- `search_artwork` with `provenance: "Rembrandt"` for broader ownership-history search
- `get_artwork_details` on each for full provenance chain and credit line context

**Why it matters:** The `creditLine` and `provenance` filters enable full-text search across acquisition records (~358K credit lines, ~48K provenance entries), making collection history systematically researchable without examining each artwork individually.

---

### Bibliographic References

`get_artwork_bibliography` exposes the museum's scholarship tracking — from five references for minor works to over a hundred for masterpieces.

#### 13. Measuring Scholarly Attention

**Research question:** Compare the bibliography counts across Vermeer's paintings in the Rijksmuseum — which have received the most and least scholarly attention?

**How the tools enable it:**
- `search_artwork` with `creator: "Johannes Vermeer"` and `type: "painting"`
- `get_artwork_bibliography` with `full: false` (summary mode) on each result — returns total citation counts
- Rank the paintings from most to least studied

**Why it matters:** Vermeer's four paintings in the Rijksmuseum are not equally studied. Comparing bibliography counts reveals which works have attracted disproportionate attention and which represent gaps — useful for identifying a dissertation topic or an overlooked angle.

#### 14. Building a Literature Review

**Research question:** What is the complete published scholarship on Jan Asselijn's *The Threatened Swan*, and how has its interpretation changed over time?

**How the tools enable it:**
- `get_artwork_bibliography` with `objectNumber: "SK-A-4"` and `full: true`
- Review the chronological sequence of publications — early catalogue entries, monograph treatments, interpretive essays
- Use ISBNs and WorldCat links to locate sources in university libraries

**Why it matters:** The bibliography tool provides a structured starting point with publication metadata (authors, titles, years, ISBNs) that would otherwise require consulting the museum's paper files or visiting the Rijksprentenkabinet library.

#### 15. Tracking Exhibition History Through Catalogues

**Research question:** How often has Vermeer's *The Little Street* been lent to exhibitions outside the Rijksmuseum?

**How the tools enable it:**
- `get_artwork_bibliography` with `full: true` on the relevant object number
- Filter results for exhibition catalogue entries (typically identifiable by their format: exhibition venue + date + catalogue number)
- Map the exhibition loans geographically and chronologically

**Why it matters:** Exhibition history reveals how a work's canonical status is constructed. The bibliography data captures this exhibition history.

---

### High-Resolution Images

`get_artwork_image` provides an interactive viewer with a high-resolution, deep-zoom feature. For some artworks, this is sufficient to examine individual brushstrokes, craquelure patterns, and inscriptions that are invisible in standard reproductions.

#### 16. Technical Art History at the Brushstroke Level

**Research question:** What materials, technique, and support were used in Rembrandt's *The Night Watch*, what are its exact dimensions, and what inscriptions does it carry? Open the high-resolution image for close examination of the paint surface.

**How the tools enable it:**
- `get_artwork_details` with `objectNumber: "SK-C-5"` returns materials, technique statement, structured dimensions, and inscriptions
- `get_artwork_image` opens the interactive deep-zoom viewer for close examination at maximum magnification

**Why it matters:** Technical metadata — support material, paint type, exact dimensions — frames what the viewer reveals. Knowing a canvas is 363 x 437 cm contextualises the scale of visible brushwork; knowing the inscription text lets the user verify it against the painted surface at full zoom.

#### 17. Reading Illegible Inscriptions

**Research question:** What inscriptions are recorded on Pieter Saenredam's church interior paintings, and can I verify them against the painted surface at high magnification?

**How the tools enable it:**
- `search_artwork` with `creator: "Pieter Saenredam"` and `type: "painting"`
- `get_artwork_details` on each result — the inscriptions field lists text transcribed from the painting surface
- `get_artwork_image` on selected works to open the deep-zoom viewer for visual verification

**Why it matters:** Saenredam's inscriptions include exact dates of preliminary drawings, completion dates, and church identifications. The metadata provides the transcription; the viewer lets the researcher confirm it against the original and check for text the catalogue may have missed.

#### 18. Comparative Detail Analysis Across Works

**Research question:** How many paintings by Leiden-born painters versus Haarlem-born painters does the Rijksmuseum hold, and who are the leading artists from each school? Open a representative work from each — a Gerrit Dou and a Frans Hals — for side-by-side examination at high zoom.

**How the tools enable it:**
- `search_artwork` with `birthPlace: "Leiden"`, `profession: "painter"`, `type: "painting"`, `compact: true` for a count — repeat with `birthPlace: "Haarlem"`
- Non-compact searches to identify the principal artists from each city
- `get_artwork_image` on a Dou and a Hals to open both in the deep-zoom viewer

**Why it matters:** The `birthPlace` filter identifies artists by geographic origin without requiring the researcher to already know who belongs to which school. The quantitative comparison reveals the relative weight of each school in the collection, and the viewer delivers the images for visual analysis of their contrasting techniques.

---

### Artist Timelines

`get_artist_timeline` arranges an artist's works chronologically, revealing career patterns invisible when browsing search results.

#### 19. Tracing Career Evolution Through Subject and Place

**Research question:** Jacob van Ruisdael's landscapes are said to evolve from flat dune scenes in his Haarlem years to dramatic waterfalls and panoramic views after his move to Amsterdam. Does the timeline of his works in the Rijksmuseum support this narrative?

**How the tools enable it:**
- `get_artist_timeline` with `artist: "Jacob van Ruisdael"` and `maxWorks: 25`
- `get_artwork_details` on each work — read description, title, and `production[].place` to identify subject matter and where each work was made
- Map subject type and production place against date: do the dune landscapes cluster in the early years and the waterfalls in the later ones?

**Why it matters:** Art historical narratives about career evolution are often based on a handful of securely dated works. A timeline across a full museum holding tests these narratives against a larger evidence base — and the production-place data can reveal whether the geographic move and the stylistic shift actually coincide.

#### 20. Medium Shifts Within a Career

**Research question:** George Hendrik Breitner is classified in the Rijksmuseum's vocabulary as painter, draughtsman, and printmaker. Does the timeline of his works reveal a clear sequence — drawing first, then painting, then prints — or did he work across media simultaneously?

**How the tools enable it:**
- `search_artwork` with `profession: "painter"` and `creator: "Breitner"` to confirm his multi-profession classification
- `get_artist_timeline` with `artist: "George Hendrik Breitner"` and `maxWorks: 25`
- `get_artwork_details` on each work to extract medium and technique
- Plot medium against date: do drawings cluster in the early years, paintings in the middle, photographs at the end — or is the practice mixed throughout?

**Why it matters:** An artist classified under multiple professions may have practised them simultaneously or sequentially. The timeline reveals which, and whether any transition aligns with documented biographical events. 

#### 21. Comparing Parallel Careers

**Research question:** How do the career trajectories of Jan Steen and Gabriël Metsu compare — two genre painters active in the same cities at the same time?

**How the tools enable it:**
- `get_artist_timeline` for both artists
- Compare: date ranges, number of works per decade, medium distribution
- Use `get_artwork_details` on representative works from each to compare subject matter and scale

**Why it matters:** Parallel career comparison is a standard for understanding market positioning, artistic rivalry, and influence. The timeline tool generates the raw data for these comparisons.

---

### Curated Sets

`list_curated_sets` and `browse_set` expose the museum's 192 curatorial groupings — thematic, scholarly, and exhibition-based. These sets encode expert knowledge about how objects relate to each other.

#### 22. Reconstructing Past Exhibitions

**Research question:** What objects were included in Rijksmuseum exhibitions related to Rembrandt, and how did the curatorial selection construct a narrative?

**How the tools enable it:**
- `list_curated_sets` with a keyword filter to find the relevant set
- `browse_set` with the set identifier to retrieve all included objects
- `get_artwork_details` on key objects to understand what they contribute to the exhibition thesis

**Why it matters:** Exhibitions are arguments made with objects — the selection, sequencing, and juxtaposition of works constitutes an interpretation. Being able to retrieve the object list for a past exhibition enables historiographic analysis of curatorial practice.

#### 23. Finding Thematic Connections Curators Have Already Made

**Research question:** Has the Rijksmuseum curated any groupings related to Dutch maritime trade, and what objects did they consider central to that story?

**How the tools enable it:**
- `list_curated_sets` with `query: "maritime"` or `query: "trade"` or `query: "VOC"`
- `browse_set` to see the contents — paintings, maps, ship models, porcelain, documents

**Why it matters:** Curated sets cross media boundaries. These cross-media juxtapositions can reveal connections that medium-specific searches miss.

#### 24. Assessing Collection Depth for Grant Applications

**Research question:** How many Japanese prints does the Rijksmuseum hold, what curated sets relate to Japanese art, what date range do the holdings cover, and which artists are best represented?

**How the tools enable it:**
- `search_artwork` with `productionPlace: "Japan"`, `type: "print"`, `compact: true` for a total count
- `list_curated_sets` filtered for Japanese-related sets
- `browse_set` on relevant sets to see the range of artists, dates, and subjects
- Non-compact search to identify the most prominent printmakers

**Why it matters:** Grant applications require demonstrating that the proposed research site has adequate resources. Concrete numbers — total holdings, date range, named artists, curated set identifiers — strengthen the feasibility argument.

---

### Collection Changes

`get_recent_changes` tracks what the museum adds and updates, providing a live feed of cataloguing activity.

#### 25. Tracking New Acquisitions in a Research Area

**Research question:** Has the Rijksmuseum added any new 17th-century paintings to its collection in the past six months? If so, who are the artists and what are the subjects?

**How the tools enable it:**
- `get_recent_changes` with a date range covering the last six months
- Use `identifiersOnly: true` for a fast scan of recently changed object numbers
- `get_artwork_details` on results to filter for paintings from the 1600s and examine creator, date, and description

**Why it matters:** New acquisitions can fill gaps in the evidence or provide crucial comparisons for ongoing research. A date-scoped query surfaces recently added or modified records without requiring the researcher to monitor the museum's website.

#### 26. Monitoring Catalogue Activity in a Research Area

**Research question:** Which objects in the Rijksmuseum's Asian art holdings have been recently modified in the catalogue? Retrieve the current metadata for the most recent changes.

**How the tools enable it:**
- `list_curated_sets` with `query: "Asian"` or `query: "Japan"` to find relevant set identifiers
- `get_recent_changes` with `setSpec` restricted to that set and a date range covering the last quarter
- `get_artwork_details` on the returned object numbers to examine the current state of provenance, attribution, and description

**Why it matters:** Museum catalogues are living documents — attributions change, provenance is discovered, dates are revised. The change-tracking tool identifies *which* records were recently touched; the detail tool reveals their current state. This does not show what changed (no diff is available), but it flags the records a researcher should re-examine.

---

### The LLM fills in the gaps

Because the MCP tools are used through a large language model, the LLM's own knowledge can act as a bridge between the researcher's question and the API's formal parameters.

#### 27. Multilingual Access to a Dutch Collection

**Research question:** A Japanese scholar studying *Rangaku* (Dutch learning in Edo-period Japan) wants to find VOC-related objects and materials about the Dutch trading post at Dejima. 

**How the LLM enables it:**
- The researcher asks in English: "Find objects related to the Dutch trading post at Dejima"
- The LLM knows that Dejima is romanised from 出島, that the Dutch called it "Deshima," and that the Rijksmuseum catalogues it under various Dutch spellings
- It searches with the appropriate terms and explains the results in the researcher's language

**Why it matters:** The Rijksmuseum's metadata is partially in Dutch, with varying degrees of English translation. A LLM doesn't just translate — it can often handle variant spellings, historical place names, and terminological differences between languages.

#### 28. Cross-Referencing Art Historical Knowledge

**Research question:** Show me works by the Utrecht Caravaggisti in the Rijksmuseum — I don't know which specific artists that includes.

**How the LLM enables it:**
- The student asks: "Show me works by the Utrecht Caravaggisti"
- The LLM identifies the relevant artists (Honthorst, Baburen, Ter Brugghen, van Bijlert) from its training knowledge
- It runs multiple `search_artwork` queries and synthesises the results

**Why it matters:** Art historical categories like "Utrecht Caravaggisti" are not search terms in the museum's metadata — they are scholarly constructs that group artists by style, period, and geography. The LLM can bridge from the category to the individual names, enabling conceptual searches that no fielded search interface supports.

#### 29. Navigating Variant Names and Historical Spelling

**Research question:** Find all works by Hercules Seghers in the collection.

**How the LLM enables it:**
- The LLM recognises the spelling variant and searches under the museum's canonical form
- It explains the discrepancy so the student understands why a direct search would have failed
- It surfaces all 77 works without the student needing to guess the correct spelling

**Why it matters:** Historical names are notoriously unstable — Rembrandt van Rijn / Ryn, Albrecht Dürer / Durer / Duerer, Pieter Brueghel / Bruegel / Breughel. Every variant that differs from the museum's canonical form is a failed search. For well-known artists, an LLM can usually handle this seamlessly, drawing on its knowledge of naming conventions across art historical traditions.

---

### Technical Guide

The sections below are for developers who want to run the server locally, deploy it, or understand the architecture.

#### Local Setup (stdio)

For use with Claude Desktop or other MCP clients that communicate over stdio:

```bash
git clone https://github.com/kintopp/rijksmuseum-mcp-plus.git
cd rijksmuseum-mcp-plus
npm install
npm run build
```

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "rijksmuseum": {
      "command": "node",
      "args": ["/absolute/path/to/rijksmuseum-mcp-plus/dist/index.js"],
      "env": {
        "VOCAB_DB_URL": "https://github.com/kintopp/rijksmuseum-mcp-plus/releases/download/v0.10/vocabulary.db.gz"
      }
    }
  }
}
```

The server works without the vocabulary database, but [vocabulary-based search parameters](#vocabulary-database) won't be available. The `VOCAB_DB_URL` setting above enables automatic download (~612 MB compressed, ~2.6 GB uncompressed) on first start.

Restart your MCP client after updating the config.

#### HTTP Deployment

For web deployment, remote access, or non-stdio clients:

```bash
npm run serve                    # Starts on port 3000
PORT=8080 npm start              # Custom port
```

HTTP mode activates automatically when `PORT` is set or `--http` is passed.

| Endpoint | Description |
|---|---|
| `POST /mcp` | MCP protocol (Streamable HTTP with SSE) |
| `GET /viewer?iiif={id}&title={title}` | OpenSeadragon IIIF deep-zoom viewer |
| `GET /health` | Health check |

The included `railway.json` supports one-click deployment on [Railway](https://railway.app/). Railway sets `PORT` automatically.

#### Tools

| Tool | Description |
|---|---|
| `search_artwork` | Search by query, title, creator, depicted person (`aboutActor`), type, material, technique, date, or description. Filter by image availability. At least one filter required. Supports wildcard date ranges (`16*` for 1600s) and compact mode for fast counts. Vocabulary-backed filters — `subject`, `iconclass`, `depictedPerson`, `depictedPlace`, `productionPlace`, `birthPlace`, `deathPlace`, `profession`, `collectionSet`, `license`, `inscription`, `provenance`, `creditLine`, `narrative`, `productionRole`, and dimension ranges (`minHeight`/`maxHeight`/`minWidth`/`maxWidth`) — enable subject, iconographic, biographical, textual, and physical search across 831,000 artworks. All filters can be freely combined for cross-field intersection queries. |
| `get_artwork_details` | [24 metadata categories](docs/metadata-categories.md) by object number (e.g. `SK-C-5`): titles, creator, date, curatorial narrative, materials, object type, production details, structured dimensions, provenance, credit line, inscriptions, iconographic subjects (Iconclass codes, depicted persons, depicted places), license, related objects, collection sets, persistent IDs, and more. Vocabulary terms are resolved to English labels with links to Getty AAT, Wikidata, and Iconclass. |
| `get_artwork_bibliography` | Scholarly references for an artwork. Summary (first 5) or full (100+ for major works). Resolves publication records with ISBNs and WorldCat links. |
| `get_artwork_image` | IIIF image info + interactive inline deep-zoom viewer via [MCP Apps](https://github.com/modelcontextprotocol/ext-apps). Returns viewer data (IIIF ID, dimensions, URLs) — no image content. For LLM image analysis, use the `analyse-artwork` prompt. |
| `get_artist_timeline` | Chronological timeline of an artist's works in the collection. |
| `open_in_browser` | Open any URL (artwork page, image, viewer) in the user's default browser. |
| `list_curated_sets` | List 192 curated collection sets (exhibitions, scholarly groupings, thematic selections). Optional name filter. Via OAI-PMH. |
| `browse_set` | Browse artworks in a curated set. Returns EDM records with titles, creators, dates, images, IIIF URLs, and iconographic subjects (Iconclass, depicted persons, places). Pagination via resumption token. |
| `resolve_uri` | Resolve a Linked Art URI to full artwork details. Use when `get_artwork_details` returns `relatedObjects` with URIs — pass them directly to learn what the related object is. Returns the same enriched detail as `get_artwork_details`. |
| `get_recent_changes` | Track additions and modifications by date range. Full EDM records (including subjects) or lightweight headers (`identifiersOnly`). Pagination via resumption token. |

#### Prompts and Resources

| Prompt / Resource | Description |
|---|---|
| `analyse-artwork` | Prompt: fetch high-resolution image and analyse visual content alongside key metadata (12 fields) |
| `generate-artist-timeline` | Prompt: create a visual timeline of an artist's works (max 25) |
| `top-100-artworks` | Prompt: explore the Rijksmuseum's Top 100 masterpieces (~133 works from curated set 260213) |
| `ui://rijksmuseum/artwork-viewer.html` | Resource: interactive IIIF viewer (MCP Apps) |

#### Architecture

```
src/
  index.ts                    — Dual-transport entry point (stdio + HTTP)
  registration.ts             — Tool/resource/prompt registration
  types.ts                    — Linked Art, IIIF, and output types
  viewer.ts                   — OpenSeadragon HTML generator (HTTP mode)
  api/
    RijksmuseumApiClient.ts   — Linked Art API client, vocabulary resolver, bibliography, IIIF image chain
    OaiPmhClient.ts           — OAI-PMH client (curated sets, EDM records, change tracking)
    VocabularyDb.ts           — SQLite vocabulary database for subject and iconographic search
  utils/
    ResponseCache.ts          — LRU+TTL response cache
    UsageStats.ts             — Tool call aggregation and periodic flush
    SystemIntegration.ts      — Cross-platform browser opening
apps/
  artwork-viewer/             — MCP Apps inline IIIF viewer (Vite + OpenSeadragon)
data/
  vocabulary.db               — Vocabulary database (built from OAI-PMH harvest, not in git)
```

#### Data Sources

The server uses the Rijksmuseum's open APIs with no authentication required:

| API | URL | Purpose |
|---|---|---|
| Search API | `https://data.rijksmuseum.nl/search/collection` | Field-based search (title, creator, depicted person, type, material, technique, date, description, image availability), returns Linked Art URIs |
| Linked Art resolver | `https://id.rijksmuseum.nl/{id}` | Object metadata, vocabulary terms, and bibliography as JSON-LD |
| IIIF Image API | `https://iiif.micr.io/{id}/info.json` | High-resolution image tiles |
| OAI-PMH | `https://data.rijksmuseum.nl/oai` | Curated sets, EDM metadata records, date-based change tracking. 192 sets, 836K+ records. |

**Image discovery chain (4 HTTP hops):** Object `.shows` > VisualItem `.digitally_shown_by` > DigitalObject `.access_point` > IIIF info.json

**Vocabulary resolution:** Material, object type, technique, place, collection, and subject terms are Rijksmuseum vocabulary URIs. These are resolved in parallel to obtain English labels and links to external authorities (Getty AAT, Wikidata, Iconclass). See [Artwork Metadata Categories](docs/metadata-categories.md) for the full field reference.

**Subject discovery chain:** Object `.shows` > VisualItem `.represents_instance_of_type` (Iconclass concepts) + `.represents` (depicted persons and places). Subject URIs are batched with the existing vocabulary resolution pass.

**Vocabulary database:** A pre-built SQLite database maps 149,000 controlled vocabulary terms to 831,000 artworks via 12.8 million mappings. Built from OAI-PMH EDM records and Linked Art resolution (both vocabulary terms and full artwork records), it powers 17 search filters: vocabulary-backed filters (`subject`, `iconclass`, `depictedPerson`, `depictedPlace`, `productionPlace`, `birthPlace`, `deathPlace`, `profession`, `collectionSet`, `license`, `productionRole`), full-text search on artwork texts (`inscription`, `provenance`, `creditLine`, `narrative`), and numeric dimension ranges (`minHeight`/`maxHeight`/`minWidth`/`maxWidth`). Includes 20,828 geocoded places with coordinates from [Getty TGN](https://www.getty.edu/research/tools/vocabularies/tgn/), [Wikidata](https://www.wikidata.org/), [GeoNames](https://www.geonames.org/), and the [World Historical Gazetteer](https://whgazetteer.org/).

**Bibliography resolution:** Publication references resolve to Schema.org Book records (a different JSON-LD context from the Linked Art artwork data) with author, title, ISBN, and WorldCat links.

#### Configuration

| Variable | Description | Default |
|---|---|---|
| `PORT` | HTTP server port (presence triggers HTTP mode) | `3000` |
| `ALLOWED_ORIGINS` | CORS origins (comma-separated) | `*` |
| `VOCAB_DB_PATH` | Path to vocabulary SQLite database | `data/vocabulary.db` |
| `VOCAB_DB_URL` | URL to download vocabulary DB on first start; gzip supported | *(none)* |
| `USAGE_STATS_PATH` | Path to usage stats JSON file | `data/usage-stats.json` |

---

### Data and Image Credits

Collection data and images are provided by the **[Rijksmuseum, Amsterdam](https://www.rijksmuseum.nl/)** via their [Linked Open Data APIs](https://data.rijksmuseum.nl/).

**Licensing:** Information and data that are no longer (or never were) protected by copyright carry the **Public Domain Mark** and/or **[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)**. Where the Rijksmuseum holds copyright, it generally waives its rights under CC0 1.0; in cases where it does exercise copyright, materials are made available under **[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)**. Materials under third-party copyright without express permission are not made available as open data. Individual licence designations appear on the [collection website](https://www.rijksmuseum.nl/en/rijksstudio).

**Attribution:** The Rijksmuseum considers it good practice to provide attribution and/or source citation via a credit line and data citation, regardless of the licence applied.

See the Rijksmuseum's [information and data policy](https://data.rijksmuseum.nl/policy/information-and-data-policy) for the full terms.

### Authors

- [Arno Bosse](https://orcid.org/0000-0003-3681-1289) — [RISE, University of Basel](https://rise.unibas.ch/)
- Claude Code — [Anthropic](https://www.anthropic.com/)

### License

This project is licensed under the [MIT License](LICENSE).
