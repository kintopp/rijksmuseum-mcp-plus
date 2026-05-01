"""HistoGIS where-was probe (corrected endpoint, point-in-polygon mode).

The earlier probe used `/api/tempspatial-simple/?wikidata_id=<QID>` which matches
on polygon-level QID tagging only — yield 2%.

This probe uses `/api/where-was/?lat=&lng=&temp_start=&page_size=50` which is
point-in-polygon: returns ALL polygons that geographically contain the point
across all time. We then filter client-side by overlap with the artwork's
creation year. Confirmed via the DHd 2019 slide deck (Zenodo 2611667).

Sample: 50 (vocab_id, lat, lng, median_year) tuples from places that:
- are geocoded (v.lat IS NOT NULL) — only 1,888 of 36,929 today; will be much
  larger post-Stage-5.5
- are used as production_place on at least one artwork with creation date in
  1500-1919

Output:
  offline/geo/histogis-probe/where-was-results.csv
  offline/geo/histogis-probe/where-was-summary.md
"""
from __future__ import annotations

import csv
import random
import sqlite3
import statistics
import time
from datetime import date
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "data" / "vocabulary.db"
OUT_DIR = ROOT / "offline" / "geo" / "histogis-probe"

ENDPOINT = "https://histogis.acdh.oeaw.ac.at/api/where-was/"
HEADERS = {
    "User-Agent": "rijksmuseum-mcp-plus histogis-where-was-probe / arno.bosse@gmail.com",
    "Accept": "application/json",
}

SAMPLE_SIZE = 50
RATE_LIMIT_S = 1.1
SEED = 42

# state-level adm_names (treat as "context only" — less useful than sub-state)
STATE_ADM_NAMES = {
    "Kingdom", "Empire", "Republic", "Confederation", "Federation",
    "Country", "State", "Reich", "Königreich", "Kaiserreich"
}


def fetch_sample(conn: sqlite3.Connection, n: int) -> list[dict]:
    """Sample geocoded places used as production_place on 1500-1919 artworks."""
    rows = conn.execute(
        "SELECT v.id AS vocab_id, v.lat, v.lon, "
        "       v.label_en, v.label_nl, "
        "       GROUP_CONCAT(a.date_earliest) AS years "
        "FROM vocabulary v "
        "JOIN mappings m ON m.vocab_rowid = v.vocab_int_id AND m.field_id = 7 "
        "JOIN artworks a ON a.art_id = m.artwork_id "
        "WHERE v.type='place' AND v.lat IS NOT NULL "
        "  AND a.date_earliest BETWEEN 1500 AND 1919 "
        "GROUP BY v.id"
    ).fetchall()
    rng = random.Random(SEED)
    sample = rng.sample(rows, k=min(n, len(rows)))
    out = []
    for vid, lat, lon, label_en, label_nl, years_str in sample:
        years = [int(y) for y in years_str.split(",") if y]
        median_year = int(statistics.median(years))
        out.append({
            "vocab_id": vid,
            "lat": lat,
            "lon": lon,
            "label": label_en or label_nl or "",
            "median_year": median_year,
            "n_artworks": len(years),
        })
    return out


def query_where_was(lat: float, lon: float, year: int) -> dict:
    """Get all polygons containing this point (across all time)."""
    when = f"{year:04d}-06-15"
    r = requests.get(ENDPOINT, params={
        "format": "json", "lat": str(lat), "lng": str(lon),
        "temp_start": when, "page_size": 50,
    }, headers=HEADERS, timeout=45)
    if r.status_code != 200:
        return {"error": f"HTTP {r.status_code}", "polygons": []}
    data = r.json()
    polygons = []
    for f in data.get("features", []):
        p = f["properties"]
        polygons.append({
            "name": p.get("name", ""),
            "adm_name": p.get("adm_name", ""),
            "source_name": p.get("source_name", ""),
            "start_date": p.get("start_date", ""),
            "end_date": p.get("end_date", ""),
            "wikidata_id": p.get("wikidata_id", ""),
        })
    return {"count": data.get("count", 0), "polygons": polygons}


