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

This release brings the improved provenance (ownership-history) parsing to the catalogue
itself. The parser refinements that shipped in v0.70 but lay dormant are now applied to
the data, so a work's chain of past owners is segmented, classified and dated more
accurately — and the curatorial corrections layered on top are preserved when the
provenance is re-parsed.

### Provenance

- **More accurate ownership histories.** The provenance recorded for each work — its
  succession of owners, sales, gifts, bequests and loans — has been re-parsed end to end.
  Ownership steps that were previously run together, or split in the wrong place, are now
  separated more reliably; an event phrased only as "sold" is read as a sale rather than
  left unclassified; and date ranges are carried to their true first and last year instead
  of collapsing to a single point.
- **Curatorial refinements now survive re-parsing.** The hand-checked improvements to the
  provenance data — corrected event types, party roles, and events split apart or set
  aside as non-provenance — are now re-attached to the event that still carries the same
  text whenever the data is re-parsed, instead of being matched by position. In practice
  the curated layer stays correct as the underlying parser keeps improving.

### Performance and reliability

- **Steadier meaning-based search after a restart.** The model that powers semantic and
  description search is now kept on the server's data volume instead of being re-fetched on
  every restart, so meaning-based search returns reliably — and a little faster — after a
  deploy or restart.

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

TODO at release time:
  - Confirm whether a vocab harvest also ships in v0.80. If so, add a Databases section
    (artwork / vocabulary / mapping counts) and note the provenance re-parse rode it.
  - If v0.80 stays a no-harvest release, state that the catalogue is otherwise unchanged
    from v0.40 and only the provenance tables + the embedding-cache behaviour changed.
  - Decide whether the content-addressed enrichment store deserves its own short note or
    stays folded into "Curatorial refinements now survive re-parsing".
==================================================================================
-->
