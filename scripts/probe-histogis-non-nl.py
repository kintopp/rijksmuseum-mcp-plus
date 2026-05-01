"""HistoGIS where-was probe — non-NL stratified sample.

The first where-was probe (`probe-histogis-where-was.py`) drew a random sample
from the v0.26 geocoded subset, which is heavily Dutch-biased. Result: 84%
any-match, 0% full-stack — every match was state-level "Koninkrijk der
Nederlanden" because HistoGIS's NL coverage stops at country level.

This probe targets HistoGIS's strength: German/Austrian/Habsburg-territory
places where sub-state polygons (kingdoms, crownlands, Regierungsbezirke,
Imperial Circles) exist in the polygon collection.

Two-step workflow (no Stage 5.5 dependency):
  1. Wikidata SPARQL — for our 5,036 production_place QIDs, fetch (country, coords).
     Filter to non-NL Central European countries.
  2. Probe HistoGIS where-was for 50 of those. Bucket as before.

Output:
  offline/geo/histogis-probe/non-nl-sample.csv      — sampled (qid, lat, lon, country, year)
  offline/geo/histogis-probe/non-nl-results.csv     — per-row buckets
  offline/geo/histogis-probe/non-nl-summary.md      — short report
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

WIKIDATA = "https://query.wikidata.org/sparql"
HISTOGIS = "https://histogis.acdh.oeaw.ac.at/api/where-was/"
UA = "rijksmuseum-mcp-plus histogis-non-nl-probe / arno.bosse@gmail.com"
H_WD = {"User-Agent": UA, "Accept": "application/sparql-results+json"}
H_HG = {"User-Agent": UA, "Accept": "application/json"}

# Countries plausibly in HistoGIS sub-state coverage (Habsburg + German-speaking +
# Imperial Circles + neighbouring polities the sources cover).
TARGET_COUNTRIES = {
    "Q183": "Germany",
    "Q40":  "Austria",
    "Q39":  "Switzerland",
    "Q213": "Czechia",
    "Q214": "Slovakia",
    "Q28":  "Hungary",
    "Q215": "Slovenia",
    "Q224": "Croatia",
    "Q36":  "Poland",
    "Q38":  "Italy",
    "Q31":  "Belgium",
    "Q32":  "Luxembourg",
    "Q41":  "Greece",       # Habsburg/Ottoman boundary plays
    "Q252": "Indonesia",    # control: should ALL miss
}
# explicitly EXCLUDED so we don't repeat the all-NL bias
EXCLUDED_COUNTRIES = {"Q55"}  # Netherlands

BATCH_SIZE = 250
SAMPLE_SIZE = 50
RATE_LIMIT_S = 1.1
SEED = 42

STATE_ADM_NAMES = {"Kingdom", "Empire", "Republic", "Confederation", "Federation",
                   "Country", "State", "Reich", "Königreich", "Kaiserreich"}


def fetch_production_place_qids(conn: sqlite3.Connection) -> list[tuple[str, str, str, str]]:
    """(vocab_id, qid, label, median_year) for places used as production_place
    on artworks dated 1500-1919."""
    rows = conn.execute(
        "SELECT v.id, vei.id, COALESCE(v.label_en, v.label_nl, ''), "
        "       GROUP_CONCAT(a.date_earliest) "
        "FROM vocabulary v "
        "JOIN vocabulary_external_ids vei "
        "  ON vei.vocab_id = v.id AND vei.authority='wikidata' "
        "JOIN mappings m ON m.vocab_rowid = v.vocab_int_id AND m.field_id = 7 "
        "JOIN artworks a ON a.art_id = m.artwork_id "
        "WHERE v.type='place' "
        "  AND a.date_earliest BETWEEN 1500 AND 1919 "
        "GROUP BY v.id, vei.id, v.label_en, v.label_nl"
    ).fetchall()
    out = []
    for vid, qid, label, years_str in rows:
        years = [int(y) for y in years_str.split(",") if y]
        out.append((vid, qid, label, int(statistics.median(years))))
    return out


def query_wikidata_country_coords(qids: list[str]) -> dict:
    """Return {qid: {"country": qid_or_label, "lat": float, "lon": float}}.
    Empty for qids without P17/P625."""
    values = " ".join(f"wd:{q}" for q in qids)
    query = (
        "SELECT ?qid ?country ?coord WHERE { "
        f"  VALUES ?qid {{ {values} }} "
        "  ?qid wdt:P17 ?country . "
        "  ?qid wdt:P625 ?coord . "
        "}"
    )
    r = requests.get(WIKIDATA, params={"query": query}, headers=H_WD, timeout=120)
    r.raise_for_status()
    out = {}
    for b in r.json()["results"]["bindings"]:
        qid_uri = b["qid"]["value"]
        qid = qid_uri.rsplit("/", 1)[-1]
        country = b["country"]["value"].rsplit("/", 1)[-1]
        coord = b["coord"]["value"]  # 'Point(lon lat)'
        if not coord.startswith("Point("):
            continue
        try:
            lon_lat = coord[6:-1].split()
            lon, lat = float(lon_lat[0]), float(lon_lat[1])
        except Exception:
            continue
        if qid not in out:  # first match only
            out[qid] = {"country": country, "lat": lat, "lon": lon}
    return out


def probe_histogis(lat: float, lon: float, year: int) -> dict:
    when = f"{year:04d}-06-15"
    r = requests.get(HISTOGIS, params={
        "format": "json", "lat": str(lat), "lng": str(lon),
        "temp_start": when, "page_size": 50,
    }, headers=H_HG, timeout=45)
    if r.status_code != 200:
        return {"error": f"HTTP {r.status_code}", "polygons": []}
    data = r.json()
    polygons = []
    for f in data.get("features", []):
        p = f["properties"]
        polygons.append({
            "name": p.get("name", ""), "adm_name": p.get("adm_name", ""),
            "source_name": p.get("source_name", ""),
            "start_date": p.get("start_date", ""), "end_date": p.get("end_date", ""),
        })
    return {"count": data.get("count", 0), "polygons": polygons}


def filter_by_year(polygons: list[dict], year: int) -> list[dict]:
    target = date(year, 7, 1)
    out = []
    for p in polygons:
        sd, ed = p.get("start_date"), p.get("end_date")
        if not sd or not ed:
            continue
        try:
            sd_d, ed_d = date.fromisoformat(sd), date.fromisoformat(ed)
        except ValueError:
            continue
        if sd_d <= target <= ed_d:
            out.append(p)
    return out


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB)

    print("=== HistoGIS non-NL probe ===\n")
    pool = fetch_production_place_qids(conn)
    print(f"production_place QIDs in 1500-1919: {len(pool):,}")

    qids = [t[1] for t in pool]
    print(f"\nFetching country + coords from Wikidata in batches of {BATCH_SIZE}…")
    qid_meta: dict[str, dict] = {}
    for i in range(0, len(qids), BATCH_SIZE):
        batch = qids[i:i + BATCH_SIZE]
        try:
            res = query_wikidata_country_coords(batch)
            qid_meta.update(res)
        except Exception as e:
            print(f"  batch {i}: {e}")
        time.sleep(1.0)
        if i % (BATCH_SIZE * 5) == 0:
            print(f"  {i+len(batch)}/{len(qids)}  cumulative resolved: {len(qid_meta)}")

    print(f"\nresolved {len(qid_meta)}/{len(qids)} QIDs to (country, coords)")

    # build candidate pool: (vocab_id, qid, label, median_year, lat, lon, country)
    candidates_target = []
    candidates_excluded = {"non_target": 0, "no_meta": 0, "nl": 0}
    for vid, qid, label, year in pool:
        meta = qid_meta.get(qid)
        if not meta:
            candidates_excluded["no_meta"] += 1
            continue
        country = meta["country"]
        if country in EXCLUDED_COUNTRIES:
            candidates_excluded["nl"] += 1
            continue
        if country not in TARGET_COUNTRIES:
            candidates_excluded["non_target"] += 1
            continue
        candidates_target.append({
            "vocab_id": vid, "qid": qid, "label": label, "median_year": year,
            "lat": meta["lat"], "lon": meta["lon"],
            "country": country,
            "country_name": TARGET_COUNTRIES[country],
        })

    print(f"\ncandidate strata:")
    print(f"  target_countries: {len(candidates_target)}")
    for k, v in candidates_excluded.items():
        print(f"  excluded_{k}: {v}")

    # country histogram of target candidates
    from collections import Counter
    country_hist = Counter(c["country_name"] for c in candidates_target)
    print(f"\ntarget country histogram:")
    for cn, n in country_hist.most_common():
        print(f"  {cn:<15} {n}")

    rng = random.Random(SEED)
    sample = rng.sample(candidates_target, k=min(SAMPLE_SIZE, len(candidates_target)))
    print(f"\nsampling {len(sample)} for the HistoGIS probe (seed {SEED})\n")

    results = []
    for i, c in enumerate(sample, 1):
        try:
            res = probe_histogis(c["lat"], c["lon"], c["median_year"])
        except Exception as e:
            results.append({**c, "bucket": "error", "n_polygons_total": 0,
                            "n_polygons_at_year": 0, "n_substate_at_year": 0, "stack": "", "err": str(e)[:100]})
            print(f"  [{i:>2}/{len(sample)}] ERR {c['label']!r}: {e}")
            time.sleep(RATE_LIMIT_S)
            continue
        if "error" in res:
            results.append({**c, "bucket": "error", "n_polygons_total": 0,
                            "n_polygons_at_year": 0, "n_substate_at_year": 0, "stack": "", "err": res["error"]})
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
        results.append({**c, "bucket": bucket,
                        "n_polygons_total": len(all_polys),
                        "n_polygons_at_year": len(at_year),
                        "n_substate_at_year": len(substate),
                        "stack": stack, "err": ""})
        tag = {"match_full_stack": "★", "match_state_only": "·",
               "no_polygons_at_year": "○", "no_match": "·"}[bucket]
        print(f"  [{i:>2}/{len(sample)}] {tag} {bucket:<22}  total={len(all_polys):>2}  @{c['median_year']}={len(at_year):>2}  "
              f"{c['country_name']:<12} {c['label'][:25]!r:<27} → {stack[:70]}")
        time.sleep(RATE_LIMIT_S)

    # write csv
    csv_path = OUT_DIR / "non-nl-results.csv"
    keys = ["vocab_id", "qid", "label", "country", "country_name", "lat", "lon",
            "median_year", "bucket", "n_polygons_total", "n_polygons_at_year",
            "n_substate_at_year", "stack", "err"]
    with csv_path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=keys, extrasaction="ignore")
        w.writeheader()
        w.writerows(results)
    sample_csv = OUT_DIR / "non-nl-sample.csv"
    with sample_csv.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["vocab_id", "qid", "label", "country", "country_name", "lat", "lon", "median_year"], extrasaction="ignore")
        w.writeheader()
        w.writerows(sample)

    # buckets
    n_full = sum(1 for r in results if r["bucket"] == "match_full_stack")
    n_state = sum(1 for r in results if r["bucket"] == "match_state_only")
    n_no_year = sum(1 for r in results if r["bucket"] == "no_polygons_at_year")
    n_no = sum(1 for r in results if r["bucket"] == "no_match")
    n_err = sum(1 for r in results if r["bucket"] == "error")
    n_any = n_full + n_state
    avg_substate = (sum(r["n_substate_at_year"] for r in results) / max(1, n_full)) if n_full else 0

    # per-country breakdown
    from collections import defaultdict
    country_breakdown = defaultdict(lambda: {"full": 0, "state": 0, "no_year": 0, "no_match": 0, "n": 0})
    for r in results:
        cn = r["country_name"]
        country_breakdown[cn]["n"] += 1
        if r["bucket"] == "match_full_stack":
            country_breakdown[cn]["full"] += 1
        elif r["bucket"] == "match_state_only":
            country_breakdown[cn]["state"] += 1
        elif r["bucket"] == "no_polygons_at_year":
            country_breakdown[cn]["no_year"] += 1
        elif r["bucket"] == "no_match":
            country_breakdown[cn]["no_match"] += 1

    print(f"\nresults: {n_full} match_full_stack / {n_state} match_state_only / "
          f"{n_no_year} no_polygons_at_year / {n_no} no_match / {n_err} error")
    print(f"  any-match rate: {n_any}/{len(sample)} = {n_any*100/len(sample):.1f}%")
    print(f"  full-stack rate: {n_full}/{len(sample)} = {n_full*100/len(sample):.1f}%")
    print(f"  avg sub-state polys per full-stack match: {avg_substate:.1f}")

    md_lines = [f"""# HistoGIS where-was probe — non-NL Central European sample — {time.strftime('%Y-%m-%d')}

