<!--
Provisional release notes for the next decade-step release (v0.80).

Rolling stub — captures the user-facing changes that have landed AFTER the v0.70 tag
(2026-06-13). Add to it as further work lands. At release time: rename to
RELEASE_NOTES_v0.80.md, pass to `gh release create --notes-file`, then drop the stub in
post-release housekeeping (see the v0.70 / v0.24 precedent).

Style: researcher- and curator-facing prose, functional section titles, sectioned
bullets, ~60 lines. Keep issue/commit numbers OUT of the published text (private tracker)
— record them only in the "Source trail" comment at the foot of this file.
-->

## v0.80 (draft)

This release brings the improved provenance (ownership-history) parsing to the catalogue.
It allows a work's chain of past owners to be segmented, classified and dated more
accurately and preserves curatorial corrections when the provenance is re-parsed.
Alongside it, the release expands how the collection can be explored and searched.

### Provenance

- **More accurate ownership histories.** Ownership steps that were previously run together,
  or split in the wrong place, are now separated more reliably; an event phrased only as "sold"
  is read as a sale rather than left unclassified; and date ranges are carried to their true first
  and last year instead of collapsing to a single point.
- **Curatorial refinements now survive re-parsing.** The hand-checked improvements to the
  provenance data — corrected event types, party roles, and events split apart or set
  aside as non-provenance — are now re-attached to the event that still carries the same
  text whenever the data is re-parsed, instead of being matched by position. In practice
  the curated layer stays correct as the underlying parser keeps improving.
- **Clearer ownership transfers in results.** When you search ownership histories, each step now
  shows the direction of a transfer — who passed a work to whom — and points to the source in
  which it is recorded, so the buyer and the seller can be told apart at a glance.

### Exploring the collection

- **Many more ways to break down the collection.** The collection-statistics view can now
  group and count works by the role a maker played in producing them, by a maker's
  profession, gender, or birth decade or century, by where a maker was born or died, and by
  the role a party held in an ownership history — collector, buyer, heir, donor, and so on.
- **Finer filters on those counts.** The same breakdowns can be narrowed to works that carry
  an inscription, curatorial text, recorded dimensions, an exhibition history, external
  authority links, a parent series, or technical examination or restoration records; to works
  with a maker linked to Wikidata or shown in a named exhibition; and to those whose
  ownership events are flagged as uncertain, unsold, or a gap.

### Search and discovery

- **More complete search by place of production.** Searching for works made in a given place
  now draws on a fuller record of production places, surfacing a large body of works that the
  previous, narrower index had missed.
- **More places carry coordinates.** Several thousand additional places now hold authoritative
  coordinates taken from their Getty (TGN) identifiers, improving "near this place" and other
  place-based searches.
- **Listing unused maker names.** A search can now return the people in the name authority who
  are not linked to any work as a maker — a quick way to surface orphaned or duplicate entries
  for clean-up.
- **Leaner set and record listings.** A long, largely duplicated measurement block is no longer
  returned by default when browsing a set or fetching a record's details; it can be requested
  when it is actually needed.
- **Fuller work details.** A work's details now report its weight and depth where recorded — not
  only its height and width — and name the curated collections it belongs to, such as a highlights
  or public-domain set.

### Performance and reliability

- **Compatible with a wider range of applications.** Some applications and AI-assistants can only read
  the short reply a tool returns, not the fuller, structured data (JSON) that accompanies it. The server can
  now give these applications the complete result so they no longer miss important details.

<!--
========================= Source trail (maintainer-only) =========================
Remove or fold into a Databases section at release time.

