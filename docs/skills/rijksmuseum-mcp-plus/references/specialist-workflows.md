# Specialist Workflows

Low-frequency, multi-step recipes that only some research paths reach. Each is
summarised by a pointer stub under `## Key Workflows` in `SKILL.md`; the full
worked detail lives here. Load this file when a task matches one of the
sections below.

## Contents

1. [Image Inspection](#5-image-inspection)
2. [Source–Copy and Related-Object Navigation](#7-sourcecopy-and-related-object-navigation)
3. [Collection Depth Assessment](#8-collection-depth-assessment)
4. [Gender and Demographic Analysis](#9-gender-and-demographic-analysis)

(Numbers match the `SKILL.md` workflow they expand — §6 Provenance and §10
Similarity are disclosed to `provenance-and-enrichment-patterns.md` and
`find-similar-channels.md` respectively.)

---

### 5. Image Inspection

**Two image tools, different purposes.** `get_artwork_image` opens the inline IIIF deep-zoom viewer for the **user** to see. `inspect_artwork_image` returns image bytes for the **model** to analyse directly. They compose: open with `get_artwork_image`, then `inspect_artwork_image` auto-navigates the open viewer to whatever region you inspect, so the user sees what you're looking at — no separate `navigate_viewer` call needed for basic zoom. Use `navigate_viewer` only to move the user's view without fetching bytes for your own analysis.

```
inspect_artwork_image(objectNumber="SK-C-5", region="pct:70,60,20,20")
# → base64 image for AI analysis + viewer auto-zooms to the same region
```

**Catalogue-first localization.** Before visually searching for a named feature, call `get_artwork_details` and read `description` (Dutch) and `curatorialNarrative` — cataloguers frequently state a feature's location verbally (e.g. "links een huilende jongen" = "a crying boy on the left"). This is worth doing before spending an inspect call on a search. Caveats: description coverage is roughly 61% and mostly Dutch, the target may go unmentioned, stated directions are viewer-perspective, and the text describes the whole work — it cannot replace looking.

**Survey before drilling.** Always call `inspect_artwork_image(region: "full")` before cropping in, even for a famous or frequently-reproduced work. Fame is not a substitute for looking — training-data memory of a well-known composition is frequently wrong in exactly the details worth examining.

**Magnify before measuring.** A 30 px subject in a `region: "full"` inspection (≈1568 px wide) has no edges you can read precisely. Inspect at a tight `pct:` region so the feature spans **hundreds of pixels** in the returned crop, then read its detail off that crop. For multiple spatially distinct features (e.g. a shell group on the left, a grasshopper on the right), prefer **one targeted inspect per region** over a single wide inspect. `inspect_artwork_image` returns `cropPixelWidth`, `cropPixelHeight`, and `cropRegion` for the returned crop; to steer the user's viewer to a crop-local sub-region without another byte fetch, pass those into `navigate_viewer`'s `relativeTo` + `relativeToSize` with a `crop_pixels:` region and the server projects deterministically.

**Edge rule.** If the target touches any edge of the inspected crop, re-center the crop before drilling further — a feature straddling an edge is a sign the crop needs adjusting.

`inspect_artwork_image` can surface content **absent from structured metadata** — unsigned Japanese prints often have readable artist signatures, publisher seals, and poem cartouches that the catalogue has not transcribed. Use `region="full"` for an initial composition overview before cropping to details.

**User-drawn highlights.** The user can draw a highlight box directly in the open viewer; its `pct:` region arrives in the chat as a message (`[Highlight: region pct:… on "<title>" (<objectNumber>)]`). This reliably binds a viewer location to the request — the user names the exact box, so there is no *coordinate* guesswork. The message carries the coordinates only, not the pixels, so before answering you **must** call `inspect_artwork_image` with that exact `pct:` region and base your response on the returned crop. Then act on it per the user's instruction — describe what the crop contains, or answer their question about it.

---

### 7. Source–Copy and Related-Object Navigation

Three complementary paths connect a work to its peers, copies, sources, pendants, components, or derivatives:

1. **Curator-declared edges via `find_similar`** — the most direct path. `find_similar(objectNumber)` returns one HTML page that includes a **Related Variant** column (creator-invariant edges: pendants, production stadia, different examples of one design) and a **Related Object** column (derivative + grouping edges: pairs, sets, recto/verso, reproductions, general related-object links — tiered weights). Surface the link to the user; they read off the channel column relevant to their question.
2. **Direct cross-references on the work itself** — `get_artwork_details` returns a `relatedObjects[]` field, scoped to the three creator-invariant relationships (`different example`, `production stadia`, `pendant`). Each entry always carries a Linked Art `objectUri` (the reliable handle) plus an `objectNumber` that is populated only when the peer URI resolves to a row in our DB — it is `null` for unresolved URIs. Pass the `objectUri` to `get_artwork_details({uri: …})` to navigate (or `objectNumber` to `get_artwork_details({objectNumber: …})` when it is present). For pairs, sets, recto/verso, reproductions, and general related-object links, read off `find_similar`'s Related Object column instead — these are not exposed on `relatedObjects[]`. A work's **physical companions** — its frame(s) and pedestal (labels `object | current frame`, `object | former frame`, `object | pedestal`) — are surfaced separately as `physicalRelations[]` (same `{ relationship, objectNumber, title, objectUri, iiifId }` shape, capped with `physicalRelationsTotalCount`), kept distinct from `relatedObjects[]` because they are attached objects, not creator-invariant variants.
3. **Reproductive-print keyword path** — when curator-declared edges are absent, `productionRole` traces reproductive prints to their painted sources:

```
search_artwork(productionRole="after painting by", creator="Rembrandt van Rijn")
# → get_artwork_details on a result to read its description (often names the source)
# → search_artwork(creator="Rembrandt van Rijn", type="painting", query="...") to find the source
# → get_artwork_image on both for side-by-side comparison
```

---

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

---

### 9. Gender and Demographic Analysis

**For an aggregate breakdown**, `collection_stats` now carries the demographic dimensions directly — `dimension="gender"` (also `profession`, `creatorBirthDecade`, `creatorBirthCentury`, `birthPlace`, `deathPlace`), each usable as a filter too (e.g. `dimension="type", gender="female"`). These bucket *artworks* by their maker's enriched person record, so read them as distributions of works, not artist head-counts (see the Creator-dimension caveat in `SKILL.md` §1, *Scope Before You Browse*).

**For the actual works by a demographic cohort, the two-step pattern via `search_persons` is still required.** `search_artwork` has no `gender` / `bornAfter` / `bornBefore` / `profession` filters, so demographic predicates reach individual works only through `search_persons` (which returns vocab IDs) → `search_artwork(creator=…)`.

```
# Step 1 — find the persons matching the demographic profile
search_persons(gender="female", profession="painter", bornBefore=1800, bornAfter=1700)
# → returns vocabIds (bare numeric strings, e.g. "210169673")

# Step 2 — fetch each person's works, then union the result sets client-side
#          (dedupe by objectNumber). creator accepts a vocabId (the exact handle —
#          a name can match several same-named artists). One call PER person:
search_artwork(creator=vocabId_1, type="painting", dateMatch="midpoint")
search_artwork(creator=vocabId_2, type="painting", dateMatch="midpoint")
# …one per vocabId, then merge yourself.
#
# Do NOT pass creator=[vocabId_1, vocabId_2, …]: array values are AND-combined, so that
# asks for works made jointly by ALL listed artists (usually 0), not by any cohort member.

# To compare structurally over time, repeat Step 1 with bornBefore/bornAfter shifted by century
# and union each cohort's per-person calls.
```

**Coverage caveat:** demographic filters (`gender`, `bornAfter`, `bornBefore`) need person-enrichment — zero rows without it, undercounts where it's sparse. Structural filters (`birthPlace`, `deathPlace`, `profession`) pivot through creator-mapped artworks, so the artwork-level attribute leaks to co-creators on multi-creator works (e.g. prints) — expect false positives (incl. `anonymous`/`unknown` placeholders). Treat these person lists as approximate, not authoritative cohorts.

Most persons in the catalogue never appear as a creator on any artwork — the default `hasArtworks: true` limits results to those who do. Pass `unused: true` to invert that: it returns only persons with **no** creator mapping, a quick way to surface orphaned or duplicate authority entries.
