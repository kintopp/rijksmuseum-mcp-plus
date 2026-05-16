---
name: rijksmuseum-mcp-plus
description: >
  Research workflows for the Rijksmuseum MCP+ server, addressing Dutch arts,
  crafts, and history (~834,000 objects). Capabilities include keyword and
  semantic search, geospatial queries, deep-zoom inspection, collection
  statistics, AI-driven image analysis, Iconclass-driven iconographic
  discovery, AAM/CMOA-aligned provenance, demographic analysis of creators
  and depicted persons, and image similarity research. Trigger on any
  question that could plausibly be answered from the Rijksmuseum's
  holdings — Golden Age Dutch and Flemish painting, prints and drawings,
  Asian export art, decorative arts and craft objects, photography,
  historical artefacts, ownership history, museum acquisitions — even when
  the user doesn't name the collection.
metadata:
  version: "0.33"
  last_updated: "2026-05-16"
---

# Rijksmuseum MCP+ Research Skill


## Tool Selection Guide


| Question type                                                                 | Start here                                                                                                           |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| "Find works about X" — clear vocabulary concept                               | `search_artwork` with `subject`                                                                                      |
| "Find works about X" — interpretive / atmospheric                             | `semantic_search`                                                                                                    |
| "Find works depicting [iconographic scene]"                                   | Iconclass server `search` → `search_artwork` with `iconclass`                                                        |
| "How many works match X?"                                                     | `collection_stats` for counts/distributions. If you also need IDs (to feed into another tool), follow up with `search_artwork(compact: true)`. |
| "Distribution of X across the collection"                                     | `collection_stats` with `dimension`                                                                                  |
| "Top N creators / depicted persons / places"                                  | `collection_stats` with `dimension` + `topN`                                                                         |
| "Sales by decade" / time series                                               | `collection_stats` with `dimension: "provenanceDecade"`                                                              |
| "How many artworks have LLM-mediated interpretations?"                        | `collection_stats` with `dimension: "categoryMethod"`                                                                |
| "Of artworks with provenance, how many are paintings?"                        | `collection_stats` with `dimension: "type"` + `hasProvenance: true`                                                  |
| "Find persons by demographics / lifespan / profession / birth or death place" | `search_persons` → feed `vocabId` to `search_artwork(creator=…)`                                                     |
| "Curatorial theme tags on a work / theme distribution"                        | `search_artwork(theme=…)` / `collection_stats(dimension="theme")`                                                    |
| "Cataloguing-channel breakdown (designs, drawings, paintings, prints…)"       | `search_artwork(sourceType=…)` / `collection_stats(dimension="sourceType")`                                          |
| "What changed since YYYY-MM-DD?" — static date filter, combinable             | `search_artwork` with `modifiedAfter` / `modifiedBefore`                                                             |
| "Has anything changed since the last harvest checkpoint?" — OAI-PMH delta     | `get_recent_changes` (resumption-token pagination)                                                                   |
| "What does the Rijksmuseum say about this work?"                              | `get_artwork_details`                                                                                                |
| "Wikidata Q-id, handle.net URI, other external IDs"                           | `get_artwork_details` → `externalIds` (work-level) and `production[].creator.wikidataId`                             |
| "Show this artwork to the user / open the zoomable viewer"                    | `get_artwork_image`                                                                                                  |
| "Examine this image closely / read this inscription"                          | `inspect_artwork_image`                                                                                              |
| "Find works similar to this one" — visual, thematic, lineage, shared subject  | `find_similar`                                                                                                       |
| "Find pendants / production stadia / different examples of one design"        | `find_similar` — read the `Related Co-Production` column on the resulting HTML page                                  |
| "Find pairs / sets / recto-verso / reproductions / derivatives"               | `find_similar` — read the `Related Object` column on the resulting HTML page                                         |
| "Show me a curated group of works on X"                                       | `list_curated_sets` → `browse_set`                                                                                   |
| "Who owned this work / trace its ownership chain"                             | `search_provenance` with `objectNumber`                                                                              |
| "Which works passed through collector X?"                                     | `search_provenance` with `party`                                                                                     |
| "Find confiscations / sales / transfers in city Y"                            | `search_provenance` with `transferType`, `location`                                                                  |
| "How long did family X hold their collection?"                                | `search_provenance` with `layer: "periods"`, `ownerName`                                                             |


