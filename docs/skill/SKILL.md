---
name: rijksmuseum-mcp
description: >
  Research workflows for the Rijksmuseum MCP+ server. Use this skill whenever
  the user wants to search the Rijksmuseum collection, look up artwork details,
  explore iconographic themes, inspect high-resolution images, trace provenance,
  browse curated sets, or answer any art-historical question that could be
  addressed through the Rijksmuseum's holdings of ~832,000 artworks.
---

# Rijksmuseum MCP+ Research Skill

## Core Mental Model

The server is not a 'one and done' search engine — it is a resource for actively exploring and researching the collection of the Rijksmuseum. Many meaningful questions will require several chained tool calls. The canonical sequence is:
```
DISCOVER → QUANTIFY → RETRIEVE → INSPECT
```
Avoid jumping directly to RETRIEVE without a DISCOVER or QUANTIFY step unless the query is simple and straightforward (e.g. the object number is already known). For QUANTIFY, use `collection_stats` for distributions and cross-domain breakdowns, `compact: true` for simple counts.

---

## Tool Selection Guide

| Question type | Start here |
|---|---|
| "Find works about X" — clear vocabulary concept | `search_artwork` with `subject` |
| "Find works about X" — interpretive / atmospheric | `semantic_search` |
| "Find works depicting [iconographic scene]" | `lookup_iconclass` → `search_artwork` with `iconclass` |
| "How many works match X?" | `search_artwork` with `compact: true` |
| "Distribution of X across the collection" | `collection_stats` with `dimension` |
| "Top N creators / depicted persons / places" | `collection_stats` with `dimension` + `topN` |
| "Sales by decade" / time series | `collection_stats` with `dimension: "provenanceDecade"` |
| "How many artworks have LLM-mediated interpretations?" | `collection_stats` with `dimension: "categoryMethod"` |
| "Of artworks with provenance, how many are paintings?" | `collection_stats` with `dimension: "type"` + `hasProvenance: true` |
| "What does the Rijksmuseum say about this work?" | `get_artwork_details` |
| "What scholarship exists on this work?" | `get_artwork_bibliography` |
| "Examine this image closely / read this inscription" | `inspect_artwork_image` |
| "Show me a curated group of works on X" | `list_curated_sets` → `browse_set` |
| "Has anything changed / been acquired recently?" | `get_recent_changes` |
| "Who owned this work / trace its ownership chain" | `search_provenance` with `objectNumber` |
| "Which works passed through collector X?" | `search_provenance` with `party` |
| "Find confiscations / sales / transfers in city Y" | `search_provenance` with `transferType`, `location` |
| "How long did family X hold their collection?" | `search_provenance` with `layer: "periods"`, `ownerName` |

**Choosing between `search_artwork(provenance=...)` and `search_provenance`:**
`search_artwork` with `provenance` is a keyword search over raw provenance text — fast for counting, faceting, and cross-tabulation (e.g. "how many Mannheimer works are porcelain?"). `search_provenance` returns structured, parsed chains with dates, prices, transfer types, and ownership periods — use it when you need to reason about the *sequence* of ownership, filter by event type, or rank by price or duration. For the last link in the chain — how the Rijksmuseum acquired a work — also check `creditLine`, which covers ~358K artworks (vs ~48K with parsed provenance) and often names donors or funds absent from the provenance chain (e.g. "Drucker-Fraser", "Vereniging Rembrandt").

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

- `subject`: morphological stemming against ~108K terms (almost all in English); best first pass; try natural phrases ("winter landscape", "vanitas", "civic guard")
- `iconclass`: the Iconclass classification system — a universal art-historical taxonomy of ~40,675 notations across 13 languages, with hierarchical browsing and pre-computed Rijksmuseum artwork counts. Three search modes via `lookup_iconclass`:
  - keyword (`query`): FTS5 across labels and keywords in all 13 languages (exact word match)
  - semantic (`semanticQuery`): embedding-based concept search — finds notations by meaning, not just words (e.g. "domestic animals" finds dogs, cats, horses)
  - browse (`notation`): navigate the hierarchy — view any notation's path, children, cross-references, and keywords

