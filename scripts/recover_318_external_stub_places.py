#!/usr/bin/env python3
"""Tier 4 of #245 (issue #318): recover label-less Place stubs whose only
useful pointer is an EXTERNAL `schema:sameAs` (TGN / Wikidata / GeoNames).

These are places the museum minted as `rdf:type schema:Place` with a sameAs to
an external authority but NO label of their own — so the harvest's
`parse_nt_file` drops them at parse time (no en/nl/other-language label →
`return None`), and they never become a `vocabulary` row. The stub id and its
authority link survive only in the raw place dump.

This is the sibling of `recover_316_alias_places.py` (Tier 2), which recovered
the INTERNAL-sameAs alias case by copying a labelled canonical sibling's label.
Tier 2 explicitly bucketed these external-only stubs and left them for here
(`# alias stub but only external sameAs (#318)`).

Recovery strategy — for each external-only stub:
  1. Classify the authority of its sameAs URI (tgn / wikidata / geonames).
  2. Dereference the authority for a label (+ coords + placetype + broader).
        - TGN     : per-entity .rdf  (skos:prefLabel@en, wgs84 lat/long,
                    gvp:placeTypePreferred → AAT, gvp:broader)
        - Wikidata: SPARQL rdfs:label@en/@nl + P625 coords
        - GeoNames: getJSON name + lat/lng + fcode  (needs GEONAMES_USERNAME)
  3. INSERT a `vocabulary` row (type='place', label, coords with
     coord_method='deterministic' per the authority-only geo policy, placetype,
     broader_id) + one `vocabulary_external_ids` row per external sameAs.

Resolvers are reused from `scripts/geocoding/batch_geocode.py` so the authority
parsing + coord handling stay consistent with the geocode pipeline.

GENERATOR ONLY — this script never writes the vocabulary DB. It walks the dump,
resolves authorities, and (with --emit-curated) writes two durable curated CSVs:

    data/backfills/recovered-places.csv          (place rows + provenance)
    data/backfills/recovered-place-mappings.csv  (object_number-keyed subject edges)

The DB mutation is a separate idempotent, RELEASE.md-registered apply step
(scripts/apply_recovered_places.py), so the recovery survives a full harvest
rebuild (unlike the direct-write recover_316 precedent — see issue #410).

Usage:
    # report only (population + per-authority resolver yield):
    ~/miniconda3/envs/embeddings/bin/python scripts/recover_318_external_stub_places.py \
        --scan-works ~/Downloads/rijksmuseum-data-dumps/work.tar.gz
    # generate the durable curated CSVs:
    ~/miniconda3/envs/embeddings/bin/python scripts/recover_318_external_stub_places.py \
        --emit-curated data/backfills --scan-works ~/Downloads/rijksmuseum-data-dumps/work.tar.gz
"""
from __future__ import annotations

import argparse
import csv
import os
import re
import subprocess
import sys
import threading
import urllib.parse
import urllib.request
import json
import xml.etree.ElementTree as ET
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DB = REPO_ROOT / "data" / "vocabulary.db"
DEFAULT_DUMP_DIRS = [
    Path("/tmp/rm-dump-place"),
    Path.home() / "Downloads" / "rijksmuseum-data-dumps" / "place_extracted",
]
ENV_FILE = REPO_ROOT / ".env"

RIJKS_PREFIX = "https://id.rijksmuseum.nl/"
SCHEMA_PLACE = "http://schema.org/Place"
SCHEMA_SAMEAS = "http://schema.org/sameAs"
SCHEMA_NAME = "http://schema.org/name"
RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type"

# Reuse the geocode pipeline's authority parsing + the TGN .rdf geo parser
# (coords / placetype / broader). Label extraction is #318-specific (below):
# the pipeline parser only reads skos:prefLabel@en, which misses the untagged
# / vernacular TGN names that ARE the point of recovering a label-less stub.
sys.path.insert(0, str(REPO_ROOT / "scripts" / "geocoding"))
from batch_geocode import (  # noqa: E402
    _parse_tgn_rdf,
    sparql_query,
    extract_tgn_id,
    extract_geonames_id,
    GETTY_RDF_BASE,
    WIKIDATA_SPARQL,
)