**Companion to `where-was-summary.md`** (which sampled the all-NL geocoded subset and got 0% full-stack).

**Sample:** {len(sample)} (vocab_id, qid, country, lat, lon, median_year) tuples drawn from places that:
- have a Wikidata QID
- are used as production_place on ≥1 artwork in 1500-1919
- have country in {{{', '.join(sorted(TARGET_COUNTRIES.values()))}}} (i.e. NOT Netherlands)

**Coords source:** Wikidata SPARQL (P625), not the v0.26 vocab DB lat/lon. This means the probe is independent of Stage 5.5 and tests the realistic full-stack rate on the population HistoGIS is built for.

**Funnel:**
- Place QIDs used as production_place 1500-1919: {len(pool):,}
- Resolved to (country, coords) via Wikidata: {len(qid_meta):,}
- In target country list: {len(candidates_target):,}
- Excluded (NL): {candidates_excluded['nl']:,}
- Excluded (other country, e.g. UK / FR / US / etc.): {candidates_excluded['non_target']:,}
- Excluded (no Wikidata coords or country): {candidates_excluded['no_meta']:,}

## Buckets

| Bucket | n | % |
|---|---:|---:|
| `match_full_stack` (sub-state polygon at the right time) | {n_full} | {n_full*100/len(sample):.1f}% |
| `match_state_only` (only kingdom/empire/etc.) | {n_state} | {n_state*100/len(sample):.1f}% |
| `no_polygons_at_year` (point covered, polygons miss the year) | {n_no_year} | {n_no_year*100/len(sample):.1f}% |
| `no_match` (point outside HistoGIS coverage) | {n_no} | {n_no*100/len(sample):.1f}% |
| `error` | {n_err} | {n_err*100/len(sample):.1f}% |

