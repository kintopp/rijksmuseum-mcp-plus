# Vocabulary Database Schema

This page describes `vocabulary.db`, the SQLite database behind rijksmuseum-mcp+. The database can be downloaded and used on its own, without the MCP server:

- **Download:** [`vocabulary.db.gz`](https://github.com/kintopp/rijksmuseum-mcp-plus/releases/download/v0.90/vocabulary.db.gz) from the [v0.90 release](https://github.com/kintopp/rijksmuseum-mcp-plus/releases/tag/v0.90) (527 MB compressed, 2.2 GB unpacked). Later releases changed only the server code, so v0.90 is the current database.
- **Contents:** 834,435 artworks, 418,020 vocabulary terms and 14,799,632 links between them, harvested on 2 May 2026. The counts on this page refer to the v0.90 file.
- **Format:** a plain SQLite 3 file. It opens in the `sqlite3` command-line tool, [DB Browser for SQLite](https://sqlitebrowser.org/), [Datasette](https://datasette.io/), or any SQLite library. No extensions are needed.

The data is a copy, not the authoritative record. For current data use the Rijksmuseum's own [APIs](https://data.rijksmuseum.nl). The provenance enrichments described below have not been reviewed or endorsed by the Rijksmuseum.

## Sources

| Source | What it contributed |
|---|---|
| [OAI-PMH](https://data.rijksmuseum.nl/oai) (EDM records) | The artwork records and their vocabulary links |
| [Linked Art resolver](https://id.rijksmuseum.nl/) | Titles, dimensions, dates, provenance text, inscriptions, bibliography, conservation records, related objects, exhibitions |
| [Schema.org dumps](https://data.rijksmuseum.nl/dumps/) | Person and organisation details (gender, life dates, biographical notes), name variants, external identifiers |
| Getty TGN, Wikidata, GeoNames | Place coordinates, kept only where a Rijksmuseum authority identifier resolves them |

The `version_info` table records the build date and each later processing step.

## How the tables connect

There are two kinds of identifier, and most joins use one or the other:

- **Artworks:** `artworks.object_number` is the museum's inventory number (for example `SK-C-5`, *The Night Watch*). Every other artwork table joins on the integer `artworks.art_id`. The column is called `artwork_id` in some tables and `art_id` in others, but it holds the same value. `art_id` equals the `artworks` rowid.
- **Vocabulary terms:** `vocabulary.id` is the Rijksmuseum's identifier (stored as text). `vocabulary.vocab_int_id` is a compact integer used only by the `mappings` table.

The `mappings` table holds every link between an artwork and a vocabulary term, as three integers:

```
mappings.artwork_id   →  artworks.art_id
mappings.vocab_rowid  →  vocabulary.vocab_int_id   (not vocabulary.id)
mappings.field_id     →  field_lookup.id
```

`field_lookup` says what kind of link each row is:

| id | name | Meaning | Links |
|---|---|---|---|
| 1 | `attribution_qualifier` | Attribution qualifier ("attributed to", "workshop of", "primary") | 1,561,950 |
| 2 | `birth_place` | The creator's place of birth, copied onto each work | 196,300 |
| 3 | `collection_set` | Membership of a curated set (`vocabulary.type = 'set'`) | 2,814,775 |
| 4 | `creator` | Maker (person or organisation) | 1,191,504 |
| 5 | `death_place` | The creator's place of death, copied onto each work | 181,118 |
| 6 | `material` | Material | 1,194,533 |
| 7 | `production_place` | Place of production | 708,294 |
| 8 | `production_role` | The maker's role ("painter", "printmaker") | 1,361,764 |
| 9 | `profession` | The creator's profession, copied onto each work | 458,690 |
| 10 | `source_type` | A broad class from the cataloguing source ("designs", "drawings", "paintings"); coarser than `type` | 211,075 |
| 11 | `spatial` | Place associated with the work (depicted or produced) | 487,139 |
| 12 | `subject` | What the work depicts: Iconclass subjects, persons, places, groups and events | 2,020,400 |
| 13 | `technique` | Technique | 1,074,567 |
| 14 | `theme` | Thematic keyword | 125,957 |
| 15 | `type` | Object type ("painting", "print") | 1,211,566 |

`subject` mixes several kinds of term. Filter on `vocabulary.type` to separate them: `classification` terms are Iconclass subjects (the code is in `notation`), and `person`, `place`, `group` and `event` are what the work depicts.

## Tables

### Artworks

**`artworks`** (834,435 rows): one row per object.

| Column | Notes |
|---|---|
| `object_number` | Inventory number; primary key |
| `art_id` | Integer key used by all other tables |
| `title`, `title_all_text` | Display title; all title variants joined, for searching |
| `creator_label` | Creator as displayed |
| `date_display` | Date as written by the cataloguer ("c. 1665–1667") |
| `date_earliest`, `date_latest` | Date range as integer years (negative for BCE). Use these for range queries |
| `height_cm`, `width_cm`, `depth_cm`, `diameter_cm`, `weight_g` | Dimensions parsed into numbers; `dimension_note`, `extent_text` keep the original wording |
| `description_text` | Cataloguer's description, mostly in Dutch (512,369 works) |
| `narrative_text` | English museum wall text (13,808 works) |
| `inscription_text` | Inscriptions and marks, `|`-separated, usually in Dutch and English (501,804 works) |
| `provenance_text` | Provenance as written by the museum (48,559 works); parsed into the provenance tables below |
| `credit_line` | Acquisition credit line |
| `has_image`, `iiif_id` | Whether an image exists, and its IIIF identifier. Image URL: `https://iiif.micr.io/{iiif_id}/full/max/0/default.jpg` |
| `rights_id` | Licence of the record → `rights_lookup.uri` (Public Domain Mark, CC0 or In Copyright) |
| `current_location` | Location code for the 8,472 works on display (for example `HG-2.16-02`). The middle part (`2.16`) is the `museum_rooms.room_id` |
| `importance` | A ranking score computed for this project from image, wall text, link count and set membership. It is not a museum value |
| `record_created`, `record_modified` | Timestamps of the museum's record edits |

Related artwork tables:

| Table | Rows | Contents |
|---|---|---|
| `title_variants` | 1,281,590 | All titles with `language` and `qualifier` (display, full, brief, former) |
| `artwork_external_ids` | 818,202 | Persistent `hdl.handle.net` identifiers |
| `artwork_hmo_ids` | 834,435 | The Linked Art object identifier for each `art_id`; used to join `exhibition_members` |
| `production_role_pairs` | 1,397,947 | Which creator had which role on which work (`creator_id`, `role_id` are `vocabulary.id` values) |
| `assignment_pairs` | 283,663 | Which attribution qualifier belongs to which creator on a work |
| `attribution_evidence` | 657,353 | Signatures (AAT 300028702) and inscriptions (AAT 300028705) that support an attribution |
| `related_objects` | 156,386 | Links between works (pendant, related object), with labels in English and Dutch |
| `artwork_parent` | 208,372 | Part-of links, such as a sheet that belongs to an album |
| `artwork_citations` | 925,603 | Bibliography: citation text, pages, ISBN, WorldCat and Rijksmuseum Library links |
| `examinations` | 3,151 | Technical examinations (technical report, dendrochronology, paint samples, infrared reflectography) |
| `modifications` | 1,743 | Recorded treatments and alterations |
| `exhibitions`, `exhibition_members`, `artwork_exhibitions` | 868 exhibitions | Exhibition titles and dates, and which works were shown |
| `museum_rooms` | 75 | Gallery codes, floors and names |

### Vocabulary and people

**`vocabulary`** (418,020 rows): every term an artwork can link to. `type` is one of `person` (290,788), `classification` (46,243), `place` (37,114), `organisation` (28,214), `group` (12,176), `event` (3,283), `set` (193) or `concept` (9).

| Column | Notes |
|---|---|
| `id` | Rijksmuseum identifier (text) |
| `vocab_int_id` | Integer key used by `mappings` |
| `label_en`, `label_nl` | Labels. Person names are often inverted ("Vermeer, Johannes") |
| `notation` | Iconclass code, for 23,262 classification terms |
| `external_id` | Main external URI (for example the Iconclass or AAT link) |
| `broader_id` | Parent term, for place and classification hierarchies |
| `lat`, `lon`, `coord_method`, `coord_method_detail` | Coordinates for 23,854 places. All have `coord_method = 'deterministic'`, which means they come from an authority identifier the museum supplied. `coord_method_detail` names the route (TGN, Wikidata property, GeoNames) |
| `placetype`, `is_areal` | Kind of place, and whether it is an area (a country or region) rather than a point |
| `birth_year`, `death_year`, `gender`, `bio`, `wikidata_id` | Person details, where known |
| `*_method` columns | How a value was obtained, kept so each enrichment can be traced |

Related tables:

| Table | Rows | Contents |
|---|---|---|
| `vocabulary_external_ids` | 321,801 | Identifiers in other authorities: Wikidata, VIAF, RKD, ULAN, Iconclass, TGN, AAT, CERL, GeoNames, and others. `vocab_id` → `vocabulary.id` |
| `person_names` | 709,013 | Name variants for persons, with language and kind (`display`, `inverted`, `preferred`, `schema_name`, `schema_alt_name`) |
| `entity_alt_names` | 31,384 | Further name variants; `tier = 'manual'` marks the 513 added by hand after review |
| `vocab_term_counts` | 181,711 | Number of artworks per term |
| `rights_lookup` | 3 | Licence URIs for `artworks.rights_id` |

The same person can appear under more than one `vocabulary.id`; Vermeer, for example, has two rows. To find everything for a person, look the name up in `person_names`, or match on `wikidata_id`.

### Provenance

The museum's provenance texts follow the AAM notation. This project parsed them into structured events with a rule-based (PEG) parser. A small number of difficult cases were corrected with an LLM, and each correction is recorded with its reasoning. The structure is aligned with the CMOA and PLOD provenance models.

| Table | Rows | Contents |
|---|---|---|
| `provenance_events` | 101,115 (48,535 works) | One row per event, in order (`sequence`). `raw_text` is the source fragment. Also holds `transfer_type` (sale, by_descent, gift, bequest, loan, and others), `transfer_category` (ownership, custody, ambiguous), `date_year`, `date_qualifier`, `location`, `price_amount`, `price_currency`, `uncertain`, and `parse_method` (`peg`, `cross_ref`, `credit_line`, `llm_structural`) |
| `provenance_parties` | 90,891 | The people and institutions in each event, with `party_role` (buyer, seller, heir, collector, donor) and `party_dates` |
| `provenance_periods` | 81,207 | The same history as ownership periods: owner, `begin_year`, `end_year`, acquisition method and source. `derivation` records how each value was inferred |
| `provenance_enrichments` | 990 | The record of every LLM or manual correction: what changed (`payload`), the `method`, `reasoning` and `confidence` |

`provenance_events` and `provenance_parties` join on `(artwork_id, sequence)`.

### Full-text search

Four FTS5 indexes are built in: `artwork_texts_fts` (titles, descriptions, inscriptions, provenance, credit lines and wall texts), `vocabulary_fts`, `person_names_fts` and `entity_alt_names_fts`. They match without regard to case or diacritics. Each joins to its source table on `rowid`.

### Tables you can ignore

These tables are left over from building the database and carry no collection data: `phase_failures`, `phase2_failures`, `backfill_bibliography_progress`, `backfill_role_pairs_progress` and `sync_state`. Tables ending in `_fts_config`, `_fts_data`, `_fts_docsize` and `_fts_idx` are internal parts of the full-text indexes.

## Example queries

All vocabulary links of one artwork:

```sql
SELECT f.name AS field, v.type, v.label_en, v.label_nl, v.notation
FROM artworks a
JOIN mappings m     ON m.artwork_id = a.art_id
JOIN vocabulary v   ON v.vocab_int_id = m.vocab_rowid
JOIN field_lookup f ON f.id = m.field_id
WHERE a.object_number = 'SK-C-5'
ORDER BY f.name;
```

Works by one creator. Find the term first, then look up its links; this is much faster than joining `mappings` directly. The result also includes works made after Vermeer, so check `attribution_qualifier` if that matters.

```sql
SELECT a.object_number, a.title, a.date_display
FROM artworks a
WHERE a.art_id IN (
  SELECT m.artwork_id FROM mappings m
  WHERE m.field_id = (SELECT id FROM field_lookup WHERE name = 'creator')
    AND m.vocab_rowid IN (
      SELECT vocab_int_id FROM vocabulary
      WHERE id IN (SELECT person_id FROM person_names WHERE name = 'Johannes Vermeer')))
ORDER BY a.date_earliest;
```

Works with an Iconclass subject, including all narrower codes (25F23 is beasts of prey):

```sql
SELECT count(DISTINCT m.artwork_id)
FROM mappings m
WHERE m.field_id = (SELECT id FROM field_lookup WHERE name = 'subject')
  AND m.vocab_rowid IN (SELECT vocab_int_id FROM vocabulary WHERE notation LIKE '25F23%');
```

The ownership history of one work:

```sql
SELECT e.sequence, e.date_year, e.transfer_type, e.location,
       group_concat(p.party_name || ' (' || coalesce(p.party_role, '?') || ')', '; ') AS parties
FROM provenance_events e
JOIN artworks a ON a.art_id = e.artwork_id
LEFT JOIN provenance_parties p ON p.artwork_id = e.artwork_id AND p.sequence = e.sequence
WHERE a.object_number = 'SK-A-4691'
GROUP BY e.sequence
ORDER BY e.sequence;
```

Full-text search in the English wall texts:

```sql
SELECT a.object_number, a.title
FROM artwork_texts_fts
JOIN artworks a ON a.rowid = artwork_texts_fts.rowid
WHERE artwork_texts_fts MATCH 'narrative_text:tulip'
ORDER BY rank
LIMIT 20;
```

A person's identifiers in other authorities:

```sql
SELECT authority, id, uri
FROM vocabulary_external_ids
WHERE vocab_id = '2101778';   -- Johannes Vermeer
```

## Licence and citation

The enrichments this project adds, such as the parsed provenance tables, are released under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). The Rijksmuseum records they are built on keep their own licences: the licence of each record is in `artworks.rights_id`, and the museum's [information and data policy](https://data.rijksmuseum.nl/policy/information-and-data-policy) asks for a credit line and data citation. To cite this project, see [`CITATION.cff`](../CITATION.cff).
