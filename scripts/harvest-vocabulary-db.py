#!/usr/bin/env python3
"""
Full-scale vocabulary database builder for Rijksmuseum MCP+.

Builds a SQLite database mapping vocabulary terms (Iconclass subjects, depicted
persons/places, materials, techniques, types, creators) to artworks, enabling
vocabulary-based search in the MCP server.

Phases:
  0.  Parse ALL data dumps (classification, person, place, concept, event, topical_term, organisation)
  0.5 Seed curated set names from OAI-PMH ListSets
  1.  Harvest ALL OAI-PMH records (836K+), extract 9 vocabulary fields + Linked Art URIs
  2.  Resolve unmatched vocabulary URIs via Linked Art API (multi-threaded)
  4.  Resolve all artwork Linked Art URIs for Tier 2 fields: inscriptions, provenance,
      credit lines, dimensions, production roles, attribution qualifiers (multi-threaded)
  2b. Re-resolve vocabulary URIs introduced by Phase 4 (production roles, attribution qualifiers)
  3.  Post-processing: geocoding import, normalized labels, FTS5 indexes, validation stats (runs last)

Usage:
    python3 scripts/harvest-vocabulary-db.py                # Full run (all phases)
    python3 scripts/harvest-vocabulary-db.py --resume       # Resume from checkpoint
    python3 scripts/harvest-vocabulary-db.py --skip-dump    # Skip Phase 0 (no local dump)
    python3 scripts/harvest-vocabulary-db.py --phase 3      # Run only from phase N onward
    python3 scripts/harvest-vocabulary-db.py --phase 4      # Run Phase 4 + 3 only
    python3 scripts/harvest-vocabulary-db.py --threads 16   # Phase 4 thread count
    python3 scripts/harvest-vocabulary-db.py --phase 3 --geo-csv offline/geo/geocoded_places_full.csv

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
DEFAULT_THREADS = 8
BATCH_SIZE = 500  # Commit every N pages

# ─── AAT URIs for Tier 2 Linked Art parsing ─────────────────────────

AAT_INSCRIPTIONS = "http://vocab.getty.edu/aat/300435414"
AAT_PROVENANCE = "http://vocab.getty.edu/aat/300444174"
AAT_CREDIT_LINE = "http://vocab.getty.edu/aat/300026687"
AAT_UNIT_CM = "http://vocab.getty.edu/aat/300379098"
AAT_UNIT_MM = "http://vocab.getty.edu/aat/300379097"
AAT_UNIT_M = "http://vocab.getty.edu/aat/300379100"
AAT_HEIGHT = "http://vocab.getty.edu/aat/300055644"
AAT_WIDTH = "http://vocab.getty.edu/aat/300055647"
RM_HEIGHT = "https://id.rijksmuseum.nl/22011"
RM_WIDTH = "https://id.rijksmuseum.nl/22012"
HEIGHT_URIS = {AAT_HEIGHT, RM_HEIGHT}
WIDTH_URIS = {AAT_WIDTH, RM_WIDTH}
AAT_NARRATIVE = "http://vocab.getty.edu/aat/300048722"
AAT_DESCRIPTION = "http://vocab.getty.edu/aat/300435452"

# ─── N-Triples parsing (same as pilot) ──────────────────────────────

NT_PATTERN = re.compile(
    r'^<([^>]+)>\s+<([^>]+)>\s+(?:<([^>]+)>|"([^"]*)")\s*\.\s*$'
)
BNODE_PATTERN = re.compile(
    r'^_:(\S+)\s+<([^>]+)>\s+(?:<([^>]+)>|"([^"]*)")\s*\.\s*$'
)
NT_LANG_PATTERN = re.compile(
    r'^<([^>]+)>\s+<([^>]+)>\s+"([^"]*)"@(\w+)\s*\.\s*$'
)

P_LABEL = "http://www.cidoc-crm.org/cidoc-crm/P190_has_symbolic_content"
P_LANGUAGE = "http://www.cidoc-crm.org/cidoc-crm/P72_has_language"
P_EQUIVALENT = "https://linked.art/ns/terms/equivalent"
SKOS_PREFLABEL = "http://www.w3.org/2004/02/skos/core#prefLabel"
RDFS_LABEL = "http://www.w3.org/2000/01/rdf-schema#label"
P_BROADER = "http://www.w3.org/2004/02/skos/core#broader"
P_HAS_TYPE = "http://www.cidoc-crm.org/cidoc-crm/P2_has_type"
LANG_EN = "http://vocab.getty.edu/aat/300388277"
LANG_NL = "http://vocab.getty.edu/aat/300388256"
AAT_DISPLAY_NAME = "http://vocab.getty.edu/aat/300404670"
AAT_PREFERRED_NAME = "http://vocab.getty.edu/aat/300404671"
AAT_INVERTED_NAME = "http://vocab.getty.edu/aat/300404672"

# AAT name classification URI suffix → label (for person_names table)
AAT_NAME_CLASSIFICATION = {
    "300404670": "display",
    "300404671": "preferred",
    "300404672": "inverted",
}

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
    "300404450": {"type": "classification", "label_en": "primary", "label_nl": "primair", "external_id": "http://vocab.getty.edu/aat/300404450"},
    "300404451": {"type": "classification", "label_en": "secondary", "label_nl": "secundair", "external_id": "http://vocab.getty.edu/aat/300404451"},
    "300379012": {"type": "classification", "label_en": "undetermined", "label_nl": "onbepaald", "external_id": "http://vocab.getty.edu/aat/300379012"},
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
    lat             REAL,
    lon             REAL,
    label_en_norm   TEXT,
    label_nl_norm   TEXT
);

CREATE TABLE IF NOT EXISTS artworks (
    object_number    TEXT PRIMARY KEY,
    title            TEXT,
    creator_label    TEXT,
    rights_uri       TEXT,
    linked_art_uri   TEXT,
    inscription_text TEXT,
    provenance_text  TEXT,
    credit_line      TEXT,
    description_text TEXT,
    height_cm        REAL,
    width_cm         REAL,
    narrative_text   TEXT,
    date_earliest    INTEGER,
    date_latest      INTEGER,
    title_all_text   TEXT,
    tier2_done       INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS mappings (
    object_number  TEXT NOT NULL,
    vocab_id       TEXT NOT NULL,
    field          TEXT NOT NULL,
    PRIMARY KEY (object_number, vocab_id, field)
);

CREATE INDEX IF NOT EXISTS idx_vocab_label_en ON vocabulary(label_en COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_vocab_label_nl ON vocabulary(label_nl COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_vocab_notation ON vocabulary(notation);
CREATE INDEX IF NOT EXISTS idx_vocab_type ON vocabulary(type);
CREATE INDEX IF NOT EXISTS idx_artworks_tier2 ON artworks(tier2_done);

CREATE TABLE IF NOT EXISTS person_names (
    person_id       TEXT NOT NULL REFERENCES vocabulary(id),
    name            TEXT NOT NULL,
    lang            TEXT,
    classification  TEXT,
    UNIQUE(person_id, name, lang)
);
CREATE INDEX IF NOT EXISTS idx_person_names_id ON person_names(person_id);
"""