**Any-match: {n_any}/{len(sample)} = {n_any*100/len(sample):.1f}%**
**Full-stack: {n_full}/{len(sample)} = {n_full*100/len(sample):.1f}%**
Average sub-state polygons per full-stack match: {avg_substate:.1f}

## Per-country breakdown
"""]
    md_lines.append("| Country | n | full | state | no_year | no_match | full % |")
    md_lines.append("|---|---:|---:|---:|---:|---:|---:|")
    for cn in sorted(country_breakdown.keys(), key=lambda k: -country_breakdown[k]["n"]):
        b = country_breakdown[cn]
        full_pct = (b["full"] * 100 / b["n"]) if b["n"] else 0
        md_lines.append(f"| {cn} | {b['n']} | {b['full']} | {b['state']} | {b['no_year']} | {b['no_match']} | {full_pct:.0f}% |")
    md_lines.append(f"""

## Comparison to the all-NL baseline

| Sample | Any-match | Full-stack | Sub-state polys/match |
|---|---:|---:|---:|
| All-NL (random from geocoded subset) | 84.0% | **0.0%** | 0.0 |
| Non-NL Central European (this probe) | {n_any*100/len(sample):.1f}% | **{n_full*100/len(sample):.1f}%** | {avg_substate:.1f} |

## Verdict

The full-stack rate from this probe is the operationally relevant number — it's the
fraction of places where HistoGIS adds non-trivial diachronic admin signal beyond
country-level. {('Worth pursuing' if n_full*100/len(sample) >= 30 else ('Niche — Habsburg/German subset only' if n_full*100/len(sample) >= 10 else 'Skip'))} based on the standing decision rule (≥30% / 10-30% / <10%).

## Raw output

- `non-nl-sample.csv` — the 50 sampled places with country + coords
- `non-nl-results.csv` — per-row buckets and stacks
""")
    md = OUT_DIR / "non-nl-summary.md"
    md.write_text("\n".join(md_lines), encoding="utf-8")
    print(f"\nwrote {md.relative_to(ROOT)}")
    print(f"wrote {csv_path.relative_to(ROOT)}")
    print(f"wrote {sample_csv.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