**Choosing between `search_artwork` (provenance-aware filters) and `search_provenance`:**
For keyword/text search over provenance, use `search_provenance` — `search_artwork` does not search provenance text. For cross-domain "what kinds of works have provenance" questions, use `hasProvenance: true` on `search_artwork` or `collection_stats` (e.g. `collection_stats(dimension="type", hasProvenance=true)`). `search_provenance` returns structured, parsed chains with dates, prices, transfer types, and ownership periods — use it when you need to reason about the *sequence* of ownership, filter by event type, or rank by price or duration. For the last link in the chain — how the Rijksmuseum acquired a work — also check `creditLine`, which covers ~360K artworks (vs ~49K with parsed provenance) and often names donors or funds absent from the provenance chain (e.g. "Drucker-Fraser", "Vereniging Rembrandt").

---

## Output Conventions

These rules govern how to present results regardless of which tool produced them.

- Always report `objectNumber` (e.g. `SK-C-5`) linked to the Rijksmuseum's page for that artwork when surfacing works — it is the stable identifier across all tools.
- For citation, use the persistent handle.net URI from `get_artwork_details` → `externalIds` (work-level external IDs surface here, including handle and other authority links).
- For person-level external IDs (Wikidata Q-id and others), consult `production[].creator.wikidataId` on `get_artwork_details`, or `wikidataId` on `search_persons` results.
- The `attributionEvidence` array on `get_artwork_details` cites the specific text/object that supports each attribution — useful for citation rigour.
- When presenting multiple works, lead with the most significant first (the default importance ranking handles this for vocabulary queries).
- For image inspection findings, distinguish explicitly between what the structured metadata says and what the AI reads directly from the image — the distinction matters for research rigour.

---

## Critical Parameter Distinctions

### `productionPlace` vs `depictedPlace`

These are semantically opposite and getting them wrong produces systematically
wrong results.

- `productionPlace`: where the object was **made** — "Amsterdam", "Delft"
- `depictedPlace`: what place the object **shows** — "Batavia", "Nagasaki"

A Dutch painting *of* Batavia was made in Amsterdam. Use both together to
distinguish objects *from* Asia versus European images *of* Asia.

### `subject` vs `iconclass`

- `subject`: morphological stemming against the subject vocabulary (Iconclass-aligned classifications and depicted-subject labels — a six-figure pool of bilingual terms; English coverage is strongest); best first pass; try natural phrases ("winter landscape", "vanitas", "civic guard")
- `iconclass`: the Iconclass classification system — ~40,675 notations across 13 languages. A retrieval tool, not a descriptive language: a notation's meaning comes from its position in the hierarchy, not just its label. Use the **Iconclass server** (`search`, `browse`, `resolve`, `expand_keys`, `search_prefix`) to discover notation codes by keyword, concept, or hierarchy navigation — see its SKILL file for full workflows and query patterns. Each result includes collection counts signalling how many artworks carry that notation. Pass the code to `search_artwork`'s `iconclass` parameter for precise filtering.

**Decision rule:** start with `subject` — it's faster and handles most queries well. Switch to `iconclass` when:

- you need to distinguish closely related scenes (Crucifixion vs Deposition, Annunciation vs Visitation) — these are sibling notations with distinct codes
- `subject` returns too broad a result set and you need hierarchical precision
- you want to explore a conceptual neighbourhood (browse children/siblings of a notation)
- the query is in a non-English language (Iconclass covers 13 languages; subject vocab is bilingual but English coverage is much stronger than Dutch)
- you want to search by meaning rather than keywords (semantic mode: "religious suffering", "festive gathering")
- you need to combine multiple iconographic concepts in a single query (AND-combined codes)

### `dateMatch` — controlling how date ranges are binned

Most artworks have date *ranges* (e.g. "1630–1640"), not exact years — see the `dateMatch` parameter description for the three modes (`overlaps`, `within`, `midpoint`). **Rule of thumb:** when issuing centuries/decades wildcards from `search_artwork` for counting purposes, use `midpoint`; use the default `overlaps` for discovery queries.

Scope: `dateMatch` applies only to `search_artwork` and `semantic_search`, and only fires when `creationDate` is supplied (year or wildcard). It is **not** a parameter on `collection_stats` — `collection_stats` accepts numeric `creationDateFrom`/`creationDateTo` (strict within-bounds), and its `decade`/`century` dimensions bin each artwork by `date_earliest` (one bin per artwork, no double-counting to escape).

### `attributionQualifier` + `creator` — structural limitation

The parameter description suggests combining `attributionQualifier` with `creator` to filter by source artist (e.g. "find all followers of Rembrandt"). In practice this does not work: across all qualifier types (`follower of`, `workshop of`, `circle of`, `attributed to`), the structured `creator` field is `Unknown [painter]` or `anonymous`, regardless of qualifier. The source artist's name appears only in the composite display string and is not exposed as a searchable entity field. For citation rigour at the single-work level, `get_artwork_details` exposes an `attributionEvidence` array.

