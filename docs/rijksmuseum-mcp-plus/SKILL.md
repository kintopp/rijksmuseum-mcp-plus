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
  version: "0.3.0"
  last_updated: "2026-05-03"
---

# Rijksmuseum MCP+ Research Skill

> **v0.3.0 audit status (2026-05-03):** safe / mechanical updates applied (frontmatter, removed-modifier rows, find_similar 6→9 channels, `relatedObjects` rewrite, demographic-workflow rewrite, `collection_stats` dimension list, coverage counts re-derived from current vocab DB). Items still flagged for live spot-tests against `node dist/index.js`:
> - **`attributionQualifier` + `creator`** — re-validate with v0.27 attribution-evidence harvesting; see TODO inline.
> - **`hasGap` + date filters** — verify the artwork-level vs event-level interaction described in `references/provenance-and-enrichment-patterns.md`.
> - **`parseMethod` shares** — re-confirmed today (peg 80.1% / cross_ref 19.6%); no change needed but worth re-checking after the next harvest.
> - **`transferType=["by_descent","widowhood"]` + `layer="periods"`** — verify end-to-end parse.

## Core Mental Model

The server is not a 'one and done' search engine — it is a resource for actively exploring and researching the collection of the Rijksmuseum. Many meaningful questions will require several chained tool calls. The canonical sequence is:
```
DISCOVER → QUANTIFY → RETRIEVE → INSPECT
```
Avoid jumping directly to RETRIEVE without a DISCOVER or QUANTIFY step unless the query is simple and straightforward (e.g. the object number is already known). For QUANTIFY, use `collection_stats` for distributions and cross-domain breakdowns, `compact: true` (returns only object numbers and minimal fields) for simple counts or when you just need IDs to feed into a follow-up call.

---

## Tool Selection Guide

| Question type | Start here |
|---|---|
| "Find works about X" — clear vocabulary concept | `search_artwork` with `subject` |
| "Find works about X" — interpretive / atmospheric | `semantic_search` |
| "Find works depicting [iconographic scene]" | Iconclass server `search` → `search_artwork` with `iconclass` |
| "How many works match X?" | `collection_stats` for counts/distributions; `search_artwork` with `compact: true` only when you need object numbers |
| "Distribution of X across the collection" | `collection_stats` with `dimension` |
| "Top N creators / depicted persons / places" | `collection_stats` with `dimension` + `topN` |
| "Sales by decade" / time series | `collection_stats` with `dimension: "provenanceDecade"` |
| "How many artworks have LLM-mediated interpretations?" | `collection_stats` with `dimension: "categoryMethod"` |
| "Of artworks with provenance, how many are paintings?" | `collection_stats` with `dimension: "type"` + `hasProvenance: true` |
| "Find persons by demographics / lifespan / profession / birth or death place" | `search_persons` → feed `vocabId` to `search_artwork(creator=…)` |
| "Curatorial theme tags on a work / theme distribution" | `search_artwork(theme=…)` / `collection_stats(dimension="theme")` |
| "Cataloguing-channel breakdown (designs, drawings, paintings, prints…)" | `search_artwork(sourceType=…)` / `collection_stats(dimension="sourceType")` |
| "What changed since YYYY-MM-DD?" — static date filter, combinable | `search_artwork` with `modifiedAfter` / `modifiedBefore` |
| "Has anything changed since the last harvest checkpoint?" — OAI-PMH delta | `get_recent_changes` (resumption-token pagination) |
| "What does the Rijksmuseum say about this work?" | `get_artwork_details` |
| "Wikidata Q-id, handle.net URI, other external IDs" | `get_artwork_details` → `externalIds` (work-level) and `production[].creator.wikidataId` |
| "Show this artwork to the user / open the zoomable viewer" | `get_artwork_image` |
| "Examine this image closely / read this inscription" | `inspect_artwork_image` |
| "Find works similar to this one" — visual, thematic, lineage, shared subject | `find_similar` |
| "Find pendants / production stadia / different examples of one design" | `find_similar` — read the `Related Co-Production` column on the resulting HTML page |
| "Find pairs / sets / recto-verso / reproductions / derivatives" | `find_similar` — read the `Related Object` column on the resulting HTML page |
| "Show me a curated group of works on X" | `list_curated_sets` → `browse_set` |
| "Who owned this work / trace its ownership chain" | `search_provenance` with `objectNumber` |
| "Which works passed through collector X?" | `search_provenance` with `party` |
| "Find confiscations / sales / transfers in city Y" | `search_provenance` with `transferType`, `location` |
| "How long did family X hold their collection?" | `search_provenance` with `layer: "periods"`, `ownerName` |

