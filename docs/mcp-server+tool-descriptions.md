# MCP Server + Tool Descriptions

How the `rijksmuseum-mcp+` server describes itself to MCP clients.

## Server Description

> Rijksmuseum collection explorer — circa 834,000 artworks from antiquity to the present day spanning paintings, prints, drawings, photographs, furniture, ceramics, textiles, and more.
>
> Search uses a vocabulary database. All filters combine freely; array values are AND-combined. Vocabulary labels are bilingual (English/Dutch) — fall back to the Dutch term when an English query returns nothing (e.g. 'fotograaf' for 'photographer').
>
> Images are served via IIIF deep-zoom. Three viewer-family tools: get_artwork_image opens an interactive viewer for the user; inspect_artwork_image returns base64 bytes for the LLM's own visual analysis; navigate_viewer highlights regions in an already-open viewer.
>
> For demographic person queries (gender, birth/death year/place, profession), use search_persons → feed the returned vocabId into search_artwork({creator}). For artworks depicting a known person, use search_artwork({aboutActor}) — broader recall than depictedPerson because it searches both subject and creator vocabularies and tolerates cross-language name forms.
>
> Place searches support depictedPlace and productionPlace as vocabulary filters. For proximity, most place vocabulary entries lack coordinates — nearPlace only works for the subset that has been authority-geocoded, but nearLat/nearLon with explicit coordinates always works for searching artworks near any point. Multi-word place names like 'Oude Kerk Amsterdam' still resolve to a single vocabulary entry regardless of coordinate coverage.
>
> Iconclass covers 40,675 subject notations. Use the Iconclass server's search tool to find notation codes by concept, then pass them to search_artwork for precise iconographic filtering.
>
> Two free-text corpora are searchable through search_artwork: descriptions (Dutch, cataloguer-written, ~61% coverage) and curatorialNarrative (English wall text, ~14K works). When neither corpus carries the relevant language, prefer semantic_search.
>
> Three search modes: search_artwork for structured filters, semantic_search for free-text concepts that resist structured metadata, find_similar for artwork-to-artwork similarity from a known objectNumber. For aggregate counts and distributions, use collection_stats instead of looping search_artwork calls.
>
> Specialised tools: search_provenance for ownership-history questions across the ~48K artworks with parsed provenance; list_curated_sets + browse_set for exhibition/thematic groupings curated by Rijksmuseum staff; get_recent_changes for OAI-PMH delta tracking against a harvest checkpoint.

---

## Tool Descriptions

15 tools total: 12 standard tools + 3 app tools (`get_artwork_image` user-facing; `remount_viewer` and `poll_viewer_commands` internal viewer plumbing). Listed in registration order — this is the order the SDK surfaces them in `tools/list`.

### 1. `search_artwork`

Use when you have specific filter criteria (subject, material, technique, dates, place, person, theme, …) and want artworks matching ALL filters. Returns artwork summaries with titles, creators, and dates; every response includes totalResults (exact match count, not just the returned page). Not for free-text concept queries — use semantic_search for those. Not for artwork-to-artwork similarity — use find_similar with an objectNumber. For demographic person queries (gender, born/died, profession, birth/death place), use search_persons first to get a vocabId, then pass it as creator here. For provenance text and ownership history, use search_provenance. For aggregate counts and distributions, prefer collection_stats — one call vs compact=true loops.

Ranking: relevance (BM25) when text search (description, title, etc.) or geographic proximity is used; otherwise importance (image availability, curatorial attention, metadata richness). For concept-ranked results, use semantic_search.

At least one filter is required. There is no full-text search across all metadata. For concept or thematic searches (e.g. 'winter landscape', 'smell', 'crucifixion'), ALWAYS start with subject — it searches ~832K artworks tagged with structured Iconclass vocabulary and has by far the highest recall for conceptual queries. Use description for cataloguer observations (compositional details, specific motifs); use curatorialNarrative for curatorial interpretation and art-historical context. These three corpora can return complementary results. For broader concept discovery beyond structured vocabulary, use semantic_search — but combine it with search_artwork(type: 'painting', …) for painting queries since paintings are underrepresented there.

