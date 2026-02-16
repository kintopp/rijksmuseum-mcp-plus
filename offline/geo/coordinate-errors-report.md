# Coordinate Errors in Rijksmuseum Linked Open Data – Place Vocabulary

**Date:** 2026-02-16
**Source:** Analysis of the Rijksmuseum Linked Art vocabulary data (place entities)
**Context:** While building a map of depicted places in the collection, we identified 8 place records with incorrect latitude/longitude coordinates.

---

## Summary

Out of ~32,330 place entities in the Rijksmuseum vocabulary, 10 records have incorrect or misleading coordinates. The errors follow three patterns:

1. **Latitude/longitude swapped** (6 records) — the lat value contains the longitude and vice versa
2. **Negative latitude sign** (2 records) — a Dutch location placed in the Southern Hemisphere
3. **Non-terrestrial or non-point locations** (2 records) — Wikidata P625 returns (0, 0) for entities that are not mappable terrestrial points

These errors affect a small number of artworks but would cause incorrect map placements.

---

## Affected Records

### Pattern 1: Latitude and Longitude Swapped

| Rijksmuseum ID | Place Name (EN) | Place Name (NL) | Stored Lat | Stored Lon | Correct Lat | Correct Lon | Location |
|---|---|---|---|---|---|---|---|
| 23031646 | Boca cape | Boka spelonk | -68.21 | 12.22 | **12.22** | **-68.21** | Bonaire |
| 23031649 | Goto lake | Goto meer | -68.386 | 12.235 | **12.235** | **-68.386** | Bonaire |
| 23031648 | Brandaris mountain | Brandaris (berg) | -68.388 | 12.262 | **12.262** | **-68.388** | Bonaire |
| 23031665 | Wilhelminastraat (Oranjestad) | Wilhelminastraat (Oranjestad) | -70.034 | 12.519 | **12.519** | **-70.034** | Aruba |
| 23031657 | Kwatta | Kwatta | -55.261 | 5.856 | **5.856** | **-55.261** | Suriname |
| 23031650 | Legerplaats Harskamp | Legerplaats Harskamp | 5.756 | 52.127 | **52.127** | **5.756** | Netherlands (Gelderland) |

**How to verify:** All Caribbean/Suriname locations should have positive latitude (Northern Hemisphere, ~5-13°N) and negative longitude (Western Hemisphere, ~55-70°W). Legerplaats Harskamp is a military base in Gelderland, Netherlands (~52°N, 5.7°E).

### Pattern 2: Incorrect Latitude Sign

| Rijksmuseum ID | Place Name (NL) | Stored Lat | Stored Lon | Correct Lat | Correct Lon | Location |
|---|---|---|---|---|---|---|
| 1301860 | Zeeuws-Vlaanderen | -51.333 | 3.667 | **51.333** | 3.667 | Netherlands (Zeeland) |
| 2301365 | Zeeuws-Vlaanderen | -51.333 | 3.667 | **51.333** | 3.667 | Netherlands (Zeeland) |

**How to verify:** Zeeuws-Vlaanderen is the southern part of the province of Zeeland, Netherlands. It should be at ~51.3°N (Northern Hemisphere), not -51.3° (which would place it near the Falkland Islands).

### Pattern 3: Non-Terrestrial or Non-Point Locations

When geocoding place entities via Wikidata P625 (coordinate location), two entries resolve to (0, 0) because they are not mappable terrestrial points. These should not have WGS84 coordinates assigned.

| Rijksmuseum ID | Place Name (EN) | Place Name (NL) | Wikidata QID | Stored Lat | Stored Lon | Issue |
|---|---|---|---|---|---|---|
| 23016 | Moon | Maan | Q405 | 0.0 | 0.0 | Celestial body — Wikidata returns selenographic (0, 0), which is not a terrestrial coordinate |
| 23027658 | Evenaar | Evenaar | Q23538 | 0.0 | 0.0 | The Equator is a line, not a point — Wikidata returns the (0°N, 0°E) reference point, which maps to the Gulf of Guinea |

**Recommendation:** When ingesting coordinates from Wikidata, filter out entities whose Wikidata instance-of (P31) is not a terrestrial geographic feature (e.g., skip astronomical bodies, abstract geographic concepts). Alternatively, reject any (0, 0) coordinate as a likely false positive unless the place is genuinely at Null Island.

---

## Suggested Validation Rule

A simple hemisphere check could catch these errors at ingest time:

- **Dutch/European places** (the vast majority of the collection): latitude should be positive (Northern Hemisphere), longitude should be positive (Eastern Hemisphere, for continental Europe) or slightly negative (for UK/Ireland/Iceland)
- **Caribbean Dutch territories** (Bonaire, Aruba, Curaçao, Sint-Maarten): latitude ~12-18°N (positive), longitude ~63-70°W (negative)
- **Suriname**: latitude ~2-6°N (positive), longitude ~54-58°W (negative)
- **General rule**: if |latitude| > 60 for a place that isn't in Scandinavia, polar regions, or similar high latitudes, flag it for review

---

## Detection Method

These errors were found during a bulk analysis of all 32,330 place entities in the vocabulary. The full analysis also geocoded ~15,700 places that had external identifiers (Wikidata, Getty TGN) but were missing coordinates, bringing coordinate coverage from 5.8% to 54.6% of all places.
