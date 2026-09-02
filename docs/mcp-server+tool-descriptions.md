# MCP Server + Tool Descriptions

How the `rijksmuseum-mcp+` server describes itself to MCP clients.

## Server Description

> Rijksmuseum collection explorer — circa 834,000 artworks from antiquity to the present day spanning paintings, prints, drawings, photographs, furniture, ceramics, textiles, and more.
>
> Search uses a vocabulary database. Filters combine freely except proximity search (see Place filters); array values are AND-combined. Vocabulary labels are bilingual (English/Dutch) — fall back to the Dutch term when an English query returns nothing (e.g. 'fotograaf' for 'photographer').
>
> Images are served via IIIF deep-zoom: get_artwork_image opens the user's interactive viewer; inspect_artwork_image returns bytes for the LLM's own visual analysis.
>
> For demographic person queries (gender, birth/death year/place, profession), use search_persons → feed the returned vocabId into search_artwork({creator}). For artworks depicting a known person, use search_artwork({aboutActor}) — broader recall than depictedPerson because it searches both subject and creator vocabularies and tolerates cross-language name forms.
>
> Place filters: depictedPlace and productionPlace — a proximity search replaces them. Most place entries lack coordinates, so nearPlace works only for the authority-geocoded subset; nearLat/nearLon always works.
>
> Use the Iconclass server to find notation codes by concept, then pass them to search_artwork for precise iconographic filtering.
>
> Two free-text corpora are searchable through search_artwork: descriptions (Dutch, cataloguer-written, ~61% coverage) and curatorialNarrative (English wall text, ~14K works). When neither corpus carries the relevant language, prefer semantic_search.
>
> Three search modes: search_artwork for structured filters, semantic_search for free-text concepts that resist structured metadata, find_similar for artwork-to-artwork similarity from a known objectNumber. For aggregate counts and distributions, use collection_stats instead of looping search_artwork calls.
>
> Specialised tools cover provenance, bibliography, conservation, curated sets, and OAI-PMH deltas — see their descriptions for routing.

---

## Tool Descriptions

19 tools total: 16 standard tools + 3 app tools (`get_artwork_image` user-facing; `remount_viewer` and `poll_viewer_commands` internal viewer plumbing). Listed in registration order — this is the order the SDK surfaces them in `tools/list`.

### 1. `search_artwork`

Structured filter search — artworks matching ALL given filters. Filters cover subject, material, technique, date, place, person. Returns artwork summaries with titles, creators, and dates; every response includes totalResults (exact match count, not just the returned page). Not for free-text concept queries — use semantic_search for those. Not for artwork-to-artwork similarity — use find_similar with an objectNumber. For demographic person queries (gender, born/died, profession, birth/death place), use search_persons first to get a vocabId, then pass it as creator here. For provenance text and ownership history, use search_provenance. For aggregate counts and distributions, prefer collection_stats — one call vs compact=true loops.

Ranking: relevance (BM25) when text search (description, title, etc.) or geographic proximity is used; otherwise importance (image availability, curatorial attention, metadata richness). For concept-ranked results, use semantic_search.

At least one filter is required. There is no full-text search across all metadata. For concept or thematic searches (e.g. 'winter landscape', 'smell', 'crucifixion'), subject has the highest recall — it searches the large majority of the collection via structured Iconclass vocabulary. Use description for cataloguer observations (compositional details, specific motifs); use curatorialNarrative for curatorial interpretation and art-historical context. These three corpora can return complementary results. For broader concept discovery beyond structured vocabulary, use semantic_search — but combine it with search_artwork(type: 'painting', …) for painting queries since paintings are underrepresented there.

