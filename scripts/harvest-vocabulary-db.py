#!/usr/bin/env python3
"""
Full-scale vocabulary database builder for Rijksmuseum MCP+.

Builds a SQLite database mapping vocabulary terms (Iconclass subjects, depicted
persons/places, materials, techniques, types, creators) to artworks, enabling
vocabulary-based search in the MCP server.

Phases:
  0. Parse ALL data dumps (classification, person, place, concept, event, topical_term, organisation)
  1. Harvest ALL OAI-PMH records (836K+), extract 9 vocabulary fields
  2. Resolve unmatched vocabulary URIs via Linked Art API (multi-threaded)
  3. Print validation stats

Usage:
    python3 scripts/harvest-vocabulary-db.py                # Full run (all phases)
    python3 scripts/harvest-vocabulary-db.py --resume       # Resume from checkpoint
    python3 scripts/harvest-vocabulary-db.py --skip-dump    # Skip Phase 0 (no local dump)
    python3 scripts/harvest-vocabulary-db.py --phase 3      # Run only from phase N onward

Output: data/vocabulary.db (~1 GB)
"""

import argparse
import json
import os
import re
import sqlite3
import tarfile
import time
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

# ─── Configuration ───────────────────────────────────────────────────

SCRIPT_DIR = Path(__file__).parent
PROJECT_DIR = SCRIPT_DIR.parent
DB_PATH = PROJECT_DIR / "data" / "vocabulary.db"
CHECKPOINT_PATH = SCRIPT_DIR / ".harvest-checkpoint"
DUMPS_DIR = Path.home() / "Downloads" / "rijksmuseum-data-dumps"

# Dump files to parse in Phase 0, with their vocabulary type mappings.
# NOTE on ID namespaces:
#   - classification (22xxx) → matches dc:subject Iconclass refs directly
#   - concept (12xxx) → matches dcterms:medium, dc:type, dcterms:technique refs
#   - person (31xxx) → matches dc:creator refs (bibliographic/artist persons)
#     BUT NOT depicted persons (21xxx) — those need Phase 2 HTTP resolution
#   - place (13xxx) → matches dcterms:spatial refs (production places)
#     BUT NOT depicted places (23xxx) — those need Phase 2 HTTP resolution
#   - event (24xxx) → partially matches dc:subject event refs
DUMP_CONFIGS = [
    # (tar.gz name, default vocab type)
    ("classification", "classification"),
    ("concept", "classification"),
    ("topical_term", "classification"),
    ("person", "person"),
    ("organisation", "person"),
    ("place", "place"),
    ("event", "event"),
]

OAI_BASE = "https://data.rijksmuseum.nl/oai"
LINKED_ART_BASE = "https://data.rijksmuseum.nl"
USER_AGENT = "rijksmuseum-mcp-harvest/1.0"
RESOLVE_THREADS = 8
BATCH_SIZE = 500  # Commit every N pages

# ─── N-Triples parsing (same as pilot) ──────────────────────────────

NT_PATTERN = re.compile(
    r'^<([^>]+)>\s+<([^>]+)>\s+(?:<([^>]+)>|"([^"]*)")\s*\.\s*$'
)
BNODE_PATTERN = re.compile(
    r'^_:(\S+)\s+<([^>]+)>\s+(?:<([^>]+)>|"([^"]*)")\s*\.\s*$'
)

P_LABEL = "http://www.cidoc-crm.org/cidoc-crm/P190_has_symbolic_content"
P_LANGUAGE = "http://www.cidoc-crm.org/cidoc-crm/P72_has_language"
P_EQUIVALENT = "https://linked.art/ns/terms/equivalent"
P_BROADER = "http://www.w3.org/2004/02/skos/core#broader"
P_HAS_TYPE = "http://www.cidoc-crm.org/cidoc-crm/P2_has_type"
LANG_EN = "http://vocab.getty.edu/aat/300388277"
LANG_NL = "http://vocab.getty.edu/aat/300388256"
AAT_DISPLAY_NAME = "http://vocab.getty.edu/aat/300404670"

# Linked Art type → vocabulary type
LA_TYPE_MAP = {
    "Person": "person",
    "Group": "person",
    "Actor": "person",
    "Place": "place",
    "Activity": "event",
    "Set": "classification",
    "Type": "classification",
    "Material": "classification",
    "MeasurementUnit": "classification",
    "Language": "classification",
    "Currency": "classification",
}

# External vocabulary IDs (e.g. Getty AAT) used directly in OAI-PMH dc:type.
# The Rijksmuseum API returns 404 for these since they aren't Rijksmuseum entities.
EXTERNAL_VOCAB = {
    "300078817": {"type": "classification", "label_en": "rectos", "label_nl": "rectozijden", "external_id": "http://vocab.getty.edu/aat/300078817"},
    "300010292": {"type": "classification", "label_en": "versos", "label_nl": "versozijden", "external_id": "http://vocab.getty.edu/aat/300010292"},
}

