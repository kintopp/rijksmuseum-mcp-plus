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

The `search_artwork` tool combines over 30 filters — from basic fields like creator, type, and date to vocabulary-backed parameters covering subject matter, production place, depicted persons, inscriptions, provenance, and dimension ranges — that can be composed to answer questions no single filter handles alone.

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

`search_artwork` includes seventeen database-backed filters — `subject`, `iconclass`, `depictedPerson`, `depictedPlace`, `productionPlace`, `birthPlace`, `deathPlace`, `profession`, `collectionSet`, `license`, `inscription`, `provenance`, `creditLine`, `curatorialNarrative`, `productionRole`, height ranges, and width ranges — drawn from a pre-built vocabulary database of 149,000 controlled terms mapped to 831,000 artworks via 12.8 million mappings. These enable searches by what is depicted, where it was made, who made it (including biographical attributes and production roles), what is written on it, what the museum says about it, and how large it is.

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
- Combine `productionPlace` with `creationDate` wildcards (e.g. `16*`) to narrow by period and identify the key printmakers at each centre
- Cross-reference with `profession: "printmaker"` and `birthPlace: "Haarlem"` to distinguish artists born in a city from those who merely worked there

**Why it matters:** Haarlem was the dominant centre of printmaking in the late 16th century until Amsterdam overtook it in the 17th. Production-place queries reveal the relative weight of each city in the collection, and comparing the leading printmakers at each centre surfaces secondary figures whose role may have been overlooked.

#### 6. Iconographic Traditions Across Media

**Research question:** How does the iconography of *vanitas* function differently in painting versus printmaking? Do the same symbolic conventions — skulls, hourglasses, extinguished candles, musical instruments — appear with equal frequency in both media?

**How the tools enable it:**
- `search_artwork` with `subject: "vanitas"` and `type: "painting"` to get all vanitas paintings — repeat with `type: "print"` to compare
- Combine `subject` with `creationDate` wildcards (e.g. `16*`, `17*`) to examine chronological patterns directly
- Cross-reference with `creator` to identify whether certain artists specialised in vanitas imagery across media or confined it to one

**Why it matters:** A subject-based search that crosses media boundaries enables systematic comparison of how a single iconographic tradition was adapted to different formats — the intimate painted still life versus the widely circulated print — without requiring extensive manual catalogue work.

---

### Artwork Details and Metadata

`get_artwork_details` returns [24 metadata categories](docs/metadata-categories.md) per artwork — far more than a typical museum search interface exposes. This depth enables object-level research that would otherwise require on-site catalogue consultation.

#### 7. Reading Inscriptions as Primary Sources

**Research question:** What textual information did Pieter Saenredam embed in his church interior paintings, and do the inscriptions serve documentary, devotional, or artistic purposes?

**How the tools enable it:**
- `search_artwork` with `inscription: "Saenredam"` to find all works with inscriptions mentioning the artist — or use `creator: "Pieter Saenredam"` and `type: "painting"` for his full oeuvre
- `get_artwork_details` on each result — the inscriptions category captures text transcribed from the painting surface
- Compare inscription content across works: dates, church names, biblical texts, artist signatures

**Why it matters:** Saenredam's inscriptions are unusually rich — they often include the exact date he made the preliminary drawing and the date he completed the painting, sometimes years apart. The `inscription` filter enables full-text search across ~500,000 artworks with transcribed inscriptions, making this information discoverable collection-wide.

#### 8. Dimensions as Evidence for Workshop Practice

**Research question:** Were there standard panel sizes used in Dutch workshops? Can we identify clusters of dimensions that suggest pre-prepared supports from panel makers?

**How the tools enable it:**
- `search_artwork` with `type: "painting"`, `material: "panel"`, and dimension ranges (e.g. `minHeight: 40`, `maxHeight: 50`, `minWidth: 30`, `maxWidth: 40`) to find panels of a specific size cluster
- Compare across size ranges to identify recurring dimensions that suggest standard panel formats
- `get_artwork_details` on results to check exact measurements, creator, and production context — add `creationDate` to narrow by period (e.g. `17*` for the 17th century)

**Why it matters:** The dimension filters make it possible to search by physical size directly, rather than retrieving all works and filtering manually. The Rijksmuseum's structured dimension data can corroborate (or challenge) what we know from guild records about panel maker standards.

#### 9. Credit Lines and Acquisition Context

**Research question:** How did the Rijksmuseum acquire its core Rembrandt collection? What proportion came through purchase, bequest, or state allocation, and when?