Each result includes a `rijksCount` (how many Rijksmuseum artworks carry that notation), so you can gauge usefulness before searching. Pass the notation code to `search_artwork`'s `iconclass` parameter for precise filtering.

**Decision rule:** start with `subject` — it's faster and handles most queries well. Switch to `iconclass` when:
- you need to distinguish closely related scenes (Crucifixion vs Deposition, Annunciation vs Visitation)
- `subject` returns too broad a result set and you need hierarchical precision
- you want to explore a conceptual neighbourhood (browse children/siblings of a notation)
- the query is in a non-English language (Iconclass covers 13 languages; subject vocab is almost entirely English)
- you want to search by meaning rather than keywords (semantic mode: "religious suffering", "festive gathering")

### `attributionQualifier` + `creator` — structural limitation

The parameter description suggests combining `attributionQualifier` with `creator` to filter by source artist (e.g. "find all followers of Rembrandt"). **This combination never works — the tool schema documentation is incorrect.** Verified across all qualifier types (`follower of`, `workshop of`, `circle of`, `attributed to`): the structured `creator` field is always `Unknown [painter]` or `anonymous`, regardless of qualifier. The source artist's name appears only in the composite display string and is not exposed as a searchable entity field.

**The correct strategy by qualifier type:**

| Goal | Working approach |
|---|---|
| Works in the manner/style of artist X | `aboutActor: "X"` + `type: "painting"` (or other type) |
| All "follower of" works in the collection | `attributionQualifier: "follower of"` alone (returns ~111 works) |
| Sub-filter those by source artist | Not possible via parameters — requires fetching and inspecting individual records |

**Additional complication — "manner of" is not a valid qualifier value.** The Rijksmuseum uses "manner of" as a distinct attribution category, but `"manner of"` is not in the `attributionQualifier` controlled vocabulary and returns zero results. Works attributed in this way are retrievable only via `aboutActor`.

**Canonical name form matters.** The Rijksmuseum catalogue uses historical Dutch/Latin spellings for some artists. Bosch is catalogued as **"Jheronimus Bosch"**, not "Hieronymus Bosch". Always check `get_artwork_details` on a known work to confirm the canonical form before filtering.

### `creator` vs `aboutActor` vs `depictedPerson`

- `creator`: who made it — uses canonical name forms ("Rembrandt van Rijn")
- `depictedPerson`: who is *shown* in it — matches 210K name variants including historical forms
- `aboutActor`: broader cross-field search; more tolerant of name variants and cross-language forms ("Louis XIV" finds "Lodewijk XIV")

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

For the full provenance data model — AAM text format, transfer type vocabulary, party roles and positions, date/currency representations, and tested query patterns — see `references/provenance-patterns.md`.

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
| `hasProvenance: true` | Restricts to ~48K artworks with parsed provenance. Pair with `type`, `creator`, etc. for cross-domain queries. |
| `creatorGender: "female"` | Pair with `type`, `subject`, or `creationDate` |
| `creatorBornAfter` / `creatorBornBefore` | Pair with any content filter |
| `expandPlaceHierarchy: true` | Expands place filters 3 levels deep; pair with `productionPlace` etc. |

---

## Key Workflows

### 1. Scope Before You Browse

For any comparative, counting, or distributional question, run `compact: true`
first to map the landscape before fetching full metadata.

```
# Example: Rembrandt's output across media
search_artwork(creator="Rembrandt van Rijn", compact=true)           # total
search_artwork(creator="Rembrandt van Rijn", type="painting", compact=true)
search_artwork(creator="Rembrandt van Rijn", type="print", compact=true)
search_artwork(creator="Rembrandt van Rijn", type="drawing", compact=true)
# Then: get_artwork_details on selected works from each category
```

This avoids fetching thousands of metadata records to answer what is
essentially a counting question.