Array values are AND-combined (e.g. subject: ['landscape', 'seascape'] finds artworks with both). If many results share an object-number prefix (e.g. multiple folios of one sketchbook), a `warnings` note flags it; narrow with type/material filters or treat the shared prefix as the unit. Each result carries an objectNumber for follow-up calls to get_artwork_details (full metadata) or get_artwork_image (deep-zoom viewer for the user). Parameters combine freely, with one exception: proximity search overrides depictedPlace/productionPlace (see nearPlace). Vocabulary labels are bilingual (English and Dutch); try the Dutch term if English returns no results (e.g. 'fotograaf' instead of 'photographer'). For proximity search, use nearPlace with a place name, or nearLat/nearLon for arbitrary locations. For acquisition channel / donor analysis (gifts, bequests, fund names like 'Vereniging Rembrandt'), use search_provenance.

### 2. `search_persons`

Find persons by gender, birth/death year or place, or profession. Returns vocab IDs. Returns vocab IDs to feed into search_artwork({creator: <vocabId>}) for works by them, or search_artwork({aboutActor: <name>}) for works depicting them. Two-step pattern: search_persons → search_artwork. Examples: 'female impressionist painters born after 1850' or 'Dutch painters who died in Italy'.

Not for free-text concept queries — use semantic_search. Not for filter-based artwork search by a known creator name — use search_artwork({creator: <name>}) directly.

By default restricts to persons with ≥1 artwork in the collection (~60K of ~290K). Coverage note: demographic filters (gender, bornAfter, bornBefore) require person-enrichment on the vocabulary DB — they return zero rows on a freshly harvested DB without it, and undercount where enrichment is sparse. The structural filters (birthPlace / deathPlace / profession) work on any harvest but resolve by pivoting through creator-mapped artworks, so on multi-creator works the artwork-level attribute leaks to co-creators — expect false positives (incl. 'anonymous'/'unknown' placeholders ranked high by output volume). Treat all of these filtered lists as approximate, not authoritative cohorts. Name search is exact and unaffected.

### 3. `get_artwork_details`

Full metadata for ONE artwork by objectNumber. Covers creator, dates, materials, provenance, inscriptions, related objects. Typically follows a search_artwork / semantic_search / find_similar result, or a user-named objectNumber. Provide exactly one of objectNumber (e.g. 'SK-C-5' for The Night Watch) or uri (a Linked Art URI from relatedObjects).

Returns metadata including titles (primary plus the full set of variants with language and qualifier — Dutch/English brief/full/display/former), creator, date, dateDisplay (free-text form), description, curatorial narrative, dimensions (text + structured: height/width/depth/weight/diameter where present), extentText, materials, object type, production details (with creator life dates, gender, and Wikidata ID where available), provenance, credit line, inscriptions, license, related objects (each carrying objectNumber + iiifId for in-viewer navigation), themes, exhibitions, attributionMarks (signature/inscription counts), externalIds (handle + other), location (museum room when on display, as { roomId, floor, roomName }), recordCreated/recordModified timestamps, plus collection sets and reference metadata. Authority IDs appear at two levels: work-level under externalIds (handle + other), and entity-level under equivalents[] arrays on objectTypes, materials, production entries, subjects.depictedPersons / subjects.depictedPlaces, collectionSetLabels and themes — each entry a { authority, id, uri } triple (VIAF/ULAN/RKD/Getty TGN+AAT/GeoNames/Wikidata), and one entity can carry several, so read every entry (iconclass terms have none). The relatedObjects field carries each peer's objectNumber (canonical handle) plus a Linked Art objectUri; pass either form back here, objectNumber preferred.

Not for filter-based discovery — use search_artwork. Not for similarity discovery — use find_similar. Not for aggregate counts — use collection_stats.

### 4. `get_artwork_bibliography`

Scholarly references (citations) for ONE artwork by objectNumber. Includes linked publication, pages, ISBN where known. Entries with a linked publication carry a [pub NNN] handle — pass it to find_artworks_citing_publication. Follows a search_artwork / get_artwork_details result. By default returns the first 5 plus a total count; set full=true for all entries (major works can have 100+ — mind the context window). Not for general metadata — use get_artwork_details. Not for library-catalogue search.

### 5. `find_artworks_citing_publication`

Reverse bibliography: artworks citing a given publication URI or id. Use the publicationUri from get_artwork_bibliography (e.g. 'https://id.rijksmuseum.nl/301154354') or the bare id. Local and resolver-free. Not for topic search of the library catalogue.

