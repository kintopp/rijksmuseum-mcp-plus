"""HistoGIS coverage probe — Part 1+2 (license-clean, funnel diagnostic, 50-row sample).

API endpoint: /api/tempspatial-simple/?wikidata_id=<QID>&when=<YYYY-MM-DD>
Coverage:     Central Europe / Habsburg / German states (strong); Pan-European
              state borders 1815-1919 (universal); Reichskreise 1512 (sparse).
License:      CC BY 4.0 (per ACDH ARCHE record).

Probe:
  - Sample 50 production_place QIDs from the v0.26 DB.
  - For each, pick the median artwork creation year (of artworks linked to that
    place) as the temporal query parameter.
  - Issue GET /api/tempspatial-simple/?wikidata_id=<QID>&when=<year>-06-15
    (uses mid-year to avoid year-boundary edge cases).
  - Bucket: name_match_found / no_match / error.

Output:
  offline/geo/histogis-probe/funnel-and-coverage.md   — short report
  offline/geo/histogis-probe/probe-results.csv         — per-row results
"""
from __future__ import annotations

import csv
import random
import sqlite3
import statistics
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "data" / "vocabulary.db"
OUT_DIR = ROOT / "offline" / "geo" / "histogis-probe"
OUT_DIR.mkdir(parents=True, exist_ok=True)

ENDPOINT = "https://histogis.acdh.oeaw.ac.at/api/tempspatial-simple/"
HEADERS = {
    "User-Agent": "rijksmuseum-mcp-plus histogis-probe / arno.bosse@gmail.com",
    "Accept": "application/json",
}

SAMPLE_SIZE = 50
RATE_LIMIT_S = 1.1
SEED = 42


def fetch_funnel(conn: sqlite3.Connection) -> dict:
    """Counts that frame the HistoGIS funnel."""
    out = {}
    out["places_total"] = conn.execute("SELECT COUNT(*) FROM vocabulary WHERE type='place'").fetchone()[0]
    out["places_with_qid"] = conn.execute(
        "SELECT COUNT(DISTINCT v.id) FROM vocabulary v "
        "JOIN vocabulary_external_ids vei ON vei.vocab_id = v.id AND vei.authority='wikidata' "
        "WHERE v.type='place'"
    ).fetchone()[0]
    out["places_used_as_production_place"] = conn.execute(
        "SELECT COUNT(DISTINCT v.id) FROM vocabulary v "
        "JOIN vocabulary_external_ids vei ON vei.vocab_id = v.id AND vei.authority='wikidata' "
        "JOIN mappings m ON m.vocab_rowid = v.vocab_int_id "
        "WHERE v.type='place' AND m.field_id = 7"
    ).fetchone()[0]
    out["artworks_linked"] = conn.execute(
        "SELECT COUNT(DISTINCT m.artwork_id) FROM vocabulary v "
        "JOIN vocabulary_external_ids vei ON vei.vocab_id = v.id AND vei.authority='wikidata' "
        "JOIN mappings m ON m.vocab_rowid = v.vocab_int_id "
        "WHERE v.type='place' AND m.field_id = 7"
    ).fetchone()[0]
    out["links_in_1500_1919"] = conn.execute(
        "SELECT COUNT(*) FROM vocabulary v "
        "JOIN vocabulary_external_ids vei ON vei.vocab_id = v.id AND vei.authority='wikidata' "
        "JOIN mappings m ON m.vocab_rowid = v.vocab_int_id "
        "JOIN artworks a ON a.art_id = m.artwork_id "
        "WHERE v.type='place' AND m.field_id = 7 "
        "  AND a.date_earliest BETWEEN 1500 AND 1919"
    ).fetchone()[0]
    out["links_in_1815_1919"] = conn.execute(
        "SELECT COUNT(*) FROM vocabulary v "
        "JOIN vocabulary_external_ids vei ON vei.vocab_id = v.id AND vei.authority='wikidata' "
        "JOIN mappings m ON m.vocab_rowid = v.vocab_int_id "
        "JOIN artworks a ON a.art_id = m.artwork_id "
        "WHERE v.type='place' AND m.field_id = 7 "
        "  AND a.date_earliest BETWEEN 1815 AND 1919"
    ).fetchone()[0]
    return out


