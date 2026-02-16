#!/usr/bin/env python3
"""
Geocode remaining ungeocoded places in the Rijksmuseum vocabulary DB.

Standalone post-harvest script. Designed to run after any harvest rebuild to
patch vocabulary.lat/vocabulary.lon and (optionally) vocabulary.external_id.

Phases:
  1a  GeoNames API — resolve GeoNames IDs to coordinates
  1b  Wikidata alt-props — follow P159/P131/P276 when P625 is missing
  1c  Getty TGN → Wikidata — cross-reference TGN IDs via P1667
  2   Self-reference resolution — copy coords from target vocab entries
  3   Wikidata entity reconciliation — name search + SPARQL validation
  4   Validation — hemisphere checks, null island, lat/lon swap detection

Usage:
    python3 scripts/geocode_places.py --db data/vocabulary.db
    python3 scripts/geocode_places.py --db data/vocabulary.db --dry-run
    python3 scripts/geocode_places.py --db data/vocabulary.db --phase 3
    python3 scripts/geocode_places.py --db data/vocabulary.db --skip-geonames
    python3 scripts/geocode_places.py --db data/vocabulary.db --apply-reviewed offline/geo/reconciled_review.csv
"""

import argparse
import asyncio
import csv
import json
import os
import re
import sqlite3
import sys
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime
from difflib import SequenceMatcher
from pathlib import Path

# ---------------------------------------------------------------------------
# Load .env from project root (no external dependency)
# ---------------------------------------------------------------------------
_env_file = Path(__file__).resolve().parent.parent / ".env"
if _env_file.exists():
    for raw_line in _env_file.read_text().splitlines():
        stripped = raw_line.strip()
        if stripped and not stripped.startswith("#") and "=" in stripped:
            key, _, value = stripped.partition("=")
            os.environ.setdefault(key.strip(), value.strip())

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

WIKIDATA_SPARQL = "https://query.wikidata.org/sparql"
GEONAMES_API = "http://api.geonames.org/getJSON"
WIKIDATA_API = "https://www.wikidata.org/w/api.php"
USER_AGENT = "rijksmuseum-mcp-geocoder/2.0 (https://github.com/kintopp/rijksmuseum-mcp-plus)"

# P31 allowlist for geographic entities (used in Phase 3 scoring)
GEOGRAPHIC_TYPES = {
    "Q515",       # city
    "Q3957",      # town
    "Q532",       # village
    "Q5119",      # capital city
    "Q1549591",   # big city
    "Q486972",    # human settlement
    "Q839954",    # street
    "Q34442",     # road
    "Q41176",     # building
    "Q35657",     # building (broader)
    "Q4294693",   # square/plaza
    "Q23397",     # lake
    "Q4022",      # river
    "Q34763",     # peninsula
    "Q23442",     # island
    "Q6256",      # country
    "Q10864048",  # first-level admin
    "Q33506",     # museum
    "Q16970",     # church building
    "Q23413",     # castle
    "Q57821",     # fortification
    "Q12280",     # bridge
    "Q44782",     # port
    "Q55488",     # railway station
    "Q82794",     # geographic region
    "Q7930989",   # city/town
    "Q123705",    # neighbourhood
    "Q15284",     # municipality
    "Q2983893",   # hamlet
    "Q3024240",   # historical city
    "Q1187580",   # administrative region
    "Q35127",     # website  # exclude
    "Q17334923",  # location
    "Q15221",     # abbey
    "Q16560",     # palace
    "Q751876",    # château
    "Q24354",     # theater building
}

# Non-geographic types to reject
NON_GEOGRAPHIC_TYPES = {
    "Q523",       # star
    "Q318",       # galaxy
    "Q17362920",  # wikimedia disambig
    "Q4167410",   # Wikimedia disambig page
    "Q13442814",  # scholarly article
    "Q5",         # human
    "Q16521",     # taxon
    "Q11424",     # film
    "Q7725634",   # literary work
}


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------

def fetch_json(url: str, headers: dict | None = None, retries: int = 3) -> dict:
    """HTTP GET → JSON with retries."""
    req = urllib.request.Request(url, headers=headers or {})
    req.add_header("User-Agent", USER_AGENT)
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return json.loads(resp.read().decode())
        except Exception as e:
            if attempt == retries - 1:
                raise
            time.sleep(2 ** attempt)
    return {}


def sparql_query(endpoint: str, query: str, retries: int = 3) -> list[dict]:
    """Execute a SPARQL query and return results bindings."""
    params = urllib.parse.urlencode({"query": query, "format": "json"})
    url = f"{endpoint}?{params}"
    data = fetch_json(url, {"Accept": "application/sparql-results+json"}, retries)
    return data.get("results", {}).get("bindings", [])


# ---------------------------------------------------------------------------
# ID extraction helpers (reused from batch_geocode.py)
# ---------------------------------------------------------------------------

def extract_qid(uri: str) -> str | None:
    """Extract QID from Wikidata URI."""
    for prefix in ("http://www.wikidata.org/entity/",
                    "https://www.wikidata.org/entity/",
                    "http://www.wikidata.org/wiki/",
                    "https://www.wikidata.org/wiki/"):
        if uri.startswith(prefix):
            return uri[len(prefix):]
    return None


def extract_geonames_id(uri: str) -> str | None:
    """Extract numeric GeoNames ID from URI."""
    for prefix in ("http://sws.geonames.org/", "https://sws.geonames.org/",
                    "http://www.geonames.org/", "https://www.geonames.org/"):
        if uri.startswith(prefix):
            return uri[len(prefix):].rstrip("/")
    return None


def extract_tgn_id(uri: str) -> str | None:
    """Extract TGN ID from Getty URI."""
    prefix = "http://vocab.getty.edu/tgn/"
    if uri.startswith(prefix):
        return uri[len(prefix):]
    return None


