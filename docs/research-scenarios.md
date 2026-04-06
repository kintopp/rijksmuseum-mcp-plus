## Research Scenarios

The `search_artwork` tool combines [39 filters](search-parameters.md) — from basic fields like creator, type, and date to vocabulary-backed parameters covering subject matter, production place, depicted persons, inscriptions, provenance, dimension ranges, creator demographics, attribution qualifiers, and place hierarchy — that can be composed to answer questions no single filter handles alone. The results are ranked by relevance (BM25) when text search filters are active (title, description, inscription, narrative, provenance), by geographic proximity for spatial queries, and by importance (a composite score reflecting image availability, curatorial attention, and metadata richness) for vocabulary-filter queries — so the most significant works surface first.

- [Searching the Collection](#searching-the-collection)
- [Subject and Iconographic Search](#subject-and-iconographic-search)
- [Artwork Details and Metadata](#artwork-details-and-metadata)
- [High-Resolution Images](#high-resolution-images)
- [Artist Timelines](#artist-timelines)
- [Curated Sets](#curated-sets)
- [Collection Changes](#collection-changes)
- [Semantic Search](#semantic-search)
- [Provenance Research](#provenance-research)

The links following each research question show how the query was answered in Claude Desktop. However, they only reproduce the textual portion of the response (no image viewer or visualisations). For some queries, 'extended thinking' had been enabled in Claude allowing you to trace (to some degree) the model's step-by-step 'reasoning' during a task.

## Searching the Collection

### 1. Mapping an Artist's Output Across Media

*What is the actual distribution of Rembrandt's works in the Rijksmuseum across painting, printmaking, and drawing — and how does this challenge popular perceptions of him as primarily a painter?* [Link](https://claude.ai/share/ad43a233-e48a-49ad-bd72-bd7828a0036c)

**How the tools enable it:**
- `collection_stats` with `dimension: "type"` and `creator: "Rembrandt"` returns the full distribution across all media in a single call
- Follow up with `search_artwork` using `creator: "Rembrandt"` and `type: "painting"` (or `"print"`, `"drawing"`) to browse specific categories
- `get_artwork_details` on selected works from each category for full metadata

**Why it matters:** The Rijksmuseum holds ~30 Rembrandt paintings but over 1,000 prints and hundreds of drawings. Most students encounter Rembrandt through a handful of iconic canvases. Seeing the actual proportions reframes his practice as fundamentally graphic.

### 2. Material Culture Beyond the Canon

*What is the scope of the Rijksmuseum's non-European holdings? How are Indonesian, Japanese, Chinese, and Indian objects distributed across media, and where were they produced?* [Link](https://claude.ai/share/b4a0033d-4391-4040-8626-8630b08e2f8c)

**How the tools enable it:**
- `collection_stats` with `dimension: "type"` and `productionPlace: "Japan"` returns the full media distribution for Japanese-produced works in a single call — repeat for `"China"`, `"Java"`, `"India"`
- Use `depictedPlace` to find works that *represent* these places, regardless of where they were made — separating objects produced in Asia from European depictions of Asia
- Use `imageAvailable: true` to assess digitisation coverage
- `search_artwork` to browse specific subsets (e.g. Japanese ceramics, Indian textiles)

**Why it matters:** The Rijksmuseum positions itself as a museum of Dutch art *and* history, which includes centuries of global trade. The combination of `productionPlace` and `depictedPlace` enables a crucial distinction: objects *from* Asia versus European images *of* Asia.

### 3. Tracking the Adoption of Artistic Techniques

*When did etching overtake engraving as the dominant printmaking technique in the Netherlands, and how do lesser-known techniques — mezzotint, aquatint, woodcut — appear in the Rijksmuseum collection over time?* [Link](https://claude.ai/share/85e48003-9abe-43fb-8088-0b57aeb7b2b1)

**How the tools enable it:**
- `collection_stats` with `dimension: "decade"`, `type: "print"`, `technique: "engraving"` returns the full chronological distribution of engravings — repeat with `technique: "etching"` to compare the two curves
- Extend to `technique: "mezzotint"`, `"woodcut"`, `"aquatint"` to map the full technical repertoire over time
- Use `dateMatch: "midpoint"` for non-overlapping decade bins (each artwork counted exactly once)
- `search_artwork` and `get_artwork_details` on selected works from each technique to examine materials and production context

**Why it matters:** The shift from engraving to etching is a defining transition in European printmaking. Date-wildcard queries make this transition quantifiable at collection scale, and the results reveal whether the Rijksmuseum's holdings reflect the standard chronology or complicate it.

---

## Subject and Iconographic Search

`search_artwork` includes [37 database-backed filters](search-parameters.md) drawn from a vocabulary database of ~194,000 controlled terms mapped to ~832,000 artworks via ~13.7 million mappings, enriched with creator biographical data (~49K life dates, ~64K gender annotations) and a spatial place hierarchy (~31K geocoded places). These enable searches by what is depicted, where it was made, who made it (including life dates, gender, and production roles), what is written on it, what the museum says about it, and how large it is.

### 4. Mapping the Visual Rhetoric of the Stadholders

*How were the successive Princes of Orange visually represented across different media, and can we trace shifts in propaganda strategy from Maurice to William III?* [Link](https://claude.ai/share/3db41904-f9ea-43ba-bf45-7d210213d71e)

**How the tools enable it:**
- `collection_stats` with `dimension: "type"` and `depictedPerson: "Maurice"` returns the full media distribution in a single call — repeat for `"Frederick Henry"`, `"William II"`, `"William III"`
- `collection_stats` with `dimension: "decade"` and `depictedPerson` for each stadholder to map the chronological spread of their representation
- `search_artwork` to browse specific subsets (e.g. paintings of William III, prints of Maurice)
- Use `get_artwork_details` on selected results to compare how each ruler was staged — martial, dynastic, classical

**Why it matters:** The Orange-Nassau dynasty used visual media strategically, but the balance between painted portraits (diplomatic gifts, court display) and printed imagery (popular circulation, political pamphlets) shifted across generations. A depicted-person search makes this media strategy empirically visible.

### 5. Production Geography and the Network of Printmaking Cities

*Which cities dominate the Rijksmuseum's printmaking holdings, and how do the principal printmakers differ between Haarlem, Amsterdam, Leiden, and Antwerp?* [Link](https://claude.ai/share/412abe3e-77e6-4296-8ba2-1d53a425cf17)

**How the tools enable it:**
- `collection_stats` with `dimension: "productionPlace"`, `type: "print"` returns the top print-producing cities ranked by count
- `collection_stats` with `dimension: "creator"`, `type: "print"`, `productionPlace: "Haarlem"` to identify the key printmakers at each centre — repeat for `"Amsterdam"`, `"Leiden"`, `"Antwerp"`
- Add `creationDateFrom`/`creationDateTo` to narrow by period
- Cross-reference with `profession: "printmaker"` and `birthPlace: "Haarlem"` to distinguish artists born in a city from those who merely worked there
- `search_artwork` to browse specific subsets and `get_artwork_details` for full metadata

**Why it matters:** Haarlem was the dominant centre of printmaking in the late 16th century until Amsterdam overtook it in the 17th. Production-place queries reveal the relative weight of each city in the collection, and comparing the leading printmakers at each centre surfaces secondary figures whose role may have been overlooked.

### 6. Iconographic Traditions Across Media

*How does the iconography of "vanitas" function differently in painting versus printmaking? Do the same symbolic conventions — skulls, hourglasses, extinguished candles, musical instruments — appear with equal frequency in both media?* [Link](https://claude.ai/share/94d6f781-1328-46f3-8ca9-0723475f61db)

**How the tools enable it:**
- `collection_stats` with `dimension: "type"` and `subject: "vanitas"` to compare the distribution across painting, print, and drawing in a single call
- `collection_stats` with `dimension: "decade"` and `subject: "vanitas"` to map the chronological spread
- `collection_stats` with `dimension: "creator"` and `subject: "vanitas"` to identify whether certain artists specialised in vanitas imagery
- `search_artwork` with `subject: "vanitas"` and `type: "painting"` (or `"print"`) to browse specific subsets
- For a broader net: `semantic_search` with `query: "vanitas symbolism and mortality"` can surface works that engage with vanitas *themes* — transience, decay, the futility of worldly pursuits — even when they are not tagged with the Iconclass `vanitas` label

**Why it matters:** A subject-based search that crosses media boundaries enables systematic comparison of how a single iconographic tradition was adapted to different formats — the intimate painted still life versus the widely circulated print — without requiring extensive manual catalogue work. Semantic search extends the reach beyond formally tagged works to those where curators have described vanitas themes in narrative texts.

---

## Artwork Details and Metadata

`get_artwork_details` returns [26 metadata categories](metadata-categories.md) per artwork — far more than a typical museum search interface exposes. This depth enables object-level research that would otherwise require on-site catalogue consultation.

### 7. Dimensions as Evidence for Workshop Practice

*Were there standard panel sizes used in Dutch workshops? Can we identify clusters of dimensions that suggest pre-prepared supports from panel makers?* [Link](https://claude.ai/share/51f0d0c8-bb82-4e84-aa7e-22d5eb386fdf)

**How the tools enable it:**
- `search_artwork` with `type: "painting"`, `material: "panel"`, and dimension ranges (e.g. `minHeight: 40`, `maxHeight: 50`, `minWidth: 30`, `maxWidth: 40`) to find panels of a specific size cluster
- Compare across size ranges to identify recurring dimensions that suggest standard panel formats
- `get_artwork_details` on results to check exact measurements, creator, and production context — add `creationDate` to narrow by period (e.g. `17*` for the 17th century)

**Why it matters:** The dimension filters make it possible to search by physical size directly, rather than retrieving all works and filtering manually. The Rijksmuseum's structured dimension data can corroborate (or challenge) what we know from guild records about panel maker standards.

### 8. Credit Lines and Acquisition Context

*How did the Rijksmuseum acquire its core Rembrandt collection? What proportion came through purchase, bequest, or state allocation, and when?* [Link](https://claude.ai/share/094cc47e-6381-49ab-a22a-a098254a3945)

**How the tools enable it:**
- `search_artwork` with `creditLine: "purchase"` and `creator: "Rembrandt"` to find works acquired by purchase — repeat with `"bequest"`, `"gift"`, `"loan"`
- `search_provenance` with `creator: "Rembrandt"` for the full parsed ownership chain of each work — filter by `transferType: "sale"` or `"bequest"` to trace specific acquisition modes, or sort by `sortBy: "price"` to rank by transaction value
- `collection_stats` with `dimension: "transferType"` and `creator: "Rembrandt"` for a single-call distribution of how Rembrandt works changed hands
- `get_artwork_details` on each for full provenance chain and credit line context

**Why it matters:** The `creditLine` and `provenance` filters enable full-text search across acquisition records (~358,000 credit lines, ~48,000 provenance entries). `search_provenance` goes further with parsed, structured provenance data — searchable by party, transfer type, date, location, and price — making collection history systematically researchable without examining each artwork individually.

### 9. Women Artists Across Centuries and Media

*What is the representation of women artists in the Rijksmuseum's collection? How does their presence vary across centuries and media — and which women produced the most works in the collection?* [Link](https://claude.ai/share/35fdb5da-37f5-4f74-b34d-143a330669d8)

**How the tools enable it:**
- `collection_stats` with `dimension: "type"` and `creatorGender: "female"` returns the full media distribution for women artists in a single call — compare with `creatorGender: "male"` for the ratio
- `collection_stats` with `dimension: "decade"` and `creatorGender: "female"` to map the distribution over time. Use `dateMatch: "midpoint"` for non-overlapping bins
- `collection_stats` with `dimension: "creator"` and `creatorGender: "female"`, `type: "painting"` to identify the leading women painters
- `search_artwork` with `creatorBornAfter: 1800`, `creatorBornBefore: 1900`, `creatorGender: "female"`, `type: "painting"` to focus on 19th-century women painters specifically
- Combine with `expandPlaceHierarchy: true` and `productionPlace: "Netherlands"` to include works from all Dutch cities
- `get_artwork_details` on selected works — the `personInfo` on production entries shows birth/death years and biographical notes

**Why it matters:** The gender filter makes visible a dimension of collection composition that is otherwise buried in individual records. Rather than searching by name for artists the researcher already knows to be women, `creatorGender` reveals the full extent of women's presence — including lesser-known figures whose work may not appear in standard art historical narratives. The century and medium breakdowns expose structural patterns: whether women were more active in certain media, whether their representation grew or shrank over time, and which individuals anchor the collection's holdings.

---

## High-Resolution Images

`get_artwork_image` provides an interactive viewer with a high-resolution, deep-zoom feature. For some artworks, this is sufficient to examine individual brushstrokes, craquelure patterns, and inscriptions that are invisible in standard reproductions.

### 10. Technical Art History at the Brushstroke Level

*What materials, technique, and support were used in Rembrandt's "The Night Watch", what are its exact dimensions, and what inscriptions does it carry? Open the high-resolution image for close examination of the paint surface.* [Link](https://claude.ai/share/344b8837-139a-4b2a-8846-990a88e6a912)

**How the tools enable it:**
- `get_artwork_details` with `objectNumber: "SK-C-5"` returns materials, technique statement, structured dimensions, and inscriptions
- `get_artwork_image` opens the interactive deep-zoom viewer for close examination at maximum magnification
- `inspect_artwork_image` retrieves specific regions as base64 for direct AI analysis — e.g. crop the lower-right corner to read a signature, or zoom into a face to examine brushwork. 

**Why it matters:** Technical metadata — support material, paint type, exact dimensions — frames what the viewer reveals. Knowing a canvas is 363 x 437 cm contextualises the scale of visible brushwork; knowing the inscription text lets the user verify it against the painted surface at full zoom. Direct image inspection by the AI adds a layer of visual analysis that goes beyond metadata alone.

### 11. Comparative Detail Analysis Across Works

*How many paintings by Leiden-born painters versus Haarlem-born painters does the Rijksmuseum hold, and who are the leading artists from each school? Open a representative work from each — a Gerrit Dou and a Frans Hals — for side-by-side examination at high zoom.* [Link](https://claude.ai/share/383f023a-a3b3-449e-bedf-773525ae9c25)

**How the tools enable it:**
- `search_artwork` with `birthPlace: "Leiden"`, `profession: "painter"`, `type: "painting"`, `compact: true` for a count — repeat with `birthPlace: "Haarlem"`
- Non-compact searches to identify the principal artists from each city
- `get_artwork_image` on a Dou and a Hals to open both in the deep-zoom viewer

**Why it matters:** The `birthPlace` filter identifies artists by geographic origin without requiring the researcher to already know who belongs to which school. The quantitative comparison reveals the relative weight of each school in the collection, and the viewer delivers the images for visual analysis of their contrasting techniques.

### 12. Reading Inscriptions and Examining Details with AI Vision

*Open Utamaro's "Waitress at the Matsu Higashi House" (RP-P-1956-605) and read the Japanese text on the print — the catalogue has no transcribed inscriptions for this work. Highlight the text areas you find and tell me if you notice anything missing that you'd expect on a print of this period.* [Link](https://claude.ai/share/00ae1128-7d23-4b97-9f64-d00a26c434ba)

**How the tools enable it:**
- `get_artwork_details` confirms the inscriptions field is empty — the catalogue has not transcribed the Japanese text
- `get_artwork_image` opens the interactive deep-zoom viewer
- `inspect_artwork_image` with `region: "full"` gives the AI an overview of the composition — it can identify the establishment signboard (松東居, "Matsu Higashi-ya") in the upper right and the artist's signature (哥麿筆, "drawn by Utamaro") below it, neither of which appears in the structured metadata
- Targeted crops let the AI examine each text element at high resolution, and `navigate_viewer` with `add_overlay` highlights them for the user
- The AI can also note what is *absent* — in this case, no publisher's seal (hanmoto) or censor's seal (kiwame-in) is visible, which is unusual for a print of this era and may indicate trimming
- **User-directed inspection:** click the image viewer to give it focus, then press `i` (or click the rightmost toolbar button) to enter interactive mode. Draw a rectangle around any area of interest — the coordinates are sent to the chat as a prompt. Add your own question (e.g. "what does this text say?" or "is there a seal mark here?") and the AI will inspect that exact region at high resolution

**Why it matters:** The Rijksmuseum's catalogue metadata for Japanese prints typically does not include transcriptions of the printed Japanese text — artist signatures, establishment names, publisher marks, and poem cartouches are visible on the image but absent from the structured data. Direct image inspection by the AI can often read and translate this text, surfacing information that would otherwise require specialist knowledge of Japanese. It can also flag missing elements — a print without a publisher's seal raises questions about trimming or provenance that a researcher might want to investigate. 

### 13. Reproductive Prints and Their Painted Sources

*How faithfully do reproductive prints translate the compositions of their painted sources? Find prints made "after" a specific painting and compare the print with the original at high magnification.* [Link](https://claude.ai/share/e822477d-6039-4103-8361-7ef77c7a523b)

**How the tools enable it:**
- `search_artwork` with `productionRole: "after painting by"` and `creator: "Rembrandt"` to find reproductive prints based on Rembrandt's compositions
- `get_artwork_details` on a result — the `relatedObjects` field links to the source painting
- `get_artwork_details` with the related object's URI to retrieve the source painting's full metadata
- `get_artwork_image` on both the print and the painting for side-by-side comparison at high zoom

**Why it matters:** The `productionRole` filter distinguishes the *function* an artist played in creating a specific work — "after painting by" identifies reproductive prints explicitly, rather than requiring the researcher to infer the relationship from titles or descriptions. The `relatedObjects` link then provides a direct path from reproduction to source, and the viewer enables the visual comparison that art historical analysis demands.

---

## Artist Timelines

`search_artwork` with a `creator` filter returns results sorted by importance, which can be re-sorted by date to reveal career patterns invisible when browsing search results. The `generate-artist-timeline` prompt automates this workflow.

### 14. Tracing Career Evolution Through Subject and Place

*Jacob van Ruisdael's landscapes are said to evolve from flat dune scenes in his Haarlem years to dramatic waterfalls and panoramic views after his move to Amsterdam. Does the timeline of his works in the Rijksmuseum support this narrative?* [Link](https://claude.ai/share/7f25a37c-f8e2-488d-9d19-9aba27f932af)

**How the tools enable it:**
- `search_artwork` with `creator: "Jacob van Ruisdael"`, then sort results by date
- `get_artwork_details` on each work — read description, title, and `production[].place` to identify subject matter and where each work was made
- Map subject type and production place against date: do the dune landscapes cluster in the early years and the waterfalls in the later ones?

**Why it matters:** Art historical narratives about career evolution are often based on a handful of securely dated works. A timeline across a full museum holding tests these narratives against a larger evidence base — and the production-place data can reveal whether the geographic move and the stylistic shift actually coincide.

### 15. Medium Shifts Within a Career

*George Hendrik Breitner worked as a painter, draughtsman, and photographer. Does the timeline of his works in the Rijksmuseum reveal a clear sequence — drawing first, then painting, then photography — or did he work across media simultaneously?* [Link](https://claude.ai/share/9c62f373-2dfc-4a63-bd87-26d376b1cac3)

**How the tools enable it:**
- `search_artwork` with `profession: "painter"` and `creator: "Breitner"` to confirm his multi-profession classification
- `search_artwork` with `creator: "George Hendrik Breitner"`, then sort by date
- `get_artwork_details` on each work to extract medium and technique
- Plot medium against date: do drawings cluster in the early years, paintings in the middle, photographs at the end — or is the practice mixed throughout?

**Why it matters:** An artist classified under multiple professions may have practised them simultaneously or sequentially. The timeline reveals which, and whether any transition aligns with documented biographical events.

---

## Curated Sets

`list_curated_sets` and `browse_set` expose the museum's 192 curatorial groupings — thematic, scholarly, and exhibition-based. These sets encode expert knowledge about how objects relate to each other.

### 16. Reconstructing Past Exhibitions

*What objects were included in Rijksmuseum exhibitions related to Rembrandt, and how did the curatorial selection construct a narrative?* [Link](https://claude.ai/share/03dad0c4-731a-411a-9223-95ead26a5917)

**How the tools enable it:**
- `list_curated_sets` with a keyword filter to find the relevant set
- `browse_set` with the set identifier to retrieve all included objects
- `get_artwork_details` on key objects to understand what they contribute to the exhibition thesis

**Why it matters:** Exhibitions are arguments made with objects — the selection, sequencing, and juxtaposition of works constitutes an interpretation. Being able to retrieve the object list for a past exhibition enables historiographic analysis of curatorial practice.

### 17. Finding Thematic Connections Curators Have Already Made

*Has the Rijksmuseum curated any groupings related to Dutch maritime trade, and what objects did they consider central to that story?* [Link](https://claude.ai/share/88ca435e-9854-457e-9738-a8f1423b0217)

**How the tools enable it:**
- `list_curated_sets` with `query: "maritime"` or `query: "trade"` or `query: "VOC"`
- `browse_set` to see the contents — paintings, maps, ship models, porcelain, documents

**Why it matters:** Curated sets cross media boundaries. These cross-media juxtapositions can reveal connections that medium-specific searches miss.

### 18. Assessing Collection Depth for Grant Applications

*How many Japanese prints does the Rijksmuseum hold, what curated sets relate to Japanese art, what date range do the holdings cover, and which artists are best represented?* [Link](https://claude.ai/share/303fd236-da49-4e97-a7c0-ca1b484b3bc1)

**How the tools enable it:**
- `collection_stats` with `dimension: "creator"`, `productionPlace: "Japan"`, `type: "print"` to identify the most prominent printmakers and get the total count
- `collection_stats` with `dimension: "decade"`, `productionPlace: "Japan"`, `type: "print"` for the chronological spread
- `list_curated_sets` filtered for Japanese-related sets
- `browse_set` on relevant sets to see the range of artists, dates, and subjects

**Why it matters:** Grant applications require demonstrating that the proposed research site has adequate resources. Concrete numbers — total holdings, date range, named artists, curated set identifiers — strengthen the feasibility argument.

---

## Collection Changes

`get_recent_changes` tracks what the museum adds and updates, providing a live feed of cataloguing activity.

### 19. Tracking New Acquisitions in a Research Area

*Has the Rijksmuseum added any new 17th-century paintings to its collection in the past six months? If so, who are the artists and what are the subjects?* [Link](https://claude.ai/share/beb8831b-b798-44b1-8347-fae35317f466)

**How the tools enable it:**
- `get_recent_changes` with a date range covering the last six months
- Use `identifiersOnly: true` for a fast scan of recently changed object numbers
- `get_artwork_details` on results to filter for paintings from the 1600s and examine creator, date, and description

**Why it matters:** New acquisitions can fill gaps in the evidence or provide crucial comparisons for ongoing research. A date-scoped query surfaces recently added or modified records without requiring the researcher to monitor the museum's website.

---

## Semantic Search

`semantic_search` finds artworks by meaning, concept, or theme using natural language — ranking all ~832,000 artworks by embedding similarity to a free-text query. Unlike the structured filters above, semantic search works with concepts that cannot be expressed as vocabulary terms, Iconclass notations, or keyword matches. It is most effective when the Rijksmuseum's curatorial narrative texts discuss the relevant concept explicitly. For full technical details, see [Semantic Search](semantic-search.md).

### 20. Discovering Thematic Connections Beyond Formal Cataloguing

*Which artworks in the Rijksmuseum engage with the theme of cultural exchange between Europe and Asia — not just objects "from" Asia or "depicting" Asia, but works where the mixing of cultures is the subject?* [Link](https://claude.ai/share/8316d9dc-27ac-4c40-a42f-b2c355df8b35)

**How the tools enable it:**
- `semantic_search` with `query: "cultural exchange between East and West"` — returns artworks ranked by how closely their catalogued text relates to this concept
- Review the source text for each result to understand *why* it was retrieved — e.g. a painting of the Castle of Batavia may rank highly because its curatorial narrative describes the mixing of ethnic groups under VOC trade
- Follow up with `get_artwork_details` on the most relevant results for full metadata
- Compare with `search_artwork` using `depictedPlace: "Batavia"` or `productionPlace: "Japan"` to see what the structured filters find — the overlap reveals which works are discoverable both ways, and which are only reachable through semantic search

**Why it matters:** "Cultural exchange" is not a vocabulary term, an Iconclass notation, or a keyword in any structured field. It is an interpretive concept that exists in curatorial narratives and descriptive texts. Semantic search is the only path to these works — and the source text grounding explains the connection, rather than leaving the researcher to guess why a result appeared.

### 21. Atmospheric and Emotional Concepts in Art

*Can we find artworks in the Rijksmuseum that evoke a sense of solitude or isolation — a single figure in an empty landscape, a lone ship on a vast sea, an abandoned building?* [Link](https://claude.ai/share/32e517fd-849e-4289-b5b9-13f88b0e6a05)

**How the tools enable it:**
- `semantic_search` with `query: "loneliness and isolation in a vast empty space"`
- The model matches against embedded titles, descriptions, narratives, and inscriptions — a farmhouse described as standing alone in flat terrain, a ship on an empty horizon, a solitary figure in a landscape
- Filter with `type: "painting"` to focus on paintings if the initial results skew toward works on paper (a known bias — prints and drawings outnumber paintings ~77:1 in the collection)
- Use the source text to assess whether the "loneliness" is in the curatorial interpretation or inferred from sparse descriptions — this distinction matters for research rigour

**Why it matters:** Emotional and atmospheric qualities are not catalogued as metadata. No Iconclass code maps to "loneliness." The `description` and `curatorialNarrative` text filters require exact word matches and won't find synonyms or related concepts. Semantic search bridges this gap — imperfectly, since it depends on what curators have written, but it is often the only available path. The source text grounding makes this limitation transparent.

### 22. Cross-Language Conceptual Search

*Ich suche Blumenstillleben — Gemälde von Blumensträußen in einer Vase, besonders aus dem 17. Jahrhundert. Welche Werke hat das Rijksmuseum?* [Link](https://claude.ai/share/5e2da910-6f33-43b7-94a4-689da7aa16f1)

**How the tools enable it:**
- `semantic_search` with `query: "Blumenstrauß in einer Vase"` — the multilingual embedding model handles the German query against Dutch and English catalogue text
- Review results for canonical flower still lifes — Rachel Ruysch, Jan van Huysum, Ambrosius Bosschaert
- If expected canonical works are missing, reformulate in English: `"bouquet of flowers in a vase"` — English queries tend to have slightly higher precision against the bilingual catalogue
- Combine with `search_artwork` using `subject: "flowers"` and `type: "painting"` to verify completeness — the structured search catches works tagged with the Iconclass term but missed by the embedding model, and vice versa

**Why it matters:** The Rijksmuseum's catalogue is predominantly Dutch, with English translations for major works only. The multilingual embedding model allows researchers to query in their own language without knowing the Dutch vocabulary — though with a precision trade-off. The recommended workflow — semantic search first, then structured verification — combines the reach of embeddings with the precision of controlled vocabulary.

---

## Provenance Research

`search_provenance` exposes parsed ownership chains for ~48,000 artworks — structured events with parties, transfer types, dates, locations, prices, and provenance gaps. Two data layers are available: raw events (Layer 1) and interpreted ownership periods with durations (Layer 2). `collection_stats` provides aggregate provenance distributions (transfer type, decade, location, party) for quantitative analysis. 

### 23. Wartime Transfers and Provenance Gaps

*Find artworks that changed hands between 1933 and 1945 through confiscation or restitution, and show me their full ownership chains. Which ones have gaps in their provenance during this period?* [Link](https://claude.ai/share/b6c4a4c2-de36-4f14-bc20-7a12a2832092)

**How the tools enable it:**
- `search_provenance` with `transferType: "confiscation"`, `dateFrom: 1933`, `dateTo: 1945` to find wartime confiscations — repeat with `transferType: "restitution"` for post-war returns
- `search_provenance` with `transferType: "confiscation"`, `dateFrom: 1933`, `dateTo: 1945`, `excludeTransferType: "restitution"` to find confiscated works that were *never* restituted — the `excludeTransferType` applies artwork-level negation
- `search_provenance` with `hasGap: true`, `dateFrom: 1933`, `dateTo: 1945` to find works with undocumented periods during the war years — these are red flags for unresolved displacement
- Each result includes the full provenance chain, so the ownership story before and after the wartime event is immediately visible
- `collection_stats` with `dimension: "transferType"`, `dateFrom: 1933`, `dateTo: 1945` for a quantitative overview of how artworks changed hands during this period

**Why it matters:** Provenance research for the period 1933–1945 is a legal and ethical obligation for museums holding works that may have been looted or forcibly sold. The combination of `transferType` filtering, `excludeTransferType` negation, and `hasGap` detection makes it possible to systematically identify works requiring further investigation — confiscated but not restituted, or with undocumented gaps during the critical years. Without structured provenance data, this work requires manually reading each artwork's free-text ownership history.

### 24. Generational Ownership and Collection Dispersal

*Find artworks that passed through four or more generations by descent within a single family, then were sold at auction. How long did these family collections typically survive before dispersal?* [Link](https://claude.ai/share/fb01bd2b-c6fb-4a5b-af74-05fb32ddd731)

**How the tools enable it:**
- `search_provenance` with `layer: "periods"`, `acquisitionMethod: "by_descent"`, `minDuration: 80`, `sortBy: "duration"`, `sortOrder: "desc"` to find the longest-held family collections (80+ years approximates four generations)
- Examine the full chains — look for consecutive `by_descent` events involving the same family name, followed by a `sale` event marking the dispersal
- `search_provenance` with `transferType: "by_descent"`, `sortBy: "eventCount"`, `sortOrder: "desc"` to find works with the most provenance events of this type — a proxy for the deepest generational chains
- `collection_stats` with `dimension: "transferType"`, `hasProvenance: true` to see the overall prevalence of `by_descent` transfers (~13,700 events) relative to sales, gifts, and bequests
- For individual cases, `search_provenance` with `objectNumber` retrieves the complete chain to trace the family lineage and the circumstances of eventual sale

**Why it matters:** The history of art collecting is also a history of family wealth and its dispersal. Works that passed through multiple generations by inheritance before reaching the market represent long-lived private collections — their dispersal often marks historical inflection points (economic crises, wars, succession failures). The `by_descent` transfer type and duration-based sorting make these patterns systematically discoverable across the collection.

### 25. Art Dealers as Intermediaries

*Which art dealers appear as both buyers and sellers in the Rijksmuseum provenance records? For each, show me what they sold to the museum versus what they bought from private collectors, and the price ranges involved.* [Link](https://claude.ai/share/59acc3af-dce5-428e-981c-3fdb8673371d)

**How the tools enable it:**
- `collection_stats` with `dimension: "party"`, `hasProvenance: true` to identify the most frequently appearing parties across all provenance records
- `search_provenance` with `party: "Goudstikker"` (or any dealer name) to retrieve all artworks that passed through their hands — the full chain for each artwork shows the dealer's role in context
- Examine each chain for the dealer's position: `sender` (selling the work) versus `receiver` (acquiring it), as indicated by the `partyPosition` field on each party record
- `search_provenance` with `party: "Goudstikker"`, `hasPrice: true`, `sortBy: "price"`, `sortOrder: "desc"` to rank transactions by value and reveal the price ranges
- `search_provenance` with `party: "Goudstikker"`, `transferType: "sale"` to isolate sales specifically, distinguishing them from gifts, bequests, or other transfer types
- Repeat for other major dealers (e.g. `"Duveen"`, `"Knoedler"`, `"Hoogendijk"`) to build a comparative picture of dealer networks

**Why it matters:** Art dealers are pivotal intermediaries whose buying and selling patterns shaped museum collections. A dealer who both acquired works from private collectors and sold to the Rijksmuseum acted as a filter — their taste and commercial strategy determined which works entered the public collection. The `party` search with `partyPosition` and price data makes dealer networks empirically traceable, surfacing patterns that are otherwise scattered across individual provenance entries. 
