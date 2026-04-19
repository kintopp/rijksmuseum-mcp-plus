## Semantic search

The `semantic_search` tool finds artworks by meaning, concept, or theme using natural language. Unlike `search_artwork`, which matches against structured metadata fields (titles, vocabulary terms, Iconclass notations), semantic search ranks all ~833,000 artworks by embedding similarity to a free-text query.

### How it works

Each artwork in the Rijksmuseum collection has a pre-computed embedding — a 384-dimensional vector generated from a composite text built from four metadata fields (the "no-subjects" strategy):

| Field | Source | Coverage |
|-------|--------|----------|
| Title | All title variants (brief, full, former × EN/NL) | ~99% |
| Inscriptions | Transcribed text from the object surface | ~60% |
| Description | Cataloguer observations (Dutch) | ~61% |
| Curatorial narrative | Museum wall text (English/Dutch) | ~2% (14K works) |

Iconclass subject labels and creator names are deliberately excluded — benchmarking showed that including subject labels biased results toward tagged vocabulary matches rather than semantic meaning, reducing the number of paintings surfaced by 71% in painting-expected queries. Creator names are excluded because they duplicate the structured `creator` filter path (#72).

The composite text is assembled as `[Title] ... [Inscriptions] ... [Description] ... [Narrative] ...` (omitting empty fields) and embedded using [`intfloat/multilingual-e5-small`](https://huggingface.co/intfloat/multilingual-e5-small), a multilingual sentence embedding model. Embeddings are int8-quantized (384 dimensions) and stored in a SQLite database using [sqlite-vec](https://github.com/asg017/sqlite-vec).

At query time, the user's query is embedded with the same model, and the nearest artwork vectors are returned ranked by cosine similarity.

### When to use semantic search

**Best for:** concepts that cannot be expressed as structured metadata:
- Atmospheric qualities — `"vanitas symbolism and mortality"`, `"sense of loneliness"`
- Compositional descriptions — `"artist gazing directly at the viewer"`
- Art-historical concepts — `"cultural exchange under VOC trade"`
- Cross-language queries — `"Blumenstrauß in einer Vase"`, `"scène de patinage en hiver"`

**Not for:** queries that map to structured fields — specific artists, dates, places, materials, object types, or Iconclass notations. Use `search_artwork` for those.

**Combine both when:**
- A semantic query returns results skewed toward works on paper but paintings are expected: follow up with `search_artwork(type: "painting", subject: ...)`.
- A `search_artwork` query returned zero results or misses conceptually relevant works: try `semantic_search` as a fallback.

### Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `query` | Yes | Natural language concept query (e.g. `"winter landscape with ice skating"`) |
| `type` | No | Filter by object type (e.g. `"painting"`, `"print"`). String or array |
| `material` | No | Filter by material (e.g. `"canvas"`, `"paper"`). String or array |
| `technique` | No | Filter by technique (e.g. `"etching"`, `"oil painting"`). String or array |
| `creationDate` | No | Filter by date — exact year (`"1642"`) or wildcard (`"16*"`) |
| `dateMatch` | No | Date matching mode: `"overlaps"` (default), `"within"`, or `"midpoint"` |
| `creator` | No | Filter by artist name. String or array |
| `subject` | No | Pre-filter by subject term. String or array |
| `iconclass` | No | Pre-filter by Iconclass notation code (e.g. `"73D82"`). String or array |
| `depictedPerson` | No | Pre-filter by depicted person. String or array |
| `depictedPlace` | No | Pre-filter by depicted place. String or array |
| `productionPlace` | No | Pre-filter by production place. String or array |
| `collectionSet` | No | Pre-filter by curated set name (e.g. `"Rembrandt"`). String or array |
| `aboutActor` | No | Pre-filter by person (depicted or creator) |
| `imageAvailable` | No | Restrict to artworks with a digital image |
| `maxResults` | No | Number of results (1–50, default 15) |
| `offset` | No | Skip this many results (for pagination) |

Filters narrow the candidate set via the vocabulary database *before* semantic ranking. This is more precise than post-filtering because it searches the full metadata (not just the embedded text) and ensures all results match the filter exactly.

### Filter notes

- Use `type: "painting"` to restrict to the paintings collection. Do **not** use `technique: "painting"` for this — it matches painted decoration on any object type (ceramics, textiles, frames) and will return unexpected results.
- Filters require the vocabulary database. If the vocabulary database is not available, filters are silently ignored and a warning is included in the response.
- When filters match zero artworks, the tool returns an explicit zero-result message rather than falling back to unfiltered search.

### Search modes

The tool uses two internal search paths:

| Mode | When | How |
|------|------|-----|
| **Pure KNN** | No filters, or vocab DB unavailable | vec0 virtual table — brute-force scan of all ~833,000 vectors |
| **Filtered KNN** | One or more filters specified | Vocabulary DB narrows candidates by metadata, then `vec_distance_cosine()` ranks the filtered set |

The search mode (`semantic` or `semantic+filtered`) is reported in the response.

### Response format

Each result includes:
- **Rank**, **object number**, **title**, **creator**, **date**, **type** — artwork identification
- **Similarity score** — cosine similarity (0–1, higher = more similar)
- **Source text** — the reconstructed composite text that was originally embedded, in the same `[Label] value` format. This is the grounding context — use it to explain *why* a result was retrieved or to identify false positives.
- **URL** — link to the artwork on rijksmuseum.nl

Source text is not stored in the embeddings database (saving ~270 MB). It is reconstructed at query time from the vocabulary database, matching the original embedding generation format.

### Known limitations

**Curatorial language dependency.** Results are most reliable when the Rijksmuseum's curatorial narrative texts discuss the relevant concept explicitly. The model embeds what curators have written, not what artworks depict. For purely emotional or stylistic concepts (e.g. chiaroscuro, desolation), catalogue descriptions often do not use that language, and precision will be lower.

**Cross-language precision.** Queries in Dutch, German, French, and other languages are supported via the multilingual embedding model, but may carry a precision penalty compared to English queries. Expected canonical works may appear lower in the ranking or be absent. If results seem off, try reformulating in English.

**No relevance ranking for filters.** Within the filtered set, results are ranked by embedding similarity — there is no hybrid score combining metadata relevance with semantic similarity.

### Description embeddings (separate path)

A second, description-only embedding set is stored alongside the main vectors and powers the Description signal in `find_similar`. It is not used by `semantic_search`. The model is [`clips/e5-small-trm-nl`](https://huggingface.co/clips/e5-small-trm-nl) — a Dutch-tuned E5 variant — and the vectors are full 384-dimensional int8 (v0.22 used a PCA-compressed 256d, restored to 384d in v0.24). Coverage is limited to artworks with a non-empty `description_text` field (~512K rows, ~61% of the collection); artworks without a description are absent from the `desc_embeddings` table, so Description-signal results for those objects simply return nothing rather than fabricating a nearest neighbour.

### Technical details

- **Embedding model:** `intfloat/multilingual-e5-small` (118M params, 384 dimensions). Runtime inference via `@huggingface/transformers` (ONNX/WASM, pure JavaScript — no native addon). The quantized ONNX model is sourced from the [Xenova mirror](https://huggingface.co/Xenova/multilingual-e5-small).
- **Vector storage:** [sqlite-vec](https://github.com/asg017/sqlite-vec) v0.1.9. Brute-force scan (no ANN index). ~833,000 × int8[384] ≈ 305 MB in the vec0 table, plus a regular `artwork_embeddings` table for filtered queries.
- **Query embedding prefix:** The model uses the `query:` prefix for queries and `passage:` for documents, following the E5 instruction format.
- **Database size:** ~2.0 GB uncompressed (includes `desc_embeddings` for description-based `find_similar`); ~1.1 GB gzipped for deployment. Auto-downloaded on first start when `EMBEDDINGS_DB_URL` is set.