def extract_rijks_id(uri: str) -> str | None:
    """Extract numeric ID from Rijksmuseum self-ref URI."""
    for prefix in ("https://id.rijksmuseum.nl/", "http://id.rijksmuseum.nl/"):
        if uri.startswith(prefix):
            return uri[len(prefix):].rstrip("/")
    return None


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------

def get_ungeocoded(conn: sqlite3.Connection, category: str | None = None
                   ) -> list[dict]:
    """Get places missing coordinates, optionally filtered by category."""
    base = """
        SELECT v.id, v.label_en, v.label_nl, v.external_id,
               COALESCE(NULLIF(v.label_en, ''), v.label_nl) AS name
        FROM vocabulary v
        WHERE v.type = 'place' AND v.lat IS NULL
    """
    if category == "wikidata":
        base += " AND v.external_id LIKE '%wikidata%'"
    elif category == "geonames":
        base += " AND v.external_id LIKE '%geonames%'"
    elif category == "getty_tgn":
        base += " AND v.external_id LIKE '%getty.edu/tgn%'"
    elif category == "self_ref":
        base += " AND v.external_id LIKE '%id.rijksmuseum.nl%'"
    elif category == "no_external_used":
        base += " AND (v.external_id IS NULL OR v.external_id = '')"
        base += " AND EXISTS (SELECT 1 FROM mappings m WHERE m.vocab_id = v.id)"
    elif category == "no_external":
        base += " AND (v.external_id IS NULL OR v.external_id = '')"

    rows = conn.execute(base).fetchall()
    return [dict(r) for r in rows]


def update_coords(conn: sqlite3.Connection, updates: dict[str, tuple[float, float]],
                  dry_run: bool = False) -> int:
    """Write lat/lon to vocabulary table. Returns count updated."""
    if dry_run or not updates:
        return 0
    cursor = conn.cursor()
    updated = 0
    for vocab_id, (lat, lon) in updates.items():
        cursor.execute(
            "UPDATE vocabulary SET lat = ?, lon = ? WHERE id = ? AND lat IS NULL",
            (lat, lon, vocab_id),
        )
        updated += cursor.rowcount
    conn.commit()
    return updated


def update_coords_and_ids(conn: sqlite3.Connection,
                          updates: dict[str, tuple[float, float, str]],
                          dry_run: bool = False) -> int:
    """Write lat/lon + external_id to vocabulary table. Returns count updated."""
    if dry_run or not updates:
        return 0
    cursor = conn.cursor()
    updated = 0
    for vocab_id, (lat, lon, ext_id) in updates.items():
        cursor.execute(
            "UPDATE vocabulary SET lat = ?, lon = ?, external_id = ? "
            "WHERE id = ? AND lat IS NULL",
            (lat, lon, ext_id, vocab_id),
        )
        updated += cursor.rowcount
    conn.commit()
    return updated


def get_coverage(conn: sqlite3.Connection) -> tuple[int, int]:
    """Return (total_places, with_coords)."""
    total = conn.execute(
        "SELECT COUNT(*) FROM vocabulary WHERE type = 'place'"
    ).fetchone()[0]
    with_coords = conn.execute(
        "SELECT COUNT(*) FROM vocabulary WHERE type = 'place' AND lat IS NOT NULL"
    ).fetchone()[0]
    return total, with_coords


# ---------------------------------------------------------------------------
# Phase 1a: GeoNames API
# ---------------------------------------------------------------------------

def phase_1a_geonames(conn: sqlite3.Connection, username: str,
                      dry_run: bool = False) -> int:
    """Geocode places with GeoNames IDs via the GeoNames API."""
    places = get_ungeocoded(conn, "geonames")
    if not places:
        print("Phase 1a: No GeoNames entries to geocode", file=sys.stderr)
        return 0

    # Build ID → vocab_id mapping
    gn_to_vocab: dict[str, list[str]] = {}
    for p in places:
        gn_id = extract_geonames_id(p["external_id"] or "")
        if gn_id and gn_id.isdigit():
            gn_to_vocab.setdefault(gn_id, []).append(p["id"])

    print(f"Phase 1a: {len(gn_to_vocab)} GeoNames IDs to geocode", file=sys.stderr)

    if dry_run:
        return 0

    results: dict[str, tuple[float, float]] = {}
    errors = 0

    for i, gn_id in enumerate(gn_to_vocab):
        try:
            url = f"{GEONAMES_API}?geonameId={gn_id}&username={username}"
            data = fetch_json(url)
            if "lat" in data and "lng" in data:
                lat = float(data["lat"])
                lon = float(data["lng"])
                if lat != 0 or lon != 0:  # Skip null island
                    for vocab_id in gn_to_vocab[gn_id]:
                        results[vocab_id] = (lat, lon)
            elif "status" in data:
                print(f"  GeoNames {gn_id}: {data['status'].get('message', 'error')}",
                      file=sys.stderr)
                errors += 1
        except Exception as e:
            print(f"  GeoNames {gn_id} error: {e}", file=sys.stderr)
            errors += 1

        # Rate limit: 1 req/sec for free tier
        time.sleep(1.0)
        if (i + 1) % 50 == 0:
            print(f"  ... {i + 1}/{len(gn_to_vocab)} done ({len(results)} found)",
                  file=sys.stderr)

    updated = update_coords(conn, results, dry_run)
    print(f"Phase 1a: {updated} places updated ({errors} errors)", file=sys.stderr)
    return updated


# ---------------------------------------------------------------------------
# Phase 1b: Wikidata P625 alternatives
# ---------------------------------------------------------------------------