**Choosing between `search_artwork` (provenance-aware filters) and `search_provenance`:**
`search_artwork` no longer accepts a `provenance` text filter (removed in v0.27 — use `search_provenance` for keyword/text search over provenance). For cross-domain "what kinds of works have provenance" questions, use `hasProvenance: true` on `search_artwork` or `collection_stats` (e.g. `collection_stats(dimension="type", hasProvenance=true)`). `search_provenance` returns structured, parsed chains with dates, prices, transfer types, and ownership periods — use it when you need to reason about the *sequence* of ownership, filter by event type, or rank by price or duration. For the last link in the chain — how the Rijksmuseum acquired a work — also check `creditLine`, which covers ~360K artworks (vs ~49K with parsed provenance) and often names donors or funds absent from the provenance chain (e.g. "Drucker-Fraser", "Vereniging Rembrandt").

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

Most artworks have date *ranges* (e.g. "1630–1640"), not exact years. `dateMatch` controls how these ranges interact with `creationDate` wildcards and `collection_stats` decade/century dimensions:

| Mode | Behaviour | Use when |
|---|---|---|
| `"overlaps"` (default) | Artwork appears in every bin its range touches | Inclusive discovery — "show me everything that *could* be from the 1630s" |
| `"within"` | Artwork appears only if its entire range falls within the bin | Exclusive bins, but drops ~43% of the collection (broadly-dated objects) |
| `"midpoint"` | Each artwork counted in exactly one bin (midpoint of its date range) | **Statistical comparisons, charts, decade-by-decade counts** — no double-counting, no data loss |

**Rule of thumb:** use `midpoint` whenever you're comparing counts across bins (decade trends, century breakdowns, gender ratios by period). Use the default `overlaps` for discovery queries where inclusiveness matters more than precision.

Available on `search_artwork`, `semantic_search`, and implicitly via `collection_stats` `creationDateFrom`/`creationDateTo` filters.

### `attributionQualifier` + `creator` — structural limitation

> ⚠ **TODO (v0.3.0 audit)** — re-validate against v0.27 on a known case (e.g. "follower of Rembrandt"). With `attribution_evidence` now harvested and `assignment_pairs` reused by `find_similar(lineage)`, the structural picture may have shifted. Confirm whether `attributionQualifier` + `creator` now resolves to the source artist, or amend.

The parameter description suggests combining `attributionQualifier` with `creator` to filter by source artist (e.g. "find all followers of Rembrandt"). **As of v0.24 this combination never worked — the tool schema documentation was incorrect.** Verified across all qualifier types (`follower of`, `workshop of`, `circle of`, `attributed to`): the structured `creator` field was always `Unknown [painter]` or `anonymous`, regardless of qualifier. The source artist's name appeared only in the composite display string and was not exposed as a searchable entity field.

**The correct strategy by qualifier type:**

| Goal | Working approach |
|---|---|
| Works in the manner/style of artist X | `aboutActor: "X"` + `type: "painting"` (or other type) |
| All "follower of" works in the collection | `attributionQualifier: "follower of"` alone (returns ~111 works) |
| Sub-filter those by source artist | Not possible via parameters — requires fetching and inspecting individual records |

**Additional complication — "manner of" is not a valid qualifier value.** The Rijksmuseum uses "manner of" as a distinct attribution category, but `"manner of"` is not in the `attributionQualifier` controlled vocabulary and returns zero results. Works attributed in this way are retrievable only via `aboutActor`.

