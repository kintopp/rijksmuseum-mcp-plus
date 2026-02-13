> **Prompt:** How does the Rijksmuseum classify its Indonesian textile collection, and how do those classifications map to the Getty Art & Architecture Thesaurus?
>
> **MCP client:** Claude Code 2.1.41 | **Model:** Claude Opus 4.6 (extended thinking, medium effort) | **Tools used:** `search_artwork`, `get_artwork_details`, `list_curated_sets`, `browse_set` | **Turns:** 9

---

## Rijksmuseum Classification of Indonesian Textiles: Taxonomy and Getty AAT Mapping

Based on a systematic survey of the collection — primarily the **AK-MAK-1742 series** (the Jan Dees & René van der Star collection transferred via Museum Nusantara, Delft) and related holdings — I can map the Rijksmuseum's multi-layered classification system across **six metadata dimensions**.

---

### 1. OBJECT TYPE CLASSIFICATIONS (Primary Taxonomy)

The Rijksmuseum uses a **Dutch-language garment typology** based on the cloth's function on the body. Here are the distinct object types I found, with their internal thesaurus IDs and Linked Open Data equivalents:

| Rijksmuseum Object Type | Dutch Term | Internal ID | Getty AAT Mapping | Wikidata |
|---|---|---|---|---|
| **Hip cloth** | *heupdoek* | `2201850` | ❌ **No AAT equivalent assigned** | ❌ None |
| **Shoulder cloth** | *schouderdoek* | `2201855` | ❌ **No AAT equivalent assigned** | ❌ None |
| **Breast cloth** | *borstdoek* | `2201950` | ❌ No AAT | ✅ `Q42141469` |
| **Head cloth** | *hoofddoek* | `2206208` | ✅ `aat:300213003` (head cloths) | ❌ None |
| **Cloth** (generic) | *cloth* | `22010138` | ❌ No AAT | ✅ `Q5849500` |
| **Clothing** (parent) | *clothing* | `22058` | ✅ `aat:300266639` (clothing) | ✅ `Q11460` |
| **Pants** (ikat trousers) | *pants* | `220309` | ✅ `aat:300209935` (trousers) | ❌ None |

**Key finding:** The two most distinctively Indonesian types — **heupdoek** (hip cloth / sarong) and **schouderdoek** (shoulder cloth / selendang) — have **no Getty AAT equivalents** in the Rijksmuseum's own linked data. These are local thesaurus terms (`id.rijksmuseum.nl/2201850`, `id.rijksmuseum.nl/2201855`) that represent a Dutch colonial-era descriptive vocabulary for which no matching AAT concept has been mapped.

---

### 2. EXTERNAL ID LINKS (Object-Level AAT)

Many objects carry an **external identifier** pointing to `http://vocab.getty.edu/aat/300312355`. This AAT term corresponds to **"sarongs"** in the Getty vocabulary. This link appears on:
- `BK-15588` (batik hip cloth)
- `AK-MAK-1742-111` (ikat hip cloth)
- `BK-1982-106` (tapis/hip cloth with VOC mark)
- `AK-MAK-1742-3` (geringsing shoulder cloth)
- `AK-MAK-1742-82` (head cloth)
- `AK-MAK-1742-7` (temple cloth)
- `AK-RAK-2017-7` (shoulder cloth)

**Notably**, AAT 300312355 ("sarongs") is applied broadly as an object-level external ID regardless of the specific garment function — it covers hip cloths, shoulder cloths, head cloths, *and* temple cloths alike. This creates a **flattening effect**: the nuanced Dutch typology (heupdoek vs. schouderdoek vs. hoofddoek vs. tempeldoek) collapses into a single AAT concept at the external ID level.

---

### 3. TECHNIQUE CLASSIFICATIONS

The technique field records **Indonesian textile-specific processes** with varying degrees of AAT/Wikidata linkage:

| Technique (as recorded) | Linked Authority | Status |
|---|---|---|
| **batik** (in technique statement: "gebatikt") | — | Free-text only; no formal AAT link observed |
| **ikat** / **inslag-ikat** (weft ikat) / **dubbele ikat** (double ikat) | — | Free-text technique statement; no AAT term linked |
| **songket** | Wikidata `Q589421` | Linked as a *material*, not a technique |

The technique statements are **free-text Dutch descriptions** (e.g., "geweven zijde en gouddraad; inslag-ikat en songket", "geweven katoen; dubbele ikat", "geverfd en gebeitst katoen") rather than controlled vocabulary terms. The Getty AAT does have relevant terms (e.g., AAT `300265042` for "batik" as a process, `300379943` for "ikat"), but these are **not linked** in the structured metadata.