def phase_1b_wikidata_alt(conn: sqlite3.Connection,
                          dry_run: bool = False) -> int:
    """Geocode Wikidata entries missing P625 via alternative properties."""
    places = get_ungeocoded(conn, "wikidata")
    if not places:
        print("Phase 1b: No Wikidata entries to geocode", file=sys.stderr)
        return 0

    # Build QID → vocab_id mapping
    qid_to_vocab: dict[str, list[str]] = {}
    for p in places:
        qid = extract_qid(p["external_id"] or "")
        if qid:
            qid_to_vocab.setdefault(qid, []).append(p["id"])

    print(f"Phase 1b: {len(qid_to_vocab)} Wikidata QIDs without P625",
          file=sys.stderr)

    if dry_run:
        return 0

    results: dict[str, tuple[float, float]] = {}
    qids = list(qid_to_vocab.keys())
    batch_size = 200

    for i in range(0, len(qids), batch_size):
        batch = qids[i:i + batch_size]
        values = " ".join(f"wd:{qid}" for qid in batch)

        # Try three alternative property paths:
        # P159 (headquarters location) → P625
        # P131 (located in admin territory) → P625
        # P276 (location) → P625
        query = f"""
        SELECT ?item ?lat ?lon WHERE {{
          VALUES ?item {{ {values} }}
          {{
            ?item wdt:P159 ?hq .
            ?hq wdt:P625 ?coord .
          }} UNION {{
            ?item wdt:P276 ?loc .
            ?loc wdt:P625 ?coord .
          }} UNION {{
            ?item wdt:P131 ?admin .
            ?admin wdt:P625 ?coord .
          }}
          BIND(geof:latitude(?coord) AS ?lat)
          BIND(geof:longitude(?coord) AS ?lon)
        }}
        """

        try:
            bindings = sparql_query(WIKIDATA_SPARQL, query)
            for b in bindings:
                qid = b["item"]["value"].rsplit("/", 1)[-1]
                lat = float(b["lat"]["value"])
                lon = float(b["lon"]["value"])
                if qid in qid_to_vocab and qid not in results:
                    # Take first result per QID (prefer P159 over P131)
                    for vocab_id in qid_to_vocab[qid]:
                        if vocab_id not in results:
                            results[vocab_id] = (lat, lon)

            print(f"  Batch {i // batch_size + 1}: {len(batch)} QIDs → "
                  f"{len(bindings)} with alt coords", file=sys.stderr)
        except Exception as e:
            print(f"  Batch {i // batch_size + 1} error: {e}", file=sys.stderr)

        time.sleep(2)

    updated = update_coords(conn, results, dry_run)
    print(f"Phase 1b: {updated} places updated", file=sys.stderr)
    return updated


# ---------------------------------------------------------------------------
# Phase 1c: Getty TGN → Wikidata cross-reference
# ---------------------------------------------------------------------------

def phase_1c_getty_crossref(conn: sqlite3.Connection,
                            dry_run: bool = False) -> int:
    """Cross-reference Getty TGN IDs to Wikidata via P1667."""
    places = get_ungeocoded(conn, "getty_tgn")
    if not places:
        print("Phase 1c: No Getty TGN entries to geocode", file=sys.stderr)
        return 0

    # Build TGN ID → vocab_id mapping
    tgn_to_vocab: dict[str, list[str]] = {}
    for p in places:
        tgn_id = extract_tgn_id(p["external_id"] or "")
        if tgn_id:
            tgn_to_vocab.setdefault(tgn_id, []).append(p["id"])

    print(f"Phase 1c: {len(tgn_to_vocab)} Getty TGN IDs to cross-reference",
          file=sys.stderr)

    if dry_run:
        return 0

    results: dict[str, tuple[float, float]] = {}
    tgn_ids = list(tgn_to_vocab.keys())
    batch_size = 200

    for i in range(0, len(tgn_ids), batch_size):
        batch = tgn_ids[i:i + batch_size]
        # Build VALUES clause with quoted TGN IDs
        values = " ".join(f'"{tid}"' for tid in batch)

        query = f"""
        SELECT ?tgnId ?lat ?lon WHERE {{
          VALUES ?tgnId {{ {values} }}
          ?item wdt:P1667 ?tgnId .
          ?item wdt:P625 ?coord .
          BIND(geof:latitude(?coord) AS ?lat)
          BIND(geof:longitude(?coord) AS ?lon)
        }}
        """

        try:
            bindings = sparql_query(WIKIDATA_SPARQL, query)
            for b in bindings:
                tgn_id = b["tgnId"]["value"]
                lat = float(b["lat"]["value"])
                lon = float(b["lon"]["value"])
                for vocab_id in tgn_to_vocab.get(tgn_id, []):
                    results[vocab_id] = (lat, lon)

            print(f"  Batch {i // batch_size + 1}: {len(batch)} TGN IDs → "
                  f"{len(bindings)} cross-referenced", file=sys.stderr)
        except Exception as e:
            print(f"  Batch {i // batch_size + 1} error: {e}", file=sys.stderr)

        time.sleep(2)

    updated = update_coords(conn, results, dry_run)
    print(f"Phase 1c: {updated} places updated", file=sys.stderr)
    return updated


# ---------------------------------------------------------------------------
# Phase 2: Self-reference resolution
# ---------------------------------------------------------------------------

def phase_2_self_refs(conn: sqlite3.Connection,
                     dry_run: bool = False) -> int:
    """Copy coordinates from target vocab entries for self-referencing places."""
    # Direct SQL self-join — no HTTP calls needed
    rows = conn.execute("""
        SELECT
            src.id AS src_id,
            tgt.lat AS lat,
            tgt.lon AS lon
        FROM vocabulary src
        JOIN vocabulary tgt ON tgt.id = REPLACE(
            REPLACE(src.external_id, 'https://id.rijksmuseum.nl/', ''),
            'http://id.rijksmuseum.nl/', ''
        )
        WHERE src.type = 'place'
          AND src.lat IS NULL
          AND src.external_id LIKE '%id.rijksmuseum.nl%'
          AND tgt.lat IS NOT NULL
    """).fetchall()

    print(f"Phase 2: {len(rows)} self-refs with geocoded targets", file=sys.stderr)

    if dry_run:
        return 0

    results = {r["src_id"]: (r["lat"], r["lon"]) for r in rows}
    updated = update_coords(conn, results, dry_run)
    print(f"Phase 2: {updated} places updated", file=sys.stderr)
    return updated