Array values are AND-combined (e.g. subject: ['landscape', 'seascape'] finds artworks with both). If many results share an object-number prefix (e.g. multiple folios of one sketchbook), a `warnings` note flags it; narrow with type/material filters or treat the shared prefix as the unit. Each result carries an objectNumber for follow-up calls to get_artwork_details (full metadata) or get_artwork_image (deep-zoom viewer — only when the user asks to see, show, or view an artwork; do not open the viewer for list/count/summary requests). All parameters combine freely. Vocabulary labels are bilingual (English and Dutch); try the Dutch term if English returns no results (e.g. 'fotograaf' instead of 'photographer'). For proximity search, use nearPlace with a place name, or nearLat/nearLon for arbitrary locations. Use creditLine for acquisition channel analysis (e.g. 'gift', 'bequest', 'Vereniging Rembrandt'). v0.27 added theme, sourceType, modifiedAfter, modifiedBefore filters; removed the per-tool provenance text filter and 6 demographic creator filters (use search_persons → creator: <vocabId> instead).

### 2. `search_persons`

Use when the user has a demographic or structural query about persons (artists, depicted figures, donors): gender, birth/death year, birth/death place, profession. Returns vocab IDs to feed into search_artwork({creator: <vocabId>}) for works by them, or search_artwork({aboutActor: <name>}) for works depicting them. Two-step pattern: search_persons → search_artwork. Examples: 'female impressionist painters born after 1850' or 'Dutch painters who died in Italy'.

Not for free-text concept queries — use semantic_search. Not for filter-based artwork search by a known creator name — use search_artwork({creator: <name>}) directly.

By default restricts to persons with ≥1 artwork in the collection (~60K of ~290K). Coverage note (v0.27): demographic filters (gender, bornAfter, bornBefore) require person-enrichment to be present on the vocabulary DB; on a freshly harvested DB without person enrichment they return zero rows. Name search and structural filters (birthPlace / deathPlace / profession) work on any harvest.

### 3. `get_artwork_details`

Use when you need full metadata for a SINGLE artwork (e.g. after a search_artwork / semantic_search / find_similar result, or when the user names a specific objectNumber). Provide exactly one of objectNumber (e.g. 'SK-C-5' for The Night Watch) or uri (a Linked Art URI from relatedObjects).

Returns metadata including titles (primary plus the full set of variants with language and qualifier — Dutch/English brief/full/display/former), creator, date, dateDisplay (free-text form), description, curatorial narrative, dimensions (text + structured: height/width/depth/weight/diameter where present), extentText, materials, object type, production details (with creator life dates, gender, and Wikidata ID where available), provenance, credit line, inscriptions, license, related objects (each carrying objectNumber + iiifId for in-viewer navigation), themes, exhibitions, attributionEvidence, externalIds (handle + other), location (museum room when on display, as { roomId, floor, roomName }), recordCreated/recordModified timestamps, plus collection sets and reference metadata. The relatedObjects field carries each peer's objectNumber (canonical handle) plus a Linked Art objectUri; pass either form back here, objectNumber preferred.

Not for filter-based discovery — use search_artwork. Not for similarity discovery — use find_similar. Not for aggregate counts — use collection_stats.

### 4. `get_artwork_image` *(app tool — user-facing)*

Use ONLY when the user explicitly wants to see, show, or view an artwork — opens an interactive deep-zoom viewer (zoom, pan, rotate, flip, j/k/l navigation between related artworks). Do NOT call for list, summary, count, or text-only requests. Not for visual analysis by the LLM — use inspect_artwork_image to get image bytes. Not all artworks have images available. Returns metadata and a viewer link, not the image bytes themselves; do not construct or fetch IIIF image URLs manually (downloadable images are on rijksmuseum.nl).

### 5. `remount_viewer` *(app tool — internal)*

Internal: switch the viewer to a different artwork while preserving the viewUUID. Called by the artwork-viewer iframe during in-viewer related navigation. Overlays are cleared on remount because their coordinates belong to the previous artwork.

### 6. `inspect_artwork_image`

Use when YOU (the LLM) need to look at an artwork image or region for visual analysis — identifying details, reading inscriptions, comparing compositions, planning overlays. Returns image bytes (base64) in the tool response — the LLM can see and reason about the image immediately. Not for the user to view — use get_artwork_image for the interactive viewer. Not for listing or summarising artworks — use search_artwork.