### 6. `get_conservation_history`

Technical examinations and restoration history for ONE artwork. Follows get_artwork_details / a search result, by objectNumber. Returns technical examinations (X-ray, dendrochronology, paint samples, infrared), conservation/restoration treatment events, a count of recorded signature/inscription marks (use search_inscriptions for the actual transcriptions), and a short provenance excerpt. Not for general metadata — use get_artwork_details. Not for transcribed inscriptions — use search_inscriptions. Not for aggregate counts — use collection_stats.

### 7. `get_artwork_image` *(app tool — user-facing)*

Opens an interactive deep-zoom viewer for the user. Use only when they ask to see, show, or view an artwork — not for list, summary, count, or text-only requests. Not for visual analysis by the LLM — use inspect_artwork_image to get image bytes. Not all artworks have images available. Returns metadata and a viewer link, not the image bytes themselves; do not construct or fetch IIIF image URLs manually (downloadable images are on rijksmuseum.nl).

### 8. `remount_viewer` *(app tool — internal)*

Internal: switch the viewer to a different artwork while preserving the viewUUID. Called by the artwork-viewer iframe during in-viewer related navigation. Any user highlight is cleared on remount because its coordinates belong to the previous artwork.

### 9. `inspect_artwork_image`

Returns image bytes (base64) for the LLM's own visual analysis. Covers a whole artwork or a region. The LLM can see and reason about the image immediately — not for the user to view (use get_artwork_image for the interactive viewer). Not for listing or summarising artworks — use search_artwork.

Use with region 'full' (default) to inspect the complete artwork, or specify a region to zoom into details, read inscriptions, or examine specific areas. The response includes cropPixelWidth/cropPixelHeight: the actual pixel dimensions of the returned image.

Region coordinates: 'pct:x,y,w,h' (percentage of full image, recommended), 'crop_pixels:x,y,w,h' (pixel coordinates of the full image — use with nativeWidth/nativeHeight from a prior response), or 'x,y,w,h' (legacy IIIF pixels, equivalent to crop_pixels). A tight region returns more real detail than a larger size — the server never upscales past the region's own pixels. For multi-panel works, estimate panel percentages from the physical dimensions in get_artwork_details.

When a viewer is open for this artwork, it automatically zooms to the inspected region (navigateViewer defaults to true, no effect when region is 'full'), so no separate navigate_viewer call is needed for basic zoom.

The response includes the active viewUUID (if any) for follow-up navigate_viewer calls.

### 10. `navigate_viewer`

Zooms/pans an already-open viewer to a region. Steer the user's view to a detail. Requires a viewUUID from a prior get_artwork_image call (the viewer must be open). Not for opening the viewer — use get_artwork_image. Not for visual analysis — use inspect_artwork_image.

In most cases you do NOT need this tool: inspect_artwork_image already auto-zooms the open viewer to whatever region it inspects. Call navigate_viewer only to move the user's view WITHOUT fetching image bytes for your own analysis.

By default, region coordinates are in full-image space (percentages or pixels of the original image), not relative to the current viewport. The same pct:x,y,w,h used in inspect_artwork_image will target the identical area in the viewer. Exception: when a command includes relativeTo, region is interpreted in that inspected crop's local coordinate space.

Region formats:
- 'pct:x,y,w,h' — percentage of full image.
- 'crop_pixels:x,y,w,h' — pixel coordinates of the full image. Use nativeWidth/nativeHeight returned by inspect_artwork_image to bound values. When used with relativeTo + relativeToSize, crop_pixels is instead interpreted as pixels within that inspected crop.
- 'x,y,w,h' — equivalent to crop_pixels: (legacy IIIF form, kept for compatibility).
- 'full' | 'square' — whole image shortcuts.

Out-of-bounds regions are rejected with an `overlay_region_out_of_bounds` warning — correct the coordinates and retry. Keep batches under 10 commands per call. The viewer session (viewUUID) remains active for 30 minutes of idle inactivity — any polling or navigation resets the clock.