**One-call alternative**: for distributional questions, `collection_stats` replaces the multi-call loop:
```
collection_stats(dimension="type", creator="Rembrandt van Rijn")
# → painting 314 (38.2%), print 289 (35.2%), drawing 218 (26.5%)
```

### 2. Iconclass Two-Step

Never pass iconographic concepts as free text to `search_artwork(iconclass=...)` —
it expects exact notation codes. Always discover valid codes first via `lookup_iconclass`.

**Step 1: discover notation codes (three modes available)**

```
lookup_iconclass(query="Crucifixion")                                      # keyword
lookup_iconclass(semanticQuery="religious suffering", onlyWithArtworks=True) # semantic
lookup_iconclass(notation="73D8")                                          # browse hierarchy
# → shows children: 73D81 (Christ before Pilate), 73D82 (Crucifixion), …
```

**Step 2: search with the discovered code**
```
search_artwork(iconclass=["73D82"])
search_artwork(iconclass=["73D82", "25F33(DOVE)"])  # AND-combines multiple codes
```

Check `rijksCount` in `lookup_iconclass` results before searching — a code with `rijksCount: 0` will return nothing.

### 3. Century / Decade Wildcards

Use `creationDate` wildcards for longitudinal analysis. Combine with `compact: true` to count across time ranges.

```
search_artwork(technique="etching", creationDate="16*", compact=true)
search_artwork(technique="etching", creationDate="17*", compact=true)
# Reveals technique-adoption transitions at collection scale
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

**Language note**: English queries yield slightly higher precision against the
bilingual catalogue even though the embedding model is multilingual. If a Dutch
or German query returns unexpected results, reformulate in English.

### 5. Two-Pass Image Inspection

Single-pass overlay placement in `navigate_viewer` is unreliable. Always
inspect first, then annotate.

```
# Pass 1: locate the feature
inspect_artwork_image(objectNumber="SK-C-5", region="pct:70,60,20,20")
# → base64 image + AI analysis of what's in that region

# Pass 2: place overlay using confirmed coordinates from Pass 1
navigate_viewer(objectNumber="SK-C-5", add_overlay={...confirmed coordinates...})
```

Use `region="full"` for an initial composition overview before cropping to
details. `inspect_artwork_image` can surface content **absent from structured
metadata** — unsigned Japanese prints often have readable artist signatures,
publisher seals, and poem cartouches that the catalogue has not transcribed.

### 6. Provenance and Acquisition Research

Provenance research typically moves through three levels of detail. Use
`search_artwork` for fast counting and profiling, `search_provenance` for
structured chain analysis, and `get_artwork_details` for a single work's
full narrative.

**Step 1 — Scope and profile** (fast counts + facets via `search_artwork`)
```
search_artwork(provenance="Mannheimer", compact=true,
               facets=["type", "century", "material"], maxResults=1)
# → 792 artworks. Mostly porcelain, gold, 18th century.
```
Combine `provenance` with `productionPlace` + `expandPlaceHierarchy` for
geographic cross-tabulation. For acquisition channel analysis, use `creditLine`
— it covers ~358K artworks (far more than the ~48K with parsed provenance)
and captures the last link: how the museum acquired the work.

**Enrichment transparency:** `categoryMethod` and `positionMethod` are both visible in output *and* queryable as input filters:
```
search_provenance(categoryMethod="llm_enrichment", maxResults=10)
# → artworks where transfer type was classified by LLM

search_provenance(positionMethod="llm_enrichment", maxResults=10)
# → artworks where party position was assigned by LLM
```
When results contain LLM-enriched records, the response includes a URL to an enrichment review page. **Always show this URL to the user.**

**Cross-domain queries** with `hasProvenance` on `search_artwork`:
```
search_artwork(type="painting", hasProvenance=true, compact=true, facets=true)
# → 2,039 paintings with provenance, faceted by creator, century, etc.