# ---------------------------------------------------------------------------
# Phase 3: Wikidata entity reconciliation
# ---------------------------------------------------------------------------

def string_similarity(a: str, b: str) -> float:
    """Normalized string similarity (0-100) using SequenceMatcher."""
    if not a or not b:
        return 0.0
    a_norm = a.lower().strip()
    b_norm = b.lower().strip()
    if a_norm == b_norm:
        return 100.0
    return SequenceMatcher(None, a_norm, b_norm).ratio() * 100


def strip_parenthetical(name: str) -> str | None:
    """Extract bare name from 'Domkerk (Utrecht)' → 'Domkerk'."""
    m = re.match(r'^(.+?)\s*\(', name)
    return m.group(1).strip() if m else None


def extract_parenthetical(name: str) -> str | None:
    """Extract context from 'Domkerk (Utrecht)' → 'Utrecht'."""
    m = re.search(r'\(([^)]+)\)', name)
    return m.group(1).strip() if m else None


def _parse_search_items(data: dict | None, lang: str) -> list[dict]:
    """Extract candidate dicts from a Wikidata wbsearchentities response."""
    if not data:
        return []
    return [
        {
            "qid": item["id"],
            "label": item.get("label", ""),
            "description": item.get("description", ""),
            "match_lang": lang,
        }
        for item in data.get("search", [])
    ]


def _deduplicate_candidates(candidates: list[dict], limit: int = 5) -> list[dict]:
    """Deduplicate candidates by QID, keeping first occurrence."""
    seen: set[str] = set()
    unique: list[dict] = []
    for c in candidates:
        if c["qid"] not in seen:
            seen.add(c["qid"])
            unique.append(c)
    return unique[:limit]


def _build_search_url(name: str, lang: str) -> str:
    """Build a Wikidata wbsearchentities URL."""
    params = urllib.parse.urlencode({
        "action": "wbsearchentities",
        "search": name,
        "language": lang,
        "uselang": lang,
        "limit": "5",
        "format": "json",
    })
    return f"{WIKIDATA_API}?{params}"


async def search_wikidata_entities(names: list[tuple[str, str]],
                                   concurrency: int = 3
                                   ) -> dict[str, list[dict]]:
    """
    Search Wikidata for entity candidates matching place names.
    names: list of (vocab_id, place_name)
    Returns: {vocab_id: [candidate dicts with qid, label, description]}

    Rate-limited: inter-request delay + exponential backoff on 429s.
    """
    try:
        import aiohttp
    except ImportError:
        print("  aiohttp not installed — falling back to synchronous mode",
              file=sys.stderr)
        return _search_wikidata_sync(names)

    results: dict[str, list[dict]] = {}
    semaphore = asyncio.Semaphore(concurrency)
    done = 0
    errors_429 = 0

    # Shared backoff state: when one request gets 429, all slow down
    backoff_until = 0.0

    async def _get_with_retry(session: aiohttp.ClientSession,
                              url: str, max_retries: int = 4) -> dict | None:
        """GET with exponential backoff on 429/5xx."""
        nonlocal backoff_until, errors_429
        loop = asyncio.get_running_loop()

        for attempt in range(max_retries + 1):
            now = loop.time()
            if backoff_until > now:
                await asyncio.sleep(backoff_until - now)

            await asyncio.sleep(0.2)

            try:
                async with session.get(url) as resp:
                    if resp.status == 429:
                        errors_429 += 1
                        wait = min(2 ** attempt * 5, 60)
                        backoff_until = loop.time() + wait
                        if errors_429 <= 3:
                            print(f"  Rate limited (429), backing off {wait}s...",
                                  file=sys.stderr)
                        await asyncio.sleep(wait)
                        continue
                    if resp.status >= 500:
                        await asyncio.sleep(2 ** attempt)
                        continue
                    return await resp.json()
            except Exception:
                if attempt < max_retries:
                    await asyncio.sleep(2 ** attempt)
                    continue
                return None
        return None

    async def search_one(session: aiohttp.ClientSession,
                         vocab_id: str, name: str) -> None:
        nonlocal done
        candidates = []

        async with semaphore:
            for lang in ("nl", "en"):
                url = _build_search_url(name, lang)
                data = await _get_with_retry(session, url)
                candidates.extend(_parse_search_items(data, lang))
                if candidates:
                    break

            # Try bare name if parenthetical and no results yet
            bare = strip_parenthetical(name)
            if bare and not candidates:
                url = _build_search_url(bare, "nl")
                data = await _get_with_retry(session, url)
                candidates.extend(_parse_search_items(data, "nl"))

        results[vocab_id] = _deduplicate_candidates(candidates)

        done += 1
        if done % 200 == 0:
            print(f"  ... {done}/{len(names)} searched", file=sys.stderr)

    headers = {"User-Agent": USER_AGENT}
    connector = aiohttp.TCPConnector(limit=concurrency, force_close=False)
    async with aiohttp.ClientSession(headers=headers,
                                     connector=connector) as session:
        tasks = [search_one(session, vid, name) for vid, name in names]
        await asyncio.gather(*tasks)

    if errors_429:
        print(f"  Total 429 errors encountered: {errors_429}", file=sys.stderr)

    return results


