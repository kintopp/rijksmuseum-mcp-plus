---
name: rijksmuseum-mcp-plus
description: >
  Research workflows for the Rijksmuseum MCP+ server, addressing Dutch arts, crafts, and history across the museum's holdings. Capabilities include keyword, structured, and semantic text search, AI-driven image analysis, geospatial queries, collection statistics, Iconclass-driven iconographic discovery, AAM/CMOA-aligned provenance, and image similarity research. Trigger on any question that could plausibly be answered from the Rijksmuseum's holdings — Golden Age Dutch and Flemish painting, prints and drawings, Asian export art, decorative arts and craft objects, photography, historical artefacts, ownership history, museum acquisitions — even when the user doesn't name the collection.
metadata:
  version: "0.90"
  last_updated: "2026-07-01"
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
| "Find/order artworks by physical size or by date"                             | `search_artwork` with `heightRange`/`widthRange` (e.g. `"10-50"`, `"100-"`, `"-30"`) and/or `sort` (e.g. `"height:desc"`, `"dateEarliest:asc"`)  |
| "Curatorial theme tags on a work / theme distribution"                        | `search_artwork(theme=…)` / `collection_stats(dimension="theme")`                                                    |
| "Cataloguing-channel breakdown (designs, drawings, paintings, prints…)"       | `search_artwork(sourceType=…)` / `collection_stats(dimension="sourceType")`                                          |
| "What changed since YYYY-MM-DD?" / "Has anything changed since the last harvest checkpoint?" — OAI-PMH delta | `get_recent_changes` (resumption-token pagination; withdrawn records flagged as deletions)                           |
| "What does the Rijksmuseum say about this work?"                              | `get_artwork_details`                                                                                                |
| "Wikidata Q-id, handle.net URI, other external IDs"                           | `get_artwork_details` → work-level `externalIds` (handle + other); entity-level `equivalents[]` (e.g. `production[].equivalents[]`, `subjects.depictedPersons[].equivalents[]`); creator Q-id at `production[].personInfo.wikidataId` |
| "Scholarly references / citations / bibliography for one work"                 | `get_artwork_bibliography` by `objectNumber` (`get_artwork_details` → `bibliographyCount` tells you whether any exist; `full: true` for all entries) |
| "Which works cite a given publication / reverse bibliography lookup"            | `find_artworks_citing_publication` — the reverse of `get_artwork_bibliography`; pass a `publication` URI or id (e.g. from a bibliography entry's `publicationUri`), `full: true` for all citing works |
| "Conservation/restoration history, technical examinations (X-ray, dendro, IR, paint samples) for one work" | `get_conservation_history` by `objectNumber`                                          |
| "Show this artwork to the user / open the zoomable viewer"                    | `get_artwork_image`                                                                                                  |
| "Examine this image closely / read this inscription"                          | `inspect_artwork_image`                                                                                              |
| "Find works similar to this one" — visual, thematic, lineage, shared subject  | `find_similar`                                                                                                       |
| "Find pendants / production stadia / different examples of one design"        | `find_similar` — read the `Related Variant` column on the resulting HTML page                                  |
| "Find pairs / sets / recto-verso / reproductions / derivatives"               | `find_similar` — read the `Related Object` column on the resulting HTML page                                         |
| "Show me a curated group of works on X"                                       | `list_curated_sets` → `browse_set`                                                                                   |
| "Who owned this work / trace its ownership chain"                             | `search_provenance` with `objectNumber`                                                                              |
| "Which works passed through collector X?"                                     | `search_provenance` with `party`                                                                                     |
| "Find confiscations / sales / transfers in city Y"                            | `search_provenance` with `transferType`, `location`                                                                  |
| "How long did family X hold their collection?"                                | `search_provenance` with `layer: "periods"`, `ownerName`                                                             |
| "Works bearing collector mark / Lugt N, or a handwritten signature on the recto" | `search_inscriptions` with `collectorMark` / facet combo (`inscriptionType`, `placement`, `technique`)           |
| "What is actually written/signed on this work?"                               | `get_artwork_details` → `parsedInscriptions` / `inscriptionSummary`, or `search_inscriptions` with `transcribedText` |


**Choosing between `search_artwork` (provenance-aware filters) and `search_provenance`:**
For keyword/text search over provenance, use `search_provenance` — `search_artwork` does not search provenance text. For cross-domain "what kinds of works have provenance" questions, use `hasProvenance: true` on `search_artwork` or `collection_stats` (e.g. `collection_stats(dimension="type", hasProvenance=true)`). `search_provenance` returns structured, parsed chains with dates, prices, transfer types, and ownership periods — use it when you need to reason about the *sequence* of ownership, filter by event type, or rank by price or duration. Use `search_provenance` (not `search_artwork`) for credit-line / donor / fund queries (e.g. "Drucker-Fraser", "Vereniging Rembrandt") — those names sit in the credit line, which covers a much larger share of the catalogue than parsed provenance does. For the credit-line-only population (works with no parsed provenance), reach it via `search_provenance`'s `creditLineQuery` fallback — see "`creditLineQuery` — unstructured credit-line fallback" below.

---

## Output Conventions

These rules govern how to present results regardless of which tool produced them.

- Always report `objectNumber` (e.g. `SK-C-5`) linked to the Rijksmuseum's page for that artwork when surfacing works — it is the stable identifier across all tools.
- For citation, use the persistent handle.net URI from `get_artwork_details` → `externalIds` (work-level external IDs surface here, including handle and other authority links).
- For person-level external IDs, use `production[].equivalents[]` (VIAF/ULAN/RKD/Wikidata — a creator can have several) and `production[].personInfo.wikidataId` on `get_artwork_details`, or `equivalents[]` / `wikidataId` on `search_persons` results.
- For authority IDs, distinguish work-level `externalIds` (handle + other) from entity-level `equivalents[]`. Entity crosswalks live on term arrays — `objectTypes[].equivalents[]`, `materials[].equivalents[]`, `subjects.depictedPersons[].equivalents[]`, `subjects.depictedPlaces[].equivalents[]`, `collectionSetLabels[].equivalents[]`, `themes[].equivalents[]` — and on `production[].equivalents[]`; each is a `{ authority, id, uri }` triple and one entity may carry several. `subjects.iconclass` has no `equivalents[]` (resolve notations via the Iconclass server).
- `get_artwork_details` → `attributionMarks` reports the *count* of signature/inscription marks on a work (presence only — the harvested rows carry no transcribed text and their carrier URIs do not resolve); use `parsedInscriptions` / `search_inscriptions` for what is actually written. For the full forensics record (technical examinations + restoration treatments + that mark count + a provenance excerpt), use `get_conservation_history`.
- When citing a creator from a result, preserve any qualifier prefix exactly as the result returned it ("attributed to Claes van Beresteyn", "workshop of Rembrandt", "after Rembrandt van Rijn"). The formatter injects these prefixes deliberately; stripping them in summary text misrepresents the catalogue's attribution position.
- When presenting multiple works, lead with the most significant first (the default importance ranking handles this for vocabulary queries).
- For image inspection findings, distinguish explicitly between what the structured metadata says and what the AI reads directly from the image — the distinction matters for research rigour.

---

## Critical Parameter Distinctions

### `subject` vs `iconclass`

- `subject`: morphological stemming against the subject vocabulary (Iconclass-aligned classifications and depicted-subject labels — a six-figure pool of bilingual terms; English coverage is strongest); best first pass; try natural phrases ("winter landscape", "vanitas", "civic guard")
- `iconclass`: the Iconclass classification system — a large notation set across 13 languages. A retrieval tool, not a descriptive language: a notation's meaning comes from its position in the hierarchy, not just its label. Use the **Iconclass server** (`search`, `browse`, `resolve`, `expand_keys`, `search_prefix`, `find_artworks`) to discover notation codes by keyword, concept, or hierarchy navigation — see its SKILL file for full workflows and query patterns. Each `search` result's `collections` array lists which loaded collections hold artworks for that notation — a presence signal, not a count; for exact per-collection artwork counts, hand the notation to `find_artworks`. Pass the code to `search_artwork`'s `iconclass` parameter for precise filtering.

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

### `heightRange` / `widthRange` / `sort` — string-form bounds and ordering on `search_artwork`

- `heightRange` / `widthRange`: `"10-50"` (between, cm), `"10-"` (≥ 10), `"-50"` (≤ 50). 0.0 sentinels treated as NULL.
- `sort`: `"column"` (default desc) or `"column:asc"`/`"column:desc"`. Columns: `height`, `width`, `dateEarliest`, `dateLatest`, `recordModified`. Cannot stand alone — needs at least one substantive filter.

### `attributionQualifier` + `productionRole` + `creator` — defaults, user phrasings, and known limits

The three attribution-scoping filters (`attributionQualifier`, `productionRole`, `sameRowMatching`) are available on **both `search_artwork` and `collection_stats`** with identical semantics — same-row enforcement against the row-aware tables. The patterns below apply to either tool: use `search_artwork` when you want the matching artwork records, `collection_stats` when you want an aggregate breakdown of that same set.

**Default attribution scope for named-artist queries.** For vague queries about a named artist's work ("show me Rembrandts", "Rembrandt's paintings"), narrow with `creator: "X"` + `productionRole: "<making-role>"` + `sameRowMatching: true` (plus `type` if known). Making-role values: `"painter"` for paintings, `"draughtsman"` for drawings, `"print maker"` for prints (the canonical label has a space — not `"printmaker"` or `"etcher"`). Without `sameRowMatching: true`, the role filter matches independently of the creator, and reproductive prints/photographs catalogued under the master's name surface alongside autograph works. Tell the user which production-role scope you applied so they can widen it explicitly.

**`creator + attributionQualifier` enforces same-row matching automatically** for the 10 non-priority qualifiers (`after`, `attributed to`, `workshop of`, `circle of`, `manner of`, `follower of`, `copyist of`, `possibly`, `free-form`, `falsification`). A work matches only when the named creator's *own* production row carries the qualifier, so `creator: "Rembrandt van Rijn" + attributionQualifier: "follower of"` returns just the follower-of-Rembrandt subset (not all follower-of-anyone works). The three priority-level qualifiers (`primary`, `secondary`, `undetermined`) are an exception — they're row-level priority markers, not attributions, so the server emits a warning and falls back to artwork-level (independent) matching when combined with `creator`. For autograph queries, use `productionRole + sameRowMatching: true` (above) rather than `attributionQualifier: "primary"`. **For the user phrasing "after X", prefer the `productionRole` row in the table below**: `attributionQualifier: "after"` also catches works where X is both source and maker (e.g. autograph etchings after the artist's own design), which inflates "by someone else after X" counts.

**Mapping user phrasings to filters.** Common English phrasings map to the catalogue's controlled vocabulary as follows. The working approach lives in the second column.


| User phrasing                                          | Catalogue filter (the one that actually narrows)                                                                                |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| "X's own paintings"                                    | `creator: "X"` + `productionRole: "painter"` + `sameRowMatching: true` + `type: "painting"`                                     |
| "X's own drawings"                                     | `creator: "X"` + `productionRole: "draughtsman"` + `sameRowMatching: true` + `type: "drawing"`                                  |
| "X's own etchings" / "X's own prints"                  | `creator: "X"` + `productionRole: "print maker"` + `sameRowMatching: true` + `type: "print"` (canonical label is `print maker` with a space, not `etcher` or `printmaker`) |
| "after X" / "reproductions of X" / "copies of X"       | `productionRole: "after painting by"` (or `"after print by"` / `"after drawing by"`) + `creator: "X"` — *no* `sameRowMatching` (X is the source, not the maker) |
| "attributed to X" / "possibly by X"                    | `attributionQualifier: "attributed to"` (or `"possibly"`) + `creator: "X"` — same-row enforced automatically                    |
| "workshop of X" / "studio of X"                        | `attributionQualifier: "workshop of"` + `creator: "X"`                                                                          |
| "follower of X" / "circle of X" / "school of X"        | corresponding `attributionQualifier` value + `creator: "X"`                                                                     |
| "in the style of X" / "in the manner of X"             | `attributionQualifier: "manner of"` + `creator: "X"` (precise), or `aboutActor: "X"` (broader, cross-language)                  |
| "all 'follower of' / 'workshop of' works (any source artist)" | corresponding `attributionQualifier` value **alone**, no `creator` — returns the full collection-wide set |
| "inspired by X" (ambiguous)                            | Ask the user — could mean `manner of`, `after`, or `follower of`                                                                |


**Array on `productionRole` is AND-combined, not OR.** Passing `productionRole: ["after painting by", "after print by", "after drawing by"]` returns artworks carrying *all three* roles (often 0-3 matches), not the union. To collect a union of reproductive roles, issue separate calls and merge client-side.

**Two adjacent reproductive roles exist.** Besides the three medium-specific `after X by` roles, the catalogue also uses `after design by` (other-reproductive, generic non-medium-specific) and `after own design by` (**self-reproductive** — the creator made the work after their own design, so they are both source and maker; a common pattern for autograph etchings after the artist's own preparatory drawing). For the user phrasing "by someone else after X", exclude `after own design by` — those works are autograph and belong with X's own œuvre, not with reproductive works by others. Pull in `after design by` only if you also want non-medium-specific reproductions.

**Scope qualifier filters to a specific source artist by combining with `creator`.** Standalone, `attributionQualifier: "follower of"` returns every follower-of-anyone work in the collection. Combined with `creator: "X"`, it returns just the follower-of-X subset — the source artist is recorded on the same production row as the qualifier (and the same-row fix surfaces that linkage), even though the work's display `creator` field is typically `Unknown [painter]` or `anonymous`.

**Canonical name form matters.** The Rijksmuseum catalogue uses historical Dutch/Latin spellings for some artists. Bosch is catalogued as **"Jheronimus Bosch"**, not "Hieronymus Bosch". Always check `get_artwork_details` on a known work to confirm the canonical form before filtering.

### `creator` vs `aboutActor` vs `depictedPerson`

Three person-search axes, used for different questions: `creator` (who made it), `depictedPerson` (who is shown in it — strict, depicted only), `aboutActor` (broader cross-field — depicted *or* creator, tolerant of cross-language variants like "Louis XIV" → "Lodewijk XIV"). See each parameter's description for matching rules.

**`creator` accepts a name string or a `vocabId` from `search_persons`.** When you have the `vocabId`, pass it: it resolves to exactly that one person, whereas a name string matches every artist sharing it — distinct artists often share a name (e.g. several "Frans van Mieris"), so a name can silently merge their œuvres while the `vocabId` returns only the person you selected.

**Demographic cohorts require a two-step pattern** — `search_persons` → one `search_artwork(creator=<vocabId>)` per person, unioned client-side (a `creator` array is AND-combined, not a cohort). See Key Workflow §9 for the full recipe and coverage caveats.

### Title language coverage — the catalogue is mostly Dutch

The Rijksmuseum has translated only **a small minority of artwork titles into English** — most works have Dutch titles only, typically medals, coins, prints, decorative arts, and other minor objects. Famous paintings and curatorially-prominent works almost always have both languages; the long tail does not.

**Implications for research:**

- **Result presentation**: when reporting results to the user, use whatever title language exists rather than insisting on English. For an 18th-century medal, "Wilhelmina Koningin der Nederlanden" *is* the canonical title — there is no English version, and inventing one would misrepresent the catalogue.
- **Ranking**: title BM25 scores are computed across both languages, so an English title query against a Dutch-only object scores zero on title (but the object may still surface via `description`, `subject`, `iconclass`, or `semantic_search`, all of which have stronger English coverage).
- **`get_artwork_details` returns the full set of title variants** with language and qualifier (Dutch/English × brief/full/display/former). When reporting a work, prefer the variant whose language matches the user's query — the field exposes language per variant so this is straightforward.

### `search_provenance`: two query layers

`search_provenance` has two data layers that answer fundamentally different questions.

- `layer: "events"` (default): individual transactions — each with a date, location, price, parties (with roles and positions), and transfer type. Think of it as a ledger of *what happened*. Events-only parameters: `transferType`, `excludeTransferType`, `hasPrice`, `currency`, `hasGap`, `relatedTo`, `categoryMethod`, `positionMethod`.
- `layer: "periods"`: interpreted ownership spans — who held the work, how they acquired it, and for how long. Think of it as a timeline of *who owned what*. Periods-only parameters: `ownerName`, `acquisitionMethod`, `periodLocation`, `minDuration`, `maxDuration`, `sortBy: "duration"`. Use `periodLocation` (period-level, ~45% populated) in preference to event-level `location` when scoping a periods-layer query — they AND-combine when both are supplied.

Shared parameters work on both layers: `party`, `location`, `creator`, `dateFrom`/`dateTo`, `objectNumber`, `sortBy`, `offset`, `facets`.

**`dateFrom` / `dateTo` semantics differ by layer:**

- **Events**: filters on the event's `date_year` — "something happened between these years"
- **Periods**: `dateFrom` filters on `begin_year`, `dateTo` on `end_year` — "ownership that started after X AND ended before Y"

The periods interpretation is much more restrictive — `dateFrom=1933, dateTo=1945` on periods misses any ownership that started before 1933 or extended past 1945. **For date-range queries (especially wartime provenance), prefer the events layer.**

**Anti-join pattern** (`transferType` + `excludeTransferType`): artwork-level set difference. `transferType: "confiscation", excludeTransferType: "restitution"` returns artworks that were confiscated but *never* restituted. Note: items *recuperated* (recovered by Allied forces) are not the same as items *restituted* (formally returned to original owners) — they will appear in anti-join results.

**Filter requirement**: both layers reject bare queries. At least one content filter is required. If you need a collection-wide ranking, use a broad filter such as `dateFrom: 1400` as a catch-all.

**`creditLineQuery` — unstructured credit-line fallback.** Parsed provenance covers only a small share of the catalogue; the raw credit-line field ("Gift of …", "Bequest of …", "Purchased with the support of the … Fonds") covers much more. When a structured query is empty or thin, extend it with `creditLineQuery` — a free-text, tokenized-AND search restricted to works with *no* parsed provenance (so no overlap, no dedup). It is a standalone mode: other filters are ignored, and matches return in `creditLineResults`, **not** `results`. Treat them as lower-confidence — credit lines record how the *museum* acquired the work, not prior ownership — so tell the user the answer is from unstructured credit-line text. **Expectation-setting:** credit lines are highly boilerplate — many thousands of distinct bilingual (Dutch | English) funding/loan templates. Generic acquisition words ("purchase", "gift", "loan", "Fonds", "bequest") return huge, undifferentiated result sets; match instead on a *distinctive* donor/fund/society name (e.g. "Waller-Fonds", "Mondriaan Stichting"). Phrase/word-order nuance buys little — templated text, not prose.

For the full provenance data model — AAM text format, transfer type vocabulary, party roles and positions, date/currency representations, and tested query patterns — see `references/provenance-and-enrichment-patterns.md`.

### Full-text filters vs vocabulary filters (ranking matters)

Activating a text filter (`query`, `description`, `inscription`, `curatorialNarrative`) switches ranking to BM25 relevance. Drop the text filter to fall back to importance ranking — useful when you want the most *significant* works to surface first.

**`textQuery` — structured boolean/phrase/proximity/prefix text search.** The flat text filters above each match one field and are AND-combined, and the text you pass is treated as a single literal phrase. When that is not enough — you need either/or logic, an either/or *across* fields, words near each other, or a word-stem wildcard — use the opt-in `textQuery` object instead. It compiles into one relevance-ranked query over the four text fields. Use it sparingly: for the common case the flat filters are simpler.

Shape: `{ must?: Clause[], should?: Clause[], mustNot?: Clause[] }` — `must` is AND, `should` is an OR-group, `mustNot` excludes. At least one `must`/`should` clause is required (`mustNot` alone is rejected, since exclusion needs something to exclude *from*). Each `Clause` targets one `field` (omit for all four) and OR-combines whatever terms it carries:

- `phrase` — exact words in order
- `any` — a list of tokens, matched as OR
- `prefix` — a stem; matches the stem plus any continuation (so `sculp` also matches `sculptor`, `sculpsit`)
- `anyPrefix` — a list of stems, matched as OR
- `near` — `{ terms: [...], distance }` requires the terms within `distance` words of each other; a nested list inside `terms` offers alternatives at that position

`textQuery` combines freely with the structured filters (`type`, `creator`, `creationDate`, …). Example — a theme written up differently in each field, excluding history prints:

```
search_artwork(textQuery={
  should: [ { field: "description",        phrase: "beeldenstorm" },
            { field: "curatorialNarrative", any: ["iconoclasm", "iconoclastic"] } ],
  mustNot: [ { field: "title", phrase: "geschiedenis" } ]
})
```

If a `textQuery` is malformed (e.g. `mustNot` with no positive clause), it is dropped with a `warnings` note rather than failing the search.

### Inscriptions: `search_inscriptions` vs `search_artwork({inscription})`

The inscription field is best understood as a conservator's **mark-and-annotation log**, not a transcription of everything visible on the work. It is dominated by **verso collector's-mark stamps** (the print room's own mark and former-owner stamps make up a large share of all records); genuine artist-/image-applied text — signatures, captions, printers' addresses, dates — is a real but **minority** component. Each physical mark is usually recorded **twice**: a detailed Dutch form carrying placement and technique, and an English gloss. Coverage is **uneven by object type** — high for prints and drawings, low for coins, medals, and posters that are *covered in* legend text never entered here. **An empty `transcribedText` does not mean the object bears no text.**

Two tools touch this field:

- `search_artwork({inscription})` is a raw BM25 full-text match over the whole inscription blob (marks included) — good for a quick keyword sweep.
- `search_inscriptions` parses the field at query time and adds structure: filter by `inscriptionType` (collector's mark / signature / inscription / number / …), `placement` (recto/verso), `technique` (stamped / handwritten / printed / …), or `collectorMark` (a Lugt number); match `transcribedText` against the quoted on-object strings only; strip ownership-stamp boilerplate with `excludeCollectorMarkOnly` or `hasTranscribedText`. Results carry `matchedInscriptions` (the matching segments, with the Dutch/English gloss merged) so you can see exactly why a work matched. Facets combine **within a single mark** (a handwritten signature on the recto must be one segment, not three coincidental ones).

`search_inscriptions` parses candidates at runtime, so it needs **at least one narrowing filter**, and a single broad facet (e.g. `inscriptionType: "collector's mark"`, roughly half the corpus) returns a **partial** result (`candidatesCapped: true`) — add a narrowing term. For a single work, `get_artwork_details` already returns `parsedInscriptions` (lossless, per-segment) and an `inscriptionSummary` rollup (`hasTranscribedText`, `hasCollectorMarkOnly`, collector marks, types) — use these to tell "object bears text" from "verso collector stamp" at a glance.

### Object-number filtering and series exploration

`search_artwork({objectNumber})` matches the stable identifier exactly by default (`"SK-C-5"` → The Night Watch). Wildcards turn it into a series browser: `*` matches any run of characters, `?` matches a single one — `"SK-C-5*"` for the Night Watch group, `"RP-P-1906-*"` for one year's print acquisitions, `"BK-NM-*"`. Matching is **case-sensitive** (object numbers are predominantly uppercase, with a few lowercase suffixes like `bis`), and a wildcard pattern needs at least two literal characters (a near-bare `"*"` is rejected with a warning). Combine it freely with content filters — e.g. `objectNumber="RP-P-1906-*"` with `type="print"`.

---

## Modifier Parameters (cannot stand alone)

These narrow results but **require at least one other content filter**:


| Modifier                           | Notes                                                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `imageAvailable`                   | `true` = only digitised works (with a IIIF image); `false` = only works *without* one (un-photographed works on paper, digitisation backlog). Always pair with a content filter. |
| `hasProvenance: true`              | Restricts to the subset of artworks with parsed provenance. Pair with `type`, `creator`, etc. for cross-domain queries.                    |
| `expandPlaceHierarchy: true`       | Expands place filters 3 levels deep; pair with `productionPlace` etc.                                                                      |


---

## Key Workflows

### 1. Scope Before You Browse

For any counting, distributional, or comparative question, **start with `collection_stats`** — it answers in one call what would otherwise require multiple `compact: true` loops.

```
# Example: everything tagged "Rembrandt van Rijn" across media — one call
collection_stats(dimension="type", creator="Rembrandt van Rijn")
# → full type distribution. Note: the `creator` filter matches anyone named
# on a production row, so reproductive 19th-c. prints and photographs
# catalogued under the master's name surface alongside autograph works.

# Autograph-only narrowing — same-row matching via the row-aware tables.
# Mirrors search_artwork's productionRole + sameRowMatching pattern.
collection_stats(dimension="type", creator="Rembrandt van Rijn",
                 productionRole="print maker", sameRowMatching=true)
# → only works where 'print maker' sits on Rembrandt's own production row,
# excluding reproductive prints whose actual maker is someone else.

# Connoisseurship subset — attributionQualifier auto-enforces same-row.
collection_stats(dimension="type", creator="Rembrandt van Rijn",
                 attributionQualifier="workshop of")
# → only works where 'workshop of' sits on Rembrandt's row, not on any
# other creator's row of the same artwork. Same auto-same-row applies to
# the 10 non-priority qualifiers (after, attributed to, circle of, etc.).

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
| Artwork    | `type`, `material`, `technique`, `creator`, `depictedPerson`, `depictedPlace`, `productionPlace`, `placeType`, `sourceType`, `theme`, `exhibition`, `century`, `decade`, `decadeModified`, `height`, `width`            |
| Creator    | `productionRole`, `profession`, `gender`, `creatorBirthDecade`, `creatorBirthCentury`, `birthPlace`, `deathPlace`                                                                                                       |
| Provenance | `transferType`, `transferCategory`, `provenanceDecade`, `provenanceLocation`, `party`, `partyPosition`, `partyRole`, `currency`, `categoryMethod`, `positionMethod`, `parseMethod`                                       |


`decadeModified` is clamped to 1990–2030; records modified outside that window land in the coverage residual rather than a bucket. Pass `sortBy: "count"` to flip ordinal dimensions (`decade`, `height`, `width`, etc.) from natural-order to most-populous-first.

The **Creator** dimensions bucket each artwork by its maker's enriched person record (`gender` → male/female/unknown; `creatorBirthDecade`/`creatorBirthCentury` by birth year). They count artworks, not persons — a multi-creator work counts under each maker, and works whose creator has no enriched person record fall in the coverage residual; treat the result as a distribution of *works*, not a census of artists. `placeType` buckets by the kind of place a work was made or depicts (city / region / nation, resolved to human labels). Most of these names also work as **filters** (e.g. `dimension="type", gender="female"` or `placeType="nations"`). A parallel family of presence filters narrows any breakdown to works that carry a given attribute: `hasInscription`, `hasNarrative`, `hasDimensions`, `hasExhibitions`, `hasExternalIds`, `hasParent`, `hasExaminations`, `hasModifications`, `hasWikidataCreator`, `hasAltNames`, plus the event flags `uncertain`, `unsold`, `gap`, `crossRef`.

Filters from both domains combine freely; one call replaces N iterations. An aggregate **gender** (or `profession` / `creatorBirthCentury` / `birthPlace` / `deathPlace`) breakdown is now a single `collection_stats(dimension="gender")` call (see the Creator-dimension note above). To list the actual *works* by a demographic cohort you still need the two-step `search_persons` → `search_artwork(creator=<vocabId>)` pattern (§9) — `search_artwork` has no demographic filters, and `creator` takes a single vocab ID (an array is AND-combined, not a cohort).

### 2. Iconclass Research

Never pass iconographic concepts as free text to `search_artwork(iconclass=...)` —  
it expects exact notation codes. Use the **Rijksmuseum Iconclass MCP server** to discover codes first (see its SKILL file for full discovery workflows, FTS query patterns, hierarchy navigation, and cross-branch strategies).

**Quick reference — Iconclass server tools:**

- `search(query=...)` — keyword lookup ("crucifixion" → `73D6`)
- `search(semanticQuery=...)` — concept search ("domestic animals" → `34B1`)
- `browse(notation=...)` — hierarchy navigation (children, cross-refs, path)
- `resolve(notation=[...])` — batch lookup of known codes
- `expand_keys` / `search_prefix` — key variants and subtree enumeration
- `find_artworks(notation=...)` — exact per-collection artwork counts + link-outs (the count-check handoff)

**Before handing off**, gauge curatorial depth: each `search` result's `collections` array tells you *which* loaded collections have artworks for a notation (presence only — an empty array means none). For the exact figure — whether a code is backed by 2,000 artworks or 3 — pass the notation to `find_artworks`. **Never truncate Iconclass discovery queries** — use the default `maxResults` (25) or higher so you can evaluate all returned notations before deciding which codes to hand off.

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

**Filter specificity matters.** Very broad single filters (e.g. `type: "print"` alone, or `material: "paper"`) exceed the internal candidate limit, so semantic ranking operates on a subset. Results are still high-quality (distances are near-optimal), but a different subset might surface equally-good alternatives. For best coverage, combine two or more filters or pair a broad filter with a specific one (e.g. `type: "print", subject: "landscape"`).

**Language note**: English queries yield slightly higher precision against the
bilingual catalogue even though the embedding model is multilingual. If a Dutch
or German query returns unexpected results, reformulate in English.

### 5. Image Inspection and Overlay Placement

When the user wants a region examined, an inscription or signature read, or a labelled overlay placed on the open viewer, follow the pixel-geometry recipe: `inspect_artwork_image` at a tight `pct:` crop → place the overlay in crop-local `crop_pixels:` via `navigate_viewer`'s `relativeTo`/`relativeToSize` → verify with `show_overlays`. Two tools, different audiences — `get_artwork_image` opens the viewer for the **user**; `inspect_artwork_image` returns bytes for the **model** (and auto-zooms the open viewer to whatever you inspect). Full recipe — edge-snapping, magnify-before-measuring, the `full`-clamp gotcha, and verification — in [`references/specialist-workflows.md`](references/specialist-workflows.md#5-image-inspection-and-overlay-placement).

### 6. Provenance and Acquisition Research

Work in three levels — **scope/profile** (`search_provenance` + `facets:true`; also the route for credit-line / donor / fund queries like "Drucker-Fraser" or "Vereniging Rembrandt"), **structured chain analysis** (filters → parsed chains with dates, prices, transfer types, periods), **single-object deep dive** (`objectNumber` → then `get_artwork_details`). Bridge to the catalogue with `hasProvenance:true` on `search_artwork` / `collection_stats`. When results carry LLM-enriched records, **always surface the review URL to the user.** The data model (AAM format, transfer/role/currency vocabularies), enrichment methodology, pagination, and tested query patterns (collector profiling, wartime provenance, price history, time series) are in [`references/provenance-and-enrichment-patterns.md`](references/provenance-and-enrichment-patterns.md).

### 7. Source–Copy and Related-Object Navigation

To reach a work's peers, copies, sources, pendants, components, or frames, three paths: (1) read `find_similar`'s **Related Variant** + **Related Object** columns (most direct); (2) `get_artwork_details` → `relatedObjects[]` (three creator-invariant edges: `different example`, `production stadia`, `pendant`) and `physicalRelations[]` (frame/pedestal companions); (3) when curator-declared edges are absent, trace reproductive prints via `productionRole="after painting by"` + `creator`. Worked recipe (URI-vs-objectNumber resolution, the reproductive-print chain to its painted source): [`references/specialist-workflows.md`](references/specialist-workflows.md#7-sourcecopy-and-related-object-navigation).

### 8. Collection Depth Assessment

For grant applications or scoping a research site, profile depth in one pass: `collection_stats` (`creator` + `decade` dimensions) for breadth and temporal spread, `list_curated_sets`/`browse_set` for curatorial groupings, and a small `search_artwork` sample for close inspection. Worked sequence: [`references/specialist-workflows.md`](references/specialist-workflows.md#8-collection-depth-assessment).

### 9. Gender and Demographic Analysis

For an **aggregate** breakdown, `collection_stats` carries the demographic dimensions directly (`gender`, `profession`, `creatorBirthDecade`/`creatorBirthCentury`, `birthPlace`, `deathPlace` — each also usable as a filter, e.g. `dimension="type", gender="female"`); these count *works* by their maker's enriched record, not artists. For the **actual works** by a cohort, use the two-step `search_persons` → one `search_artwork(creator=<vocabId>)` **per person**, unioned client-side. Two traps to know inline: a `creator` array is AND-combined — joint authorship, usually 0 — **not** a cohort; and demographic filters (`gender`, `bornAfter`, `bornBefore`) return **zero rows** without person-enrichment on the DB. Full recipe, structural-filter leakage on multi-creator works, and the `unused:true` orphan-finder: [`references/specialist-workflows.md`](references/specialist-workflows.md#9-gender-and-demographic-analysis).

### 10. Similarity Research

`find_similar(objectNumber)` renders an HTML comparison page across 9 channels plus a Pooled column (only `objectNumber` + `maxResults`, default 20 / max 50 per channel; no `signal` parameter). **Behavioural rule: surface the URL/path to the user — do not fetch, summarise, or paraphrase the page.** For which channel answers which question, see [`references/find-similar-channels.md`](references/find-similar-channels.md).

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
| `creator: "Name"` returns more works than expected                     | A name string matches every artist sharing it (distinct artists often share a name). Resolve the person via `search_persons` and pass its `vocabId` to `creator` instead — it resolves to exactly that one person.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `search_persons` returns 0 rows for a demographic filter               | The `gender`, `bornAfter`, `bornBefore` filters require person enrichment to be present on the vocab DB. On a fresh harvest without enrichment they return zero rows — name-token matching and structural filters (`birthPlace`, `deathPlace`, `profession`) still work.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `relatedObjects` field on `get_artwork_details`                        | See workflow §7 — scoped to 3 creator-invariant relationships; pairs/sets/recto-verso/reproductions live on `find_similar`'s Related Object column.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Multi-folio works dominate results (sketchbooks, albums, print series) | The Rijksmuseum catalogues sketchbooks/albums/print-series as a parent record plus child records per folio, so a single physical object can fill the first page of results. Use `groupBy: "parent"` on `search_artwork` to collapse children whose parent is also in the result set (the parent gains a `groupedChildCount`). When `groupBy` isn't set, the response's `warnings` field flags clustering (e.g. "8 results are folios/components of BI-1898-1748A"). Affects ~4.6% of artworks (object numbers with parenthetical suffixes).                                                                                                                                                        |

