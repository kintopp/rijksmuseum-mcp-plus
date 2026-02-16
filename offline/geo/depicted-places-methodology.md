# Depicted Places in the Rijksmuseum Collection — Methodology & Data

**Date:** 2026-02-16

---

## Overview

We extracted, deduplicated, and geocoded the places depicted in the Rijksmuseum collection using the vocabulary database (`data/vocabulary.db`) that was previously harvested from the Rijksmuseum Linked Art APIs. The work produced two datasets and an interactive map.

---

## Datasets

### 1. `offline/geo/geocoded_places.csv` — 18,276 places with coordinates

All place vocabulary entries that now have latitude/longitude, including both the ~1,887 that were already geocoded during the original harvest and the ~16,391 newly geocoded in this session.

| Column | Description |
|---|---|
| `id` | Rijksmuseum vocabulary ID (e.g. `23029985`) |
| `place_name` | Best available name (English preferred, Dutch fallback) |
| `label_en` / `label_nl` | Raw labels from the vocabulary |
| `external_id` | Linked authority URI (Wikidata, Getty TGN, GeoNames, or Rijksmuseum internal) |
| `lat` / `lon` | WGS84 coordinates |
| `authority_source` | Which authority the external_id points to: `wikidata`, `getty_tgn`, `geonames`, `rijksmuseum`, `none` |
| `artwork_count` | Number of artworks depicting this place (via `subject` or `spatial` mapping fields) |

Sorted by artwork_count descending. Top entries: Amsterdam (76,831), Netherlands (69,856), Paris (24,057), France (17,919).

### 2. `offline/geo/ungeocoded_places.csv` — 14,052 places without coordinates

All place vocabulary entries still missing lat/lon, categorized by why they couldn't be geocoded.

| Column | Description |
|---|---|
| `id` | Rijksmuseum vocabulary ID |
| `place_name` | Best available name |
| `label_en` / `label_nl` | Raw labels |
| `external_id` | Authority URI (if any) |
| `category` | Reason for missing coordinates (see breakdown below) |
| `artwork_count` | Number of artworks depicting this place |

**Category breakdown:**

| Category | Count | Description |
|---|---|---|
| `no_external_id__used` | 7,627 | Never reconciled to an external authority, but linked to artworks. Many are streets, buildings, landmarks (e.g. "Nieuwezijds Voorburgwal", "Beurs van Berlage"). Highest-impact gap. |
| `no_external_id__orphan` | 4,589 | No external authority AND not linked to any artworks. Dead entries. |
| `rijksmuseum_self_ref` | 1,039 | External ID is a self-referencing `https://id.rijksmuseum.nl/...` URI. 96.8% are duplicates of already-geocoded entries under different vocab IDs. None used in mappings. |
| `wikidata_no_P625` | 337 | Wikidata QID exists but the Wikidata entity has no P625 (coordinate location) property. Obscure or abstract locations. |
| `geonames_no_wikidata` | 285 | GeoNames ID exists but no matching Wikidata entity was found (or the Wikidata match lacks coordinates). Could be resolved via GeoNames API directly. |
| `getty_tgn_no_coords` | 175 | Getty TGN ID exists but the TGN record has no coordinates. Historical or abstract regions. |

Sorted by category priority (actionable first) then artwork_count descending.

### 3. `offline/geo/coordinate-errors-report.md` — 8 coordinate errors

Report documenting 8 places with incorrect coordinates found during the analysis (6 lat/lon swaps, 2 negative latitude signs). These have been fixed in the vocabulary database. Written in email-ready format for reporting to the Rijksmuseum.

---

## Geocoding Process

Starting from ~1,887 places with coordinates (5.8% of 32,330 total place vocabulary entries), we ran four geocoding rounds:

| Round | Method | Places resolved | Time | Script |
|---|---|---|---|---|
| 1 | Wikidata SPARQL — batch query P625 by QID | 8,334 | ~40s | `scripts/batch_geocode.py` |
| 2 | Getty TGN SPARQL — batch query by TGN ID | 7,430 | ~70s | `scripts/batch_geocode.py` |
| 3 | Nominatim — top 200 by artwork count | 184 | ~4min | `scripts/map_depicted_places.py --geocode-top 200` |
| 4 | Wikidata SPARQL — cross-ref GeoNames IDs via P1566 | 627 | ~10s | Inline script (same SPARQL pattern as round 1) |