def _search_wikidata_sync(names: list[tuple[str, str]]
                          ) -> dict[str, list[dict]]:
    """Synchronous fallback for Wikidata entity search."""
    results: dict[str, list[dict]] = {}

    for i, (vocab_id, name) in enumerate(names):
        candidates = []

        for lang in ("nl", "en"):
            url = _build_search_url(name, lang)
            try:
                data = fetch_json(url)
                candidates.extend(_parse_search_items(data, lang))
            except Exception as e:
                print(f"  Search error for '{name}' ({lang}): {e}",
                      file=sys.stderr)

            if candidates:
                break

        results[vocab_id] = _deduplicate_candidates(candidates)
        time.sleep(0.2)

        if (i + 1) % 200 == 0:
            print(f"  ... {i + 1}/{len(names)} searched", file=sys.stderr)

    return results


def validate_candidates_sparql(candidates: dict[str, list[dict]],
                               batch_size: int = 300
                               ) -> dict[str, dict]:
    """
    Fetch P31, P17, P625, P131, labels for all candidate QIDs via SPARQL.
    Returns {qid: {types: [...], country_qid, lat, lon, label, admin_qid}}.
    """
    # Collect all unique QIDs
    all_qids = set()
    for cands in candidates.values():
        for c in cands:
            all_qids.add(c["qid"])

    if not all_qids:
        return {}

    print(f"  Validating {len(all_qids)} candidate QIDs via SPARQL",
          file=sys.stderr)

    qid_info: dict[str, dict] = {}
    qid_list = sorted(all_qids)

    for i in range(0, len(qid_list), batch_size):
        batch = qid_list[i:i + batch_size]
        values = " ".join(f"wd:{q}" for q in batch)

        query = f"""
        SELECT ?item ?coord ?lat ?lon ?type ?country ?admin ?label WHERE {{
          VALUES ?item {{ {values} }}
          OPTIONAL {{ ?item wdt:P625 ?coord .
                      BIND(geof:latitude(?coord) AS ?lat)
                      BIND(geof:longitude(?coord) AS ?lon) }}
          OPTIONAL {{ ?item wdt:P31 ?type }}
          OPTIONAL {{ ?item wdt:P17 ?country }}
          OPTIONAL {{ ?item wdt:P131 ?admin }}
          OPTIONAL {{ ?item rdfs:label ?label . FILTER(LANG(?label) = "en") }}
        }}
        """

        try:
            bindings = sparql_query(WIKIDATA_SPARQL, query)
            for b in bindings:
                qid = b["item"]["value"].rsplit("/", 1)[-1]
                if qid not in qid_info:
                    qid_info[qid] = {
                        "types": set(),
                        "country_qid": None,
                        "admin_qid": None,
                        "lat": None,
                        "lon": None,
                        "label": None,
                    }
                info = qid_info[qid]

                if "type" in b:
                    info["types"].add(b["type"]["value"].rsplit("/", 1)[-1])
                if "country" in b and not info["country_qid"]:
                    info["country_qid"] = b["country"]["value"].rsplit("/", 1)[-1]
                if "admin" in b and not info["admin_qid"]:
                    info["admin_qid"] = b["admin"]["value"].rsplit("/", 1)[-1]
                if "lat" in b and info["lat"] is None:
                    info["lat"] = float(b["lat"]["value"])
                    info["lon"] = float(b["lon"]["value"])
                if "label" in b and not info["label"]:
                    info["label"] = b["label"]["value"]

            print(f"  SPARQL batch {i // batch_size + 1}: "
                  f"{len(batch)} QIDs queried", file=sys.stderr)
        except Exception as e:
            print(f"  SPARQL batch {i // batch_size + 1} error: {e}",
                  file=sys.stderr)

        time.sleep(2)

    # Convert type sets to lists for serialization
    for info in qid_info.values():
        info["types"] = list(info["types"])

    return qid_info


def score_candidate(name: str, candidate: dict, qid_info: dict) -> float:
    """
    Score a candidate match (0-100) based on:
    - String similarity (40%)
    - Geographic type (25%)
    - Has coordinates (20%)
    - Country context (15%)
    """
    info = qid_info.get(candidate["qid"], {})
    label = info.get("label") or candidate.get("label", "")

    # 1. String similarity (40%)
    sim = string_similarity(name, label)
    # Also check against parenthetical-stripped name
    bare = strip_parenthetical(name)
    if bare:
        sim = max(sim, string_similarity(bare, label))
    sim_score = sim * 0.40

    # 2. Geographic type (25%)
    types = set(info.get("types", []))
    if types & GEOGRAPHIC_TYPES:
        type_score = 100 * 0.25
    elif types & NON_GEOGRAPHIC_TYPES:
        type_score = 0
    elif not types:
        type_score = 25 * 0.25  # Unknown — slight penalty
    else:
        type_score = 50 * 0.25  # Has types but not in allowlist

    # 3. Has coordinates (20%)
    has_coords = info.get("lat") is not None
    coord_score = 100 * 0.20 if has_coords else 0

    # 4. Country context (15%)
    country = info.get("country_qid")
    if country == "Q55":  # Netherlands
        country_score = 100 * 0.15
    elif country in ("Q142", "Q183", "Q38", "Q145", "Q29", "Q30",
                      "Q252", "Q17", "Q148"):
        # France, Germany, Italy, UK, Spain, US, Indonesia, Japan, China
        country_score = 50 * 0.15
    elif country:
        country_score = 40 * 0.15
    else:
        country_score = 25 * 0.15

    return sim_score + type_score + coord_score + country_score


