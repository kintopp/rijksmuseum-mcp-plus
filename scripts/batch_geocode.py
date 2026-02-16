#!/usr/bin/env python3
"""
Batch geocode depicted places using external IDs already in the vocabulary DB.

Strategy:
  1. Wikidata SPARQL — batch query P625 coordinates for QIDs (fast, ~500 QIDs/query)
  2. GeoNames API — resolve GeoNames IDs to coordinates (fast, bulk JSON)
  3. Getty TGN SPARQL — batch query coordinates from Getty Thesaurus

Usage:
    python3 scripts/batch_geocode.py [--db PATH] [--dry-run]
"""

import argparse
import json
import sqlite3
import sys
import time
import urllib.request
import urllib.parse
from pathlib import Path

WIKIDATA_SPARQL = "https://query.wikidata.org/sparql"
GETTY_SPARQL = "http://vocab.getty.edu/sparql"
GEONAMES_API = "http://api.geonames.org/getJSON"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def fetch_json(url: str, headers: dict | None = None) -> dict:
    """Simple HTTP GET → JSON."""
    req = urllib.request.Request(url, headers=headers or {})
    req.add_header("User-Agent", "rijksmuseum-mcp-geocoder/1.0")
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode())


def sparql_query(endpoint: str, query: str) -> list[dict]:
    """Execute a SPARQL query and return results bindings."""
    params = urllib.parse.urlencode({"query": query, "format": "json"})
    url = f"{endpoint}?{params}"
    data = fetch_json(url, {"Accept": "application/sparql-results+json"})
    return data.get("results", {}).get("bindings", [])


# ---------------------------------------------------------------------------
# 1. Wikidata batch geocode
# ---------------------------------------------------------------------------

def extract_qid(uri: str) -> str | None:
    """Extract QID from Wikidata URI."""
    # Handles both http://www.wikidata.org/entity/Q123 and https://www.wikidata.org/wiki/Q123
    for prefix in ("http://www.wikidata.org/entity/", "https://www.wikidata.org/entity/",
                    "http://www.wikidata.org/wiki/", "https://www.wikidata.org/wiki/"):
        if uri.startswith(prefix):
            return uri[len(prefix):]
    return None


def geocode_wikidata(places: list[dict], batch_size: int = 400) -> dict[str, tuple[float, float]]:
    """
    Batch geocode places via Wikidata SPARQL P625 (coordinate location).
    Returns {vocab_id: (lat, lon)}.
    """
    # Build QID → vocab_id mapping
    qid_to_vocab: dict[str, list[str]] = {}
    for p in places:
        qid = extract_qid(p["external_id"])
        if qid:
            qid_to_vocab.setdefault(qid, []).append(p["id"])

    if not qid_to_vocab:
        return {}

    print(f"Wikidata: {len(qid_to_vocab)} unique QIDs to geocode", file=sys.stderr)

    results: dict[str, tuple[float, float]] = {}
    qids = list(qid_to_vocab.keys())

    for i in range(0, len(qids), batch_size):
        batch = qids[i:i + batch_size]
        values = " ".join(f"wd:{qid}" for qid in batch)

        query = f"""
        SELECT ?item ?lat ?lon WHERE {{
          VALUES ?item {{ {values} }}
          ?item wdt:P625 ?coord .
          BIND(geof:latitude(?coord) AS ?lat)
          BIND(geof:longitude(?coord) AS ?lon)
        }}
        """

        try:
            bindings = sparql_query(WIKIDATA_SPARQL, query)
            for b in bindings:
                item_uri = b["item"]["value"]
                lat = float(b["lat"]["value"])
                lon = float(b["lon"]["value"])
                qid = item_uri.rsplit("/", 1)[-1]
                for vocab_id in qid_to_vocab.get(qid, []):
                    results[vocab_id] = (lat, lon)

            print(f"  Batch {i // batch_size + 1}: {len(batch)} QIDs → "
                  f"{len(bindings)} with coords", file=sys.stderr)
        except Exception as e:
            print(f"  Batch {i // batch_size + 1} error: {e}", file=sys.stderr)

        # Wikidata rate limit: be polite
        time.sleep(2)

    print(f"Wikidata: resolved {len(results)} places", file=sys.stderr)
    return results


