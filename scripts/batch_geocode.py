#!/usr/bin/env python3
"""
Batch geocode depicted places using external IDs already in the vocabulary DB.

Default strategy (top-up — fills missing coords only):
  1. Wikidata SPARQL — batch query P625 coordinates for QIDs (fast, ~500 QIDs/query)
  2. GeoNames API — resolve GeoNames IDs to coordinates (fast, bulk JSON)
  3. Getty TGN SPARQL — batch query coordinates from Getty Thesaurus

Alternate mode — full TGN re-validation via per-entity RDF dereferencing
(use this when vocab.getty.edu/sparql is broken but the LOD CDN still works):
    python3 scripts/batch_geocode.py --revalidate-tgn-rdf [--dry-run] [--rdf-workers N]

Usage:
    python3 scripts/batch_geocode.py [--db PATH] [--dry-run]
"""

import argparse
import json
import sqlite3
import sys
import threading
import time
import urllib.request
import urllib.parse
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path

WIKIDATA_SPARQL = "https://query.wikidata.org/sparql"
GETTY_SPARQL = "http://vocab.getty.edu/sparql"
GETTY_RDF_BASE = "http://vocab.getty.edu/tgn/"   # per-entity dereferencing: GETTY_RDF_BASE + "{id}.rdf"
GEONAMES_API = "http://api.geonames.org/getJSON"

UA = "rijksmuseum-mcp-geocoder/2.0 (https://github.com/kintopp/rijksmuseum-mcp-plus)"

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


def geocode_geonames(places: list[dict],
                     username: str | None = None) -> dict[str, tuple[float, float]]:
    """
    Geocode places via GeoNames JSON API.
    Free tier: 1000 req/hour, 1 req at a time.

    ``username`` must be an activated GeoNames account with free-webservice
    access enabled. Defaults to $GEONAMES_USERNAME from the env; falls back
    to the shared 'demo' account which is almost always rate-limited out
    and will silently yield 0 resolutions (the error response is a valid
    JSON with ``status.value=18`` but no lat/lng). Use a real username.
    """
    import os as _os
    if not username:
        username = _os.environ.get("GEONAMES_USERNAME", "demo")
    if username == "demo":
        print("WARNING: using 'demo' GeoNames account — will hit rate limit",
              file=sys.stderr)

    gn_to_vocab: dict[str, list[str]] = {}
    for p in places:
        gn_id = extract_geonames_id(p["external_id"])
        if gn_id and gn_id.isdigit():
            gn_to_vocab.setdefault(gn_id, []).append(p["id"])

    if not gn_to_vocab:
        return {}

    print(f"GeoNames: {len(gn_to_vocab)} IDs to geocode (user={username})",
          file=sys.stderr)

    results: dict[str, tuple[float, float]] = {}
    rate_limited_warned = False
    for i, gn_id in enumerate(gn_to_vocab):
        try:
            url = f"{GEONAMES_API}?geonameId={gn_id}&username={username}"
            data = fetch_json(url)
            if "lat" in data and "lng" in data:
                lat = float(data["lat"])
                lon = float(data["lng"])
                for vocab_id in gn_to_vocab[gn_id]:
                    results[vocab_id] = (lat, lon)
            elif "status" in data and not rate_limited_warned:
                # Surface the API error once (e.g. rate limit, bad username).
                print(f"  GeoNames API error for {gn_id}: "
                      f"{data['status'].get('message', 'unknown')}",
                      file=sys.stderr)
                rate_limited_warned = True
        except Exception as e:
            print(f"  GeoNames {gn_id} error: {e}", file=sys.stderr)

        # Rate limit: ~1 req/sec for free tier
        if (i + 1) % 100 == 0:
            print(f"  ... {i + 1}/{len(gn_to_vocab)} done ({len(results)} resolved)",
                  file=sys.stderr)
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
# 3b. Getty TGN per-entity RDF dereferencing
# ---------------------------------------------------------------------------
#
# Substitute for the SPARQL path when vocab.getty.edu/sparql is unreachable
# (it 500s as of 2026-05-09 while the static LOD layer still serves valid
# RDF). The RDF payload carries lat/long, gvp:placeTypePreferred, and the
# broader-chain in a single fetch — so this is also the right path for a
# "full re-validation" pass that upgrades coord_method_detail provenance
# and refreshes vocabulary.placetype/placetype_source on TGN-tagged places.
#
# Tagged em.TGN_RDF_DIRECT (separate from em.TGN_DIRECT, which records the
# SPARQL path). The two constants exist side-by-side so consumers can tell
# which mechanism produced a given row — preserves audit-trail fidelity per
# the #258 append-only gate.