# ─── XML Namespaces ──────────────────────────────────────────────────

NS = {
    "oai": "http://www.openarchives.org/OAI/2.0/",
    "dc": "http://purl.org/dc/elements/1.1/",
    "dcterms": "http://purl.org/dc/terms/",
    "edm": "http://www.europeana.eu/schemas/edm/",
    "edmfp": "http://www.europeanafashion.eu/edmfp/",
    "ore": "http://www.openarchives.org/ore/terms/",
    "rdf": "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
    "rdaGr2": "http://rdvocab.info/ElementsGr2/",
    "skos": "http://www.w3.org/2004/02/skos/core#",
}

RDF_RESOURCE = "{http://www.w3.org/1999/02/22-rdf-syntax-ns#}resource"
RDF_ABOUT = "{http://www.w3.org/1999/02/22-rdf-syntax-ns#}about"
XML_LANG = "{http://www.w3.org/XML/1998/namespace}lang"

# EDM fields on ProvidedCHO that map to vocabulary references.
# Each entry: (XML tag with full namespace, mapping field name)
CHO_VOCAB_FIELDS = [
    ("{http://purl.org/dc/elements/1.1/}subject",             "subject"),
    ("{http://purl.org/dc/terms/}medium",                     "material"),
    ("{http://purl.org/dc/elements/1.1/}type",                "type"),       # rdf:resource refs only, not text edm:type
    ("{http://purl.org/dc/elements/1.1/}creator",             "creator"),
    ("{http://purl.org/dc/terms/}spatial",                    "spatial"),     # production place
    ("{http://www.europeanafashion.eu/edmfp/}technique",      "technique"),
]


# ─── Database Schema ─────────────────────────────────────────────────

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS vocabulary (
    id          TEXT PRIMARY KEY,
    type        TEXT NOT NULL,
    label_en    TEXT,
    label_nl    TEXT,
    external_id TEXT,
    broader_id  TEXT,
    notation    TEXT,
    lat         REAL,
    lon         REAL
);

CREATE TABLE IF NOT EXISTS artworks (
    object_number  TEXT PRIMARY KEY,
    title          TEXT,
    creator_label  TEXT,
    rights_uri     TEXT
);

CREATE TABLE IF NOT EXISTS mappings (
    object_number  TEXT NOT NULL,
    vocab_id       TEXT NOT NULL,
    field          TEXT NOT NULL,
    PRIMARY KEY (object_number, vocab_id, field)
);