Use with region 'full' (default) to inspect the complete artwork, or specify a region to zoom into details, read inscriptions, or examine specific areas.

Region coordinates: 'pct:x,y,w,h' (percentage of full image, recommended), 'crop_pixels:x,y,w,h' (pixel coordinates of the full image — use with nativeWidth/nativeHeight from a prior response), or 'x,y,w,h' (legacy IIIF pixels, equivalent to crop_pixels). Quick reference:
- Top-left quarter: pct:0,0,50,50
- Bottom-right quarter: pct:50,50,50,50
- Center strip: pct:25,25,50,50
- Full image: full (default)
- For multi-panel works: use physical dimensions from get_artwork_details to estimate panel percentages, then inspect individual panels with close-up crops.

Best practice for overlay placement: ALWAYS inspect before overlaying. Start with region 'full' to understand the layout, then use close-up crops (600–800px) to pinpoint specific features before calling navigate_viewer with add_overlay. Use navigate_viewer's 'relativeTo' parameter to place overlays using crop-local coordinates — the server handles the projection to full-image space, avoiding manual coordinate math.

Auto-navigation: when a viewer is open for this artwork, the viewer automatically zooms to the inspected region (navigateViewer defaults to true, no effect when region is 'full'). This keeps the viewer in sync with your analysis — no separate navigate_viewer call needed for basic zoom. Use navigate_viewer separately only when you need overlays, labels, or clear_overlays.

The response includes the active viewUUID (if any) for follow-up navigate_viewer calls.

### 7. `navigate_viewer`

Use after inspect_artwork_image when you want to draw the user's attention to a specific region of the open viewer (zoom there, add a labelled overlay, or clear overlays). Requires a viewUUID from a prior get_artwork_image call (the viewer must be open). Not for opening the viewer — use get_artwork_image. Not for visual analysis — use inspect_artwork_image. Commands execute in order: typically clear_overlays → navigate → add_overlay.

All region coordinates are in full-image space (percentages or pixels of the original image), not relative to the current viewport. The same pct:x,y,w,h used in inspect_artwork_image will target the identical area in the viewer.

For accurate overlay placement: inspect the target area with inspect_artwork_image first, verify the region contains what you expect, then use the same or refined coordinates here. Do not estimate overlay positions from memory — always inspect first.

Region formats:
- 'pct:x,y,w,h' — percentage of full image.
- 'crop_pixels:x,y,w,h' — pixel coordinates of the full image. Use the nativeWidth/nativeHeight returned by inspect_artwork_image to bound values.
- 'x,y,w,h' — equivalent to crop_pixels: (legacy IIIF form, kept for compatibility).
- 'full' | 'square' — whole image shortcuts.

Out-of-bounds regions are rejected with an `overlay_region_out_of_bounds` warning — correct the coordinates and retry.

Overlays persist in the viewer until clear_overlays is issued — each call appends to the existing set. Keep batches under 10 commands per call. The viewer session (viewUUID) remains active for 30 minutes of idle inactivity — any polling or navigation resets the clock.

Coordinate shortcut: when placing overlays based on a prior inspect_artwork_image crop, use 'relativeTo' with the crop's region string. Specify 'region' as coordinates within the crop's local space (pct: format) and the server projects to full-image space deterministically — eliminates manual coordinate conversion math.

Response field deliveryState reports whether the iframe drained the commands immediately (`delivered_recently`), the iframe exists but hasn't polled recently and the commands are queued (`queued_waiting_for_viewer` — typical when scrolled out of view), or no iframe has connected yet (`no_live_viewer_seen`). In the queued case, overlay state is preserved server-side and will apply automatically when the viewer resumes polling — do not narrate this as a delivery failure to the user.

### 8. `poll_viewer_commands` *(app tool — internal)*

Internal: poll for pending viewer navigation commands.

### 9. `list_curated_sets`

Use when you want to discover curated collection sets (193 total) ranging from substantive sub-collections (drawings, paintings, photographs) through iconographic groupings to umbrella sets (Alle gepubliceerde objecten = 834K members). Each result carries memberCount, top dominantTypes, top dominantCenturies by membership, and a category heuristic (object_type / iconographic / album / sub_collection / umbrella) so you can pick the right scope. Use minMembers: 100, maxMembers: 200000 to avoid umbrella sets when the user wants a substantive subset. Pair with browse_set(setSpec) to enumerate members. Not for keyword search across artworks — use search_artwork. Not for aggregate counts — use collection_stats.