Coordinate shortcut: to zoom to a region of a prior inspect_artwork_image crop, use 'relativeTo' with the crop's region string and specify 'region' as coordinates within the crop's local space; the server projects to full-image space deterministically. Use pct:x,y,w,h for crop-local percentages, or crop_pixels:x,y,w,h plus relativeToSize:{width: cropPixelWidth, height: cropPixelHeight} from inspect_artwork_image for crop-local rendered pixels.

Response field deliveryState reports whether the iframe drained the commands immediately (`delivered_recently`), the iframe exists but hasn't polled recently and the commands are queued (`queued_waiting_for_viewer` — typical when scrolled out of view), or no iframe has connected yet (`no_live_viewer_seen`). In the queued case, the command is preserved server-side and will apply automatically when the viewer resumes polling — do not narrate this as a delivery failure to the user.

### 11. `poll_viewer_commands` *(app tool — internal)*

Internal: poll for pending viewer navigation commands

### 12. `list_curated_sets`

Browse thematic sets curated by Rijksmuseum staff. Includes sub-collection groupings (drawings, paintings, iconographic sets). Each result carries memberCount, top dominantTypes, top dominantCenturies by membership, and a category heuristic (object_type / iconographic / album / sub_collection / umbrella) so you can pick the right scope. Use minMembers: 100, maxMembers: 200000 to avoid umbrella sets when the user wants a substantive subset. Pair with browse_set(setSpec) to enumerate members. Not for keyword search across artworks — use search_artwork. Not for aggregate counts — use collection_stats.

### 13. `browse_set`

Enumerate the member artworks of one curated set by setSpec. Get setSpec values from list_curated_sets. DB-backed (warm calls in tens of ms). Returns DB-direct records with objectNumber, title, creator, date (display + earliest/latest), description, dimensions, datestamp, image/IIIF URLs, and a stable lodUri. For multi-row vocab (subjects, materials, type taxonomy, full set memberships), follow up with get_artwork_details on the returned objectNumber. Supports pagination via resumptionToken (stateless base64; not portable across server upgrades). Not for set discovery — use list_curated_sets first.

### 14. `get_recent_changes`

OAI-PMH delta feed of records changed within a date range. Paginated; anchored to a known harvest checkpoint. Use identifiersOnly=true for a lightweight listing (headers only, no full metadata). Full-mode records include an objectNumber for follow-up calls to get_artwork_details or get_artwork_image; identifiersOnly records carry only a LOD URI, so re-run without it to act on a change. Deleted records are flagged with deleted:true (marked [DELETED] in the listing) and carry only a LOD URI + datestamp, no metadata.

### 15. `search_provenance`

Ownership-history search across parsed provenance chains. Covers collectors, sales, gifts, confiscations, restitutions. Returns full provenance chains grouped by artwork, with matching events flagged.

Not for catalogue keyword search — use search_artwork. Not for aggregate provenance counts — use collection_stats with provenance dimensions/filters. periodLocation is a period-level location filter, preferred over location at layer='periods' for clarity.

Each chain tells the complete ownership story: collectors, sales, inheritances, gifts, confiscations, and restitutions, with dates, locations, prices, and citations.

Use objectNumber for a single artwork's chain (fast local lookup, no network). Use party to trace a collector or dealer across artworks (e.g. 'Six', 'Rothschild'). Use relatedTo for reverse cross-references — find all works sharing provenance with a given object (pendants, album sheets, dollhouse contents). Combine transferType, dateFrom/dateTo, location for pattern discovery (e.g. confiscations 1940–1945, sales in Paris).

Event flags:
- unsold: true means this sale event was unsold/bought-in/withdrawn at auction — no ownership transfer occurred. Filter these when analysing actual sales.
- batchPrice: true means the price is an en bloc/batch total for multiple artworks, not an individual price. Filter these when ranking or comparing prices — they massively distort rankings.

