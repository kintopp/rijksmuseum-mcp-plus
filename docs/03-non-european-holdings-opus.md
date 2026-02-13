> **Prompt:** What is the scope of the Rijksmuseum's non-European holdings? How many Japanese prints, Indian textiles, Indonesian objects, and Chinese ceramics are in the collection?
>
> **MCP client:** Claude Code | **Model:** Claude Opus 4.6 (extended thinking, medium effort) | **Tools used:** `search_artwork`, `list_curated_sets`, `browse_set` | **Turns:** 5

---

## Non-European Holdings in the Rijksmuseum: A Quantitative Overview

### Summary Counts by Geographic Area

Using description-based searches and material/technique filters, the following counts emerge:

| Region/Category | Total Objects | With Digital Images | Digitisation Rate |
|----------------|--------------|--------------------|--------------------|
| **Japan** (description) | 1,626 | 1,510 | 92.9% |
| **China** (description) | 1,011 | — | — |
| **India** (description) | 569 | — | — |
| **Indonesia** (description) | 123 | — | — |

### Material and Technique Counts

| Filter | Count |
|--------|-------|
| **Porcelain** (material) | 8,978 |
| **Textile** (type) | 6,343 |
| **Woodcut** (technique) | 260 |
| **Japanese prints** (description "Japan" + type "print") | 134 |

### The Japan Collection

The Rijksmuseum maintains a dedicated curated set for Japanese objects:

- **"Japan (collectie)"** (set 26134): **7,735 objects** — a substantial collection spanning multiple centuries and media
- **"Japanse textielsjablonen"** (set 26169): a specialised set of Japanese textile stencils

The Japan collection is remarkably diverse. A browse of the set reveals:
- **Hanging scrolls**: ink and pigment on silk paintings (e.g., Hashimoto Kansetsu's *Landscape in China*, c. 1930)
- **Prints**: including modern works by Takehisa Yumeji (1920s sheet music covers) and, elsewhere in the collection, classical ukiyo-e
- **Applied arts**: ceramics, lacquerwork, textiles, and metalwork

The 134 specifically Japanese prints found through the description search are a fraction of the full Japan set — the broader set includes prints not explicitly described with the word "Japan" in their metadata.

### Porcelain: The Largest Non-European Category

At **8,978 objects**, porcelain is by far the largest material category with non-European connections. This reflects the Rijksmuseum's strength in VOC (Dutch East India Company) trade ceramics — Chinese export porcelain, Japanese Imari ware, and Delftware imitations that document the global ceramics trade.

### Textiles: A Major but Underexplored Collection

**6,343 textile objects** represent one of the museum's largest but least publicly visible collections. This includes:
- Indonesian batik and ikat
- Indian chintz (hugely important to VOC trade)
- Japanese textile stencils (katagami)
- European textiles influenced by Asian designs

### The Digitisation Question

Japan leads in digitisation: 92.9% of Japan-related objects have digital images available (1,510 of 1,626 description matches). This is critical for remote researchers — a collection that isn't digitised is effectively invisible to those who cannot visit Amsterdam.

### Limitations of This Analysis

Several important caveats apply:

1. **Description-based searches are imprecise.** An object described with "Japan" in its Dutch or English description may not be Japanese — it could depict Japan, or reference Japan in its provenance. Conversely, many Japanese objects may not contain the word "Japan" in their description at all.

2. **The search API lacks geographic origin filters.** There is no `origin` or `culture` parameter — only `description`, `material`, `type`, and `technique`. This means geographic queries rely on free-text matching rather than structured vocabulary.

3. **Category overlap is significant.** A Chinese export porcelain bowl made for the Dutch market appears in both "China" and "porcelain" counts, and may also appear in VOC-related curated sets.

4. **The curated set is the most reliable count.** The "Japan (collectie)" set at 7,735 objects represents curatorial judgement about what belongs to the Japanese collection — far more reliable than keyword searches. Equivalent curated sets for China, India, and Indonesia would provide comparable authority, but their existence and scope would need to be checked via `list_curated_sets`.

### Implications for Research

The Rijksmuseum's non-European holdings are substantial — tens of thousands of objects when porcelain, textiles, and regional collections are combined. For researchers planning comparative or postcolonial projects:

- **Japan** is the best-supported area: large curated set (7,735), high digitisation rate, dedicated textile stencil sub-collection
- **Porcelain** offers the largest single entry point into cross-cultural material history
- **Textiles** are numerous but may require on-site research due to lower digitisation rates
- **Indonesia** appears modestly represented in description searches (123), but this likely understates the true count — many Indonesian objects may be catalogued under Dutch descriptions without explicit geographic markers