collection_stats(dimension="type", hasProvenance=true)
# → type distribution across all 48K artworks with provenance
```

**Provenance facets** — add `facets: true` to any `search_provenance` call for quick distributional context:
```
search_provenance(party="Goudstikker", facets=true, maxResults=5)
# → chains + facets: transferType, decade, location, transferCategory, partyPosition
```

**Step 2 — Structured chain analysis** (via `search_provenance`)
```
search_provenance(party="Mannheimer", transferType="confiscation", maxResults=10)

# Anti-join: confiscated but never restituted
search_provenance(transferType="confiscation",
                  excludeTransferType="restitution", maxResults=20)

# Inheritance patterns — find works that passed through widows
search_provenance(transferType="widowhood", sortBy="dateYear",
                  sortOrder="asc", maxResults=20)

# Dealer network — find works where Goupil appears as sender (seller)
search_provenance(party="Goupil", maxResults=20)
# Then inspect party roles: role="seller" + position="sender" vs "buyer"/"receiver"

# Ownership durations
search_provenance(layer="periods", ownerName="Six",
                  sortBy="duration", sortOrder="desc", maxResults=20)

# Price history — most expensive recorded transactions
# IMPORTANT: filter batchPrice to exclude en bloc totals
search_provenance(hasPrice=true, currency="guilders",
                  sortBy="price", sortOrder="desc", maxResults=20)
# Then: check batchPrice flag on results — true means the price
# is a batch total for multiple artworks, not an individual price

# Wartime gaps — hasGap is artwork-level (any gap in the chain);
# dateFrom/dateTo filter on event date_year. Inspect the returned chain
# to confirm the gap falls within the target period.
search_provenance(hasGap=true, creator="Rembrandt",
                  dateFrom=1933, dateTo=1945, maxResults=20)

# Multi-generation family collections
search_provenance(transferType=["by_descent", "widowhood"],
                  layer="periods", minDuration=50,
                  sortBy="duration", sortOrder="desc", maxResults=20)
```

**Step 3 — Single-object deep dive**
```
search_provenance(objectNumber="SK-A-2344")
# → Full Milkmaid chain: Van Ruijven → Dissius → ... → Six → museum.
# Follow up with get_artwork_details for narrative text,
# and get_artwork_bibliography for scholarly references.
```

`bibliographyCount` in `get_artwork_details` gives you a count without the
cost of fetching full citations — use it to triage a result set before
committing to `get_artwork_bibliography` calls.

**Pagination**: when `totalResults` exceeds 50, paginate with `offset` (e.g.
`offset=0`, `offset=50`, `offset=100` until offset ≥ totalResults).

For the complete catalogue of tested provenance query patterns — including
collector profiling, acquisition channel analysis, and decade-level time series
construction — see `references/provenance-patterns.md`.

### 7. Source–Copy Navigation

`relatedObjects` in `get_artwork_details` provides direct links to associated
works. Use it instead of a second search when tracing reproductive prints back
to painted sources.

```
search_artwork(productionRole="after painting by", creator="Rembrandt van Rijn")
# → get_artwork_details on a result
# → relatedObjects links to the source painting's URI
# → get_artwork_details on that URI for full source metadata
# → get_artwork_image on both for side-by-side comparison
```

### 8. Collection Depth Assessment

For grant applications or scoping a research site:

```
search_artwork(productionPlace="Japan", type="print", compact=true)  # total count
list_curated_sets(query="Japan")                                       # curatorial groupings
browse_set(setId="...")                                                # range of artists/dates
search_artwork(productionPlace="Japan", type="print", maxResults=10)  # leading artists
```

### 9. Gender and Demographic Analysis

`creatorGender` is a modifier — always combine it with at least one content
filter. Use century wildcards to reveal structural patterns over time.

```
# Count women painters per century
search_artwork(creatorGender="female", type="painting", creationDate="17*", compact=true)
# Repeat for "18*", "19*"; then drop compact=true to identify leading artists per century