VOCAB_INSERT_SQL = (
    "INSERT OR IGNORE INTO vocabulary "
    "(id, type, label_en, label_nl, external_id, broader_id, notation, lat, lon) "
    "VALUES (:id, :type, :label_en, :label_nl, :external_id, :broader_id, :notation, :lat, :lon)"
)


def get_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    """Return the set of column names for a given table."""
    return {row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}


def create_or_open_db() -> sqlite3.Connection:
    """Create or open the SQLite database, migrating schema if needed."""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA cache_size=-64000")  # 64 MB cache
    conn.executescript(SCHEMA_SQL)

    # Create mappings indexes appropriate for the current schema.
    # Integer-encoded DBs (post-normalize_mappings) have field_id/artwork_id/vocab_rowid;
    # text DBs (fresh harvest, pre-Phase 3) have field/object_number/vocab_id.
    mapping_cols = get_columns(conn, "mappings")
    if "field_id" in mapping_cols:
        # Integer-encoded schema — indexes are created by normalize_mappings() in Phase 3.
        # Create them here too for idempotency (IF NOT EXISTS avoids duplicates).
        conn.execute("CREATE INDEX IF NOT EXISTS idx_mappings_field_vocab   ON mappings(field_id, vocab_rowid)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_mappings_field_artwork ON mappings(field_id, artwork_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_mappings_vocab         ON mappings(vocab_rowid)")
        # Drop stub index left over from v0.15 harvest workaround (duplicate of idx_mappings_field_artwork)
        conn.execute("DROP INDEX IF EXISTS idx_mappings_field_object")
    else:
        # Text schema — original indexes for Phase 1/2/4 queries
        conn.execute("CREATE INDEX IF NOT EXISTS idx_mappings_field_vocab  ON mappings(field, vocab_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_mappings_field_object ON mappings(field, object_number)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_mappings_vocab        ON mappings(vocab_id)")

    # Migrate existing DBs: add normalized label columns if missing
    vocab_cols = get_columns(conn, "vocabulary")
    for col_name, col_type in [("label_en_norm", "TEXT"), ("label_nl_norm", "TEXT")]:
        if col_name not in vocab_cols:
            conn.execute(f"ALTER TABLE vocabulary ADD COLUMN {col_name} {col_type}")
            print(f"  Migrated: added vocabulary.{col_name}")

    # Migrate existing DBs: add Tier 2 columns if missing
    existing_cols = get_columns(conn, "artworks")
    tier2_cols = [
        ("linked_art_uri", "TEXT"),
        ("inscription_text", "TEXT"),
        ("provenance_text", "TEXT"),
        ("credit_line", "TEXT"),
        ("description_text", "TEXT"),
        ("height_cm", "REAL"),
        ("width_cm", "REAL"),
        ("narrative_text", "TEXT"),
        ("date_earliest", "INTEGER"),
        ("date_latest", "INTEGER"),
        ("title_all_text", "TEXT"),
        ("tier2_done", "INTEGER DEFAULT 0"),
    ]
    for col_name, col_type in tier2_cols:
        if col_name not in existing_cols:
            conn.execute(f"ALTER TABLE artworks ADD COLUMN {col_name} {col_type}")
            print(f"  Migrated: added artworks.{col_name}")
    conn.commit()

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
    skos_label_en: str | None = None
    skos_label_nl: str | None = None

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

        # Match language-tagged literals (skos:prefLabel, rdfs:label)
        m = NT_LANG_PATTERN.match(line)
        if m and m.group(1) == entity_uri:
            pred = m.group(2)
            text = m.group(3)
            lang_tag = m.group(4)
            if pred in (SKOS_PREFLABEL, RDFS_LABEL) and text:
                if lang_tag == "en" and not skos_label_en:
                    skos_label_en = text
                elif lang_tag == "nl" and not skos_label_nl:
                    skos_label_nl = text

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

    # Fallback: use skos/rdfs labels if display-name labels weren't found
    if not label_en:
        label_en = skos_label_en
    if not label_nl:
        label_nl = skos_label_nl

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
        tf.extractall(extract_dir, filter="data")
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

        # Extract Linked Art URI from CHO's rdf:about (for Phase 4 resolution)
        lod_uri = cho.get(RDF_ABOUT, "")

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
            "linked_art_uri": lod_uri,
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
                "INSERT OR IGNORE INTO artworks (object_number, title, creator_label, rights_uri, linked_art_uri) VALUES (?, ?, ?, ?, ?)",
                (rec["object_number"], rec["title"], rec["creator_label"], rec["rights_uri"], rec["linked_art_uri"]),
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
    name_variants = []  # All name variants for persons
    seen_names = set()  # Deduplicate (content, lang) pairs
    for name in data.get("identified_by", []):
        content = name.get("content", "")
        if not content or not isinstance(content, str):
            continue
        langs = name.get("language", [])
        lang_ids = [l.get("id", "") for l in langs] if langs else []
        if LANG_EN in lang_ids:
            label_en = label_en or content
        elif LANG_NL in lang_ids:
            label_nl = label_nl or content
        elif not label_en and not label_nl:
            label_en = content

        # Collect all name variants for persons (only Name entries, not Identifiers)
        if vocab_type == "person" and name.get("type") == "Name":
            lang = None
            if LANG_EN in lang_ids:
                lang = "en"
            elif LANG_NL in lang_ids:
                lang = "nl"

            classification = None
            for c in name.get("classified_as", []):
                cid = c.get("id", "")
                for suffix, clabel in AAT_NAME_CLASSIFICATION.items():
                    if cid.endswith(suffix):
                        classification = clabel
                        break
                if classification:
                    break

            key = (content, lang)
            if key not in seen_names:
                seen_names.add(key)
                name_variants.append({
                    "person_id": entity_id,
                    "name": content,
                    "lang": lang,
                    "classification": classification,
                })

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
        "name_variants": name_variants,
    }