**Canonical name form matters.** The Rijksmuseum catalogue uses historical Dutch/Latin spellings for some artists. Bosch is catalogued as **"Jheronimus Bosch"**, not "Hieronymus Bosch". Always check `get_artwork_details` on a known work to confirm the canonical form before filtering.

### `creator` vs `aboutActor` vs `depictedPerson`

- `creator`: who made it — accepts canonical name forms ("Rembrandt van Rijn") **or a vocab ID** returned by `search_persons`
- `depictedPerson`: who is *shown* in it — matches ~709K name variants across ~291K persons, including historical forms
- `aboutActor`: broader cross-field search; more tolerant of name variants and cross-language forms ("Louis XIV" finds "Lodewijk XIV")

**Demographic gating is a two-step pattern in v0.27.** The old `creatorGender`, `creatorBornAfter`, `creatorBornBefore`, `creatorBirthPlace`, and `creatorDeathPlace` modifiers on `search_artwork` were **removed**. To find works by women painters born after 1850, first call `search_persons(gender="female", profession="painter", bornAfter=1850)` to get vocab IDs, then pass those IDs to `search_artwork(creator=[id1, id2, …], type="painting")`. Note: `search_persons` demographic filters (gender, born*) return zero rows on a freshly harvested DB without person enrichment.

### Title language coverage — the catalogue is mostly Dutch

The Rijksmuseum has translated only **~4% of artwork titles into English** (~35K of 834K works). The remaining ~96% have Dutch titles only — typically medals, coins, prints, decorative arts, and other minor objects. Famous paintings and curatorially-prominent works almost always have both languages; the long tail does not.

**Implications for research:**

- **Result presentation**: when reporting results to the user, use whatever title language exists rather than insisting on English. For an 18th-century medal, "Wilhelmina Koningin der Nederlanden" *is* the canonical title — there is no English version, and inventing one would misrepresent the catalogue.
- **Ranking**: title BM25 scores are computed across both languages, so an English title query against a Dutch-only object scores zero on title (but the object may still surface via `description`, `subject`, `iconclass`, or `semantic_search`, all of which have stronger English coverage).
- **`get_artwork_details` now returns the full set of title variants** with language and qualifier (Dutch/English × brief/full/display/former). When reporting a work, prefer the variant whose language matches the user's query — the field exposes language per variant so this is straightforward.

### `search_provenance`: two query layers

`search_provenance` has two data layers that answer fundamentally different questions.

- `layer: "events"` (default): individual transactions — each with a date, location, price, parties (with roles and positions), and transfer type. Think of it as a ledger of *what happened*. Events-only parameters: `transferType`, `excludeTransferType`, `hasPrice`, `currency`, `hasGap`, `relatedTo`.
- `layer: "periods"`: interpreted ownership spans — who held the work, how they acquired it, and for how long. Think of it as a timeline of *who owned what*. Periods-only parameters: `ownerName`, `acquisitionMethod`, `minDuration`, `maxDuration`, `sortBy: "duration"`.

Shared parameters work on both layers: `party`, `location`, `creator`, `dateFrom`/`dateTo`, `objectNumber`, `categoryMethod`, `positionMethod`, `sortBy`, `offset`, `facets`.

**`dateFrom`/`dateTo` semantics differ by layer:**
- **Events**: filters on the event's `date_year` — "something happened between these years"
- **Periods**: `dateFrom` filters on `begin_year`, `dateTo` on `end_year` — "ownership that started after X AND ended before Y"

The periods interpretation is much more restrictive — `dateFrom=1933, dateTo=1945` on periods misses any ownership that started before 1933 or extended past 1945. **For date-range queries (especially wartime provenance), prefer the events layer.**

**Anti-join pattern** (`transferType` + `excludeTransferType`): artwork-level set difference. `transferType: "confiscation", excludeTransferType: "restitution"` returns artworks that were confiscated but *never* restituted. Note: items *recuperated* (recovered by Allied forces) are not the same as items *restituted* (formally returned to original owners) — they will appear in anti-join results.

**Filter requirement**: both layers reject bare queries. At least one content filter is required. If you need a collection-wide ranking, use a broad filter such as `dateFrom: 1400` as a catch-all.

