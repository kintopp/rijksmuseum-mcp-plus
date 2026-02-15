# rijksmuseum-mcp+

An AI-powered interface to the [Rijksmuseum](https://www.rijksmuseum.nl/) collection. Search artworks, explore their history, view high-resolution images, and access scholarly references — all through natural conversation.

Built on the Rijksmuseum's [Linked Open Data APIs](https://data.rijksmuseum.nl/), the [Linked Art](https://linked.art/) and [Europeana Data Model](https://pro.europeana.eu/page/edm-documentation) (EDM) standards, and the [Model Context Protocol](https://modelcontextprotocol.io/) (MCP).

> This project was inspired by [@r-huijts/rijksmuseum-mcp](https://github.com/r-huijts/rijksmuseum-mcp), the original Rijksmuseum MCP server. That version used the museum's REST API which is no longer supported. This is a ground-up rewrite using the museum's newer Linked Open Data infrastructure and adds features like an interactive inline image viewer.

## Quick Start

The easiest way to try rijksmuseum-mcp+ is through the hosted version — no installation needed.

Connect your MCP client to:

```
https://rijksmuseum-mcp-plus-production.up.railway.app/mcp
```
Recommended: [Claude Desktop](https://claude.com/download) or [claude.ai](https://claude.ai). Both require a Pro or better [subscription](https://claude.com/pricing). For example, in claude.ai: Settings → Connectors → Add custom connector → paste the URL above. For more details, see Anthropic's [instructions](https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp#h_3d1a65aded). 

Rijksmuseum-mcp+ also works well with many open source MCP clients (such as [Jan.ai](https://jan.ai)) and CLI coding apps like OpenAI Codex. Moreover, these can also be used via API charges instead of a subscription. However, to date, only Claude Desktop and claude.ai support viewing inline images [directly in the chat](docs/swan.jpg). All other clients will automatically fall back to providing links to the Rijksmuseum detail page which however also includes options to zoom in/out and export the image.

### Example Queries

“Show me a drawing by Gesina ter Borch”  
“Find Pieter Saenredam’s paintings”  
“Give me a list of the Rijksmuseum’s curated collections”  
“Search for prints from the 1530s”  
“Show me woodcuts by Hokusai”  
“Find artworks depicting the Raid on the Medway”  
“What paintings depict Amalia van Solms?”  
“Show me works about the sense of smell”  
“Search for winter landscapes from the 17th century”  
“Find all works made in Haarlem with the mezzotint technique”

## Search capabilities

There are three classes of discoverability that users need to keep in mind when using the current (v0.8) version of the resource:

1. **Metadata categories that are directly searchable** – For example, `title`, `creator`, `material`, `type`, `depictedPerson`, `subject`, and `iconclass`
2. **Search parameters with no corresponding metadata output** — these are filters (e.g. `birthPlace`, `deathPlace`, and `profession`) that query data held internally by the Rijksmuseum but are *not* returned in artwork detail records. Users can filter by an artist's birth place but cannot see that birth place in the results.
3. **Metadata categories that are not searchable at all** — fields like `provenance`, `inscriptions`, `dimensions`, `curatorialNarrative`, and current `location` are returned in detail records but cannot be used as search criteria.

### Searchable metadata categories

| Search Parameter | What it queries | Notes |
|---|---|---|
| `query` | Artwork title (broad match) | Less targeted than `title`; no general full-text search exists |
| `title` | Artwork title (exact field match) | |
| `creator` | Artist or maker name | |
| `creationDate` | Year or date range of creation | Supports wildcards: `1642`, `164*` (1640s), `16*` (1600s) |
| `description` | Free-text description of the artwork | |
| `type` | Object type: `painting`, `print`, `drawing`, etc. | |
| `material` | Material: `canvas`, `paper`, `panel`, `oil paint`, etc. | |
| `technique` | Technique: `oil painting`, `etching`, `mezzotint`, etc. | |
| `productionPlace` | Place where the work was made | Vocabulary-based; may not match every `production[].place` value in artwork details |
| `subject` | Iconclass subject labels (themes, scenes) | Text search on vocabulary labels; requires vocabulary DB |
| `iconclass` | Iconclass notation code (e.g. `34B11` for dogs) | Exact code match; requires vocabulary DB |
| `depictedPerson` | Named person depicted in the artwork | Vocabulary-based; more comprehensive than `aboutActor` |
| `aboutActor` | Person depicted or referenced in the artwork | Uses the Search API directly; less comprehensive than `depictedPerson` |
| `depictedPlace` | Named place depicted in the artwork | Vocabulary-based; requires vocabulary DB |
| `collectionSet` | Curated collection set name (e.g. 'Rembrandt', 'Japanese') | Vocabulary-based; text search on set names. Use `list_curated_sets` to discover available sets |
| `license` | Rights/license designation | Matches against rights URI. Common values: `publicdomain`, `zero` (CC0), `by` (CC BY) |
| `imageAvailable` | Whether a digital image exists | Boolean filter; not a metadata category |

### Search-only parameters (no corresponding metadata output)

These parameters are accepted by `search_artwork` and return results, but the underlying data is **not included** in the `get_artwork_details` response for any artwork. The data lives in artist/actor authority records that are not exposed through the current API.

| Search Parameter | What it queries | Notes |
|---|---|---|
| `birthPlace` | Artist's place of birth | Results cannot confirm the match — the artwork record does not include birth place |
| `deathPlace` | Artist's place of death | Same limitation |
| `profession` | Artist's profession (e.g. `painter`, `draughtsman`) | Same limitation; vocabulary labels are bilingual (EN/NL) |

### Non-searchable metadata categories

These fields are returned by `get_artwork_details` but cannot be used as search filters.

| Search Parameter | What it queries | Notes |
|---|---|---|
| — | Object number (`objectNumber`) | Lookup key for `get_artwork_details`, not a search filter |
| — | Persistent identifier (`persistentId`) | Stable handle.net URI for citation |
| — | External identifiers (`externalIds`) | |
| — | Production details (`production`) | Creator name and place are searchable above; role and actor URI are not |
| — | Curatorial narrative (`curatorialNarrative`) | Museum wall text in English and Dutch |
| — | Dimension statement (`dimensionStatement`) | |
| — | Structured dimensions (`dimensions`) | Numeric height, width, weight, depth with units |
| — | Inscriptions (`inscriptions`) | Transcribed text from the object surface |
| — | Provenance (`provenance`) | Ownership history |
| — | Credit line (`creditLine`) | Acquisition mode and acknowledgement |
| — | Current location (`location`) | Gallery and room within the museum |
| — | Web page (`webPage`) | |
| — | Related objects (`relatedObjects`) | Links to related artworks |

Future releases of rijksmuseum-mcp+ will improve this situation.

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

## Searching the Collection

The `search_artwork` tool combines filters — creator, type, material, technique, date (with wildcards), description, depicted person (`aboutActor`), and image availability — that can be composed to answer questions no single filter handles alone.

### 1. Mapping an Artist's Output Across Media

**Research question:** What is the actual distribution of Rembrandt's works in the Rijksmuseum across painting, printmaking, and drawing — and how does this challenge popular perceptions of him as primarily a painter?

**How the tools enable it:**
- `search_artwork` with `creator: "Rembrandt"` and `compact: true` for a total count
- Repeat with `type: "painting"`, then `type: "print"`, then `type: "drawing"` to get counts per medium
- Follow up with `get_artwork_details` on selected works from each category

**Why it matters:** The Rijksmuseum holds ~30 Rembrandt paintings but over 1,000 prints and hundreds of drawings. Most students encounter Rembrandt through a handful of iconic canvases. Seeing the actual proportions reframes his practice as fundamentally graphic.

### 2. Material Culture Beyond the Canon

**Research question:** What is the scope of the Rijksmuseum's non-European holdings? How are Indonesian, Japanese, Chinese, and Indian objects distributed across media, and where were they produced?

**How the tools enable it:**
- `search_artwork` with `productionPlace: "Japan"` and `compact: true`, then repeat for `"China"`, `"Java"`, `"India"` to map the geographic distribution
- Cross-reference with `type` filters to distinguish ceramics, textiles, prints, and metalwork
- Use `depictedPlace` to find works that *represent* these places, regardless of where they were made — separating objects produced in Asia from European depictions of Asia
- Use `imageAvailable: true` to assess digitisation coverage

**Why it matters:** The Rijksmuseum positions itself as a museum of Dutch art *and* history, which includes centuries of global trade. The combination of `productionPlace` and `depictedPlace` enables a crucial distinction: objects *from* Asia versus European images *of* Asia.

### 3. Tracking the Adoption of Artistic Techniques

**Research question:** When did etching overtake engraving as the dominant printmaking technique in the Netherlands, and how do lesser-known techniques — mezzotint, aquatint, woodcut — appear in the Rijksmuseum collection over time?

**How the tools enable it:**
- `search_artwork` with `type: "print"`, `technique: "engraving"`, `creationDate: "15*"`, `compact: true` — repeat for `"16*"` and `"17*"`
- Compare with `technique: "etching"` across the same date ranges
- Extend to `technique: "mezzotint"`, `"woodcut"`, `"aquatint"` to map the full technical repertoire
- Use `get_artwork_details` on selected works from each technique to examine materials and production context

**Why it matters:** The shift from engraving to etching is a defining transition in European printmaking. Date-wildcard queries make this transition quantifiable at collection scale, and the results reveal whether the Rijksmuseum's holdings reflect the standard chronology or complicate it.

---

## Subject and Iconographic Search

`search_artwork` includes ten vocabulary-backed filters — `subject`, `iconclass`, `depictedPerson`, `depictedPlace`, `productionPlace`, `birthPlace`, `deathPlace`, `profession`, `collectionSet`, and `license` — drawn from 149,000 controlled vocabulary terms mapped to 831,000 artworks. These enable searches by what is depicted, where it was made, and who made it — including biographical attributes of the artist.

### 4. Mapping the Visual Rhetoric of the Stadholders

**Research question:** How were the successive Princes of Orange visually represented across different media, and can we trace shifts in propaganda strategy from Maurice to William III?

**How the tools enable it:**
- `search_artwork` with `depictedPerson: "Maurice"` and `compact: true`, then repeat for `"Frederick Henry"`, `"William II"`, `"William III"`
- For each stadholder, filter by `type: "painting"` vs `type: "print"` vs `type: "medal"` to map the media distribution
- Use `get_artwork_details` on selected results to compare how each ruler was staged — martial, dynastic, classical

**Why it matters:** The Orange-Nassau dynasty used visual media strategically, but the balance between painted portraits (diplomatic gifts, court display) and printed imagery (popular circulation, political pamphlets) shifted across generations. A depicted-person search makes this media strategy empirically visible.

### 5. Production Geography and the Migration of Printmaking

**Research question:** How did the centre of gravity of Dutch printmaking shift between Haarlem, Amsterdam, and other cities across the 16th and 17th centuries?

**How the tools enable it:**
- `search_artwork` with `type: "print"`, `productionPlace: "Haarlem"`, `creationDate: "15*"`, `compact: true` — repeat for `"16*"`
- Compare with `productionPlace: "Amsterdam"` across the same date ranges
- Extend to `"Leiden"`, `"Utrecht"`, `"Antwerp"` for the broader network
- Use `get_artwork_details` on a sample to identify the key printmakers at each centre

**Why it matters:** Haarlem was the dominant centre of printmaking in the late 16th century until Amsterdam overtook it in the 17th. Production-place queries across date ranges provide collection-level evidence for secondary centres whose role may have been overlooked.

### 6. Iconographic Traditions Across Media and Time

**Research question:** How does the iconography of *vanitas* function differently in painting versus printmaking? Do their symbolic conventions appear with the same frequency and combination in both media?

**How the tools enable it:**
- `search_artwork` with `subject: "vanitas"` to get all works tagged with vanitas-related Iconclass codes
- Split by `type: "painting"` vs `type: "print"` to compare media
- Add `creationDate: "16*"` and `"17*"` to track chronological patterns
- Use `get_artwork_details` on a sample from each group to compare which specific vanitas motifs are present

**Why it matters:** A subject-based search that crosses media boundaries enables systematic comparisons that would otherwise require extensive manual catalogue work.

### 7. Colonial Visual Culture: Representing the East Indies

**Research question:** How did Dutch artists represent the East Indies, and does the production location — metropole versus colony — correlate with differences in how these places were depicted?

**How the tools enable it:**
- `search_artwork` with `depictedPlace: "Batavia"` to find all works showing the colonial capital
- Extend to `depictedPlace: "Java"`, `"Sumatra"`, `"Dutch East Indies"`
- Cross-reference with `productionPlace: "Amsterdam"` vs `productionPlace: "Batavia"` to separate metropolitan and colonial viewpoints
- Use `get_artwork_details` to examine medium, date, and descriptive context

**Why it matters:** Dutch colonial visual culture is an active area of research, but the question of *where* images of the colonies were produced is methodologically significant. The combination of `depictedPlace` and `productionPlace` makes this metropolitan-colonial distinction searchable for the first time at collection scale.

---

## Artwork Details and Metadata

`get_artwork_details` returns [24 metadata categories](docs/metadata-categories.md) per artwork — far more than a typical museum search interface exposes. This depth enables object-level research that would otherwise require on-site catalogue consultation.

### 8. Provenance as Historical Evidence

**Research question:** What can the ownership history of Vermeer's *The Milkmaid* tell us about the painting's changing reputation from the 17th century to the present?

**How the tools enable it:**
- `get_artwork_details` with `objectNumber: "SK-A-2344"` returns the full provenance chain
- Cross-reference owners and sale dates with the bibliography via `get_artwork_bibliography`
- Use `get_artwork_image` to examine the painting alongside the provenance narrative

**Why it matters:** When a work changes hands at auction, is gifted to a museum, or passes through a dealer's inventory, each transaction reflects contemporary taste and valuation. The structured provenance data makes these transactions traceable.

### 9. Reading Inscriptions as Primary Sources

**Research question:** What textual information did Pieter Saenredam embed in his church interior paintings, and do the inscriptions serve documentary, devotional, or artistic purposes?

**How the tools enable it:**
- `search_artwork` with `creator: "Pieter Saenredam"` and `type: "painting"`
- `get_artwork_details` on each result — the inscriptions category captures text transcribed from the painting surface
- Compare inscription content across works: dates, church names, biblical texts, artist signatures

**Why it matters:** Saenredam's inscriptions are unusually rich — they often include the exact date he made the preliminary drawing and the date he completed the painting, sometimes years apart. The inscriptions metadata category surfaces this information for each artwork, though inscriptions cannot be used as a search filter across the collection.

### 10. Dimensions as Evidence for Workshop Practice

**Research question:** Were there standard panel sizes used in 17th-century Dutch workshops? Can we identify clusters of dimensions that suggest pre-prepared supports from panel makers?

**How the tools enable it:**
- `search_artwork` with `type: "painting"`, `material: "panel"`, `creationDate: "16*"`
- `get_artwork_details` on a sample — structured dimensions give height and width in centimetres
- Tabulate dimensions across dozens of works to look for recurring sizes

**Why it matters:** The Rijksmuseum's structured dimension data — as opposed to free-text descriptions — can corroborate (or challenge) what we know from guild records.

### 11. Vocabulary Terms and External Authority Links

**Research question:** What material and object-type terms does the Rijksmuseum use for its batik holdings, and which of those terms have equivalents in the Getty Art & Architecture Thesaurus?

**How the tools enable it:**
- `search_artwork` with `material: "batik"` or `type: "textile"` combined with `description: "Indonesia"`
- `get_artwork_details` on results — materials and object types are resolved to English labels, each with links to Getty AAT and Wikidata where equivalents exist
- List the distinct vocabulary terms, noting which carry AAT mappings and which are Rijksmuseum-only

**Why it matters:** Controlled vocabularies shape how collections are discovered. The resolved vocabulary terms in the detail output make it visible which Rijksmuseum classifications align with international standards and which do not — without needing to consult the AAT directly.

### 12. Credit Lines and Acquisition Context

**Research question:** How did the Rijksmuseum acquire its core Rembrandt collection? What proportion came through purchase, bequest, or state allocation, and when?

**How the tools enable it:**
- `search_artwork` with `creator: "Rembrandt"` and `type: "painting"`
- `get_artwork_details` on each — the credit line records the acquisition mode and often the year
- Cross-reference with provenance for the full chain

**Why it matters:** A museum's acquisition history is itself a subject of art historical study. The credit line field makes this systematically researchable.

---

## Bibliographic References

`get_artwork_bibliography` exposes the museum's scholarship tracking — from five references for minor works to over a hundred for masterpieces.

### 13. Measuring Scholarly Attention

**Research question:** Compare the bibliography counts across Vermeer's paintings in the Rijksmuseum — which have received the most and least scholarly attention?

**How the tools enable it:**
- `search_artwork` with `creator: "Johannes Vermeer"` and `type: "painting"`
- `get_artwork_bibliography` with `full: false` (summary mode) on each result — returns total citation counts
- Rank the paintings from most to least studied

**Why it matters:** Vermeer's four paintings in the Rijksmuseum are not equally studied. Comparing bibliography counts reveals which works have attracted disproportionate attention and which represent gaps — useful for identifying a dissertation topic or an overlooked angle.

### 14. Building a Literature Review

**Research question:** What is the complete published scholarship on Jan Asselijn's *The Threatened Swan*, and how has its interpretation changed over time?

**How the tools enable it:**
- `get_artwork_bibliography` with `objectNumber: "SK-A-4"` and `full: true`
- Review the chronological sequence of publications — early catalogue entries, monograph treatments, interpretive essays
- Use ISBNs and WorldCat links to locate sources in university libraries

**Why it matters:** The bibliography tool provides a structured starting point with publication metadata (authors, titles, years, ISBNs) that would otherwise require consulting the museum's paper files or visiting the Rijksprentenkabinet library.

### 15. Tracking Exhibition History Through Catalogues

**Research question:** How often has Vermeer's *The Little Street* been lent to exhibitions outside the Rijksmuseum?

**How the tools enable it:**
- `get_artwork_bibliography` with `full: true` on the relevant object number
- Filter results for exhibition catalogue entries (typically identifiable by their format: exhibition venue + date + catalogue number)
- Map the exhibition loans geographically and chronologically

**Why it matters:** Exhibition history reveals how a work's canonical status is constructed. The bibliography data captures this exhibition history.

---

## High-Resolution Images

`get_artwork_image` provides an interactive viewer with a high-resolution, deep-zoom feature. For some artworks, this is sufficient to examine individual brushstrokes, craquelure patterns, and inscriptions that are invisible in standard reproductions.

### 16. Technical Art History at the Brushstroke Level

**Research question:** What materials, technique, and support were used in Rembrandt's *The Night Watch*, what are its exact dimensions, and what inscriptions does it carry? Open the high-resolution image for close examination of the paint surface.

**How the tools enable it:**
- `get_artwork_details` with `objectNumber: "SK-C-5"` returns materials, technique statement, structured dimensions, and inscriptions
- `get_artwork_image` opens the interactive deep-zoom viewer for close examination at maximum magnification

**Why it matters:** Technical metadata — support material, paint type, exact dimensions — frames what the viewer reveals. Knowing a canvas is 363 x 437 cm contextualises the scale of visible brushwork; knowing the inscription text lets the user verify it against the painted surface at full zoom.

### 17. Reading Illegible Inscriptions

**Research question:** What inscriptions are recorded on Pieter Saenredam's church interior paintings, and can I verify them against the painted surface at high magnification?

**How the tools enable it:**
- `search_artwork` with `creator: "Pieter Saenredam"` and `type: "painting"`
- `get_artwork_details` on each result — the inscriptions field lists text transcribed from the painting surface
- `get_artwork_image` on selected works to open the deep-zoom viewer for visual verification

**Why it matters:** Saenredam's inscriptions include exact dates of preliminary drawings, completion dates, and church identifications. The metadata provides the transcription; the viewer lets the researcher confirm it against the original and check for text the catalogue may have missed.

### 18. Comparative Detail Analysis Across Works

**Research question:** How many paintings by Leiden-born painters versus Haarlem-born painters does the Rijksmuseum hold, and who are the leading artists from each school? Open a representative work from each — a Gerrit Dou and a Frans Hals — for side-by-side examination at high zoom.

**How the tools enable it:**
- `search_artwork` with `birthPlace: "Leiden"`, `profession: "painter"`, `type: "painting"`, `compact: true` for a count — repeat with `birthPlace: "Haarlem"`
- Non-compact searches to identify the principal artists from each city
- `get_artwork_image` on a Dou and a Hals to open both in the deep-zoom viewer

**Why it matters:** The `birthPlace` filter identifies artists by geographic origin without requiring the researcher to already know who belongs to which school. The quantitative comparison reveals the relative weight of each school in the collection, and the viewer delivers the images for visual analysis of their contrasting techniques.

---

## Artist Timelines

`get_artist_timeline` arranges an artist's works chronologically, revealing career patterns invisible when browsing search results.

### 19. Tracing Career Evolution Through Subject and Place

**Research question:** Jacob van Ruisdael's landscapes are said to evolve from flat dune scenes in his Haarlem years to dramatic waterfalls and panoramic views after his move to Amsterdam. Does the timeline of his works in the Rijksmuseum support this narrative?

**How the tools enable it:**
- `get_artist_timeline` with `artist: "Jacob van Ruisdael"` and `maxWorks: 25`
- `get_artwork_details` on each work — read description, title, and `production[].place` to identify subject matter and where each work was made
- Map subject type and production place against date: do the dune landscapes cluster in the early years and the waterfalls in the later ones?

**Why it matters:** Art historical narratives about career evolution are often based on a handful of securely dated works. A timeline across a full museum holding tests these narratives against a larger evidence base — and the production-place data can reveal whether the geographic move and the stylistic shift actually coincide.

### 20. Medium Shifts Within a Career

**Research question:** George Hendrik Breitner is classified in the Rijksmuseum's vocabulary as painter, draughtsman, and printmaker. Does the timeline of his works reveal a clear sequence — drawing first, then painting, then prints — or did he work across media simultaneously?

**How the tools enable it:**
- `search_artwork` with `profession: "painter"` and `creator: "Breitner"` to confirm his multi-profession classification
- `get_artist_timeline` with `artist: "George Hendrik Breitner"` and `maxWorks: 25`
- `get_artwork_details` on each work to extract medium and technique
- Plot medium against date: do drawings cluster in the early years, paintings in the middle, photographs at the end — or is the practice mixed throughout?

**Why it matters:** An artist classified under multiple professions may have practised them simultaneously or sequentially. The timeline reveals which, and whether any transition aligns with documented biographical events. 

### 21. Comparing Parallel Careers

**Research question:** How do the career trajectories of Jan Steen and Gabriël Metsu compare — two genre painters active in the same cities at the same time?

**How the tools enable it:**
- `get_artist_timeline` for both artists
- Compare: date ranges, number of works per decade, medium distribution
- Use `get_artwork_details` on representative works from each to compare subject matter and scale

**Why it matters:** Parallel career comparison is a standard for understanding market positioning, artistic rivalry, and influence. The timeline tool generates the raw data for these comparisons.

---

## Curated Sets

`list_curated_sets` and `browse_set` expose the museum's 192 curatorial groupings — thematic, scholarly, and exhibition-based. These sets encode expert knowledge about how objects relate to each other.

### 22. Reconstructing Past Exhibitions

**Research question:** What objects were included in Rijksmuseum exhibitions related to Rembrandt, and how did the curatorial selection construct a narrative?

**How the tools enable it:**
- `list_curated_sets` with a keyword filter to find the relevant set
- `browse_set` with the set identifier to retrieve all included objects
- `get_artwork_details` on key objects to understand what they contribute to the exhibition thesis

**Why it matters:** Exhibitions are arguments made with objects — the selection, sequencing, and juxtaposition of works constitutes an interpretation. Being able to retrieve the object list for a past exhibition enables historiographic analysis of curatorial practice.

### 23. Finding Thematic Connections Curators Have Already Made

**Research question:** Has the Rijksmuseum curated any groupings related to Dutch maritime trade, and what objects did they consider central to that story?

**How the tools enable it:**
- `list_curated_sets` with `query: "maritime"` or `query: "trade"` or `query: "VOC"`
- `browse_set` to see the contents — paintings, maps, ship models, porcelain, documents

**Why it matters:** Curated sets cross media boundaries. These cross-media juxtapositions can reveal connections that medium-specific searches miss.

### 24. Assessing Collection Depth for Grant Applications

**Research question:** How many Japanese prints does the Rijksmuseum hold, what curated sets relate to Japanese art, what date range do the holdings cover, and which artists are best represented?

**How the tools enable it:**
- `search_artwork` with `productionPlace: "Japan"`, `type: "print"`, `compact: true` for a total count
- `list_curated_sets` filtered for Japanese-related sets
- `browse_set` on relevant sets to see the range of artists, dates, and subjects
- Non-compact search to identify the most prominent printmakers

**Why it matters:** Grant applications require demonstrating that the proposed research site has adequate resources. Concrete numbers — total holdings, date range, named artists, curated set identifiers — strengthen the feasibility argument.

---

## Collection Changes

`get_recent_changes` tracks what the museum adds and updates, providing a live feed of cataloguing activity.

### 25. Tracking New Acquisitions in a Research Area

**Research question:** Has the Rijksmuseum added any new 17th-century paintings to its collection in the past six months? If so, who are the artists and what are the subjects?

**How the tools enable it:**
- `get_recent_changes` with a date range covering the last six months
- Use `identifiersOnly: true` for a fast scan of recently changed object numbers
- `get_artwork_details` on results to filter for paintings from the 1600s and examine creator, date, and description

**Why it matters:** New acquisitions can fill gaps in the evidence or provide crucial comparisons for ongoing research. A date-scoped query surfaces recently added or modified records without requiring the researcher to monitor the museum's website.

### 26. Monitoring Catalogue Activity in a Research Area

**Research question:** Which objects in the Rijksmuseum's Asian art holdings have been recently modified in the catalogue? Retrieve the current metadata for the most recent changes.

**How the tools enable it:**
- `list_curated_sets` with `query: "Asian"` or `query: "Japan"` to find relevant set identifiers
- `get_recent_changes` with `setSpec` restricted to that set and a date range covering the last quarter
- `get_artwork_details` on the returned object numbers to examine the current state of provenance, attribution, and description

**Why it matters:** Museum catalogues are living documents — attributions change, provenance is discovered, dates are revised. The change-tracking tool identifies *which* records were recently touched; the detail tool reveals their current state. This does not show what changed (no diff is available), but it flags the records a researcher should re-examine.

---

## The LLM fills in the gaps

Because the MCP tools are used through a large language model, the LLM's own knowledge can act as a bridge between the researcher's question and the API's formal parameters.

### 27. Multilingual Access to a Dutch Collection

**Research question:** A Japanese scholar studying *Rangaku* (Dutch learning in Edo-period Japan) wants to find VOC-related objects and materials about the Dutch trading post at Dejima. 

**How the LLM enables it:**
- The researcher asks in English: "Find objects related to the Dutch trading post at Dejima"
- The LLM knows that Dejima is romanised from 出島, that the Dutch called it "Deshima," and that the Rijksmuseum catalogues it under various Dutch spellings
- It searches with the appropriate terms and explains the results in the researcher's language

**Why it matters:** The Rijksmuseum's metadata is partially in Dutch, with varying degrees of English translation. A LLM doesn't just translate — it can often handle variant spellings, historical place names, and terminological differences between languages.

### 28. Cross-Referencing Art Historical Knowledge

**Research question:** Show me works by the Utrecht Caravaggisti in the Rijksmuseum — I don't know which specific artists that includes.

**How the LLM enables it:**
- The student asks: "Show me works by the Utrecht Caravaggisti"
- The LLM identifies the relevant artists (Honthorst, Baburen, Ter Brugghen, van Bijlert) from its training knowledge
- It runs multiple `search_artwork` queries and synthesises the results

**Why it matters:** Art historical categories like "Utrecht Caravaggisti" are not search terms in the museum's metadata — they are scholarly constructs that group artists by style, period, and geography. The LLM can bridge from the category to the individual names, enabling conceptual searches that no fielded search interface supports.

### 29. Navigating Variant Names and Historical Spelling

**Research question:** Find all works by Hercules Seghers in the collection.

**How the LLM enables it:**
- The LLM recognises the spelling variant and searches under the museum's canonical form
- It explains the discrepancy so the student understands why a direct search would have failed
- It surfaces all 77 works without the student needing to guess the correct spelling

**Why it matters:** Historical names are notoriously unstable — Rembrandt van Rijn / Ryn, Albrecht Dürer / Durer / Duerer, Pieter Brueghel / Bruegel / Breughel. Every variant that differs from the museum's canonical form is a failed search. For well-known artists, an LLM can usually handle this seamlessly, drawing on its knowledge of naming conventions across art historical traditions.

---

## Technical Guide

The sections below are for developers who want to run the server locally, deploy it, or understand the architecture.

### Local Setup (stdio)

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
      "args": ["/absolute/path/to/rijksmuseum-mcp-plus/dist/index.js"]
    }
  }
}
```

Or install from npm without cloning:

```json
{
  "mcpServers": {
    "rijksmuseum": {
      "command": "npx",
      "args": ["-y", "rijksmuseum-mcp-plus"]
    }
  }
}
```

Restart your MCP client after updating the config.

### HTTP Deployment

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

### Tools

| Tool | Description |
|---|---|
| `search_artwork` | Search by query, title, creator, depicted person (`aboutActor`), type, material, technique, date, or description. Filter by image availability. At least one filter required. Supports wildcard date ranges (`16*` for 1600s) and compact mode for fast counts. Vocabulary-backed filters — `subject`, `iconclass`, `depictedPerson`, `depictedPlace`, `productionPlace`, `birthPlace`, `deathPlace`, `profession`, `collectionSet`, and `license` — enable subject, iconographic, and biographical search across 831,000 artworks. All filters can be freely combined for cross-field intersection queries. Vocabulary labels are bilingual (English and Dutch). |
| `get_artwork_details` | [24 metadata categories](docs/metadata-categories.md) by object number (e.g. `SK-C-5`): titles, creator, date, curatorial narrative, materials, object type, production details, structured dimensions, provenance, credit line, inscriptions, iconographic subjects (Iconclass codes, depicted persons, depicted places), license, related objects, collection sets, persistent IDs, and more. Vocabulary terms are resolved to English labels with links to Getty AAT, Wikidata, and Iconclass. |
| `get_artwork_bibliography` | Scholarly references for an artwork. Summary (first 5) or full (100+ for major works). Resolves publication records with ISBNs and WorldCat links. |
| `get_artwork_image` | IIIF image info + interactive inline deep-zoom viewer via [MCP Apps](https://github.com/modelcontextprotocol/ext-apps). Returns viewer data (IIIF ID, dimensions, URLs) — no image content. For LLM image analysis, use the `examine-artwork-image` prompt. |
| `get_artist_timeline` | Chronological timeline of an artist's works in the collection. |
| `open_in_browser` | Open any URL (artwork page, image, viewer) in the user's default browser. |
| `list_curated_sets` | List 192 curated collection sets (exhibitions, scholarly groupings, thematic selections). Optional name filter. Via OAI-PMH. |
| `browse_set` | Browse artworks in a curated set. Returns EDM records with titles, creators, dates, images, IIIF URLs, and iconographic subjects (Iconclass, depicted persons, places). Pagination via resumption token. |
| `get_recent_changes` | Track additions and modifications by date range. Full EDM records (including subjects) or lightweight headers (`identifiersOnly`). Pagination via resumption token. |

### Prompts and Resources

| Prompt / Resource | Description |
|---|---|
| `analyze-artwork` | Prompt: analyze an artwork's composition, style, and historical context |
| `examine-artwork-image` | Prompt: fetch high-resolution image for LLM visual analysis (1200px default) |
| `generate-artist-timeline` | Prompt: create a visual timeline of an artist's works |
| `art://collection/popular` | Resource: a curated selection of notable paintings |
| `ui://rijksmuseum/artwork-viewer.html` | Resource: interactive IIIF viewer (MCP Apps) |

### Architecture

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
    SystemIntegration.ts      — Cross-platform browser opening
apps/
  artwork-viewer/             — MCP Apps inline IIIF viewer (Vite + OpenSeadragon)
data/
  vocabulary.db               — Vocabulary database (built from OAI-PMH harvest, not in git)
```

### Data Sources

The server uses the Rijksmuseum's open APIs with no authentication required:

| API | URL | Purpose |
|---|---|---|
| Search API | `https://data.rijksmuseum.nl/search/collection` | Field-based search (title, creator, depicted person, type, material, technique, date, description, image availability), returns Linked Art URIs |
| Linked Art resolver | `https://id.rijksmuseum.nl/{id}` | Object metadata, vocabulary terms, and bibliography as JSON-LD |
| IIIF Image API | `https://iiif.micr.io/{id}/info.json` | High-resolution image tiles |
| OAI-PMH | `https://data.rijksmuseum.nl/oai` | Curated sets, EDM metadata records, date-based change tracking. 192 sets, 836K+ records. |

**Image discovery chain (4 HTTP hops):** Object `.shows` > VisualItem `.digitally_shown_by` > DigitalObject `.access_point` > IIIF info.json

**Vocabulary resolution:** Material, object type, technique, place, collection, and subject terms are Rijksmuseum vocabulary URIs. These are resolved in parallel to obtain English labels and links to external authorities (Getty AAT, Wikidata, Iconclass).

**Subject discovery chain:** Object `.shows` > VisualItem `.represents_instance_of_type` (Iconclass concepts) + `.represents` (depicted persons and places). Subject URIs are batched with the existing vocabulary resolution pass.

**Vocabulary database:** A pre-built SQLite database maps 149,000 controlled vocabulary terms (Iconclass codes, depicted persons, depicted places, production places, birth/death places, professions) to 831,000 artworks via 8 million mappings. Built from OAI-PMH EDM records and Linked Art vocabulary resolution, it powers the `subject`, `iconclass`, `depictedPerson`, `depictedPlace`, `productionPlace`, `birthPlace`, `deathPlace`, `profession`, `collectionSet`, and `license` filters in `search_artwork`.

**Bibliography resolution:** Publication references resolve to Schema.org Book records (a different JSON-LD context from the Linked Art artwork data) with author, title, ISBN, and WorldCat links.

### Configuration

| Variable | Description | Default |
|---|---|---|
| `PORT` | HTTP server port (presence triggers HTTP mode) | `3000` |
| `ALLOWED_ORIGINS` | CORS origins (comma-separated) | `*` |

---

## Data and Image Credits

Collection data and images are provided by the **[Rijksmuseum, Amsterdam](https://www.rijksmuseum.nl/)** via their [Linked Open Data APIs](https://data.rijksmuseum.nl/).

**Licensing:** Information and data that are no longer (or never were) protected by copyright carry the **Public Domain Mark** and/or **[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)**. Where the Rijksmuseum holds copyright, it generally waives its rights under CC0 1.0; in cases where it does exercise copyright, materials are made available under **[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)**. Materials under third-party copyright without express permission are not made available as open data. Individual licence designations appear on the [collection website](https://www.rijksmuseum.nl/en/rijksstudio).

**Attribution:** The Rijksmuseum considers it good practice to provide attribution and/or source citation via a credit line and data citation, regardless of the licence applied.

See the Rijksmuseum's [information and data policy](https://data.rijksmuseum.nl/policy/information-and-data-policy) for the full terms.

## Authors

- [Arno Bosse](https://orcid.org/0000-0003-3681-1289) — [RISE, University of Basel](https://rise.unibas.ch/)
- Claude Code — [Anthropic](https://www.anthropic.com/)

## License

This project is licensed under the [MIT License](LICENSE).