def run_phase2(conn: sqlite3.Connection):
    """Phase 2: Resolve all unmapped vocabulary URIs."""
    cur = conn.cursor()

    # Integer-encoded DBs have vocab_rowid (always a valid FK) — nothing to resolve
    if "vocab_rowid" in get_columns(conn, "mappings"):
        print("  Integer-encoded schema: all vocab references are valid FKs, nothing to resolve.")
        unmatched = []
    else:
        unmatched = [row[0] for row in cur.execute("""
            SELECT DISTINCT m.vocab_id
            FROM mappings m
            LEFT JOIN vocabulary v ON m.vocab_id = v.id
            WHERE v.id IS NULL
        """).fetchall()]

    if not unmatched:
        print("  No unmatched vocabulary URIs to resolve.")
        return

    print(f"  Resolving {len(unmatched):,} unmatched vocabulary URIs ({DEFAULT_THREADS} threads)...")

    PERSON_NAMES_INSERT = (
        "INSERT OR IGNORE INTO person_names (person_id, name, lang, classification) "
        "VALUES (:person_id, :name, :lang, :classification)"
    )

    resolved = 0
    failed = 0
    person_names_count = 0
    t0 = time.time()

    with ThreadPoolExecutor(max_workers=DEFAULT_THREADS) as pool:
        futures = {pool.submit(resolve_uri, eid): eid for eid in unmatched}
        batch = []
        name_batch = []

        for i, future in enumerate(as_completed(futures), 1):
            result = future.result()
            if result:
                batch.append(result)
                # Collect person name variants
                variants = result.get("name_variants", [])
                if variants:
                    name_batch.extend(variants)
                    person_names_count += len(variants)
                resolved += 1
            else:
                failed += 1

            if len(batch) >= 200:
                conn.executemany(VOCAB_INSERT_SQL, batch)
                if name_batch:
                    conn.executemany(PERSON_NAMES_INSERT, name_batch)
                    name_batch = []
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
    if name_batch:
        conn.executemany(PERSON_NAMES_INSERT, name_batch)
    conn.commit()

    elapsed = time.time() - t0
    print(f"  Resolution complete: {resolved:,} resolved, {failed:,} failed, {elapsed:.0f}s")
    if person_names_count:
        print(f"  Person name variants collected: {person_names_count:,}")


# ─── Phase 4: Linked Art Resolution (Tier 2) ─────────────────────────

def has_classification(classified_as: list | None, uris: str | set[str]) -> bool:
    """Check if a classified_as array contains any of the given URIs."""
    if not classified_as:
        return False
    if isinstance(uris, str):
        uris = {uris}
    return any(
        (c.get("id", "") if isinstance(c, dict) else str(c)) in uris
        for c in classified_as
    )


def find_statements(referred_to_by: list | None, aat_uri: str) -> list[str]:
    """Find all referred_to_by statements matching a given AAT classification.

    Returns all matching texts concatenated with ' | ' delimiter.
    Collects ALL languages — inscriptions are often in Latin/Dutch/mixed.
    """
    if not referred_to_by:
        return []
    texts = []
    for stmt in referred_to_by:
        if not isinstance(stmt, dict):
            continue
        if has_classification(stmt.get("classified_as"), aat_uri):
            content = stmt.get("content", "")
            if isinstance(content, list):
                texts.extend(s for s in content if isinstance(s, str))
            elif content:
                texts.append(content)
    return texts


# Conversion factors from unit to centimeters
UNIT_TO_CM = {
    AAT_UNIT_CM: 1.0,
    AAT_UNIT_MM: 0.1,
    AAT_UNIT_M: 100.0,
}


def extract_dimension_cm(dimensions: list | None, type_uris: set[str]) -> float | None:
    """Extract a dimension value in centimeters for a given dimension type (height/width)."""
    if not dimensions:
        return None
    for dim in dimensions:
        if not isinstance(dim, dict):
            continue
        value = dim.get("value")
        if value is None:
            continue
        if not has_classification(dim.get("classified_as", []), type_uris):
            continue
        unit = dim.get("unit", {})
        unit_id = unit.get("id", "") if isinstance(unit, dict) else ""
        try:
            val = float(value)
        except (ValueError, TypeError):
            continue
        factor = UNIT_TO_CM.get(unit_id, 1.0)  # default to cm
        return round(val * factor, 2) if factor != 1.0 else val
    return None


def extract_production_parts(data: dict) -> tuple[list[tuple[str, str]], list[tuple[str, str]]]:
    """Extract production roles and attribution qualifiers from produced_by.

    Returns:
        (roles, qualifiers) where each is a list of (vocab_id, field) tuples.

    Production structure in Linked Art:
        produced_by: {
            part: [
                {
                    carried_out_by: [{ id: "https://id.rijksmuseum.nl/31xxx" }],
                    technique: [{ id: "https://id.rijksmuseum.nl/12xxx" }],  # role (painter, printmaker)
                    classified_as: [{ id: "..." }],  # qualifier (attributed to, workshop of)
                }
            ]
        }
    """
    roles: list[tuple[str, str]] = []
    qualifiers: list[tuple[str, str]] = []

    produced_by = data.get("produced_by")
    if not isinstance(produced_by, dict):
        return roles, qualifiers

    parts = produced_by.get("part", [])
    if not isinstance(parts, list):
        # Single production event without parts — check top level
        parts = [produced_by]

    for part in parts:
        if not isinstance(part, dict):
            continue
        # Extract technique (production role: painter, printmaker, etc.)
        for tech in part.get("technique", []):
            if isinstance(tech, dict):
                tid = tech.get("id", "")
                if tid:
                    vid = tid.split("/")[-1]
                    roles.append((vid, "production_role"))
        # Extract classified_as (attribution qualifier: attributed to, workshop of, etc.)
        for cls in part.get("classified_as", []):
            if isinstance(cls, dict):
                cid = cls.get("id", "")
                if cid:
                    vid = cid.split("/")[-1]
                    qualifiers.append((vid, "attribution_qualifier"))

    return roles, qualifiers


def extract_narrative(data: dict) -> str | None:
    """Extract curatorial narrative text from Linked Art subject_of.

    Walks subject_of[] entries looking for part[] children classified as
    AAT 300048722 (essay). Prefers EN, falls back to NL, then any language.
    """
    subject_of = data.get("subject_of")
    if not isinstance(subject_of, list):
        return None

    narratives: dict[str, str] = {}  # keyed by lang URI

    for entry in subject_of:
        if not isinstance(entry, dict):
            continue
        # Determine language of this entry
        lang_uri = None
        for lang in entry.get("language", []):
            lid = lang.get("id", "") if isinstance(lang, dict) else ""
            if lid in (LANG_NL, LANG_EN):
                lang_uri = lid
                break
            if lid and not lang_uri:
                lang_uri = lid

        # Walk parts looking for narrative classification
        for part in entry.get("part", []):
            if not isinstance(part, dict):
                continue
            if has_classification(part.get("classified_as"), AAT_NARRATIVE):
                content = part.get("content", "")
                if content and lang_uri and lang_uri not in narratives:
                    narratives[lang_uri] = content

    # Prefer EN → NL → first available (matches project convention)
    if LANG_EN in narratives:
        return narratives[LANG_EN]
    if LANG_NL in narratives:
        return narratives[LANG_NL]
    if narratives:
        return next(iter(narratives.values()))
    return None


