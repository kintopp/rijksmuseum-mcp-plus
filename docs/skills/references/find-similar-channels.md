# `find_similar` — channel reference

`find_similar(objectNumber)` renders an HTML comparison page at `${PUBLIC_URL}/similar/:uuid` (cached 30 min) showing the source work alongside nearest neighbours across **9 independent similarity channels** plus a pooled column. The tool takes only `objectNumber` and `maxResults` (default 20, max 50, per channel); there is no `signal` parameter.

**Behavioural rule (also stated in SKILL.md):** your job is to surface the URL/path to the user — don't fetch, summarise, or paraphrase the page.

## Channels

| Channel               | Matches on                                                                        | Use when the user wants…                                           |
| --------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Visual                | Image embedding (composition, palette, format)                                    | Look-alikes regardless of attribution                              |
| Related Co-Production | Creator-invariant curator edges (pendants, production stadia, different examples) | Pairs/companions/variants by the same hand                         |
| Related Object        | Other curator edges (pairs, sets, recto/verso, reproductions — tiered)            | Components, derivatives, reproductive copies, sets/series          |
| Lineage               | Shared creator + assignment-qualifier overlap                                     | Workshop / follower / pupil / copy neighbourhoods                  |
| Iconclass             | Overlapping Iconclass notations                                                   | Same iconographic programme                                        |
| Description           | Dutch-description embedding similarity                                            | Shared themes/technique/style in cataloguer text                   |
| Theme                 | Curatorial-theme set overlap (IDF-weighted)                                       | Same collection-level narrative                                    |
| Depicted Person       | Same person(s) portrayed                                                          | Sitters across portraits; historical figures                       |
| Depicted Place        | Same place(s) shown                                                               | Views of the same city, building, or landscape                     |
| Pooled                | Blend of all nine — works scoring in **4+** channels                              | Exploratory "what else is like this" when the axis isn't yet known |

## Example

```
find_similar(objectNumber="RP-P-1958-335", maxResults=50)  # default 20
```

## Feature gating and fallbacks

Feature-gated (`ENABLE_FIND_SIMILAR`); Theme channel separately gated (`ENABLE_THEME_SIMILAR`). Fallback when unavailable: `semantic_search`, or `search_artwork` built from the source's creator + type + subject.
