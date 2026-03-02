# rijksmuseum-mcp-plus tools

## Search & Discovery

- **`search_artwork`** — Search the collection by keyword, artist, period, medium, etc.
- **`semantic_search`** — Find artworks by meaning, concept, or theme using natural language
- **`browse_set`** — Browse artworks within a curated collection set

## Artwork Details

- **`get_artwork_details`** — Full metadata for a specific artwork (by object number)
- **`get_artwork_image`** — High-resolution interactive deep-zoom viewer
- **`inspect_artwork_image`** — Fetch an artwork image as base64 for direct visual analysis
- **`get_artwork_bibliography`** — Scholarly references and bibliography for a work

## Artist & Timeline

- **`get_artist_timeline`** — Chronological timeline of an artist's works in the collection

## Classification & Curation

- **`lookup_iconclass`** — Search the Iconclass vocabulary (universal iconographic classification system)
- **`list_curated_sets`** — Browse curated exhibitions and scholarly groupings
- **`get_recent_changes`** — Track recent additions and modifications to the collection

## Navigation & Linked Data

- **`navigate_viewer`** — Navigate to specific regions of an artwork image, add overlays
- **`resolve_uri`** — Resolve a Linked Art URI to full artwork details
- **`open_in_browser`** — Open a URL in your browser

---

*14 tools total. `semantic_search` and `lookup_iconclass` are particularly powerful for
humanities research — query conceptually rather than by keyword, and cross-reference
the Iconclass taxonomy directly.*