Provenance re-parse — deployed 2026-06-14 as the v0.80-content vocabulary.db (vocab-only
swap; embeddings unchanged from v0.70). It activates parser fixes that shipped DORMANT in
v0.70 and were deliberately left out of the v0.70 notes:
  - comma-splitter no longer toggles quote state on possessive apostrophes
    (Christie's / Sotheby's / d'Arc), which had under-split events            [d1674ea]
  - a bare "sold" is classified as a sale with no spurious party              [33d6ed3]
  - date ranges expand to true [start, end] period bounds                     [33d6ed3]
  - further provenance parsing fixes (advisor plans 010 / 014)               [33d6ed3]

Curatorial-refinement durability = the content-addressed enrichment store + the store-driven
re-parse cutover (so enrichments re-attach by event text, not by position):
  3c6df5b (store + tests), ee2f628 (Phase-2 structural), df4c7c4, 9a9813f, 7c00afe,
  a6a2ee8, 4951ddd, 12a0777, 1999503, a3f6301, fab7cb0, e1de78c, 26d3b61, c092d85.

Reliability — embedding model cache persisted to /data via env.cacheDir (from HF_HOME),
removing the per-boot HuggingFace fetch.                                       [9ad7bd8]

Compatibility — opt-in serialized-JSON text fallback for structuredContent (env
MCP_TEXT_JSON_COMPAT, OFF by default): tools returning structuredContent can also expose the
result as a second serialized-JSON TextContent block for generic / programmatic clients that parse
content[].text; two-tier size guard (per-copy cap + projected-total ceiling) keeps the copy under
the ~150K-char claude.ai/Desktop limit. Realigns with the spec's backwards-compat recommendation
(2025-11-25 server/tools: "a tool that returns structured content SHOULD also return the serialized
JSON in a TextContent block") — which this server otherwise deviates from by putting curator prose,
not JSON, in the primary text block. NOT for Claude (claude.ai/Desktop read the prose text, Claude
Code reads structuredContent). Runtime-only code; ships with the next code push, no DB
swap.                                                            [#402, merge cd619ae]

Compatibility rollout — wires the #402 helper into the nested-output tools where prose alone drops
a layer (json-text-compat-rollout plan): search_provenance events render party direction
(sender->receiver) + a citation src ref in prose; get_artwork_details prose adds weight/depth +
collection set labels; browse_set and get_recent_changes (full records only) set jsonText ON by
default; find_similar sends a TRIMMED, divergent text-channel digest via a new jsonTextData helper
option (seed + per-channel {total, top} capped to 72 candidates overall by rank-interleave +
pooled<=16) while structuredContent keeps full per-channel depth for the CLI — this digest IS aimed
at text-only LLM hosts (claude.ai/Desktop). Global MCP_TEXT_JSON_COMPAT default stays off; flat/
lossless tools untouched. Runtime-only; ships with the next code push, no DB swap.
                                                  [branch feat/json-text-compat-rollout, 54e5c1b]

Collection-exploration + search features — runtime-only code, merged to main (not yet pushed/
deployed at time of writing); ships with the next code push, no DB swap needed:
  - collection_stats: 9 new dimensions + many new filters — productionRole / profession /
    gender / creator birth decade+century / birth+death place / partyRole, the 10 has*
    presence predicates, an exhibition filter, parseMethod, and the unsold/uncertain/gap/
    cross-ref event flags. NOTE: a placeType dimension also ships but its bucket labels are
    raw AAT/Wikidata URIs (follow-up to map to names) — hence omitted from the body.  [#320, merge eccaf9d]
  - productionPlace search/stats now resolve the Linked-Art production_place field in
    addition to the OAI-PMH spatial field (~116K more works reachable)                 [#356, merge 2b3e273]
  - search_persons `unused` filter — persons with no creator mapping                   [#393, merge 2b3e273]
  - extentText dropped from browse_set / get_artwork_details default output, behind an
    opt-in flag (includeExtentText / verboseExtent)                                    [#381, merge 2b3e273]

Place coordinates — NULL-coord places carrying a Rijks-supplied Getty (TGN) id geocoded to the
deterministic tier (places: 20,923 -> 23,854 authority-coord; coverage ~56% -> ~64%). Code in
the RELEASE.md pre-publish chain; coords APPLIED to the LOCAL vocabulary.db 2026-06-15 but NOT
yet deployed — REQUIRES a vocab DB swap to ship (or rides the next harvest's pre-publish run).
Backup data/vocabulary.db.pre019-20260615; cache data/null-coord-rijks-tgn-coords.csv.  [#336, merge ec0fb0b]

Follow-up filed (not in this release): dedup the Rijks-dump TGN helpers across geocoding
scripts.                                                  [offline#404]

TODO at release time:
  - Confirm whether a vocab harvest also ships in v0.80. If so, add a Databases section
    (artwork / vocabulary / mapping counts) and note the provenance re-parse rode it.
  - If v0.80 stays a no-harvest release, state that the catalogue is otherwise unchanged
    from v0.40 and only the provenance tables + the embedding-cache behaviour changed.
  - Decide whether the content-addressed enrichment store deserves its own short note or
    stays folded into "Curatorial refinements now survive re-parsing".
  - Before publishing, confirm the [#336] place coordinates actually reached production (the
    vocab DB swap happened, or a harvest carried them). If still local-only, drop or reword
    the "More places carry coordinates" bullet.
  - Confirm the runtime collection-exploration + search features ([#320] / [#356] / [#393] /
    [#381]) were pushed/deployed; they need only a code push, not a DB swap.
  - Confirm the JSON-text fallback ([#402]) and its rollout into the result-heavy tools were
    pushed/deployed; code push only, no DB swap. The "Works with a wider range of applications"
    bullet covers a capability that is off by default for most tools but on for a few — keep that
    nuance if reworded.
==================================================================================
-->
