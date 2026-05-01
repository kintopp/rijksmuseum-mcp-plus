"""Part 2 — RCE name-search rescue probe.

Goal: empirically test whether we can rescue ungeocoded building-shaped
Rijksmuseum vocab places that are NOT covered by Phase 1e bridge mode.

Data model caveat (discovered 2026-05-01): Rijksmonument records carry no
first-class name field. The descriptive text lives in `ceo:omschrijving`
(prose like "Pand onder zadeldakkap...") and `ceo:locatienaam` (municipality,
not building). So this probe tests the only realistic strategy:
substring-match the label against `omschrijving` text.

Sampling: 50 ungeocoded vocab places whose label_nl/label_en contains a
building-shaped Dutch substring (kerk, klooster, kasteel, fort, molen, brug,
toren, gemaal, kapel, abdij, hofje, poort, stadhuis, raadhuis, begijnhof,
pakhuis, waaggebouw). Excludes vocab_ids already covered by p359-qids.csv
(we want to test the *rescue* population, not bridge-covered places).

Output:
  offline/geo/rce-probe/name-search-results.csv  — per-row buckets
  offline/geo/rce-probe/name-search-summary.md   — short report
"""
from __future__ import annotations

import csv
import re
import sqlite3
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "data" / "vocabulary.db"
OUT_DIR = ROOT / "offline" / "geo" / "rce-probe"

RCE_SPARQL = "https://api.linkeddata.cultureelerfgoed.nl/datasets/rce/cho/sparql"
HEADERS = {
    "User-Agent": "rijksmuseum-mcp-plus rce-name-search-probe / arno.bosse@gmail.com",
    "Accept": "application/sparql-results+json",
}

# Dutch building-shaped substrings; matched case-insensitively in label_nl/label_en
BUILDING_TOKENS = [
    "kerk", "kapel", "klooster", "abdij", "begijnhof",
    "kasteel", "slot", "fort", "vesting", "schans", "wal",
    "molen", "brug", "toren", "gemaal",
    "stadhuis", "raadhuis", "rathaus",
    "pakhuis", "waag", "weeshuis", "gasthuis", "godshuis",
    "poort", "stadspoort", "gevangenpoort",
    "hofje", "synagoge",
]
BUILDING_RE = re.compile("|".join(re.escape(t) for t in BUILDING_TOKENS), re.IGNORECASE)

SAMPLE_SIZE = 50
RATE_LIMIT_S = 1.1


def fetch_candidates(conn: sqlite3.Connection, exclude_vocab_ids: set[str]) -> list[dict]:
    """Pull ungeocoded vocab places with a building-shaped label, exclude those
    already in p359-qids.csv (the bridge-covered set)."""
    rows = conn.execute(
        "SELECT v.id, v.label_en, v.label_nl, v.lat, v.lon "
        "FROM vocabulary v "
        "WHERE v.type='place' AND v.lat IS NULL "
        "  AND (v.label_nl IS NOT NULL OR v.label_en IS NOT NULL)"
    ).fetchall()
    candidates = []
    for r in rows:
        if r[0] in exclude_vocab_ids:
            continue
        label = r[1] or r[2]
        if not label or not BUILDING_RE.search(label):
            continue
        candidates.append({
            "vocab_id": r[0],
            "label_en": r[1] or "",
            "label_nl": r[2] or "",
            "label": label,
        })
    return candidates


