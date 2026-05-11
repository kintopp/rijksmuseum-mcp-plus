"""For each of the 4 outlier places, search Wikidata via the REST search
API for candidate entities, then fetch each candidate's P625 (coord),
P31 (instance of), and P17 (country) so we can compare against the
expected geographic context from the DB.

This is a search/triage tool — it surfaces candidates with enough metadata
for a human (or me, in the next turn) to pick the right one. Does not
write to the DB.
"""
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

USER_AGENT = ("rijksmuseum-mcp-plus/0.30 "
              "(https://github.com/kintopp/rijksmuseum-mcp-plus; "
              "arno.bosse@gmail.com)")

# (label_to_search, language, expected geographic context, current TGN ID for cross-ref)
TARGETS = [
    {"vocab_id": "130561", "search": "Kew", "lang": "en",
     "context": "West London suburb (Kew Gardens area), UK",
     "current_tgn": "4005652"},
    {"vocab_id": "130898", "search": "Sint-Nicolaaskerk", "lang": "nl",
     "context": "St Nicholas church in Arnhem, Netherlands",
     "current_tgn": "7006876"},
    {"vocab_id": "2301118", "search": "Haarlemmermeer", "lang": "nl",
     "context": "Municipality / former lake near Amsterdam, Netherlands",
     "current_tgn": "1112001"},
    # Try the corrected spelling — 'Boxburghshire' is almost certainly a typo
    # for 'Roxburghshire', a historical county in southern Scotland.
    {"vocab_id": "2304716", "search": "Roxburghshire", "lang": "en",
     "context": "Historical county in southern Scotland, UK",
     "current_tgn": "7002444"},
]


def http_get_json(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def wikidata_search(label: str, lang: str, limit: int = 5) -> list[dict]:
    params = {
        "action": "wbsearchentities", "search": label, "language": lang,
        "format": "json", "limit": str(limit), "type": "item",
    }
    url = f"https://www.wikidata.org/w/api.php?{urllib.parse.urlencode(params)}"
    data = http_get_json(url)
    return data.get("search", [])


def fetch_entity_brief(qid: str) -> dict:
    url = f"https://www.wikidata.org/wiki/Special:EntityData/{qid}.json"
    data = http_get_json(url)
    entities = data.get("entities", {}) or {}
    if not entities:
        return {}
    ent = entities[next(iter(entities))]
    out = {
        "qid": qid,
        "labels": {lang: ent.get("labels", {}).get(lang, {}).get("value")
                   for lang in ("en", "nl")},
        "descriptions": {lang: ent.get("descriptions", {}).get(lang, {}).get("value")
                         for lang in ("en", "nl")},
    }
    claims = ent.get("claims", {}) or {}
    # P625 = coordinate location
    coord = None
    for c in claims.get("P625", []):
        if c.get("rank") in ("preferred", "normal"):
            v = ((c.get("mainsnak") or {}).get("datavalue") or {}).get("value") or {}
            if "latitude" in v and "longitude" in v:
                coord = (v["latitude"], v["longitude"])
                break
    out["coord"] = coord
    # P31 = instance of
    p31 = []
    for c in claims.get("P31", [])[:5]:
        v = ((c.get("mainsnak") or {}).get("datavalue") or {}).get("value") or {}
        if v.get("id"):
            p31.append(v["id"])
    out["instance_of"] = p31
    # P17 = country
    p17 = []
    for c in claims.get("P17", [])[:3]:
        v = ((c.get("mainsnak") or {}).get("datavalue") or {}).get("value") or {}
        if v.get("id"):
            p17.append(v["id"])
    out["country"] = p17
    # P1667 = TGN ID
    p1667 = []
    for c in claims.get("P1667", [])[:3]:
        v = ((c.get("mainsnak") or {}).get("datavalue") or {}).get("value")
        if v:
            p1667.append(v)
    out["tgn_id"] = p1667
    # P1566 = GeoNames ID
    p1566 = []
    for c in claims.get("P1566", [])[:3]:
        v = ((c.get("mainsnak") or {}).get("datavalue") or {}).get("value")
        if v:
            p1566.append(v)
    out["geonames_id"] = p1566
    return out


def main():
    for t in TARGETS:
        print(f"\n{'═'*78}")
        print(f"  vocab_id={t['vocab_id']}  search={t['search']!r} ({t['lang']})")
        print(f"  expected: {t['context']}")
        print(f"  DB current TGN: {t['current_tgn']}")
        print('═'*78)
        try:
            results = wikidata_search(t["search"], t["lang"], limit=8)
        except Exception as exc:
            print(f"  search failed: {exc}"); continue
        print(f"  Wikidata search returned {len(results)} candidate(s):")
        for i, r in enumerate(results, 1):
            qid = r.get("id")
            label = r.get("label", "")
            desc = r.get("description", "") or ""
            print(f"\n  [{i}] {qid}  {label}")
            print(f"      desc: {desc[:120]}")
            try:
                ent = fetch_entity_brief(qid)
                time.sleep(0.6)
            except Exception as exc:
                print(f"      brief fetch failed: {exc}")
                continue
            coord = ent.get("coord")
            if coord:
                print(f"      P625 coord: ({coord[0]:.4f}, {coord[1]:.4f})")
            if ent.get("instance_of"):
                print(f"      P31 instance_of: {ent['instance_of']}")
            if ent.get("country"):
                print(f"      P17 country: {ent['country']}")
            tgn = ent.get("tgn_id") or []
            if tgn:
                marker = "  ⭐ MATCHES DB TGN" if t["current_tgn"] in tgn else ""
                print(f"      P1667 TGN: {tgn}{marker}")
            if ent.get("geonames_id"):
                print(f"      P1566 GeoNames: {ent['geonames_id']}")
        time.sleep(0.6)


if __name__ == "__main__":
    main()