---

### 4. MATERIAL CLASSIFICATIONS

Materials are well-linked to both AAT and Wikidata:

| Material | AAT | Wikidata |
|---|---|---|
| **silk** | `aat:300243428` | `Q37681` |
| **cotton (textile)** | `aat:300014067` | `Q11457` |
| **gold thread** | `aat:300400561` | — |
| **brocade (textile)** | `aat:300227779` | — |
| **songket** | ❌ No AAT | `Q589421` |
| **tin plate** (decorative additions) | `aat:300380231` | — |
| **textile materials** (generic) | `aat:300231565` | — |

**Songket** is interesting: classified as a material (which it partly is, as supplementary weft brocade), it has a Wikidata link but **no AAT equivalent**, reflecting the AAT's weaker coverage of Southeast Asian textile vocabulary.

---

### 5. TITLE / ALTERNATE NAME LAYER

The Rijksmuseum preserves **indigenous nomenclature** in alternate titles (qualifier: "other"), while the primary title uses Dutch descriptive terms:

| Object | Primary Title (Dutch) | Alternate Title (Indigenous) |
|---|---|---|
| `AK-MAK-1742-100` | Heupdoek (sarong) | **Sarung** |
| `AK-MAK-1742-12` | Heupdoek | **Kain songket, saput** |
| `AK-MAK-1742-3` | Schouderdoek | **Geringsing wayang kebo** |
| `AK-MAK-1742-69` | Schouderdoek | **Kamben** |
| `AK-MAK-1742-82` | Hoofddoek | **Tengkuluk; kain sandang** |
| `AK-MAK-1742-7` | Tempeldoek | **Kain songket** |

These indigenous terms are **unlinked** — they exist only as free-text alternate titles with no authority file URIs. This means terms like *geringsing*, *saput*, *kamben*, and *tengkuluk* are invisible to AAT-based discovery systems.

---

### 6. COLLECTION SET HIERARCHY

The textiles are organized into overlapping curatorial sets that define institutional context:

| Set ID | Label | Function |
|---|---|---|
| `261137` | **Zuidoost-Azië, maritiem (collectie)** | Geographic/cultural grouping (Maritime Southeast Asia) |
| `261136` | **Zuidoost-Azië, vasteland (collectie)** | Mainland SE Asia variant |
| `261228` | **textiel** | Medium-based set (807 total textiles) |
| `261119` | **applied arts** | Departmental grouping |
| `260247` | **friends asian art** | Loan/ownership (VVAK) |
| `260210` | **Against Opacity** | Exhibition/thematic set |
| `26127` | **costumes and accessories** | Cross-cultural dress category |
| `260236` | **fashion** | Broader thematic grouping |

---

### 7. PROVENANCE PATTERN

The vast majority of the Indonesian textiles entered the Rijksmuseum through a single channel: the **Jan Dees and René van der Star collection**, originally donated to the **Museum Nusantara in Delft**, which closed in 2013. The collection was transferred via **Erfgoed Delft** to the **Vereniging van Vrienden der Aziatische Kunst** (VVAK / Royal Asian Art Society), which loans them to the Rijksmuseum. This explains the uniformity of the `AK-MAK-1742-*` numbering series.

---

### Summary Assessment: Classification Gaps

The Rijksmuseum employs a **rich, multi-layered classification** that actually preserves more cultural specificity than the Getty AAT can accommodate. However, the mapping reveals significant **interoperability gaps**:

1. **Object types** — The core Indonesian garment types (*heupdoek*, *schouderdoek*, *borstdoek*) have no AAT equivalents. The blunt mapping of everything to AAT `300312355` ("sarongs") erases functional distinctions.

2. **Techniques** — *Batik*, *ikat*, and *songket* are recorded only as free-text technique statements, not linked to the AAT concepts that do exist for these processes (e.g., AAT `300265042`, `300379943`).

3. **Indigenous names** — Terms like *geringsing*, *kamben*, *saput*, *tengkuluk*, and *kain sandang* are preserved but **orphaned** from any authority file, making them invisible to cross-collection discovery.

4. **Songket as material** — Classified as a material linked only to Wikidata, it falls between the AAT's cracks (the AAT treats supplementary weft brocade differently from how songket functions in Indonesian textile culture).

This is a case where the **source culture's taxonomy is richer than the target controlled vocabulary**, and the Rijksmuseum's own thesaurus mediates between the two — preserving specificity locally while losing it in linked data export.

---