### 10. `browse_set`

Use when you have a setSpec (from list_curated_sets) and want to enumerate its member artworks. DB-backed since v0.27 (~600× faster than the prior OAI-PMH path; warm calls in tens of ms). Returns DB-direct records with objectNumber, title, creator, date (display + earliest/latest), description, dimensions, datestamp, image/IIIF URLs, and a stable lodUri. For multi-row vocab (subjects, materials, type taxonomy, full set memberships), follow up with get_artwork_details on the returned objectNumber. Supports pagination via resumptionToken (stateless base64; not portable across pre-v0.27 deploys). Not for set discovery — use list_curated_sets first.

### 11. `get_recent_changes`

Use when you need OAI-PMH delta semantics specifically — tracking what changed since a known harvest checkpoint, with resumption-token pagination. Returns records changed within a date range. Use identifiersOnly=true for a lightweight listing (headers only, no full metadata). Each record includes an objectNumber for follow-up calls to get_artwork_details or get_artwork_image. For static date-modified filtering across the collection, prefer search_artwork({modifiedAfter: <ISO date>}) — same data, no resumption tokens, combinable with other filters.

### 12. `search_provenance`

Use when the user has a provenance question — ownership history, collectors, sales, inheritances, gifts, confiscations, restitutions, or a search across the parsed provenance corpus (~48K artworks with structured records). Returns full provenance chains grouped by artwork, with matching events flagged.

Not for catalogue keyword search — use search_artwork. Not for aggregate provenance counts — use collection_stats with provenance dimensions/filters. v0.27 added periodLocation (period-level location filter, preferred over location at layer='periods' for clarity).

Each chain tells the complete ownership story: collectors, sales, inheritances, gifts, confiscations, and restitutions, with dates, locations, prices, and citations.

Use objectNumber for a single artwork's chain (fast local lookup, no network). Use party to trace a collector or dealer across artworks (e.g. 'Six', 'Rothschild'). Use relatedTo for reverse cross-references — find all works sharing provenance with a given object (pendants, album sheets, dollhouse contents). Combine transferType, dateFrom/dateTo, location for pattern discovery (e.g. confiscations 1940–1945, sales in Paris).

IMPORTANT flags on events:
- unsold: true means this sale event was unsold/bought-in/withdrawn at auction — no ownership transfer occurred. Filter these when analysing actual sales.
- batchPrice: true means the price is an en bloc/batch total for multiple artworks, not an individual price. Filter these when ranking or comparing prices — they massively distort rankings.

