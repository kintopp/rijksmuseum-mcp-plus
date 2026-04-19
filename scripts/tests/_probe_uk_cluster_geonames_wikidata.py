#!/usr/bin/env python3
"""Feasibility probe for #262 revised C strategy: do GeoNames + Wikidata
recover the 30 famous UK cities that WHG couldn't?

Tests each of the 30 names against:
  - GeoNames searchJSON with country=GB filter
  - Wikidata SPARQL with P17=Q145 + label exact match
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.parse
import urllib.request

GEONAMES_API = "http://api.geonames.org/searchJSON"
WIKIDATA_SPARQL = "https://query.wikidata.org/sparql"
USER_AGENT = "rijksmuseum-mcp-262probe/1.0"

# The 30 names from Layer A+B probe that returned no GB candidate
UNRECOVERABLE = [
    "Cambridge", "Oxford", "Saint Ives", "Dedham", "Shipston-on-Stour",
    "Beachy Head", "Tiverton", "Hexham", "England", "Birmingham",
    "Falmouth", "Windsor", "Salisbury", "Norwich", "Liverpool",
    "Sheffield", "Plymouth", "Greenwich", "Kendal", "Leicester",
    "Burslem", "Kew", "Ludlow", "Glastonbury", "Woodstock",
    "Chichester", "Halifax", "Truro", "Engeland",
]


def fetch_json(url, headers=None, retries=3):
    headers = headers or {}
    headers.setdefault("User-Agent", USER_AGENT)
    req = urllib.request.Request(url, headers=headers)
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return json.loads(resp.read().decode())
        except Exception as e:
            if attempt == retries - 1:
                raise
            time.sleep(2 ** (attempt + 1))


def geonames_search(name, username):
    qs = urllib.parse.urlencode({
        "q": name,
        "country": "GB",
        "maxRows": 3,
        "username": username,
    })
    return fetch_json(f"{GEONAMES_API}?{qs}")


def wikidata_search(name):
    # Use exact label match on en-GB / nl labels with P17 country = UK (Q145)
    safe = name.replace('"', '\\"')
    query = f'''
SELECT ?item ?itemLabel ?coord WHERE {{
  ?item rdfs:label "{safe}"@en ;
        wdt:P17 wd:Q145 ;
        wdt:P625 ?coord .
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en". }}
}} LIMIT 3
'''
    url = f"{WIKIDATA_SPARQL}?query={urllib.parse.quote(query)}"
    return fetch_json(url, headers={"Accept": "application/sparql-results+json"})


def main():
    gn_user = os.environ.get("GEONAMES_USERNAME", "kintopp")

    print("=" * 90)
    print(f"Probing {len(UNRECOVERABLE)} 'WHG-unrecoverable' UK names against GeoNames + Wikidata")
    print("=" * 90)

    gn_hits, wd_hits = [], []
    print(f"\n{'name':<25} | {'GeoNames (country=GB)':<40} | Wikidata SPARQL (P17=Q145)")
    print("-" * 110)

    for name in UNRECOVERABLE:
        # GeoNames
        gn_label = "—"
        try:
            gn_resp = geonames_search(name, gn_user)
            gn_results = gn_resp.get("geonames", []) or []
            if gn_results:
                top = gn_results[0]
                gn_label = f"{top.get('name','')} [{top.get('fcl','')}.{top.get('fcode','')}] ({top.get('lat','')[:6]},{top.get('lng','')[:6]})"
                gn_hits.append(name)
        except Exception as e:
            gn_label = f"ERR: {str(e)[:30]}"

        # Wikidata
        wd_label = "—"
        try:
            wd_resp = wikidata_search(name)
            bindings = wd_resp.get("results", {}).get("bindings", []) or []
            if bindings:
                first = bindings[0]
                wd_label = f"{first.get('itemLabel', {}).get('value', '?')} {first.get('coord', {}).get('value', '')[:40]}"
                wd_hits.append(name)
        except Exception as e:
            wd_label = f"ERR: {str(e)[:30]}"

        print(f"{name:<25} | {gn_label:<40} | {wd_label}")
        time.sleep(1.0)  # be polite to both endpoints

    print()
    print("=" * 90)
    print(f"Coverage of the 30 WHG-unrecoverable rows:")
    print(f"  GeoNames returned a GB result:  {len(gn_hits):>2} / {len(UNRECOVERABLE)} ({100*len(gn_hits)/len(UNRECOVERABLE):.0f}%)")
    print(f"  Wikidata returned a GB result:  {len(wd_hits):>2} / {len(UNRECOVERABLE)} ({100*len(wd_hits)/len(UNRECOVERABLE):.0f}%)")
    union = set(gn_hits) | set(wd_hits)
    print(f"  Union (either source recovers): {len(union):>2} / {len(UNRECOVERABLE)} ({100*len(union)/len(UNRECOVERABLE):.0f}%)")

    missing = [n for n in UNRECOVERABLE if n not in union]
    if missing:
        print(f"\n  Names neither GeoNames nor Wikidata recovers ({len(missing)}):")
        for n in missing:
            print(f"    - {n}")


if __name__ == "__main__":
    main()