_RDF_NS = {
    "wgs":  "http://www.w3.org/2003/01/geo/wgs84_pos#",
    "skos": "http://www.w3.org/2004/02/skos/core#",
    "gvp":  "http://vocab.getty.edu/ontology#",
    "rdf":  "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
}
_RDF_RESOURCE = f"{{{_RDF_NS['rdf']}}}resource"


@dataclass
class TGNRecord:
    """Facts harvested from a single TGN entity's .rdf payload.

    Returned by ``geocode_getty_rdf`` — caller decides write strategy
    (coord upgrade vs. discrepancy log, placetype fill, etc.).
    """
    tgn_id: str
    lat: float | None = None
    lon: float | None = None
    placetype_aat: str | None = None     # full URI: http://vocab.getty.edu/aat/300008389
    broader_tgn: str | None = None       # bare ID of immediate gvp:broader parent
    label_en: str | None = None
    fetch_status: int = 0                # HTTP status (0 = transport error before status line)
    fetch_error: str | None = None       # populated on non-200 or parse failure


def _parse_tgn_rdf(body: bytes, tgn_id: str) -> TGNRecord:
    """Parse one TGN entity's RDF payload into a TGNRecord.

    Tolerant of missing fields — TGN often has placeType but no coords (areal
    entities). Returns the record with whatever was found; the caller checks
    individual field presence.
    """
    rec = TGNRecord(tgn_id=tgn_id, fetch_status=200)
    try:
        root = ET.fromstring(body)
    except ET.ParseError as e:
        rec.fetch_status = 0
        rec.fetch_error = f"parse error: {e}"
        return rec

    for elem in root.iter():
        if "}" not in elem.tag:
            continue
        ns, _, tag = elem.tag[1:].partition("}")
        if ns == _RDF_NS["wgs"]:
            if tag == "lat" and elem.text and rec.lat is None:
                try:
                    rec.lat = float(elem.text)
                except ValueError:
                    pass
            elif tag == "long" and elem.text and rec.lon is None:
                try:
                    rec.lon = float(elem.text)
                except ValueError:
                    pass
        elif ns == _RDF_NS["skos"] and tag == "prefLabel":
            if (elem.get("{http://www.w3.org/XML/1998/namespace}lang") == "en"
                    and rec.label_en is None and elem.text):
                rec.label_en = elem.text
        elif ns == _RDF_NS["gvp"]:
            if tag == "placeTypePreferred" and rec.placetype_aat is None:
                ref = elem.get(_RDF_RESOURCE, "")
                if "/aat/" in ref:
                    rec.placetype_aat = ref
            elif tag == "broader" and rec.broader_tgn is None:
                ref = elem.get(_RDF_RESOURCE, "")
                if "/tgn/" in ref:
                    rec.broader_tgn = ref.rsplit("/", 1)[-1]
    return rec


def _fetch_tgn_rdf(session, tgn_id: str, timeout: int = 20) -> TGNRecord:
    """Fetch and parse one TGN entity's .rdf. Network errors surface in
    ``fetch_error``; the caller decides whether to retry."""
    url = f"{GETTY_RDF_BASE}{tgn_id}.rdf"
    try:
        resp = session.get(url, timeout=timeout, allow_redirects=True)
    except Exception as e:
        return TGNRecord(tgn_id=tgn_id, fetch_status=0,
                         fetch_error=f"transport: {e.__class__.__name__}: {e}")
    if resp.status_code != 200:
        return TGNRecord(tgn_id=tgn_id, fetch_status=resp.status_code,
                         fetch_error=f"HTTP {resp.status_code}")
    return _parse_tgn_rdf(resp.content, tgn_id)


