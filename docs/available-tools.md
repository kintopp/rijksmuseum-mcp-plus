# rijksmuseum-mcp-plus tools

## Search & Discovery

- **`search_artwork`** — Filter the collection by structured criteria (subject, material, technique, dates, place, person, theme, …). Combinable filters; AND semantics on arrays.
- **`semantic_search`** — Find artworks by meaning, concept, or theme using natural language. Ranked by Dutch-description embedding similarity.
- **`search_persons`** — Find persons (artists, depicted figures, donors) by demographic (gender, born/died) or structural (birth/death place, profession) criteria. Two-step pattern: feed the returned vocab IDs into `search_artwork({creator: <vocabId>})`.
- **`collection_stats`** — Aggregate statistics, counts, and distributions across the collection.
- **`browse_set`** — DB-backed enumeration of artworks within a curated collection set.
- **`search_inscriptions`** — Structured search over artwork inscriptions: collector's marks (Lugt numbers), signatures, and transcribed text, with facets for type/placement/technique. Catalogue-entered data, not OCR.

## Artwork Details

- **`get_artwork_details`** — Full metadata for a specific artwork (by object number or Linked Art URI).
- **`get_artwork_bibliography`** — Scholarly references for one artwork (citations, linked publication, pages, ISBN) by object number. First 5 + a total count by default; `full: true` for all (major works can carry 100+).
- **`find_artworks_citing_publication`** — Reverse bibliography: artworks whose references cite a given publication, by its URI or bare id (e.g. a `publicationUri` from `get_artwork_bibliography`).
- **`get_conservation_history`** — Conservation/forensics for one artwork: technical examinations (X-ray, dendrochronology, infrared, paint samples), restoration treatments, a count of signature/inscription marks, and a provenance excerpt.
- **`get_artwork_image`** — High-resolution interactive deep-zoom viewer (with j/k/l navigation between related artworks).
- **`inspect_artwork_image`** — Fetch an artwork image (or region) as base64 for direct visual analysis by the LLM.

## Provenance

- **`search_provenance`** — Search ownership and provenance history across ~48K artworks with parsed records.

## Classification & Curation

- **`list_curated_sets`** — Discover curated sets (193 total) with member counts, dominant types/centuries, and a category heuristic.
- **`get_recent_changes`** — OAI-PMH delta semantics for tracking what changed since a known harvest checkpoint.

## Similarity

- **`find_similar`** — HTML comparison page across 9 independent similarity channels: Visual, Related Variant, Related Object, Lineage, Iconclass, Description, Theme, Depicted Person, Depicted Place + Pooled (feature-gated via `ENABLE_FIND_SIMILAR`; Theme channel further gated by `ENABLE_THEME_SIMILAR`).

## Viewer Navigation

- **`navigate_viewer`** — Navigate the open deep-zoom viewer to a specific region; add or clear labelled overlays.

---
