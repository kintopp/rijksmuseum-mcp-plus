## Semantic search

The `semantic_search` tool finds artworks by meaning, concept, or theme using natural language. Unlike `search_artwork`, which matches against structured metadata fields (titles, vocabulary terms, Iconclass notations), semantic search ranks the whole embedded corpus — about 830K artworks — by similarity to a free-text query. (`search_artwork` is not purely structured either: its `textQuery` DSL runs full-text search over descriptions and curatorial narrative. The distinction is exact matching versus vector similarity, not metadata versus text.)

### How it works

Each artwork in the Rijksmuseum collection has a pre-computed embedding — a 768-dimensional vector generated from a composite text built from four metadata fields (the "no-subjects" strategy):

| Field | Source | Coverage |
|-------|--------|----------|
| Title | The primary title only — **not** the full brief/full/former × EN/NL variant set, which the non-deployed embedding strategies use | ~99% |
| Inscriptions | Transcribed text on the work (signatures, captions, dates); verso collector's-mark stamps and placeholder rows are stripped, so only genuine transcribed text is embedded | ~29% (of the ~60% that carry any inscription field) |
| Description | Cataloguer observations (Dutch) | ~61% |
| Curatorial narrative | Museum wall text (English only — Dutch column always null) | ~2% (14K works) |

Iconclass subject labels and creator names are deliberately excluded — benchmarking showed that including subject labels biased results toward tagged vocabulary matches rather than semantic meaning, sharply reducing the number of paintings surfaced in painting-expected queries. Creator names are excluded because they duplicate the structured `creator` filter path (#72).

The composite text is assembled as `[Title] ... [Inscriptions] ... [Description] ... [Narrative] ...` (omitting empty fields) and embedded using Google's [EmbeddingGemma 2](https://huggingface.co/onnx-community/embeddinggemma-2-ONNX), a multilingual text–image embedding model. Embeddings are int8-quantized (768 dimensions) and stored in the Gemma database (`gemma.db`), which also holds the image and Iconclass vectors behind `multimodal_search`. `semantic_search` ranks the same metadata vectors as `multimodal_search`'s metadata channel, and adds the source text of each hit for grounding.

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
| `imageAvailable` | No | `true` = only artworks with a digital image; `false` = only those without one |
| `maxResults` | No | Number of results (1–50, default 15) |
| `offset` | No | Skip this many results (for pagination) |

Filters narrow the candidate set via the vocabulary database *before* semantic ranking. This is more precise than post-filtering because it searches the full metadata (not just the embedded text) and ensures all results match the filter exactly.

### Filter notes

- Use `type: "painting"` to restrict to the paintings collection. Do **not** use `technique: "painting"` for this — it matches painted decoration on any object type (ceramics, textiles, frames) and will return unexpected results.
- Filters require the vocabulary database. If it is unavailable the filters are ignored and a warning is returned in the response.
- When filters match zero artworks, the tool returns an explicit zero-result message rather than falling back to unfiltered search.

### Search modes

The tool uses two internal search paths:

| Mode | When | How |
|------|------|-----|
| **Unfiltered** | No filters, or vocab DB unavailable | In-memory scan of a 384-dimensional prefix of every vector picks the top 2,000 candidates, which are then rescored exactly against the full 768-dimensional vectors |
| **Filtered** | Any metadata filter | Vocabulary DB narrows candidates by metadata. Up to 20,000 candidates are rescored exactly; a broader set goes through the same two-stage pass, restricted to the candidates |

The search mode (`semantic` or `semantic+filtered`) is reported in the response.

### Response format

Each result includes:
- **Rank**, **object number**, **title**, **creator**, **date**, **type** — artwork identification
- **Similarity score** — cosine similarity (higher = more similar). EmbeddingGemma scores sit in a narrow band (most relevant hits around 0.75–0.85), so read them as a ranking, not as absolute relevance
- **Source text** — the reconstructed composite text that was originally embedded, in the same `[Label] value` format. This is the grounding context — use it to explain *why* a result was retrieved or to identify false positives.
- **URL** — link to the artwork on rijksmuseum.nl

Source text is not stored in the vector database. It is reconstructed at query time from the vocabulary database, matching the original embedding generation format.

### Known limitations

**Curatorial language dependency.** Results are most reliable when the Rijksmuseum's curatorial narrative texts discuss the relevant concept explicitly. The model embeds what curators have written, not what artworks depict. For purely emotional or stylistic concepts (e.g. chiaroscuro, desolation), catalogue descriptions often do not use that language, and precision will be lower.

**Cross-language precision.** Queries in Dutch, German, French, and other languages are supported via the multilingual embedding model, but may carry a precision penalty compared to English queries. Expected canonical works may appear lower in the ranking or be absent. If results seem off, try reformulating in English.

**Names and named periods.** The model is weaker on artist names and named historical periods (e.g. "Tachtigjarige Oorlog") than on scene descriptions and concepts. Use the `creator` and `creationDate` pre-filters, or `search_artwork`, for those.

**No relevance ranking for filters.** Within the filtered set, results are ranked by embedding similarity — there is no hybrid score combining metadata relevance with semantic similarity.

### Description embeddings (separate path)

A separate, description-only embedding set lives in the embeddings database (`embeddings.db`) and powers the Description signal in `find_similar`. It is not used by `semantic_search`. The model is [`clips/e5-small-trm-nl`](https://huggingface.co/clips/e5-small-trm-nl) — a Dutch-tuned E5 variant — and the vectors are full 384-dimensional int8. Coverage matches the `description_text` field exactly, one row per described artwork (~61% of the collection); artworks without a description are absent from the description index, so Description-signal results for those objects simply return nothing rather than fabricating a nearest neighbour.

### Technical details

- **Embedding model:** EmbeddingGemma 2 (768 dimensions, Matryoshka-trained so a prefix of the vector is itself a usable embedding). Runtime inference via `@huggingface/transformers` (ONNX on CPU, int8 by default) loads the [`onnx-community/embeddinggemma-2-ONNX`](https://huggingface.co/onnx-community/embeddinggemma-2-ONNX) text tower only, pinned to a fixed revision so an upstream re-export cannot shift the query space.
- **Query embedding prefix:** queries are encoded as `task: search result | query: …`; the stored artwork texts were encoded as documents.
- **Vector storage:** full vectors in plain SQLite tables, read by rowid for the exact rescoring step; the 384-dimensional prefixes are loaded into memory at startup.

### Operational notes

- **The tool is conditionally registered.** `semantic_search` (like `multimodal_search`) appears in `tools/list` only when *both* the Gemma database and the Gemma query model loaded successfully. If the model fails to load, the tool silently disappears and calls return `-32602`, while every vocabulary-backed tool keeps working — so the failure looks like something else entirely.
- **Set `HF_HOME`.** transformers.js does not honour `HF_HOME` itself; the server reads it and assigns it to the library's cache directory. Leave it unset and the model lands in an ephemeral cache, is re-fetched on every boot, and a busy startup can fail that fetch — which produces exactly the silent unregistration above.
- **Results are cached.** Responses go through an LRU+TTL cache keyed on the Gemma database build id and the canonical arguments, with in-flight de-duplication. A database swap therefore invalidates the cache automatically.