Every record carries provenance-of-provenance metadata: parseMethod shows how the event was parsed (peg, regex_fallback, cross_ref, credit_line, llm_structural), categoryMethod/positionMethod show how classifications and party positions were determined (type_mapping, role_mapping, llm_enrichment, llm_disambiguation, rule:transfer_is_ownership), correctionMethod (llm_structural:#NNN) shows LLM structural corrections (location fixes, event reclassification, event splitting), and enrichmentReasoning provides the LLM's reasoning for any non-deterministic decision. Parties have position (sender/receiver/agent) indicating their role in the transfer.

When results contain LLM-enriched records, the response ends with a REVIEW_URL or REVIEW_FILE line pointing at a human-review page for those decisions. Include that URL or path verbatim as a link in your reply — the user cannot see tool output, so it is their only route to the page.

Use hasGap to find artworks with gaps in their provenance chain — red flags for wartime displacement or undocumented transfers. Only the parsed provenance fields exposed below are searchable. At least one filter is required.

creditLineQuery — unstructured fallback: only ~48K artworks have parsed provenance, but many more carry a credit-line field (acquisition/funding statements). It is a standalone mode for artworks lacking parsed provenance — a free-text search over credit lines that ignores all other filters and returns matches in creditLineResults (not results). Credit lines record the museum's own acquisition, not prior ownership, so present those results as coming from unstructured credit-line text, not parsed provenance.

### 16. `search_inscriptions`

Structured search over artwork inscriptions and collector's marks. Also signatures, dates, numbers, transcribed text.

What this field is: catalogue-entered inscription/mark data — not OCR and not an exhaustive transcription of visible text. It is dominated by verso collector's-mark stamps (the Rijksprentenkabinet's own mark and former-owner stamps account for a large share of all records); genuine artist-/image-applied text (signatures, captions, addresses) is a real but minority component. Coverage is uneven by object type: high for prints and drawings, low for coins, medals, and posters that are covered in legend text never entered here. An empty transcribedText does not mean the object bears no text.

Use transcribedText to find what is actually written ON the work (matched against the quoted strings only). Use collectorMark to find works bearing a given Lugt number (e.g. 'Lugt 240' or '240'). Combine inscriptionType / placement / technique for facet queries (e.g. a handwritten signature on the recto). Use excludeCollectorMarkOnly or hasTranscribedText:true to strip ownership-stamp boilerplate. Use text for a blunt full-text match over the whole inscription blob.

Each result carries matchedInscriptions — the segments that matched, with the NL/EN gloss merged — so you can see exactly why it matched. Facets combine within a single segment (a signature AND recto AND handwritten must be the same mark).

Runtime parse with no derived index: a query must include at least one narrowing filter, and a broad single facet (e.g. inscriptionType:"collector's mark", roughly half the corpus) will trip the candidate cap and return PARTIAL results (candidatesCapped:true) — add a narrowing term. For free-text keyword search across the whole catalogue use search_artwork; search_artwork({inscription}) is a raw FTS over the same field, whereas this tool adds the structured facets and gloss-deduped matches.

### 17. `collection_stats`

Group-by breakdown over one structured dimension — counts and histograms. Dimensions: type, decade, place, creator; includes percentages. Covers totals, summaries, and group-by / count-by / distribution-of / statistics-over queries across the Rijksmuseum collection. Returns formatted text tables + structured output mirroring the same data (denominator/grouping/coverage semantics disclosed in the schema). Not for individual artwork lookup — use get_artwork_details. Not for similarity — use find_similar.

Artwork dimensions: type, material, technique, creator, productionRole (making/reproductive role), profession, depictedPerson, depictedPlace, productionPlace, birthPlace (creator birth place), deathPlace (creator death place), century, decade, height, width, gender (creator gender: female/male/unknown — groups artworks by creator gender via creator-mapping join), creatorBirthDecade / creatorBirthCentury (cohort dims bucketed by creator birth year), placeType (production place type — country/city/region/etc.), theme (thematic vocab — labels in NL until backfill), sourceType (cataloguing-channel taxonomy — 6 values), exhibition (top exhibitions by member count), decadeModified (record_modified bucketed by decade, clamped to 1990–2030).
Provenance dimensions: transferType, transferCategory, provenanceDecade, provenanceLocation, party, partyPosition, partyRole (verb-derived role: collector/buyer/recipient/heir/donor vs the normalised owner/non-owner partyPosition), currency, categoryMethod, positionMethod, parseMethod.