def resolve_artwork(uri: str) -> dict | None:
    """Resolve a single artwork's Linked Art JSON-LD and extract Tier 2 fields."""
    req = urllib.request.Request(uri, headers={
        "Accept": "application/ld+json",
        "Profile": "https://linked.art/ns/v1/linked-art.json",
        "User-Agent": USER_AGENT,
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return {"_status": "not_found"}
        # Log non-404 HTTP errors for diagnostics (500s, 503s, rate limits)
        print(f"    HTTP {e.code} for {uri}", flush=True)
        return None
    except Exception as e:
        print(f"    Error for {uri}: {e}", flush=True)
        return None

    referred_to_by = data.get("referred_to_by", [])

    # Extract text fields by AAT classification
    def join_statements(aat_uri: str) -> str | None:
        texts = find_statements(referred_to_by, aat_uri)
        return " | ".join(texts) if texts else None

    inscription_text = join_statements(AAT_INSCRIPTIONS)
    provenance_text = join_statements(AAT_PROVENANCE)
    credit_line = join_statements(AAT_CREDIT_LINE)
    description_text = join_statements(AAT_DESCRIPTION)

    # Structured dimensions
    dimensions = data.get("dimension", [])
    height_cm = extract_dimension_cm(dimensions, HEIGHT_URIS)
    width_cm = extract_dimension_cm(dimensions, WIDTH_URIS)

    # Production roles and attribution qualifiers
    roles, qualifiers = extract_production_parts(data)

    # Curatorial narrative (museum wall text)
    narrative_text = extract_narrative(data)

    # Date extraction from produced_by.timespan
    date_earliest = None
    date_latest = None
    produced_by = data.get("produced_by", {})
    timespan = produced_by.get("timespan", {}) if isinstance(produced_by, dict) else {}
    if isinstance(timespan, dict):
        for key, target in [("begin_of_the_begin", "earliest"), ("end_of_the_end", "latest")]:
            val = timespan.get(key, "")
            if val and isinstance(val, str) and len(val) >= 4:
                try:
                    # Handle negative years (BCE) and standard ISO dates
                    year_str = val[:5] if val.startswith("-") else val[:4]
                    year = int(year_str)
                    if target == "earliest":
                        date_earliest = year
                    else:
                        date_latest = year
                except (ValueError, IndexError):
                    pass
    # If only one is present, use it for both (single-year works)
    if date_earliest is not None and date_latest is None:
        date_latest = date_earliest
    elif date_latest is not None and date_earliest is None:
        date_earliest = date_latest

    # Title extraction: all Name entries from identified_by
    title_parts = []
    for entry in data.get("identified_by", []):
        if isinstance(entry, dict) and entry.get("type") == "Name":
            content = entry.get("content", "")
            if isinstance(content, list):
                title_parts.extend(s for s in content if isinstance(s, str))
            elif content:
                title_parts.append(content)
    title_all_text = "\n".join(title_parts) if title_parts else None

    return {
        "inscription_text": inscription_text,
        "provenance_text": provenance_text,
        "credit_line": credit_line,
        "description_text": description_text,
        "height_cm": height_cm,
        "width_cm": width_cm,
        "narrative_text": narrative_text,
        "date_earliest": date_earliest,
        "date_latest": date_latest,
        "title_all_text": title_all_text,
        "roles": roles,
        "qualifiers": qualifiers,
    }


def run_phase4(conn: sqlite3.Connection, threads: int = DEFAULT_THREADS):
    """Phase 4: Resolve all artwork Linked Art URIs for Tier 2 fields."""
    cur = conn.cursor()

    # Get all artworks that haven't been processed yet
    pending = cur.execute("""
        SELECT object_number, linked_art_uri
        FROM artworks
        WHERE tier2_done = 0 AND linked_art_uri IS NOT NULL AND linked_art_uri != ''
    """).fetchall()

    if not pending:
        print("  No artworks pending Tier 2 resolution.")
        return

    total = len(pending)
    print(f"  Resolving {total:,} artworks for Tier 2 fields ({threads} threads)...")

    # Detect schema for mappings inserts (production roles + attribution qualifiers)
    int_mappings = "field_id" in get_columns(conn, "mappings")
    if int_mappings:
        MAPPING_INSERT_SQL = """
            INSERT OR IGNORE INTO mappings (artwork_id, vocab_rowid, field_id)
            SELECT a.art_id, v.vocab_int_id, f.id
            FROM artworks a, vocabulary v, field_lookup f
            WHERE a.object_number = ? AND v.id = ? AND f.name = ?
        """
    else:
        MAPPING_INSERT_SQL = (
            "INSERT OR IGNORE INTO mappings (object_number, vocab_id, field) VALUES (?, ?, ?)"
        )

    processed = 0
    succeeded = 0
    failed = 0
    not_found = 0
    with_inscription = 0
    with_provenance = 0
    with_credit = 0
    with_description = 0
    with_dimensions = 0
    with_narrative = 0
    with_dates = 0
    with_titles = 0
    role_count = 0
    qualifier_count = 0
    t0 = time.time()

    TIER2_UPDATE_SQL = """
        UPDATE artworks SET
            inscription_text = ?,
            provenance_text = ?,
            credit_line = ?,
            description_text = ?,
            height_cm = ?,
            width_cm = ?,
            narrative_text = ?,
            date_earliest = ?,
            date_latest = ?,
            title_all_text = ?,
            tier2_done = 1
        WHERE object_number = ?
    """

    with ThreadPoolExecutor(max_workers=threads) as pool:
        # Submit in batches to avoid excessive memory for futures dict
        batch_start = 0
        commit_batch_size = 500

        while batch_start < total:
            batch_end = min(batch_start + commit_batch_size, total)
            batch = pending[batch_start:batch_end]

            futures = {
                pool.submit(resolve_artwork, uri): (obj_num, uri)
                for obj_num, uri in batch
            }

            for future in as_completed(futures):
                obj_num, uri = futures[future]
                processed += 1

                try:
                    result = future.result()
                except Exception:
                    result = None

                if result is None:
                    failed += 1
                    # Don't mark tier2_done — leave for retry
                    continue

                if result.get("_status") == "not_found":
                    not_found += 1
                    # Mark as done so we don't retry 404s
                    conn.execute("UPDATE artworks SET tier2_done = 1 WHERE object_number = ?", (obj_num,))
                    continue

                succeeded += 1
                if result["inscription_text"]:
                    with_inscription += 1
                if result["provenance_text"]:
                    with_provenance += 1
                if result["credit_line"]:
                    with_credit += 1
                if result["description_text"]:
                    with_description += 1
                if result["height_cm"] is not None or result["width_cm"] is not None:
                    with_dimensions += 1
                if result["narrative_text"]:
                    with_narrative += 1
                if result["date_earliest"] is not None:
                    with_dates += 1
                if result["title_all_text"]:
                    with_titles += 1

                conn.execute(TIER2_UPDATE_SQL, (
                    result["inscription_text"],
                    result["provenance_text"],
                    result["credit_line"],
                    result["description_text"],
                    result["height_cm"],
                    result["width_cm"],
                    result["narrative_text"],
                    result["date_earliest"],
                    result["date_latest"],
                    result["title_all_text"],
                    obj_num,
                ))

                # Insert production role and attribution qualifier mappings
                for vocab_id, field in result["roles"] + result["qualifiers"]:
                    conn.execute(MAPPING_INSERT_SQL, (obj_num, vocab_id, field))
                role_count += len(result["roles"])
                qualifier_count += len(result["qualifiers"])

            conn.commit()
            batch_start = batch_end

            elapsed = time.time() - t0
            rate = processed / elapsed if elapsed > 0 else 0
            remaining = (total - processed) / rate if rate > 0 else 0
            print(
                f"  {processed:,}/{total:,} ({succeeded:,} ok, {failed:,} failed, {not_found:,} 404, "
                f"{rate:.0f}/s, ~{remaining / 60:.0f}min left)",
                flush=True,
            )

    elapsed = time.time() - t0
    print(f"\n  Phase 4 complete in {elapsed / 60:.1f}min:")
    print(f"    Succeeded:    {succeeded:,}")
    print(f"    Failed:       {failed:,} (will retry on --resume --phase 4)")
    print(f"    Not found:    {not_found:,}")
    print(f"    Inscriptions: {with_inscription:,}")
    print(f"    Provenance:   {with_provenance:,}")
    print(f"    Credit lines: {with_credit:,}")
    print(f"    Descriptions: {with_description:,}")
    print(f"    Dimensions:   {with_dimensions:,}")
    print(f"    Narratives:   {with_narrative:,}")
    print(f"    Dates:        {with_dates:,}")
    print(f"    All titles:   {with_titles:,}")
    print(f"    Prod. roles:  {role_count:,}")
    print(f"    Attr. quals:  {qualifier_count:,}")


# ─── Geocoding Import ────────────────────────────────────────────────

def import_geocoding(conn: sqlite3.Connection, csv_path: str):
    """Import geocoded place data from CSV into the vocabulary table.

    Updates lat, lon, and (optionally) external_id for existing place records.
    Only updates external_id if the CSV has a non-empty value that differs from the DB.
    """
    import csv

    csv_file = Path(csv_path)
    if not csv_file.exists():
        print(f"  ERROR: Geocoding CSV not found: {csv_path}")
        return

    print(f"  Reading: {csv_path}")
    updated_coords = 0
    updated_ext_id = 0
    skipped_missing = 0
    skipped_not_place = 0

    with open(csv_file, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        batch = []

        for row in reader:
            vocab_id = row.get("id", "").strip()
            lat_str = row.get("lat", "").strip()
            lon_str = row.get("lon", "").strip()
            ext_id = row.get("external_id", "").strip()

            if not vocab_id or not lat_str or not lon_str:
                continue

            try:
                lat = float(lat_str)
                lon = float(lon_str)
            except ValueError:
                continue

            batch.append((vocab_id, lat, lon, ext_id))

        print(f"  Parsed {len(batch):,} geocoded places from CSV")

    for vocab_id, lat, lon, ext_id in batch:
        existing = conn.execute(
            "SELECT type, external_id FROM vocabulary WHERE id = ?",
            (vocab_id,),
        ).fetchone()

        if existing is None:
            skipped_missing += 1
            continue

        if existing[0] != "place":
            skipped_not_place += 1
            continue

        # Update coords, and external_id if the CSV provides a different one
        should_update_ext = ext_id and ext_id != existing[1]
        if should_update_ext:
            conn.execute(
                "UPDATE vocabulary SET lat = ?, lon = ?, external_id = ? WHERE id = ?",
                (lat, lon, ext_id, vocab_id),
            )
            updated_ext_id += 1
        else:
            conn.execute(
                "UPDATE vocabulary SET lat = ?, lon = ? WHERE id = ?",
                (lat, lon, vocab_id),
            )
        updated_coords += 1

    conn.commit()
    print(f"  Geocoding import complete:")
    print(f"    Coordinates updated: {updated_coords:,}")
    print(f"    External IDs updated: {updated_ext_id:,}")
    if skipped_missing:
        print(f"    Skipped (not in DB): {skipped_missing:,}")
    if skipped_not_place:
        print(f"    Skipped (not a place): {skipped_not_place:,}")


# ─── Normalization (integer-encoding) ─────────────────────────────────

def normalize_mappings(conn: sqlite3.Connection):
    """Integer-encode the mappings table for ~1.2 GB space savings.

    Replaces TEXT columns (object_number, vocab_id, field) with INTEGER FKs
    (artwork_id, vocab_rowid, field_id) in a WITHOUT ROWID clustered B-tree.
    Idempotent: skips if already normalized.
    """
    # Guard: skip if already normalized
    if "artwork_id" in get_columns(conn, "mappings"):
        print("  Mappings already integer-encoded, skipping.")
        return

    t0 = time.time()
    cur = conn.cursor()

    # Step 1: Add stable integer IDs to parent tables (survive VACUUM)
    print("  Adding stable integer IDs to artworks and vocabulary...")
    if "art_id" not in get_columns(conn, "artworks"):
        conn.execute("ALTER TABLE artworks ADD COLUMN art_id INTEGER")
        conn.execute("UPDATE artworks SET art_id = rowid")
        conn.execute("CREATE UNIQUE INDEX idx_artworks_art_id ON artworks(art_id)")

    if "vocab_int_id" not in get_columns(conn, "vocabulary"):
        conn.execute("ALTER TABLE vocabulary ADD COLUMN vocab_int_id INTEGER")
        conn.execute("UPDATE vocabulary SET vocab_int_id = rowid")
        conn.execute("CREATE UNIQUE INDEX idx_vocab_int_id ON vocabulary(vocab_int_id)")
    conn.commit()

    # Step 2: Create field_lookup table
    print("  Creating field_lookup table...")
    conn.execute("DROP TABLE IF EXISTS field_lookup")
    conn.execute("CREATE TABLE field_lookup (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE)")
    conn.execute("INSERT INTO field_lookup (name) SELECT DISTINCT field FROM mappings ORDER BY field")
    field_count = cur.execute("SELECT COUNT(*) FROM field_lookup").fetchone()[0]
    print(f"    {field_count} distinct fields")
    conn.commit()

    # Step 3: Create and populate integer-encoded mappings table
    #   WITHOUT ROWID stores the composite INTEGER PK as a clustered B-tree,
    #   avoiding separate rowid allocation and saving ~50% vs regular table.
    print("  Building integer-encoded mappings table (this may take a few minutes)...")
    conn.execute("DROP TABLE IF EXISTS mappings_int")
    conn.execute("""
        CREATE TABLE mappings_int (
            artwork_id  INTEGER NOT NULL,
            vocab_rowid INTEGER NOT NULL,
            field_id    INTEGER NOT NULL,
            PRIMARY KEY (artwork_id, vocab_rowid, field_id)
        ) WITHOUT ROWID
    """)
    conn.execute("""
        INSERT INTO mappings_int (artwork_id, vocab_rowid, field_id)
        SELECT a.art_id, v.vocab_int_id, f.id
        FROM mappings m
        JOIN artworks a ON m.object_number = a.object_number
        JOIN vocabulary v ON m.vocab_id = v.id
        JOIN field_lookup f ON m.field = f.name
    """)
    new_count = cur.execute("SELECT COUNT(*) FROM mappings_int").fetchone()[0]
    old_count = cur.execute("SELECT COUNT(*) FROM mappings").fetchone()[0]
    print(f"    Migrated {new_count:,} of {old_count:,} mappings")
    if new_count < old_count:
        print(f"    Note: {old_count - new_count:,} orphaned mappings dropped (vocab_id not in vocabulary)")
    conn.commit()

    # Step 4: Swap tables (rename-then-drop is crash-safe: if killed after
    # the first rename, both tables survive and the idempotency guard recovers)
    print("  Swapping tables...")
    conn.execute("ALTER TABLE mappings RENAME TO mappings_old")
    conn.execute("ALTER TABLE mappings_int RENAME TO mappings")
    conn.commit()
    conn.execute("DROP TABLE mappings_old")
    conn.commit()

    # Step 5: Recreate secondary indexes
    print("  Creating secondary indexes...")
    conn.execute("CREATE INDEX idx_mappings_field_vocab   ON mappings(field_id, vocab_rowid)")
    conn.execute("CREATE INDEX idx_mappings_field_artwork ON mappings(field_id, artwork_id)")
    conn.execute("CREATE INDEX idx_mappings_vocab         ON mappings(vocab_rowid)")
    conn.commit()

    elapsed = time.time() - t0
    print(f"  Integer-encoding complete in {elapsed:.1f}s")


def normalize_rights(conn: sqlite3.Connection):
    """Normalize artworks.rights_uri to integer FK via rights_lookup table.

    Creates a rights_lookup table (3-4 rows) and replaces the TEXT rights_uri
    column with an INTEGER rights_id FK. Idempotent: skips if already normalized.
    """
    # Guard: skip if already normalized
    if "rights_id" in get_columns(conn, "artworks"):
        print("  Rights already normalized, skipping.")
        return

    print("  Normalizing rights_uri to integer FK...")

    conn.execute("DROP TABLE IF EXISTS rights_lookup")
    conn.execute("CREATE TABLE rights_lookup (id INTEGER PRIMARY KEY, uri TEXT NOT NULL UNIQUE)")
    conn.execute("""
        INSERT INTO rights_lookup (uri)
        SELECT DISTINCT rights_uri FROM artworks
        WHERE rights_uri IS NOT NULL AND rights_uri != ''
    """)
    rights_count = conn.execute("SELECT COUNT(*) FROM rights_lookup").fetchone()[0]
    print(f"    {rights_count} distinct rights URIs")

    conn.execute("ALTER TABLE artworks ADD COLUMN rights_id INTEGER")
    conn.execute("""
        UPDATE artworks SET rights_id = (
            SELECT r.id FROM rights_lookup r WHERE r.uri = artworks.rights_uri
        )
    """)
    conn.commit()

    # Drop the old TEXT column (SQLite >= 3.35.0)
    try:
        conn.execute("ALTER TABLE artworks DROP COLUMN rights_uri")
        conn.commit()
        print("    Dropped rights_uri column")
    except Exception:
        print("    Note: Could not drop rights_uri (SQLite < 3.35.0), column retained")


# ─── Phase 3: Validation ─────────────────────────────────────────────

def run_phase3(conn: sqlite3.Connection, geo_csv: str | None = None):
    """Phase 3: Post-processing (geocoding import, FTS, stats)."""
    cur = conn.cursor()

    # Import geocoding data if CSV provided
    if geo_csv:
        print("\n--- Geocoding Import ---")
        import_geocoding(conn, geo_csv)
        print()

    # ── Integer-encode mappings & normalize rights for ~1.2 GB savings ──
    print("\n--- Mappings Normalization ---")
    normalize_mappings(conn)
    normalize_rights(conn)

    # Drop harvest-only index (only useful during Phase 4 to find unresolved artworks)
    conn.execute("DROP INDEX IF EXISTS idx_artworks_tier2")
    conn.commit()

    print("\n" + "=" * 60)
    print("DATABASE STATISTICS")
    print("=" * 60)

    for table in ["vocabulary", "artworks", "mappings"]:
        count = cur.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        print(f"  {table}: {count:,} rows")

    print("\n--- Vocabulary by Type ---")
    rows = cur.execute("""
        SELECT v.type, COUNT(*) as vocab_cnt,
               COUNT(DISTINCT m.artwork_id) as artwork_cnt
        FROM vocabulary v
        LEFT JOIN mappings m ON m.vocab_rowid = v.vocab_int_id
        GROUP BY v.type
        ORDER BY artwork_cnt DESC
    """).fetchall()
    for vtype, vcnt, acnt in rows:
        print(f"  {vtype:20s} {vcnt:8,} terms    {acnt:8,} artworks linked")

    print("\n--- Mappings by Field ---")
    rows = cur.execute("""
        SELECT f.name as field, COUNT(*) as cnt, COUNT(DISTINCT m.artwork_id) as artworks
        FROM mappings m
        JOIN field_lookup f ON m.field_id = f.id
        GROUP BY m.field_id
        ORDER BY cnt DESC
    """).fetchall()
    for field, cnt, artworks in rows:
        print(f"  {field:20s} {cnt:10,} mappings    {artworks:8,} artworks")

    print("\n--- Vocabulary Coverage ---")
    total_vocab_ids = cur.execute("SELECT COUNT(DISTINCT vocab_rowid) FROM mappings").fetchone()[0]
    # After integer-encoding, all vocab_rowids are valid (orphans dropped during JOIN migration)
    print(f"  Distinct vocab IDs referenced: {total_vocab_ids:,}")
    print(f"  All matched (orphans dropped during integer-encoding)")

    # ── Post-processing: vocab_term_counts, FTS5, collection_set/rights stats ──

    print("\n--- Post-processing ---")

    # Create vocab_term_counts table (preserves text vocab_id for topTermUris())
    print("  Building vocab_term_counts...")
    conn.execute("DROP TABLE IF EXISTS vocab_term_counts")
    conn.execute("""
        CREATE TABLE vocab_term_counts AS
        SELECT v.id AS vocab_id, COUNT(*) AS cnt
        FROM mappings m
        JOIN vocabulary v ON m.vocab_rowid = v.vocab_int_id
        GROUP BY m.vocab_rowid
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

    # Build FTS5 index on person name variants (if person_names table has data)
    pn_count = cur.execute(
        "SELECT COUNT(*) FROM person_names"
    ).fetchone()[0]
    if pn_count > 0:
        print("  Building FTS5 index on person name variants...")
        conn.execute("DROP TABLE IF EXISTS person_names_fts")
        conn.execute("""
            CREATE VIRTUAL TABLE person_names_fts USING fts5(
                name,
                content='person_names', content_rowid='rowid',
                tokenize='unicode61 remove_diacritics 2'
            )
        """)
        conn.execute("INSERT INTO person_names_fts(person_names_fts) VALUES('rebuild')")
        pnf_count = cur.execute("SELECT COUNT(*) FROM person_names_fts").fetchone()[0]
        print(f"    person_names_fts: {pnf_count:,} rows")
        conn.commit()
    else:
        print("  Skipping person_names_fts (no person name data yet)")

    # Populate normalized label columns (space-stripped lowercase for LIKE fallback)
    print("  Populating normalized label columns...")
    conn.execute("""
        UPDATE vocabulary SET
            label_en_norm = REPLACE(LOWER(label_en), ' ', ''),
            label_nl_norm = REPLACE(LOWER(label_nl), ' ', '')
        WHERE label_en IS NOT NULL OR label_nl IS NOT NULL
    """)
    norm_count = cur.execute(
        "SELECT COUNT(*) FROM vocabulary WHERE label_en_norm IS NOT NULL OR label_nl_norm IS NOT NULL"
    ).fetchone()[0]
    print(f"    Normalized labels: {norm_count:,} rows")
    conn.commit()

    # Create FTS5 virtual table for artwork text fields (Tier 2)
    has_tier2 = cur.execute(
        "SELECT COUNT(*) FROM artworks WHERE tier2_done = 1"
    ).fetchone()[0]
    if has_tier2 > 0:
        print("  Building FTS5 index on artwork text fields (Tier 2)...")
        conn.execute("DROP TABLE IF EXISTS artwork_texts_fts")
        conn.execute("""
            CREATE VIRTUAL TABLE artwork_texts_fts USING fts5(
                inscription_text, provenance_text, credit_line, description_text, narrative_text,
                title_all_text,
                content='artworks', content_rowid='rowid',
                tokenize='unicode61 remove_diacritics 2'
            )
        """)
        conn.execute("INSERT INTO artwork_texts_fts(artwork_texts_fts) VALUES('rebuild')")
        atf_count = cur.execute("SELECT COUNT(*) FROM artwork_texts_fts").fetchone()[0]
        print(f"    artwork_texts_fts: {atf_count:,} rows")
        conn.commit()
    else:
        print("  Skipping artwork_texts_fts (no Tier 2 data yet)")

    # Conditional indexes: only create when relevant data exists
    conditional_indexes = [
        (
            "SELECT COUNT(*) FROM artworks WHERE height_cm IS NOT NULL OR width_cm IS NOT NULL",
            "dimension indexes",
            [
                "CREATE INDEX IF NOT EXISTS idx_artworks_height ON artworks(height_cm) WHERE height_cm IS NOT NULL",
                "CREATE INDEX IF NOT EXISTS idx_artworks_width ON artworks(width_cm) WHERE width_cm IS NOT NULL",
            ],
        ),
        (
            "SELECT COUNT(*) FROM artworks WHERE date_earliest IS NOT NULL",
            "date range index",
            [
                "CREATE INDEX IF NOT EXISTS idx_artworks_date_range ON artworks(date_earliest, date_latest) WHERE date_earliest IS NOT NULL",
            ],
        ),
        (
            "SELECT COUNT(*) FROM vocabulary WHERE lat IS NOT NULL",
            "geo index",
            [
                "CREATE INDEX IF NOT EXISTS idx_vocab_lat_lon ON vocabulary(lat, lon) WHERE lat IS NOT NULL",
            ],
        ),
    ]
    for count_sql, label, index_sqls in conditional_indexes:
        count = cur.execute(count_sql).fetchone()[0]
        if count > 0:
            print(f"  Creating {label} — {count:,} qualifying rows...")
            for sql in index_sqls:
                conn.execute(sql)
            conn.commit()
        else:
            print(f"  Skipping {label} (no qualifying data)")

    # Collection set stats
    set_field_id = cur.execute(
        "SELECT id FROM field_lookup WHERE name = 'collection_set'"
    ).fetchone()
    if set_field_id:
        set_mappings = cur.execute(
            "SELECT COUNT(*) FROM mappings WHERE field_id = ?", (set_field_id[0],)
        ).fetchone()[0]
        distinct_sets = cur.execute(
            "SELECT COUNT(DISTINCT vocab_rowid) FROM mappings WHERE field_id = ?", (set_field_id[0],)
        ).fetchone()[0]
        print(f"    collection_set mappings: {set_mappings:,} ({distinct_sets:,} distinct sets)")
    else:
        print(f"    collection_set mappings: 0 (no collection_set field)")

    # Rights coverage (via rights_lookup after normalization)
    rights_total = cur.execute(
        "SELECT COUNT(*) FROM artworks WHERE rights_id IS NOT NULL"
    ).fetchone()[0]
    rights_distinct = cur.execute(
        "SELECT COUNT(DISTINCT rights_id) FROM artworks WHERE rights_id IS NOT NULL"
    ).fetchone()[0]
    print(f"    rights coverage: {rights_total:,} artworks ({rights_distinct:,} distinct URIs)")

    # Show distinct rights URIs
    print("\n--- Rights URIs ---")
    rows = cur.execute("""
        SELECT r.uri, COUNT(*) as cnt
        FROM artworks a
        JOIN rights_lookup r ON a.rights_id = r.id
        GROUP BY a.rights_id
        ORDER BY cnt DESC
    """).fetchall()
    for uri, cnt in rows:
        print(f"  {cnt:8,}  {uri}")

    # Tier 2 stats
    if has_tier2 > 0:
        print(f"\n--- Tier 2 Coverage (of {has_tier2:,} resolved) ---")

        # Text and dimension column coverage
        text_cols = [
            ("inscription_text", "Inscriptions"),
            ("provenance_text",  "Provenance"),
            ("credit_line",      "Credit lines"),
            ("description_text", "Descriptions"),
            ("narrative_text",   "Narratives"),
            ("title_all_text",   "All titles"),
        ]
        non_null_cols = [
            ("date_earliest",    "Dates"),
            ("height_cm",        "Height"),
            ("width_cm",         "Width"),
        ]
        for col, label in text_cols:
            cnt = cur.execute(f"SELECT COUNT(*) FROM artworks WHERE {col} IS NOT NULL AND {col} != ''").fetchone()[0]
            print(f"  {label:20s} {cnt:8,} artworks")
        for col, label in non_null_cols:
            cnt = cur.execute(f"SELECT COUNT(*) FROM artworks WHERE {col} IS NOT NULL").fetchone()[0]
            print(f"  {label:20s} {cnt:8,} artworks")

        # Mapping field coverage
        for field, label in [("production_role", "Prod. roles"), ("attribution_qualifier", "Attr. qualifiers")]:
            fid = cur.execute("SELECT id FROM field_lookup WHERE name = ?", (field,)).fetchone()
            if fid:
                cnt = cur.execute(
                    "SELECT COUNT(*) FROM mappings WHERE field_id = ?", (fid[0],)
                ).fetchone()[0]
                artworks = cur.execute(
                    "SELECT COUNT(DISTINCT artwork_id) FROM mappings WHERE field_id = ?", (fid[0],)
                ).fetchone()[0]
            else:
                cnt, artworks = 0, 0
            print(f"  {label:20s} {cnt:8,} mappings ({artworks:,} artworks)")

        tier2_pending = cur.execute(
            "SELECT COUNT(*) FROM artworks WHERE tier2_done = 0 AND linked_art_uri IS NOT NULL AND linked_art_uri != ''"
        ).fetchone()[0]
        if tier2_pending > 0:
            print(f"  Still pending:     {tier2_pending:,} artworks (use --resume --phase 4)")

    print("\n--- Sample Queries ---")

    # Dogs (Iconclass 34B11)
    count = cur.execute("""
        SELECT COUNT(DISTINCT m.artwork_id)
        FROM mappings m
        JOIN vocabulary v ON m.vocab_rowid = v.vocab_int_id
        WHERE v.notation = '34B11'
    """).fetchone()[0]
    print(f"  Iconclass 34B11 (dog): {count:,} artworks")

    # Crucifixion
    count = cur.execute("""
        SELECT COUNT(DISTINCT m.artwork_id)
        FROM mappings m
        JOIN vocabulary v ON m.vocab_rowid = v.vocab_int_id
        WHERE v.label_en LIKE '%crucifixion%'
    """).fetchone()[0]
    print(f"  Subject 'crucifixion': {count:,} artworks")

    # Rembrandt as depicted person
    subject_fid = cur.execute("SELECT id FROM field_lookup WHERE name = 'subject'").fetchone()
    if subject_fid:
        count = cur.execute("""
            SELECT COUNT(DISTINCT m.artwork_id)
            FROM mappings m
            JOIN vocabulary v ON m.vocab_rowid = v.vocab_int_id
            WHERE m.field_id = ? AND v.type = 'person'
              AND v.label_en LIKE '%Rembrandt%'
        """, (subject_fid[0],)).fetchone()[0]
    else:
        count = 0
    print(f"  Depicted person 'Rembrandt': {count:,} artworks")

    # Amsterdam
    count = cur.execute("""
        SELECT COUNT(DISTINCT m.artwork_id)
        FROM mappings m
        JOIN vocabulary v ON m.vocab_rowid = v.vocab_int_id
        WHERE v.type = 'place' AND v.label_en LIKE '%Amsterdam%'
    """).fetchone()[0]
    print(f"  Place 'Amsterdam': {count:,} artworks")

    print("\n--- Top 10 Subjects ---")
    if subject_fid:
        rows = cur.execute("""
            SELECT v.notation, v.label_en, v.label_nl, v.type,
                   COUNT(DISTINCT m.artwork_id) as cnt
            FROM mappings m
            JOIN vocabulary v ON m.vocab_rowid = v.vocab_int_id
            WHERE m.field_id = ?
            GROUP BY m.vocab_rowid
            ORDER BY cnt DESC
            LIMIT 10
        """, (subject_fid[0],)).fetchall()
    else:
        rows = []
    for notation, en, nl, vtype, cnt in rows:
        label = en or nl or "?"
        code = notation if vtype == "classification" else "—"
        print(f"  {code or '—':12s} {label:50s} {cnt:6,}")

    # Final VACUUM to reclaim space from dropped tables/columns
    print("\n--- VACUUM ---")
    t0 = time.time()
    conn.execute("VACUUM")
    print(f"  VACUUM complete in {time.time() - t0:.1f}s")


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
        help="Run only from phase N onward (default: 0). Phase 4 = Tier 2 Linked Art resolution.",
    )
    parser.add_argument(
        "--threads", type=int, default=DEFAULT_THREADS,
        help=f"Thread count for Phase 4 Linked Art resolution (default: {DEFAULT_THREADS})",
    )
    parser.add_argument(
        "--geo-csv", type=str, default=None, dest="geo_csv",
        help="Path to geocoded places CSV (id,place_name,label_en,label_nl,external_id,lat,lon,artwork_count). "
             "Imports geocoding data into vocabulary table during Phase 3.",
    )
    return parser.parse_args()


def main():
    args = parse_args()

    print(f"Database: {DB_PATH}")
    print(f"Options: resume={args.resume}, skip_dump={args.skip_dump}, start_phase={args.start_phase}, threads={args.threads}, geo_csv={args.geo_csv}")
    print()

    conn = create_or_open_db()

    # Phase ordering: 0 → 0.5 → 1 → 2 → 4 → 2b → 3
    # Phase 2b re-resolves after Phase 4 (which introduces new vocab refs).
    # Phase 3 runs last because it builds FTS indexes and stats on all data.

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

    if args.start_phase <= 4:
        print("=== Phase 4: Linked Art Resolution (Tier 2) ===")
        t0 = time.time()
        run_phase4(conn, threads=args.threads)
        print(f"  Phase 4 took {time.time() - t0:.1f}s")
        print()

        print("=== Phase 2b: Resolving new vocabulary URIs from Phase 4 ===")
        t0 = time.time()
        run_phase2(conn)
        print(f"  Phase 2b took {time.time() - t0:.1f}s")
        print()

    print("=== Phase 3: Validation & Post-processing ===")
    run_phase3(conn, geo_csv=args.geo_csv)

    conn.close()
    print(f"\nDone. Database at: {DB_PATH}")
    db_size = DB_PATH.stat().st_size / (1024 * 1024)
    print(f"Database size: {db_size:.1f} MB")


if __name__ == "__main__":
    main()