Every record carries provenance-of-provenance metadata: parseMethod shows how the event was parsed (peg, regex_fallback, cross_ref, credit_line, llm_structural), categoryMethod/positionMethod show how classifications and party positions were determined (type_mapping, role_mapping, llm_enrichment, llm_disambiguation, rule:transfer_is_ownership), correctionMethod (llm_structural:#NNN) shows LLM structural corrections (location fixes, event reclassification, event splitting), and enrichmentReasoning provides the LLM's reasoning for any non-deterministic decision. Parties have position (sender/receiver/agent) indicating their role in the transfer.

IMPORTANT: When results contain LLM-enriched records, the response text ends with a REVIEW_URL or REVIEW_FILE line. You MUST copy this URL or file path verbatim into your response as a clickable link or openable path. Do NOT omit it, paraphrase it, summarise it, or refer to it indirectly (e.g. 'see the link above'). The user cannot see tool output — if you do not include the path, they have no way to find the review page.

Use hasGap to find artworks with gaps in their provenance chain — red flags for wartime displacement or undocumented transfers. Only the parsed provenance fields exposed below are searchable; raw-text full-text search across provenance was removed in v0.27. For the last link in the chain — how the Rijksmuseum acquired it (donor, fund, bequest) — also check search_artwork's creditLine parameter. CreditLine covers ~358K artworks (vs ~48K with provenance) and often names donors or funds absent from the provenance chain (e.g. 'Drucker-Fraser', 'Vereniging Rembrandt'). At least one filter is required.

### 13. `collection_stats`

Use when the user wants aggregate counts, percentages, or distributions across the collection (one call instead of search_artwork(compact=true) loops). Returns formatted text tables — no structured output schema. Not for individual artwork lookup — use get_artwork_details. Not for similarity — use find_similar.

Examples:
- "What types of artworks have provenance?" → dimension='type', hasProvenance=true
- "Transfer type distribution for Rembrandt" → dimension='transferType', creator='Rembrandt'
- "Top 20 depicted persons" → dimension='depictedPerson', topN=20
- "Sales by decade 1600–1900" → dimension='provenanceDecade', transferType='sale', dateFrom=1600, dateTo=1900
- "How many artworks have LLM-mediated interpretations?" → dimension='categoryMethod'

Artwork dimensions: type, material, technique, creator, depictedPerson, depictedPlace, productionPlace, century, decade, height, width, theme (thematic vocab — labels in NL until #300 backfill), sourceType (cataloguing-channel taxonomy — 6 values), exhibition (top exhibitions by member count), decadeModified (record_modified bucketed by decade, clamped to 1990–2030).
Provenance dimensions: transferType, transferCategory, provenanceDecade, provenanceLocation, party, partyPosition, currency, categoryMethod, positionMethod, parseMethod.

Filters from both domains combine freely. Artwork filters narrow the artwork set; provenance filters further restrict to artworks matching those provenance criteria. For demographic-filtered counts (e.g. female artists by century), first run search_persons to get vocab IDs, then pass them as creator here.

### 14. `find_similar`

Use when the user has a SPECIFIC artwork (objectNumber) and wants others like it. Generates an HTML comparison page with IIIF thumbnails across 9 independent similarity channels: Visual (image-embedding nearest neighbours), Related Co-Production (creator-invariant curator-declared edges: pendants, production stadia, different examples), Related Object (other curator-declared edges: pairs, sets, recto/verso, reproductions, general related-object links — tiered weights), Lineage (creator + assignment-qualifier overlap), Iconclass (subject-notation overlap), Description (Dutch-description embedding similarity), Theme (curatorial-theme set overlap, IDF-weighted), Depicted Person, and Depicted Place — plus a Pooled column blending all nine.

Not for free-text concept queries — use semantic_search. Not for filter-based search — use search_artwork.

IMPORTANT: The result is a file path or URL to an HTML page. Your ONLY job is to show the user the path/URL so they can open it in a browser. Do NOT attempt to open, read, fetch, summarise, or characterise the page contents. Do NOT make additional tool calls to look up the same artworks. Simply present the link and explain that it contains a visual comparison page.

### 15. `semantic_search`

Use when the user has a free-text concept ('solitude', 'industrial revolution', 'maritime trade', 'vanitas symbolism') and no specific filter criteria. Returns artworks ranked by Dutch-description embedding similarity to the query, with source text for grounding — use that text to explain why results are relevant or to flag false positives.

Not for queries expressible as structured metadata (specific artists, dates, places, materials) — use search_artwork for those. Not for artwork-to-artwork similarity — use find_similar with an objectNumber.

Best for concepts that resist structured metadata: atmospheric qualities ('sense of loneliness'), compositional descriptions ('artist gazing directly at the viewer'), art-historical concepts ('cultural exchange under VOC trade'), or cross-language queries. Results are most reliable when the Rijksmuseum's curatorial narrative texts discuss the relevant concept explicitly; purely emotional or stylistic concepts (e.g. chiaroscuro, desolation) may yield lower precision because catalogue descriptions often do not use that language.

Filter notes: supports pre-filtering by subject, depictedPerson, depictedPlace, productionPlace, collectionSet, aboutActor, iconclass, and imageAvailable in addition to type, material, technique, creator, and creationDate. Use type: 'painting' to restrict to the paintings collection. Do NOT use technique: 'painting' — it matches painted decoration on any object type (ceramics, textiles, frames) and will return unexpected results.

Painting queries — two-step pattern: paintings are underrepresented (prints and drawings outnumber them ~77:1). For queries where paintings are the expected result type, ALWAYS combine semantic_search with a follow-up search_artwork(type: 'painting', subject: …) or search_artwork(type: 'painting', creator: …) — do not wait to observe skew, as the absence of key works is not visible in the returned results.

Multilingual: queries in Dutch, German, French and other languages are supported but may benefit from a wider result window or English reformulation if canonical works are missing.