**How the tools enable it:**
- `search_artwork` with `creditLine: "purchase"` and `creator: "Rembrandt"` to find works acquired by purchase — repeat with `"bequest"`, `"gift"`, `"loan"`
- `search_artwork` with `provenance: "Rembrandt"` for broader ownership-history search
- `get_artwork_details` on each for full provenance chain and credit line context

**Why it matters:** The `creditLine` and `provenance` filters enable full-text search across acquisition records (~358K credit lines, ~48K provenance entries), making collection history systematically researchable without examining each artwork individually.

---

### Bibliographic References

`get_artwork_bibliography` exposes the museum's scholarship tracking — from five references for minor works to over a hundred for masterpieces.

#### 10. Measuring Scholarly Attention

**Research question:** Compare the bibliography counts across Vermeer's paintings in the Rijksmuseum — which have received the most and least scholarly attention?

**How the tools enable it:**
- `search_artwork` with `creator: "Johannes Vermeer"` and `type: "painting"`
- `get_artwork_bibliography` with `full: false` (summary mode) on each result — returns total citation counts
- Rank the paintings from most to least studied

**Why it matters:** Vermeer's four paintings in the Rijksmuseum are not equally studied. Comparing bibliography counts reveals which works have attracted disproportionate attention and which represent gaps — useful for identifying a dissertation topic or an overlooked angle.

#### 11. Building a Literature Review

**Research question:** What is the complete published scholarship on Jan Asselijn's *The Threatened Swan*, and how has its interpretation changed over time?

**How the tools enable it:**
- `get_artwork_bibliography` with `objectNumber: "SK-A-4"` and `full: true`
- Review the chronological sequence of publications — early catalogue entries, monograph treatments, interpretive essays
- Use ISBNs and WorldCat links to locate sources in university libraries

**Why it matters:** The bibliography tool provides a structured starting point with publication metadata (authors, titles, years, ISBNs) that would otherwise require consulting the museum's paper files or visiting the Rijksprentenkabinet library.

#### 12. Iconographic Depth and Scholarly Attention

**Research question:** Which depictions of the Crucifixion in the Rijksmuseum have generated the most scholarly literature, and how does the depth of scholarship on major biblical scenes compare across Iconclass categories?

**How the tools enable it:**
- `search_artwork` with `iconclass: "73D82"` (Crucifixion) to find all Crucifixion scenes
- `get_artwork_bibliography` with `full: false` on each result to compare citation counts
- Repeat with `iconclass: "73A52"` (Annunciation) and `iconclass: "73D24"` (Last Supper) to compare across scenes
- `get_artwork_details` on the most-cited works to examine how subject matter correlates with scholarly interest

**Why it matters:** Iconclass notation codes provide precise iconographic categories that label-based subject search cannot match — `73D82` retrieves Crucifixion scenes regardless of whether the title or description mentions the word. Comparing bibliography depth across Iconclass codes reveals which biblical subjects have attracted disproportionate scholarly attention in the Rijksmuseum's holdings.

---

### High-Resolution Images

`get_artwork_image` provides an interactive viewer with a high-resolution, deep-zoom feature. For some artworks, this is sufficient to examine individual brushstrokes, craquelure patterns, and inscriptions that are invisible in standard reproductions.

#### 13. Technical Art History at the Brushstroke Level

**Research question:** What materials, technique, and support were used in Rembrandt's *The Night Watch*, what are its exact dimensions, and what inscriptions does it carry? Open the high-resolution image for close examination of the paint surface.

**How the tools enable it:**
- `get_artwork_details` with `objectNumber: "SK-C-5"` returns materials, technique statement, structured dimensions, and inscriptions
- `get_artwork_image` opens the interactive deep-zoom viewer for close examination at maximum magnification

**Why it matters:** Technical metadata — support material, paint type, exact dimensions — frames what the viewer reveals. Knowing a canvas is 363 x 437 cm contextualises the scale of visible brushwork; knowing the inscription text lets the user verify it against the painted surface at full zoom.

#### 14. Comparative Detail Analysis Across Works

**Research question:** How many paintings by Leiden-born painters versus Haarlem-born painters does the Rijksmuseum hold, and who are the leading artists from each school? Open a representative work from each — a Gerrit Dou and a Frans Hals — for side-by-side examination at high zoom.

**How the tools enable it:**
- `search_artwork` with `birthPlace: "Leiden"`, `profession: "painter"`, `type: "painting"`, `compact: true` for a count — repeat with `birthPlace: "Haarlem"`
- Non-compact searches to identify the principal artists from each city
- `get_artwork_image` on a Dou and a Hals to open both in the deep-zoom viewer

