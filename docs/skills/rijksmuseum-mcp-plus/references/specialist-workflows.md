# Specialist Workflows

Practical mechanics for two tasks where the tools' own descriptions leave out hard-won detail: reading fine detail from images, and turning a demographic profile into a list of works.

## Image inspection

**Two image tools, different purposes.** `get_artwork_image` opens the inline IIIF deep-zoom viewer for the **user** to see. `inspect_artwork_image` returns image bytes for the **model** to analyse directly. They compose: open with `get_artwork_image`, then `inspect_artwork_image` auto-navigates the open viewer to whatever region you inspect, so the user sees what you're looking at — no separate `navigate_viewer` call needed for basic zoom. **Exception: `region: "full"` never moves the viewer** (it would reset a zoom the user may have set by hand), so a survey inspect leaves their view untouched — don't tell them it moved. Use `navigate_viewer` only to move the user's view without fetching bytes for your own analysis.

```
inspect_artwork_image(objectNumber="SK-C-5", region="pct:70,60,20,20")
# → base64 image for AI analysis + viewer auto-zooms to the same region
```

**Catalogue-first localization.** Before visually searching for a named feature, call `get_artwork_details` and read `description` (Dutch) and `curatorialNarrative` — cataloguers frequently state a feature's location verbally (e.g. "links een huilende jongen" = "a crying boy on the left"). This is worth doing before spending an inspect call on a search. Caveats: description coverage is roughly 61% and mostly Dutch, the target may go unmentioned, stated directions are viewer-perspective, and the text describes the whole work — it cannot replace looking.

**Survey before drilling.** Always call `inspect_artwork_image(region: "full")` before cropping in, even for a famous or frequently-reproduced work. Fame is not a substitute for looking — training-data memory of a well-known composition is frequently wrong in exactly the details worth examining.

**Magnify before measuring.** A 30 px subject in a `region: "full"` inspection (≈1568 px wide, the default `size`) has no edges you can read precisely. Inspect at a tight `pct:` region so the feature spans **hundreds of pixels** in the returned crop, then read its detail off that crop. Raising `size` is the weaker lever — it accepts up to 1988, but the server clamps to the region's own pixel width (it never upscales) and to what the vision encoder accepts before downscaling, reporting either as a `size clamped from …` warning. Cropping tighter beats asking for a bigger image. For multiple spatially distinct features (e.g. a shell group on the left, a grasshopper on the right), prefer **one targeted inspect per region** over a single wide inspect. `inspect_artwork_image` returns `cropPixelWidth`, `cropPixelHeight`, and `cropRegion` for the returned crop; to steer the user's viewer to a crop-local sub-region without another byte fetch, pass those into `navigate_viewer`'s `relativeTo` + `relativeToSize` with a `crop_pixels:` region and the server projects deterministically.

**Edge rule.** If the target touches any edge of the inspected crop, re-center the crop before drilling further — a feature straddling an edge is a sign the crop needs adjusting.

`inspect_artwork_image` can surface content **absent from structured metadata** — unsigned Japanese prints often have readable artist signatures, publisher seals, and poem cartouches that the catalogue has not transcribed.

**User-drawn highlights.** The user can draw a highlight box directly in the open viewer; its `pct:` region arrives in the chat as a message (`[Highlight: region pct:… on "<title>" (<objectNumber>)]`). This reliably binds a viewer location to the request — the user names the exact box, so there is no *coordinate* guesswork. The message carries the coordinates only, not the pixels, so before answering you **must** call `inspect_artwork_image` with that exact `pct:` region and base your response on the returned crop. Then act on it per the user's instruction — describe what the crop contains, or answer their question about it.

---

## Demographic cohorts

**For an aggregate breakdown**, `collection_stats` carries the demographic dimensions directly — `dimension="gender"` (also `profession`, `creatorBirthDecade`, `creatorBirthCentury`, `birthPlace`, `deathPlace`), each usable as a filter too (e.g. `dimension="type", gender="female"`). These bucket *artworks* by their maker's enriched person record, so read them as distributions of works, not artist head-counts.

**For the actual works by a demographic cohort, use the two-step pattern via `search_persons`.** `search_artwork` has no `gender` / `bornAfter` / `bornBefore` / `profession` filters, so demographic predicates reach individual works only through `search_persons` (which returns vocab IDs) → `search_artwork(creator=…)`.

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
