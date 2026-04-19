#!/usr/bin/env python3
"""Re-geocode non-areal rows whose inherited coord matches an areal ancestor's.

Addresses issue #262: rows like UK boroughs sharing England's (53.0, -2.0)
coord. Cascade: GeoNames -> Wikidata -> WHG, each with country context
derived from the broader_id chain.

Strategy (A -> C from issue #262):
  1. Tag every affected row with coord_method_detail='parent_fallback'.
  2. For each, derive a country QID (P17 value) by walking broader_id.
  3. Try GeoNames searchJSON with country ISO-2 filter. If hit, adopt
     coord + tag coord_method_detail='geonames_api' (authority).
  4. Else try Wikidata SPARQL with P17 country filter. If hit, tag
     'wikidata_p625' (authority).
  5. Else try WHG reconcile with P17 hint + Country: XX description
     post-filter. If hit, tag 'whg_reconciliation' (derived).
  6. Else leave coord as-is with 'parent_fallback' tag so downstream
     runtime filter (#256 + #262) can exclude.

Usage:
  python3 scripts/regeo_parent_fallback.py --dry-run     # preview
  python3 scripts/regeo_parent_fallback.py               # apply

Env:
  GEONAMES_USERNAME  (default: kintopp)
  WHG_TOKEN          (required for Phase 3)
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import sqlite3
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

# Load geocode_places as a module (filename has a hyphen? it doesn't — fine)
spec = importlib.util.spec_from_file_location(
    "geocode_places", SCRIPT_DIR / "geocode_places.py"
)
geocode_mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(geocode_mod)

import enrichment_methods as em  # noqa: E402

# Constants
GEONAMES_SEARCH = "http://api.geonames.org/searchJSON"
WIKIDATA_SPARQL = "https://query.wikidata.org/sparql"
USER_AGENT = "rijksmuseum-mcp-regeo-262/1.0"
WHG_RECONCILE_URL = "https://whgazetteer.org/reconcile"
WHG_PLACE_TYPE = "https://whgazetteer.org/static/whg_schema.jsonld#Place"
COUNTRY_RE = re.compile(r"Country:\s*([A-Z]{2})", re.IGNORECASE)

COUNTRY_QID_TO_ISO2 = geocode_mod.COUNTRY_QID_TO_ISO2

# Label-based country fallback for cases where _derive_country_qid fails because
# the broader_id chain has TGN-only entries (no Wikidata QID). Keys are lowercase
# English or Dutch labels for countries, values are (iso2, wikidata_country_qid).
# Only the countries that actually appear in Rijksmuseum's place hierarchy.
LABEL_TO_COUNTRY = {
    # UK constituent countries + aggregates — all use GB/Q145 for external lookup
    "england": ("GB", "Q145"), "engeland": ("GB", "Q145"),
    "scotland": ("GB", "Q145"), "schotland": ("GB", "Q145"),
    "wales": ("GB", "Q145"),
    "northern ireland": ("GB", "Q145"), "noord-ierland": ("GB", "Q145"),
    "great britain": ("GB", "Q145"), "groot-brittannië": ("GB", "Q145"),
    "united kingdom": ("GB", "Q145"), "verenigd koninkrijk": ("GB", "Q145"),
    # Main European countries (Rijksmuseum-heavy)
    "netherlands": ("NL", "Q55"), "nederland": ("NL", "Q55"),
    "france": ("FR", "Q142"), "frankrijk": ("FR", "Q142"),
    "germany": ("DE", "Q183"), "duitsland": ("DE", "Q183"),
    "italy": ("IT", "Q38"), "italië": ("IT", "Q38"),
    "spain": ("ES", "Q29"), "spanje": ("ES", "Q29"),
    "belgium": ("BE", "Q31"), "belgië": ("BE", "Q31"),
    "portugal": ("PT", "Q45"),
    "sweden": ("SE", "Q34"), "zweden": ("SE", "Q34"),
    "norway": ("NO", "Q20"), "noorwegen": ("NO", "Q20"),
    "denmark": ("DK", "Q35"), "denemarken": ("DK", "Q35"),
    "finland": ("FI", "Q33"),
    "austria": ("AT", "Q40"), "oostenrijk": ("AT", "Q40"),
    "switzerland": ("CH", "Q39"), "zwitserland": ("CH", "Q39"),
    "poland": ("PL", "Q36"), "polen": ("PL", "Q36"),
    "russia": ("RU", "Q159"), "rusland": ("RU", "Q159"),
    "ireland": ("IE", "Q27"), "ierland": ("IE", "Q27"),
    "greece": ("GR", "Q41"), "griekenland": ("GR", "Q41"),
    # Non-European (colonial context matters for Rijksmuseum)
    "united states": ("US", "Q30"), "verenigde staten": ("US", "Q30"),
    "china": ("CN", "Q148"),
    "japan": ("JP", "Q17"),
    "indonesia": ("ID", "Q252"), "indonesië": ("ID", "Q252"),
    "suriname": ("SR", "Q730"),
    "south africa": ("ZA", "Q258"), "zuid-afrika": ("ZA", "Q258"),
    "india": ("IN", "Q668"),
    "brazil": ("BR", "Q155"), "brazilië": ("BR", "Q155"),
    "mexico": ("MX", "Q96"),
    "turkey": ("TR", "Q43"), "turkije": ("TR", "Q43"),
    "canada": ("CA", "Q16"),
    "australia": ("AU", "Q408"), "australië": ("AU", "Q408"),
    "new zealand": ("NZ", "Q664"), "nieuw-zeeland": ("NZ", "Q664"),
}


def derive_country(vid, broader_by_id, wd_qid_by_id, labels_by_id, max_depth=8):
    """Walk broader_id chain to find country. Tries two paths:
    1. Ancestor has Wikidata QID present in COUNTRY_QID_TO_ISO2 (primary).
    2. Ancestor's label matches LABEL_TO_COUNTRY map (TGN-only fallback).
    Returns (iso2, country_qid) or (None, None).
    """
    current = vid
    for _ in range(max_depth):
        nxt = broader_by_id.get(current)
        if not nxt or nxt == current:
            return (None, None)
        current = nxt
        # Path 1: Wikidata QID
        qid = wd_qid_by_id.get(current)
        if qid and qid in COUNTRY_QID_TO_ISO2:
            return (COUNTRY_QID_TO_ISO2[qid], qid)
        # Path 2: label-based
        label = (labels_by_id.get(current) or "").strip().lower()
        if label in LABEL_TO_COUNTRY:
            iso2, qid = LABEL_TO_COUNTRY[label]
            return (iso2, qid)
    return (None, None)


# fetch_json reused from scripts/geocode_places.py (same signature + retry logic).

# Errors from HTTP calls that mean "API problem" rather than "no result".
# Narrow the catch so unexpected exceptions (KeyError on response shape, etc.)
# still surface as crashes.
_API_ERRORS = (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError)


def _name_similar(a: str, b: str) -> bool:
    """Permissive name-match guard against GeoNames false positives
    (e.g. 'Richmond upon Thames' -> 'Kingston upon Thames').
    Accepts: exact match, case-insensitive equality, one contains the other,
    or first-word equality when words are ≥4 chars. Rejects totally unrelated."""
    a_l = a.strip().lower()
    b_l = b.strip().lower()
    if a_l == b_l:
        return True
    # one contains the other (e.g. "Bath" ↔ "Bath, Somerset")
    if len(a_l) >= 4 and (a_l in b_l or b_l in a_l):
        return True
    # First-word equality when both first words are substantial
    a_first = a_l.split()[0] if a_l else ""
    b_first = b_l.split()[0] if b_l else ""
    if len(a_first) >= 5 and a_first == b_first:
        return True
    return False


def geonames_search(name, iso2, username):
    # Request P (populated places) AND A (admin areas) so boroughs/counties covered
    qs = urllib.parse.urlencode({
        "q": name, "country": iso2, "maxRows": 5,
        "username": username,
    })
    try:
        resp = geocode_mod.fetch_json(f"{GEONAMES_SEARCH}?{qs}")
        results = resp.get("geonames", []) or []
        # Iterate top-5 and pick the first that passes the name-similarity guard
        for r in results:
            matched_name = r.get("name", "")
            if _name_similar(name, matched_name):
                return (float(r["lat"]), float(r["lng"]), matched_name)
        return None  # no similar-enough match
    except _API_ERRORS as e:
        print(f"    [geonames err] {name}: {e}", file=sys.stderr)
        return None


def wikidata_search(name, country_qid):
    safe = name.replace('"', '\\"')
    # Try en label first, then nl
    for lang in ("en", "nl"):
        query = f'''
SELECT ?item ?coord WHERE {{
  ?item rdfs:label "{safe}"@{lang} ;
        wdt:P17 wd:{country_qid} ;
        wdt:P625 ?coord .
}} LIMIT 1
'''
        url = f"{WIKIDATA_SPARQL}?query={urllib.parse.quote(query)}"
        try:
            resp = geocode_mod.fetch_json(url, headers={"Accept": "application/sparql-results+json"})
            bindings = resp.get("results", {}).get("bindings", []) or []
            if bindings:
                coord = bindings[0].get("coord", {}).get("value", "")
                # "Point(lon lat)" -> parse
                m = re.match(r"Point\(([-\d.]+)\s+([-\d.]+)\)", coord)
                if m:
                    return (float(m.group(2)), float(m.group(1)), name)  # lat, lon
        except _API_ERRORS as e:
            print(f"    [wikidata err] {name}/{lang}: {e}", file=sys.stderr)
    return None


def whg_search(name, country_qid, country_iso2):
    token = os.environ.get("WHG_TOKEN", "").strip().strip('"').strip("'")
    if not token:
        return None
    # Build single-query request
    queries = {"q0": {
        "query": name,
        "type": WHG_PLACE_TYPE,
        "limit": 5,
        "properties": [{"pid": "P17", "v": country_qid}],
    }}
    body = urllib.parse.urlencode({"queries": json.dumps(queries)}).encode()
    req = urllib.request.Request(WHG_RECONCILE_URL, data=body, method="POST")
    req.add_header("User-Agent", USER_AGENT)
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read().decode())
    except _API_ERRORS as e:
        print(f"    [whg err] {name}: {e}", file=sys.stderr)
        return None

    results = (data.get("q0") or {}).get("result", []) or []
    results = [r for r in results if not r.get("id", "").startswith("dummy:")]
    # Layer B: post-filter by Country: XX in description
    for r in results:
        desc = r.get("description", "") or ""
        m = COUNTRY_RE.search(desc)
        if m and m.group(1).upper() == country_iso2:
            entity_id = r.get("id", "")
            # Need to extend to get coord — skip for now; return None if we can't get coord
            # Use WHG extend endpoint
            extend = {"ids": [entity_id], "properties": [{"id": "geometry"}]}
            extend_body = urllib.parse.urlencode({"extend": json.dumps(extend)}).encode()
            ereq = urllib.request.Request(WHG_RECONCILE_URL, data=extend_body, method="POST")
            ereq.add_header("User-Agent", USER_AGENT)
            ereq.add_header("Content-Type", "application/x-www-form-urlencoded")
            ereq.add_header("Authorization", f"Bearer {token}")
            try:
                with urllib.request.urlopen(ereq, timeout=60) as resp:
                    edata = json.loads(resp.read().decode())
                row = edata.get("rows", {}).get(entity_id, {})
                geom_list = row.get("geometry", []) or []
                if geom_list:
                    # WHG returns a GeoJSON-ish {str: "POINT(lon lat)"} or similar
                    g = geom_list[0]
                    gstr = g.get("str", "") if isinstance(g, dict) else str(g)
                    m2 = re.match(r"POINT\(([-\d.]+)\s+([-\d.]+)\)", gstr, re.IGNORECASE)
                    if m2:
                        return (float(m2.group(2)), float(m2.group(1)), r.get("name", ""))
            except _API_ERRORS as e:
                print(f"    [whg extend err] {entity_id}: {e}", file=sys.stderr)
            break  # only try top country-matched result
    return None


def identify_candidates(conn):
    """Non-areal rows sharing lat/lon with an areal row (excluding self-references)."""
    rows = conn.execute("""
        SELECT v.id, COALESCE(v.label_en, v.label_nl) AS name,
               v.label_en, v.label_nl, v.lat, v.lon, v.broader_id,
               v.coord_method, v.coord_method_detail
        FROM vocabulary v
        WHERE v.type='place' AND v.lat IS NOT NULL
          AND (v.is_areal = 0 OR v.is_areal IS NULL)
          AND EXISTS (
              SELECT 1 FROM vocabulary v2
              WHERE v2.type='place' AND v2.is_areal = 1
                AND v2.lat = v.lat AND v2.lon = v.lon AND v2.id != v.id
          )
    """).fetchall()
    return rows


def apply_update(conn, vid, lat, lon, tier, detail, dry_run):
    if dry_run:
        return
    conn.execute(
        "UPDATE vocabulary SET lat=?, lon=?, coord_method=?, coord_method_detail=? "
        "WHERE id=? AND type='place'",
        (lat, lon, tier, detail, vid),
    )


def tag_parent_fallback(conn, vid, dry_run):
    """Mark a row's existing coord as parent_fallback (leaves lat/lon as-is)."""
    if dry_run:
        return
    conn.execute(
        "UPDATE vocabulary SET coord_method=?, coord_method_detail=? "
        "WHERE id=? AND type='place'",
        (em.tier_for(em.PARENT_FALLBACK), em.PARENT_FALLBACK, vid),
    )


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--db", default="data/vocabulary.db")
    ap.add_argument("--dry-run", action="store_true",
                    help="Print proposed updates, don't apply.")
    ap.add_argument("--limit", type=int, default=0,
                    help="Limit to first N rows (for testing).")
    ap.add_argument("--skip-whg", action="store_true",
                    help="Skip WHG phase (for quick GeoNames+Wikidata test).")
    args = ap.parse_args()

    gn_user = os.environ.get("GEONAMES_USERNAME", "kintopp")
    has_whg = bool(os.environ.get("WHG_TOKEN", "").strip())
    if not has_whg and not args.skip_whg:
        print("WARNING: WHG_TOKEN not set — will skip WHG phase", file=sys.stderr)

    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row

    print("Building country derivation maps...", file=sys.stderr)
    broader_by_id, wd_qid_by_id = geocode_mod._build_country_derivation_maps(conn)
    # Labels for the label-based fallback path (LABEL_TO_COUNTRY)
    labels_by_id: dict[str, str] = {}
    for row in conn.execute(
        "SELECT id, COALESCE(label_en, label_nl) AS lbl FROM vocabulary "
        "WHERE type='place' AND (label_en IS NOT NULL OR label_nl IS NOT NULL)"
    ):
        labels_by_id[row[0]] = row[1]

    print("Identifying parent_fallback candidates...", file=sys.stderr)
    candidates = identify_candidates(conn)
    print(f"  {len(candidates):,} candidates found", file=sys.stderr)
    if args.limit:
        candidates = candidates[:args.limit]
        print(f"  --limit {args.limit}: processing first {len(candidates)}", file=sys.stderr)

    stats = {"geonames": 0, "wikidata": 0, "whg": 0, "no_country": 0,
             "fallback_kept": 0, "total": len(candidates)}

    for i, c in enumerate(candidates):
        vid = c["id"]
        name = c["name"]
        orig_lat, orig_lon = c["lat"], c["lon"]

        country_iso2, country_qid = derive_country(vid, broader_by_id, wd_qid_by_id, labels_by_id)

        prefix = f"  [{i+1:>3}/{len(candidates)}] {name!r:<30}"
        if not country_iso2:
            print(f"{prefix} no country context — keep parent_fallback")
            tag_parent_fallback(conn, vid, args.dry_run)
            stats["no_country"] += 1
            continue

        # Try GeoNames
        result = geonames_search(name, country_iso2, gn_user)
        if result:
            lat, lon, matched = result
            print(f"{prefix} GeoNames[{country_iso2}] → ({lat:.3f},{lon:.3f}) '{matched}'")
            apply_update(conn, vid, lat, lon, em.tier_for(em.GEONAMES_API), em.GEONAMES_API, args.dry_run)
            stats["geonames"] += 1
            time.sleep(0.6)
            continue
        time.sleep(0.3)

        # Try Wikidata SPARQL
        result = wikidata_search(name, country_qid)
        if result:
            lat, lon, matched = result
            print(f"{prefix} Wikidata[{country_qid}] → ({lat:.3f},{lon:.3f})")
            apply_update(conn, vid, lat, lon, em.tier_for(em.WIKIDATA_P625), em.WIKIDATA_P625, args.dry_run)
            stats["wikidata"] += 1
            time.sleep(0.5)
            continue
        time.sleep(0.3)

        # Try WHG
        if args.skip_whg or not has_whg:
            print(f"{prefix} no GN/WD match, skipping WHG → keep parent_fallback")
            tag_parent_fallback(conn, vid, args.dry_run)
            stats["fallback_kept"] += 1
            continue

        result = whg_search(name, country_qid, country_iso2)
        if result:
            lat, lon, matched = result
            print(f"{prefix} WHG[{country_iso2}] → ({lat:.3f},{lon:.3f}) '{matched}'")
            apply_update(conn, vid, lat, lon, em.tier_for(em.WHG_RECONCILIATION), em.WHG_RECONCILIATION, args.dry_run)
            stats["whg"] += 1
            time.sleep(0.6)
        else:
            print(f"{prefix} no match in any source → keep parent_fallback")
            tag_parent_fallback(conn, vid, args.dry_run)
            stats["fallback_kept"] += 1

    if not args.dry_run:
        conn.commit()
    conn.close()

    print()
    print("=" * 60)
    print(f"Summary ({'DRY RUN' if args.dry_run else 'APPLIED'}):")
    print("=" * 60)
    for k in ("geonames", "wikidata", "whg", "fallback_kept", "no_country"):
        print(f"  {k:<18} {stats[k]:>4}")
    print(f"  {'total':<18} {stats['total']:>4}")
    recovered = stats["geonames"] + stats["wikidata"] + stats["whg"]
    if stats["total"]:
        print(f"  recovery rate: {100*recovered/stats['total']:.1f}%")


if __name__ == "__main__":
    main()