def phase_3_reconciliation(conn: sqlite3.Connection,
                           dry_run: bool = False,
                           output_dir: str = "offline/geo") -> int:
    """
    Reconcile unmatched place names to Wikidata entities.
    Outputs accepted/review/rejected CSVs and applies accepted matches.
    """
    places = get_ungeocoded(conn, "no_external_used")
    if not places:
        print("Phase 3: No unreconciled places to process", file=sys.stderr)
        return 0

    # Filter out "unknown" and very short names
    candidates_input = []
    skipped = 0
    for p in places:
        name = p["name"] or ""
        if not name or name.lower() in ("unknown", "onbekend", "?", "??"):
            skipped += 1
            continue
        if len(name) < 2:
            skipped += 1
            continue
        candidates_input.append((p["id"], name))

    print(f"Phase 3: {len(candidates_input)} places to reconcile "
          f"({skipped} skipped)", file=sys.stderr)

    if dry_run:
        return 0

    # Step 3a: Search Wikidata for candidates
    print("Phase 3a: Searching Wikidata entities...", file=sys.stderr)
    search_results = asyncio.run(
        search_wikidata_entities(candidates_input, concurrency=5)
    )

    # Count how many found candidates
    with_candidates = sum(1 for v in search_results.values() if v)
    print(f"  Found candidates for {with_candidates}/{len(candidates_input)} places",
          file=sys.stderr)

    # Step 3b: Validate all candidates via SPARQL
    print("Phase 3b: Validating candidates via SPARQL...", file=sys.stderr)
    qid_info = validate_candidates_sparql(search_results)

    # Step 3c: Score and classify
    print("Phase 3c: Scoring candidates...", file=sys.stderr)
    accepted = []   # (vocab_id, name, qid, lat, lon, score)
    review = []     # (vocab_id, name, candidates_with_scores)
    rejected = []   # (vocab_id, name, reason)

    # Build name lookup
    name_lookup = {vid: name for vid, name in candidates_input}

    for vocab_id, cands in search_results.items():
        name = name_lookup.get(vocab_id, "")
        if not cands:
            rejected.append((vocab_id, name, "no_candidates"))
            continue

        # Score each candidate
        scored = []
        for c in cands:
            score = score_candidate(name, c, qid_info)
            info = qid_info.get(c["qid"], {})
            scored.append({
                **c,
                "score": score,
                "lat": info.get("lat"),
                "lon": info.get("lon"),
                "types": info.get("types", []),
                "country_qid": info.get("country_qid"),
                "label_en": info.get("label"),
            })

        scored.sort(key=lambda x: x["score"], reverse=True)
        top = scored[0]

        # Decision thresholds
        gap = top["score"] - scored[1]["score"] if len(scored) > 1 else 100
        has_coords = top["lat"] is not None

        if top["score"] >= 80 and has_coords and gap >= 20:
            accepted.append((vocab_id, name, top["qid"],
                             top["lat"], top["lon"], top["score"]))
        elif top["score"] >= 60 or (has_coords and top["score"] >= 50):
            review.append((vocab_id, name, scored))
        else:
            rejected.append((vocab_id, name, f"low_score:{top['score']:.0f}"))

    print(f"Phase 3c: {len(accepted)} accepted, {len(review)} review, "
          f"{len(rejected)} rejected", file=sys.stderr)

    # Write output CSVs
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)

    # Accepted CSV
    with open(out / "reconciled_accepted.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["vocab_id", "name", "qid", "lat", "lon", "score"])
        for row in accepted:
            w.writerow(row)
    print(f"  Wrote {out / 'reconciled_accepted.csv'} ({len(accepted)} entries)",
          file=sys.stderr)

    # Review CSV
    with open(out / "reconciled_review.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["vocab_id", "name", "decision",
                     "qid_1", "label_1", "score_1", "lat_1", "lon_1", "types_1",
                     "qid_2", "label_2", "score_2", "lat_2", "lon_2", "types_2"])
        for vocab_id, name, scored in review:
            row = [vocab_id, name, ""]
            for j in range(2):
                if j < len(scored):
                    s = scored[j]
                    row.extend([
                        s["qid"], s.get("label_en") or s["label"],
                        f"{s['score']:.0f}",
                        s["lat"], s["lon"],
                        ";".join(s["types"][:3]),
                    ])
                else:
                    row.extend(["", "", "", "", "", ""])
            w.writerow(row)
    print(f"  Wrote {out / 'reconciled_review.csv'} ({len(review)} entries)",
          file=sys.stderr)

    # Rejected CSV
    with open(out / "reconciled_rejected.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["vocab_id", "name", "reason"])
        for row in rejected:
            w.writerow(row)
    print(f"  Wrote {out / 'reconciled_rejected.csv'} ({len(rejected)} entries)",
          file=sys.stderr)

    # Step 3d: Apply accepted matches
    updates: dict[str, tuple[float, float, str]] = {}
    for vocab_id, name, qid, lat, lon, score in accepted:
        ext_id = f"http://www.wikidata.org/entity/{qid}"
        updates[vocab_id] = (lat, lon, ext_id)

    updated = update_coords_and_ids(conn, updates, dry_run)
    print(f"Phase 3d: {updated} places updated with Wikidata matches",
          file=sys.stderr)
    return updated


# ---------------------------------------------------------------------------
# Phase 3 supplement: Apply reviewed matches
# ---------------------------------------------------------------------------

def apply_reviewed(conn: sqlite3.Connection, csv_path: str,
                   dry_run: bool = False) -> int:
    """Apply manually reviewed reconciliation results."""
    path = Path(csv_path)
    if not path.exists():
        print(f"Review CSV not found: {csv_path}", file=sys.stderr)
        return 0

    updates: dict[str, tuple[float, float, str]] = {}

    with open(path, newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            decision = (row.get("decision") or "").strip().lower()
            if decision not in ("y", "yes", "1", "accept"):
                continue

            vocab_id = row["vocab_id"]
            qid = row.get("qid_1", "")
            lat = row.get("lat_1")
            lon = row.get("lon_1")

            if qid and lat and lon:
                try:
                    ext_id = f"http://www.wikidata.org/entity/{qid}"
                    updates[vocab_id] = (float(lat), float(lon), ext_id)
                except ValueError:
                    pass

    print(f"Apply reviewed: {len(updates)} approved entries", file=sys.stderr)

    if dry_run:
        return 0

    updated = update_coords_and_ids(conn, updates, dry_run)
    print(f"Apply reviewed: {updated} places updated", file=sys.stderr)
    return updated


# ---------------------------------------------------------------------------
# Phase 4: Validation
# ---------------------------------------------------------------------------

def phase_4_validation(conn: sqlite3.Connection,
                       output_dir: str = "offline/geo") -> list[dict]:
    """
    Validate all geocoded places. Returns list of issues found.
    Writes validation_report.md.
    """
    rows = conn.execute("""
        SELECT id, label_en, label_nl, lat, lon, external_id,
               COALESCE(NULLIF(label_en, ''), label_nl) AS name
        FROM vocabulary
        WHERE type = 'place' AND lat IS NOT NULL
    """).fetchall()

    print(f"Phase 4: Validating {len(rows)} geocoded places", file=sys.stderr)

    issues: list[dict] = []

    # Track coordinates for duplicate check
    coord_map: dict[tuple[float, float], list[dict]] = defaultdict(list)

    for r in rows:
        row = dict(r)
        lat, lon = row["lat"], row["lon"]
        name = row["name"] or ""

        # 1. Null Island: (0, 0) or very close
        if abs(lat) < 0.01 and abs(lon) < 0.01:
            issues.append({
                "id": row["id"], "name": name,
                "lat": lat, "lon": lon,
                "issue": "null_island",
                "detail": f"Coordinates ({lat}, {lon}) are at or near Null Island",
            })

        # 2. Lat out of range
        if abs(lat) > 90:
            issues.append({
                "id": row["id"], "name": name,
                "lat": lat, "lon": lon,
                "issue": "lat_out_of_range",
                "detail": f"Latitude {lat} exceeds ±90°",
            })

        # 3. Lon out of range
        if abs(lon) > 180:
            issues.append({
                "id": row["id"], "name": name,
                "lat": lat, "lon": lon,
                "issue": "lon_out_of_range",
                "detail": f"Longitude {lon} exceeds ±180°",
            })

        # 4. Lat/lon swap detection for known Dutch cities
        #    Use exact match or word boundary to avoid false positives like
        #    "Amsterdamse Poort" (Jakarta) or "Dordrecht" (South Africa)
        dutch_cities = {"amsterdam", "rotterdam", "den haag", "utrecht",
                        "leiden", "haarlem", "delft", "groningen",
                        "breda", "maastricht", "dordrecht"}
        name_lower = name.lower()
        is_dutch_city = (name_lower in dutch_cities or
                         any(name_lower == f"{c}" for c in dutch_cities))
        if is_dutch_city:
            # Dutch places should be ~47-54°N, 3-7°E
            if not (47 <= lat <= 54 and 3 <= lon <= 8):
                # Check if swapped
                if 47 <= lon <= 54 and 3 <= lat <= 8:
                    issues.append({
                        "id": row["id"], "name": name,
                        "lat": lat, "lon": lon,
                        "issue": "lat_lon_swap",
                        "detail": f"Likely swapped: ({lat}, {lon}) "
                                  f"→ should be ({lon}, {lat})",
                    })
                elif lat < 0:
                    issues.append({
                        "id": row["id"], "name": name,
                        "lat": lat, "lon": lon,
                        "issue": "negative_lat",
                        "detail": f"Dutch place with negative latitude: {lat}",
                    })

        # 5. Caribbean territories check (exact match or starts-with to
        #    avoid false positives like "Sint-Maartenskerk" in NL)
        caribbean_keywords = {"curaçao", "curacao", "bonaire", "sint-eustatius",
                              "sint maarten", "aruba", "suriname"}
        is_caribbean = (name_lower in caribbean_keywords or
                        name_lower.startswith(tuple(
                            f"{kw} " for kw in caribbean_keywords)) or
                        name_lower.startswith(tuple(
                            f"{kw}," for kw in caribbean_keywords)) or
                        re.search(r'\b(?:curaçao|curacao|bonaire|aruba)\b',
                                  name_lower))
        if is_caribbean:
            if not (10 <= lat <= 20 and -71 <= lon <= -55):
                if not (-10 <= lat <= 10 and -60 <= lon <= -45):
                    # Could also be Suriname
                    issues.append({
                        "id": row["id"], "name": name,
                        "lat": lat, "lon": lon,
                        "issue": "caribbean_outlier",
                        "detail": f"Caribbean/Suriname place outside expected range",
                    })

        # Collect for duplicate check
        coord_key = (round(lat, 4), round(lon, 4))
        coord_map[coord_key].append(row)

    # 6. Duplicate coordinate check (5+ entries at same point, excluding (0,0))
    for coord, entries in coord_map.items():
        if len(entries) >= 5 and coord != (0.0, 0.0):
            names = [e["name"] for e in entries[:5]]
            # Only flag if names look unrelated
            name_set = {n.lower().split()[0] if n else "" for n in names}
            if len(name_set) >= 3:
                issues.append({
                    "id": entries[0]["id"],
                    "name": f"{len(entries)} entries",
                    "lat": coord[0], "lon": coord[1],
                    "issue": "duplicate_coords",
                    "detail": f"{len(entries)} places at ({coord[0]}, {coord[1]}): "
                              f"{', '.join(names[:5])}...",
                })

    # Write report
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)

    total, with_coords = get_coverage(conn)

    report_lines = [
        "# Geocoding Validation Report",
        f"\n**Date:** {datetime.now().strftime('%Y-%m-%d %H:%M')}",
        f"\n## Coverage",
        f"- Total places: {total:,}",
        f"- With coordinates: {with_coords:,} ({with_coords/total*100:.1f}%)",
        f"- Without coordinates: {total - with_coords:,}",
        f"\n## Issues Found: {len(issues)}",
    ]

    if issues:
        # Group by issue type
        by_type: dict[str, list[dict]] = defaultdict(list)
        for issue in issues:
            by_type[issue["issue"]].append(issue)

        for issue_type, items in sorted(by_type.items()):
            report_lines.append(f"\n### {issue_type} ({len(items)})")
            report_lines.append("")
            report_lines.append("| ID | Name | Lat | Lon | Detail |")
            report_lines.append("|---|---|---|---|---|")
            for item in items[:50]:  # Cap at 50 per type
                report_lines.append(
                    f"| {item['id']} | {item['name']} | "
                    f"{item['lat']} | {item['lon']} | {item['detail']} |"
                )
            if len(items) > 50:
                report_lines.append(f"| ... | *{len(items) - 50} more* | | | |")
    else:
        report_lines.append("\nNo issues found.")

    report_path = out / "validation_report.md"
    report_path.write_text("\n".join(report_lines) + "\n")
    print(f"Phase 4: {len(issues)} issues found → {report_path}",
          file=sys.stderr)

    return issues


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Geocode remaining places in the vocabulary DB",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python3 scripts/geocode_places.py --db data/vocabulary.db
  python3 scripts/geocode_places.py --db data/vocabulary.db --dry-run
  python3 scripts/geocode_places.py --db data/vocabulary.db --phase 3
  python3 scripts/geocode_places.py --db data/vocabulary.db --skip-geonames
  python3 scripts/geocode_places.py --db data/vocabulary.db \\
      --apply-reviewed offline/geo/reconciled_review.csv
        """,
    )
    parser.add_argument("--db", default="data/vocabulary.db",
                        help="Path to vocabulary.db")
    parser.add_argument("--dry-run", action="store_true",
                        help="Show counts but don't modify DB")
    parser.add_argument("--phase", type=str,
                        help="Run only specific phase (1a, 1b, 1c, 2, 3, 4)")
    parser.add_argument("--skip-geonames", action="store_true",
                        help="Skip Phase 1a (GeoNames API)")
    parser.add_argument("--geonames-user",
                        default=os.environ.get("GEONAMES_USERNAME", "demo"),
                        help="GeoNames API username (or set GEONAMES_USERNAME env var)")
    parser.add_argument("--apply-reviewed",
                        help="Path to reviewed CSV with 'decision' column")
    parser.add_argument("--output-dir", default="offline/geo",
                        help="Output directory for CSVs and reports")
    args = parser.parse_args()

    # Resolve DB path
    db_path = Path(args.db)
    if not db_path.exists():
        repo_root = Path(__file__).resolve().parent.parent
        db_path = repo_root / args.db
    if not db_path.exists():
        print(f"DB not found: {args.db}", file=sys.stderr)
        sys.exit(1)

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row

    # Show initial coverage
    total, with_coords = get_coverage(conn)
    print(f"{'=' * 60}", file=sys.stderr)
    print(f"Geocode Places — {db_path.name}", file=sys.stderr)
    print(f"Coverage: {with_coords:,} / {total:,} ({with_coords/total*100:.1f}%)",
          file=sys.stderr)
    print(f"{'=' * 60}", file=sys.stderr)

    if args.dry_run:
        print("DRY RUN — no database modifications\n", file=sys.stderr)

    # Handle --apply-reviewed mode
    if args.apply_reviewed:
        updated = apply_reviewed(conn, args.apply_reviewed, args.dry_run)
        total, with_coords = get_coverage(conn)
        print(f"\nFinal coverage: {with_coords:,} / {total:,} "
              f"({with_coords/total*100:.1f}%)", file=sys.stderr)
        conn.close()
        return

    total_updated = 0
    run_phase = args.phase

    # Phase 1a: GeoNames
    if run_phase in (None, "1a") and not args.skip_geonames:
        print(f"\n--- Phase 1a: GeoNames API ---", file=sys.stderr)
        total_updated += phase_1a_geonames(conn, args.geonames_user, args.dry_run)

    # Phase 1b: Wikidata alternative properties
    if run_phase in (None, "1b"):
        print(f"\n--- Phase 1b: Wikidata alt-props ---", file=sys.stderr)
        total_updated += phase_1b_wikidata_alt(conn, args.dry_run)

    # Phase 1c: Getty → Wikidata cross-reference
    if run_phase in (None, "1c"):
        print(f"\n--- Phase 1c: Getty TGN → Wikidata ---", file=sys.stderr)
        total_updated += phase_1c_getty_crossref(conn, args.dry_run)

    # Phase 2: Self-reference resolution
    if run_phase in (None, "2"):
        print(f"\n--- Phase 2: Self-reference resolution ---", file=sys.stderr)
        total_updated += phase_2_self_refs(conn, args.dry_run)

    # Phase 3: Wikidata entity reconciliation
    if run_phase in (None, "3"):
        print(f"\n--- Phase 3: Wikidata entity reconciliation ---",
              file=sys.stderr)
        total_updated += phase_3_reconciliation(
            conn, args.dry_run, args.output_dir)

    # Phase 4: Validation
    if run_phase in (None, "4"):
        print(f"\n--- Phase 4: Validation ---", file=sys.stderr)
        phase_4_validation(conn, args.output_dir)

    # Final summary
    total, with_coords = get_coverage(conn)
    print(f"\n{'=' * 60}", file=sys.stderr)
    print(f"Summary:", file=sys.stderr)
    print(f"  Places updated this run:  {total_updated:,}", file=sys.stderr)
    print(f"  Total places in DB:       {total:,}", file=sys.stderr)
    print(f"  With coordinates:         {with_coords:,}", file=sys.stderr)
    print(f"  Coverage:                 {with_coords/total*100:.1f}%",
          file=sys.stderr)
    print(f"{'=' * 60}", file=sys.stderr)

    conn.close()


if __name__ == "__main__":
    main()