def geocode_getty_rdf(places: list[dict],
                      *,
                      max_workers: int = 6,
                      request_timeout: int = 20,
                      progress_every: int = 500) -> dict[str, TGNRecord]:
    """
    Full re-validation pass over places with TGN authority IDs, using
    per-entity RDF dereferencing instead of the SPARQL endpoint.

    Returns ``{vocab_id: TGNRecord}`` covering every input place (including
    failures — check ``rec.fetch_status`` / ``rec.fetch_error``). The caller
    decides write strategy: top-up missing coords, upgrade existing-coord
    provenance to ``em.TGN_RDF_DIRECT``, refresh ``placetype`` /
    ``placetype_source``, log discrepancies between TGN and existing values.

    Unlike ``geocode_getty()``, this function does NOT pre-filter to
    ungeocoded places — full re-validation requires touching the rows that
    already have coords too. Trust-tier enforcement (``WHERE lat IS NULL``)
    is the caller's job and is generally inappropriate for the upgrade-mode
    use case.

    HTTP keep-alive via per-worker ``requests.Session`` (sessions aren't
    thread-safe across simultaneous calls, so each worker thread gets its
    own from ``threading.local``). Avg latency drops from ~1.9s/req with
    cold-connection ``urlopen`` to ~200-300ms/req with keep-alive.
    """
    import requests
    from requests.adapters import HTTPAdapter
    from urllib3.util.retry import Retry

    tgn_to_vocab: dict[str, list[str]] = {}
    for p in places:
        tgn_id = extract_tgn_id(p["external_id"])
        if tgn_id:
            tgn_to_vocab.setdefault(tgn_id, []).append(p["id"])

    if not tgn_to_vocab:
        return {}

    n_unique = len(tgn_to_vocab)
    n_vocab_rows = sum(len(v) for v in tgn_to_vocab.values())
    print(f"Getty TGN (RDF): {n_unique} unique IDs across {n_vocab_rows} "
          f"vocab rows (max_workers={max_workers})", file=sys.stderr)

    thread_local = threading.local()

    def _session() -> "requests.Session":
        s = getattr(thread_local, "session", None)
        if s is None:
            s = requests.Session()
            s.headers.update({
                "User-Agent": UA,
                "Accept": "application/rdf+xml",
                "Accept-Encoding": "gzip",
            })
            retry = Retry(
                total=3,
                backoff_factor=0.5,
                status_forcelist=[429, 502, 503, 504],
                allowed_methods=frozenset(["GET"]),
                raise_on_status=False,
            )
            adapter = HTTPAdapter(pool_connections=1, pool_maxsize=1, max_retries=retry)
            s.mount("http://", adapter)
            s.mount("https://", adapter)
            thread_local.session = s
        return s

    results: dict[str, TGNRecord] = {}
    fetched = coords_found = placetypes_found = errors = 0
    t0 = time.perf_counter()

    def _fetch(tgn_id: str) -> tuple[str, TGNRecord]:
        return tgn_id, _fetch_tgn_rdf(_session(), tgn_id, timeout=request_timeout)

    with ThreadPoolExecutor(max_workers=max_workers) as ex:
        futures = [ex.submit(_fetch, tgn) for tgn in tgn_to_vocab]
        for fut in as_completed(futures):
            tgn_id, rec = fut.result()
            for vocab_id in tgn_to_vocab[tgn_id]:
                results[vocab_id] = rec
            fetched += 1
            if rec.fetch_error:
                errors += 1
            if rec.lat is not None and rec.lon is not None:
                coords_found += 1
            if rec.placetype_aat:
                placetypes_found += 1

            if fetched % progress_every == 0:
                elapsed = time.perf_counter() - t0
                rate = fetched / elapsed if elapsed > 0 else 0
                eta_min = (n_unique - fetched) / rate / 60 if rate > 0 else 0
                print(f"  ... {fetched}/{n_unique} ({rate:.1f} req/s, "
                      f"eta {eta_min:.1f} min) — coords={coords_found}, "
                      f"placetypes={placetypes_found}, errors={errors}",
                      file=sys.stderr)

    elapsed = time.perf_counter() - t0
    print(f"Getty TGN (RDF): {fetched} fetches in {elapsed:.1f}s "
          f"({fetched/elapsed:.1f} req/s avg) — "
          f"coords={coords_found}, placetypes={placetypes_found}, "
          f"errors={errors}", file=sys.stderr)
    return results