# TGN label namespaces (#318 label extraction)
_NS_SKOS = "http://www.w3.org/2004/02/skos/core#"
_NS_RDFS = "http://www.w3.org/2000/01/rdf-schema#"
_NS_GVP = "http://vocab.getty.edu/ontology#"
_XML_LANG = "{http://www.w3.org/XML/1998/namespace}lang"

URI_TRIPLE_RE = re.compile(r"^<([^>]+)>\s+<([^>]+)>\s+<([^>]+)>\s*\.\s*$")
LITERAL_TRIPLE_RE = re.compile(r"^<([^>]+)>\s+<([^>]+)>\s+\".*$")
WIKIDATA_QID_RE = re.compile(r"(?:entity|wiki)/(Q\d+)")
GEONAMES_API = "http://api.geonames.org/getJSON"
USER_AGENT = "rijksmuseum-mcp-plus/0.81 (https://github.com/kintopp/rijksmuseum-mcp-plus)"


def classify_authority(uri: str) -> str | None:
    if "vocab.getty.edu/tgn" in uri:
        return "tgn"
    if "wikidata.org/entity" in uri or "wikidata.org/wiki" in uri:
        return "wikidata"
    if "geonames.org" in uri:
        return "geonames"
    if "pleiades.stoa.org" in uri:
        return "pleiades"
    if "viaf.org" in uri:
        return "viaf"
    if "loc.gov" in uri:
        return "loc"
    return None


def extract_qid(uri: str) -> str | None:
    m = WIKIDATA_QID_RE.search(uri)
    return m.group(1) if m else None