**Why it matters:** The `birthPlace` filter identifies artists by geographic origin without requiring the researcher to already know who belongs to which school. The quantitative comparison reveals the relative weight of each school in the collection, and the viewer delivers the images for visual analysis of their contrasting techniques.

#### 15. Reproductive Prints and Their Painted Sources

**Research question:** How faithfully do reproductive prints translate the compositions of their painted sources? Find prints made "after" a specific painting and compare the print with the original at high magnification.

**How the tools enable it:**
- `search_artwork` with `productionRole: "after painting by"` and `creator: "Rembrandt"` to find reproductive prints based on Rembrandt's compositions
- `get_artwork_details` on a result — the `relatedObjects` field links to the source painting
- `resolve_uri` on the related object URI to retrieve the source painting's full metadata
- `get_artwork_image` on both the print and the painting for side-by-side comparison at high zoom

**Why it matters:** The `productionRole` filter distinguishes the *function* an artist played in creating a specific work — "after painting by" identifies reproductive prints explicitly, rather than requiring the researcher to infer the relationship from titles or descriptions. The `relatedObjects` link then provides a direct path from reproduction to source, and the viewer enables the visual comparison that art historical analysis demands.

---

### Artist Timelines

`get_artist_timeline` arranges an artist's works chronologically, revealing career patterns invisible when browsing search results.

#### 16. Tracing Career Evolution Through Subject and Place

**Research question:** Jacob van Ruisdael's landscapes are said to evolve from flat dune scenes in his Haarlem years to dramatic waterfalls and panoramic views after his move to Amsterdam. Does the timeline of his works in the Rijksmuseum support this narrative?

**How the tools enable it:**
- `get_artist_timeline` with `artist: "Jacob van Ruisdael"`
- `get_artwork_details` on each work — read description, title, and `production[].place` to identify subject matter and where each work was made
- Map subject type and production place against date: do the dune landscapes cluster in the early years and the waterfalls in the later ones?

**Why it matters:** Art historical narratives about career evolution are often based on a handful of securely dated works. A timeline across a full museum holding tests these narratives against a larger evidence base — and the production-place data can reveal whether the geographic move and the stylistic shift actually coincide.

#### 17. Medium Shifts Within a Career

**Research question:** George Hendrik Breitner is classified in the Rijksmuseum's vocabulary as painter, draughtsman, and printmaker. Does the timeline of his works reveal a clear sequence — drawing first, then painting, then prints — or did he work across media simultaneously?

**How the tools enable it:**
- `search_artwork` with `profession: "painter"` and `creator: "Breitner"` to confirm his multi-profession classification
- `get_artist_timeline` with `artist: "George Hendrik Breitner"`
- `get_artwork_details` on each work to extract medium and technique
- Plot medium against date: do drawings cluster in the early years, paintings in the middle, photographs at the end — or is the practice mixed throughout?

**Why it matters:** An artist classified under multiple professions may have practised them simultaneously or sequentially. The timeline reveals which, and whether any transition aligns with documented biographical events. 

#### 18. Comparing Parallel Careers

**Research question:** How do the career trajectories of Jan Steen and Gabriël Metsu compare — two genre painters active in the same cities at the same time?

**How the tools enable it:**
- `get_artist_timeline` for both artists
- Compare: date ranges, number of works per decade, medium distribution
- Use `get_artwork_details` on representative works from each to compare subject matter and scale

**Why it matters:** Parallel career comparison is a standard for understanding market positioning, artistic rivalry, and influence. The timeline tool generates the raw data for these comparisons.

---

### Curated Sets

`list_curated_sets` and `browse_set` expose the museum's 192 curatorial groupings — thematic, scholarly, and exhibition-based. These sets encode expert knowledge about how objects relate to each other.

#### 19. Reconstructing Past Exhibitions

**Research question:** What objects were included in Rijksmuseum exhibitions related to Rembrandt, and how did the curatorial selection construct a narrative?

**How the tools enable it:**
- `list_curated_sets` with a keyword filter to find the relevant set
- `browse_set` with the set identifier to retrieve all included objects
- `get_artwork_details` on key objects to understand what they contribute to the exhibition thesis

**Why it matters:** Exhibitions are arguments made with objects — the selection, sequencing, and juxtaposition of works constitutes an interpretation. Being able to retrieve the object list for a past exhibition enables historiographic analysis of curatorial practice.

#### 20. Finding Thematic Connections Curators Have Already Made

**Research question:** Has the Rijksmuseum curated any groupings related to Dutch maritime trade, and what objects did they consider central to that story?