**The correct strategy by qualifier type:**


| Goal                                      | Working approach                                                                  |
| ----------------------------------------- | --------------------------------------------------------------------------------- |
| Works in the manner/style of artist X     | `aboutActor: "X"` + `type: "painting"` (or other type)                            |
| All "follower of" works in the collection | `attributionQualifier: "follower of"` alone (returns 111 works)                   |
| Sub-filter those by source artist         | Not possible via parameters — requires fetching and inspecting individual records |


**Canonical name form matters.** The Rijksmuseum catalogue uses historical Dutch/Latin spellings for some artists. Bosch is catalogued as **"Jheronimus Bosch"**, not "Hieronymus Bosch". Always check `get_artwork_details` on a known work to confirm the canonical form before filtering.

### `creator` vs `aboutActor` vs `depictedPerson`

Three person-search axes, used for different questions: `creator` (who made it), `depictedPerson` (who is shown in it — strict, depicted only), `aboutActor` (broader cross-field — depicted *or* creator, tolerant of cross-language variants like "Louis XIV" → "Lodewijk XIV"). See each parameter's description for matching rules.

**Demographic gating is a two-step pattern.** To find works by women painters born after 1850: first `search_persons(gender="female", profession="painter", bornAfter=1850)` for vocab IDs, then `search_artwork(creator=[id1, id2, …], type="painting")`. Demographic filters (`gender`, `bornAfter`, `bornBefore`) need person enrichment present on the vocab DB — they return zero rows on a freshly harvested DB without enrichment.

### Title language coverage — the catalogue is mostly Dutch

The Rijksmuseum has translated only **~5% of artwork titles into English** (~39K of 834K works). The remaining ~95% have Dutch titles only — typically medals, coins, prints, decorative arts, and other minor objects. Famous paintings and curatorially-prominent works almost always have both languages; the long tail does not.

**Implications for research:**

- **Result presentation**: when reporting results to the user, use whatever title language exists rather than insisting on English. For an 18th-century medal, "Wilhelmina Koningin der Nederlanden" *is* the canonical title — there is no English version, and inventing one would misrepresent the catalogue.
- **Ranking**: title BM25 scores are computed across both languages, so an English title query against a Dutch-only object scores zero on title (but the object may still surface via `description`, `subject`, `iconclass`, or `semantic_search`, all of which have stronger English coverage).
- **`get_artwork_details` returns the full set of title variants** with language and qualifier (Dutch/English × brief/full/display/former). When reporting a work, prefer the variant whose language matches the user's query — the field exposes language per variant so this is straightforward.

### `search_provenance`: two query layers

`search_provenance` has two data layers that answer fundamentally different questions.

- `layer: "events"` (default): individual transactions — each with a date, location, price, parties (with roles and positions), and transfer type. Think of it as a ledger of *what happened*. Events-only parameters: `transferType`, `excludeTransferType`, `hasPrice`, `currency`, `hasGap`, `relatedTo`.
- `layer: "periods"`: interpreted ownership spans — who held the work, how they acquired it, and for how long. Think of it as a timeline of *who owned what*. Periods-only parameters: `ownerName`, `acquisitionMethod`, `periodLocation`, `minDuration`, `maxDuration`, `sortBy: "duration"`. Use `periodLocation` (period-level, ~45% populated) in preference to event-level `location` when scoping a periods-layer query — they AND-combine when both are supplied.

Shared parameters work on both layers: `party`, `location`, `creator`, `dateFrom`/`dateTo`, `objectNumber`, `categoryMethod`, `positionMethod`, `sortBy`, `offset`, `facets`.

**`dateFrom` / `dateTo` semantics differ by layer:**

- **Events**: filters on the event's `date_year` — "something happened between these years"
- **Periods**: `dateFrom` filters on `begin_year`, `dateTo` on `end_year` — "ownership that started after X AND ended before Y"

The periods interpretation is much more restrictive — `dateFrom=1933, dateTo=1945` on periods misses any ownership that started before 1933 or extended past 1945. **For date-range queries (especially wartime provenance), prefer the events layer.**

**Anti-join pattern** (`transferType` + `excludeTransferType`): artwork-level set difference. `transferType: "confiscation", excludeTransferType: "restitution"` returns artworks that were confiscated but *never* restituted. Note: items *recuperated* (recovered by Allied forces) are not the same as items *restituted* (formally returned to original owners) — they will appear in anti-join results.