For the full provenance data model — AAM text format, transfer type vocabulary, party roles and positions, date/currency representations, and tested query patterns — see `references/provenance-and-enrichment-patterns.md`.

### Full-text filters vs vocabulary filters (ranking matters)

Results rank by **BM25 text relevance** when any of these are active:
`title`, `description`, `inscription`, `provenance`, `creditLine`,
`curatorialNarrative`.

Results rank by **importance** (image availability + curatorial attention +
metadata richness) when only vocabulary or column filters are active.

**Practical rule**: if you want the most *significant* works to surface first,
use vocabulary filters alone. If you want *keyword relevance*, activate a text
filter.

---

## Modifier Parameters (cannot stand alone)

These narrow results but **require at least one other content filter**:

| Modifier | Notes |
|---|---|
| `imageAvailable: true` | Always pair with a content filter |
| `hasProvenance: true` | Restricts to ~49K artworks with parsed provenance. Pair with `type`, `creator`, etc. for cross-domain queries. |
| `modifiedAfter` / `modifiedBefore` | ISO 8601 date — record-level last-modified filter (~516K artworks have a `record_modified` timestamp). Combinable with any content filter. |
| `expandPlaceHierarchy: true` | Expands place filters 3 levels deep; pair with `productionPlace` etc. |

(The v0.24 `creatorGender`, `creatorBornAfter`, `creatorBornBefore`, `creatorBirthPlace`, `creatorDeathPlace` modifiers were removed in v0.27 — use `search_persons` then feed vocab IDs to `creator`.)

---

## Key Workflows

### 1. Scope Before You Browse

For any counting, distributional, or comparative question, **start with `collection_stats`** — it answers in one call what would otherwise require multiple `compact: true` loops.

```
# Example: Rembrandt's output across media — one call
collection_stats(dimension="type", creator="Rembrandt van Rijn")
# → painting 314 (38.2%), print 289 (35.2%), drawing 218 (26.5%)

# Cross-domain: what types of artworks have provenance events in Amsterdam?
collection_stats(dimension="type", hasProvenance=true, location="Amsterdam")

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

### 2. Iconclass Research

Never pass iconographic concepts as free text to `search_artwork(iconclass=...)` —
it expects exact notation codes. Use the **Iconclass server** to discover codes first (see its SKILL file for full discovery workflows, FTS query patterns, hierarchy navigation, and cross-branch strategies).

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

For longitudinal analysis, prefer `collection_stats` with decade or century binning. **Use `dateMatch: "midpoint"` for statistical comparisons** — the default `overlaps` mode double-counts broadly-dated objects across bins (see Critical Parameter Distinctions above):

```
collection_stats(dimension="decade", technique="etching", creationDateFrom=1500, creationDateTo=1800)
# → decade-by-decade etching counts in one call (default overlaps — inclusive but inflated)