def sample_qid_year_pairs(conn: sqlite3.Connection, n: int) -> list[dict]:
    """For each sampled place QID, pick the median creation_year of its artworks
    in 1500-1919 as the representative date for HistoGIS lookup."""
    rows = conn.execute(
        "SELECT v.id AS vocab_id, vei.id AS qid, "
        "       v.label_en, v.label_nl, "
        "       GROUP_CONCAT(a.date_earliest) AS years "
        "FROM vocabulary v "
        "JOIN vocabulary_external_ids vei ON vei.vocab_id = v.id AND vei.authority='wikidata' "
        "JOIN mappings m ON m.vocab_rowid = v.vocab_int_id "
        "JOIN artworks a ON a.art_id = m.artwork_id "
        "WHERE v.type='place' AND m.field_id = 7 "
        "  AND a.date_earliest BETWEEN 1500 AND 1919 "
        "GROUP BY v.id, vei.id, v.label_en, v.label_nl"
    ).fetchall()
    rng = random.Random(SEED)
    sample = rng.sample(rows, k=min(n, len(rows)))
    out = []
    for vid, qid, label_en, label_nl, years_str in sample:
        years = [int(y) for y in years_str.split(",") if y]
        median_year = int(statistics.median(years))
        out.append({
            "vocab_id": vid,
            "qid": qid,
            "label": label_en or label_nl or "",
            "median_year": median_year,
            "n_artworks": len(years),
            "earliest_year": min(years),
            "latest_year": max(years),
        })
    return out


def query_histogis(qid: str, year: int) -> dict:
    """Query HistoGIS for polygons containing this QID's place at the given year.
    Returns {"count": int, "polygons": [{"title", "source_name", "start_date", "end_date"}, ...]}."""
    when = f"{year:04d}-06-15"  # mid-year to avoid year-boundary
    r = requests.get(ENDPOINT, params={"wikidata_id": qid, "when": when},
                     headers=HEADERS, timeout=45)
    if r.status_code != 200:
        return {"error": f"HTTP {r.status_code}", "count": 0, "polygons": []}
    data = r.json()
    polygons = []
    for res in data.get("results", []):
        polygons.append({
            "title": res.get("title", ""),
            "source_name": res.get("source_name", ""),
            "adm_name": res.get("adm_name", ""),
            "start_date": res.get("start_date", ""),
            "end_date": res.get("end_date", ""),
        })
    return {"count": data.get("count", 0), "polygons": polygons}