**Final result: 18,278 places with coordinates (56.5% coverage).**

The key insight was that the Linked Art harvester had already reconciled places to external authorities (Wikidata, Getty TGN, GeoNames) but hadn't populated lat/lon from those authorities. Batch SPARQL queries against Wikidata and Getty resolved ~16,000 places in under 2 minutes.

---

## Scripts

All in `scripts/`:

### `scripts/map_depicted_places.py`

End-to-end pipeline: extract depicted places from vocabulary DB → deduplicate by normalized name → optionally geocode via Nominatim → save CSV → generate interactive Folium/Leaflet map.

```
python3 scripts/map_depicted_places.py \
  --db data/vocabulary.db \
  --output depicted_places_map.html \
  --csv-out data/depicted_places_deduped.csv \
  --geocode-top 200    # or --no-geocode to skip Nominatim
```

### `scripts/batch_geocode.py`

Bulk geocoding using external authority IDs already in the vocabulary DB. Queries Wikidata SPARQL (by QID), Getty TGN SPARQL (by TGN ID), and optionally GeoNames API. Updates `vocabulary.db` in-place.

```
python3 scripts/batch_geocode.py \
  --db data/vocabulary.db \
  --skip-geonames      # GeoNames API is slow (1 req/sec)
```

### `scripts/harvest-vocabulary-db.py`

Pre-existing harvester that built the vocabulary database from Linked Art APIs. Not modified in this session.

---

## Output Map

`offline/geo/depicted_places_map.html` — Interactive Leaflet map with:
- 14,050 deduplicated depicted places (after merging vocabulary entries with the same name)
- Clustered markers via MarkerCluster
- Circle markers sized by artwork count (log scale), color-coded blue → orange → red
- Popups with artwork count and link to Rijksmuseum search
- Legend with statistics

---

## Non-Point Entity Audit (TODO)

Many geocoded places are not cities or specific locations — they are countries, continents, oceans, or regions. Their coordinates are centroid approximations from Wikidata/Getty, which are technically valid but may not be desirable for all map use cases.

**Audit results (no changes made — for future decision):**

### Continents (~5 entries)
Africa, Asia, Europe, North America, South America. Centroids from Wikidata. Europe's centroid (54.9°N, 15.2°E) falls in Poland; Africa's (1.6°S, 17.2°E) in the Congo basin. These appear as giant dots on the map.

### Oceans & Seas (~21 entries)
Pacific Ocean, Atlantic Ocean, Indian Ocean, North Sea, Mediterranean Sea, Baltic Sea, South China Sea, etc. Pacific Ocean's centroid is (0°N, -160°W) — the lat=0 could theoretically be confused with a Null Island false positive but is a legitimate centroid.

### Countries (~40+ entries)
Netherlands, France, England, Germany, Italy, Japan, China, India, Indonesia, etc. These have authority-sourced centroids and are among the highest artwork-count entries (Netherlands: 69,856 artworks, France: 17,919).

### Provinces/Regions (~10+ entries)
Noord-Holland, Zuid-Holland, Gelderland, Friesland, etc. Authority-sourced centroids.

**Assessment:** All coordinates come from legitimate authority sources (Wikidata P625, Getty TGN). None are errors. However, for map visualization, placing 69,856 artworks at the centroid of "Netherlands" creates a misleading giant marker. Options to consider:

1. **Leave as-is** — centroids are technically correct; the map is showing "places depicted," not precise locations
2. **Filter by entity type** — use Wikidata P31 (instance-of) to exclude or flag non-point entities (countries, continents, water bodies)
3. **Visual differentiation** — render non-point entities with a different marker style (e.g., hollow circles, different color) to distinguish them from specific locations

---

## What Would Improve Coverage Further

1. **Geocode the 7,627 unreconciled places** — many are Amsterdam streets/buildings that could be geocoded by appending ", Amsterdam" to the name and using Nominatim
2. **Resolve the 285 GeoNames-only entries** via the GeoNames API (~5 min at 1 req/sec)
3. **Contribute P625 coordinates to Wikidata** for the 337 QIDs that lack them
4. **Entity reconciliation** for the 7,627 unreconciled places — matching them to Wikidata/TGN would unlock both coordinates and cross-referencing
