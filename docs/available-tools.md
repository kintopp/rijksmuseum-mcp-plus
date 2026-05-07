# rijksmuseum-mcp-plus tools

## Decision: which tool?

| Question | Tool |
|---|---|
| Specific filters (subject, material, dates, place, person, theme, …)? | `search_artwork` |
| Free-text concept query? | `semantic_search` |
| Artwork-to-artwork similarity? | `find_similar` |
| Demographic person query (gender, born, profession, birth/death place)? | `search_persons` → `search_artwork({creator: <vocabId>})` |
| Provenance / ownership history? | `search_provenance` |
| Single artwork's full metadata? | `get_artwork_details` |
| Open the deep-zoom viewer (user-facing)? | `get_artwork_image` |
| Get image bytes for LLM visual analysis? | `inspect_artwork_image` |
| Aggregate counts, distributions, cross-tabs? | `collection_stats` |
| Discover curated sets? | `list_curated_sets` |
| Enumerate set members? | `browse_set` |
| What changed since YYYY-MM-DD? | `get_recent_changes` (OAI delta) or `search_artwork({modifiedAfter: …})` (static filter) |

## Search & Discovery

- **`search_artwork`** — Filter the collection by structured criteria (subject, material, technique, dates, place, person, theme, …). Combinable filters; AND semantics on arrays.
- **`semantic_search`** — Find artworks by meaning, concept, or theme using natural language. Ranked by Dutch-description embedding similarity.
- **`search_persons`** — Find persons (artists, depicted figures, donors) by demographic (gender, born/died) or structural (birth/death place, profession) criteria. Two-step pattern: feed the returned vocab IDs into `search_artwork({creator: <vocabId>})`.
- **`collection_stats`** — Aggregate statistics, counts, and distributions across the collection.
- **`browse_set`** — DB-backed enumeration of artworks within a curated collection set.

## Artwork Details

- **`get_artwork_details`** — Full metadata for a specific artwork (by object number or Linked Art URI).
- **`get_artwork_image`** — High-resolution interactive deep-zoom viewer (with j/k/l navigation between related artworks).
- **`inspect_artwork_image`** — Fetch an artwork image (or region) as base64 for direct visual analysis by the LLM.

## Provenance

- **`search_provenance`** — Search ownership and provenance history across ~48K artworks with parsed records.

## Classification & Curation

- **`list_curated_sets`** — Discover curated sets (193 total) with member counts, dominant types/centuries, and a category heuristic.
- **`get_recent_changes`** — OAI-PMH delta semantics for tracking what changed since a known harvest checkpoint.

## Similarity

- **`find_similar`** — HTML comparison page across 9 independent similarity channels: Visual, Related Co-Production, Related Object, Lineage, Iconclass, Description, Theme, Depicted Person, Depicted Place + Pooled (feature-gated via `ENABLE_FIND_SIMILAR`; Theme channel further gated by `ENABLE_THEME_SIMILAR`).

## Viewer Navigation

- **`navigate_viewer`** — Navigate the open deep-zoom viewer to a specific region; add or clear labelled overlays.

---

*14 tools total (12 standard + 2 internal app tools). `find_similar` is feature-gated
via `ENABLE_FIND_SIMILAR` (default: true). `semantic_search` is
particularly powerful for humanities research — query conceptually rather than by keyword.
For Iconclass taxonomy navigation, prefer the dedicated [Iconclass MCP server](https://github.com/kintopp/rijksmuseum-iconclass-mcp).*
