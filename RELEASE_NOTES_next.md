<!--
Provisional release notes for the next decade-step release (likely v0.70).
Not committed to main — at release time, rename to RELEASE_NOTES_v0.70.md and pass to
`gh release create --notes-file`, then drop it in post-release housekeeping (see the
v0.24 precedent).

This is a running stub: it captures the user-facing changes that landed AFTER the
v0.60 tag (2026-06-09). Add to it as further work lands.
-->

## v0.70 (draft)

Structured search and parsing for the inscriptions on a work — collector's marks,
signatures, and the text written on the object itself, both as a new search and within a
work's full details — together with the ability to look up works by their object number
(whole series at once) and to run many command-line searches in a single batch.

<!-- TODO at release time: confirm harvest status and fold into the Databases section. -->

### Inscriptions

- **Search the collection by what is inscribed on a work.** A new search finds works
  bearing a particular collector's mark (by its Lugt catalogue number), a signature, a
  date, or any text transcribed from the work itself. Searches can be narrowed by where a
  mark sits (front or back) and how it was made (stamped, handwritten, engraved, and so
  on — in English or the Dutch catalogue terms), and can set aside the former-owner and
  collection stamps that dominate the catalogue to surface only works carrying genuine
  inscribed text.
- **Inscriptions are now parsed on a work's detail view.** Opening a work's full details
  breaks its raw inscription notes into individual marks and transcriptions, with a short
  summary that distinguishes text actually written on the work from ownership-stamp
  boilerplate. Each mark keeps both its Dutch catalogue form and its English reading.
- **Honest about coverage.** Inscription data is cataloguer-entered, not a transcription of
  everything visible — it leans heavily toward collector's-mark stamps, and an empty result
  does not mean a work bears no text. The new search and detail view surface this so the
  data is not over-read.

### Search

- **Look up works by object number, including whole series.** You can now find a work
  directly by its object number — for example the Night Watch, `SK-C-5` — and use simple
  wildcard patterns to gather a whole series in one search, such as all of a given year's
  print acquisitions. This makes it easy to pull together a related group without knowing
  each individual number.

### Command line

- **Inscription search from the command line.** The new inscription search is available in
  the `rijks-mcp` command-line client, with the same collector-mark, transcribed-text, and
  facet filters as the assistant tool.
- **Run many searches in one batch.** The `rijks-mcp` client can now read a list of
  queries — one per line — and run them all in a single pass, returning the results in
  order. This suits feeding a column of names, object numbers, or search terms through the
  same search and collecting everything for a spreadsheet or data pipeline.

### Documentation

- Documented the new inscription search and parsed-inscription details in the technical
  guide, rewrote the structured-text-search guide for a researcher and curator audience,
  and corrected the description of place-coordinate provenance to reflect the
  authority-only policy now in force (coordinates are kept only where a museum-supplied
  authority identifier resolves them).

### Databases

- The new inscription search and parsing — and the new object-number search — run at query
  time over the catalogue text and identifiers already present, so no new data or index is
  required for them.