**Filter requirement**: both layers reject bare queries. At least one content filter is required. If you need a collection-wide ranking, use a broad filter such as `dateFrom: 1400` as a catch-all.

For the full provenance data model — AAM text format, transfer type vocabulary, party roles and positions, date/currency representations, and tested query patterns — see `references/provenance-and-enrichment-patterns.md`.

### Full-text filters vs vocabulary filters (ranking matters)

Activating a text filter (`title`, `description`, `inscription`, `creditLine`, `curatorialNarrative`) switches ranking to BM25 relevance. Drop the text filter to fall back to importance ranking — useful when you want the most *significant* works to surface first.

---

## Modifier Parameters (cannot stand alone)

These narrow results but **require at least one other content filter**:


| Modifier                           | Notes                                                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `imageAvailable: true`             | Always pair with a content filter                                                                                                          |
| `hasProvenance: true`              | Restricts to ~49K artworks with parsed provenance. Pair with `type`, `creator`, etc. for cross-domain queries.                             |
| `modifiedAfter` / `modifiedBefore` | ISO 8601 date — record-level last-modified filter (~516K artworks have a `record_modified` timestamp). Combinable with any content filter. |
| `expandPlaceHierarchy: true`       | Expands place filters 3 levels deep; pair with `productionPlace` etc.                                                                      |


---

## Key Workflows

### 1. Scope Before You Browse

For any counting, distributional, or comparative question, **start with `collection_stats`** — it answers in one call what would otherwise require multiple `compact: true` loops.

```
# Example: Rembrandt's output across media — one call
collection_stats(dimension="type", creator="Rembrandt van Rijn")
# → painting 314 (38.2%), print 289 (35.2%), drawing 218 (26.5%)

# Cross-domain: what types of artworks have provenance events in Amsterdam?
collection_stats(dimension="type", hasProvenance=true, provenanceLocation="Amsterdam")

# Top 30 depicted persons
collection_stats(dimension="depictedPerson", topN=30)

# Cross-filter with Iconclass or curated sets
collection_stats(dimension="type", iconclass="73D82")
# → what types of artworks depict the Crucifixion?

collection_stats(dimension="creator", collectionSet="Japanese prints", topN=20)
# → top 20 creators in the Japanese prints set

# Physical size distributions (binned by binWidth, in cm)
collection_stats(dimension="height", type="painting", binWidth=20)
# → height distribution of paintings in 20cm bins
```

Use `compact: true` on `search_artwork` only when you need the actual object numbers (e.g. to feed into `get_artwork_details`), not just the count or distribution. For pure counting, `collection_stats` is always more efficient.

**Available `dimension` values:**


| Domain     | Dimensions                                                                                                                                                                                                              |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Artwork    | `type`, `material`, `technique`, `creator`, `depictedPerson`, `depictedPlace`, `productionPlace`, `sourceType`, `theme`, `exhibition`, `century`, `decade`, `decadeModified`, `height`, `width`                         |
| Provenance | `transferType`, `transferCategory`, `provenanceDecade`, `provenanceLocation`, `party`, `partyPosition`, `currency`, `categoryMethod`, `positionMethod`, `parseMethod`                                                   |


`decadeModified` is clamped to 1990–2030; records modified outside that window land in the coverage residual rather than a bucket. Pass `sortBy: "count"` to flip ordinal dimensions (`decade`, `height`, `width`, etc.) from natural-order to most-populous-first.

Filters from both domains combine freely; one call replaces N iterations. For gender breakdowns (no `creatorGender` dimension exists) run `search_persons` first, then pass vocab IDs to `collection_stats(creator=…)`.

### 2. Iconclass Research

Never pass iconographic concepts as free text to `search_artwork(iconclass=...)` —  
it expects exact notation codes. Use the **Rijksmuseum Iconclass MCP server** to discover codes first (see its SKILL file for full discovery workflows, FTS query patterns, hierarchy navigation, and cross-branch strategies).

**Quick reference — Iconclass server tools:**

- `search(query=...)` — keyword lookup ("crucifixion" → `73D6`)
- `search(semanticQuery=...)` — concept search ("domestic animals" → `34B1`)
- `browse(notation=...)` — hierarchy navigation (children, cross-refs, path)
- `resolve(notation=[...])` — batch lookup of known codes
- `expand_keys` / `search_prefix` — key variants and subtree enumeration

**Before handing off**, check `collectionCounts` — a code with 0 artworks returns nothing; a code with 2,000 vs 3 signals very different curatorial depth. **Never truncate Iconclass discovery queries** — use the default `maxResults` (25) or higher so you can evaluate all returned notations and their counts before deciding which codes to hand off.

**Searching with codes on this server:**

