---
name: rijksmuseum-mcp-plus
description: >
  Research workflows for the Rijksmuseum MCP+ server, addressing Dutch arts, crafts, and history across the museum's holdings. Capabilities include keyword, structured, and semantic text search, AI-driven image analysis, geospatial queries, collection statistics, Iconclass-driven iconographic discovery, AAM/CMOA-aligned provenance, and image similarity research. Trigger on any question that could plausibly be answered from the Rijksmuseum's holdings — Golden Age Dutch and Flemish painting, prints and drawings, Asian export art, decorative arts and craft objects, photography, historical artefacts, ownership history, museum acquisitions — even when the user doesn't name the collection.
metadata:
  version: "0.95"
  last_updated: "2026-10-04"
---

# Rijksmuseum MCP+ Research Skill

Answer from the tools, not from memory: check attributions, dates, object numbers and counts against the catalogue even for famous works, because recollections of a collection are often wrong in exactly those details.

The tool descriptions already document every parameter and say which tool does what. This skill adds two things they don't: how the catalogue can mislead a careful reader, and a set of research moves to draw on. None of the moves is a required sequence. Good questions usually reward approaching the collection from more than one direction, and the routes that disagree with each other are often where the finding is.

## How the catalogue can mislead

**Absence is rarely evidence.**
- `get_artwork_details` → `attributionMarks: 0` does not mean unsigned. The mark rows and the inscription field are independent datasets: The Night Watch reports 0 marks yet carries "Rembrandt f 1642" in `parsedInscriptions`. Check `parsedInscriptions` before reporting that a work has no signature.
- `get_conservation_history` covers a small fraction of a percent of the collection, and famous paintings are not favoured (The Night Watch and The Milkmaid both return nothing). An empty result means no examination record was harvested, not that the work was never examined.
- The inscription field is a mark-and-annotation log dominated by verso collector's stamps, not a transcription of visible text. Coins, medals and posters covered in legends often have nothing entered. `placement` (recto/verso) is almost never recorded for paintings, so adding it zeroes a painting query.
- Parsed provenance exists for only about one artwork in sixteen. Credit lines reach much further but record how the *museum* acquired a work, not earlier ownership. They are templated boilerplate, so search them on distinctive donor or fund names, not words like "gift" or "purchase".

**Language and naming.**
- Most titles are Dutch only; English titles exist mainly for prominent works. Report the title that exists rather than inventing a translation. Descriptions are Dutch; curatorial narratives (far fewer) are English. Some vocabulary only matches in Dutch (`fotograaf`, `Tweede Wereldoorlog`, theme labels, curated-set names).
- Artists can be catalogued under historical forms ("Jheronimus Bosch"). A creator name string also merges every artist who shares it; a `vocabId` from `search_persons` names exactly one person.

**Attribution is layered.**
- `creator` alone matches anyone on any production row, so a master's name also pulls in prints and photographs made *after* them. Autograph scope means `creator` + a making `productionRole` + `sameRowMatching: true`. The making-role labels are `painter`, `draughtsman` and `print maker` (with a space). Tell the user which scope you applied.
- Keep the qualifier prefixes the results carry ("workshop of Rembrandt", "after Rembrandt van Rijn"). Stripping them misstates the catalogue's position.

**Counts are of works, under specific rules.**
- Creator-demographic dimensions in `collection_stats` (gender, birth cohort, profession, birth/death place) count *works* by their makers' records, not artists. Profession and birth/death place are artwork-level attributes, so on multi-creator prints they leak to every co-creator.
- `collection_stats` date bins use each work's earliest date, and `creationDateFrom/To` are strict: a work dated c. 1490–1510 falls outside a 1500–1800 window.
- Sketchbooks, albums and print series are catalogued as one parent plus a record per leaf, so one physical object can fill a results page.

**Place and similarity.**
- Many place coordinates are rounded to about 2 km, so a `nearPlace` radius below that cannot separate a landmark from its city.
- Prints and drawings outnumber paintings roughly 77:1, so unfiltered semantic results rarely surface the paintings; that gap is invisible in the returned list.