def main() -> None:
    conn = sqlite3.connect(DB)
    print("=== HistoGIS Part 1+2 — funnel + coverage probe ===\n")

    funnel = fetch_funnel(conn)
    print("Funnel:")
    for k, v in funnel.items():
        print(f"  {k:>40}: {v:>10,}")

    sample = sample_qid_year_pairs(conn, SAMPLE_SIZE)
    print(f"\nProbing {len(sample)} (vocab_id, qid, median_year) pairs at HistoGIS…")

    results = []
    for i, c in enumerate(sample, 1):
        try:
            res = query_histogis(c["qid"], c["median_year"])
        except Exception as e:
            results.append({**c, "bucket": "error", "n_polygons": 0, "polygons_summary": str(e)[:120]})
            print(f"  [{i:>2}/{len(sample)}] ERROR  {c['qid']} ({c['label']!r}, {c['median_year']}): {e}")
            time.sleep(RATE_LIMIT_S)
            continue

        if res.get("error"):
            results.append({**c, "bucket": "error", "n_polygons": 0, "polygons_summary": res["error"]})
            print(f"  [{i:>2}/{len(sample)}] {res['error']}  {c['qid']}")
        elif res["count"] == 0:
            results.append({**c, "bucket": "no_match", "n_polygons": 0, "polygons_summary": ""})
            print(f"  [{i:>2}/{len(sample)}] · 0 polygons  {c['qid']:<10} ({c['label']!r}, {c['median_year']})")
        else:
            polys = res["polygons"]
            summary = " | ".join(
                f"{p['title']} [{p.get('adm_name','')}, {p.get('source_name','')}]"
                for p in polys[:3]
            )
            results.append({
                **c, "bucket": "match_found",
                "n_polygons": res["count"],
                "polygons_summary": summary,
            })
            print(f"  [{i:>2}/{len(sample)}] ✓ {res['count']} polygons  {c['qid']:<10} ({c['label']!r}, {c['median_year']})  → {polys[0]['title']}")
        time.sleep(RATE_LIMIT_S)

    # write csv
    csv_path = OUT_DIR / "probe-results.csv"
    keys = ["vocab_id", "qid", "label", "median_year", "earliest_year", "latest_year",
            "n_artworks", "bucket", "n_polygons", "polygons_summary"]
    with csv_path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=keys, extrasaction="ignore")
        w.writeheader()
        w.writerows(results)

    n_match = sum(1 for r in results if r["bucket"] == "match_found")
    n_no = sum(1 for r in results if r["bucket"] == "no_match")
    n_err = sum(1 for r in results if r["bucket"] == "error")
    print(f"\nresults: {n_match} match_found / {n_no} no_match / {n_err} error")

    # markdown report
    md = OUT_DIR / "funnel-and-coverage.md"
    md.write_text(f"""# HistoGIS Part 1+2 — funnel + coverage probe — {time.strftime('%Y-%m-%d')}

**Source DB:** `data/vocabulary.db` (v0.26 dress-rehearsal harvest, pre-Stage-5.5).
**API:** `https://histogis.acdh.oeaw.ac.at/api/tempspatial-simple/?wikidata_id=<QID>&when=<YYYY-MM-DD>`
**License:** CC BY 4.0 (confirmed via ACDH ARCHE record `oeaw_detail/105578`)
**Probe sample:** {len(sample)} (vocab_id, qid, median_year) tuples, seed=42.
**Rate limit:** {RATE_LIMIT_S} s between calls.

## Funnel

| Metric | Value |
|---|---:|
| All places | {funnel['places_total']:,} |
| Places with Wikidata QID | {funnel['places_with_qid']:,} |
| Places used as `production_place` (field_id=7) on ≥1 artwork | {funnel['places_used_as_production_place']:,} |
| Artworks linked to those places | {funnel['artworks_linked']:,} |
| (place, artwork) links with creation date 1500–1919 | {funnel['links_in_1500_1919']:,} |
| (place, artwork) links with creation date 1815–1919 (strongest HG period) | {funnel['links_in_1815_1919']:,} |

## Coverage probe (50-row sample)

| Bucket | n | % |
|---|---:|---:|
| `match_found` | {n_match} | {n_match*100/len(sample):.1f}% |
| `no_match` | {n_no} | {n_no*100/len(sample):.1f}% |
| `error` | {n_err} | {n_err*100/len(sample):.1f}% |

## Interpretation

- Sample yield rate: **{n_match*100/len(sample):.1f}%** of `(place_QID, year)` pairs return at least one HistoGIS polygon.
- Projected addressable enrichment for Role A (production-place temporal-polity context):
  ~{int(funnel['places_used_as_production_place'] * n_match / len(sample))} of the {funnel['places_used_as_production_place']:,} place QIDs would resolve, conditional on this sample being representative.
- That implies enrichment of up to ~{int(funnel['links_in_1500_1919'] * n_match / len(sample)):,} (place, artwork) links — a substantial share of the collection's diachronic-political signal.

## Caveats

- HistoGIS is geographically focused: Central Europe / Habsburg / German states are well-covered;
  Italian, Iberian, Eastern European, and overseas places are sparse to absent.
- Temporal coverage: pan-European state borders 1815–1919 are universal; pre-1815 coverage is
  patchy outside the Holy Roman Empire / Reichskreise. A place with median year 1650 in Spain
  will return 0 polygons even though Spain has a Wikidata QID match.
- A "match" is signal, not yield — each match returns 1–N nested polygons (city / district /
  crownland / state). Most useful is the highest-level non-state polygon (e.g. crownland), which
  carries the most diachronic information.

## Verdict (yield-driven decision rule)

- ≥30% match rate → invest in Role A enrichment as a Phase 1j or harvest-time annotation
- 10-30% → consider only for the Habsburg/German subset; not worth a general phase
- <10% → skip; the geographic coverage doesn't reach our collection broadly enough

Current rate **{n_match*100/len(sample):.1f}%** → {('worth pursuing' if n_match*100/len(sample) >= 30 else ('Habsburg/German subset only' if n_match*100/len(sample) >= 10 else 'skip'))}.

## License clearance

CC BY 4.0 on the data (ACDH ARCHE record). MIT on the application code (`acdh-oeaw/histogis` GitHub repo). No SA, no ND, no special licensing complications. Standard attribution suffices:

> "Includes data from HistoGIS (ACDH-OEAW), CC BY 4.0. <https://histogis.acdh.oeaw.ac.at/>"

Add to `version_info` row + project README data-credits section.

## Raw output

- `probe-results.csv` — {len(results)} rows of probe results (per-row buckets and polygon summaries)
""", encoding="utf-8")
    print(f"wrote {md.relative_to(ROOT)}")
    print(f"wrote {csv_path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