Filters from both domains combine freely. Artwork filters narrow the artwork set; provenance filters further restrict to artworks matching those provenance criteria. Provenance event-level filters (transferType + provenanceLocation + provenanceDateFrom/To + categoryMethod + parseMethod + unsold/uncertain/gap/crossRef) compose on the same event row; party-level filters (party + positionMethod + partyRole) compose on the same party row. For demographic-filtered counts (e.g. female artists by century), use gender='female' directly or run search_persons to get vocab IDs, then pass them as creator.

### 18. `find_similar`

Finds artworks like a given one across 9 similarity channels. Takes one objectNumber; adds a pooled consensus. Generates an HTML comparison page with IIIF thumbnails across all 9 channels: Visual (image-embedding nearest neighbours), Related Variant (creator-invariant curator-declared edges: pendants, production stadia, different examples), Related Object (other curator-declared edges: pairs, sets, recto/verso, reproductions, general related-object links — tiered weights), Lineage (creator + assignment-qualifier overlap), Iconclass (subject-notation overlap), Description (Dutch-description embedding similarity), Theme (curatorial-theme set overlap, IDF-weighted), Depicted Person, and Depicted Place — plus a Pooled column blending all nine.

Not for free-text concept queries — use semantic_search. Not for filter-based search — use search_artwork. Not for aggregate counts or distributions — use collection_stats.

The result is a URL or file path to an HTML comparison page built for the user to open in a browser — present it as a link. The page itself is not fetchable by the model; the response text carries a trimmed per-channel summary (and structuredContent the full per-channel data) so questions about the comparison can be answered from the response rather than by re-querying each artwork.

### 19. `semantic_search`

Free-text concept search by embedding similarity. For ideas like 'solitude' or 'vanitas' that resist metadata. Ranks by multilingual embedding similarity over a composite of each artwork's title, inscriptions, description and curatorial narrative, and returns that source text for grounding — use it to explain why results are relevant or to flag false positives.

Not for queries expressible as structured metadata (specific artists, dates, places, materials) — use search_artwork for those. Not for artwork-to-artwork similarity — use find_similar with an objectNumber. Not for aggregate counts or distributions — use collection_stats.

Best for concepts that resist structured metadata: atmospheric qualities ('sense of loneliness'), compositional descriptions ('artist gazing directly at the viewer'), art-historical concepts ('cultural exchange under VOC trade'), or cross-language queries. Results are most reliable when the Rijksmuseum's curatorial narrative texts discuss the relevant concept explicitly; purely emotional or stylistic concepts (e.g. chiaroscuro, desolation) may yield lower precision because catalogue descriptions often do not use that language.

Filter notes: supports pre-filtering by subject, depictedPerson, depictedPlace, productionPlace, collectionSet, aboutActor, iconclass, and imageAvailable in addition to type, material, technique, creator, and creationDate. Use type: 'painting' to restrict to the paintings collection. Do NOT use technique: 'painting' — it matches painted decoration on any object type (ceramics, textiles, frames) and will return unexpected results. A single very broad filter (e.g. type: 'print' or material: 'paper' alone) can exceed the internal candidate limit, so ranking then operates on a near-optimal subset rather than the full match set and may miss equally-relevant works — pair it with a narrower filter (e.g. type: 'print', subject: 'landscape') for exact ranking.

Painting queries: paintings are underrepresented (prints and drawings outnumber them ~77:1), and missing key works are not visible in the returned list. When paintings are the expected result type, pre-filter with type: 'painting' here or pair this with search_artwork(type: 'painting', subject: …) / search_artwork(type: 'painting', creator: …).

Multilingual: queries in Dutch, German, French and other languages are supported but may benefit from a wider result window or English reformulation if canonical works are missing.