# ---------------------------------------------------------------------------
# 3c. Full re-validation orchestrator (TGN RDF)
# ---------------------------------------------------------------------------

# Coordinate match tolerance: ~0.05° ≈ 5.5 km at the equator. Below this,
# treat the existing coord and TGN's coord as agreeing (provenance-upgrade
# only). Above, log a discrepancy and leave the existing coord untouched.
# 0.05° was chosen to absorb sub-degree rounding noise (TGN's coords are
# often manually rounded to 1-2 decimals) while still surfacing genuine
# wrong-entity matches like the Wikidata-reconciliation Texas-vs-Italy
# error caught in the 30-row smoke pass.
TGN_RDF_COORD_MATCH_DEG = 0.05


def _load_tgn_revalidation_set(conn: sqlite3.Connection) -> list[dict]:
    """Pull every place with a TGN authority ID, with its current coord/
    placetype state. Manual rows are included — the writer handles
    per-column manual-override skip rules row-by-row."""
    rows = conn.execute("""
        SELECT v.id,
               vei.uri AS external_id,
               v.label_en,
               v.lat, v.lon,
               v.coord_method, v.coord_method_detail,
               v.placetype, v.placetype_source
        FROM vocabulary_external_ids vei
        JOIN vocabulary v ON v.id = vei.vocab_id
        WHERE vei.authority = 'tgn' AND v.type = 'place'
    """).fetchall()
    return [dict(r) for r in rows]