def search_omschrijving(label: str) -> list[dict]:
    """Return up to 5 monument records whose `ceo:omschrijving` contains the label."""
    safe = label.replace('"', '\\"').replace("\\", "\\\\")
    query = (
        "PREFIX ceo: <https://linkeddata.cultureelerfgoed.nl/def/ceo#> "
        "PREFIX gs:  <http://www.opengis.net/ont/geosparql#> "
        "SELECT ?monument ?rmid ?text ?wkt ?locatienaam WHERE { "
        "  ?monument a ceo:Rijksmonument ; "
        "            ceo:cultuurhistorischObjectnummer ?rmid ; "
        "            ceo:heeftOmschrijving ?o ; "
        "            ceo:heeftGeometrie ?g ; "
        "            ceo:heeftLocatieAanduiding ?loc . "
        "  ?o ceo:omschrijving ?text . "
        "  ?loc ceo:locatienaam ?locatienaam . "
        "  ?g gs:asWKT ?wkt . "
        "  FILTER(STRSTARTS(STR(?wkt), \"Point\")) "
        f"  FILTER(CONTAINS(LCASE(STR(?text)), LCASE(\"{safe}\"))) "
        "} LIMIT 5"
    )
    r = requests.post(RCE_SPARQL, data={"query": query}, headers=HEADERS, timeout=45)
    if r.status_code != 200:
        return []
    out = []
    pt_re = re.compile(r"^\s*Point\s*\(\s*([-\d.]+)\s+([-\d.]+)\s*\)\s*$", re.IGNORECASE)
    for b in r.json().get("results", {}).get("bindings", []):
        m = pt_re.match(b.get("wkt", {}).get("value", ""))
        if not m:
            continue
        out.append({
            "rmid": b.get("rmid", {}).get("value", ""),
            "uri": b.get("monument", {}).get("value", ""),
            "lat": float(m.group(2)),
            "lon": float(m.group(1)),
            "locatienaam": b.get("locatienaam", {}).get("value", ""),
            "text_excerpt": b.get("text", {}).get("value", "")[:120],
        })
    return out


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB)

    # exclude bridge-covered vocab IDs
    p359 = OUT_DIR / "p359-qids.csv"
    exclude = set()
    if p359.exists():
        with p359.open() as f:
            r = csv.reader(f)
            next(r)  # header
            exclude = {row[0] for row in r if row[0]}
    print(f"excluding {len(exclude)} bridge-covered vocab IDs")

    candidates = fetch_candidates(conn, exclude)
    print(f"building-shaped ungeocoded candidates: {len(candidates):,}")

    import random
    rng = random.Random(42)
    sample = rng.sample(candidates, k=min(SAMPLE_SIZE, len(candidates)))
    print(f"sampling {len(sample)} for the probe (seed=42)\n")

    results = []
    for i, c in enumerate(sample, 1):
        try:
            hits = search_omschrijving(c["label"])
        except Exception as e:
            results.append({**c, "bucket": "error", "n_hits": 0, "first_rmid": "", "first_locatienaam": "", "first_text": str(e)[:120]})
            print(f"  [{i:>2}/{len(sample)}] ERROR  {c['label']!r}: {e}")
            time.sleep(RATE_LIMIT_S)
            continue

        if not hits:
            bucket = "no_match"
            results.append({**c, "bucket": bucket, "n_hits": 0, "first_rmid": "", "first_locatienaam": "", "first_text": ""})
        else:
            bucket = "name_match_found"
            first = hits[0]
            results.append({
                **c,
                "bucket": bucket,
                "n_hits": len(hits),
                "first_rmid": first["rmid"],
                "first_uri": first["uri"],
                "first_lat": first["lat"],
                "first_lon": first["lon"],
                "first_locatienaam": first["locatienaam"],
                "first_text": first["text_excerpt"],
            })
        tag = "✓" if bucket == "name_match_found" else "·"
        print(f"  [{i:>2}/{len(sample)}] {tag} {len(hits)} hits  {c['label']!r}"
              + (f"  → {hits[0]['locatienaam']} ({hits[0]['rmid']})" if hits else ""))
        time.sleep(RATE_LIMIT_S)

    # write csv
    csv_path = OUT_DIR / "name-search-results.csv"
    keys = ["vocab_id", "label", "label_en", "label_nl", "bucket", "n_hits",
            "first_rmid", "first_uri", "first_lat", "first_lon",
            "first_locatienaam", "first_text"]
    with csv_path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=keys, extrasaction="ignore")
        w.writeheader()
        w.writerows(results)
    print(f"\nwrote {csv_path.relative_to(ROOT)}")

    # summary
    n_match = sum(1 for r in results if r["bucket"] == "name_match_found")
    n_nomatch = sum(1 for r in results if r["bucket"] == "no_match")
    n_err = sum(1 for r in results if r["bucket"] == "error")
    print(f"\nresults: {n_match} name_match_found / {n_nomatch} no_match / {n_err} error / {len(results)} total")

    # generate summary report
    md = OUT_DIR / "name-search-summary.md"
    md.write_text(f"""# RCE name-search rescue probe — {time.strftime('%Y-%m-%d')}

**Sample:** {len(sample)} ungeocoded building-shaped vocab labels (excludes the {len(exclude)} bridge-covered IDs from `p359-qids.csv`).
**Building-shape filter:** label contains one of `{', '.join(BUILDING_TOKENS)}` (case-insensitive).
**Search strategy:** substring-match against `ceo:omschrijving` (the only descriptive text field on Rijksmonument records — there is no first-class building-name field).
**Rate limit:** {RATE_LIMIT_S} s between SPARQL calls.

## Buckets

| Bucket | n | % |
|---|---:|---:|
| `name_match_found` | {n_match} | {n_match*100/len(sample):.1f}% |
| `no_match` | {n_nomatch} | {n_nomatch*100/len(sample):.1f}% |
| `error` | {n_err} | {n_err*100/len(sample):.1f}% |

## Interpretation

- Building-shaped candidate population in our DB: **{len(candidates):,}** ungeocoded places.
- Name-match yield rate from this sample: **{n_match*100/len(sample):.1f}%**.
- Projected addressable rescue: ~{int(len(candidates) * n_match / len(sample))} additional matches across the full population, *if* this sample is representative.

## Caveat — `omschrijving` ≠ name

The `ceo:omschrijving` field is descriptive prose ("Pand onder zadeldakkap..."), not a building name. Matches are opportunistic — they happen when the label happens to be mentioned in the description. False-positive rate could be elevated; each match needs human review before applying.

## Verdict (yield-driven)

- **>20% match rate**: name-search arm worth investing engineering time in (~1-2K rescues).
- **5-20%**: marginal; consider only if all bridge-mode rescues exhausted.
- **<5%**: skip; the data model doesn't support the use case.

Current rate **{n_match*100/len(sample):.1f}%** → {('worth pursuing' if n_match*100/len(sample) >= 20 else ('marginal' if n_match*100/len(sample) >= 5 else 'skip'))}.
""", encoding="utf-8")
    print(f"wrote {md.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