collection_stats(dimension="decade", technique="etching", creationDateFrom=1500, creationDateTo=1800, binWidth=50)
# → half-century bins
```

For queries that need individual object numbers (not just counts), use `creationDate` wildcards with `search_artwork`:

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

**Pre-filtering:** `semantic_search` accepts all vocabulary filters from `search_artwork` as pre-filters — `subject`, `iconclass`, `depictedPerson`, `depictedPlace`, `productionPlace`, `collectionSet`, `aboutActor`, `imageAvailable`, `dateMatch`. These narrow the candidate set *before* semantic ranking, combining structured precision with conceptual search:

```
semantic_search(query="vanitas symbolism", subject="skull", type="painting")
# → paintings with skull subjects, ranked by how well they match "vanitas symbolism"
```

**Filter specificity matters.** Very broad single filters (e.g. `type: "print"` alone — 421K works, or `material: "paper"` — 643K) exceed the internal candidate limit, so semantic ranking operates on a subset. Results are still high-quality (distances are near-optimal), but a different subset might surface equally-good alternatives. For best coverage, combine two or more filters or pair a broad filter with a specific one (e.g. `type: "print", subject: "landscape"`).

**Language note**: English queries yield slightly higher precision against the
bilingual catalogue even though the embedding model is multilingual. If a Dutch
or German query returns unexpected results, reformulate in English.

### 5. Image Inspection and Overlay Placement

**Two image tools, different purposes.** `get_artwork_image` opens the inline IIIF deep-zoom viewer and returns metadata plus a `viewUUID` handle for follow-up navigation — use it when the user wants to *see* the image themselves. `inspect_artwork_image` returns image bytes as base64 so the model can analyse the image directly — use it whenever *you* need to read inscriptions, identify details, or reason about composition. They compose cleanly: open with `get_artwork_image`, then `inspect_artwork_image` for analysis (which also auto-navigates the open viewer to whatever region you inspected, so the user sees what you're looking at).

**Basic inspection + zoom is a single step.** `inspect_artwork_image` automatically navigates the open viewer to the inspected region (`navigateViewer` defaults to `true`). No separate `navigate_viewer` call is needed for basic zoom — the viewer stays in sync with your analysis.

```
# Single call: inspect a region AND zoom the viewer there
inspect_artwork_image(objectNumber="SK-C-5", region="pct:70,60,20,20")
# → base64 image for AI analysis + viewer auto-zooms to the same region
```

**For overlays, use the inspect → overlay two-step with `relativeTo`:**

```
# Step 1: inspect the area
inspect_artwork_image(objectNumber="SK-C-5", region="pct:70,60,20,20")
# → found a detail at roughly the center of this crop