# ---------------------------------------------------------------------------
# 2. GeoNames batch geocode
# ---------------------------------------------------------------------------

def extract_geonames_id(uri: str) -> str | None:
    """Extract numeric GeoNames ID from URI."""
    # http://sws.geonames.org/2751272/ or https://sws.geonames.org/2749440
    for prefix in ("http://sws.geonames.org/", "https://sws.geonames.org/",
                    "http://www.geonames.org/", "https://www.geonames.org/"):
        if uri.startswith(prefix):
            return uri[len(prefix):].rstrip("/")
    return None


def geocode_geonames(places: list[dict]) -> dict[str, tuple[float, float]]:
    """
    Geocode places via GeoNames JSON API.
    Free tier: 1000 req/hour, 1 req at a time.
    """
    gn_to_vocab: dict[str, list[str]] = {}
    for p in places:
        gn_id = extract_geonames_id(p["external_id"])
        if gn_id and gn_id.isdigit():
            gn_to_vocab.setdefault(gn_id, []).append(p["id"])

    if not gn_to_vocab:
        return {}

    print(f"GeoNames: {len(gn_to_vocab)} IDs to geocode", file=sys.stderr)

    results: dict[str, tuple[float, float]] = {}
    for i, gn_id in enumerate(gn_to_vocab):
        try:
            url = f"{GEONAMES_API}?geonameId={gn_id}&username=demo"
            data = fetch_json(url)
            if "lat" in data and "lng" in data:
                lat = float(data["lat"])
                lon = float(data["lng"])
                for vocab_id in gn_to_vocab[gn_id]:
                    results[vocab_id] = (lat, lon)
        except Exception as e:
            print(f"  GeoNames {gn_id} error: {e}", file=sys.stderr)

        # Rate limit: ~1 req/sec for free tier
        if (i + 1) % 100 == 0:
            print(f"  ... {i + 1}/{len(gn_to_vocab)} done", file=sys.stderr)
        time.sleep(0.5)

    print(f"GeoNames: resolved {len(results)} places", file=sys.stderr)
    return results


# ---------------------------------------------------------------------------
# 3. Getty TGN SPARQL
# ---------------------------------------------------------------------------

def extract_tgn_id(uri: str) -> str | None:
    """Extract TGN ID from Getty URI."""
    # http://vocab.getty.edu/tgn/7011405
    prefix = "http://vocab.getty.edu/tgn/"
    if uri.startswith(prefix):
        return uri[len(prefix):]
    return None