def classify_place_file(path: Path) -> tuple[str, list[str]]:
    """Return (status, external_sameAs_uris) for a place dump file.

    status ∈ {has_label, external_only, internal_alias, no_sameas, not_place}.
    Mirrors recover_316's classifier but surfaces the external sameAs list so
    the external_only bucket (this issue) can be resolved.
    """
    entity_uri = f"{RIJKS_PREFIX}{path.name}"
    is_place = False
    has_name = False
    has_internal_sameas = False
    external: list[str] = []

    try:
        with path.open("r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line or not line.startswith(f"<{entity_uri}>"):
                    continue
                m = URI_TRIPLE_RE.match(line)
                if m:
                    _s, p, o = m.groups()
                    if p == RDF_TYPE and o == SCHEMA_PLACE:
                        is_place = True
                    elif p == SCHEMA_SAMEAS:
                        if o.startswith(RIJKS_PREFIX):
                            has_internal_sameas = True
                        elif classify_authority(o):
                            external.append(o)
                    continue
                lm = LITERAL_TRIPLE_RE.match(line)
                if lm and lm.groups()[1] == SCHEMA_NAME:
                    has_name = True
    except OSError:
        return ("not_place", [])

    if not is_place:
        return ("not_place", [])
    if has_name:
        return ("has_label", [])
    if has_internal_sameas:
        return ("internal_alias", [])      # Tier 2 (#316) territory
    if external:
        return ("external_only", external)  # Tier 4 (#318) — ours
    return ("no_sameas", [])


@dataclass
class Resolution:
    rijks_id: str
    authority: str
    auth_id: str
    uri: str
    label_en: str | None = None
    label_nl: str | None = None
    lat: float | None = None
    lon: float | None = None
    placetype: str | None = None      # full AAT URI (TGN) or feature code (GeoNames)
    broader_tgn: str | None = None
    error: str | None = None

    @property
    def has_label(self) -> bool:
        return bool(self.label_en or self.label_nl)


# --------------------------------------------------------------------------
# Resolvers
# --------------------------------------------------------------------------

def _tgn_best_label(body: bytes) -> str | None:
    """Best display label for a TGN entity, in priority order:
      skos:prefLabel@en → untagged skos:prefLabel → rdfs:label@en/untagged →
      any-lang skos:prefLabel → any rdfs:label → gvp:term (reified Label node).

    The geocode pipeline's parser only takes skos:prefLabel@en, which is wrong
    here: a label-less stub's authority is usually a vernacular place whose
    preferred TGN term carries no @lang tag (e.g. 'Mondaino'). First-wins per
    bucket; TGN's per-entity .rdf is about the one subject (reified Label/source
    nodes use gvp:term / skosxl:literalForm, not skos:prefLabel/rdfs:label)."""
    try:
        root = ET.fromstring(body)
    except ET.ParseError:
        return None
    pref_en = pref_untagged = pref_any = None
    rdfs_pref = rdfs_any = gvp_term = None
    for elem in root.iter():
        if "}" not in elem.tag:
            continue
        ns, _, tag = elem.tag[1:].partition("}")
        text = (elem.text or "").strip()
        if not text:
            continue
        lang = elem.get(_XML_LANG)
        if ns == _NS_SKOS and tag == "prefLabel":
            if lang == "en" and pref_en is None:
                pref_en = text
            elif not lang and pref_untagged is None:
                pref_untagged = text
            elif pref_any is None:
                pref_any = text
        elif ns == _NS_RDFS and tag == "label":
            if (lang == "en" or not lang) and rdfs_pref is None:
                rdfs_pref = text
            elif rdfs_any is None:
                rdfs_any = text
        elif ns == _NS_GVP and tag == "term" and gvp_term is None:
            gvp_term = text
    return pref_en or pref_untagged or rdfs_pref or pref_any or rdfs_any or gvp_term


def _tgn_session() -> "object":
    s = getattr(_tgn_tls, "session", None)
    if s is None:
        import requests
        from requests.adapters import HTTPAdapter
        from urllib3.util.retry import Retry
        s = requests.Session()
        s.headers.update({"User-Agent": USER_AGENT, "Accept": "application/rdf+xml",
                          "Accept-Encoding": "gzip"})
        # 499 = Getty closing the connection under load (seen on bulk runs);
        # retryable like 429/5xx.
        retry = Retry(total=3, backoff_factor=0.5, status_forcelist=[429, 499, 502, 503, 504],
                      allowed_methods=frozenset(["GET"]), raise_on_status=False)
        adapter = HTTPAdapter(pool_connections=1, pool_maxsize=1, max_retries=retry)
        s.mount("http://", adapter)
        s.mount("https://", adapter)
        _tgn_tls.session = s
    return s


_tgn_tls = threading.local()


def resolve_tgn(stubs: list[tuple[str, str]], max_workers: int) -> dict[str, Resolution]:
    """stubs: [(rijks_id, tgn_uri)]. Fetch each .rdf once; reuse _parse_tgn_rdf
    for coords/placetype/broader, then overlay the #318 label fallback chain."""
    def fetch(rid: str, uri: str) -> Resolution:
        tgn_id = extract_tgn_id(uri) or ""
        r = Resolution(rid, "tgn", tgn_id, uri)
        if not tgn_id:
            r.error = "no tgn id"
            return r
        try:
            resp = _tgn_session().get(f"{GETTY_RDF_BASE}{tgn_id}.rdf",
                                      timeout=20, allow_redirects=True)
        except Exception as e:  # noqa: BLE001
            r.error = f"transport: {e.__class__.__name__}"
            return r
        if resp.status_code != 200:
            r.error = f"HTTP {resp.status_code}"
            return r
        rec = _parse_tgn_rdf(resp.content, tgn_id)
        r.lat, r.lon = rec.lat, rec.lon
        r.placetype, r.broader_tgn = rec.placetype_aat, rec.broader_tgn
        r.label_en = _tgn_best_label(resp.content) or rec.label_en
        return r

    out: dict[str, Resolution] = {}
    if not stubs:
        return out
    with ThreadPoolExecutor(max_workers=max_workers) as ex:
        futures = [ex.submit(fetch, rid, uri) for rid, uri in stubs]
        for fut in as_completed(futures):
            r = fut.result()
            out[r.rijks_id] = r
    return out


def resolve_wikidata(stubs: list[tuple[str, str]]) -> dict[str, Resolution]:
    """stubs: [(rijks_id, wikidata_uri)]. SPARQL for label@en/@nl + P625 coords."""
    out: dict[str, Resolution] = {}
    qid_to_rid: dict[str, str] = {}
    for rid, uri in stubs:
        qid = extract_qid(uri)
        out[rid] = Resolution(rid, "wikidata", qid or "", uri, error="no qid" if not qid else None)
        if qid:
            qid_to_rid[qid] = rid
    if not qid_to_rid:
        return out

    qids = list(qid_to_rid)
    values = " ".join(f"wd:{q}" for q in qids)
    query = f"""
    SELECT ?item ?label_en ?label_nl ?lat ?lon WHERE {{
      VALUES ?item {{ {values} }}
      OPTIONAL {{ ?item rdfs:label ?label_en . FILTER(LANG(?label_en) = "en") }}
      OPTIONAL {{ ?item rdfs:label ?label_nl . FILTER(LANG(?label_nl) = "nl") }}
      OPTIONAL {{
        ?item wdt:P625 ?coord .
        BIND(geof:latitude(?coord) AS ?lat)
        BIND(geof:longitude(?coord) AS ?lon)
      }}
    }}
    """
    try:
        bindings = sparql_query(WIKIDATA_SPARQL, query)
    except Exception as e:  # noqa: BLE001
        for rid in qid_to_rid.values():
            out[rid].error = f"sparql: {e}"
        return out

    for b in bindings:
        qid = b["item"]["value"].rsplit("/", 1)[-1]
        rid = qid_to_rid.get(qid)
        if not rid:
            continue
        r = out[rid]
        r.error = None
        if "label_en" in b:
            r.label_en = b["label_en"]["value"]
        if "label_nl" in b:
            r.label_nl = b["label_nl"]["value"]
        if "lat" in b and "lon" in b:
            r.lat = float(b["lat"]["value"])
            r.lon = float(b["lon"]["value"])
    return out


def load_geonames_username() -> str | None:
    if os.environ.get("GEONAMES_USERNAME"):
        return os.environ["GEONAMES_USERNAME"]
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            if line.startswith("GEONAMES_USERNAME="):
                return line.split("=", 1)[1].strip()
    return None


def resolve_geonames(stubs: list[tuple[str, str]], username: str | None) -> dict[str, Resolution]:
    """stubs: [(rijks_id, geonames_uri)]. getJSON name + lat/lng + fcode."""
    out: dict[str, Resolution] = {}
    for rid, uri in stubs:
        raw_gid = extract_geonames_id(uri) or ""
        # Some sameAs targets append a path segment (e.g. ".../128228/kermanshah.html",
        # ".../6558017/about.rdf") that extract_geonames_id leaves in — the numeric
        # GeoNames id is the leading digit run.
        gm = re.match(r"\d+", raw_gid)
        gid = gm.group(0) if gm else ""
        r = Resolution(rid, "geonames", gid, uri)
        out[rid] = r
        if not gid:
            r.error = "no geonames id"
            continue
        if not username:
            r.error = "no GEONAMES_USERNAME"
            continue
        params = urllib.parse.urlencode({"geonameId": gid, "username": username})
        req = urllib.request.Request(f"{GEONAMES_API}?{params}", headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read().decode())
        except Exception as e:  # noqa: BLE001
            r.error = f"http: {e.__class__.__name__}"
            continue
        if data.get("status"):  # GeoNames error envelope
            r.error = f"geonames: {data['status'].get('message', 'error')}"
            continue
        r.label_en = data.get("name") or data.get("toponymName")
        if data.get("lat") and data.get("lng"):
            try:
                r.lat = float(data["lat"])
                r.lon = float(data["lng"])
            except ValueError:
                pass
        r.placetype = data.get("fcode")
    return out


# --------------------------------------------------------------------------
# Work-dump reference scan (upper bound on addressable artworks)
# --------------------------------------------------------------------------

_ABOUT_RE = re.compile(
    rb"^<https://id\.rijksmuseum\.nl/(\d+)> <http://schema\.org/about> "
    rb"<https://id\.rijksmuseum\.nl/(\d+)>"
)


def scan_works(work_tar: Path, stub_ids: list[str]) -> dict:
    """Stream work.tar.gz and count works that schema:about one of the stubs.

    Matching is done in Python over tar's decompressed stdout — deliberately NOT
    piped to an external grep. The interactive `grep` here is a Claude shell-
    function shim to ugrep (fast), but a subprocess shell resolves to BSD
    /usr/bin/grep, which is pathologically slow (minutes, 100% CPU) on this ~1 GB
    multibyte stream even under LC_ALL=C. A cheap bytes prefilter keeps Python
    fast: stub ids are the 33-prefixed authority series, so only lines carrying
    both `/about>` and `rijksmuseum.nl/33` are regex-matched.
    Returns {referenced_stubs, orphan_stubs, distinct_works, cites} where
    cites[stub_id] = set(work_id) (work_id is the 300xxx VisualItem)."""
    stub_set = {sid.encode() for sid in stub_ids}
    cites: dict[str, set[str]] = {}
    works: set[bytes] = set()
    tar = subprocess.Popen(["tar", "-xzOf", str(work_tar)], stdout=subprocess.PIPE)
    try:
        for raw in tar.stdout:
            if b"/about>" not in raw or b"rijksmuseum.nl/33" not in raw:
                continue
            m = _ABOUT_RE.match(raw)
            if m and m.group(2) in stub_set:
                works.add(m.group(1))
                cites.setdefault(m.group(2).decode(), set()).add(m.group(1).decode())
    finally:
        tar.stdout.close()
        tar.wait()
    return {
        "referenced_stubs": set(cites),
        "orphan_stubs": [s for s in stub_ids if s not in cites],
        "distinct_works": len(works),
        "cites": cites,
    }


# --------------------------------------------------------------------------
# Curated-CSV emission (the durable, harvest-surviving artifacts)
# --------------------------------------------------------------------------

# authority → coord_method_detail (matches the values the geocode pipeline
# already writes, so strip_non_authority_coords.py keeps these as 'deterministic')
COORD_DETAIL = {"tgn": "tgn_rdf_direct", "wikidata": "wikidata_p625", "geonames": "geonames_api"}

PLACES_CSV = "recovered-places.csv"
MAPPINGS_CSV = "recovered-place-mappings.csv"

PLACES_HEADER = [
    "vocab_id", "recovery_tier", "label_en", "label_nl", "lat", "lon",
    "coord_method", "coord_method_detail", "placetype", "placetype_source",
    "broader_id", "authority", "auth_id", "uri", "resolved_at", "evidence",
]
MAPPINGS_HEADER = ["object_number", "vocab_id", "field", "source", "resolved_at"]


def emit_curated(out_dir: Path, resolutions: dict, cites: dict,
                 conn, resolved_at: str) -> tuple[int, int]:
    """Write the two durable curated CSVs from the resolved stubs + work-scan.

    recovered-places.csv      — one row per recoverable place (got a label).
    recovered-place-mappings.csv — object_number-keyed depicted-place subject
    edges (work→stub via schema:about, work→art_id→object_number via handle).
    No DB writes; these CSVs feed scripts/apply_recovered_places.py (registered
    in RELEASE.md, idempotent, harvest-durable)."""
    out_dir.mkdir(parents=True, exist_ok=True)
    c = conn.cursor()
    # handle → art_id (PK is art_id-first, so build an in-memory id→art_id map)
    handle_art = {hid: aid for aid, hid in c.execute(
        "SELECT art_id, id FROM artwork_external_ids WHERE authority='handle'").fetchall()}
    art_obj = dict(c.execute("SELECT art_id, object_number FROM artworks").fetchall())

    # places
    n_places = 0
    with (out_dir / PLACES_CSV).open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(PLACES_HEADER)
        for rid, r in sorted(resolutions.items()):
            if not r.has_label:
                continue
            has_coord = r.lat is not None and r.lon is not None
            # placetype column is AAT/Wikidata-URI typed; only TGN gives an AAT
            # URI here (GeoNames fcodes are not stored to keep the column clean).
            ptype = r.placetype if (r.authority == "tgn" and r.placetype) else ""
            ev = (f"Recovered label-less schema:Place stub via {r.authority} {r.auth_id}: "
                  f"label={ (r.label_en or r.label_nl)!r}"
                  + (f", coords=({r.lat},{r.lon})" if has_coord else ", no coords")
                  + (f", placetype={r.placetype}" if r.placetype else "") + ".")
            w.writerow([
                rid, "external_authority", r.label_en or "", r.label_nl or "",
                r.lat if has_coord else "", r.lon if has_coord else "",
                "deterministic" if has_coord else "",
                COORD_DETAIL[r.authority] if has_coord else "",
                ptype, "tgn" if ptype else "",
                "",  # broader_id: TGN broader is a TGN id, not a rijks vocab id — omit
                r.authority, r.auth_id, r.uri, resolved_at, ev,
            ])
            n_places += 1

    # mappings: work(300xxx) → handle RM0001.COLLECT.{wid[3:]} → art_id → object_number
    n_maps = 0
    seen: set[tuple[str, str]] = set()
    with (out_dir / MAPPINGS_CSV).open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(MAPPINGS_HEADER)
        for rid, works in sorted(cites.items()):
            if rid not in resolutions or not resolutions[rid].has_label:
                continue
            for wid in sorted(works):
                if not wid.startswith("300"):
                    continue
                aid = handle_art.get(f"RM0001.COLLECT.{wid[3:]}")
                obj = art_obj.get(aid) if aid is not None else None
                if not obj:
                    continue
                key = (obj, rid)
                if key in seen:
                    continue
                seen.add(key)
                w.writerow([obj, rid, "subject", "linked_art:schema_about", resolved_at])
                n_maps += 1
    return n_places, n_maps


# --------------------------------------------------------------------------

def find_dump_dir(candidates: list[Path]) -> Path | None:
    for p in candidates:
        if p.is_dir() and any(p.iterdir()):
            return p
    return None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    ap.add_argument("--db", type=Path, default=DEFAULT_DB)
    ap.add_argument("--dump-dir", type=Path, default=None)
    ap.add_argument("--no-resolve", action="store_true",
                    help="Skip network resolution; report population/dispatch plan only.")
    ap.add_argument("--scan-works", type=Path, default=None,
                    help="Path to work.tar.gz; report how many works schema:about a stub.")
    ap.add_argument("--emit-curated", type=Path, default=None, metavar="DIR",
                    help="Write durable curated CSVs (recovered-places.csv + "
                         "recovered-place-mappings.csv) to DIR (e.g. data/backfills). "
                         "Requires --scan-works and resolution. NO DB writes — apply via "
                         "scripts/apply_recovered_places.py.")
    ap.add_argument("--tgn-workers", type=int, default=6)
    ap.add_argument("--audit-tsv", type=Path,
                    default=REPO_ROOT / f"data/audit/issue-318-recovery-{datetime.now(timezone.utc).strftime('%Y-%m-%d')}.tsv")
    args = ap.parse_args()

    if not args.db.exists():
        print(f"ERROR: DB not found: {args.db}", file=sys.stderr)
        return 1
    dump_dir = args.dump_dir or find_dump_dir(DEFAULT_DUMP_DIRS)
    if dump_dir is None or not dump_dir.is_dir():
        print(f"ERROR: no place dump dir among {DEFAULT_DUMP_DIRS}", file=sys.stderr)
        return 1
    print(f"Place dump dir: {dump_dir}")

    import sqlite3
    conn = sqlite3.connect(args.db)
    existing_ids = {r[0] for r in conn.execute("SELECT id FROM vocabulary").fetchall()}
    print(f"Vocab rows already loaded: {len(existing_ids):,}")

    # 1. Walk dump → classify, collect external_only stubs
    files = sorted(f for f in os.listdir(dump_dir)
                   if (dump_dir / f).is_file() and not f.startswith("."))
    print(f"Place dump files to scan: {len(files):,}")
    counters: Counter = Counter()
    stubs: dict[str, list[str]] = {}        # rijks_id → [external_uri]
    already_loaded = 0
    for fname in files:
        if fname in existing_ids:
            already_loaded += 1
            # still classify? no — already a row; only interested in dropped stubs
            continue
        status, external = classify_place_file(dump_dir / fname)
        counters[status] += 1
        if status == "external_only":
            stubs[fname] = external

    print("\n=== classification of NOT-already-loaded place files ===")
    print(f"  {'already_loaded':>16}: {already_loaded:,}")
    for k in ("external_only", "internal_alias", "has_label", "no_sameas", "not_place"):
        print(f"  {k:>16}: {counters[k]:,}")

    # 2. Authority breakdown of external_only stubs (1 stub may have >1 sameAs;
    #    pick the first resolvable authority per stub for dispatch).
    by_auth: dict[str, list[tuple[str, str]]] = {"tgn": [], "wikidata": [], "geonames": []}
    other_auth: Counter = Counter()
    dispatch: dict[str, tuple[str, str]] = {}   # rijks_id → (authority, uri)
    for rid, uris in stubs.items():
        chosen = None
        for uri in uris:
            a = classify_authority(uri)
            if a in by_auth:
                chosen = (a, uri)
                break
            elif a:
                other_auth[a] += 1
        if chosen:
            dispatch[rid] = chosen
            by_auth[chosen[0]].append((rid, chosen[1]))

    print(f"\n=== #318 external-only stub population: {len(stubs):,} ===")
    for a in ("tgn", "wikidata", "geonames"):
        print(f"  dispatch {a:>9}: {len(by_auth[a]):,}")
    if other_auth:
        print(f"  out-of-resolver-scope authorities (first-pick): {dict(other_auth)}")

    # 3. Work-dump reference scan (addressable artworks). Forced when emitting
    #    curated CSVs — the mappings need the per-stub work citations.
    cites: dict | None = None
    work_tar = args.scan_works
    if args.emit_curated and work_tar is None:
        print("ERROR: --emit-curated requires --scan-works <work.tar.gz>.", file=sys.stderr)
        conn.close()
        return 1
    if work_tar:
        print(f"\n=== scanning {work_tar.name} for works that schema:about a stub ===")
        ws = scan_works(work_tar, list(stubs.keys()))
        cites = ws["cites"]
        print(f"  stubs referenced by ≥1 work : {len(ws['referenced_stubs']):,} / {len(stubs):,}")
        print(f"  stubs referenced by NO work : {len(ws['orphan_stubs']):,}  (vocab-only, no artwork value)")
        print(f"  distinct works citing a stub: {ws['distinct_works']:,}  (UPPER BOUND on addressable artworks)")

    # 4. Resolve (unless --no-resolve)
    resolutions: dict[str, Resolution] = {}
    if args.no_resolve:
        print("\n[--no-resolve] skipping network resolution (dispatch plan above).")
    else:
        print("\n=== resolving authorities (no DB writes) ===")
        if by_auth["tgn"]:
            print(f"  TGN: dereferencing {len(by_auth['tgn'])} .rdf entities ...")
            resolutions.update(resolve_tgn(by_auth["tgn"], args.tgn_workers))
        if by_auth["wikidata"]:
            print(f"  Wikidata: SPARQL for {len(by_auth['wikidata'])} QIDs ...")
            resolutions.update(resolve_wikidata(by_auth["wikidata"]))
        if by_auth["geonames"]:
            gn_user = load_geonames_username()
            print(f"  GeoNames: {len(by_auth['geonames'])} ids "
                  f"({'username loaded' if gn_user else 'NO username — will skip'}) ...")
            resolutions.update(resolve_geonames(by_auth["geonames"], gn_user))

        # Yield report
        print("\n=== resolver yield ===")
        hdr = f"  {'authority':>9} {'dispatched':>10} {'label':>7} {'coords':>7} {'placetype':>9} {'failed':>7}"
        print(hdr)
        audit_rows = []
        for a in ("tgn", "wikidata", "geonames"):
            disp = by_auth[a]
            recs = [resolutions[rid] for rid, _ in disp if rid in resolutions]
            n_label = sum(1 for r in recs if r.has_label)
            n_coord = sum(1 for r in recs if r.lat is not None and r.lon is not None)
            n_ptype = sum(1 for r in recs if r.placetype)
            n_fail = sum(1 for r in recs if not r.has_label)
            print(f"  {a:>9} {len(disp):>10} {n_label:>7} {n_coord:>7} {n_ptype:>9} {n_fail:>7}")
            for r in recs:
                audit_rows.append(r)
        total_label = sum(1 for r in resolutions.values() if r.has_label)
        total_coord = sum(1 for r in resolutions.values() if r.lat is not None)
        print(f"\n  RECOVERABLE (got a label): {total_label:,} / {len(stubs):,} stubs"
              f"   |  with coords: {total_coord:,}")

        # Sample successes + failures
        ok = [r for r in resolutions.values() if r.has_label][:6]
        bad = [r for r in resolutions.values() if not r.has_label][:6]
        print("\n  --- sample resolved ---")
        for r in ok:
            print(f"    {r.rijks_id} [{r.authority}:{r.auth_id}] -> "
                  f"{(r.label_en or r.label_nl)!r}  coords={r.lat},{r.lon}  ptype={r.placetype}")
        if bad:
            print("  --- sample unresolved ---")
            for r in bad:
                print(f"    {r.rijks_id} [{r.authority}:{r.auth_id}] -> error={r.error}")

        # Audit TSV
        args.audit_tsv.parent.mkdir(parents=True, exist_ok=True)
        with args.audit_tsv.open("w", newline="") as f:
            w = csv.writer(f, delimiter="\t")
            w.writerow(["rijks_id", "authority", "auth_id", "uri",
                        "label_en", "label_nl", "lat", "lon", "placetype", "broader_tgn", "error"])
            for r in audit_rows:
                w.writerow([r.rijks_id, r.authority, r.auth_id, r.uri,
                            r.label_en or "", r.label_nl or "", r.lat or "", r.lon or "",
                            r.placetype or "", r.broader_tgn or "", r.error or ""])
        print(f"\n  audit TSV: {args.audit_tsv} ({len(audit_rows)} rows)")

    # Curated CSV emission — the durable, harvest-surviving artifacts. This
    # generator NEVER writes the DB; the DB mutation lives in the idempotent,
    # RELEASE.md-registered scripts/apply_recovered_places.py.
    if args.emit_curated:
        if args.no_resolve or not resolutions:
            print("ERROR: --emit-curated requires resolution (don't pass --no-resolve).", file=sys.stderr)
            conn.close()
            return 1
        resolved_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        n_places, n_maps = emit_curated(args.emit_curated, resolutions, cites or {}, conn, resolved_at)
        print(f"\n=== curated CSVs written to {args.emit_curated} ===")
        print(f"  {PLACES_CSV}   : {n_places} place rows (recoverable, got a label)")
        print(f"  {MAPPINGS_CSV} : {n_maps} artwork→place subject mappings")
        print("  NO DB writes — apply via scripts/apply_recovered_places.py "
              "(idempotent, registered in RELEASE.md before strip_non_authority_coords.py).")
        conn.close()
        return 0

    print("\n[report-only — no curated CSVs written. Pass "
          "--emit-curated data/backfills --scan-works <work.tar.gz> to generate them.]")
    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