# Step 2: place overlay using crop-local coordinates — the server projects to full-image space
navigate_viewer(viewUUID=..., commands=[{
  action: "add_overlay",
  region: "pct:30,30,40,40",      # coordinates within the crop
  relativeTo: "pct:70,60,20,20",  # the crop region from Step 1
  label: "Detail"
}])
```

The `relativeTo` parameter eliminates manual coordinate conversion — specify where the feature is within the crop, and the server handles the projection. Both `region` and `relativeTo` must use `pct:` format.

For pixel-precision work on dense compositions (e.g. cataloguing several insects on a flower piece), use `crop_pixels:x,y,w,h` instead — coordinates are full-image pixels, so no `relativeTo` projection is needed. `inspect_artwork_image` echoes `nativeWidth`/`nativeHeight` in both the structured payload and the caption so you can bound pixel values to the actual image.

Use `region="full"` for an initial composition overview before cropping to
details. `inspect_artwork_image` can surface content **absent from structured
metadata** — unsigned Japanese prints often have readable artist signatures,
publisher seals, and poem cartouches that the catalogue has not transcribed.

**Other inspect parameters:** `size` defaults to 1568 px (range 200–2016, aligned to multiples of 28 for clean LLM coordinate handling). `show_overlays: true` composites any active viewer overlays onto the returned crop (response clamped to 448 px when enabled — useful for verifying overlay placement). `viewUUID` targets a specific viewer session when the user has multiple open; omit to auto-discover a viewer for the artwork.

### 6. Provenance and Acquisition Research

Provenance research moves through three levels of detail:

1. **Scope and profile** — `search_artwork` with `creditLine` for fast counts
   and facets. `creditLine` covers ~360K artworks (vs ~49K with parsed
   provenance) and captures the last link: how the museum acquired the work.
   Combine with `productionPlace` + `expandPlaceHierarchy` for geographic
   cross-tabulation. (The `provenance` keyword filter on `search_artwork` was
   removed in v0.27 — for keyword search over raw provenance text use
   `search_provenance` instead.)

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

In v0.27 there are three complementary paths between a work and its peers,
copies, sources, pendants, components, or derivatives:

1. **Curator-declared edges via `find_similar`** — the most direct path. `find_similar(objectNumber)` returns one HTML page that includes a **Related Co-Production** column (creator-invariant edges: pendants, production stadia, different examples of one design) and a **Related Object** column (derivative + grouping edges: pairs, sets, recto/verso, reproductions, general related-object links — tiered weights). Surface the link to the user; they read off the channel column relevant to their question.
2. **Direct cross-references on the work itself** — `get_artwork_details` returns a `relatedObjects[]` field with each peer's `objectNumber` (canonical handle) plus a Linked Art `objectUri`. Pass either back to `get_artwork_details({objectNumber: …})` or `get_artwork_details({uri: …})` to navigate. ~77K artworks have at least one outgoing related-object edge.
3. **Reproductive-print keyword path** — when the curator-declared edges are absent, `productionRole` still works for tracing reproductive prints to their painted sources:

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

In v0.27 demographic gating is a **two-step pattern** via `search_persons`. The
old `creatorGender` / `creatorBornAfter` / `creatorBornBefore` modifiers and the
`collection_stats(dimension="creatorGender")` aggregation no longer exist.

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

`find_similar` takes a known artwork and renders an **HTML comparison page** at `${PUBLIC_URL}/similar/:uuid` (cached for 30 minutes) showing the source work alongside nearest neighbours across **9 independent similarity channels** plus a pooled column. The tool takes only `objectNumber` and `maxResults` — there is no `signal` parameter. Your job is to surface the link to the user, **not** to fetch, summarise, or paraphrase the page.

The 9 channel columns on the rendered HTML page (column legend, not query parameters):

| Channel column | Matches on | Read it when the user is asking about… |
|---|---|---|
| Visual | Image embedding (composition, palette, format) | Look-alikes regardless of attribution — "other prints with this feel" |
| Related Co-Production | Curator-declared creator-invariant edges (pendants, production stadia, different examples) | Pairs/companions/variants of the same composition by the same hand |
| Related Object | Curator-declared derivative + grouping edges (pairs, sets, recto/verso, reproductions, general related-object links — tiered weights) | Components, derivatives, reproductive copies, sets/series |
| Lineage | Shared creator + assignment-qualifier overlap | Workshop, follower, pupil, copy neighbourhoods |
| Iconclass | Overlapping Iconclass notations | Works with the same iconographic programme |
| Description | Dutch-description embedding similarity | Shared themes, technique, style vocabulary in cataloguer text |
| Theme | Curatorial-theme set overlap (IDF-weighted) | Works grouped under the same collection-level narrative |
| Depicted Person | Same person(s) portrayed | Sitters across multiple portraits; historical figures |
| Depicted Place | Same place(s) shown | Views of the same city, building, or landscape |
| Pooled | Blend of all nine — works that score in **4+** channels | Exploratory "what else is like this" when you don't yet know which dimension matters |

```
find_similar(objectNumber="RP-P-1958-335")  # one call → HTML page with all 9 channels + pooled
find_similar(objectNumber="RP-P-1958-335", maxResults=50)  # widen each column
```

The HTML page renders all channels in a single view; `maxResults` defaults to 20 (max 50) candidates per channel. The tool is feature-gated (`ENABLE_FIND_SIMILAR`); the Theme channel is independently gated by `ENABLE_THEME_SIMILAR`. If unavailable, fall back to `semantic_search` or a structured `search_artwork` built from the source artwork's filters (shared creator + type + subject).

---

## Known Limitations and Fallbacks

| Issue | Workaround |
|---|---|
| `navigate_viewer` reports `viewerConnected: false` | Means the inline viewer iframe hasn't polled within 5s (no WebSocket — the viewer polls `poll_viewer_commands` every 500ms). Commands are still queued server-side and delivered on the next poll. If `viewerConnected: false` persists across multiple fresh `get_artwork_image` calls, the iframe likely failed to mount on the host — surface this to the user rather than silently falling back to `inspect_artwork_image`. |
| No `subject` results in English | Try the Dutch term — vocabulary is bilingual ("fotograaf" not "photographer") |
| `semantic_search` skews toward prints/drawings | Filter with `type: "painting"` — prints and drawings outnumber paintings ~77:1 |
| `semantic_search` with very broad filter | Single broad filters (`type: "print"`, `material: "paper"`) exceed the candidate limit — results are good but not exhaustive. Combine filters for better coverage. |
| Inscription field empty in catalogue | Use `inspect_artwork_image` — AI vision can often read text directly from the image. Try `quality: "gray"` for better contrast on faded inscriptions or signatures. |
| `facets` on `search_artwork` | Multiple dimensions including type, material, technique, century, theme, sourceType, rights, imageAvailable, creator, depictedPerson, depictedPlace, productionPlace. Configure with `facetLimit` (1–50, default 5). Pass `facets=true` for all or `facets=["creator","type"]` for specific ones. Dimensions already filtered on are excluded automatically. All entries include percentage. |
| `facets` on `search_provenance` | 5 dimensions: transferType, decade, location, transferCategory, partyPosition. Set `facets=true`. Percentages included. |
| Collection-wide distributions | Use `collection_stats` instead of `compact=true` counting loops. Artwork dimensions: `type`, `material`, `technique`, `creator`, `depictedPerson`, `depictedPlace`, `productionPlace`, `sourceType`, `theme`, `exhibition`, `century`, `decade`, `decadeModified`, `height`, `width`. Provenance dimensions: `transferType`, `transferCategory`, `provenanceDecade`, `provenanceLocation`, `party`, `partyPosition`, `currency`, `categoryMethod`, `positionMethod`, `parseMethod`. Cross-domain filters combine freely. One call replaces N iterations. (`creatorGender` is **not** a valid dimension in v0.27 — for gender breakdowns, run `search_persons` then `collection_stats(creator=…)`.) |
| `search_provenance` data model details | Batch prices, unsold lots, historical currencies, gap flags, parse methods, party coverage, 0-year durations, and `sortBy: "eventCount"` unreliability — see `references/provenance-and-enrichment-patterns.md` |
| `attributionQualifier` + `creator` | As of v0.24 did not work — use `aboutActor` instead. May have changed in v0.27 (see Critical Parameter Distinctions above for TODO). |
| `attributionQualifier: "manner of"` | Not a valid value — returns zero results. Use `aboutActor`. |
| Canonical artist name forms | Some artists use historical spellings (e.g. "Jheronimus Bosch"). If a known artist returns no results, check the canonical form via `get_artwork_details` on a known work. |
| `search_persons` returns 0 rows for a demographic filter | The `gender`, `bornAfter`, `bornBefore` filters require person enrichment to be present on the vocab DB. On a fresh harvest without enrichment they return zero rows — name-token matching and structural filters (`birthPlace`, `deathPlace`, `profession`) still work. |
| `relatedObjects` field on `get_artwork_details` | Now populated (~77K artworks have ≥1 outgoing related-object edge). Each entry carries `objectNumber` plus a Linked Art `objectUri`; pass either back to `get_artwork_details`. For curated-edge similarity discovery, use `find_similar` and read its **Related Co-Production** and **Related Object** columns. |
| Multi-folio works dominate results (sketchbooks, albums, print series) | The Rijksmuseum catalogues sketchbooks/albums/print-series as a parent record plus child records per folio, so a single physical object can fill the first page of results. Use `groupBy: "parent"` on `search_artwork` to collapse children whose parent is also in the result set (the parent gains a `groupedChildCount`). When `groupBy` isn't set, the response's `warnings` field flags clustering (e.g. "8 results are folios/components of BI-1898-1748A"). Affects ~4.6% of artworks (object numbers with parenthetical suffixes). |

---

## Output Conventions

- Always report `objectNumber` (e.g. `SK-C-5`) linked to the Rijksmuseum's page for that artwork when surfacing works — it is the stable identifier across all tools
- For citation, use the persistent handle.net URI from `get_artwork_details` → `externalIds` (work-level external IDs surface here, including handle and other authority links)
- For person-level external IDs (Wikidata Q-id and others), consult `production[].creator.wikidataId` on `get_artwork_details`, or `wikidataId` on `search_persons` results
- The `attributionEvidence` array on `get_artwork_details` cites the specific text/object that supports each attribution — useful for citation rigour
- When presenting multiple works, lead with the most significant first (the default importance ranking handles this for vocabulary queries)
- For image inspection findings, distinguish explicitly between what the structured metadata says and what the AI reads directly from the image — the distinction matters for research rigour

---