def geocode_getty(places: list[dict], batch_size: int = 200) -> dict[str, tuple[float, float]]:
    """
    Batch geocode places via Getty TGN SPARQL.
    """
    tgn_to_vocab: dict[str, list[str]] = {}
    for p in places:
        tgn_id = extract_tgn_id(p["external_id"])
        if tgn_id:
            tgn_to_vocab.setdefault(tgn_id, []).append(p["id"])

    if not tgn_to_vocab:
        return {}

    print(f"Getty TGN: {len(tgn_to_vocab)} IDs to geocode", file=sys.stderr)

    results: dict[str, tuple[float, float]] = {}
    tgn_ids = list(tgn_to_vocab.keys())

    for i in range(0, len(tgn_ids), batch_size):
        batch = tgn_ids[i:i + batch_size]
        values = " ".join(f"tgn:{tid}" for tid in batch)

        query = f"""
        PREFIX tgn: <http://vocab.getty.edu/tgn/>
        PREFIX schema: <http://schema.org/>
        PREFIX wgs84: <http://www.w3.org/2003/01/geo/wgs84_pos#>

        SELECT ?place ?lat ?lon WHERE {{
          VALUES ?place {{ {values} }}
          ?place foaf:focus ?focus .
          ?focus wgs84:lat ?lat ;
                 wgs84:long ?lon .
        }}
        """

        try:
            bindings = sparql_query(GETTY_SPARQL, query)
            for b in bindings:
                uri = b["place"]["value"]
                lat = float(b["lat"]["value"])
                lon = float(b["lon"]["value"])
                tgn_id = uri.rsplit("/", 1)[-1]
                for vocab_id in tgn_to_vocab.get(tgn_id, []):
                    results[vocab_id] = (lat, lon)

            print(f"  Batch {i // batch_size + 1}: {len(batch)} TGN IDs → "
                  f"{len(bindings)} with coords", file=sys.stderr)
        except Exception as e:
            print(f"  Batch {i // batch_size + 1} error: {e}", file=sys.stderr)

        time.sleep(2)

    print(f"Getty TGN: resolved {len(results)} places", file=sys.stderr)
    return results


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Batch geocode via external IDs")
    parser.add_argument("--db", default="data/vocabulary.db", help="Path to vocabulary.db")
    parser.add_argument("--dry-run", action="store_true", help="Show counts but don't update")
    parser.add_argument("--skip-geonames", action="store_true",
                        help="Skip GeoNames (slow, requires API key for bulk)")
    args = parser.parse_args()

    db_path = Path(args.db)
    if not db_path.exists():
        repo_root = Path(__file__).resolve().parent.parent
        db_path = repo_root / args.db
    if not db_path.exists():
        print(f"DB not found: {args.db}", file=sys.stderr)
        sys.exit(1)

    # Get all places missing coordinates but having external IDs
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    rows = conn.execute("""
        SELECT id, external_id, label_en, label_nl
        FROM vocabulary
        WHERE type = 'place'
          AND lat IS NULL
          AND external_id IS NOT NULL
          AND external_id != ''
    """).fetchall()
    places = [dict(r) for r in rows]
    conn.close()

    print(f"Found {len(places)} places missing coordinates with external IDs",
          file=sys.stderr)

    # Categorize
    wikidata = [p for p in places if "wikidata" in (p["external_id"] or "")]
    geonames = [p for p in places if "geonames" in (p["external_id"] or "")]
    getty = [p for p in places if "getty.edu/tgn" in (p["external_id"] or "")]

    print(f"  Wikidata: {len(wikidata)}", file=sys.stderr)
    print(f"  GeoNames: {len(geonames)}", file=sys.stderr)
    print(f"  Getty TGN: {len(getty)}", file=sys.stderr)

    if args.dry_run:
        print("Dry run — not updating database", file=sys.stderr)
        return

    all_results: dict[str, tuple[float, float]] = {}

    # 1. Wikidata (fastest — batch SPARQL)
    if wikidata:
        wd_results = geocode_wikidata(wikidata)
        all_results.update(wd_results)

    # 2. Getty TGN (batch SPARQL)
    if getty:
        getty_results = geocode_getty(getty)
        all_results.update(getty_results)

    # 3. GeoNames (slow — one-by-one API, skip by default)
    if geonames and not args.skip_geonames:
        gn_results = geocode_geonames(geonames)
        all_results.update(gn_results)

    # Update the database
    if all_results:
        print(f"\nUpdating {len(all_results)} places in database...", file=sys.stderr)
        conn = sqlite3.connect(str(db_path))
        cursor = conn.cursor()
        updated = 0
        for vocab_id, (lat, lon) in all_results.items():
            cursor.execute(
                "UPDATE vocabulary SET lat = ?, lon = ? WHERE id = ? AND lat IS NULL",
                (lat, lon, vocab_id),
            )
            updated += cursor.rowcount
        conn.commit()
        conn.close()
        print(f"Updated {updated} rows", file=sys.stderr)

    # Final summary
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    total_places = conn.execute(
        "SELECT COUNT(*) FROM vocabulary WHERE type = 'place'"
    ).fetchone()[0]
    with_coords = conn.execute(
        "SELECT COUNT(*) FROM vocabulary WHERE type = 'place' AND lat IS NOT NULL"
    ).fetchone()[0]
    conn.close()

    print(f"\n{'='*60}", file=sys.stderr)
    print(f"Summary:", file=sys.stderr)
    print(f"  Total places in DB:    {total_places:,}", file=sys.stderr)
    print(f"  With coordinates:      {with_coords:,}", file=sys.stderr)
    print(f"  Coverage:              {with_coords/total_places*100:.1f}%", file=sys.stderr)
    print(f"{'='*60}", file=sys.stderr)


if __name__ == "__main__":
    main()
