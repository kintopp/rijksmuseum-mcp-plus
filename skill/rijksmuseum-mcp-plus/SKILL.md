---
name: rijksmuseum-mcp-plus
description: >
  Research workflows for the Rijksmuseum MCP+ server, addressing Dutch arts, crafts, and history across the museum's holdings. Capabilities include keyword, structured, and semantic text search, text-to-image search, AI-driven image analysis, geospatial queries, collection statistics, Iconclass-driven iconographic discovery, AAM/CMOA-aligned provenance, and image similarity research. Trigger on any question that could plausibly be answered from the Rijksmuseum's holdings — Golden Age Dutch and Flemish painting, prints and drawings, Asian export art, decorative arts and craft objects, photography, historical artefacts, ownership history, museum acquisitions — even when the user doesn't name the collection.
license: MIT
compatibility: Requires the rijksmuseum-mcp+ MCP server and network access.
metadata:
  version: "0.96.0"
  last_updated: "2026-10-31"
---

# Rijksmuseum MCP+ Research Skill

## Where the data comes from

The server answers from a snapshot of the Rijksmuseum's open data harvested in May 2026, not from the museum's live APIs. Records the museum has added, corrected or withdrawn since then are not reflected; `get_recent_changes` reads the live change feed, and the [collection website](https://www.rijksmuseum.nl/en/collection) is the current reference.

- **OAI-PMH** (`https://data.rijksmuseum.nl/oai`): one EDM metadata record per object, the backbone of the harvest.
- **Linked Art** (`https://id.rijksmuseum.nl/`): JSON-LD object records and vocabulary terms.
- **Data dumps** (`https://data.rijksmuseum.nl/dumps/`): person, group, place and concept authorities, the source of creator demographics and of links to Wikidata, VIAF, ULAN and RKD.

The museum publishes these under its [information and data policy](https://data.rijksmuseum.nl/policy/information-and-data-policy): CC0 1.0 or the Public Domain Mark, with CC BY 4.0 where it exercises its own copyright; it asks for a credit line either way. Each object's `license` field gives the rights for the work and its image: Public Domain Mark for most, In Copyright for roughly one work in eight, CC0 for a few.

This project enriched parts of the museum's data; the Rijksmuseum has not reviewed or endorsed any of it:
- **Provenance texts and credit lines**: parsed by a grammar into events, parties and ownership periods aligned with the AAM/CMOA standard. A few hundred ambiguous decisions out of many thousands were made by an LLM; these carry `categoryMethod`/`positionMethod`/`correctionMethod` flags, the model's reasoning, and a review page.
- **Inscription field**: split at query time, by rules, into individual marks, collector's marks and transcribed text.
- **Place authorities**: coordinates from Getty TGN (ODC-By 1.0), Wikidata (CC0) and GeoNames (CC BY 4.0), added only where a museum-supplied authority ID resolves them.
- **Production records**: each maker paired with their own role and attribution qualifier, which is what makes same-row attribution filters possible.
- **Titles, descriptions, inscriptions and curatorial narratives**: encoded together as one embedding per work, which `semantic_search` and `multimodal_search`'s metadata channel both rank. The Dutch descriptions are also encoded on their own for `find_similar`'s Description channel.
- **Images and Iconclass notations**: the photographs and the labels of the Iconclass notations used in the collection, encoded into the same image–text embedding space, so `multimodal_search` can rank a text query against what the pictures show. Subject terms are not part of the text either search matches.

Only images (IIIF, `iiif.micr.io`), `get_recent_changes` and `find_similar`'s Visual channel are fetched live, so an image can be current while its metadata is not.

## Working with the catalogue

Answer from the tools, not from memory: check attributions, dates, object numbers and counts against the catalogue even for famous works, because recollections of a collection are often wrong in exactly those details.

The tool descriptions already document every parameter and say which tool does what. This skill adds two things they don't: how the catalogue can mislead a careful reader, and a set of research moves to draw on. None of the moves is a required sequence. Good questions usually reward approaching the collection from more than one direction, and the routes that disagree with each other are often where the finding is.

## How the catalogue can mislead

**Absence is rarely evidence.**
- `get_artwork_details` → `attributionMarks.total: 0` does not mean unsigned. The mark rows and the inscription field are independent datasets: The Night Watch reports 0 marks yet carries "Rembrandt f 1642" in `parsedInscriptions`. Check `parsedInscriptions` before reporting that a work has no signature.
- `get_conservation_history` covers a small fraction of a percent of the collection, and famous paintings are not favoured (The Night Watch and The Milkmaid both return nothing). An empty result means no examination record was harvested, not that the work was never examined.
- The inscription field is a mark-and-annotation log dominated by verso collector's stamps, not a transcription of visible text. Coins, medals and posters covered in legends often have nothing entered. `placement` (recto/verso) is almost never recorded for paintings, so adding it zeroes a painting query.
- Parsed provenance exists for only about one artwork in sixteen. Credit lines reach much further but record how the *museum* acquired a work, not earlier ownership. They are templated boilerplate, so search them on distinctive donor or fund names, not words like "gift" or "purchase". A credit-line search (`creditLineQuery`) covers only works *without* parsed provenance, so a complete answer for a donor or fund needs it plus a `party` search of the parsed chains; the two sets do not overlap.

**Language and naming.**
- Most titles are Dutch only; English titles exist mainly for prominent works. Report the title that exists rather than inventing a translation. Descriptions are Dutch; curatorial narratives (far fewer) are English. Some vocabulary only matches in Dutch (`fotograaf`, `Tweede Wereldoorlog`, theme labels, curated-set names).
- A `creator` name matches every recorded variant of a person's name, in any order or historical spelling ("Vermeer, Johannes", "Hieronymus Bosch" for Jheronimus Bosch). It therefore also merges everyone who shares a variant: "Jan Vermeer" reaches Johannes Vermeer, Jan Vermeer van Haarlem and Jan van der Meer, and "Frans van Mieris" both generations. A warning lists the creators a name matched; a `vocabId` from `search_persons` names exactly one person. A zero for a named artist means the name was not recognised, not that the museum holds nothing by them; check it with `search_persons`.

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
- `multimodal_search`'s image channel sees only digitised works, and its matches are visual resemblance, not identification: an image-only hit for a named place may show any town that looks like it. Similarities are comparable only within one channel (image scores run lower than text scores), so rank within a channel, never across them. Like all embedding search it is weak on artist names and named periods; put those in its filters.

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
- **Follow the people.** Makers, sitters, copyists, owners, dealers and donors are separate indexes into the same objects. A painting's afterlife may be clearer through its copyist, its sitter's other portraits, or the collector who owned it than through the painting itself. Owners of prints and drawings also left collector's marks (Lugt numbers, via `search_inscriptions`); many are the print room's own stamp, but former owners' marks reach more than twice as many works as the parsed provenance covers, almost all of them outside it.
- **Follow the object outward.** Related and physical companions on the record, `find_similar`'s channels, prints made after it, works cited in the same publication, and other works in its provenance (`relatedTo`). Object numbers encode department and, for many objects, accession year, so a wildcard (`RP-P-1906-*`) can rebuild an acquisition batch.
- **Use counts as arguments.** A distribution can test a claim (when a motif rises and falls, which cities dominate a medium, who collected what) and turn an anecdote into a pattern, or show that it isn't one.
- **Search what the work shows.** For scenes, motifs and visual details ("children playing in the street", "a red umbrella"), `multimodal_search` runs one query through three channels at once: catalogue metadata, the images themselves, and the Iconclass notations nearest the query. Read the channels against each other. A work found by several is the strongest candidate. An image-only hit is often a depiction the catalogue never recorded, so look at it before claiming it. A metadata-only hit is described that way but may not show it prominently. The fused list can bury image-only discoveries; `channels: ["image"]` shows that channel's own ranking. When one of the returned `iconclassNotations` fits, `search_artwork` with that `iconclass` gives the complete tagged set rather than a ranked sample.
- **Look.** `inspect_artwork_image` can read what the catalogue never recorded: signatures, seals, cartouches, inscriptions, details in the background. Keep what the catalogue says separate from what you see in the image.
- **Read the negative space.** What is undigitised (`imageAvailable: false`), uncatalogued, missing from a provenance chain (`hasGap`), or orphaned in the authority files (`search_persons` `unused`) can be as telling as what is present.
- **Change the language.** Dutch terms, Iconclass notations (13 languages, from the Iconclass server) and English reformulations of semantic queries each reach different material. One concept can sit in several Iconclass branches (a dog as pet under `34B11`, as a symbol of fidelity under `11A(DOG)`).

## Presenting results

- Give the `objectNumber` for every work you discuss, linked to its Rijksmuseum page; cite the handle URI from `externalIds` when a persistent citation is needed.
- Separate three sources of statement: what the catalogue records, what you observed in an image, and what comes from your own background knowledge.
- For `multimodal_search` results, say which channels found each work, and present the candidates the channels agree on separately from those only the image or only the text supports.
- Pass on links the tools produce for the user: `find_similar` comparison pages and provenance review URLs. The user cannot see tool output, so these links are their only way to those pages.
- Say what scope your searches covered, especially when an answer rests on a sample rather than an exhaustive query.

## References

Load when the task needs them:
- [`references/provenance-and-enrichment-patterns.md`](references/provenance-and-enrichment-patterns.md) — the provenance data model (AAM text format, transfer and party vocabularies, dates, currencies, LLM-enrichment methods) and tested query patterns.
- [`references/find-similar-channels.md`](references/find-similar-channels.md) — what each `find_similar` channel matches on.
- [`references/specialist-workflows.md`](references/specialist-workflows.md) — image-inspection mechanics (cropping for detail, user highlights) and turning a demographic profile into a list of works.