CREATE INDEX IF NOT EXISTS idx_mappings_field_vocab ON mappings(field, vocab_id);
CREATE INDEX IF NOT EXISTS idx_mappings_field_object ON mappings(field, object_number);
CREATE INDEX IF NOT EXISTS idx_mappings_vocab ON mappings(vocab_id);
CREATE INDEX IF NOT EXISTS idx_vocab_label_en ON vocabulary(label_en COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_vocab_label_nl ON vocabulary(label_nl COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_vocab_notation ON vocabulary(notation);
CREATE INDEX IF NOT EXISTS idx_vocab_type ON vocabulary(type);
"""

VOCAB_INSERT_SQL = (
    "INSERT OR IGNORE INTO vocabulary "
    "(id, type, label_en, label_nl, external_id, broader_id, notation, lat, lon) "
    "VALUES (:id, :type, :label_en, :label_nl, :external_id, :broader_id, :notation, :lat, :lon)"
)


def create_or_open_db() -> sqlite3.Connection:
    """Create or open the SQLite database."""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA cache_size=-64000")  # 64 MB cache
    conn.executescript(SCHEMA_SQL)
    return conn


# ─── Phase 0: Parse data dumps ────────────────────────────────────────

def parse_nt_file(filepath: str, default_type: str) -> dict | None:
    """Parse a single N-Triples entity file into a vocabulary record."""
    entity_id = os.path.basename(filepath)
    entity_uri = f"https://id.rijksmuseum.nl/{entity_id}"

    bnodes: dict[str, dict] = {}
    equivalents: list[str] = []
    broader_id: str | None = None
    notation: str | None = None
    defined_by: str | None = None
    rdf_type: str | None = None

    try:
        with open(filepath, "r", encoding="utf-8") as f:
            lines = f.readlines()
    except Exception:
        return None

    for line in lines:
        line = line.strip()
        if not line:
            continue

        m = NT_PATTERN.match(line)
        if m and m.group(1) == entity_uri:
            pred = m.group(2)
            obj_uri = m.group(3)
            obj_lit = m.group(4)
            if pred == P_EQUIVALENT and obj_uri:
                equivalents.append(obj_uri)
            elif pred == P_BROADER and obj_uri:
                broader_id = obj_uri.split("/")[-1]
            elif pred == "http://www.cidoc-crm.org/cidoc-crm/P168_place_is_defined_by" and obj_lit:
                defined_by = obj_lit
            elif pred == "http://www.w3.org/1999/02/22-rdf-syntax-ns#type" and obj_uri:
                rdf_type = obj_uri

        m = BNODE_PATTERN.match(line)
        if m:
            bnode_id = m.group(1)
            pred = m.group(2)
            obj_uri = m.group(3)
            obj_lit = m.group(4)

            if bnode_id not in bnodes:
                bnodes[bnode_id] = {}

            if pred == P_LABEL and obj_lit is not None:
                bnodes[bnode_id]["label"] = obj_lit
            elif pred == P_LANGUAGE and obj_uri:
                bnodes[bnode_id]["language"] = obj_uri
            elif pred == P_HAS_TYPE and obj_uri == AAT_DISPLAY_NAME:
                bnodes[bnode_id]["is_display_name"] = True
            elif pred == "http://www.w3.org/1999/02/22-rdf-syntax-ns#type":
                if obj_uri == "http://www.cidoc-crm.org/cidoc-crm/E42_Identifier":
                    bnodes[bnode_id]["is_identifier"] = True

    label_en = None
    label_nl = None

    for bdata in bnodes.values():
        label = bdata.get("label")
        if not label:
            continue
        if bdata.get("is_identifier"):
            notation = label
        elif bdata.get("is_display_name"):
            lang = bdata.get("language")
            if lang == LANG_EN:
                label_en = label
            elif lang == LANG_NL:
                label_nl = label

    # Determine type from RDF type if we can
    vocab_type = default_type
    if rdf_type:
        type_name = rdf_type.rsplit("/", 1)[-1] if "/" in rdf_type else rdf_type
        type_name = type_name.rsplit("#", 1)[-1] if "#" in type_name else type_name
        if type_name in LA_TYPE_MAP:
            vocab_type = LA_TYPE_MAP[type_name]

    # Pick best external ID (prefer Wikidata, Iconclass)
    external_id = None
    for eq in equivalents:
        if "iconclass.org" in eq:
            external_id = eq
            break
        if "wikidata.org" in eq:
            external_id = eq
            break
    if not external_id and equivalents:
        external_id = equivalents[0]

    # Parse coordinates for places
    lat = None
    lon = None
    if defined_by and defined_by.startswith("POINT"):
        notation = defined_by
        m_coord = re.match(r"POINT\(([-\d.]+)\s+([-\d.]+)\)", defined_by)
        if m_coord:
            lon = float(m_coord.group(1))
            lat = float(m_coord.group(2))

    if not label_en and not label_nl:
        return None

    return {
        "id": entity_id,
        "type": vocab_type,
        "label_en": label_en,
        "label_nl": label_nl,
        "external_id": external_id,
        "broader_id": broader_id,
        "notation": notation,
        "lat": lat,
        "lon": lon,
    }


def extract_dump(tar_name: str) -> Path | None:
    """Extract a tar.gz dump to a temp directory, return the path."""
    tar_path = DUMPS_DIR / f"{tar_name}.tar.gz"
    if not tar_path.exists():
        return None
    extract_dir = Path("/tmp") / f"rm-dump-{tar_name}"
    if extract_dir.exists() and any(extract_dir.iterdir()):
        return extract_dir  # Already extracted
    extract_dir.mkdir(parents=True, exist_ok=True)
    with tarfile.open(tar_path, "r:gz") as tf:
        tf.extractall(extract_dir)
    return extract_dir


def parse_dump_dir(dump_dir: Path, default_type: str) -> list[dict]:
    """Parse all N-Triples files in a dump directory."""
    files = [f for f in os.listdir(dump_dir) if os.path.isfile(dump_dir / f) and not f.startswith(".")]
    total = len(files)
    records = []
    for i, fname in enumerate(files):
        if i % 5000 == 0 and i > 0:
            print(f"    Parsing: {i}/{total}...", flush=True)
        rec = parse_nt_file(str(dump_dir / fname), default_type)
        if rec:
            records.append(rec)
    return records


def run_phase0(conn: sqlite3.Connection):
    """Phase 0: Parse all data dumps into vocabulary table."""
    # Always seed external vocabulary entries regardless of dump availability
    for ext_id, ext_data in EXTERNAL_VOCAB.items():
        conn.execute(VOCAB_INSERT_SQL, {
            "id": ext_id, "type": ext_data["type"],
            "label_en": ext_data["label_en"], "label_nl": ext_data["label_nl"],
            "external_id": ext_data["external_id"],
            "broader_id": None, "notation": None, "lat": None, "lon": None,
        })
    conn.commit()
    print(f"  Seeded {len(EXTERNAL_VOCAB)} external vocabulary entries (Getty AAT)")

    if not DUMPS_DIR.is_dir():
        print(f"  SKIP: Data dumps not found at {DUMPS_DIR}")
        print(f"  Download from: https://data.rijksmuseum.nl/object-metadata/download/")
        return

    total_records = 0

    for tar_name, default_type in DUMP_CONFIGS:
        print(f"  Processing {tar_name} dump (type={default_type})...")
        dump_dir = extract_dump(tar_name)
        if dump_dir is None:
            print(f"    SKIP: {tar_name}.tar.gz not found")
            continue

        records = parse_dump_dir(dump_dir, default_type)
        if not records:
            print(f"    No records parsed")
            continue

        conn.executemany(VOCAB_INSERT_SQL, records)
        conn.commit()

        with_notation = sum(1 for r in records if r.get("notation"))
        print(f"    {len(records):,} records ({with_notation:,} with notation)")
        total_records += len(records)

    print(f"  Total: {total_records:,} vocabulary records from dumps")


# ─── Phase 0.5: Seed Set Names ───────────────────────────────────────

def run_phase0_5(conn: sqlite3.Connection):
    """Seed vocabulary table with curated set names from OAI-PMH ListSets."""
    url = f"{OAI_BASE}?verb=ListSets"
    print("  Fetching ListSets from OAI-PMH...")
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as resp:
        root = ET.fromstring(resp.read())

    count = 0
    for set_el in root.findall(".//oai:set", NS):
        spec_el = set_el.find("oai:setSpec", NS)
        name_el = set_el.find("oai:setName", NS)
        if spec_el is None or name_el is None:
            continue
        set_spec = spec_el.text or ""
        set_name = name_el.text or ""
        if not set_spec or not set_name:
            continue
        conn.execute(VOCAB_INSERT_SQL, {
            "id": set_spec, "type": "set",
            "label_en": set_name, "label_nl": set_name,
            "external_id": None, "broader_id": None,
            "notation": None, "lat": None, "lon": None,
        })
        count += 1

    conn.commit()
    print(f"  Seeded {count} curated set names")


# ─── Phase 1: OAI-PMH Harvest ───────────────────────────────────────

def fetch_oai_page(url: str) -> ET.Element:
    """Fetch and parse an OAI-PMH XML page."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return ET.fromstring(resp.read())
        except Exception as e:
            if attempt < 2:
                wait = 5 * (attempt + 1)
                print(f"  Retry {attempt + 1}/3 after error: {e} (waiting {wait}s)", flush=True)
                time.sleep(wait)
            else:
                raise


def extract_resource_ref(elem) -> str | None:
    """Extract vocabulary ID from an element.

    Handles two RDF/XML serialization patterns:
      1. Flat attribute:  <el rdf:resource="https://id.rijksmuseum.nl/12345"/>
      2. Nested element:  <el><edm:Place rdf:about="https://id.rijksmuseum.nl/12345">...
    """
    # Pattern 1: flat rdf:resource attribute
    ref = elem.get(RDF_RESOURCE, "")
    if ref:
        return ref.split("/")[-1]
    # Pattern 2: nested child element with rdf:about
    for child in elem:
        ref = child.get(RDF_ABOUT, "")
        if ref:
            return ref.split("/")[-1]
    return None


def extract_records(root: ET.Element) -> list[dict]:
    """Extract artwork metadata and vocabulary mappings from OAI-PMH EDM records."""
    records = []

    for record in root.findall(".//oai:record", NS):
        header = record.find("oai:header", NS)
        if header is None:
            continue
        # Skip deleted records
        if header.get("status") == "deleted":
            continue

        # Extract setSpec values from header (collection set memberships)
        set_specs = [el.text for el in header.findall("oai:setSpec", NS) if el.text]

        metadata = record.find("oai:metadata", NS)
        if metadata is None:
            continue

        # Find ProvidedCHO — nested inside rdf:RDF > ore:Aggregation > edm:aggregatedCHO
        cho = metadata.find(".//{http://www.europeana.eu/schemas/edm/}ProvidedCHO")
        if cho is None:
            continue

        # Extract object number
        object_number = ""
        id_el = cho.find("{http://purl.org/dc/elements/1.1/}identifier")
        if id_el is not None and id_el.text:
            object_number = id_el.text.strip()

        if not object_number:
            continue

        # Extract title (prefer English)
        title = ""
        for t in cho.findall("{http://purl.org/dc/elements/1.1/}title"):
            if t.text:
                lang = t.get(XML_LANG, "")
                if lang == "en" or not title:
                    title = t.text.strip()[:500]

        # Collect all vocabulary mappings: (vocab_id, field)
        mappings: list[tuple[str, str]] = []

        # Extract vocabulary references from CHO element
        # (XML tag, mapping field name)
        for xml_tag, field in CHO_VOCAB_FIELDS:
            for el in cho.findall(xml_tag):
                vid = extract_resource_ref(el)
                if vid:
                    mappings.append((vid, field))

        # Extract creator label and agent metadata from edm:Agent elements
        # Agents are siblings of ore:Aggregation inside rdf:RDF
        creator_label = ""
        for agent in metadata.iter("{http://www.europeana.eu/schemas/edm/}Agent"):
            agent_about = agent.get(RDF_ABOUT, "")
            if not any(f == "creator" and agent_about.endswith(v) for v, f in mappings):
                continue

            # Extract agent's name
            for pref_label in agent.findall("{http://www.w3.org/2004/02/skos/core#}prefLabel"):
                if pref_label.text:
                    lang = pref_label.get(XML_LANG, "")
                    if lang == "en" or not creator_label:
                        creator_label = pref_label.text.strip()

            # Extract birth/death place (rdaGr2 namespace, not edm)
            for bp in agent.findall("{http://rdvocab.info/ElementsGr2/}placeOfBirth"):
                vid = extract_resource_ref(bp)
                if vid:
                    mappings.append((vid, "birth_place"))
            for dp in agent.findall("{http://rdvocab.info/ElementsGr2/}placeOfDeath"):
                vid = extract_resource_ref(dp)
                if vid:
                    mappings.append((vid, "death_place"))

            # Extract profession/occupation
            for prof in agent.findall("{http://rdvocab.info/ElementsGr2/}professionOrOccupation"):
                vid = extract_resource_ref(prof)
                if vid:
                    mappings.append((vid, "profession"))

        # Add collection set mappings from header setSpec values
        for spec in set_specs:
            mappings.append((spec, "collection_set"))

        # Extract rights URI from ore:Aggregation
        rights_uri = ""
        agg = metadata.find(".//{http://www.openarchives.org/ore/terms/}Aggregation")
        if agg is not None:
            rights_el = agg.find("{http://www.europeana.eu/schemas/edm/}rights")
            if rights_el is not None:
                rights_uri = rights_el.get(RDF_RESOURCE, "")

        records.append({
            "object_number": object_number,
            "title": title,
            "creator_label": creator_label,
            "rights_uri": rights_uri,
            "mappings": mappings,
        })

    return records


def save_checkpoint(token: str, page: int):
    """Save harvest progress to checkpoint file."""
    with open(CHECKPOINT_PATH, "w") as f:
        json.dump({"resumption_token": token, "page": page}, f)


def load_checkpoint() -> tuple[str, int] | None:
    """Load harvest progress from checkpoint file."""
    if not CHECKPOINT_PATH.exists():
        return None
    try:
        with open(CHECKPOINT_PATH) as f:
            data = json.load(f)
        return data["resumption_token"], data["page"]
    except Exception:
        return None


def run_phase1(conn: sqlite3.Connection, resume: bool = False):
    """Phase 1: Harvest all OAI-PMH records."""
    start_page = 0
    url = f"{OAI_BASE}?verb=ListRecords&metadataPrefix=edm"

    if resume:
        checkpoint = load_checkpoint()
        if checkpoint:
            token, start_page = checkpoint
            url = f"{OAI_BASE}?verb=ListRecords&resumptionToken={token}"
            print(f"  Resuming from page {start_page + 1} (token: {token[:40]}...)")
        else:
            print("  No checkpoint found, starting fresh")

    page = start_page
    total_artworks = 0
    total_mappings = 0
    t0 = time.time()

    while url:
        page += 1
        try:
            root = fetch_oai_page(url)
        except Exception as e:
            print(f"  FATAL error on page {page}: {e}")
            print(f"  Use --resume to continue from last checkpoint")
            break

        records = extract_records(root)

        for rec in records:
            conn.execute(
                "INSERT OR IGNORE INTO artworks (object_number, title, creator_label, rights_uri) VALUES (?, ?, ?, ?)",
                (rec["object_number"], rec["title"], rec["creator_label"], rec["rights_uri"]),
            )
            for vocab_id, field in rec["mappings"]:
                conn.execute(
                    "INSERT OR IGNORE INTO mappings (object_number, vocab_id, field) VALUES (?, ?, ?)",
                    (rec["object_number"], vocab_id, field),
                )
                total_mappings += 1

        total_artworks += len(records)

        # Check for resumption token
        token_el = root.find(".//oai:resumptionToken", NS)
        if token_el is not None and token_el.text:
            token = token_el.text
            url = f"{OAI_BASE}?verb=ListRecords&resumptionToken={token}"
            # Save checkpoint
            save_checkpoint(token, page)
        else:
            url = None

        if page % 10 == 0:
            elapsed = time.time() - t0
            rate = (page - start_page) / elapsed * 60 if elapsed > 0 else 0
            print(
                f"  Page {page}: {total_artworks:,} artworks, {total_mappings:,} mappings "
                f"({rate:.0f} pages/min)",
                flush=True,
            )

        if page % BATCH_SIZE == 0:
            conn.commit()

    conn.commit()
    elapsed = time.time() - t0
    print(f"  Harvest complete: {total_artworks:,} artworks, {total_mappings:,} mappings, {page} pages, {elapsed:.0f}s")

    # Clean up checkpoint on success
    if CHECKPOINT_PATH.exists() and url is None:
        CHECKPOINT_PATH.unlink()


# ─── Phase 2: Resolve unmatched URIs ─────────────────────────────────

def resolve_uri(entity_id: str) -> dict | None:
    """Resolve a Rijksmuseum entity URI via the Linked Art API."""
    url = f"{LINKED_ART_BASE}/{entity_id}"
    req = urllib.request.Request(url, headers={
        "Accept": "application/ld+json",
        "Profile": "https://linked.art/ns/v1/linked-art.json",
        "User-Agent": USER_AGENT,
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read())
    except Exception:
        return None

    la_type = data.get("type", "")
    vocab_type = LA_TYPE_MAP.get(la_type)
    if not vocab_type:
        return None

    label_en = None
    label_nl = None
    for name in data.get("identified_by", []):
        content = name.get("content", "")
        if not content:
            continue
        langs = name.get("language", [])
        lang_ids = [l.get("id", "") for l in langs] if langs else []
        if LANG_EN in lang_ids:
            label_en = label_en or content
        elif LANG_NL in lang_ids:
            label_nl = label_nl or content
        elif not label_en and not label_nl:
            label_en = content

    external_id = None
    for eq in data.get("equivalent", []):
        eq_id = eq.get("id", "")
        if "wikidata.org" in eq_id:
            external_id = eq_id
            break
        elif not external_id:
            external_id = eq_id

    notation = None
    lat = None
    lon = None
    if vocab_type == "place":
        defined_by = data.get("defined_by", "")
        if isinstance(defined_by, str) and defined_by.startswith("POINT"):
            notation = defined_by
            # Parse POINT(lon lat)
            m = re.match(r"POINT\(([-\d.]+)\s+([-\d.]+)\)", defined_by)
            if m:
                lon = float(m.group(1))
                lat = float(m.group(2))

    return {
        "id": entity_id,
        "type": vocab_type,
        "label_en": label_en,
        "label_nl": label_nl,
        "external_id": external_id,
        "broader_id": None,
        "notation": notation,
        "lat": lat,
        "lon": lon,
    }


def run_phase2(conn: sqlite3.Connection):
    """Phase 2: Resolve all unmapped vocabulary URIs."""
    cur = conn.cursor()

    unmatched = [row[0] for row in cur.execute("""
        SELECT DISTINCT m.vocab_id
        FROM mappings m
        LEFT JOIN vocabulary v ON m.vocab_id = v.id
        WHERE v.id IS NULL
    """).fetchall()]

    if not unmatched:
        print("  No unmatched vocabulary URIs to resolve.")
        return

    print(f"  Resolving {len(unmatched):,} unmatched vocabulary URIs ({RESOLVE_THREADS} threads)...")

    resolved = 0
    failed = 0
    t0 = time.time()

    with ThreadPoolExecutor(max_workers=RESOLVE_THREADS) as pool:
        futures = {pool.submit(resolve_uri, eid): eid for eid in unmatched}
        batch = []

        for i, future in enumerate(as_completed(futures), 1):
            result = future.result()
            if result:
                batch.append(result)
                resolved += 1
            else:
                failed += 1

            if len(batch) >= 200:
                conn.executemany(VOCAB_INSERT_SQL, batch)
                conn.commit()
                batch = []

            if i % 1000 == 0:
                elapsed = time.time() - t0
                rate = i / elapsed
                remaining = (len(unmatched) - i) / rate
                print(
                    f"  {i:,}/{len(unmatched):,} ({resolved:,} ok, {failed:,} failed, "
                    f"{rate:.0f}/s, ~{remaining:.0f}s left)",
                    flush=True,
                )

    if batch:
        conn.executemany(VOCAB_INSERT_SQL, batch)
        conn.commit()

    elapsed = time.time() - t0
    print(f"  Resolution complete: {resolved:,} resolved, {failed:,} failed, {elapsed:.0f}s")


# ─── Phase 3: Validation ─────────────────────────────────────────────

def run_phase3(conn: sqlite3.Connection):
    """Phase 3: Print validation stats."""
    cur = conn.cursor()

    print("\n" + "=" * 60)
    print("DATABASE STATISTICS")
    print("=" * 60)

    for table in ["vocabulary", "artworks", "mappings"]:
        count = cur.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        print(f"  {table}: {count:,} rows")

    print("\n--- Vocabulary by Type ---")
    rows = cur.execute("""
        SELECT v.type, COUNT(*) as vocab_cnt,
               COUNT(DISTINCT m.object_number) as artwork_cnt
        FROM vocabulary v
        LEFT JOIN mappings m ON m.vocab_id = v.id
        GROUP BY v.type
        ORDER BY artwork_cnt DESC
    """).fetchall()
    for vtype, vcnt, acnt in rows:
        print(f"  {vtype:20s} {vcnt:8,} terms    {acnt:8,} artworks linked")

    print("\n--- Mappings by Field ---")
    rows = cur.execute("""
        SELECT field, COUNT(*) as cnt, COUNT(DISTINCT object_number) as artworks
        FROM mappings
        GROUP BY field
        ORDER BY cnt DESC
    """).fetchall()
    for field, cnt, artworks in rows:
        print(f"  {field:20s} {cnt:10,} mappings    {artworks:8,} artworks")

    print("\n--- Vocabulary Coverage ---")
    total_vocab_ids = cur.execute("SELECT COUNT(DISTINCT vocab_id) FROM mappings").fetchone()[0]
    matched = cur.execute("""
        SELECT COUNT(DISTINCT m.vocab_id)
        FROM mappings m
        JOIN vocabulary v ON m.vocab_id = v.id
    """).fetchone()[0]
    print(f"  Distinct vocab IDs referenced: {total_vocab_ids:,}")
    print(f"  Matched to vocabulary table:   {matched:,}")
    print(f"  Still unmatched:               {total_vocab_ids - matched:,}")

    # ── Post-processing: vocab_term_counts, FTS5, collection_set/rights stats ──

    print("\n--- Post-processing ---")

    # Create vocab_term_counts table (reproducible, was previously ad-hoc)
    print("  Building vocab_term_counts...")
    conn.execute("DROP TABLE IF EXISTS vocab_term_counts")
    conn.execute("""
        CREATE TABLE vocab_term_counts AS
        SELECT vocab_id, COUNT(*) as cnt
        FROM mappings
        GROUP BY vocab_id
    """)
    conn.execute("CREATE INDEX idx_vtc_cnt ON vocab_term_counts(cnt DESC)")
    vtc_count = cur.execute("SELECT COUNT(*) FROM vocab_term_counts").fetchone()[0]
    print(f"    vocab_term_counts: {vtc_count:,} rows")
    conn.commit()

    # Create FTS5 virtual table for vocabulary label search
    print("  Building FTS5 index on vocabulary labels...")
    conn.execute("DROP TABLE IF EXISTS vocabulary_fts")
    conn.execute("""
        CREATE VIRTUAL TABLE vocabulary_fts USING fts5(
            label_en, label_nl,
            content='vocabulary', content_rowid='rowid',
            tokenize='unicode61 remove_diacritics 2'
        )
    """)
    conn.execute("INSERT INTO vocabulary_fts(vocabulary_fts) VALUES('rebuild')")
    fts_count = cur.execute("SELECT COUNT(*) FROM vocabulary_fts").fetchone()[0]
    print(f"    vocabulary_fts: {fts_count:,} rows")
    conn.commit()

    # Collection set stats
    set_mappings = cur.execute(
        "SELECT COUNT(*) FROM mappings WHERE field = 'collection_set'"
    ).fetchone()[0]
    distinct_sets = cur.execute(
        "SELECT COUNT(DISTINCT vocab_id) FROM mappings WHERE field = 'collection_set'"
    ).fetchone()[0]
    print(f"    collection_set mappings: {set_mappings:,} ({distinct_sets:,} distinct sets)")

    # Rights URI coverage
    rights_total = cur.execute(
        "SELECT COUNT(*) FROM artworks WHERE rights_uri IS NOT NULL AND rights_uri != ''"
    ).fetchone()[0]
    rights_distinct = cur.execute(
        "SELECT COUNT(DISTINCT rights_uri) FROM artworks WHERE rights_uri IS NOT NULL AND rights_uri != ''"
    ).fetchone()[0]
    print(f"    rights_uri coverage: {rights_total:,} artworks ({rights_distinct:,} distinct URIs)")

    # Show distinct rights URIs
    print("\n--- Rights URIs ---")
    rows = cur.execute("""
        SELECT rights_uri, COUNT(*) as cnt
        FROM artworks
        WHERE rights_uri IS NOT NULL AND rights_uri != ''
        GROUP BY rights_uri
        ORDER BY cnt DESC
    """).fetchall()
    for uri, cnt in rows:
        print(f"  {cnt:8,}  {uri}")

    print("\n--- Sample Queries ---")

    # Dogs (Iconclass 34B11)
    count = cur.execute("""
        SELECT COUNT(DISTINCT m.object_number)
        FROM mappings m
        JOIN vocabulary v ON m.vocab_id = v.id
        WHERE v.notation = '34B11'
    """).fetchone()[0]
    print(f"  Iconclass 34B11 (dog): {count:,} artworks")

    # Crucifixion
    count = cur.execute("""
        SELECT COUNT(DISTINCT m.object_number)
        FROM mappings m
        JOIN vocabulary v ON m.vocab_id = v.id
        WHERE v.label_en LIKE '%crucifixion%'
    """).fetchone()[0]
    print(f"  Subject 'crucifixion': {count:,} artworks")

    # Rembrandt as depicted person
    count = cur.execute("""
        SELECT COUNT(DISTINCT m.object_number)
        FROM mappings m
        JOIN vocabulary v ON m.vocab_id = v.id
        WHERE m.field = 'subject' AND v.type = 'person'
          AND v.label_en LIKE '%Rembrandt%'
    """).fetchone()[0]
    print(f"  Depicted person 'Rembrandt': {count:,} artworks")

    # Amsterdam
    count = cur.execute("""
        SELECT COUNT(DISTINCT m.object_number)
        FROM mappings m
        JOIN vocabulary v ON m.vocab_id = v.id
        WHERE v.type = 'place' AND v.label_en LIKE '%Amsterdam%'
    """).fetchone()[0]
    print(f"  Place 'Amsterdam': {count:,} artworks")

    print("\n--- Top 10 Subjects ---")
    rows = cur.execute("""
        SELECT v.notation, v.label_en, v.label_nl, COUNT(DISTINCT m.object_number) as cnt
        FROM mappings m
        JOIN vocabulary v ON m.vocab_id = v.id
        WHERE m.field = 'subject'
        GROUP BY m.vocab_id
        ORDER BY cnt DESC
        LIMIT 10
    """).fetchall()
    for notation, en, nl, cnt in rows:
        label = en or nl or "?"
        print(f"  {notation or '—':12s} {label:50s} {cnt:6,}")


# ─── Main ────────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(
        description="Build the Rijksmuseum vocabulary SQLite database."
    )
    parser.add_argument(
        "--resume", action="store_true",
        help="Resume OAI-PMH harvest from last checkpoint",
    )
    parser.add_argument(
        "--skip-dump", action="store_true",
        help="Skip Phase 0 (useful when no local data dumps are available)",
    )
    parser.add_argument(
        "--phase", type=int, default=0, dest="start_phase",
        help="Run only from phase N onward (default: 0)",
    )
    return parser.parse_args()


def main():
    args = parse_args()

    print(f"Database: {DB_PATH}")
    print(f"Options: resume={args.resume}, skip_dump={args.skip_dump}, start_phase={args.start_phase}")
    print()

    conn = create_or_open_db()

    if args.start_phase <= 0 and not args.skip_dump:
        print("=== Phase 0: Parsing data dumps ===")
        t0 = time.time()
        run_phase0(conn)
        print(f"  Phase 0 took {time.time() - t0:.1f}s")
        print()

    if args.start_phase <= 0:
        print("=== Phase 0.5: Seeding curated set names ===")
        t0 = time.time()
        run_phase0_5(conn)
        print(f"  Phase 0.5 took {time.time() - t0:.1f}s")
        print()

    if args.start_phase <= 1:
        print("=== Phase 1: Harvesting ALL OAI-PMH records ===")
        t0 = time.time()
        run_phase1(conn, resume=args.resume)
        print(f"  Phase 1 took {time.time() - t0:.1f}s")
        print()

    if args.start_phase <= 2:
        print("=== Phase 2: Resolving unmatched vocabulary URIs ===")
        t0 = time.time()
        run_phase2(conn)
        print(f"  Phase 2 took {time.time() - t0:.1f}s")
        print()

    print("=== Phase 3: Validation ===")
    run_phase3(conn)

    conn.close()
    print(f"\nDone. Database at: {DB_PATH}")
    db_size = DB_PATH.stat().st_size / (1024 * 1024)
    print(f"Database size: {db_size:.1f} MB")


if __name__ == "__main__":
    main()
