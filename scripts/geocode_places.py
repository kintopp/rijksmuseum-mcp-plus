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
  3b  World Historical Gazetteer — reconcile remaining names via WHG API
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
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from difflib import SequenceMatcher
from pathlib import Path

# Local module for #218 enrichment-provenance constants (tier_for, detail values).
# Sibling file, same dir.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import enrichment_methods as em  # noqa: E402

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
WHG_RECONCILE_URL = "https://whgazetteer.org/reconcile"

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
# Country QID → ISO 3166-1 alpha-2 lookup (#257 layer B)
# ---------------------------------------------------------------------------
# Loaded once at module import. Populated by scripts/fetch_country_qid_to_iso2.py
# and committed as scripts/country_qid_to_iso2.tsv. Used to:
#   (a) Recognise whether a broader_id ancestor QID is a country (presence → yes).
#   (b) Convert the derived country QID to the ISO-2 code used by WHG's
#       response description field ("Country: XX") for post-filter comparison.

def _load_country_qid_to_iso2() -> dict[str, str]:
    """Load the committed country QID → ISO-2 TSV. Empty dict on failure."""
    path = Path(__file__).resolve().parent / "country_qid_to_iso2.tsv"
    result: dict[str, str] = {}
    if not path.exists():
        return result
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) == 2 and parts[0].startswith("Q"):
            result[parts[0]] = parts[1].upper()
    return result


COUNTRY_QID_TO_ISO2: dict[str, str] = _load_country_qid_to_iso2()


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
    """Get places missing coordinates, optionally filtered by category.

    Legacy helper: reads from ``vocabulary.external_id`` only. Phases 1a/1b/1c
    should use ``get_ungeocoded_by_authority`` instead, which also picks up
    authority links stored exclusively in ``vocabulary_external_ids``
    (~2,000 TGN + ~48 GeoNames rows added by #238). Still used by self-ref
    (Phase 2) and no_external (Phase 3) paths.
    """
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
        # Integer-encoded schema (v0.21+): mappings.vocab_rowid FKs to
        # vocabulary.vocab_int_id, not the text id. The old m.vocab_id
        # reference predated the schema migration and silently crashed
        # whenever Phase 3 fired against a post-v0.21 DB. See #105.
        #
        # Correlated EXISTS is catastrophic here (7.9K outer rows × full
        # scan of idx_mappings_field_vocab — ~10 min observed); the only
        # mappings index is (field_id, vocab_rowid) so a lookup by
        # vocab_rowid alone is an index scan. IN (SELECT DISTINCT …)
        # materialises the vocab_rowid set once (~1.6s) and the planner
        # then does a bounded IN check per outer row.
        base += " AND v.vocab_int_id IN (SELECT DISTINCT vocab_rowid FROM mappings)"
    elif category == "no_external":
        base += " AND (v.external_id IS NULL OR v.external_id = '')"

    rows = conn.execute(base).fetchall()
    return [dict(r) for r in rows]


def _build_country_derivation_maps(
    conn: sqlite3.Connection,
) -> tuple[dict[str, str], dict[str, str]]:
    """Preload the two lookups needed to walk broader_id chains in pure Python.

    Returns ``(broader_by_id, wd_qid_by_id)``. Both dicts are restricted
    to ``type='place'`` rows so non-place Wikidata QIDs (persons,
    concepts) can't accidentally match entries in ``COUNTRY_QID_TO_ISO2``
    during the chain walk. At ~400K vocab rows this is ~30-50 MB of
    dict overhead — cheap vs the ~84K-query N+1 it replaces.
    """
    broader_by_id = dict(conn.execute(
        "SELECT id, broader_id FROM vocabulary "
        "WHERE type = 'place' AND broader_id IS NOT NULL"
    ))
    wd_qid_by_id: dict[str, str] = dict(conn.execute(
        "SELECT vei.vocab_id, vei.id FROM vocabulary_external_ids vei "
        "JOIN vocabulary v ON v.id = vei.vocab_id "
        "WHERE vei.authority = 'wikidata' AND v.type = 'place'"
    ))
    # Fold the legacy vocabulary.external_id column into the same map
    # for any place not yet covered via vocabulary_external_ids.
    legacy_rows = conn.execute(
        "SELECT id, external_id FROM vocabulary "
        "WHERE type = 'place' AND external_id LIKE '%wikidata%'"
    )
    for vid, ext in legacy_rows:
        if vid not in wd_qid_by_id:
            qid = extract_qid(ext or "")
            if qid:
                wd_qid_by_id[vid] = qid
    return broader_by_id, wd_qid_by_id


def _derive_country_qid(
    place_id: str,
    broader_by_id: dict[str, str],
    wd_qid_by_id: dict[str, str],
    max_depth: int = 6,
) -> str | None:
    """Walk broader_id chain in memory to find an ancestor's country QID.

    #257 layer A: the QID becomes a P17 hint on the WHG query.
    #257 layer B: it's mapped via COUNTRY_QID_TO_ISO2 to compare against
    WHG's ``description: "Country: XX"`` field.
    """
    current_id: str | None = place_id
    for _ in range(max_depth):
        next_id = broader_by_id.get(current_id)
        if not next_id or next_id == current_id:
            return None
        current_id = next_id
        qid = wd_qid_by_id.get(current_id)
        if qid and qid in COUNTRY_QID_TO_ISO2:
            return qid
    return None


def get_ungeocoded_by_authority(conn: sqlite3.Connection, authority: str
                                ) -> list[dict]:
    """Get ungeocoded places with an authority link, unified across both sources.

    Reads from ``vocabulary_external_ids`` (primary — bare IDs, multi-ID support)
    UNION with ``vocabulary.external_id`` (legacy — single URI per row, pre-#238).
    Returns one row per vocab_id; prefers the ``vocabulary_external_ids`` entry
    when both sources have it.

    ``authority`` is one of the ``vocabulary_external_ids.authority`` values:
    ``'wikidata'``, ``'geonames'``, ``'tgn'``, etc.

    Returns dicts with: ``id`` (vocab_id), ``label_en``, ``label_nl``, ``name``,
    ``authority_id`` (bare entity ID, already parsed), ``authority_uri``
    (full URI, when available).
    """
    # Legacy column mapping: authority → LIKE pattern + extractor name.
    # Only the three external-coord authorities are supported here; self-ref
    # is handled separately (Phase 2).
    legacy_like = {
        "wikidata": "%wikidata%",
        "geonames": "%geonames%",
        "tgn":      "%getty.edu/tgn%",
    }[authority]

    # Primary: vocabulary_external_ids has the bare id + uri directly.
    # A handful of places carry multiple entries for the same authority
    # (e.g. merged records with two Wikidata IDs); keep only the first
    # encountered row per vocab_id.
    primary = conn.execute("""
        SELECT v.id, v.label_en, v.label_nl,
               COALESCE(NULLIF(v.label_en, ''), v.label_nl) AS name,
               vei.id AS authority_id,
               vei.uri AS authority_uri
        FROM vocabulary v
        JOIN vocabulary_external_ids vei ON vei.vocab_id = v.id
        WHERE v.type = 'place' AND v.lat IS NULL AND vei.authority = ?
    """, (authority,)).fetchall()

    seen: set[str] = set()
    result: list[dict] = []
    for r in primary:
        vocab_id = r["id"]
        if vocab_id in seen:
            continue
        seen.add(vocab_id)
        result.append(dict(r))

    # Legacy: vocabulary.external_id only. Extract the bare ID in Python
    # via the authority-specific extractor.
    legacy_rows = conn.execute(f"""
        SELECT v.id, v.label_en, v.label_nl,
               COALESCE(NULLIF(v.label_en, ''), v.label_nl) AS name,
               v.external_id
        FROM vocabulary v
        WHERE v.type = 'place' AND v.lat IS NULL
          AND v.external_id LIKE ?
    """, (legacy_like,)).fetchall()

    extractor = {
        "wikidata": extract_qid,
        "geonames": extract_geonames_id,
        "tgn":      extract_tgn_id,
    }[authority]

    for r in legacy_rows:
        vocab_id = r["id"]
        if vocab_id in seen:
            continue  # already covered via vocabulary_external_ids
        authority_id = extractor(r["external_id"] or "")
        if not authority_id:
            continue
        result.append({
            "id":            vocab_id,
            "label_en":      r["label_en"],
            "label_nl":      r["label_nl"],
            "name":          r["name"],
            "authority_id":  authority_id,
            "authority_uri": r["external_id"],
        })
        seen.add(vocab_id)

    return result


def update_coords(conn: sqlite3.Connection,
                  updates: dict[str, tuple[float, float]],
                  coord_method_detail: str,
                  dry_run: bool = False) -> int:
    """Write lat/lon + coord_method to vocabulary. Returns count updated.

    ``coord_method_detail`` is one of the fine-grained constants from
    ``enrichment_methods`` (e.g. ``em.GEONAMES_API``, ``em.WIKIDATA_P625``).
    The coarse tier (authority / derived / human) is derived via
    ``em.tier_for(coord_method_detail)`` and written to ``coord_method``.
    The detail value itself is CSV-only per #218 (not stored in the DB).

    The `AND lat IS NULL` guard is trust-tier enforcement, not a performance
    optimisation: phases run in priority order (1a GeoNames API → 1b Wikidata
    P-property lookup → 1c Getty TGN → 2 self-ref → 3 Wikidata reconciliation →
    3b WHG reconciliation), and this clause prevents a lower-confidence phase
    from overwriting a higher-confidence phase's earlier write. Removing it
    would let fuzzy-match reconciliation (Phase 3/3b) clobber authority-ID
    lookups (Phase 1a/b/c) — which historically pointed e.g. "Exmouth" at a
    peninsula in Western Australia while Phase 1a had correctly placed it in
    Devon. See issue #218 and the v0.24 feasibility-check notes.
    """
    if dry_run or not updates:
        return 0
    coord_tier = em.tier_for(coord_method_detail)  # raises on unknown — fail fast
    cursor = conn.cursor()
    updated = 0
    for vocab_id, (lat, lon) in updates.items():
        cursor.execute(
            "UPDATE vocabulary SET lat = ?, lon = ?, "
            "coord_method = ?, coord_method_detail = ? "
            "WHERE id = ? AND lat IS NULL",
            (lat, lon, coord_tier, coord_method_detail, vocab_id),
        )
        updated += cursor.rowcount
    conn.commit()
    return updated


def update_coords_and_ids(conn: sqlite3.Connection,
                          updates: dict[str, tuple[float, float, str]],
                          coord_method_detail: str,
                          external_id_method_detail: str,
                          dry_run: bool = False) -> int:
    """Write lat/lon + external_id + both method tiers to vocabulary.

    Both detail parameters are required and validated via ``em.tier_for()``.
    Same trust-tier enforcement as ``update_coords`` — see its docstring.
    The ``AND lat IS NULL`` guard is load-bearing, not a perf trick.
    """
    if dry_run or not updates:
        return 0
    coord_tier = em.tier_for(coord_method_detail)
    ext_id_tier = em.tier_for(external_id_method_detail)
    cursor = conn.cursor()
    updated = 0
    for vocab_id, (lat, lon, ext_id) in updates.items():
        cursor.execute(
            "UPDATE vocabulary SET lat = ?, lon = ?, external_id = ?, "
            "coord_method = ?, coord_method_detail = ?, "
            "external_id_method = ?, external_id_method_detail = ? "
            "WHERE id = ? AND lat IS NULL",
            (lat, lon, ext_id, coord_tier, coord_method_detail,
             ext_id_tier, external_id_method_detail, vocab_id),
        )
        updated += cursor.rowcount
    conn.commit()
    return updated


