#!/usr/bin/env python3
"""One-off probe: fetch per-entity TGN .rdf and extract lat/long/placetype/label.

Validates whether the static RDF dereferencing path is a viable substitute
for the broken vocab.getty.edu/sparql endpoint. Run from repo root.
"""
import sqlite3
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET

UA = "rijksmuseum-mcp-geocoder/2.0 (https://github.com/kintopp/rijksmuseum-mcp-plus)"
NS = {
    "wgs":   "http://www.w3.org/2003/01/geo/wgs84_pos#",
    "skos":  "http://www.w3.org/2004/02/skos/core#",
    "gvp":   "http://vocab.getty.edu/ontology#",
    "rdf":   "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
}

def fetch_rdf(tgn_id: str) -> tuple[int, bytes, float]:
    url = f"http://vocab.getty.edu/tgn/{tgn_id}.rdf"
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "application/rdf+xml",
        "Accept-Encoding": "gzip",
    })
    t0 = time.perf_counter()
    with urllib.request.urlopen(req, timeout=20) as resp:
        body = resp.read()
        if resp.headers.get("Content-Encoding") == "gzip":
            import gzip
            body = gzip.decompress(body)
        return resp.status, body, time.perf_counter() - t0

def parse(body: bytes) -> dict:
    root = ET.fromstring(body)
    out = {"lat": None, "lon": None, "label_en": None, "placetype": None,
           "broader": None, "areal_hint": False}
    for elem in root.iter():
        tag = elem.tag.split("}")[-1] if "}" in elem.tag else elem.tag
        ns = elem.tag.split("}")[0][1:] if "}" in elem.tag else ""
        if tag == "lat" and ns == NS["wgs"]:
            out["lat"] = float(elem.text)
        elif tag == "long" and ns == NS["wgs"]:
            out["lon"] = float(elem.text)
        elif tag == "prefLabel" and ns == NS["skos"]:
            if elem.get("{http://www.w3.org/XML/1998/namespace}lang") == "en":
                out["label_en"] = elem.text
        elif tag == "placeTypePreferred" and ns == NS["gvp"]:
            ref = elem.get(f"{{{NS['rdf']}}}resource", "")
            if "/aat/" in ref:
                out["placetype"] = "aat:" + ref.rsplit("/", 1)[-1]
        elif tag == "broader" and ns == NS["gvp"]:
            ref = elem.get(f"{{{NS['rdf']}}}resource", "")
            if "/tgn/" in ref:
                out["broader"] = "tgn:" + ref.rsplit("/", 1)[-1]
    # Areal hint: AdminPlaceConcept rdf:type
    for elem in root.iter(f"{{{NS['rdf']}}}type"):
        ref = elem.get(f"{{{NS['rdf']}}}resource", "")
        if ref.endswith("AdminPlaceConcept"):
            out["areal_hint"] = True
    return out

def main():
    conn = sqlite3.connect("data/vocabulary.db")
    rows = conn.execute("""
        SELECT v.id AS vocab_id, vei.id AS tgn_id, v.label_en, v.lat, v.lon
        FROM vocabulary_external_ids vei
        JOIN vocabulary v ON v.id = vei.vocab_id
        WHERE vei.authority = 'tgn' AND v.type = 'place'
        ORDER BY (v.lat IS NULL) DESC, random()
        LIMIT 10
    """).fetchall()
    conn.close()

    print(f"{'tgn_id':<10}  {'http':<5}  {'kb':<5}  {'ms':<5}  "
          f"{'lat':<10}  {'lon':<10}  {'placetype':<14}  "
          f"{'broader':<13}  areal  label  (db_lat,db_lon)")
    print("-" * 130)
    total_bytes = 0
    total_time = 0.0
    for vocab_id, tgn, db_label, db_lat, db_lon in rows:
        try:
            status, body, dt = fetch_rdf(tgn)
            total_bytes += len(body)
            total_time += dt
            info = parse(body)
            print(f"{tgn:<10}  {status:<5}  {len(body)//1024:<5}  "
                  f"{int(dt*1000):<5}  "
                  f"{str(info['lat']):<10}  {str(info['lon']):<10}  "
                  f"{(info['placetype'] or ''):<14}  "
                  f"{(info['broader'] or ''):<13}  "
                  f"{'Y' if info['areal_hint'] else 'n':<5}  "
                  f"{(info['label_en'] or db_label or '')[:24]:<24}  "
                  f"({db_lat},{db_lon})")
        except Exception as e:
            print(f"{tgn:<10}  ERR    {e}")
    n = len(rows)
    print(f"\nTotals: {n} fetches, {total_bytes/1024:.1f} KB, "
          f"{total_time:.2f}s elapsed → {total_time/n*1000:.0f} ms/req avg, "
          f"{total_bytes/n/1024:.1f} KB/req avg")

if __name__ == "__main__":
    main()
