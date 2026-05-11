"""Classify the 131 TGN-no-coords gap by liveness, follow isReplacedBy
chains for obsolete IDs, and re-query for coords on the replacement.
"""
import csv, sqlite3, time
from pathlib import Path
import requests

DB = Path("data/vocabulary.db")
OUT = Path("data/audit/areal-classifier-extension/_tgn_chain_results.tsv")
ENDPOINT = "https://vocab.getty.edu/sparql.json"

def fetch_candidates(conn):
    return conn.execute("""
        SELECT v.id, vei.uri, v.label_en, v.label_nl
        FROM vocabulary v JOIN vocabulary_external_ids vei ON v.id = vei.vocab_id
        WHERE v.type='place' AND v.lat IS NULL AND vei.authority='tgn'
        ORDER BY v.id""").fetchall()

def query(sparql):
    r = requests.post(ENDPOINT,
        data={"query": sparql, "format": "application/sparql-results+json"},
        headers={"Accept": "application/sparql-results+json"}, timeout=60)
    r.raise_for_status()
    return r.json().get("results", {}).get("bindings", [])

def classify_and_redirect(uris):
    """For each URI, return (status, replacement_uri_or_None, lat, lon)."""
    values = " ".join(f"<{u}>" for u in uris)
    sparql = f"""
PREFIX wgs: <http://www.w3.org/2003/01/geo/wgs84_pos#>
PREFIX foaf: <http://xmlns.com/foaf/0.1/>
PREFIX dc: <http://purl.org/dc/terms/>
PREFIX gvp: <http://vocab.getty.edu/ontology#>
SELECT ?tgn ?obsolete ?replacement ?lat ?lon WHERE {{
  VALUES ?tgn {{ {values} }}
  OPTIONAL {{ ?tgn a gvp:ObsoleteSubject . BIND(true AS ?obsolete) }}
  OPTIONAL {{ ?tgn dc:isReplacedBy ?replacement }}
  OPTIONAL {{ ?tgn foaf:focus ?focus . ?focus wgs:lat ?lat ; wgs:long ?lon }}
}}"""
    return query(sparql)

def fetch_replacement_coords(rep_uris):
    """Query replacement TGN URIs for coords."""
    if not rep_uris:
        return {}
    values = " ".join(f"<{u}>" for u in rep_uris)
    sparql = f"""
PREFIX wgs: <http://www.w3.org/2003/01/geo/wgs84_pos#>
PREFIX foaf: <http://xmlns.com/foaf/0.1/>
SELECT ?tgn ?lat ?lon WHERE {{
  VALUES ?tgn {{ {values} }}
  ?tgn foaf:focus ?focus . ?focus wgs:lat ?lat ; wgs:long ?lon
}}"""
    out = {}
    for b in query(sparql):
        out[b["tgn"]["value"]] = (float(b["lat"]["value"]), float(b["lon"]["value"]))
    return out

def main():
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(DB) as conn:
        candidates = fetch_candidates(conn)
    print(f"candidates: {len(candidates)}")

    BATCH = 25
    classified = {}  # uri -> {obsolete, replacement, lat, lon}
    for i in range(0, len(candidates), BATCH):
        chunk = candidates[i:i+BATCH]
        uris = [r[1] for r in chunk]
        try:
            rows = classify_and_redirect(uris)
            for b in rows:
                u = b["tgn"]["value"]
                rec = classified.setdefault(u, {"obsolete": False, "replacement": None, "lat": None, "lon": None})
                if "obsolete" in b: rec["obsolete"] = True
                if "replacement" in b: rec["replacement"] = b["replacement"]["value"]
                if "lat" in b: rec["lat"] = float(b["lat"]["value"])
                if "lon" in b: rec["lon"] = float(b["lon"]["value"])
            print(f"  classify batch {i//BATCH+1}: {len(rows)} bindings")
        except Exception as e:
            print(f"  classify batch {i//BATCH+1} FAILED: {e}")
        time.sleep(0.3)

    # Now follow isReplacedBy chains for obsolete entries that have a replacement
    rep_uris = list({rec["replacement"] for rec in classified.values() if rec["replacement"]})
    print(f"\nobsolete entries with replacements: {len(rep_uris)}")
    rep_coords = {}
    for i in range(0, len(rep_uris), BATCH):
        chunk = rep_uris[i:i+BATCH]
        try:
            rep_coords.update(fetch_replacement_coords(chunk))
        except Exception as e:
            print(f"  replacement batch {i//BATCH+1} FAILED: {e}")
        time.sleep(0.3)
    print(f"replacement entries with coords: {len(rep_coords)}")

    # Write results
    with OUT.open("w", newline="") as f:
        w = csv.writer(f, delimiter="\t")
        w.writerow(["vocab_id", "tgn_uri", "label_en", "label_nl",
                    "live_lat", "live_lon", "obsolete", "replacement_uri",
                    "replacement_lat", "replacement_lon", "resolved"])
        live_hits = obs_resolved = obs_dead = live_no_coord = 0
        for vocab_id, uri, en, nl in candidates:
            rec = classified.get(uri, {})
            replacement = rec.get("replacement")
            rep_lat = rep_lon = None
            if replacement and replacement in rep_coords:
                rep_lat, rep_lon = rep_coords[replacement]
            resolved = ""
            if rec.get("lat"):
                resolved = "live_direct"; live_hits += 1
            elif rep_lat is not None:
                resolved = "via_replacement"; obs_resolved += 1
            elif rec.get("obsolete"):
                resolved = "obsolete_dead"; obs_dead += 1
            else:
                resolved = "live_no_coord"; live_no_coord += 1
            w.writerow([vocab_id, uri, en or "", nl or "",
                        rec.get("lat") or "", rec.get("lon") or "",
                        "1" if rec.get("obsolete") else "0",
                        replacement or "",
                        rep_lat if rep_lat is not None else "",
                        rep_lon if rep_lon is not None else "",
                        resolved])
        print()
        print(f"live, has coords:        {live_hits}")
        print(f"obsolete, replacement has coords: {obs_resolved}")
        print(f"obsolete, no replacement coords:  {obs_dead}")
        print(f"live, no coords in TGN:           {live_no_coord}")
        print(f"output: {OUT}")

if __name__ == "__main__":
    main()