def filter_reconcilable(places: list[dict]) -> tuple[list[tuple[str, str]], int]:
    """Filter out unknowns and very short names from place lists.

    Returns (candidates, skipped_count) where candidates are (vocab_id, name) tuples.
    Shared by Phase 3 and Phase 3b.
    """
    candidates: list[tuple[str, str]] = []
    skipped = 0
    for p in places:
        name = p["name"] or ""
        if not name or name.lower() in ("unknown", "onbekend", "?", "??") or len(name) < 2:
            skipped += 1
            continue
        candidates.append((p["id"], name))
    return candidates, skipped


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
                      dry_run: bool = False,
                      csv_only: bool = False,
                      output_dir: str = "data/audit") -> int:
    """Geocode places with GeoNames IDs via the GeoNames API.

    Sources authority IDs from both ``vocabulary_external_ids`` (primary,
    post-#238) and ``vocabulary.external_id`` (legacy). See
    ``get_ungeocoded_by_authority``.

    With ``csv_only=True`` the resolved (vocab_id, lat, lon) tuples are
    written to ``<output_dir>/phase_1a_geonames.csv`` and the DB is not
    modified.
    """
    places = get_ungeocoded_by_authority(conn, "geonames")
    if not places:
        print("Phase 1a: No GeoNames entries to geocode", file=sys.stderr)
        return 0

    # Build ID → vocab_id mapping. authority_id is already the bare GeoNames
    # numeric ID thanks to the helper's extractor logic.
    gn_to_vocab: dict[str, list[str]] = {}
    for p in places:
        gn_id = p["authority_id"]
        if gn_id and str(gn_id).isdigit():
            gn_to_vocab.setdefault(str(gn_id), []).append(p["id"])

    print(f"Phase 1a: {len(gn_to_vocab)} GeoNames IDs to geocode", file=sys.stderr)

    if dry_run:
        return 0

    results: dict[str, tuple[float, float]] = {}
    errors = 0
    errors_429 = 0
    # Free-tier limits are hourly (1000) and daily (20000). GeoNames returns 200
    # OK with a ``status.message`` body on limit hits; it may also return 429 if
    # hammered. Both paths funnel into the same exponential-backoff loop,
    # capped at one hour. After ``hard_stop_threshold`` consecutive limit hits
    # *at the cap*, the phase soft-exits: rows not yet processed will be
    # picked up on the next rerun via the ``AND lat IS NULL`` resume guard.
    GEONAMES_LIMIT_PHRASES = (
        "hourly limit",
        "daily limit",
        "the daily limit",
        "credits have expired",
        "limit of credits",
        "limit for this service",
    )
    hard_stop_threshold = 3
    max_backoff_s = 3600
    consecutive_limit_hits = 0
    backoff_until = 0.0
    hard_stop = False
    cutoff_gn_id: str | None = None

    gn_ids_list = list(gn_to_vocab.keys())
    for i, gn_id in enumerate(gn_ids_list):
        if hard_stop:
            cutoff_gn_id = gn_id
            break

        now = time.time()
        if backoff_until > now:
            time.sleep(backoff_until - now)

        limit_hit = False
        hit_msg = ""
        try:
            url = f"{GEONAMES_API}?geonameId={gn_id}&username={username}"
            data = fetch_json(url)
            if "lat" in data and "lng" in data:
                lat = float(data["lat"])
                lon = float(data["lng"])
                if lat != 0 or lon != 0:  # Skip null island
                    for vocab_id in gn_to_vocab[gn_id]:
                        results[vocab_id] = (lat, lon)
                consecutive_limit_hits = 0
            elif "status" in data:
                msg = (data["status"].get("message") or "").lower()
                if any(phrase in msg for phrase in GEONAMES_LIMIT_PHRASES):
                    limit_hit = True
                    hit_msg = msg
                else:
                    print(f"  GeoNames {gn_id}: "
                          f"{data['status'].get('message', 'error')}",
                          file=sys.stderr)
                    errors += 1
                    consecutive_limit_hits = 0
            else:
                consecutive_limit_hits = 0
        except urllib.error.HTTPError as e:
            if e.code == 429:
                errors_429 += 1
                limit_hit = True
                hit_msg = f"HTTP 429 ({e.reason})"
            else:
                print(f"  GeoNames {gn_id} HTTP {e.code}: {e}", file=sys.stderr)
                errors += 1
                consecutive_limit_hits = 0
        except Exception as e:
            print(f"  GeoNames {gn_id} error: {e}", file=sys.stderr)
            errors += 1
            consecutive_limit_hits = 0

        if limit_hit:
            consecutive_limit_hits += 1
            wait = min(60 * (2 ** (consecutive_limit_hits - 1)), max_backoff_s)
            print(f"  GeoNames limit hit: {hit_msg.strip()!r} — "
                  f"backing off {wait}s (consecutive={consecutive_limit_hits})",
                  file=sys.stderr)
            backoff_until = time.time() + wait
            if consecutive_limit_hits >= hard_stop_threshold and wait >= max_backoff_s:
                print(f"  Sustained limit failures at {max_backoff_s}s cap; "
                      f"halting Phase 1a at gn_id={gn_id} "
                      f"({i}/{len(gn_ids_list)} processed). "
                      f"Rerun later — `AND lat IS NULL` resume will pick up the rest.",
                      file=sys.stderr)
                hard_stop = True
                cutoff_gn_id = gn_id
            # Do NOT sleep the 1 req/sec here — the backoff already covered it.
            continue

        # Rate limit: 1 req/sec for free tier
        time.sleep(1.0)
        if (i + 1) % 50 == 0:
            print(f"  ... {i + 1}/{len(gn_ids_list)} done ({len(results)} found)",
                  file=sys.stderr)

    if csv_only:
        out = Path(output_dir)
        out.mkdir(parents=True, exist_ok=True)
        csv_path = out / "phase_1a_geonames.csv"
        with open(csv_path, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["vocab_id", "lat", "lon", "method", "method_detail"])
            for vocab_id, (lat, lon) in results.items():
                w.writerow([vocab_id, lat, lon,
                            em.tier_for(em.GEONAMES_API), em.GEONAMES_API])
        print(f"Phase 1a: {len(results)} places written to {csv_path} "
              f"(csv-only — DB not modified)", file=sys.stderr)
        return 0

    updated = update_coords(conn, results, em.GEONAMES_API, dry_run)
    summary = [f"{updated} places updated", f"{errors} errors"]
    if errors_429:
        summary.append(f"{errors_429} 429s")
    if hard_stop:
        summary.append(f"HALTED at gn_id={cutoff_gn_id}")
    print(f"Phase 1a: {', '.join(summary)}", file=sys.stderr)
    return updated


# ---------------------------------------------------------------------------
# Phase 1b: Wikidata P625 alternatives
# ---------------------------------------------------------------------------

