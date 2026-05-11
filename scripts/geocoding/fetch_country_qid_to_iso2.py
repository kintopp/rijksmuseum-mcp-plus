#!/usr/bin/env python3
"""Generate ``scripts/country_qid_to_iso2.tsv`` from Wikidata.

One-time script. The output TSV is committed and consumed by WI-3's
WHG country-context filter (#257 layer B) to compare a derived country
QID against WHG's ``description: "Country: XX"`` ISO-2 codes.

Query:
    SELECT ?country ?iso WHERE {
      ?country wdt:P31/wdt:P279* wd:Q6256 ;   # instance of country (or subclass)
               wdt:P297 ?iso .                # ISO 3166-1 alpha-2
    }

Subclass traversal (P31/P279*) catches e.g. Q3624078 (sovereign state),
Q112099 (island nation), Q6256 (country itself). Excludes historical
countries (Q3024240) which mostly have no ISO-2 anyway.

Run:
    ~/miniconda3/envs/embeddings/bin/python scripts/fetch_country_qid_to_iso2.py
"""
from __future__ import annotations

import sys
import urllib.parse
import urllib.request
from pathlib import Path

WIKIDATA_SPARQL = "https://query.wikidata.org/sparql"
OUT_PATH = Path(__file__).resolve().parent / "country_qid_to_iso2.tsv"

USER_AGENT = (
    "rijksmuseum-mcp-plus/0.24 (+https://github.com/kintopp/rijksmuseum-mcp-plus)"
)

QUERY = """
SELECT DISTINCT ?country ?iso WHERE {
  ?country wdt:P31/wdt:P279* wd:Q6256 ;
           wdt:P297 ?iso .
  FILTER(LANG(?iso) = "" || LANG(?iso) = "en")
}
ORDER BY ?iso
"""

# Constituent countries and historical entities that the main SPARQL query
# misses (they lack P297 but are conventionally represented by a parent
# ISO-2). Hand-curated — keep short and document rationale per row.
SUPPLEMENTS: dict[str, str] = {
    # United Kingdom's constituent countries (Q145 itself = GB, but data often
    # references the constituents directly).
    "Q21":  "GB",  # England
    "Q22":  "GB",  # Scotland
    "Q25":  "GB",  # Wales
    "Q26":  "GB",  # Northern Ireland
    # Kingdom of the Netherlands (Q29999) has ISO NL; the constituent country
    # Netherlands (Q55) does not carry P297 but is the more common reference.
    "Q55":  "NL",  # Netherlands (constituent)
    # Denmark Realm (Q35) vs Denmark constituent (Q756617). Q35 has DK.
    # Faroe Islands (Q4628, FO) + Greenland (Q223, GL) already in SPARQL.
    # Curaçao, Aruba, Sint Maarten — covered by P297 in SPARQL as own entries.
    # Historical entities with well-known modern equivalents (used in WHG
    # context for #257 only when the place's broader_id chain ends here).
    "Q2895":    "RU",  # USSR → Russia (best-effort, imperfect)
    "Q153136":  "RU",  # Soviet Union synonym
    "Q30988":   "CD",  # Zaire → DR Congo
}


def main() -> int:
    url = (
        f"{WIKIDATA_SPARQL}?{urllib.parse.urlencode({'query': QUERY, 'format': 'json'})}"
    )
    req = urllib.request.Request(url)
    req.add_header("Accept", "application/sparql-results+json")
    req.add_header("User-Agent", USER_AGENT)

    print(f"Querying {WIKIDATA_SPARQL} ...", file=sys.stderr)
    with urllib.request.urlopen(req, timeout=60) as resp:
        import json
        data = json.loads(resp.read().decode())

    bindings = data.get("results", {}).get("bindings", [])
    rows: list[tuple[str, str]] = []
    seen: set[str] = set()
    for b in bindings:
        uri = b.get("country", {}).get("value", "")
        iso = b.get("iso", {}).get("value", "").strip().upper()
        if not uri or not iso or len(iso) != 2:
            continue
        # Extract QID from URI
        qid = uri.rsplit("/", 1)[-1]
        if not qid.startswith("Q"):
            continue
        if qid in seen:
            continue
        seen.add(qid)
        rows.append((qid, iso))

    # Merge in supplements that the SPARQL query missed (constituent
    # countries, historical entities). Supplements override SPARQL on
    # collision, but report collisions for review.
    supplement_added = 0
    for qid, iso in SUPPLEMENTS.items():
        if qid in seen:
            print(f"  [supplement] {qid} already in SPARQL results — skipping",
                  file=sys.stderr)
            continue
        rows.append((qid, iso))
        seen.add(qid)
        supplement_added += 1

    rows.sort(key=lambda r: r[1])
    with OUT_PATH.open("w") as f:
        f.write("# Country QID → ISO 3166-1 alpha-2 code.\n")
        f.write("# Source: Wikidata SPARQL (P31/P279* Q6256 + P297) + "
                "hand-curated supplements.\n")
        f.write("# Used by scripts/geocode_places.py phase_3b_whg for #257 layer B.\n")
        f.write("# Format: qid<TAB>iso2\n")
        for qid, iso in rows:
            f.write(f"{qid}\t{iso}\n")

    print(f"Wrote {len(rows)} country QID → ISO-2 mappings to {OUT_PATH} "
          f"({supplement_added} from supplements)",
          file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