def revalidate_tgn_rdf(db_path: Path,
                       *,
                       max_workers: int = 6,
                       dry_run: bool = False,
                       coord_match_tolerance_deg: float = TGN_RDF_COORD_MATCH_DEG,
                       discrepancy_csv: Path | None = None) -> None:
    """Full re-validation pass over TGN-authority places via per-entity RDF.

    Branches per row:
      A) had_coords + RDF coords agree (≤ tolerance) → upgrade
         ``coord_method_detail`` to ``tgn_rdf_direct`` (coord untouched).
      B) had_coords + RDF coords disagree → discrepancy CSV row, no DB change.
      C) !had_coords + RDF has coords → fill lat/lon and set
         ``coord_method`` / ``coord_method_detail``.
      D) !had_coords + RDF has no coords + placetype not in settlement
         allow-list → set ``is_areal = 1`` (areal entity confirmed).
      E) Neither side has coords + placetype unclear → no action; logged.

    Independently: if TGN returns a ``placetype_aat`` AND the row's existing
    ``placetype_source`` is not ``manual``, refresh ``placetype`` /
    ``placetype_source`` to the TGN value. Manual placetype edits are sacred.

    Manual coord overrides (``coord_method='manual'``) are skipped entirely
    on the coord side. Their placetype may still be refreshed if its source
    isn't manual.
    """
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import csv as _csv
    import enrichment_methods as em

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    places = _load_tgn_revalidation_set(conn)
    conn.close()

    print(f"TGN RDF revalidation: {len(places)} TGN-tagged places loaded "
          f"(tolerance={coord_match_tolerance_deg}°, workers={max_workers})",
          file=sys.stderr)

    records = geocode_getty_rdf(places, max_workers=max_workers)

    # Plan writes per row by branch. We accumulate three lists for the
    # SQL phase + one for the discrepancy CSV.
    coord_upgrades: list[tuple[str]] = []   # (vocab_id,) → set coord_method_detail only
    coord_fills: list[tuple[float, float, str]] = []  # (lat, lon, vocab_id)
    areal_flags: list[tuple[str]] = []      # (vocab_id,) → set is_areal=1
    placetype_writes: list[tuple[str, str]] = []  # (placetype_uri, vocab_id)
    discrepancies: list[dict] = []
    no_action: list[dict] = []

    for row in places:
        rec = records.get(row["id"])
        if rec is None or rec.fetch_error:
            no_action.append({
                "vocab_id": row["id"],
                "tgn_id": rec.tgn_id if rec else "?",
                "reason": (rec.fetch_error if rec else "no_record"),
            })
            continue

        # Placetype refresh — independent of coord branching.
        if rec.placetype_aat and row["placetype_source"] != em.MANUAL:
            placetype_writes.append((rec.placetype_aat, row["id"]))

        # Coord branching.
        had = row["lat"] is not None
        manual_coord = (row["coord_method"] == em.MANUAL and had)
        rdf_has_coords = rec.lat is not None and rec.lon is not None

        if manual_coord:
            # Skip coord side entirely — placetype refresh above already done.
            continue

        if had and rdf_has_coords:
            if (abs(row["lat"] - rec.lat) <= coord_match_tolerance_deg
                    and abs(row["lon"] - rec.lon) <= coord_match_tolerance_deg):
                # Branch A: provenance upgrade.
                coord_upgrades.append((row["id"],))
            else:
                # Branch B: discrepancy.
                discrepancies.append({
                    "vocab_id": row["id"],
                    "tgn_id": rec.tgn_id,
                    "label_en": row["label_en"] or "",
                    "existing_lat": row["lat"],
                    "existing_lon": row["lon"],
                    "existing_method_detail": row["coord_method_detail"] or "",
                    "tgn_lat": rec.lat,
                    "tgn_lon": rec.lon,
                    "delta_lat": row["lat"] - rec.lat,
                    "delta_lon": row["lon"] - rec.lon,
                    "placetype_aat": rec.placetype_aat or "",
                })
        elif not had and rdf_has_coords:
            # Branch C: new coord fill.
            coord_fills.append((rec.lat, rec.lon, row["id"]))
        elif not had and not rdf_has_coords:
            # Branch D vs E: settlement-tier placetype means TGN simply lacks
            # the centroid (anomalous, log only); anything else is areal.
            if rec.placetype_aat and rec.placetype_aat not in em.INHERITANCE_ALLOWED_PLACETYPES:
                areal_flags.append((row["id"],))
            else:
                no_action.append({
                    "vocab_id": row["id"],
                    "tgn_id": rec.tgn_id,
                    "reason": ("settlement_no_centroid"
                               if rec.placetype_aat
                               else "no_coords_no_placetype"),
                })

    # Summary.
    print(f"\n{'='*60}", file=sys.stderr)
    print(f"TGN RDF revalidation plan:", file=sys.stderr)
    print(f"  A) provenance upgrades (coord match):  {len(coord_upgrades):>6,}",
          file=sys.stderr)
    print(f"  B) discrepancies (coord mismatch):     {len(discrepancies):>6,}  → CSV only",
          file=sys.stderr)
    print(f"  C) new coord fills:                    {len(coord_fills):>6,}",
          file=sys.stderr)
    print(f"  D) areal flags (no coord + non-settlement placetype): {len(areal_flags):>6,}",
          file=sys.stderr)
    print(f"  --- placetype writes (independent):    {len(placetype_writes):>6,}",
          file=sys.stderr)
    print(f"  no-action (errors, settlement w/o centroid, etc.): {len(no_action):>6,}",
          file=sys.stderr)
    print(f"{'='*60}", file=sys.stderr)

    # Discrepancy CSV.
    if discrepancies:
        if discrepancy_csv is None:
            discrepancy_csv = db_path.parent / "tgn-rdf-discrepancies.csv"
        with open(discrepancy_csv, "w", newline="") as f:
            w = _csv.DictWriter(f, fieldnames=list(discrepancies[0].keys()))
            w.writeheader()
            w.writerows(discrepancies)
        print(f"Discrepancy CSV written: {discrepancy_csv} "
              f"({len(discrepancies)} rows)", file=sys.stderr)

    if dry_run:
        print("Dry run — no DB changes applied.", file=sys.stderr)
        return

    # Apply writes in a single transaction.
    coord_tier = em.tier_for(em.TGN_RDF_DIRECT)
    conn = sqlite3.connect(str(db_path))
    cur = conn.cursor()
    try:
        if coord_upgrades:
            cur.executemany(
                "UPDATE vocabulary SET coord_method = ?, coord_method_detail = ? "
                "WHERE id = ? AND coord_method != ?",
                [(coord_tier, em.TGN_RDF_DIRECT, vid, em.MANUAL)
                 for (vid,) in coord_upgrades],
            )
            print(f"  applied: {cur.rowcount} provenance upgrades", file=sys.stderr)
        if coord_fills:
            cur.executemany(
                "UPDATE vocabulary SET lat = ?, lon = ?, "
                "  coord_method = ?, coord_method_detail = ? "
                "WHERE id = ? AND lat IS NULL",
                [(lat, lon, coord_tier, em.TGN_RDF_DIRECT, vid)
                 for (lat, lon, vid) in coord_fills],
            )
            print(f"  applied: {cur.rowcount} new coord fills", file=sys.stderr)
        if areal_flags:
            cur.executemany(
                "UPDATE vocabulary SET is_areal = 1 WHERE id = ? AND lat IS NULL",
                areal_flags,
            )
            print(f"  applied: {cur.rowcount} is_areal=1 flags", file=sys.stderr)
        if placetype_writes:
            cur.executemany(
                "UPDATE vocabulary SET placetype = ?, placetype_source = 'tgn' "
                "WHERE id = ? AND COALESCE(placetype_source, '') != 'manual'",
                placetype_writes,
            )
            print(f"  applied: {cur.rowcount} placetype refreshes", file=sys.stderr)
        conn.commit()
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Batch geocode via external IDs")
    parser.add_argument("--db", default="data/vocabulary.db", help="Path to vocabulary.db")
    parser.add_argument("--dry-run", action="store_true", help="Show counts but don't update")
    parser.add_argument("--skip-geonames", action="store_true",
                        help="Skip GeoNames (slow, requires API key for bulk)")
    parser.add_argument("--skip-getty", action="store_true",
                        help="Skip Getty TGN SPARQL (use when vocab.getty.edu is unreachable)")
    parser.add_argument("--revalidate-tgn-rdf", action="store_true",
                        help="Run a full re-validation pass over all TGN-authority "
                             "places via per-entity RDF dereferencing. Skips the "
                             "normal Wikidata/GeoNames/Getty-SPARQL flow.")
    parser.add_argument("--rdf-workers", type=int, default=8,
                        help="Concurrent workers for --revalidate-tgn-rdf (default: 8)")
    args = parser.parse_args()

    db_path = Path(args.db)
    if not db_path.exists():
        repo_root = Path(__file__).resolve().parent.parent
        db_path = repo_root / args.db
    if not db_path.exists():
        print(f"DB not found: {args.db}", file=sys.stderr)
        sys.exit(1)

    # --revalidate-tgn-rdf: full re-validation over all TGN-authority places
    # via per-entity RDF dereferencing. Branches on existing coord state
    # (upgrade / discrepancy log / fill / areal flag) — see revalidate_tgn_rdf.
    if args.revalidate_tgn_rdf:
        revalidate_tgn_rdf(db_path,
                           max_workers=args.rdf_workers,
                           dry_run=args.dry_run)
        return

    # Get ungeocoded places with external-authority links. Source of truth
    # is vocabulary_external_ids (populated by #238's Schema.org sweep); we
    # also union the legacy vocabulary.external_id column for pre-#238 rows.
    # After a cold re-run reset, vocabulary.external_id is NULL for every
    # non-Rijksmuseum-self-ref place, so the primary source here is the
    # vei table.
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row

    # Primary: vocabulary_external_ids (authority-keyed). Dedup per vocab_id.
    primary = conn.execute("""
        SELECT v.id,
               vei.authority,
               vei.uri AS external_id,
               v.label_en, v.label_nl
        FROM vocabulary v
        JOIN vocabulary_external_ids vei ON vei.vocab_id = v.id
        WHERE v.type = 'place' AND v.lat IS NULL
          AND vei.authority IN ('wikidata', 'geonames', 'tgn')
    """).fetchall()

    by_vocab: dict[str, dict] = {}
    for r in primary:
        vid = r["id"]
        if vid not in by_vocab:
            by_vocab[vid] = dict(r)

    # Legacy: any remaining places with a matching substring in
    # vocabulary.external_id that we haven't covered yet (mostly empty
    # after a cold-reset; kept for robustness).
    legacy_rows = conn.execute("""
        SELECT id, external_id, label_en, label_nl
        FROM vocabulary
        WHERE type = 'place' AND lat IS NULL
          AND external_id IS NOT NULL AND external_id != ''
          AND (external_id LIKE '%wikidata%'
               OR external_id LIKE '%geonames%'
               OR external_id LIKE '%getty.edu/tgn%')
    """).fetchall()
    for r in legacy_rows:
        vid = r["id"]
        if vid in by_vocab:
            continue
        uri = r["external_id"] or ""
        if "wikidata" in uri:
            auth = "wikidata"
        elif "geonames" in uri:
            auth = "geonames"
        elif "getty.edu/tgn" in uri:
            auth = "tgn"
        else:
            continue
        by_vocab[vid] = dict(
            id=vid,
            authority=auth,
            external_id=uri,
            label_en=r["label_en"],
            label_nl=r["label_nl"],
        )

    places = list(by_vocab.values())
    conn.close()

    print(f"Found {len(places)} places missing coordinates with external IDs",
          file=sys.stderr)

    # Categorize by authority (not substring).
    wikidata = [p for p in places if p["authority"] == "wikidata"]
    geonames = [p for p in places if p["authority"] == "geonames"]
    getty    = [p for p in places if p["authority"] == "tgn"]

    print(f"  Wikidata: {len(wikidata)}", file=sys.stderr)
    print(f"  GeoNames: {len(geonames)}", file=sys.stderr)
    print(f"  Getty TGN: {len(getty)}", file=sys.stderr)

    if args.dry_run:
        print("Dry run — not updating database", file=sys.stderr)
        return

    # #218: each source is tagged with its own fine-grained detail value so
    # downstream consumers can distinguish "direct Wikidata P625" from
    # "direct Getty TGN" etc. The coarse tier (AUTHORITY) is derived via
    # em.tier_for() at write time. Keep the three result dicts separate so
    # source attribution isn't lost at merge.
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import enrichment_methods as em  # local import

    result_sets: list[tuple[dict[str, tuple[float, float]], str]] = []

    # 1. Wikidata (fastest — batch SPARQL)
    if wikidata:
        result_sets.append((geocode_wikidata(wikidata), em.WIKIDATA_P625))

    # 2. Getty TGN (batch SPARQL)
    if getty and not args.skip_getty:
        result_sets.append((geocode_getty(getty), em.TGN_DIRECT))
    elif getty and args.skip_getty:
        print(f"  (skipping {len(getty)} TGN-tagged places — --skip-getty)",
              file=sys.stderr)

    # 3. GeoNames (slow — one-by-one API, skip by default)
    if geonames and not args.skip_geonames:
        result_sets.append((geocode_geonames(geonames), em.GEONAMES_API))

    # Update the database
    total_rows = sum(len(r) for r, _ in result_sets)
    if total_rows:
        print(f"\nUpdating {total_rows} places in database...", file=sys.stderr)
        conn = sqlite3.connect(str(db_path))
        cursor = conn.cursor()
        updated = 0
        # `AND lat IS NULL` is trust-tier enforcement: this script runs the
        # fast bulk authority-ID passes (Wikidata SPARQL, GeoNames, Getty TGN)
        # and must not overwrite any place that already has coordinates from
        # a prior pass — whether from this script's own earlier phases or
        # from geocode_places.py's higher-confidence phases. See #218 and
        # geocode_places.update_coords for the full rationale.
        for results, detail in result_sets:
            if not results:
                continue
            coord_tier = em.tier_for(detail)
            for vocab_id, (lat, lon) in results.items():
                cursor.execute(
                    "UPDATE vocabulary SET lat = ?, lon = ?, "
                    "  coord_method = ?, coord_method_detail = ? "
                    "WHERE id = ? AND lat IS NULL",
                    (lat, lon, coord_tier, detail, vocab_id),
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