```
search_artwork(iconclass=["73D82"])
search_artwork(iconclass=["73D82", "25F33(DOVE)"])  # AND-combines across branches
```

Multiple codes AND-combine — this is how you express compound iconographic queries. If results are unexpected, use the Iconclass server's semantic search to discover alternative branches — the same concept can live in multiple places (a dog as pet under `34B11`, a dog as symbol of fidelity under `11A(DOG)`).

**`theme` is not Iconclass.** The `search_artwork(theme=…)` filter uses a separate **curatorial** vocabulary (e.g. "overzeese geschiedenis", "economische geschiedenis", "costume") that groups works around collection-level narratives. ~7% of artworks carry a theme (mostly Dutch labels). Don't pass Iconclass codes to `theme`, or theme labels to `iconclass`.

### 3. Century / Decade Wildcards

For longitudinal analysis, prefer `collection_stats` with decade or century binning. `collection_stats` bins each artwork into exactly one bin (by `date_earliest`), so there is no double-counting and no `dateMatch` parameter is needed:

```
collection_stats(dimension="decade", technique="etching", creationDateFrom=1500, creationDateTo=1800)
# → decade-by-decade etching counts in one call

collection_stats(dimension="decade", technique="etching", creationDateFrom=1500, creationDateTo=1800, binWidth=50)
# → half-century bins
```

Note: `creationDateFrom`/`creationDateTo` here are strict within-bounds — an artwork dated "c. 1490–1510" is excluded from a 1500-1800 window because its earliest year is below 1500.

For queries that need individual object numbers (not just counts), use `creationDate` wildcards with `search_artwork`. `dateMatch` matters here because `search_artwork` defaults to `overlaps` and a broadly-dated object can otherwise appear in multiple century buckets across separate calls:

```
search_artwork(technique="etching", creationDate="16*", dateMatch="midpoint")
search_artwork(technique="etching", creationDate="17*", dateMatch="midpoint")
# dateMatch="midpoint" ensures each artwork is counted in exactly one century
```

Supported patterns: `"1642"` (exact year), `"164*"` (decade), `"16*"` (century), `"1*"` (millennium).

### 4. Semantic Search + Structured Verification

Use `semantic_search` for concepts with no vocabulary term or Iconclass code —
atmosphere, emotion, cultural interpretation. Always follow up with a
structured `search_artwork` to test whether the same works are reachable
through controlled vocabulary.

```
semantic_search(query="loneliness and isolation in a vast empty space", type="painting")
# Review source text for each result — ask why it appeared
# Then: search_artwork(subject="landscape", curatorialNarrative="solitary")
# Compare overlap: works only reachable via semantic search are the interesting gap cases
```

**Pre-filtering:** `semantic_search` accepts a substantial subset of `search_artwork`'s filters as pre-filters — `type`, `material`, `technique`, `creator`, `creationDate`, `dateMatch`, `subject`, `iconclass`, `depictedPerson`, `depictedPlace`, `productionPlace`, `collectionSet`, `aboutActor`, `imageAvailable`. These narrow the candidate set *before* semantic ranking, combining structured precision with conceptual search:

```
semantic_search(query="vanitas symbolism", subject="skull", type="painting")
# → paintings with skull subjects, ranked by how well they match "vanitas symbolism"
```

**Filter specificity matters.** Very broad single filters (e.g. `type: "print"` alone — 421K works, or `material: "paper"` — 643K) exceed the internal candidate limit, so semantic ranking operates on a subset. Results are still high-quality (distances are near-optimal), but a different subset might surface equally-good alternatives. For best coverage, combine two or more filters or pair a broad filter with a specific one (e.g. `type: "print", subject: "landscape"`).

**Language note**: English queries yield slightly higher precision against the
bilingual catalogue even though the embedding model is multilingual. If a Dutch
or German query returns unexpected results, reformulate in English.

### 5. Image Inspection and Overlay Placement

**Two image tools, different purposes.** `get_artwork_image` opens the inline IIIF deep-zoom viewer for the **user** to see. `inspect_artwork_image` returns image bytes for the **model** to analyse directly. They compose: open with `get_artwork_image`, then `inspect_artwork_image` auto-navigates the open viewer to whatever region you inspect, so the user sees what you're looking at — no separate `navigate_viewer` call needed for basic zoom.

```
inspect_artwork_image(objectNumber="SK-C-5", region="pct:70,60,20,20")
# → base64 image for AI analysis + viewer auto-zooms to the same region
```