def phase_1b_wikidata_alt(conn: sqlite3.Connection,
                          dry_run: bool = False,
                          csv_only: bool = False,
                          output_dir: str = "data/audit") -> int:
    """Geocode Wikidata entries missing P625 via alternative properties.

    Fires for QIDs where the direct P625 lookup failed (handled earlier by
    ``batch_geocode.geocode_wikidata``). Tries three alternative paths in
    priority order — P159 (headquarters) → P276 (location) → P131 (admin
    territory) — and tags each write with the specific property that won
    (so downstream consumers can distinguish e.g. a parent-admin fallback
    from a direct headquarters match).

    Sources QIDs from both ``vocabulary_external_ids`` and the legacy
    ``vocabulary.external_id`` column.

    With ``csv_only=True`` resolved (vocab_id, lat, lon, method_detail)
    rows are written to ``<output_dir>/phase_1b_wikidata_alt.csv`` and
    the DB is not modified.
    """
    places = get_ungeocoded_by_authority(conn, "wikidata")
    if not places:
        print("Phase 1b: No Wikidata entries to geocode", file=sys.stderr)
        return 0

    # Build QID → vocab_id mapping.
    qid_to_vocab: dict[str, list[str]] = {}
    for p in places:
        qid = p["authority_id"]
        if qid and str(qid).startswith("Q"):
            qid_to_vocab.setdefault(qid, []).append(p["id"])

    print(f"Phase 1b: {len(qid_to_vocab)} Wikidata QIDs without P625",
          file=sys.stderr)

    if dry_run:
        return 0

    # Per-result: {vocab_id: (lat, lon, detail)}. Priority order enforces
    # P159 > P276 > P131 if a QID has multiple alt-paths.
    PROP_PRIORITY = {em.WIKIDATA_P159: 0, em.WIKIDATA_P276: 1, em.WIKIDATA_P131: 2}
    PROP_FROM_SPARQL = {
        "P159": em.WIKIDATA_P159,
        "P276": em.WIKIDATA_P276,
        "P131": em.WIKIDATA_P131,
    }
    per_qid: dict[str, tuple[float, float, str]] = {}
    qids = list(qid_to_vocab.keys())
    batch_size = 200

    for i in range(0, len(qids), batch_size):
        batch = qids[i:i + batch_size]
        values = " ".join(f"wd:{qid}" for qid in batch)

        # Same three UNION branches as before, now with a ?prop binding so
        # we know which path produced each coordinate.
        query = f"""
        SELECT ?item ?lat ?lon ?prop WHERE {{
          VALUES ?item {{ {values} }}
          {{
            ?item wdt:P159 ?hq .
            ?hq wdt:P625 ?coord .
            BIND("P159" AS ?prop)
          }} UNION {{
            ?item wdt:P276 ?loc .
            ?loc wdt:P625 ?coord .
            BIND("P276" AS ?prop)
          }} UNION {{
            ?item wdt:P131 ?admin .
            ?admin wdt:P625 ?coord .
            BIND("P131" AS ?prop)
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
                prop_raw = b["prop"]["value"]
                detail = PROP_FROM_SPARQL.get(prop_raw)
                if detail is None:
                    continue
                # Keep the highest-priority (lowest number) detail per QID.
                existing = per_qid.get(qid)
                if existing is None or PROP_PRIORITY[detail] < PROP_PRIORITY[existing[2]]:
                    per_qid[qid] = (lat, lon, detail)

            print(f"  Batch {i // batch_size + 1}: {len(batch)} QIDs → "
                  f"{len(bindings)} with alt coords", file=sys.stderr)
        except Exception as e:
            print(f"  Batch {i // batch_size + 1} error: {e}", file=sys.stderr)

        time.sleep(2)

    # Fan out per-QID results to vocab_ids, bucketed by detail tag for
    # separate UPDATE calls (update_coords takes one detail per call).
    by_detail: dict[str, dict[str, tuple[float, float]]] = defaultdict(dict)
    for qid, (lat, lon, detail) in per_qid.items():
        for vocab_id in qid_to_vocab[qid]:
            by_detail[detail][vocab_id] = (lat, lon)

    if csv_only:
        out = Path(output_dir)
        out.mkdir(parents=True, exist_ok=True)
        csv_path = out / "phase_1b_wikidata_alt.csv"
        n = 0
        with open(csv_path, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["vocab_id", "lat", "lon", "method", "method_detail"])
            for detail, results in by_detail.items():
                for vocab_id, (lat, lon) in results.items():
                    w.writerow([vocab_id, lat, lon, em.tier_for(detail), detail])
                    n += 1
        print(f"Phase 1b: {n} places written to {csv_path} "
              f"(csv-only — DB not modified)", file=sys.stderr)
        return 0

    total = 0
    for detail, results in by_detail.items():
        total += update_coords(conn, results, detail, dry_run)
    print(f"Phase 1b: {total} places updated "
          f"(P159={len(by_detail.get(em.WIKIDATA_P159, {}))}, "
          f"P276={len(by_detail.get(em.WIKIDATA_P276, {}))}, "
          f"P131={len(by_detail.get(em.WIKIDATA_P131, {}))})",
          file=sys.stderr)
    return total


# ---------------------------------------------------------------------------
# Phase 1c: Getty TGN → Wikidata cross-reference
# ---------------------------------------------------------------------------

def phase_1c_getty_crossref(conn: sqlite3.Connection,
                            dry_run: bool = False,
                            csv_only: bool = False,
                            output_dir: str = "data/audit") -> int:
    """Cross-reference Getty TGN IDs to Wikidata via P1667.

    This is the *indirect* TGN path — Wikidata entities that reference a TGN
    ID via their P1667 ("Getty Thesaurus of Geographic Names ID") property,
    from which we pull P625. The *direct* TGN path (dereferencing Getty's
    own SPARQL for coords) is handled by ``batch_geocode.geocode_getty()``
    and tagged ``em.TGN_DIRECT``. This phase fires as the fallback for TGN
    IDs that direct lookup failed to geocode — tagged ``em.TGN_VIA_WIKIDATA``.

    Sources TGN IDs from both ``vocabulary_external_ids`` (primary — where
    most TGN links live post-#238) and legacy ``vocabulary.external_id``.

    With ``csv_only=True`` the resolved (vocab_id, lat, lon) tuples are
    written to ``<output_dir>/phase_1c_getty_crossref.csv`` and the DB is
    not modified — useful for smoke tests and audit captures.
    """
    places = get_ungeocoded_by_authority(conn, "tgn")
    if not places:
        print("Phase 1c: No Getty TGN entries to geocode", file=sys.stderr)
        return 0

    # Build TGN ID → vocab_id mapping. authority_id is already the bare
    # numeric TGN ID from the helper.
    tgn_to_vocab: dict[str, list[str]] = {}
    for p in places:
        tgn_id = p["authority_id"]
        if tgn_id:
            tgn_to_vocab.setdefault(str(tgn_id), []).append(p["id"])

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

    if csv_only:
        out = Path(output_dir)
        out.mkdir(parents=True, exist_ok=True)
        csv_path = out / "phase_1c_getty_crossref.csv"
        with open(csv_path, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["vocab_id", "lat", "lon", "method", "method_detail"])
            for vocab_id, (lat, lon) in results.items():
                w.writerow([vocab_id, lat, lon,
                            em.tier_for(em.TGN_VIA_WIKIDATA), em.TGN_VIA_WIKIDATA])
        print(f"Phase 1c: {len(results)} places written to {csv_path} "
              f"(csv-only — DB not modified)", file=sys.stderr)
        return 0

    # Phase 1c is the via-Wikidata-P1667 path by construction; the direct
    # TGN path (tgn_direct) lives in batch_geocode.geocode_getty(). No
    # per-result sub-path distinction needed here.
    updated = update_coords(conn, results, em.TGN_VIA_WIKIDATA, dry_run)
    print(f"Phase 1c: {updated} places updated", file=sys.stderr)
    return updated


# ---------------------------------------------------------------------------
# Phase 2: Self-reference resolution
# ---------------------------------------------------------------------------

def _normalize_place_name(name: str) -> str:
    """Lowercase + strip whitespace. Used for WOF / Pleiades name matching."""
    return (name or "").strip().lower()


WOF_ACCEPT_PLACETYPES: tuple[str, ...] = (
    "country", "region", "county", "locality", "localadmin", "borough", "dependency",
)
WOF_SETTLEMENT_PLACETYPES = frozenset({"locality", "localadmin", "borough"})

# Vocab placetype URIs that indicate a settlement-class entity (subset of
# em.INHERITANCE_ALLOWED_PLACETYPES that maps cleanly to WOF locality-tier).
# When vocab.placetype is in this set, Phase 1d requires WOF placetype to be
# a settlement-tier match. When vocab.placetype is unset or outside this set,
# the placetype-consistency check is skipped (fail-open).
_VOCAB_SETTLEMENT_PT_URIS = frozenset({
    "http://vocab.getty.edu/aat/300008347",  # inhabited places (umbrella)
    "http://vocab.getty.edu/aat/300008389",  # cities
    "http://vocab.getty.edu/aat/300008375",  # towns
    "http://vocab.getty.edu/aat/300008372",  # villages
    "http://vocab.getty.edu/aat/300008393",  # hamlets
    "http://www.wikidata.org/entity/Q486972",
    "http://www.wikidata.org/entity/Q515",
    "http://www.wikidata.org/entity/Q532",
    "http://www.wikidata.org/entity/Q3957",
    "http://www.wikidata.org/entity/Q5084",
    "http://www.wikidata.org/entity/Q1549591",
    "http://www.wikidata.org/entity/Q484170",
    "http://www.wikidata.org/entity/Q747074",
})


def _wof_load_admin_index(parquet_glob: str
                          ) -> tuple[dict[str, list[dict]], list[dict]]:
    """Load coarse-placetype WOF rows into (name_index, all_rows).

    ``name_index`` maps a normalized name to the list of WOF rows that
    use it (covers ``name``, ``name_eng``, ``name_nld``). Geometry is not
    loaded — we only need the centroid (``lat``/``lon``) and concordances.
    """
    import duckdb
    duck = duckdb.connect()
    duck.execute("SET memory_limit='4GB'; SET threads=2")
    placetypes = ",".join(f"'{pt}'" for pt in WOF_ACCEPT_PLACETYPES)
    rows = duck.execute(
        f"""
        SELECT id, name, name_eng, name_nld, placetype,
               lat, lon, wd_id, gn_id,
               regexp_extract(filename, 'admin-([a-z]{{2}})-', 1) AS wof_iso2
          FROM read_parquet('{parquet_glob}', filename=true)
         WHERE lat IS NOT NULL AND lon IS NOT NULL
           AND placetype IN ({placetypes})
        """
    ).fetchall()
    duck.close()

    cols = ("id", "name", "name_eng", "name_nld", "placetype",
            "lat", "lon", "wd_id", "gn_id", "wof_iso2")
    all_rows = [dict(zip(cols, r)) for r in rows]
    name_index: dict[str, list[dict]] = defaultdict(list)
    for r in all_rows:
        for variant in (r["name"], r["name_eng"], r["name_nld"]):
            if variant:
                name_index[_normalize_place_name(variant)].append(r)
    return name_index, all_rows


def _wof_placetype_consistent(vocab_placetype: str | None,
                               wof_placetype: str) -> bool:
    """Phase 1d placetype-consistency check (fail-open on unknown vocab placetypes)."""
    if not vocab_placetype:
        return True
    if vocab_placetype in _VOCAB_SETTLEMENT_PT_URIS:
        return wof_placetype in WOF_SETTLEMENT_PLACETYPES
    return True


def phase_1d_wof(conn: sqlite3.Connection,
                 parquet_glob: str,
                 dry_run: bool = False,
                 output_dir: str = "offline/geo",
                 csv_only: bool = False) -> int:
    """Match remaining ungeocoded places against WOF admin polygons.

    For each ungeocoded place name (case-insensitive exact match against
    WOF ``name``/``name_eng``/``name_nld``), require placetype consistency
    when the vocab row has a settlement-class placetype set. Accept on a
    single match; route multi-matches to ``wof_review.csv`` for human
    triage. Concordances harvested per accepted row: WOF Spelunker URI as
    ``external_id`` plus Wikidata QID and GeoNames ID into
    ``vocabulary_external_ids``.

    With ``csv_only=True`` accepted matches are written to
    ``<output_dir>/phase_1d_wof_accepted.csv`` (alongside the existing
    ``wof_review.csv``) and the DB is not modified.
    """
    places = get_ungeocoded(conn, "no_external_used")
    if not places:
        print("Phase 1d: No places to match against WOF", file=sys.stderr)
        return 0
    candidates, skipped = filter_reconcilable(places)
    print(f"Phase 1d: {len(candidates)} places to match against WOF "
          f"({skipped} skipped)", file=sys.stderr)
    if not candidates:
        return 0

    placetype_by_vid: dict[str, str] = dict(conn.execute(
        "SELECT id, placetype FROM vocabulary "
        " WHERE type='place' AND placetype IS NOT NULL AND placetype != ''"
    ).fetchall())

    print("Phase 1d-1: Loading WOF admin parquet index...", file=sys.stderr)
    name_index, all_rows = _wof_load_admin_index(parquet_glob)
    print(f"  Loaded {len(all_rows):,} coarse-placetype WOF rows; "
          f"{len(name_index):,} distinct normalized names", file=sys.stderr)

    accepted: dict[str, dict] = {}
    review_rows: list[tuple[str, str, list[dict]]] = []
    no_match = 0

    for vid, name in candidates:
        nname = _normalize_place_name(name)
        matches = name_index.get(nname, [])
        v_pt = placetype_by_vid.get(vid)
        if v_pt:
            matches = [m for m in matches
                       if _wof_placetype_consistent(v_pt, m["placetype"])]

        if not matches:
            no_match += 1
            continue
        if len(matches) == 1:
            accepted[vid] = matches[0]
        else:
            review_rows.append((vid, name, matches))

    print(f"  Accepted: {len(accepted)}, review: {len(review_rows)}, "
          f"no match: {no_match}", file=sys.stderr)

    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)
    if review_rows:
        _write_review_csv(out / "wof_review.csv", review_rows, _WOF_REVIEW_FIELDS)
        print(f"  Wrote {out / 'wof_review.csv'} ({len(review_rows)} entries)",
              file=sys.stderr)

    if dry_run:
        return 0

    updates: dict[str, tuple[float, float, str]] = {}
    concordances: list[tuple[str, str, str, str]] = []
    for vid, m in accepted.items():
        wof_uri = f"https://spelunker.whosonfirst.org/id/{m['id']}"
        updates[vid] = (m["lat"], m["lon"], wof_uri)
        concordances.append((vid, "wof", str(m["id"]), wof_uri))
        if m.get("wd_id"):
            wd_uri = f"http://www.wikidata.org/entity/{m['wd_id']}"
            concordances.append((vid, "wikidata", m["wd_id"], wd_uri))
        if m.get("gn_id"):
            gn_uri = f"http://sws.geonames.org/{m['gn_id']}/"
            concordances.append((vid, "geonames", m["gn_id"], gn_uri))

    if csv_only:
        accepted_csv = out / "phase_1d_wof_accepted.csv"
        with open(accepted_csv, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["vocab_id", "lat", "lon", "external_id",
                        "method", "method_detail", "concordance_authority", "concordance_id"])
            for vid, (lat, lon, ext) in updates.items():
                # Emit one row per concordance (or one bare row if none).
                vid_concs = [c for c in concordances if c[0] == vid]
                if not vid_concs:
                    w.writerow([vid, lat, lon, ext,
                                em.tier_for(em.WOF_AUTHORITY), em.WOF_AUTHORITY, "", ""])
                else:
                    for _, auth, cid, _curi in vid_concs:
                        w.writerow([vid, lat, lon, ext,
                                    em.tier_for(em.WOF_AUTHORITY), em.WOF_AUTHORITY,
                                    auth, cid])
        print(f"Phase 1d: {len(updates)} accepted matches written to {accepted_csv} "
              f"(csv-only — DB not modified)", file=sys.stderr)
        return 0

    updated = update_coords_and_ids(
        conn, updates,
        coord_method_detail=em.WOF_AUTHORITY,
        external_id_method_detail=em.WOF_AUTHORITY,
        dry_run=dry_run,
    )
    if concordances:
        conn.executemany(
            "INSERT OR IGNORE INTO vocabulary_external_ids "
            "(vocab_id, authority, id, uri) VALUES (?, ?, ?, ?)",
            concordances,
        )
        conn.commit()
    print(f"Phase 1d: {updated} places updated, "
          f"{len(concordances)} concordances added", file=sys.stderr)
    return updated


def _write_review_csv(path: Path,
                      rows: list[tuple[str, str, list[dict]]],
                      fields: list[tuple[str, str]],
                      max_matches: int = 3) -> None:
    """Write a multi-candidate review CSV.

    ``rows`` is a list of ``(vocab_id, name, [match_dict, ...])`` tuples.
    ``fields`` is a list of ``(column_label, dict_key)`` pairs that
    determine which fields are extracted per match candidate; column names
    are emitted as ``<label>_1``, ``<label>_2``, etc., padded with blanks
    when fewer than ``max_matches`` candidates are present.
    """
    header = ["vocab_id", "name", "decision"]
    for i in range(1, max_matches + 1):
        header.extend(f"{label}_{i}" for label, _ in fields)
    with path.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(header)
        for vid, name, matches in rows:
            row: list = [vid, name, ""]
            for m in matches[:max_matches]:
                row.extend(m.get(key, "") for _, key in fields)
            while len(row) < len(header):
                row.append("")
            w.writerow(row)


_WOF_REVIEW_FIELDS = [
    ("wof_id", "id"), ("label", "name"), ("placetype", "placetype"),
    ("iso2", "wof_iso2"), ("lat", "lat"), ("lon", "lon"),
]
_PLEIADES_REVIEW_FIELDS = [
    ("pleiades_id", "id"), ("title", "title"),
    ("lat", "lat"), ("lon", "lon"),
]


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
    updated = update_coords(conn, results, em.SELF_REF, dry_run)
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

    candidates_input, skipped = filter_reconcilable(places)

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

    updated = update_coords_and_ids(
        conn, updates,
        coord_method_detail=em.WIKIDATA_RECONCILIATION,
        external_id_method_detail=em.WIKIDATA_RECONCILIATION,
        dry_run=dry_run,
    )
    print(f"Phase 3d: {updated} places updated with Wikidata matches",
          file=sys.stderr)
    return updated


# ---------------------------------------------------------------------------
# Phase 3b: World Historical Gazetteer reconciliation
# ---------------------------------------------------------------------------

WHG_PLACE_TYPE = "https://whgazetteer.org/static/whg_schema.jsonld#Place"


def _http_post_json(endpoint: str,
                    params: dict[str, str],
                    extra_headers: dict[str, str] | None = None,
                    bearer_token: str | None = None,
                    retries: int = 3,
                    timeout: int = 120,
                    retry_label: str = "POST") -> dict:
    """Form-encode ``params``, POST them, parse + return the JSON response.

    Used by the WHG, Wikidata, and RCE SPARQL paths. Bearer token is added
    to the Authorization header when supplied.
    """
    body = urllib.parse.urlencode(params).encode()
    headers = {
        "User-Agent": USER_AGENT,
        "Content-Type": "application/x-www-form-urlencoded",
    }
    if extra_headers:
        headers.update(extra_headers)
    if bearer_token:
        headers["Authorization"] = f"Bearer {bearer_token}"
    req = urllib.request.Request(endpoint, data=body, method="POST",
                                  headers=headers)
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode())
        except Exception as e:
            if attempt == retries - 1:
                raise
            wait = 2 ** (attempt + 1)
            print(f"  {retry_label} retry in {wait}s: {e}", file=sys.stderr)
            time.sleep(wait)
    return {}


def _whg_post(params: dict[str, str], retries: int = 3) -> dict:
    """POST form-encoded params to WHG /reconcile with the ORCID Bearer token.

    Token comes from WHG_TOKEN (set after linking an ORCID account on the
    WHG Profile page; required since 2024-2025).
    """
    token = os.environ.get("WHG_TOKEN", "").strip().strip('"').strip("'") or None
    return _http_post_json(WHG_RECONCILE_URL, params, bearer_token=token,
                            retries=retries, retry_label="WHG")


def whg_reconcile_batch(queries: dict) -> dict:
    """POST batch reconciliation queries to WHG. Returns {qN: {result: [...]}}."""
    return _whg_post({"queries": json.dumps(queries)})


def whg_extend_batch(entity_ids: list[str],
                     properties: list[str]) -> dict:
    """POST data extension request to WHG. Returns {rows: {id: {prop: [...]}}}."""
    extend = {
        "ids": entity_ids,
        "properties": [{"id": p} for p in properties],
    }
    return _whg_post({"extend": json.dumps(extend)})


def _mean_coord(points: list[list[float]]) -> tuple[float, float]:
    """Average a list of GeoJSON [lon, lat] points into (lat, lon)."""
    return (
        sum(c[1] for c in points) / len(points),
        sum(c[0] for c in points) / len(points),
    )


def _centroid(geometry: dict) -> tuple[float, float] | None:
    """Extract centroid (lat, lon) from a GeoJSON geometry."""
    gtype = geometry.get("type", "")
    coords = geometry.get("coordinates")

    if gtype == "Point" and coords:
        return (coords[1], coords[0])  # GeoJSON is [lon, lat]

    if gtype == "MultiPoint" and coords:
        return _mean_coord(coords)

    if gtype == "Polygon" and coords:
        return _mean_coord(coords[0])  # outer ring

    if gtype == "MultiPolygon" and coords:
        all_points = [pt for poly in coords for pt in poly[0]]
        if all_points:
            return _mean_coord(all_points)

    if gtype == "GeometryCollection":
        for geom in geometry.get("geometries", []):
            result = _centroid(geom)
            if result:
                return result

    return None


def _parse_centroid_str(centroid_str: str) -> tuple[float, float] | None:
    """Parse WHG centroid string → (lat, lon).

    WHG returns centroid as comma-separated 'lat, lng' string
    (e.g. '52.374029999999955, 4.88969').
    """
    try:
        parts = centroid_str.split(",")
        if len(parts) == 2:
            lat = float(parts[0].strip())
            lng = float(parts[1].strip())
            if lat != 0 or lng != 0:
                return (lat, lng)
    except (ValueError, TypeError):
        pass
    # Fallback: try JSON object format
    try:
        obj = json.loads(centroid_str)
        lat = float(obj.get("lat", 0))
        lng = float(obj.get("lng", 0))
        if lat != 0 or lng != 0:
            return (lat, lng)
    except (json.JSONDecodeError, TypeError, ValueError):
        pass
    return None


def _parse_geojson_str(geojson_str: str) -> tuple[float, float] | None:
    """Parse WHG geometry_geojson string → centroid (lat, lon)."""
    try:
        geoms = json.loads(geojson_str)
        if isinstance(geoms, list):
            for geom in geoms:
                result = _centroid(geom)
                if result:
                    return result
        elif isinstance(geoms, dict):
            return _centroid(geoms)
    except (json.JSONDecodeError, TypeError):
        pass
    return None


def _extract_coords_from_props(props: dict) -> tuple[float, float] | None:
    """Extract (lat, lon) from WHG extend response properties.

    Tries centroid string first (simpler), falls back to GeoJSON geometry.
    """
    parsers = [
        ("whg:geometry_centroid", _parse_centroid_str),
        ("whg:geometry_geojson", _parse_geojson_str),
    ]
    for key, parser in parsers:
        for v in props.get(key, []):
            coord = parser(v.get("str", ""))
            if coord:
                return coord
    return None


def phase_3b_whg(conn: sqlite3.Connection,
                 dry_run: bool = False,
                 csv_only: bool = False,
                 output_dir: str = "offline/geo") -> int:
    """
    Reconcile ungeocoded place names via the World Historical Gazetteer API.
    Targets places without external IDs that still lack coordinates
    (i.e. whatever Phase 3 didn't resolve).

    Uses the WHG Reconciliation Service API v0.2 (Bearer token):
    - POST /reconcile with queries → fuzzy name matching
    - POST /reconcile with extend → batch coordinate fetching

    Daily quota: 4,977 requests. Phase 3b uses ~150-200 requests
    (7,444 places / 50-query batches + extend passes); Phase 3c adds
    similar. Plenty of headroom.
    """
    places = get_ungeocoded(conn, "no_external_used")
    if not places:
        print("Phase 3b: No places to reconcile via WHG", file=sys.stderr)
        return 0

    candidates, skipped = filter_reconcilable(places)

    print(f"Phase 3b: {len(candidates)} places to reconcile via WHG "
          f"({skipped} skipped)", file=sys.stderr)

    if dry_run:
        return 0

    # ------------------------------------------------------------------
    # Step 0: Derive country hints from broader_id chains (#257 layer A)
    # ------------------------------------------------------------------
    # For each candidate place, walk its broader_id chain until an ancestor
    # with a country QID is found. The QID becomes a P17 hint on the WHG
    # query (layer A) AND drives the post-filter at accept time (layer B).
    # Places with no derivable country → hint-free query; layer B also
    # becomes a no-op for them (preserves prior behaviour for those rows).
    print("Phase 3b-0: Deriving country hints from broader_id chains...",
          file=sys.stderr)
    broader_by_id, wd_qid_by_id = _build_country_derivation_maps(conn)
    country_hints: dict[str, str] = {}
    for vid, _ in candidates:
        qid = _derive_country_qid(vid, broader_by_id, wd_qid_by_id)
        if qid:
            country_hints[vid] = qid
    print(f"  Derived country for {len(country_hints)}/{len(candidates)} "
          f"places via broader_id walk", file=sys.stderr)

    # ------------------------------------------------------------------
    # Step 1: Batch reconciliation (50 queries/batch, auth-free)
    # ------------------------------------------------------------------
    print("Phase 3b-1: Reconciling via WHG...", file=sys.stderr)
    all_matches: dict[str, list[dict]] = {}
    batch_size = 50  # WHG's batch limit

    for i in range(0, len(candidates), batch_size):
        batch = candidates[i:i + batch_size]
        queries: dict[str, dict] = {}
        batch_map: dict[str, tuple[str, str]] = {}
        for j, (vid, name) in enumerate(batch):
            key = f"q{j}"
            q: dict = {
                "query": name,
                "type": WHG_PLACE_TYPE,
                "limit": 5,
            }
            # Layer A: attach P17 country hint when derivable.
            country_qid = country_hints.get(vid)
            if country_qid:
                q["properties"] = [{"pid": "P17", "v": country_qid}]
            queries[key] = q
            batch_map[key] = (vid, name)

        try:
            resp = whg_reconcile_batch(queries)
            for key, data in resp.items():
                if key in batch_map:
                    vid, _ = batch_map[key]
                    results = data.get("result", []) if isinstance(data, dict) else []
                    # Filter out dummy responses
                    results = [r for r in results
                               if not r.get("id", "").startswith("dummy:")]
                    all_matches[vid] = results
        except Exception as e:
            print(f"  Batch {i // batch_size + 1} error: {e}", file=sys.stderr)

        time.sleep(0.5)
        done = min(i + batch_size, len(candidates))
        if done % 500 < batch_size or done == len(candidates):
            print(f"  ... {done}/{len(candidates)} reconciled", file=sys.stderr)

    with_matches = sum(1 for v in all_matches.values() if v)
    print(f"  Found candidates for {with_matches}/{len(candidates)} places",
          file=sys.stderr)

    # ------------------------------------------------------------------
    # Step 2: Batch-fetch coordinates via data extension (auth-free)
    # ------------------------------------------------------------------
    print("Phase 3b-2: Fetching entity coordinates...", file=sys.stderr)

    # Collect unique entity IDs from top-3 candidates per place
    entity_ids_needed = {
        r.get("id", "")
        for results in all_matches.values()
        for r in results[:3]
    } - {""}  # exclude empty IDs

    entity_coords: dict[str, tuple[float, float]] = {}
    extend_batch_size = 50  # keep batches manageable

    sorted_ids = sorted(entity_ids_needed)
    for i in range(0, len(sorted_ids), extend_batch_size):
        batch_ids = sorted_ids[i:i + extend_batch_size]
        try:
            resp = whg_extend_batch(
                batch_ids,
                ["whg:geometry_centroid", "whg:geometry_geojson"],
            )
            for eid, props in resp.get("rows", {}).items():
                coord = _extract_coords_from_props(props)
                if coord:
                    entity_coords[eid] = coord
        except Exception as e:
            print(f"  Extend batch {i // extend_batch_size + 1} error: {e}",
                  file=sys.stderr)

        time.sleep(0.5)
        if (i + extend_batch_size) % 500 < extend_batch_size:
            print(f"  ... {min(i + extend_batch_size, len(sorted_ids))}"
                  f"/{len(sorted_ids)} entities fetched "
                  f"({len(entity_coords)} with coords)", file=sys.stderr)

    print(f"  {len(entity_coords)}/{len(entity_ids_needed)} entities "
          f"have coordinates", file=sys.stderr)

    # ------------------------------------------------------------------
    # Step 3: Score and classify
    # ------------------------------------------------------------------
    print("Phase 3b-3: Scoring matches...", file=sys.stderr)
    name_lookup = dict(candidates)

    accepted: list[tuple] = []
    review: list[tuple] = []
    rejected: list[tuple] = []
    country_mismatch: list[tuple] = []  # #257 layer B rejections

    # Pattern matches WHG's description string: "Country: XX" (ISO-2 alpha)
    # or "Country: GB, FR" (rare multi-country). We look for the first
    # two-letter uppercase code in the first 40 chars of the description.
    country_re = re.compile(r"Country:\s*([A-Z]{2})")

    for vid, results in all_matches.items():
        name = name_lookup.get(vid, "")

        if not results:
            rejected.append((vid, name, "no_candidates"))
            continue

        scored: list[dict] = []
        for r in results[:5]:
            eid = r.get("id", "")
            whg_name = r.get("name", "")
            whg_score = float(r.get("score", 0))
            whg_match = bool(r.get("match", False))
            whg_description = r.get("description", "") or ""
            coords = entity_coords.get(eid)

            sim = string_similarity(name, whg_name)
            bare = strip_parenthetical(name)
            if bare:
                sim = max(sim, string_similarity(bare, whg_name))

            # Composite: 50% WHG score, 30% name similarity, 20% has coords
            composite = (whg_score * 0.50
                         + sim * 0.30
                         + (100 if coords else 0) * 0.20)

            # Extract WHG's country code from description (layer B input).
            m = country_re.search(whg_description)
            whg_country = m.group(1) if m else None

            scored.append({
                "entity_id": eid,
                "name": whg_name,
                "whg_score": whg_score,
                "whg_match": whg_match,
                "similarity": sim,
                "composite": composite,
                "lat": coords[0] if coords else None,
                "lon": coords[1] if coords else None,
                "description": whg_description,
                "whg_country": whg_country,
            })

        scored.sort(key=lambda x: x["composite"], reverse=True)
        top = scored[0]
        gap = top["composite"] - scored[1]["composite"] if len(scored) > 1 else 100
        has_coords = top["lat"] is not None

        # Layer B: reject top candidate if WHG's country disagrees with the
        # one we derived via broader_id walk. Only fires when both are known;
        # if either side is None, the filter is a no-op (preserves prior
        # behaviour for uncountried places / countries WHG didn't annotate).
        derived_qid = country_hints.get(vid)
        expected_iso = COUNTRY_QID_TO_ISO2.get(derived_qid) if derived_qid else None
        if expected_iso and top["whg_country"] and top["whg_country"] != expected_iso:
            country_mismatch.append((
                vid, name, top["entity_id"], top["name"],
                top["whg_country"], expected_iso,
                f"{top['composite']:.0f}",
            ))
            # Demote to rejected — keep the mismatch tracked separately for audit.
            rejected.append((
                vid, name,
                f"country_mismatch:{top['whg_country']}!={expected_iso}",
            ))
            continue

        if top["composite"] >= 80 and has_coords and (top["whg_match"] or gap >= 15):
            accepted.append((vid, name, top["entity_id"],
                             top["lat"], top["lon"], top["composite"]))
        elif top["composite"] >= 50 and has_coords:
            review.append((vid, name, scored))
        else:
            rejected.append((vid, name, f"low_score:{top['composite']:.0f}"))

    print(f"Phase 3b-3: {len(accepted)} accepted, {len(review)} review, "
          f"{len(rejected)} rejected ({len(country_mismatch)} country-mismatch)",
          file=sys.stderr)

    # ------------------------------------------------------------------
    # Step 4: Write output CSVs
    # ------------------------------------------------------------------
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)

    with open(out / "whg_accepted.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["vocab_id", "name", "whg_entity_id", "lat", "lon", "score"])
        for row in accepted:
            w.writerow(row)
    print(f"  Wrote {out / 'whg_accepted.csv'} ({len(accepted)} entries)",
          file=sys.stderr)

    with open(out / "whg_review.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["vocab_id", "name", "decision",
                     "entity_1", "name_1", "score_1", "lat_1", "lon_1",
                     "entity_2", "name_2", "score_2", "lat_2", "lon_2"])
        for vid, name, scored in review:
            row = [vid, name, ""]
            for j in range(2):
                if j < len(scored):
                    s = scored[j]
                    row.extend([s["entity_id"], s["name"],
                                f"{s['composite']:.0f}",
                                s["lat"], s["lon"]])
                else:
                    row.extend(["", "", "", "", ""])
            w.writerow(row)
    print(f"  Wrote {out / 'whg_review.csv'} ({len(review)} entries)",
          file=sys.stderr)

    with open(out / "whg_rejected.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["vocab_id", "name", "reason"])
        for row in rejected:
            w.writerow(row)
    print(f"  Wrote {out / 'whg_rejected.csv'} ({len(rejected)} entries)",
          file=sys.stderr)

    # #257 layer B: country-mismatch rejects go to their own CSV so the
    # post-run diagnostics can track how many candidates layer B caught.
    with open(out / "whg_country_mismatch.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["vocab_id", "name", "whg_entity_id", "whg_label",
                    "whg_country", "derived_country", "score"])
        for row in country_mismatch:
            w.writerow(row)
    print(f"  Wrote {out / 'whg_country_mismatch.csv'} "
          f"({len(country_mismatch)} entries)", file=sys.stderr)

    # ------------------------------------------------------------------
    # Step 5: Apply accepted matches
    # ------------------------------------------------------------------
    if csv_only:
        print(f"Phase 3b-5: Skipped (--csv-only). Review CSVs in {out}/",
              file=sys.stderr)
        return 0

    updates: dict[str, tuple[float, float, str]] = {}
    for vid, name, eid, lat, lon, score in accepted:
        # eid is like "place:1234567" — build WHG entity URL
        whg_uri = f"https://whgazetteer.org/entity/{eid}/"
        updates[vid] = (lat, lon, whg_uri)

    updated = update_coords_and_ids(
        conn, updates,
        coord_method_detail=em.WHG_RECONCILIATION,
        external_id_method_detail=em.WHG_RECONCILIATION,
        dry_run=dry_run,
    )
    print(f"Phase 3b-5: {updated} places updated with WHG matches",
          file=sys.stderr)
    return updated


# ---------------------------------------------------------------------------
# Phase 3c: WHG bridge — authority-failed places
# ---------------------------------------------------------------------------

# WHG link prefix → canonical URI prefix mapping
WHG_LINK_PREFIXES: dict[str, str] = {
    "wd:": "http://www.wikidata.org/entity/",
    "gn:": "https://sws.geonames.org/",
    "tgn:": "http://vocab.getty.edu/tgn/",
    "viaf:": "https://viaf.org/viaf/",
    "loc:": "http://id.loc.gov/authorities/names/",
}


def _parse_whg_links(lpf_str: str) -> dict[str, str]:
    """Extract authority links from a WHG LPF feature JSON string.

    Returns dict mapping authority prefix (wd, gn, tgn, viaf, loc) to full URI.
    """
    links: dict[str, str] = {}
    try:
        feat = json.loads(lpf_str) if isinstance(lpf_str, str) else lpf_str
        for link in feat.get("properties", {}).get("links", []):
            ident = link.get("identifier", "")
            for prefix, uri_base in WHG_LINK_PREFIXES.items():
                if ident.startswith(prefix):
                    local_id = ident[len(prefix):]
                    links[prefix.rstrip(":")] = uri_base + local_id
                    break
    except (json.JSONDecodeError, TypeError):
        pass
    return links


def _existing_authority(ext_id: str) -> tuple[str, str] | None:
    """Identify the authority type and local ID from an existing external_id URI."""
    checks = [
        ("gn", "geonames.org/", extract_geonames_id),
        ("tgn", "getty.edu/tgn/", extract_tgn_id),
        ("wd", "wikidata.org/", extract_qid),
    ]
    for key, marker, extractor in checks:
        if marker in (ext_id or ""):
            local = extractor(ext_id)
            if local:
                return (key, local)
    return None


def phase_3c_whg_bridge(conn: sqlite3.Connection,
                        dry_run: bool = False,
                        csv_only: bool = False,
                        output_dir: str = "offline/geo") -> int:
    """Reconcile authority-failed places via WHG and harvest cross-references.

    Targets places that have an authority ID (GeoNames, Getty TGN, Wikidata)
    but whose authority couldn't provide coordinates. Uses WHG fuzzy name
    matching to find coordinates AND extract cross-referenced authority links.
    """
    # Gather the 3 authority-failed categories
    categories = ["geonames", "getty_tgn", "wikidata"]
    all_places: list[dict] = []
    for cat in categories:
        places = get_ungeocoded(conn, cat)
        print(f"  {cat}: {len(places)} ungeocoded", file=sys.stderr)
        all_places.extend(places)

    if not all_places:
        print("Phase 3c: No authority-failed places to reconcile", file=sys.stderr)
        return 0

    candidates, skipped = filter_reconcilable(all_places)
    print(f"Phase 3c: {len(candidates)} authority-failed places to reconcile "
          f"({skipped} skipped)", file=sys.stderr)

    if dry_run:
        return 0

    # ------------------------------------------------------------------
    # Step 1: Batch reconciliation
    # ------------------------------------------------------------------
    print("Phase 3c-1: Reconciling via WHG...", file=sys.stderr)
    all_matches: dict[str, list[dict]] = {}
    batch_size = 50

    for i in range(0, len(candidates), batch_size):
        batch = candidates[i:i + batch_size]
        queries: dict[str, dict] = {}
        batch_map: dict[str, tuple[str, str]] = {}
        for j, (vid, name) in enumerate(batch):
            key = f"q{j}"
            queries[key] = {
                "query": name,
                "type": WHG_PLACE_TYPE,
                "limit": 5,
            }
            batch_map[key] = (vid, name)

        try:
            resp = whg_reconcile_batch(queries)
            for key, data in resp.items():
                if key in batch_map:
                    vid, _ = batch_map[key]
                    results = data.get("result", []) if isinstance(data, dict) else []
                    results = [r for r in results
                               if not r.get("id", "").startswith("dummy:")]
                    all_matches[vid] = results
        except Exception as e:
            print(f"  Batch {i // batch_size + 1} error: {e}", file=sys.stderr)

        time.sleep(0.5)
        done = min(i + batch_size, len(candidates))
        if done % 200 < batch_size or done == len(candidates):
            print(f"  ... {done}/{len(candidates)} reconciled", file=sys.stderr)

    with_matches = sum(1 for v in all_matches.values() if v)
    print(f"  Found candidates for {with_matches}/{len(candidates)} places",
          file=sys.stderr)

    # ------------------------------------------------------------------
    # Step 2: Batch-fetch coordinates + LPF features (for authority links)
    # ------------------------------------------------------------------
    print("Phase 3c-2: Fetching coordinates + authority links...", file=sys.stderr)

    entity_ids_needed = {
        r.get("id", "")
        for results in all_matches.values()
        for r in results[:3]
    } - {""}

    entity_coords: dict[str, tuple[float, float]] = {}
    entity_links: dict[str, dict[str, str]] = {}  # entity_id → {wd: uri, gn: uri, ...}
    extend_batch_size = 50

    sorted_ids = sorted(entity_ids_needed)
    for i in range(0, len(sorted_ids), extend_batch_size):
        batch_ids = sorted_ids[i:i + extend_batch_size]
        try:
            resp = whg_extend_batch(
                batch_ids,
                ["whg:geometry_centroid", "whg:geometry_geojson",
                 "whg:lpf_feature"],
            )
            for eid, props in resp.get("rows", {}).items():
                coord = _extract_coords_from_props(props)
                if coord:
                    entity_coords[eid] = coord
                # Parse authority links from LPF feature
                for feat_entry in props.get("whg:lpf_feature", []):
                    links = _parse_whg_links(feat_entry.get("str", ""))
                    if links:
                        entity_links[eid] = links
        except Exception as e:
            print(f"  Extend batch {i // extend_batch_size + 1} error: {e}",
                  file=sys.stderr)

        time.sleep(0.5)
        if (i + extend_batch_size) % 200 < extend_batch_size:
            print(f"  ... {min(i + extend_batch_size, len(sorted_ids))}"
                  f"/{len(sorted_ids)} entities fetched", file=sys.stderr)

    print(f"  {len(entity_coords)}/{len(entity_ids_needed)} with coordinates, "
          f"{len(entity_links)} with authority links", file=sys.stderr)

    # ------------------------------------------------------------------
    # Step 3: Score, classify, and check authority cross-references
    # ------------------------------------------------------------------
    print("Phase 3c-3: Scoring matches...", file=sys.stderr)
    name_lookup = dict(candidates)

    # Build vocab_id → existing external_id lookup
    ext_id_lookup: dict[str, str] = {}
    for p in all_places:
        ext_id_lookup[p["id"]] = p.get("external_id") or ""

    accepted: list[dict] = []
    review: list[dict] = []
    rejected: list[tuple] = []

    for vid, results in all_matches.items():
        name = name_lookup.get(vid, "")

        if not results:
            rejected.append((vid, name, "no_candidates"))
            continue

        scored: list[dict] = []
        for r in results[:5]:
            eid = r.get("id", "")
            whg_name = r.get("name", "")
            whg_score = float(r.get("score", 0))
            whg_match = bool(r.get("match", False))
            coords = entity_coords.get(eid)
            links = entity_links.get(eid, {})

            sim = string_similarity(name, whg_name)
            bare = strip_parenthetical(name)
            if bare:
                sim = max(sim, string_similarity(bare, whg_name))

            # Check if WHG's authority links confirm the existing authority
            existing = _existing_authority(ext_id_lookup.get(vid, ""))
            authority_confirmed = False
            if existing and links:
                auth_type, auth_id = existing
                whg_uri = links.get(auth_type, "")
                if auth_id and auth_id in whg_uri:
                    authority_confirmed = True

            # Composite: 40% WHG score, 25% similarity, 20% coords, 15% authority match
            composite = (whg_score * 0.40
                         + sim * 0.25
                         + (100 if coords else 0) * 0.20
                         + (100 if authority_confirmed else 0) * 0.15)

            scored.append({
                "entity_id": eid,
                "name": whg_name,
                "whg_score": whg_score,
                "whg_match": whg_match,
                "similarity": sim,
                "composite": composite,
                "authority_confirmed": authority_confirmed,
                "lat": coords[0] if coords else None,
                "lon": coords[1] if coords else None,
                "links": links,
            })

        scored.sort(key=lambda x: x["composite"], reverse=True)
        top = scored[0]
        gap = top["composite"] - scored[1]["composite"] if len(scored) > 1 else 100
        has_coords = top["lat"] is not None

        row = {
            "vid": vid,
            "name": name,
            "existing_id": ext_id_lookup.get(vid, ""),
            "top": top,
            "scored": scored,
        }

        if top["composite"] >= 80 and has_coords and (top["whg_match"] or gap >= 15):
            accepted.append(row)
        elif top["composite"] >= 50 and has_coords:
            review.append(row)
        else:
            rejected.append((vid, name, f"low_score:{top['composite']:.0f}"))

    confirmed_count = sum(1 for r in accepted if r["top"]["authority_confirmed"])
    print(f"Phase 3c-3: {len(accepted)} accepted ({confirmed_count} authority-confirmed), "
          f"{len(review)} review, {len(rejected)} rejected", file=sys.stderr)

    # ------------------------------------------------------------------
    # Step 4: Write output CSVs (with authority link columns)
    # ------------------------------------------------------------------
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)

    link_cols = ["link_wd", "link_gn", "link_tgn", "link_viaf", "link_loc"]

    with open(out / "whg_bridge_accepted.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["vocab_id", "name", "existing_id", "whg_entity_id",
                     "lat", "lon", "score", "authority_confirmed"] + link_cols)
        for row in accepted:
            t = row["top"]
            w.writerow([
                row["vid"], row["name"], row["existing_id"],
                t["entity_id"], t["lat"], t["lon"],
                f"{t['composite']:.1f}", t["authority_confirmed"],
            ] + [t["links"].get(k.replace("link_", ""), "") for k in link_cols])
    print(f"  Wrote {out / 'whg_bridge_accepted.csv'} ({len(accepted)} entries)",
          file=sys.stderr)

    with open(out / "whg_bridge_review.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["vocab_id", "name", "existing_id", "decision",
                     "entity_1", "name_1", "score_1", "lat_1", "lon_1",
                     "confirmed_1"] + [c + "_1" for c in link_cols] +
                    ["entity_2", "name_2", "score_2", "lat_2", "lon_2",
                     "confirmed_2"] + [c + "_2" for c in link_cols])
        for row in review:
            csv_row = [row["vid"], row["name"], row["existing_id"], ""]
            for j in range(2):
                if j < len(row["scored"]):
                    s = row["scored"][j]
                    csv_row.extend([
                        s["entity_id"], s["name"], f"{s['composite']:.0f}",
                        s["lat"], s["lon"], s["authority_confirmed"],
                    ] + [s["links"].get(k.replace("link_", ""), "") for k in link_cols])
                else:
                    csv_row.extend([""] * (6 + len(link_cols)))
            w.writerow(csv_row)
    print(f"  Wrote {out / 'whg_bridge_review.csv'} ({len(review)} entries)",
          file=sys.stderr)

    with open(out / "whg_bridge_rejected.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["vocab_id", "name", "reason"])
        for row in rejected:
            w.writerow(row)
    print(f"  Wrote {out / 'whg_bridge_rejected.csv'} ({len(rejected)} entries)",
          file=sys.stderr)

    # ------------------------------------------------------------------
    # Step 5: Apply accepted matches
    # ------------------------------------------------------------------
    if csv_only:
        print(f"Phase 3c-5: Skipped (--csv-only). Review CSVs in {out}/",
              file=sys.stderr)
        return 0

    updates: dict[str, tuple[float, float, str]] = {}
    for row in accepted:
        t = row["top"]
        # Prefer a discovered Wikidata/GeoNames/TGN link over a WHG URI
        best_ext_id = ""
        for pref in ("wd", "gn", "tgn"):
            if pref in t["links"]:
                best_ext_id = t["links"][pref]
                break
        if not best_ext_id:
            best_ext_id = f"https://whgazetteer.org/entity/{t['entity_id']}/"
        updates[row["vid"]] = (t["lat"], t["lon"], best_ext_id)

    updated = update_coords_and_ids(
        conn, updates,
        coord_method_detail=em.WHG_BRIDGE,
        external_id_method_detail=em.WHG_BRIDGE,
        dry_run=dry_run,
    )
    print(f"Phase 3c-5: {updated} places updated", file=sys.stderr)
    return updated


# ---------------------------------------------------------------------------
# Phase 3 supplement: Apply reviewed matches
# ---------------------------------------------------------------------------

def apply_reviewed(conn: sqlite3.Connection, csv_path: str,
                   dry_run: bool = False) -> int:
    """Apply manually reviewed reconciliation results.

    Handles both Wikidata review CSVs (qid_1 column) and WHG review
    CSVs (entity_1 column) -- the external_id is constructed accordingly.
    """
    path = Path(csv_path)
    if not path.exists():
        print(f"Review CSV not found: {csv_path}", file=sys.stderr)
        return 0

    updates: dict[str, tuple[float, float, str]] = {}
    ext_id_prefixes = {
        "qid_1": "http://www.wikidata.org/entity/",
        "entity_1": "https://whgazetteer.org/place/",
        "wof_id_1": "https://spelunker.whosonfirst.org/id/",
    }

    with open(path, newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            decision = (row.get("decision") or "").strip().lower()
            if decision not in ("y", "yes", "1", "accept"):
                continue

            # Determine source: Wikidata (qid_1), WHG (entity_1), or WOF (wof_id_1)
            ext_id = ""
            for col, prefix in ext_id_prefixes.items():
                value = row.get(col, "")
                if value:
                    ext_id = prefix + str(value)
                    break
            if not ext_id:
                continue

            lat, lon = row.get("lat_1"), row.get("lon_1")
            if lat and lon:
                try:
                    updates[row["vocab_id"]] = (float(lat), float(lon), ext_id)
                except ValueError:
                    pass

    print(f"Apply reviewed: {len(updates)} approved entries", file=sys.stderr)

    if dry_run:
        return 0

    # Pick the HUMAN-tier detail based on which review CSV was supplied.
    # Four shapes per #218 §"Phase → method assignment":
    #   reconciled_review.csv  → RECONCILED_REVIEW_ACCEPTED
    #   whg_review.csv         → WHG_REVIEW_ACCEPTED
    #   whg_bridge_review.csv  → WHG_BRIDGE_REVIEW_ACCEPTED
    #   wof_review.csv         → WOF_REVIEW_ACCEPTED
    name = path.name.lower()
    if "bridge" in name:
        review_detail = em.WHG_BRIDGE_REVIEW_ACCEPTED
    elif "wof" in name:
        review_detail = em.WOF_REVIEW_ACCEPTED
    elif "whg" in name:
        review_detail = em.WHG_REVIEW_ACCEPTED
    else:
        review_detail = em.RECONCILED_REVIEW_ACCEPTED

    updated = update_coords_and_ids(
        conn, updates,
        coord_method_detail=review_detail,
        external_id_method_detail=review_detail,
        dry_run=dry_run,
    )
    print(f"Apply reviewed ({review_detail}): {updated} places updated",
          file=sys.stderr)
    return updated


# ---------------------------------------------------------------------------
# Phase 1e: RCE Rijksmonumenten via Wikidata QID bridge (v0.25)
# ---------------------------------------------------------------------------

RCE_SPARQL_ENDPOINT = "https://api.linkeddata.cultureelerfgoed.nl/datasets/rce/cho/sparql"

# Wikidata `wdt:P359` ("Rijksmonument ID") is the bridge: a monument's
# Wikidata item carries a P359 statement with the official RCE
# Rijksmonument number. RCE's CHO graph stores the same number on each
# `ceo:Rijksmonument` as `ceo:cultuurhistorischObjectnummer` (the URL slug
# matches), and the geometry is on a separate node reached via
# `ceo:heeftGeometrie`, exposed as a WKT literal `Point (lon lat)` (or
# `MultiPolygon (...)` for the parcel outline — we filter to Points).
#
# Both property names verified 2026-04-29 via live SPARQL probes against
# query.wikidata.org and api.linkeddata.cultureelerfgoed.nl. The original
# v0.25 plan named them `wdt:P2168` and `ceo:rijksmonumentnummer` — both
# were wrong (P2168 is "Swedish Film Database person ID";
# rijksmonumentnummer doesn't exist on RCE). See decisions doc §431.

WIKIDATA_SPARQL = "https://query.wikidata.org/sparql"


def _rce_pre_flight(conn: sqlite3.Connection, threshold: int = 9000) -> int:
    """Stage E.0 pre-flight gate. Returns the wikidata-place count; raises
    SystemExit if below threshold."""
    n = conn.execute(
        "SELECT COUNT(*) FROM vocabulary_external_ids vei "
        "  JOIN vocabulary v ON v.id = vei.vocab_id "
        " WHERE v.type='place' AND vei.authority='wikidata'"
    ).fetchone()[0]
    if n < threshold:
        raise SystemExit(
            f"Phase 1e refuses to run: only {n} Wikidata place external IDs "
            f"found in vocabulary_external_ids (threshold {threshold}). "
            f"Land #276 + Phase 4 backfill first."
        )
    return n


_SPARQL_JSON_HEADERS = {"Accept": "application/sparql-results+json"}


_WKT_POINT_RE = re.compile(r"^\s*Point\s*\(\s*([-\d.]+)\s+([-\d.]+)\s*\)\s*$",
                            re.IGNORECASE)


def _wikidata_qids_to_rijksmonument_ids(qids: list[str]
                                         ) -> dict[str, list[str]]:
    """Query Wikidata for (qid → P359 Rijksmonument ID) mappings.

    Returns ``{qid: [rm_id, ...]}``. Empty for qids without a P359 statement.
    """
    if not qids:
        return {}
    values = " ".join(f"wd:{q}" for q in qids)
    query = (
        "SELECT ?qid ?rmid WHERE { "
        f"  VALUES ?qid {{ {values} }} "
        "  ?qid wdt:P359 ?rmid . }"
    )
    data = _http_post_json(WIKIDATA_SPARQL, {"query": query},
                            extra_headers=_SPARQL_JSON_HEADERS,
                            timeout=60, retries=3, retry_label="Wikidata")

    result: dict[str, list[str]] = defaultdict(list)
    for binding in data.get("results", {}).get("bindings", []):
        qid_uri = binding.get("qid", {}).get("value", "")
        rmid = binding.get("rmid", {}).get("value", "")
        qid = qid_uri.rsplit("/", 1)[-1]
        if qid and rmid:
            result[qid].append(rmid)
    return dict(result)


def _rce_lookup_monuments(rm_ids: list[str]) -> dict[str, dict]:
    """Query RCE CHO endpoint for monument centroids by Rijksmonument ID.

    Returns ``{rm_id: {"uri": ..., "lat": ..., "lon": ...}}``. Each monument
    has both a Point centroid and a MultiPolygon parcel outline reachable
    via ``ceo:heeftGeometrie``; we filter to Points.
    """
    if not rm_ids:
        return {}
    values = " ".join(f'"{rm}"' for rm in rm_ids)
    query = (
        "PREFIX ceo: <https://linkeddata.cultureelerfgoed.nl/def/ceo#> "
        "PREFIX gs:  <http://www.opengis.net/ont/geosparql#> "
        "SELECT ?rmid ?monument ?wkt WHERE { "
        f"  VALUES ?rmid {{ {values} }} "
        "  ?monument a ceo:Rijksmonument ; "
        "            ceo:cultuurhistorischObjectnummer ?rmid ; "
        "            ceo:heeftGeometrie ?g . "
        "  ?g gs:asWKT ?wkt . "
        "  FILTER(STRSTARTS(STR(?wkt), \"Point\")) }"
    )
    data = _http_post_json(RCE_SPARQL_ENDPOINT, {"query": query},
                            extra_headers=_SPARQL_JSON_HEADERS,
                            timeout=60, retries=3, retry_label="RCE")

    out: dict[str, dict] = {}
    for b in data.get("results", {}).get("bindings", []):
        rmid = b.get("rmid", {}).get("value", "")
        if not rmid or rmid in out:
            continue
        m = _WKT_POINT_RE.match(b.get("wkt", {}).get("value", ""))
        if not m:
            continue
        try:
            lon = float(m.group(1))
            lat = float(m.group(2))
        except ValueError:
            continue
        out[rmid] = {
            "rmid": rmid,
            "uri": b.get("monument", {}).get("value", ""),
            "lat": lat,
            "lon": lon,
        }
    return out


def phase_1e_rce(conn: sqlite3.Connection,
                 dry_run: bool = False,
                 batch_size: int = 100,
                 output_dir: str = "offline/geo",
                 csv_only: bool = False) -> int:
    """QID-bridge RCE Rijksmonumenten lookup (decisions doc §431).

    Walks ``vocabulary_external_ids`` for places with Wikidata QIDs, asks
    Wikidata for any P359 (Rijksmonument ID) statements, then asks RCE for
    each monument's coords. On hit: tag em.RCE_VIA_WIKIDATA, write the RCE
    monument URI as ``external_id``, and INSERT the RCE concordance into
    ``vocabulary_external_ids``.

    With ``csv_only=True`` resolved (vocab_id, lat, lon, RCE concordance)
    rows are written to ``<output_dir>/phase_1e_rce.csv`` and the DB is
    not modified.
    """
    n_qids = _rce_pre_flight(conn, threshold=9000)
    print(f"Phase 1e: pre-flight OK ({n_qids:,} wikidata-tagged places)",
          file=sys.stderr)

    rows = conn.execute(
        "SELECT vei.vocab_id, vei.id AS qid "
        "  FROM vocabulary_external_ids vei "
        "  JOIN vocabulary v ON v.id = vei.vocab_id "
        " WHERE v.type='place' AND vei.authority='wikidata' "
        "   AND v.lat IS NULL"
    ).fetchall()
    print(f"Phase 1e: {len(rows):,} ungeocoded places have a Wikidata QID",
          file=sys.stderr)
    if not rows:
        return 0

    qid_to_vids: dict[str, list[str]] = defaultdict(list)
    for vid, qid in rows:
        qid_to_vids[qid].append(vid)
    qids = sorted(qid_to_vids)

    def _run_batches(items: list[str], fn, label: str) -> dict:
        """Submit one fn(batch) call per ``batch_size``-sized slice of items
        in parallel (4 workers); merge results into a single dict."""
        merged: dict = {}
        slices = [items[i:i + batch_size]
                  for i in range(0, len(items), batch_size)]
        with ThreadPoolExecutor(max_workers=4) as pool:
            futures = {pool.submit(fn, s): idx for idx, s in enumerate(slices)}
            for fut in as_completed(futures):
                idx = futures[fut]
                try:
                    merged.update(fut.result())
                except Exception as e:
                    print(f"  {label} batch {idx + 1} error: {e}",
                          file=sys.stderr)
        return merged

    # Step 1: ask Wikidata for P359 mappings
    print(f"Phase 1e-1: Querying Wikidata for P359 across {len(qids)} QIDs "
          f"({batch_size}/batch, 4 parallel)...", file=sys.stderr)
    qid_to_rmids = _run_batches(
        qids, _wikidata_qids_to_rijksmonument_ids, "Wikidata")
    print(f"  {len(qid_to_rmids)} of {len(qids)} QIDs map to Rijksmonument IDs",
          file=sys.stderr)

    if not qid_to_rmids:
        print("Phase 1e: no P359 statements found; phase exits with 0 updates.",
              file=sys.stderr)
        return 0

    all_rmids = sorted({rm for ids in qid_to_rmids.values() for rm in ids})
    print(f"Phase 1e-2: Querying RCE for {len(all_rmids)} monument IDs "
          f"({batch_size}/batch, 4 parallel)...", file=sys.stderr)
    rce_by_rmid = _run_batches(all_rmids, _rce_lookup_monuments, "RCE")
    print(f"  {len(rce_by_rmid)} monuments found with coords", file=sys.stderr)

    if dry_run or not rce_by_rmid:
        return 0

    updates: dict[str, tuple[float, float, str]] = {}
    concordances: list[tuple[str, str, str, str]] = []
    for qid, rmids in qid_to_rmids.items():
        for rm in rmids:
            mon = rce_by_rmid.get(rm)
            if not mon:
                continue
            for vid in qid_to_vids[qid]:
                if vid not in updates:
                    updates[vid] = (mon["lat"], mon["lon"], mon["uri"])
                    concordances.append((vid, "rce", rm, mon["uri"]))

    if csv_only:
        out = Path(output_dir)
        out.mkdir(parents=True, exist_ok=True)
        csv_path = out / "phase_1e_rce.csv"
        with open(csv_path, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["vocab_id", "lat", "lon", "external_id",
                        "method", "method_detail", "rce_id"])
            conc_by_vid = {c[0]: c for c in concordances}
            for vid, (lat, lon, uri) in updates.items():
                rm_id = conc_by_vid.get(vid, (None, None, "", None))[2]
                w.writerow([vid, lat, lon, uri,
                            em.tier_for(em.RCE_VIA_WIKIDATA), em.RCE_VIA_WIKIDATA,
                            rm_id])
        print(f"Phase 1e: {len(updates)} places written to {csv_path} "
              f"(csv-only — DB not modified)", file=sys.stderr)
        return 0

    updated = update_coords_and_ids(
        conn, updates,
        coord_method_detail=em.RCE_VIA_WIKIDATA,
        external_id_method_detail=em.RCE_VIA_WIKIDATA,
        dry_run=dry_run,
    )
    if concordances:
        conn.executemany(
            "INSERT OR IGNORE INTO vocabulary_external_ids "
            "(vocab_id, authority, id, uri) VALUES (?, ?, ?, ?)",
            concordances,
        )
        conn.commit()
    print(f"Phase 1e: {updated} places updated", file=sys.stderr)
    return updated


# ---------------------------------------------------------------------------
# Phase 3e: Pleiades classical-antiquity reconciliation (v0.25)
# ---------------------------------------------------------------------------

def _pleiades_load_index(dump_path: Path
                         ) -> tuple[dict[str, list[dict]], int]:
    """Load Pleiades JSON-LD dump and build a normalized-name → places index.

    Pleiades dump shape: ``{"@context": ..., "@graph": [<place>, ...]}``,
    where each place has ``id``, ``uri``, ``title``, ``reprPoint`` (lon,lat),
    and a ``names[]`` array of variant names with ``romanized`` and
    ``attested`` fields. We index over title + romanized + attested for
    fuzzy alias coverage.
    """
    import gzip
    open_fn = gzip.open if str(dump_path).endswith(".gz") else open
    with open_fn(dump_path, "rt", encoding="utf-8") as f:
        data = json.load(f)
    items = data.get("@graph", []) if isinstance(data, dict) else data
    index: dict[str, list[dict]] = defaultdict(list)
    n_with_coords = 0
    for it in items:
        repr_pt = it.get("reprPoint")
        if not repr_pt or len(repr_pt) != 2:
            continue
        lon, lat = repr_pt[0], repr_pt[1]
        if lat is None or lon is None:
            continue
        n_with_coords += 1
        record = {
            "id": it.get("id"),
            "uri": it.get("uri"),
            "title": it.get("title", ""),
            "lat": lat,
            "lon": lon,
        }
        names: set[str] = set()
        title = it.get("title")
        if title:
            names.add(_normalize_place_name(title))
            # Slash-separated alternates: "Consabura/Consabrum" → both
            for part in title.split("/"):
                if part.strip():
                    names.add(_normalize_place_name(part))
        for nm in it.get("names", []) or []:
            for fld in ("romanized", "attested"):
                v = nm.get(fld)
                if v:
                    names.add(_normalize_place_name(v))
        for n in names:
            if n:
                index[n].append(record)
    return index, n_with_coords


def phase_3e_pleiades(conn: sqlite3.Connection,
                      dump_path: Path,
                      dry_run: bool = False,
                      output_dir: str = "offline/geo") -> int:
    """Match remaining ungeocoded places against the Pleiades classical
    antiquity gazetteer via exact name match (title + romanized + attested
    aliases). Single hit → DERIVED-tier auto-accept; multi-hit →
    pleiades_review.csv.
    """
    places = get_ungeocoded(conn, "no_external_used")
    if not places:
        print("Phase 3e: No places to match against Pleiades", file=sys.stderr)
        return 0
    candidates, skipped = filter_reconcilable(places)
    print(f"Phase 3e: {len(candidates)} places to match against Pleiades "
          f"({skipped} skipped)", file=sys.stderr)
    if not candidates:
        return 0

    print("Phase 3e-1: Loading Pleiades dump...", file=sys.stderr)
    index, n_with_coords = _pleiades_load_index(dump_path)
    print(f"  Loaded {n_with_coords:,} Pleiades places "
          f"({len(index):,} distinct normalized names)", file=sys.stderr)

    accepted: dict[str, dict] = {}
    review_rows: list[tuple[str, str, list[dict]]] = []
    no_match = 0

    for vid, name in candidates:
        nname = _normalize_place_name(name)
        matches = index.get(nname, [])
        if not matches:
            no_match += 1
            continue
        if len(matches) == 1:
            accepted[vid] = matches[0]
        else:
            review_rows.append((vid, name, matches))

    print(f"  Accepted: {len(accepted)}, review: {len(review_rows)}, "
          f"no match: {no_match}", file=sys.stderr)

    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)
    if review_rows:
        path = out / "pleiades_review.csv"
        _write_review_csv(path, review_rows, _PLEIADES_REVIEW_FIELDS)
        print(f"  Wrote {path} ({len(review_rows)} entries)", file=sys.stderr)

    if dry_run:
        return 0

    updates: dict[str, tuple[float, float, str]] = {}
    for vid, m in accepted.items():
        updates[vid] = (m["lat"], m["lon"], m["uri"])

    updated = update_coords_and_ids(
        conn, updates,
        coord_method_detail=em.PLEIADES_RECONCILIATION,
        external_id_method_detail=em.PLEIADES_RECONCILIATION,
        dry_run=dry_run,
    )
    if accepted:
        conn.executemany(
            "INSERT OR IGNORE INTO vocabulary_external_ids "
            "(vocab_id, authority, id, uri) VALUES (?, ?, ?, ?)",
            [(vid, "other", str(m["id"]), m["uri"])
             for vid, m in accepted.items()],
        )
        conn.commit()
    print(f"Phase 3e: {updated} places updated", file=sys.stderr)
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
# Phase 4-pip: WOF point-in-polygon audit (read-only)
# ---------------------------------------------------------------------------

def phase_4_pip_validation(conn: sqlite3.Connection,
                            wof_parquet_glob: str,
                            output_dir: str) -> dict[str, int]:
    """Run the WOF PIP audit by delegating to scripts/phase4_pip_validation.py.

    Read-only: writes CSVs + summary.txt under ``output_dir``, never mutates
    the DB. Used as the Stage A baseline anchor and as the post-cold-rerun /
    post-bundle gate.
    """
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from phase4_pip_validation import run_pip_validation
    out = Path(output_dir)
    print(f"Phase 4-pip: PIP audit against {wof_parquet_glob} → {out}",
          file=sys.stderr)
    result = run_pip_validation(conn, wof_parquet_glob, out, expected_country_lookup=None)
    print(f"Phase 4-pip: {result}", file=sys.stderr)
    return result


# ---------------------------------------------------------------------------
# Backfill CSV export
# ---------------------------------------------------------------------------

def export_backfill_csv(conn: sqlite3.Connection, csv_path: str) -> int:
    """Write data/backfills/geocoded-places.csv with all method + detail columns.

    One row per place that has at least one non-NULL method tag. The CSV is
    the round-trip artefact: ``import_geocoding()`` reads it on the next
    harvest cycle to repopulate ``vocabulary``.
    """
    out = Path(csv_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    db_cols = ["id", "label_en", "label_nl", "lat", "lon", "external_id",
               "coord_method", "coord_method_detail",
               "external_id_method", "external_id_method_detail",
               "broader_method", "broader_method_detail"]
    csv_header = ["vocab_id" if c == "id" else c for c in db_cols]
    rows = conn.execute(
        f"""
        SELECT {", ".join(db_cols)}
          FROM vocabulary
         WHERE type = 'place'
           AND (coord_method IS NOT NULL
                OR external_id_method IS NOT NULL
                OR broader_method IS NOT NULL)
         ORDER BY id
        """
    ).fetchall()
    with out.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(csv_header)
        for r in rows:
            w.writerow([r[c] for c in db_cols])
    print(f"Exported {len(rows)} rows → {out}", file=sys.stderr)
    return len(rows)


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
  python3 scripts/geocode_places.py --db data/vocabulary.db --phase 3b
  python3 scripts/geocode_places.py --db data/vocabulary.db --skip-geonames
  python3 scripts/geocode_places.py --db data/vocabulary.db \\
      --apply-reviewed offline/geo/reconciled_review.csv
  python3 scripts/geocode_places.py --db data/vocabulary.db \\
      --apply-reviewed offline/geo/whg_review.csv
  python3 scripts/geocode_places.py --db data/vocabulary.db --propagate-coords
        """,
    )
    parser.add_argument("--db", default="data/vocabulary.db",
                        help="Path to vocabulary.db")
    parser.add_argument("--dry-run", action="store_true",
                        help="Show counts but don't modify DB")
    parser.add_argument("--phase", type=str,
                        choices=["1a", "1b", "1c", "1d", "1e",
                                 "2", "3", "3b", "3c", "3e",
                                 "4", "4-pip", "layer-b"],
                        help="Run only specific phase. v0.25 phases: 1d (WOF), "
                             "1e (RCE), 3e (Pleiades), 4-pip (PIP validation), "
                             "layer-b (Step 7 fail-closed inheritance).")
    parser.add_argument("--skip-geonames", action="store_true",
                        help="Skip Phase 1a (GeoNames API)")
    parser.add_argument("--geonames-user",
                        default=os.environ.get("GEONAMES_USERNAME", "demo"),
                        help="GeoNames API username (or set GEONAMES_USERNAME env var)")
    parser.add_argument("--skip-whg", action="store_true",
                        help="Skip Phase 3b (WHG reconciliation)")
    parser.add_argument("--csv-only", action="store_true",
                        help="Write output CSVs but don't apply matches to DB")
    parser.add_argument("--apply-reviewed",
                        help="Path to reviewed CSV with 'decision' column "
                             "(supports both Wikidata and WHG review formats)")
    parser.add_argument("--propagate-coords", action="store_true",
                        help="Run broader_id coord inheritance (Step 7). "
                             "Uses areal-parent filter — parents with ≥2 geocoded "
                             "children spanning ≥75 km are excluded. Standalone; "
                             "skips all other phases.")
    parser.add_argument("--output-dir", default="offline/geo",
                        help="Output directory for CSVs and reports")
    parser.add_argument("--wof-parquet",
                        default="data/seed/wof/whosonfirst-data-admin-*.parquet",
                        help="Glob for WOF admin parquets (used by --phase 1d / 4-pip)")
    parser.add_argument("--pleiades-dump",
                        default="data/seed/pleiades-places.json.gz",
                        type=Path,
                        help="Path to Pleiades JSON-LD dump (used by --phase 3e)")
    parser.add_argument("--export-backfill-csv", action="store_true",
                        help="Export geocoded-places backfill CSV (with all method "
                             "+ method_detail columns) and exit. Standalone mode.")
    parser.add_argument("--backfill-csv", default="data/backfills/geocoded-places.csv",
                        help="Output path for --export-backfill-csv")
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

    # Handle --export-backfill-csv mode (standalone — exits after writing CSV)
    if args.export_backfill_csv:
        export_backfill_csv(conn, args.backfill_csv)
        conn.close()
        return

    # Handle --propagate-coords mode (Step 7: broader_id coord inheritance)
    if args.propagate_coords:
        if args.dry_run:
            print("--propagate-coords is currently write-only; skipping under --dry-run",
                  file=sys.stderr)
            conn.close()
            return
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        # Import lazily: the harvest module has heavy top-level imports we don't
        # need for the other geocode phases.
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "harvest_vocab_db",
            Path(__file__).resolve().parent / "harvest-vocabulary-db.py",
        )
        harvest_mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(harvest_mod)
        print("\n--- Step 7: Coord inheritance (broader_id propagation) ---",
              file=sys.stderr)
        harvest_mod.propagate_place_coordinates(conn)
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
        total_updated += phase_1a_geonames(
            conn, args.geonames_user, args.dry_run,
            args.csv_only, args.output_dir)

    # Phase 1b: Wikidata alternative properties
    if run_phase in (None, "1b"):
        print(f"\n--- Phase 1b: Wikidata alt-props ---", file=sys.stderr)
        total_updated += phase_1b_wikidata_alt(
            conn, args.dry_run, args.csv_only, args.output_dir)

    # Phase 1c: Getty → Wikidata cross-reference
    if run_phase in (None, "1c"):
        print(f"\n--- Phase 1c: Getty TGN → Wikidata ---", file=sys.stderr)
        total_updated += phase_1c_getty_crossref(
            conn, args.dry_run, args.csv_only, args.output_dir)

    # Phase 1d: Who's On First admin polygon match (v0.25)
    if run_phase == "1d":
        print(f"\n--- Phase 1d: WOF admin polygon match ---", file=sys.stderr)
        total_updated += phase_1d_wof(
            conn, args.wof_parquet, args.dry_run, args.output_dir,
            csv_only=args.csv_only)

    # Phase 1e: RCE Rijksmonumenten via Wikidata QID bridge (v0.25)
    if run_phase == "1e":
        print(f"\n--- Phase 1e: RCE Rijksmonumenten via Wikidata ---",
              file=sys.stderr)
        total_updated += phase_1e_rce(
            conn, args.dry_run, output_dir=args.output_dir,
            csv_only=args.csv_only)

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

    # Phase 3b: World Historical Gazetteer reconciliation (requires WHG_TOKEN)
    if run_phase in (None, "3b") and not args.skip_whg:
        print(f"\n--- Phase 3b: WHG reconciliation ---", file=sys.stderr)
        total_updated += phase_3b_whg(
            conn, args.dry_run, args.csv_only, args.output_dir)

    # Phase 3c: WHG bridge — authority-failed places
    if run_phase in (None, "3c") and not args.skip_whg:
        print(f"\n--- Phase 3c: WHG bridge (authority-failed) ---",
              file=sys.stderr)
        total_updated += phase_3c_whg_bridge(
            conn, args.dry_run, args.csv_only, args.output_dir)

    # Phase 3e: Pleiades classical antiquity reconciliation (v0.25)
    if run_phase == "3e":
        print(f"\n--- Phase 3e: Pleiades classical antiquity ---",
              file=sys.stderr)
        total_updated += phase_3e_pleiades(
            conn, args.pleiades_dump, args.dry_run, args.output_dir)

    # Phase 4: Validation (range/swap heuristics + markdown report)
    if run_phase in (None, "4"):
        print(f"\n--- Phase 4: Validation ---", file=sys.stderr)
        phase_4_validation(conn, args.output_dir)

    # Phase 4-pip: WOF point-in-polygon audit (read-only, never in default loop)
    if run_phase == "4-pip":
        print(f"\n--- Phase 4-pip: WOF PIP audit ---", file=sys.stderr)
        phase_4_pip_validation(conn, args.wof_parquet, args.output_dir)

    # Layer B: fail-closed inheritance via propagate_place_coordinates (#262)
    if run_phase == "layer-b":
        print(f"\n--- Layer B: fail-closed inheritance ---", file=sys.stderr)
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "harvest_vocab_db",
            Path(__file__).resolve().parent / "harvest-vocabulary-db.py",
        )
        harvest_mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(harvest_mod)
        if args.dry_run:
            print("--phase layer-b is currently write-only; skipping under --dry-run",
                  file=sys.stderr)
        else:
            harvest_mod.propagate_place_coordinates(conn)
            total, with_coords = get_coverage(conn)
            print(f"\nFinal coverage: {with_coords:,} / {total:,} "
                  f"({with_coords/total*100:.1f}%)", file=sys.stderr)

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
