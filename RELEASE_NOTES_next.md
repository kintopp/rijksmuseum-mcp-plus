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
signatures, and the text written on the object itself — both as a new search tool and
within a work's full details.

<!-- TODO at release time: confirm harvest status and fold into the Databases section. -->

### Inscriptions

- **Search the collection by what is inscribed on a work.** A new search finds works
  bearing a particular collector's mark (by its Lugt catalogue number), a signature, a
  date, or any text transcribed from the work itself. Searches can be narrowed by where a
  mark sits (front or back) and how it was made (stamped, handwritten, engraved, and so
  on), and can set aside the former-owner and collection stamps that dominate the catalogue
  to surface only works carrying genuine inscribed text.
- **Inscriptions are now parsed on a work's detail view.** Opening a work's full details
  breaks its raw inscription notes into individual marks and transcriptions, with a short
  summary that distinguishes text actually written on the work from ownership-stamp
  boilerplate. Each mark keeps both its Dutch catalogue form and its English reading.
- **Honest about coverage.** Inscription data is cataloguer-entered, not a transcription of
  everything visible — it leans heavily toward collector's-mark stamps, and an empty result
  does not mean a work bears no text. The new search and detail view surface this so the
  data is not over-read.

### Command line

- **Inscription search from the command line.** The new inscription search is available in
  the `rijks-mcp` command-line client, with the same collector-mark, transcribed-text, and
  facet filters as the assistant tool.

### Documentation

- Documented the new inscription search and parsed-inscription details in the technical
  guide, and corrected the description of place-coordinate provenance to reflect the
  authority-only policy now in force (coordinates are kept only where a museum-supplied
  authority identifier resolves them).

### Databases

- The new inscription search and parsing run at query time over the existing catalogue
  text — no new data or index is required for them.