**Tight detail boxes: snap to the feature's actual edges.** Overlays around signatures, faces, inscriptions, or depicted objects should outline the feature, not loosely contain it — the overlay is a communicative claim to the user about where a feature sits, not a vague gesture toward its neighbourhood. Estimating "what percentage of this crop" is the weakest step in the accuracy chain — frame the overlay in the **same pixel grid you just analysed** instead. `inspect_artwork_image` returns `cropPixelWidth`, `cropPixelHeight`, and `cropRegion`; copy them into `navigate_viewer`'s `relativeToSize` alongside a `crop_pixels:` region and the server projects deterministically.

```
# Step 1: inspect the area
inspect_artwork_image(objectNumber="SK-C-5", region="pct:70,60,20,20")
# → cropPixelWidth=1200, cropPixelHeight=600, cropRegion="pct:70,60,20,20"

# Step 2: place a tight overlay in crop-local pixels
navigate_viewer(viewUUID=..., commands=[{
  action: "add_overlay",
  region: "crop_pixels:600,300,240,120",        # pixels within the inspected crop
  relativeTo: "pct:70,60,20,20",
  relativeToSize: {width: 1200, height: 600},   # cropPixelWidth/cropPixelHeight
  label: "Signature"
}])
```

**Magnify before measuring.** The "same pixel grid" only helps when the grid resolves the feature — a 30 px subject in a `region: "full"` inspection (≈1568 px wide) has no edges you can read precisely, and the resulting overlay will be loosely placed and oversized however careful the `crop_pixels:` arithmetic. Inspect first at a tight `pct:` region so the feature spans **hundreds of pixels** in the returned crop, then read its edges off that crop. For multiple spatially distinct features (e.g. a shell group on the left, a grasshopper on the right), prefer **one targeted inspect per region** over a single wide inspect — each crop's `cropPixelWidth`/`cropPixelHeight` then serves as its own `relativeToSize` for the overlays in that region.

**Coarser variant — crop-local percentages.** When the feature lacks identifiable edges (atmospheric region, gradient, undefined area), omit `relativeToSize` and pass `region: "pct:..."` with the same `relativeTo`. For any feature with discernible edges, prefer `crop_pixels:`.

`inspect_artwork_image` can surface content **absent from structured metadata** — unsigned Japanese prints often have readable artist signatures, publisher seals, and poem cartouches that the catalogue has not transcribed. Use `region="full"` for an initial composition overview before cropping to details.

**Verifying overlay placement with `show_overlays`.** Inspect a region that encloses your overlay(s), not `full` — at the 448 px clamp, small overlays on a full-image view shrink below visual threshold (the server rejects this combination with a `show_overlays_on_full_not_supported` warning).

### 6. Provenance and Acquisition Research

Provenance research moves through three levels of detail:

1. **Scope and profile** — `search_artwork` with `creditLine` for fast counts
   and facets. `creditLine` covers ~360K artworks (vs ~49K with parsed
   provenance) and captures the last link: how the museum acquired the work.
   Combine with `productionPlace` + `expandPlaceHierarchy` for geographic
   cross-tabulation. For keyword search over raw provenance text, use
   `search_provenance` (this is not a `search_artwork` parameter).
2. **Structured chain analysis** — `search_provenance` for parsed chains with
   dates, prices, transfer types, and ownership periods. Add `facets: true`
   for quick distributional context alongside chain results.
3. **Single-object deep dive** — `search_provenance(objectNumber=...)` for the
   full chain, then `get_artwork_details` for narrative text and curatorial
   context.

**Cross-domain queries**: `hasProvenance: true` on `search_artwork` or
`collection_stats` bridges the two systems — e.g.
`collection_stats(dimension="type", hasProvenance=true)`.

**Enrichment transparency:** `categoryMethod` and `positionMethod` are
queryable input filters on `search_provenance`, not just output fields. When
results contain LLM-enriched records, the response includes a review URL.
**Always show this URL to the user.**

**Pagination**: when `totalResults` exceeds 50, paginate with `offset`
(increments of 50 until offset ≥ totalResults).

For the complete data model (AAM text format, transfer type vocabulary, party
roles, date and currency representations), tested query patterns (collector
profiling, wartime provenance, price history, acquisition channels, decade-level
time series), and enrichment methodology, see `references/provenance-and-enrichment-patterns.md`.

### 7. Source–Copy and Related-Object Navigation

Three complementary paths connect a work to its peers, copies, sources, pendants, components, or derivatives:

1. **Curator-declared edges via `find_similar`** — the most direct path. `find_similar(objectNumber)` returns one HTML page that includes a **Related Co-Production** column (creator-invariant edges: pendants, production stadia, different examples of one design) and a **Related Object** column (derivative + grouping edges: pairs, sets, recto/verso, reproductions, general related-object links — tiered weights). Surface the link to the user; they read off the channel column relevant to their question.
2. **Direct cross-references on the work itself** — `get_artwork_details` returns a `relatedObjects[]` field, scoped to the three creator-invariant relationships (`different example`, `production stadia`, `pendant`). Each entry carries the peer's `objectNumber` (canonical handle) plus a Linked Art `objectUri`; pass either back to `get_artwork_details({objectNumber: …})` or `get_artwork_details({uri: …})` to navigate. For pairs, sets, recto/verso, reproductions, and general related-object links, read off `find_similar`'s Related Object column instead — these are not exposed on `relatedObjects[]`.
3. **Reproductive-print keyword path** — when curator-declared edges are absent, `productionRole` traces reproductive prints to their painted sources:

```
search_artwork(productionRole="after painting by", creator="Rembrandt van Rijn")
# → get_artwork_details on a result to read its description (often names the source)
# → search_artwork(creator="Rembrandt van Rijn", type="painting", title="...") to find the source
# → get_artwork_image on both for side-by-side comparison
```

### 8. Collection Depth Assessment

For grant applications or scoping a research site:

```
collection_stats(dimension="creator", type="print", productionPlace="Japan", topN=20)
# → top 20 print artists from Japan + total count, in one call

collection_stats(dimension="decade", type="print", productionPlace="Japan")
# → temporal distribution

list_curated_sets(query="Japan")                                       # curatorial groupings
browse_set(setSpec="...")                                               # range of artists/dates
search_artwork(productionPlace="Japan", type="print", maxResults=10)  # sample works for closer inspection
```

### 9. Gender and Demographic Analysis

Demographic gating is a **two-step pattern** via `search_persons`. There are no `creatorGender` / `creatorBornAfter` / `creatorBornBefore` modifiers on `search_artwork` and no `creatorGender` dimension on `collection_stats` — demographic predicates live exclusively on `search_persons`, which returns vocab IDs you then feed to `search_artwork(creator=…)`.

```
# Step 1 — find the persons matching the demographic profile
search_persons(gender="female", profession="painter", bornBefore=1800, bornAfter=1700)
# → returns vocabIds (e.g. "https://id.rijksmuseum.nl/200001234")

# Step 2 — fetch their works (creator accepts vocab IDs as well as name strings)
search_artwork(creator=[vocabId_1, vocabId_2, ...], type="painting", dateMatch="midpoint")

# To compare structurally over time, repeat Step 1 with bornBefore/bornAfter shifted by century
# and feed each cohort into Step 2.
```

**Coverage caveat:** `search_persons` demographic filters (gender, bornAfter, bornBefore) require person-enrichment to be present on the vocabulary DB. On a freshly harvested DB without enrichment they return zero rows. Structural filters (`birthPlace`, `deathPlace`, `profession`) and `name` work on any harvest.

Of ~291K persons in the catalogue, ~60K appear as creators on at least one artwork — the default `hasArtworks: true` limits results to that subset.

### 10. Similarity Research

**Your job with `find_similar` is to surface the result link to the user — not to fetch, summarise, or paraphrase the rendered page.** The tool returns an HTML comparison page; the user reads the channel column relevant to their question.

`find_similar(objectNumber)` renders an HTML comparison page at `${PUBLIC_URL}/similar/:uuid` (cached for 30 minutes) showing the source work alongside nearest neighbours across **9 independent similarity channels** plus a pooled column. The tool takes only `objectNumber` and `maxResults` — there is no `signal` parameter.

The 9 channel columns on the rendered HTML page (column legend, not query parameters):


| Channel column        | Matches on                                                                                                                            | Read it when the user is asking about…                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Visual                | Image embedding (composition, palette, format)                                                                                        | Look-alikes regardless of attribution — "other prints with this feel"                |
| Related Co-Production | Curator-declared creator-invariant edges (pendants, production stadia, different examples)                                            | Pairs/companions/variants of the same composition by the same hand                   |
| Related Object        | Curator-declared derivative + grouping edges (pairs, sets, recto/verso, reproductions, general related-object links — tiered weights) | Components, derivatives, reproductive copies, sets/series                            |
| Lineage               | Shared creator + assignment-qualifier overlap                                                                                         | Workshop, follower, pupil, copy neighbourhoods                                       |
| Iconclass             | Overlapping Iconclass notations                                                                                                       | Works with the same iconographic programme                                           |
| Description           | Dutch-description embedding similarity                                                                                                | Shared themes, technique, style vocabulary in cataloguer text                        |
| Theme                 | Curatorial-theme set overlap (IDF-weighted)                                                                                           | Works grouped under the same collection-level narrative                              |
| Depicted Person       | Same person(s) portrayed                                                                                                              | Sitters across multiple portraits; historical figures                                |
| Depicted Place        | Same place(s) shown                                                                                                                   | Views of the same city, building, or landscape                                       |
| Pooled                | Blend of all nine — works that score in **4+** channels                                                                               | Exploratory "what else is like this" when you don't yet know which dimension matters |