**Provenance semantics.**
- On the periods layer, `dateFrom`/`dateTo` bound the start and end of ownership, which is far stricter than the events layer's "something happened between these years". For wartime questions, the events layer is usually the right one.
- Recuperation (recovery by the Allies) is not restitution (return to the owner); a confiscated-but-not-restituted anti-join still contains recuperated works.
- `unsold` events are not transfers, and `batchPrice` totals cover several works; both distort price rankings.

## Mapping attribution language

| User says | Filters that express it |
| --- | --- |
| "X's own paintings / drawings / prints" | `creator` + `productionRole` `painter` / `draughtsman` / `print maker` + `sameRowMatching: true` (+ matching `type`) |
| "after X", "reproductions of X" | `creator` + `productionRole: "after painting by"` (or `after print by`, `after drawing by`, generic `after design by`), no `sameRowMatching`. `after own design by` marks X reproducing their own design, which is autograph. |
| "attributed to / possibly / workshop of / circle of / follower of / manner of X" | `creator` + the matching `attributionQualifier` (same-row is automatic) |
| the same, for any artist | the `attributionQualifier` alone |
| "inspired by X" | ambiguous between manner of, after and follower of: say which reading you took, or show more than one |

## Research moves

Draw on whichever of these fit, combine them, or ignore them.

- **Triangulate across independent corpora.** One concept can be reached through subject/Iconclass vocabulary, Dutch cataloguer descriptions, English curatorial narratives, inscriptions, provenance text and embedding search. Each was written by different people for different purposes; works found by one route but not another show where the cataloguing thinks differently.
- **Follow the people.** Makers, sitters, copyists, owners, dealers and donors are separate indexes into the same objects. A painting's afterlife may be clearer through its copyist, its sitter's other portraits, or the collector who owned it than through the painting itself.
- **Follow the object outward.** Related and physical companions on the record, `find_similar`'s channels, prints made after it, works cited in the same publication, and other works in its provenance (`relatedTo`).
- **Use counts as arguments.** A distribution can test a claim (when a motif rises and falls, which cities dominate a medium, who collected what) and turn an anecdote into a pattern, or show that it isn't one.
- **Look.** `inspect_artwork_image` can read what the catalogue never recorded: signatures, seals, cartouches, inscriptions, details in the background. Keep what the catalogue says separate from what you see in the image.
- **Read the negative space.** What is undigitised (`imageAvailable: false`), uncatalogued, missing from a provenance chain (`hasGap`), or orphaned in the authority files (`search_persons` `unused`) can be as telling as what is present.
- **Change the language.** Dutch terms, Iconclass notations (13 languages, from the Iconclass server) and English reformulations of semantic queries each reach different material. One concept can sit in several Iconclass branches (a dog as pet under `34B11`, as a symbol of fidelity under `11A(DOG)`).

## Presenting results

- Give the `objectNumber` for every work you discuss, linked to its Rijksmuseum page; cite the handle URI from `externalIds` when a persistent citation is needed.
- Separate three sources of statement: what the catalogue records, what you observed in an image, and what comes from your own background knowledge.
- Pass on links the tools produce for the user: `find_similar` comparison pages and provenance review URLs. The user cannot see tool output, so these links are their only way to those pages.
- Say what scope your searches covered, especially when an answer rests on a sample rather than an exhaustive query.

## References

Load when the task needs them:
- [`references/provenance-and-enrichment-patterns.md`](references/provenance-and-enrichment-patterns.md) — the provenance data model (AAM text format, transfer and party vocabularies, dates, currencies, LLM-enrichment methods) and tested query patterns.
- [`references/find-similar-channels.md`](references/find-similar-channels.md) — what each `find_similar` channel matches on.
- [`references/specialist-workflows.md`](references/specialist-workflows.md) — image-inspection mechanics (cropping for detail, user highlights) and turning a demographic profile into a list of works.