**How the tools enable it:**
- `list_curated_sets` with `query: "maritime"` or `query: "trade"` or `query: "VOC"`
- `browse_set` to see the contents — paintings, maps, ship models, porcelain, documents

**Why it matters:** Curated sets cross media boundaries. These cross-media juxtapositions can reveal connections that medium-specific searches miss.

#### 21. Assessing Collection Depth for Grant Applications

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

#### 22. Tracking New Acquisitions in a Research Area

**Research question:** Has the Rijksmuseum added any new 17th-century paintings to its collection in the past six months? If so, who are the artists and what are the subjects?

**How the tools enable it:**
- `get_recent_changes` with a date range covering the last six months
- Use `identifiersOnly: true` for a fast scan of recently changed object numbers
- `get_artwork_details` on results to filter for paintings from the 1600s and examine creator, date, and description

**Why it matters:** New acquisitions can fill gaps in the evidence or provide crucial comparisons for ongoing research. A date-scoped query surfaces recently added or modified records without requiring the researcher to monitor the museum's website.

#### 23. Monitoring Catalogue Activity in a Research Area

**Research question:** Which objects in the Rijksmuseum's Asian art holdings have been recently modified in the catalogue? Retrieve the current metadata for the most recent changes.

**How the tools enable it:**
- `list_curated_sets` with `query: "Asian"` or `query: "Japan"` to find relevant set identifiers
- `get_recent_changes` with `setSpec` restricted to that set and a date range covering the last quarter
- `get_artwork_details` on the returned object numbers to examine the current state of provenance, attribution, and description

**Why it matters:** Museum catalogues are living documents — attributions change, provenance is discovered, dates are revised. The change-tracking tool identifies *which* records were recently touched; the detail tool reveals their current state. This does not show what changed (no diff is available), but it flags the records a researcher should re-examine.

---

### The LLM fills in the gaps

Because the MCP tools are used through a large language model, the LLM's own knowledge can act as a bridge between the researcher's question and the API's formal parameters.

#### 24. Multilingual Access to a Dutch Collection

**Research question:** A Japanese scholar studying *Rangaku* (Dutch learning in Edo-period Japan) wants to find VOC-related objects and materials about the Dutch trading post at Dejima. 

**How the LLM enables it:**
- The researcher asks in English: "Find objects related to the Dutch trading post at Dejima"
- The LLM knows that Dejima is romanised from 出島, that the Dutch called it "Deshima," and that the Rijksmuseum catalogues it under various Dutch spellings
- It searches with the appropriate terms and explains the results in the researcher's language

**Why it matters:** The Rijksmuseum's metadata is partially in Dutch, with varying degrees of English translation. A LLM doesn't just translate — it can often handle variant spellings, historical place names, and terminological differences between languages.

#### 25. Cross-Referencing Art Historical Knowledge

**Research question:** Show me works by the Utrecht Caravaggisti in the Rijksmuseum — I don't know which specific artists that includes.

**How the LLM enables it:**
- The student asks: "Show me works by the Utrecht Caravaggisti"
- The LLM identifies the relevant artists (Honthorst, Baburen, Ter Brugghen, van Bijlert) from its training knowledge
- It runs multiple `search_artwork` queries and synthesises the results

**Why it matters:** Art historical categories like "Utrecht Caravaggisti" are not search terms in the museum's metadata — they are scholarly constructs that group artists by style, period, and geography. The LLM can bridge from the category to the individual names, enabling conceptual searches that no fielded search interface supports.

#### 26. Geographic Research Without Knowing the Map

**Research question:** I'm studying how the landscape around Haarlem was depicted in the 17th century — not just the city itself but the dunes, bleaching fields, and villages within walking distance. What does the Rijksmuseum hold?

**How the LLM enables it:**
- The LLM recognises this as a geographic proximity query and uses `nearPlace: "Haarlem"` with `nearPlaceRadius: 15` (roughly walking distance) to find artworks connected to the Haarlem area
- It combines this with `creationDate: "16*"` to restrict to the 17th century
- It then uses `curatorialNarrative` to search curatorial wall texts for "dune", "bleaching", or "Haarlemmermeer" to find works the museum has specifically contextualised in terms of the local landscape
- The LLM synthesises the geographic and curatorial narrative results, explaining which villages and landscape features appear in the collection

**Why it matters:** The researcher doesn't need to know which specific villages fall within 15 km of Haarlem — the LLM and the geocoded place vocabulary handle that. The `curatorialNarrative` search adds a curatorial dimension: it surfaces works where the museum itself has written about the landscape context, connecting the geographic data with art historical interpretation. This combination of proximity search and curatorial text search is something no conventional museum interface offers.