```
find_similar(objectNumber="RP-P-1958-335")  # one call → HTML page with all 9 channels + pooled
find_similar(objectNumber="RP-P-1958-335", maxResults=50)  # widen each column
```

The HTML page renders all channels in a single view; `maxResults` defaults to 20 (max 50) candidates per channel. The tool is feature-gated (`ENABLE_FIND_SIMILAR`); the Theme channel is independently gated by `ENABLE_THEME_SIMILAR`. If unavailable, fall back to `semantic_search` or a structured `search_artwork` built from the source artwork's filters (shared creator + type + subject).

---

## Known Limitations and Fallbacks


| Issue                                                                  | Workaround                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `navigate_viewer` `deliveryState` field                                | Three values: `delivered_recently` (iframe polled within 5s — commands flowed through), `queued_waiting_for_viewer` (iframe exists but is paused/offscreen — overlays preserved server-side and applied when polling resumes; **do NOT narrate this as a delivery failure** to the user), `no_live_viewer_seen` (no iframe has connected yet — likely a host-mount failure across multiple fresh `get_artwork_image` calls; surface this to the user rather than silently falling back to `inspect_artwork_image`). Pair with `recentlyPolledByViewer` (bool) for the "is the viewer live right now" check. |
| No `subject` results in English                                        | Try the Dutch term — vocabulary is bilingual ("fotograaf" not "photographer")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `semantic_search` skews toward prints/drawings                         | Filter with `type: "painting"` — prints and drawings outnumber paintings ~77:1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `semantic_search` with very broad filter                               | Single broad filters (`type: "print"`, `material: "paper"`) exceed the candidate limit — results are good but not exhaustive. Combine filters for better coverage.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Inscription field empty in catalogue                                   | Use `inspect_artwork_image` — AI vision can often read text directly from the image. Try `quality: "gray"` for better contrast on faded inscriptions or signatures.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `facets` on `search_artwork`                                           | Multiple dimensions including type, material, technique, century, theme, sourceType, rights, imageAvailable, creator, depictedPerson, depictedPlace, productionPlace. Configure with `facetLimit` (1–50, default 5). Pass `facets=true` for all or `facets=["creator","type"]` for specific ones. Dimensions already filtered on are excluded automatically. All entries include percentage.                                                                                                                                                                                                                                                                                                       |
| `facets` on `search_provenance`                                        | 5 dimensions: transferType, decade, location, transferCategory, partyPosition. Set `facets=true`. Percentages included.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Collection-wide distributions                                          | Use `collection_stats` instead of `compact=true` counting loops. See workflow §1 for the full list of artwork + provenance dimensions and the gender-breakdown pattern.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `search_provenance` data model details                                 | Batch prices, unsold lots, historical currencies, gap flags, parse methods, party coverage, 0-year durations, and `sortBy: "eventCount"` unreliability — see `references/provenance-and-enrichment-patterns.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Canonical artist name forms                                            | Some artists use historical spellings (e.g. "Jheronimus Bosch"). If a known artist returns no results, check the canonical form via `get_artwork_details` on a known work.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `search_persons` returns 0 rows for a demographic filter               | The `gender`, `bornAfter`, `bornBefore` filters require person enrichment to be present on the vocab DB. On a fresh harvest without enrichment they return zero rows — name-token matching and structural filters (`birthPlace`, `deathPlace`, `profession`) still work.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `relatedObjects` field on `get_artwork_details`                        | See workflow §7 — scoped to 3 creator-invariant relationships; pairs/sets/recto-verso/reproductions live on `find_similar`'s Related Object column.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Multi-folio works dominate results (sketchbooks, albums, print series) | The Rijksmuseum catalogues sketchbooks/albums/print-series as a parent record plus child records per folio, so a single physical object can fill the first page of results. Use `groupBy: "parent"` on `search_artwork` to collapse children whose parent is also in the result set (the parent gains a `groupedChildCount`). When `groupBy` isn't set, the response's `warnings` field flags clustering (e.g. "8 results are folios/components of BI-1898-1748A"). Affects ~4.6% of artworks (object numbers with parenthetical suffixes).                                                                                                                                                        |