# Or: one-call gender breakdown per century
collection_stats(dimension="creatorGender", type="painting", creationDateFrom=1700, creationDateTo=1799)
# → male 4,521 (96.3%), female 48 (1.0%), ...
```

---

## Known Limitations and Fallbacks

| Issue | Workaround |
|---|---|
| `navigate_viewer` WebSocket disconnection | Use `inspect_artwork_image` as the reliable fallback for region analysis |
| No `subject` results in English | Try the Dutch term — vocabulary is bilingual ("fotograaf" not "photographer") |
| `semantic_search` skews toward prints/drawings | Filter with `type: "painting"` — prints and drawings outnumber paintings ~77:1 |
| `bibliographyCount` is high but citations needed | Use `get_artwork_bibliography(full=false)` to get structured metadata without full text |
| Inscription field empty in catalogue | Use `inspect_artwork_image` — AI vision can often read text directly from the image |
| `facets` on `search_artwork` | 11 dimensions: type, material, technique, century, creatorGender, rights, imageAvailable, creator, depictedPerson, depictedPlace, productionPlace. Configure with `facetLimit` (1–50, default 5). Pass `facets=true` for all or `facets=["creator","type"]` for specific ones. All entries include percentage. |
| `facets` on `search_provenance` | 5 dimensions: transferType, decade, location, transferCategory, partyPosition. Set `facets=true`. Percentages included. |
| Collection-wide distributions | Use `collection_stats` instead of pagination loops — 19 dimensions across artwork and provenance domains with cross-domain filters. |
| `search_provenance` batch prices | *En bloc* prices: when a batch was sold together, the total price is attributed to every item. Events with `batchPrice: true` are batch totals — **always filter these out** when ranking or comparing prices (`batchPrice: false`). |
| `search_provenance` unsold events | Sale events with `unsold: true` are auctions where the lot was not sold (bought in, withdrawn). No ownership transfer occurred. Filter these when analysing actual sales. |
| `search_provenance` `sortBy: "eventCount"` | Ranking is unreliable — pendant pairs and contextual annotations inflate event counts. Use `sortBy: "price"`, `"duration"`, or `"dateYear"` for stable rankings. |
| `search_provenance` historical currencies | Prices are stored in their original currency — no inflation adjustment or cross-currency conversion. Pre-decimal notations (£.s.d, fl. X:Y:-) are converted to decimal equivalents. |
| `search_provenance` `hasGap: true` too broad | The gap flag is very liberal. Always combine with `creator`, `dateFrom`/`dateTo`, or another filter to produce manageable result sets. |
| `search_provenance` 0-year durations | Same-year transactions (e.g. "1904–1904") yield 0-year ownership periods — not errors, they reflect rapid resale or same-day transfers. |
| `search_provenance` `parseMethod` values | Four values: `peg` (~80%, highest confidence), `cross_ref` (~20%), `credit_line` (~0.1%, inferred from credit line field), `regex_fallback` (legacy, unused). |
| `search_provenance` party coverage | ~86K parties across ~101K events. Not all events have named parties — bare-name `collection` events and cross-references often lack structured party data. |
| `attributionQualifier` + `creator` | Does not work — use `aboutActor` instead. See Critical Parameter Distinctions above. |
| `attributionQualifier: "manner of"` | Not a valid value — returns zero results. Use `aboutActor`. |
| Canonical artist name forms | Some artists use historical spellings (e.g. "Jheronimus Bosch"). If a known artist returns no results, check the canonical form via `get_artwork_details` on a known work. |

---

## Output Conventions

- Always report `objectNumber` (e.g. `SK-C-5`) linked to the Rijksmuseum's page for that artwork when surfacing works — it is the stable identifier across all tools
- Use `persistentId` (handle.net URI) for any citation or bibliographic reference
- When presenting multiple works, lead with the most significant first (the default importance ranking handles this for vocabulary queries)
- For image inspection findings, distinguish explicitly between what the structured metadata says and what the AI reads directly from the image — the distinction matters for research rigour

---
