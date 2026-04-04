# rijksmuseum-mcp-plus tools

## Search & Discovery

- **`search_artwork`** — Search the collection by keyword, artist, period, medium, etc.
- **`semantic_search`** — Find artworks by meaning, concept, or theme using natural language
- **`collection_stats`** — Aggregate statistics, counts, and distributions across the collection
- **`browse_set`** — Browse artworks within a curated collection set

## Artwork Details

- **`get_artwork_details`** — Full metadata for a specific artwork (by object number or Linked Art URI)
- **`get_artwork_image`** — High-resolution interactive deep-zoom viewer
- **`inspect_artwork_image`** — Fetch an artwork image as base64 for direct visual analysis
- **`get_artwork_bibliography`** — Scholarly references and bibliography for a work

## Provenance

- **`search_provenance`** — Search ownership and provenance history across ~48K artworks with parsed provenance records

## Classification & Curation

- **`list_curated_sets`** — Browse curated exhibitions and scholarly groupings
- **`get_recent_changes`** — Track recent additions and modifications to the collection

## Similarity

- **`find_similar`** — Find artworks similar to a given artwork across multiple signals (feature-gated)

## Viewer Navigation

- **`navigate_viewer`** — Navigate to specific regions of an artwork image, add overlays

---

*15 tools total (13 standard + 2 internal app tools). `find_similar` is feature-gated
via `ENABLE_FIND_SIMILAR` (default: true). `semantic_search` is
particularly powerful for humanities research — query conceptually rather than by keyword.
For Iconclass taxonomy navigation, prefer the dedicated [Iconclass MCP server](https://github.com/kintopp/rijksmuseum-iconclass-mcp).*