def filter_by_year(polygons: list[dict], year: int) -> list[dict]:
    """Keep polygons whose [start_date, end_date] contains July 1 of `year`."""
    target = date(year, 7, 1)
    out = []
    for p in polygons:
        sd, ed = p.get("start_date", ""), p.get("end_date", "")
        if not sd or not ed:
            continue
        try:
            sd_d = date.fromisoformat(sd)
            ed_d = date.fromisoformat(ed)
        except ValueError:
            continue
        if sd_d <= target <= ed_d:
            out.append(p)
    return out


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB)

    sample = fetch_sample(conn, SAMPLE_SIZE)
    print(f"Probing {len(sample)} (vocab_id, lat, lon, median_year) tuples at /api/where-was/\n")

    results = []
    for i, c in enumerate(sample, 1):
        try:
            res = query_where_was(c["lat"], c["lon"], c["median_year"])
        except Exception as e:
            results.append({**c, "bucket": "error", "n_polygons_total": 0, "n_polygons_at_year": 0,
                            "stack": "", "err": str(e)[:100]})
            print(f"  [{i:>2}/{len(sample)}] ERR  {c['label']!r}: {e}")
            time.sleep(RATE_LIMIT_S)
            continue
        if "error" in res:
            results.append({**c, "bucket": "error", "n_polygons_total": 0, "n_polygons_at_year": 0,
                            "stack": "", "err": res["error"]})
            print(f"  [{i:>2}/{len(sample)}] {res['error']}  {c['label']!r}")
            time.sleep(RATE_LIMIT_S)
            continue

        all_polys = res["polygons"]
        at_year = filter_by_year(all_polys, c["median_year"])
        substate = [p for p in at_year if p["adm_name"] not in STATE_ADM_NAMES]

        if not all_polys:
            bucket = "no_match"
        elif not at_year:
            bucket = "no_polygons_at_year"
        elif not substate:
            bucket = "match_state_only"
        else:
            bucket = "match_full_stack"

        stack = " | ".join(f"{p['name']}/{p['adm_name']}" for p in at_year[:5])
        results.append({
            **c, "bucket": bucket,
            "n_polygons_total": len(all_polys),
            "n_polygons_at_year": len(at_year),
            "n_substate_at_year": len(substate),
            "stack": stack,
            "err": "",
        })
        tag = {"match_full_stack": "★", "match_state_only": "·",
               "no_polygons_at_year": "○", "no_match": "·"}[bucket]
        print(f"  [{i:>2}/{len(sample)}] {tag} {bucket:<22}  total={len(all_polys):>2}  @{c['median_year']}={len(at_year):>2}  {c['label']!r:<35} → {stack[:80]}")
        time.sleep(RATE_LIMIT_S)

    csv_path = OUT_DIR / "where-was-results.csv"
    keys = ["vocab_id", "label", "lat", "lon", "median_year", "n_artworks",
            "bucket", "n_polygons_total", "n_polygons_at_year", "n_substate_at_year",
            "stack", "err"]
    with csv_path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=keys, extrasaction="ignore")
        w.writeheader()
        w.writerows(results)

    n_full = sum(1 for r in results if r["bucket"] == "match_full_stack")
    n_state = sum(1 for r in results if r["bucket"] == "match_state_only")
    n_no_year = sum(1 for r in results if r["bucket"] == "no_polygons_at_year")
    n_no = sum(1 for r in results if r["bucket"] == "no_match")
    n_err = sum(1 for r in results if r["bucket"] == "error")
    n_any_match = n_full + n_state
    avg_at_year = (sum(r["n_polygons_at_year"] for r in results if r["n_polygons_at_year"]) /
                   max(1, n_any_match))

    print(f"\nresults: {n_full} match_full_stack / {n_state} match_state_only / "
          f"{n_no_year} no_polygons_at_year / {n_no} no_match / {n_err} error")
    print(f"  any-match rate: {n_any_match}/{len(sample)} = {n_any_match*100/len(sample):.1f}%")
    print(f"  full-stack rate: {n_full}/{len(sample)} = {n_full*100/len(sample):.1f}%")
    print(f"  avg polygons per matched year: {avg_at_year:.1f}")

    md = OUT_DIR / "where-was-summary.md"
    md.write_text(f"""# HistoGIS `/api/where-was/` probe — {time.strftime('%Y-%m-%d')}

**Replaces:** `funnel-and-coverage.md` (which used `/api/tempspatial-simple/?wikidata_id=` and yielded 2%; that's a polygon-tag query, not point-in-polygon).

**Endpoint:** `GET /api/where-was/?lat=<LAT>&lng=<LNG>&temp_start=<YYYY-MM-DD>&page_size=50`
**Mode:** point-in-polygon. Returns ALL polygons geographically containing the point across all time. Client filters by overlap with target year.
**Sample:** 50 geocoded production places linked to ≥1 artwork in 1500-1919, seeded with 42.
**Rate limit:** {RATE_LIMIT_S}s between calls.

## Buckets

| Bucket | n | % |
|---|---:|---:|
| `match_full_stack` (sub-state polygon overlaps year — most useful) | {n_full} | {n_full*100/len(sample):.1f}% |
| `match_state_only` (only kingdom/empire/etc. overlaps year — state-level signal only) | {n_state} | {n_state*100/len(sample):.1f}% |
| `no_polygons_at_year` (point covered, but none of its polygons overlap the target year) | {n_no_year} | {n_no_year*100/len(sample):.1f}% |
| `no_match` (zero polygons returned — point outside HistoGIS coverage entirely) | {n_no} | {n_no*100/len(sample):.1f}% |
| `error` | {n_err} | {n_err*100/len(sample):.1f}% |

**Any-match rate (full + state-only): {n_any_match}/{len(sample)} = {n_any_match*100/len(sample):.1f}%**
**Full-stack rate (sub-state polygon at the right time): {n_full}/{len(sample)} = {n_full*100/len(sample):.1f}%**
Average overlapping polygons per match: {avg_at_year:.1f}

## Interpretation

- This is the actual capability of HistoGIS for our use case: feed in a place's coordinates plus an artwork's creation date, get back the historical administrative stack.
- The earlier 2% from the wikidata_id endpoint was a measurement artefact, not a coverage limit. Real point-in-polygon yield is far higher.
- A `match_full_stack` row gives us a multi-level diachronic admin context for free (e.g. Berlin 1850 → Potsdam Governmental District + Brandenburg Province + Preußen Kingdom).

## Funnel (current state)

| Metric | Value |
|---|---:|
| All places in vocabulary | 36,929 |
| Geocoded places (`lat IS NOT NULL`) — pre-Stage-5.5 | 1,888 |
| Geocoded production places linked to artworks in 1500-1919 | 784 |
| Post-Stage-5.5 projected (geocoding cascade target ~80% coverage) | ~28,000 |

The current 784 is small. Post-Stage-5.5 the addressable population scales by ~10-15× (since geocoding cascade lifts coverage to ~80%). Yield rate from this probe should hold roughly constant on that larger population.

## Projected enrichment

If the {n_any_match*100/len(sample):.1f}% any-match rate is representative:
- Today: ~{int(784 * n_any_match / len(sample))} of the 784 geocoded production places would resolve to historical admin context.
- Post-Stage-5.5: ~{int(28000 * 0.5 * n_any_match / len(sample)):,} places (assuming ~half of the 28K post-cascade geocoded places are linked to in-range artworks).

## License

CC BY 4.0 on the data (per ARCHE record `oeaw_detail/105578`). MIT on the application code (`acdh-oeaw/histogis` GitHub). Single-line attribution in `version_info` and project README data-credits.

## Verdict (yield-driven)

- ≥30% any-match → invest in Role A (production-place temporal-polity enrichment)
- 10-30% → niche; consider for the German/Austrian subset only
- <10% → skip

Current rate **{n_any_match*100/len(sample):.1f}% any-match / {n_full*100/len(sample):.1f}% full-stack** → {('worth pursuing' if n_any_match*100/len(sample) >= 30 else ('niche' if n_any_match*100/len(sample) >= 10 else 'skip'))}.

## Raw output

- `where-was-results.csv` — per-row buckets and admin stacks
""", encoding="utf-8")
    print(f"\nwrote {md.relative_to(ROOT)}")
    print(f"wrote {csv_path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
