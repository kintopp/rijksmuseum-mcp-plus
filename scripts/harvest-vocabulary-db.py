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
    python3 scripts/harvest-vocabulary-db.py --phase 3 --geo-csv data/backfills/geocoded-places.csv
    python3 scripts/harvest-vocabulary-db.py --limit 1   # Test harvest: 1 page (~200 artworks), all phases

Output: data/vocabulary.db (~1 GB)
"""

import argparse
import hashlib
import json
import os
import re
import sqlite3
import tarfile
from itertools import chain
import time
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
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
    ("exhibition", "event"),
]

OAI_BASE = "https://data.rijksmuseum.nl/oai"
LINKED_ART_BASE = "https://data.rijksmuseum.nl"
USER_AGENT = "rijksmuseum-mcp-harvest/1.0"
DEFAULT_THREADS = 12
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
AAT_PRODUCTION_STATEMENT = "http://vocab.getty.edu/aat/300435416"
AAT_DEPTH = "http://vocab.getty.edu/aat/300072633"
AAT_WEIGHT = "http://vocab.getty.edu/aat/300056240"
AAT_DIAMETER = "http://vocab.getty.edu/aat/300055624"
RM_DEPTH = "https://id.rijksmuseum.nl/2203"
RM_WEIGHT = "https://id.rijksmuseum.nl/220217"
RM_DIAMETER = "https://id.rijksmuseum.nl/2205120"
DEPTH_URIS = {AAT_DEPTH, RM_DEPTH}
WEIGHT_URIS = {AAT_WEIGHT, RM_WEIGHT}
DIAMETER_URIS = {AAT_DIAMETER, RM_DIAMETER}
AAT_UNIT_G = "http://vocab.getty.edu/aat/300379225"     # grams
AAT_UNIT_KG = "http://vocab.getty.edu/aat/300379226"    # kilograms

# Source object types (used_object_of_type) — AAT concepts for the type of object
# used as a source in production (e.g., "this print was made after a painting").
# Only 6 distinct values across the collection; all are external AAT URIs not in the
# Rijksmuseum vocabulary dump, so they must be seeded into the vocabulary table.
AAT_SOURCE_TYPES = {
    "300102051": "designs",
    "300033973": "drawings",
    "300033618": "paintings",
    "300041273": "prints (visual works)",
    "300047090": "sculpture (visual works)",
    "300046300": "photographs",
}

# Exhibition N-Triples predicates
P_BEGIN = "http://www.cidoc-crm.org/cidoc-crm/P82a_begin_of_the_begin"
P_END = "http://www.cidoc-crm.org/cidoc-crm/P82b_end_of_the_end"
P_HAS_MEMBER = "http://www.cidoc-crm.org/cidoc-crm/P46i_forms_part_of"  # legacy fallback: artwork → exhibition
P_HAS_MEMBER_LA = "https://linked.art/ns/terms/has_member"              # actual predicate in exhibition dump
P_USED_SPECIFIC_OBJECT = "http://www.cidoc-crm.org/cidoc-crm/P16_used_specific_object"  # exhibition → Set bnode

# Title classification AAT URIs
AAT_TITLE_FULL = "http://vocab.getty.edu/aat/300417200"
AAT_TITLE_BRIEF = "http://vocab.getty.edu/aat/300417207"
AAT_TITLE_DISPLAY = "http://vocab.getty.edu/aat/300404670"
RM_TITLE_FORMER = "https://id.rijksmuseum.nl/22015528"

# ─── N-Triples parsing (same as pilot) ──────────────────────────────

NT_PATTERN = re.compile(
    r'^<([^>]+)>\s+<([^>]+)>\s+(?:<([^>]+)>|"([^"]*)")\s*\.\s*$'
)
BNODE_PATTERN = re.compile(
    r'^_:(\S+)\s+<([^>]+)>\s+(?:<([^>]+)>|"([^"]*)")\s*\.\s*$'
)
# Matches triples with URI subject and blank-node object: <uri> <uri> _:bnode .
# Needed for exhibition dump parsing where <Exhibition> P16_used_specific_object _:Set .
# NT_PATTERN's object alternation only accepts URIs/literals, so these triples
# are invisible to it — without this pattern, the exhibition → Set link is lost
# and has_member edges cannot be attributed to the right exhibition.
NT_TO_BNODE_PATTERN = re.compile(
    r'^<([^>]+)>\s+<([^>]+)>\s+_:(\S+)\s*\.\s*$'
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
AAT_DISPLAY_NAME = AAT_TITLE_DISPLAY  # same AAT concept (300404670)
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
    "Group": "group",
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
    # Attribution qualifiers — rich labels for assigned_by[].classified_as (#43)
    "300404269": {"type": "classification", "label_en": "attributed to", "label_nl": "toegeschreven aan", "external_id": "http://vocab.getty.edu/aat/300404269"},
    "300404274": {"type": "classification", "label_en": "workshop of", "label_nl": "werkplaats van", "external_id": "http://vocab.getty.edu/aat/300404274"},
    "300404284": {"type": "classification", "label_en": "circle of", "label_nl": "omgeving van", "external_id": "http://vocab.getty.edu/aat/300404284"},
    "300404282": {"type": "classification", "label_en": "follower of", "label_nl": "navolger van", "external_id": "http://vocab.getty.edu/aat/300404282"},
    "300404272": {"type": "classification", "label_en": "manner of", "label_nl": "manier van", "external_id": "http://vocab.getty.edu/aat/300404272"},
    "300404279": {"type": "classification", "label_en": "copy after", "label_nl": "kopie naar", "external_id": "http://vocab.getty.edu/aat/300404279"},
    "300404434": {"type": "classification", "label_en": "school of", "label_nl": "school van", "external_id": "http://vocab.getty.edu/aat/300404434"},
    "300404273": {"type": "classification", "label_en": "studio of", "label_nl": "atelier van", "external_id": "http://vocab.getty.edu/aat/300404273"},
    # Additional attribution qualifiers — discovered via maker-relations probe (2026-03-08)
    "300404286": {"type": "classification", "label_en": "after", "label_nl": "naar", "external_id": "http://vocab.getty.edu/aat/300404286"},
    "300404287": {"type": "classification", "label_en": "copyist of", "label_nl": "imitator van", "external_id": "http://vocab.getty.edu/aat/300404287"},
    "300435722": {"type": "classification", "label_en": "possibly", "label_nl": "mogelijk", "external_id": "http://vocab.getty.edu/aat/300435722"},
    "300404283": {"type": "classification", "label_en": "circle of", "label_nl": "kring van", "external_id": "http://vocab.getty.edu/aat/300404283"},
    # Additional attribution qualifiers — discovered via v0.24 schema discovery
    "300404288": {"type": "classification", "label_en": "manner of", "label_nl": "op de manier van", "external_id": "http://vocab.getty.edu/aat/300404288"},
    "300252887": {"type": "classification", "label_en": "falsification", "label_nl": "vervalsing", "external_id": "http://vocab.getty.edu/aat/300252887"},
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

# Regex to extract IIIF identifier from iiif.micr.io URLs
IIIF_ID_RE = re.compile(r"https?://iiif\.micr\.io/([^/]+)")

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
    has_image        INTEGER DEFAULT 0,
    iiif_id          TEXT,
    tier2_done       INTEGER DEFAULT 0,
    date_display     TEXT,
    current_location TEXT,
    depth_cm         REAL,
    weight_g         REAL,
    diameter_cm      REAL,
    dimension_note   TEXT,
    provenance_text_hash TEXT
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

CREATE TABLE IF NOT EXISTS exhibitions (
    exhibition_id INTEGER PRIMARY KEY,
    title_en      TEXT,
    title_nl      TEXT,
    date_start    TEXT,
    date_end      TEXT
);

CREATE TABLE IF NOT EXISTS exhibition_members (
    exhibition_id INTEGER NOT NULL,
    hmo_id        TEXT NOT NULL,
    PRIMARY KEY (exhibition_id, hmo_id)
);

CREATE TABLE IF NOT EXISTS modifications (
    art_id       INTEGER NOT NULL,
    seq          INTEGER NOT NULL,
    modifier_uri TEXT,
    date_display TEXT,
    date_begin   TEXT,
    date_end     TEXT,
    description  TEXT,
    PRIMARY KEY (art_id, seq)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS related_objects (
    art_id           INTEGER NOT NULL,
    related_la_uri   TEXT NOT NULL,
    related_art_id   INTEGER,
    relationship_en  TEXT NOT NULL,
    relationship_nl  TEXT,
    PRIMARY KEY (art_id, related_la_uri)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS examinations (
    art_id          INTEGER NOT NULL,
    seq             INTEGER NOT NULL,
    examiner_name   TEXT,
    report_type_id  TEXT NOT NULL,
    report_type_en  TEXT,
    date_display    TEXT,
    date_begin      TEXT,
    date_end        TEXT,
    PRIMARY KEY (art_id, seq)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS title_variants (
    art_id     INTEGER NOT NULL,
    seq        INTEGER NOT NULL,
    title_text TEXT NOT NULL,
    language   TEXT,
    qualifier  TEXT,
    PRIMARY KEY (art_id, seq)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS assignment_pairs (
    artwork_id   INTEGER NOT NULL,
    qualifier_id TEXT NOT NULL,
    creator_id   TEXT NOT NULL,
    part_index   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (artwork_id, qualifier_id, creator_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS artwork_parent (
    art_id        INTEGER NOT NULL,
    parent_la_uri TEXT NOT NULL,
    parent_art_id INTEGER,
    PRIMARY KEY (art_id, parent_la_uri)
) WITHOUT ROWID;
"""

VOCAB_INSERT_SQL = (
    "INSERT OR IGNORE INTO vocabulary "
    "(id, type, label_en, label_nl, external_id, broader_id, notation, lat, lon) "
    "VALUES (:id, :type, :label_en, :label_nl, :external_id, :broader_id, :notation, :lat, :lon)"
)


def get_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    """Return the set of column names for a given table."""
    return {row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}


def table_exists(conn: sqlite3.Connection, name: str) -> bool:
    """Check if a table exists in the database."""
    return conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone() is not None


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
        ("date_display", "TEXT"),
        ("current_location", "TEXT"),
        ("depth_cm", "REAL"),
        ("weight_g", "REAL"),
        ("diameter_cm", "REAL"),
        ("dimension_note", "TEXT"),
        ("provenance_text_hash", "TEXT"),
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

    # For events, insert even without labels (the entity ID is the primary value)
    if not label_en and not label_nl:
        if vocab_type == "event":
            label_en = entity_id  # Use entity ID as fallback label
        else:
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


def parse_exhibition_dump(dump_dir: Path, conn: sqlite3.Connection) -> tuple[int, int]:
    """Parse exhibition dump files and populate exhibitions + exhibition_members tables.

    Exhibition entities are E7_Activity with ID namespace 241xxxx. Extracts:
    - Title from P1_is_identified_by → P190_has_symbolic_content (EN/NL)
    - Date range from P82a_begin_of_the_begin / P82b_end_of_the_end
    - Member artwork IDs via the Linked Art two-hop chain:
        <Exhibition> P16_used_specific_object _:Set
        _:Set        https://linked.art/ns/terms/has_member <HMO>
      The exhibition references a blank-node Set entity, and the Set carries
      the has_member edges in the Linked Art namespace. Legacy CIDOC-CRM
      direct/inverse membership predicates (P46_is_composed_of, P46i_forms_part_of)
      are retained as defensive fallbacks but are not used by the current dump.
      See issue #220 for the diagnosis.

    Returns (exhibition_count, member_count).
    """
    files = [f for f in os.listdir(dump_dir) if os.path.isfile(dump_dir / f) and not f.startswith(".")]
    exhibition_count = 0
    member_count = 0

    for fname in files:
        entity_id = fname
        entity_uri = f"https://id.rijksmuseum.nl/{entity_id}"
        filepath = dump_dir / fname

        bnodes: dict[str, dict] = {}
        date_begin = None
        date_end = None
        member_uris: set[str] = set()
        # Blank nodes referenced by this exhibition via P16_used_specific_object.
        # These are the Set entities whose has_member edges give us members.
        set_bnodes: set[str] = set()
        # Buffer: all bnode → HMO has_member edges seen in this file, keyed by bnode.
        # Filtered against set_bnodes after the parse loop to keep only the ones
        # that belong to this exhibition's Set(s).
        bnode_members: dict[str, set[str]] = {}

        try:
            with open(filepath, "r", encoding="utf-8") as f:
                lines = f.readlines()
        except Exception:
            continue

        for line in lines:
            line = line.strip()
            if not line:
                continue

            # URI-subject, URI-object or literal: dates, labels, legacy membership
            m = NT_PATTERN.match(line)
            if m:
                subj = m.group(1)
                pred = m.group(2)
                obj_uri = m.group(3)
                obj_lit = m.group(4)

                if subj == entity_uri:
                    if pred == P_BEGIN and obj_lit:
                        date_begin = obj_lit
                    elif pred == P_END and obj_lit:
                        date_end = obj_lit
                    # Legacy direct membership — retained as defensive fallback
                    elif pred == "http://www.cidoc-crm.org/cidoc-crm/P46_is_composed_of" and obj_uri:
                        hmo_num = obj_uri.split("/")[-1]
                        if hmo_num.isdigit():
                            member_uris.add(hmo_num)

                # Legacy inverse membership — retained as defensive fallback
                if obj_uri == entity_uri and pred == P_HAS_MEMBER:
                    hmo_num = subj.split("/")[-1]
                    if hmo_num.isdigit():
                        member_uris.add(hmo_num)
                continue

            # URI-subject, blank-node-object: the exhibition → Set link
            mb = NT_TO_BNODE_PATTERN.match(line)
            if mb:
                subj = mb.group(1)
                pred = mb.group(2)
                bnode_id = mb.group(3)
                if subj == entity_uri and pred == P_USED_SPECIFIC_OBJECT:
                    set_bnodes.add(bnode_id)
                continue

            # Blank-node-subject: Set's has_member edges and title bnode fields
            bm = BNODE_PATTERN.match(line)
            if bm:
                bnode_id = bm.group(1)
                pred = bm.group(2)
                obj_uri = bm.group(3)
                obj_lit = bm.group(4)

                if bnode_id not in bnodes:
                    bnodes[bnode_id] = {}

                if pred == P_LABEL and obj_lit is not None:
                    bnodes[bnode_id]["label"] = obj_lit
                elif pred == P_LANGUAGE and obj_uri:
                    bnodes[bnode_id]["language"] = obj_uri
                elif pred == P_HAS_MEMBER_LA and obj_uri:
                    # Buffer — filter against set_bnodes after the loop, since
                    # the triple order in the N-Triples file is not guaranteed
                    # and the P16 link may come after its has_member edges.
                    hmo_num = obj_uri.split("/")[-1]
                    if hmo_num.isdigit():
                        bnode_members.setdefault(bnode_id, set()).add(hmo_num)

        # Resolve has_member edges: keep only those belonging to this exhibition's Set(s)
        for bnode_id in set_bnodes:
            member_uris.update(bnode_members.get(bnode_id, set()))

        # Extract EN/NL titles from bnodes
        title_en = None
        title_nl = None
        for bdata in bnodes.values():
            label = bdata.get("label")
            if not label:
                continue
            lang = bdata.get("language")
            if lang == LANG_EN and not title_en:
                title_en = label
            elif lang == LANG_NL and not title_nl:
                title_nl = label

        if not title_en and not title_nl:
            continue

        try:
            exh_id = int(entity_id)
        except ValueError:
            continue

        conn.execute(
            "INSERT OR IGNORE INTO exhibitions (exhibition_id, title_en, title_nl, date_start, date_end) VALUES (?, ?, ?, ?, ?)",
            (exh_id, title_en, title_nl, date_begin, date_end),
        )
        exhibition_count += 1

        for hmo_id in member_uris:
            conn.execute(
                "INSERT OR IGNORE INTO exhibition_members (exhibition_id, hmo_id) VALUES (?, ?)",
                (exh_id, hmo_id),
            )
            member_count += 1

    conn.commit()
    return exhibition_count, member_count


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

        # Exhibition dump gets special parsing (structured tables, not just vocab)
        if tar_name == "exhibition":
            exh_count, mem_count = parse_exhibition_dump(dump_dir, conn)
            # Also parse as regular vocab (for label lookup)
            records = parse_dump_dir(dump_dir, default_type)
            if records:
                conn.executemany(VOCAB_INSERT_SQL, records)
                conn.commit()
                total_records += len(records)
            print(f"    {exh_count:,} exhibitions, {mem_count:,} artwork memberships, {len(records):,} vocab records")
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

        # Check for image availability and extract IIIF ID from edm:isShownBy / edm:object
        has_image = 0
        iiif_id = None
        if agg is not None:
            is_shown = agg.find("{http://www.europeana.eu/schemas/edm/}isShownBy")
            edm_obj = agg.find("{http://www.europeana.eu/schemas/edm/}object")

            # Extract IIIF URL from isShownBy (two RDF/XML shapes):
            #   1. <edm:isShownBy rdf:resource="https://iiif.micr.io/{UUID}/..."/>
            #   2. <edm:isShownBy><edm:WebResource rdf:about="https://iiif.micr.io/{UUID}/..."/></edm:isShownBy>
            iiif_url = ""
            if is_shown is not None:
                has_image = 1
                iiif_url = is_shown.get(RDF_RESOURCE, "")
                if not iiif_url:
                    # Nested WebResource — URL is on rdf:about of the child element
                    child = next(iter(is_shown), None)
                    if child is not None:
                        iiif_url = child.get(RDF_ABOUT, "")
            elif edm_obj is not None:
                has_image = 1
                iiif_url = edm_obj.get(RDF_RESOURCE, "")
                if not iiif_url:
                    child = next(iter(edm_obj), None)
                    if child is not None:
                        iiif_url = child.get(RDF_ABOUT, "")

            # Extract UUID from URL: https://iiif.micr.io/{UUID}/full/max/0/default.jpg
            if iiif_url:
                m = IIIF_ID_RE.match(iiif_url)
                if m:
                    iiif_id = m.group(1)

        records.append({
            "object_number": object_number,
            "title": title,
            "creator_label": creator_label,
            "rights_uri": rights_uri,
            "linked_art_uri": lod_uri,
            "has_image": has_image,
            "iiif_id": iiif_id,
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


def run_phase1(conn: sqlite3.Connection, resume: bool = False, max_pages: int | None = None):
    """Phase 1: Harvest OAI-PMH records. If max_pages is set, stop after that many pages (~200 records/page)."""
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
                "INSERT OR IGNORE INTO artworks (object_number, title, creator_label, rights_uri, linked_art_uri, has_image, iiif_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (rec["object_number"], rec["title"], rec["creator_label"], rec["rights_uri"], rec["linked_art_uri"], rec["has_image"], rec["iiif_id"]),
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

        if max_pages and (page - start_page) >= max_pages:
            print(f"  Reached page limit ({max_pages} pages, {total_artworks:,} artworks)")
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

# Conversion factors from unit to grams (for weight)
UNIT_TO_G = {
    AAT_UNIT_G: 1.0,
    AAT_UNIT_KG: 1000.0,
}


def _extract_dimension_value(dimensions: list | None, type_uris: set[str], unit_map: dict[str, float]) -> float | None:
    """Extract a dimension/weight value, converting via unit_map (default factor 1.0)."""
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
        factor = unit_map.get(unit_id, 1.0)
        return round(val * factor, 2) if factor != 1.0 else val
    return None


def extract_dimension_cm(dimensions: list | None, type_uris: set[str]) -> float | None:
    """Extract a dimension value in centimeters for a given dimension type (height/width)."""
    return _extract_dimension_value(dimensions, type_uris, UNIT_TO_CM)


def extract_weight_g(dimensions: list | None, type_uris: set[str]) -> float | None:
    """Extract a weight value in grams for a given dimension type."""
    return _extract_dimension_value(dimensions, type_uris, UNIT_TO_G)


def extract_dimension_note(dimensions: list | None) -> str | None:
    """Extract annotation text from dimension referred_to_by entries."""
    if not dimensions:
        return None
    notes = []
    for dim in dimensions:
        if not isinstance(dim, dict):
            continue
        for ref in dim.get("referred_to_by", []):
            if not isinstance(ref, dict):
                continue
            content = ref.get("content", "")
            if isinstance(content, list):
                notes.extend(s for s in content if isinstance(s, str))
            elif content:
                notes.append(content)
    return " | ".join(notes) if notes else None


def _extract_timespan(entry: dict) -> tuple[str | None, str | None, str | None]:
    """Extract (date_display, date_begin, date_end) from a Linked Art timespan dict."""
    ts = entry.get("timespan", {})
    if not isinstance(ts, dict):
        return None, None, None
    date_begin = ts.get("begin_of_the_begin")
    date_end = ts.get("end_of_the_end")
    date_display = None
    for ident in ts.get("identified_by", []):
        if isinstance(ident, dict) and ident.get("type") == "Name":
            content = ident.get("content", "")
            if content:
                date_display = content
                break
    return date_display, date_begin, date_end


def extract_modifications(data: dict) -> list[dict]:
    """Extract modification/treatment events from modified_by.

    Returns list of dicts: {modifier_uri, date_display, date_begin, date_end, description}
    """
    modified_by = data.get("modified_by", [])
    if not isinstance(modified_by, list):
        return []
    results = []
    for entry in modified_by:
        if not isinstance(entry, dict):
            continue
        # carried_out_by: bare URI strings
        modifier_uri = None
        for actor in entry.get("carried_out_by", []):
            if isinstance(actor, str):
                modifier_uri = actor
                break
            elif isinstance(actor, dict) and actor.get("id"):
                modifier_uri = actor["id"]
                break

        date_display, date_begin, date_end = _extract_timespan(entry)

        # description from referred_to_by (prefer EN via AAT 300388277)
        description = None
        for ref in entry.get("referred_to_by", []):
            if not isinstance(ref, dict):
                continue
            content = ref.get("content", "")
            if isinstance(content, list):
                content = " ".join(s for s in content if isinstance(s, str))
            if content:
                description = content
                break

        results.append({
            "modifier_uri": modifier_uri,
            "date_display": date_display,
            "date_begin": date_begin,
            "date_end": date_end,
            "description": description,
        })
    return results


def extract_attributed_by(data: dict) -> tuple[list[dict], list[dict]]:
    """Extract attributed_by entries, splitting into related_objects and examinations.

    Pattern A (no carried_out_by): Object relationships → related_objects
    Pattern B (has carried_out_by): Examination reports → examinations

    Returns (related_objects_list, examinations_list).
    """
    attributed_by = data.get("attributed_by", [])
    if not isinstance(attributed_by, list):
        return [], []

    related_objects = []
    examinations = []

    for entry in attributed_by:
        if not isinstance(entry, dict):
            continue

        has_examiner = bool(entry.get("carried_out_by"))

        if has_examiner:
            # Pattern B: Examination report
            examiner_name = None
            for actor in entry.get("carried_out_by", []):
                if isinstance(actor, dict):
                    # Try to get label from identified_by
                    for ident in actor.get("identified_by", []):
                        if isinstance(ident, dict):
                            name = ident.get("content", "")
                            if name:
                                examiner_name = name
                                break
                    if not examiner_name and actor.get("id"):
                        examiner_name = actor["id"].split("/")[-1]

            report_type_id = ""
            report_type_en = None
            for cls in entry.get("classified_as", []):
                if isinstance(cls, dict) and cls.get("id"):
                    report_type_id = cls["id"]
                    # Try to extract label
                    for ident in cls.get("identified_by", []):
                        if isinstance(ident, dict):
                            report_type_en = ident.get("content")
                            break
                    break

            date_display, date_begin, date_end = _extract_timespan(entry)

            if report_type_id:
                examinations.append({
                    "examiner_name": examiner_name,
                    "report_type_id": report_type_id,
                    "report_type_en": report_type_en,
                    "date_display": date_display,
                    "date_begin": date_begin,
                    "date_end": date_end,
                })
        else:
            # Pattern A: Object relationships
            for assigned in entry.get("assigned", []):
                if not isinstance(assigned, dict):
                    continue
                related_uri = assigned.get("id", "")
                if not related_uri:
                    continue

                # Extract relationship labels from identified_by
                relationship_en = None
                relationship_nl = None
                for ident in entry.get("identified_by", []):
                    if not isinstance(ident, dict):
                        continue
                    content = ident.get("content", "")
                    if not content:
                        continue
                    lang_uri = None
                    for lang in ident.get("language", []):
                        if isinstance(lang, dict):
                            lang_uri = lang.get("id", "")
                            break
                    if lang_uri == LANG_EN:
                        relationship_en = content
                    elif lang_uri == LANG_NL:
                        relationship_nl = content
                    elif not relationship_en:
                        relationship_en = content  # fallback

                if relationship_en:
                    related_objects.append({
                        "related_la_uri": related_uri,
                        "relationship_en": relationship_en,
                        "relationship_nl": relationship_nl,
                    })

    return related_objects, examinations


def extract_title_variants(data: dict) -> list[dict]:
    """Extract title variants from identified_by Name entries.

    Returns list of dicts: {title_text, language, qualifier}
    """
    results = []
    for entry in data.get("identified_by", []):
        if not isinstance(entry, dict) or entry.get("type") != "Name":
            continue
        content = entry.get("content", "")
        if isinstance(content, list):
            content = " ".join(s for s in content if isinstance(s, str))
        if not content:
            continue

        # Language
        language = None
        for lang in entry.get("language", []):
            if isinstance(lang, dict):
                lid = lang.get("id", "")
                if lid == LANG_EN:
                    language = "en"
                elif lid == LANG_NL:
                    language = "nl"
                elif lid:
                    language = lid.split("/")[-1]
                break

        # Qualifier from classified_as
        qualifier = None
        for cls in entry.get("classified_as", []):
            if isinstance(cls, dict):
                cid = cls.get("id", "")
                if cid == AAT_TITLE_FULL:
                    qualifier = "full"
                elif cid == AAT_TITLE_BRIEF:
                    qualifier = "brief"
                elif cid == AAT_TITLE_DISPLAY:
                    qualifier = "display"
                elif cid == RM_TITLE_FORMER:
                    qualifier = "former"
                if qualifier:
                    break

        results.append({
            "title_text": content,
            "language": language,
            "qualifier": qualifier,
        })
    return results


def extract_part_of(data: dict) -> list[str]:
    """Extract parent HMO URIs from part_of.

    Returns list of Linked Art URIs.
    """
    results = []
    for entry in data.get("part_of", []):
        if isinstance(entry, dict) and entry.get("type") == "HumanMadeObject":
            uri = entry.get("id", "")
            if uri:
                results.append(uri)
    return results


def _pick_preferred_lang(by_lang: dict[str, str]) -> str | None:
    """Return EN value, then NL, then first available."""
    return by_lang.get(LANG_EN) or by_lang.get(LANG_NL) or (
        next(iter(by_lang.values())) if by_lang else None
    )


def _extract_ids(items: list, field: str) -> list[tuple[str, str]]:
    """Extract (vocab_id, field) tuples from a list of Linked Art typed dicts."""
    result = []
    for item in items:
        if isinstance(item, dict):
            uri = item.get("id", "")
            if uri:
                result.append((uri.split("/")[-1], field))
    return result


def _extract_assigned_creators(items: list) -> list[tuple[str, str]]:
    """Extract creator (vocab_id, field) tuples from assigned[] items.

    Handles two patterns:
      1. Direct person: {"type": "Person", "id": "https://.../{id}"}
      2. Inline Group (workshop of): {"type": "Group", "formed_by": {
             "influenced_by": [{"type": "Person", "id": "https://.../{id}"}]}}
    """
    result = []
    for item in items:
        if not isinstance(item, dict):
            continue
        uri = item.get("id", "")
        if uri:
            result.append((uri.split("/")[-1], "creator"))
            continue
        # Inline Group — traverse formed_by.influenced_by to find the person
        if item.get("type") == "Group":
            formed_by = item.get("formed_by")
            if isinstance(formed_by, dict):
                for inf in formed_by.get("influenced_by", []):
                    if isinstance(inf, dict) and inf.get("id"):
                        result.append((inf["id"].split("/")[-1], "creator"))
    return result


def extract_production_parts(data: dict) -> tuple[
    list[tuple[str, str]], list[tuple[str, str]], list[tuple[str, str]],
    list[tuple[str, str, int]], list[tuple[str, str]], list[tuple[str, str]],
]:
    """Extract production roles, qualifiers, creators, assignment pairs, places, and source types from produced_by.

    Returns:
        (roles, qualifiers, creators, assignment_pairs, places, source_types) where
        roles/qualifiers/creators/places/source_types are lists of (vocab_id, field) tuples,
        and assignment_pairs are (qualifier_id, creator_id, part_index) tuples.

    Production structure in Linked Art:
        produced_by: {
            part: [
                {
                    carried_out_by: [{ id: "https://id.rijksmuseum.nl/31xxx" }],
                    technique: [{ id: "https://id.rijksmuseum.nl/12xxx" }],  # role (painter, printmaker)
                    classified_as: [{ id: "..." }],  # priority level (primary/secondary/undetermined)
                    took_place_at: [{ id: "https://id.rijksmuseum.nl/230xxx", type: "Place" }],
                    used_object_of_type: [{ id: "http://vocab.getty.edu/aat/300xxx", type: "Type" }],
                    assigned_by: [
                        {
                            type: "AttributeAssignment",
                            assigned_property: "carried_out_by",
                            assigned: [{ id: "https://id.rijksmuseum.nl/31xxx" }],  # person
                            classified_as: [{ id: "..." }],  # REAL qualifier (attributed to, workshop of)
                        }
                    ]
                }
            ]
        }

    Note: part.classified_as contains priority levels (primary/secondary), NOT rich
    attribution qualifiers. The real qualifiers (attributed to, workshop of, manner of,
    etc.) come from assigned_by[].classified_as. Both are stored as
    "attribution_qualifier" mappings (different AAT codes, additive).
    """
    roles: list[tuple[str, str]] = []
    qualifiers: list[tuple[str, str]] = []
    creators: list[tuple[str, str]] = []
    assignment_pairs: list[tuple[str, str, int]] = []  # (qualifier_id, creator_id, part_index)
    places: list[tuple[str, str]] = []
    source_types: list[tuple[str, str]] = []

    produced_by = data.get("produced_by")
    if not isinstance(produced_by, dict):
        return roles, qualifiers, creators, assignment_pairs, places, source_types

    # Collect parts from both part[] and top-level assigned_by
    parts = produced_by.get("part", [])
    if not isinstance(parts, list):
        # Single production event without parts — check top level
        parts = [produced_by]

    def _process_assigned_by(assigned_by_list: list, part_idx: int):
        """Process assigned_by entries, extracting creators, qualifiers, and pairs."""
        for assignment in assigned_by_list:
            if not isinstance(assignment, dict):
                continue
            if assignment.get("type") != "AttributeAssignment":
                continue
            prop = assignment.get("assigned_property", "")
            if prop not in ("carried_out_by", "influenced_by"):
                continue
            assigned_creators = _extract_assigned_creators(assignment.get("assigned", []))
            assigned_quals = _extract_ids(assignment.get("classified_as", []), "attribution_qualifier")
            creators.extend(assigned_creators)
            qualifiers.extend(assigned_quals)

            # Emit assignment_pairs: pair each qualifier with each creator
            for q_id, _ in assigned_quals:
                for c_id, _ in assigned_creators:
                    assignment_pairs.append((q_id, c_id, part_idx))

    def _normalise_list(val: object) -> list:
        """Normalise a value that may be a dict, list, or absent into a list."""
        if isinstance(val, dict):
            return [val]
        if isinstance(val, list):
            return val
        return []

    for part_idx, part in enumerate(parts):
        if not isinstance(part, dict):
            continue
        roles.extend(_extract_ids(part.get("technique", []), "production_role"))
        qualifiers.extend(_extract_ids(part.get("classified_as", []), "attribution_qualifier"))
        _process_assigned_by(part.get("assigned_by", []), part_idx)
        places.extend(_extract_ids(_normalise_list(part.get("took_place_at")), "production_place"))
        source_types.extend(_extract_ids(_normalise_list(part.get("used_object_of_type")), "source_type"))

    # Also check top-level produced_by.assigned_by (#43 — some artworks have it at the top)
    if produced_by.get("part") is not None:
        # Only process top-level assigned_by if we didn't already treat produced_by as a single part
        _process_assigned_by(produced_by.get("assigned_by", []), -1)
        # Top-level took_place_at / used_object_of_type (rare but possible)
        places.extend(_extract_ids(_normalise_list(produced_by.get("took_place_at")), "production_place"))
        source_types.extend(_extract_ids(_normalise_list(produced_by.get("used_object_of_type")), "source_type"))

    return roles, qualifiers, creators, assignment_pairs, places, source_types


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

    return _pick_preferred_lang(narratives)


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
    depth_cm = extract_dimension_cm(dimensions, DEPTH_URIS)
    diameter_cm = extract_dimension_cm(dimensions, DIAMETER_URIS)
    weight_g = extract_weight_g(dimensions, WEIGHT_URIS)
    dimension_note = extract_dimension_note(dimensions)

    # Production roles, attribution qualifiers, assigned creators, assignment pairs, places, source types
    roles, qualifiers, creators, assignment_pairs, places, source_types = extract_production_parts(data)

    # Creator label from production statement text (referred_to_by with AAT 300435416)
    # Contains the qualifier-prefixed creator name (e.g. "attributed to Claes van Beresteyn")
    creator_label = None
    produced_by = data.get("produced_by", {})
    if isinstance(produced_by, dict):
        prod_refs = produced_by.get("referred_to_by", [])
        if isinstance(prod_refs, list):
            label_by_lang: dict[str, str] = {}
            for ref in prod_refs:
                if not isinstance(ref, dict):
                    continue
                if not has_classification(ref.get("classified_as"), AAT_PRODUCTION_STATEMENT):
                    continue
                content = ref.get("content", "")
                if isinstance(content, list):
                    content = " ".join(s for s in content if isinstance(s, str))
                if not content:
                    continue
                for lang in ref.get("language", []):
                    lid = lang.get("id", "") if isinstance(lang, dict) else ""
                    if lid and lid not in label_by_lang:
                        label_by_lang[lid] = content
                        break
            creator_label = _pick_preferred_lang(label_by_lang)

    # Curatorial narrative (museum wall text)
    narrative_text = extract_narrative(data)

    # Date extraction from produced_by.timespan
    date_earliest = None
    date_latest = None
    produced_by = data.get("produced_by", {})
    timespan = produced_by.get("timespan", {}) if isinstance(produced_by, dict) else {}
    if isinstance(timespan, list) and timespan:
        # Multi-phase production: take widest date range across all phases
        all_begins = [t.get("begin_of_the_begin", "") for t in timespan if isinstance(t, dict)]
        all_ends = [t.get("end_of_the_end", "") for t in timespan if isinstance(t, dict)]
        timespan = {
            "begin_of_the_begin": min((b for b in all_begins if b), default=""),
            "end_of_the_end": max((e for e in all_ends if e), default=""),
        }
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

    # Date display text from timespan.identified_by (reuse produced_by from above)
    date_display = None
    ts_for_display = produced_by.get("timespan", {}) if isinstance(produced_by, dict) else {}
    if isinstance(ts_for_display, list):
        # Multi-phase: concatenate display labels with "; "
        display_parts = []
        for ts_item in ts_for_display:
            if isinstance(ts_item, dict):
                for ident in ts_item.get("identified_by", []):
                    if isinstance(ident, dict) and ident.get("type") == "Name":
                        c = ident.get("content", "")
                        if c:
                            display_parts.append(c)
                            break
        date_display = "; ".join(display_parts) if display_parts else None
    elif isinstance(ts_for_display, dict):
        for ident in ts_for_display.get("identified_by", []):
            if isinstance(ident, dict) and ident.get("type") == "Name":
                c = ident.get("content", "")
                if c:
                    date_display = c
                    break

    # Current location
    current_location = None
    cur_loc = data.get("current_location", {})
    if isinstance(cur_loc, dict):
        # Try label from identified_by, then fall back to id
        for ident in cur_loc.get("identified_by", []):
            if isinstance(ident, dict):
                c = ident.get("content", "")
                if c:
                    current_location = c
                    break
        if not current_location:
            current_location = cur_loc.get("id")

    # Provenance text hash (SHA-256 for incremental change detection)
    provenance_text_hash = None
    if provenance_text:
        provenance_text_hash = hashlib.sha256(provenance_text.encode("utf-8")).hexdigest()

    # Modifications (treatments/restorations)
    modifications = extract_modifications(data)

    # Related objects and examinations from attributed_by
    related_objects, examinations = extract_attributed_by(data)

    # Title variants (structured)
    title_variants = extract_title_variants(data)

    # Parent HMO URIs (part_of)
    parent_uris = extract_part_of(data)

    return {
        "inscription_text": inscription_text,
        "provenance_text": provenance_text,
        "credit_line": credit_line,
        "description_text": description_text,
        "height_cm": height_cm,
        "width_cm": width_cm,
        "depth_cm": depth_cm,
        "diameter_cm": diameter_cm,
        "weight_g": weight_g,
        "dimension_note": dimension_note,
        "narrative_text": narrative_text,
        "date_earliest": date_earliest,
        "date_latest": date_latest,
        "date_display": date_display,
        "current_location": current_location,
        "provenance_text_hash": provenance_text_hash,
        "title_all_text": title_all_text,
        "creator_label": creator_label,
        "roles": roles,
        "qualifiers": qualifiers,
        "creators": creators,
        "assignment_pairs": assignment_pairs,
        "places": places,
        "source_types": source_types,
        "modifications": modifications,
        "related_objects": related_objects,
        "examinations": examinations,
        "title_variants": title_variants,
        "parent_uris": parent_uris,
    }


def run_phase4(conn: sqlite3.Connection, threads: int = DEFAULT_THREADS):
    """Phase 4: Resolve all artwork Linked Art URIs for Tier 2 fields."""
    cur = conn.cursor()

    # Guard: Phase 3 drops tier2_done and linked_art_uri columns — Phase 4 cannot run after that
    artworks_cols = get_columns(conn, "artworks")
    if "tier2_done" not in artworks_cols or "linked_art_uri" not in artworks_cols:
        print("  tier2_done/linked_art_uri columns not present (Phase 3 already finalized).")
        print("  To re-run Tier 2 resolution, start from a fresh Phase 1+2 harvest.")
        return

    # Detect schema early — needed by seed step and MAPPING_INSERT_SQL below
    int_mappings = "field_id" in get_columns(conn, "mappings")

    # Seed AAT source-type vocabulary entries (used_object_of_type).
    # These are external AAT URIs not present in the Rijksmuseum vocabulary dump.
    # _extract_ids() emits the AAT suffix (e.g. "300102051") as vocab_id, so we insert
    # with that as the primary key to match the MAPPING_INSERT_SQL JOIN.
    # vocab_int_id is an explicit INTEGER column (NOT a rowid alias) used by the
    # integer-schema MAPPING_INSERT_SQL — seeded rows must get a value.
    max_vid = 0
    if int_mappings:
        max_vid = cur.execute("SELECT COALESCE(MAX(vocab_int_id), 0) FROM vocabulary").fetchone()[0]
    seeded = 0
    for aat_id, label_en in AAT_SOURCE_TYPES.items():
        res = cur.execute(
            "INSERT OR IGNORE INTO vocabulary (id, type, label_en) VALUES (?, 'classification', ?)",
            (aat_id, label_en),
        )
        if res.rowcount and int_mappings:
            max_vid += 1
            cur.execute("UPDATE vocabulary SET vocab_int_id = ? WHERE id = ?", (max_vid, aat_id))
        seeded += res.rowcount
    if seeded:
        if int_mappings:
            print(f"  Seeded {seeded} AAT source-type vocabulary entries (vocab_int_id {max_vid - seeded + 1}–{max_vid}).")
        else:
            print(f"  Seeded {seeded} AAT source-type vocabulary entries.")

    # Ensure new field names exist in field_lookup (integer-schema DBs).
    # The MAPPING_INSERT_SQL JOINs against field_lookup — missing entries cause silent drops.
    if int_mappings:
        fl_added = 0
        for field_name in ("production_place", "source_type"):
            res = cur.execute("INSERT OR IGNORE INTO field_lookup (name) VALUES (?)", (field_name,))
            fl_added += res.rowcount
        if fl_added:
            print(f"  Added production_place + source_type to field_lookup.")

    # Ensure art_id exists on artworks before Phase 4's main loop — the six
    # new-table inserts (modifications, related_objects, examinations,
    # title_variants, assignment_pairs, artwork_parent) are keyed by art_id
    # and would otherwise be silently skipped on a fresh harvest because
    # Phase 3's normalize_mappings() doesn't run until AFTER Phase 4.
    #
    # This block is idempotent — normalize_mappings() has the same guard and
    # will skip the art_id bootstrap if it's already in place. Fix for #219
    # (six Phase 4 tables returned 0 rows in v0.24).
    if "art_id" not in get_columns(conn, "artworks"):
        print("  Adding stable art_id column (so Phase 4 new-table inserts work)...")
        conn.execute("ALTER TABLE artworks ADD COLUMN art_id INTEGER")
        conn.execute("UPDATE artworks SET art_id = rowid")
        conn.execute("CREATE UNIQUE INDEX idx_artworks_art_id ON artworks(art_id)")

    conn.commit()

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

    # Detect schema for mappings inserts (production roles + attribution qualifiers).
    # art_id is guaranteed present by the bootstrap block above — but keep the
    # dynamic check so this function stays robust against schema drift.
    artworks_cols = get_columns(conn, "artworks")
    has_art_id = "art_id" in artworks_cols
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
    with_creator_label = 0
    role_count = 0
    qualifier_count = 0
    creator_count = 0
    modification_count = 0
    related_object_count = 0
    examination_count = 0
    title_variant_count = 0
    assignment_pair_count = 0
    parent_count = 0
    place_count = 0
    source_type_count = 0
    t0 = time.time()

    TIER2_UPDATE_SQL = """
        UPDATE artworks SET
            inscription_text = ?,
            provenance_text = ?,
            credit_line = ?,
            description_text = ?,
            height_cm = ?,
            width_cm = ?,
            depth_cm = ?,
            diameter_cm = ?,
            weight_g = ?,
            dimension_note = ?,
            narrative_text = ?,
            date_earliest = ?,
            date_latest = ?,
            date_display = ?,
            current_location = ?,
            provenance_text_hash = ?,
            title_all_text = ?,
            creator_label = COALESCE(?, creator_label),
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
                if result.get("creator_label"):
                    with_creator_label += 1

                conn.execute(TIER2_UPDATE_SQL, (
                    result["inscription_text"],
                    result["provenance_text"],
                    result["credit_line"],
                    result["description_text"],
                    result["height_cm"],
                    result["width_cm"],
                    result["depth_cm"],
                    result["diameter_cm"],
                    result["weight_g"],
                    result["dimension_note"],
                    result["narrative_text"],
                    result["date_earliest"],
                    result["date_latest"],
                    result["date_display"],
                    result["current_location"],
                    result["provenance_text_hash"],
                    result["title_all_text"],
                    result.get("creator_label"),
                    obj_num,
                ))

                # Insert production role, attribution qualifier, creator, place, and source type mappings
                for vocab_id, field in chain(result["roles"], result["qualifiers"], result["creators"], result["places"], result["source_types"]):
                    conn.execute(MAPPING_INSERT_SQL, (obj_num, vocab_id, field))
                role_count += len(result["roles"])
                qualifier_count += len(result["qualifiers"])
                creator_count += len(result["creators"])
                place_count += len(result["places"])
                source_type_count += len(result["source_types"])

                # New-table inserts require art_id. The bootstrap block at the top
                # of run_phase4 guarantees art_id exists, so has_art_id should be
                # True — but keep the fallback so this function stays robust if
                # the bootstrap is ever disabled or the caller reshapes the schema.
                # Fix for #219 (v0.24 regression where art_id was only added by
                # Phase 3's normalize_mappings after Phase 4 had already finished).
                if has_art_id:
                    art_id_row = conn.execute(
                        "SELECT art_id FROM artworks WHERE object_number = ?", (obj_num,)
                    ).fetchone()
                    art_id = art_id_row[0] if art_id_row else None
                else:
                    art_id = None

                if art_id is not None:
                    # Insert modifications
                    for seq, mod in enumerate(result.get("modifications", [])):
                        conn.execute(
                            "INSERT OR IGNORE INTO modifications (art_id, seq, modifier_uri, date_display, date_begin, date_end, description) VALUES (?, ?, ?, ?, ?, ?, ?)",
                            (art_id, seq, mod["modifier_uri"], mod["date_display"], mod["date_begin"], mod["date_end"], mod["description"]),
                        )
                    modification_count += len(result.get("modifications", []))

                    # Insert related objects
                    for ro in result.get("related_objects", []):
                        conn.execute(
                            "INSERT OR IGNORE INTO related_objects (art_id, related_la_uri, relationship_en, relationship_nl) VALUES (?, ?, ?, ?)",
                            (art_id, ro["related_la_uri"], ro["relationship_en"], ro.get("relationship_nl")),
                        )
                    related_object_count += len(result.get("related_objects", []))

                    # Insert examinations
                    for seq, exam in enumerate(result.get("examinations", [])):
                        conn.execute(
                            "INSERT OR IGNORE INTO examinations (art_id, seq, examiner_name, report_type_id, report_type_en, date_display, date_begin, date_end) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                            (art_id, seq, exam["examiner_name"], exam["report_type_id"], exam.get("report_type_en"), exam.get("date_display"), exam.get("date_begin"), exam.get("date_end")),
                        )
                    examination_count += len(result.get("examinations", []))

                    # Insert title variants
                    for seq, tv in enumerate(result.get("title_variants", [])):
                        conn.execute(
                            "INSERT OR IGNORE INTO title_variants (art_id, seq, title_text, language, qualifier) VALUES (?, ?, ?, ?, ?)",
                            (art_id, seq, tv["title_text"], tv.get("language"), tv.get("qualifier")),
                        )
                    title_variant_count += len(result.get("title_variants", []))

                    # Insert assignment pairs
                    for q_id, c_id, part_idx in result.get("assignment_pairs", []):
                        conn.execute(
                            "INSERT OR IGNORE INTO assignment_pairs (artwork_id, qualifier_id, creator_id, part_index) VALUES (?, ?, ?, ?)",
                            (art_id, q_id, c_id, part_idx),
                        )
                    assignment_pair_count += len(result.get("assignment_pairs", []))

                    # Insert parent URIs
                    for parent_uri in result.get("parent_uris", []):
                        conn.execute(
                            "INSERT OR IGNORE INTO artwork_parent (art_id, parent_la_uri) VALUES (?, ?)",
                            (art_id, parent_uri),
                        )
                    parent_count += len(result.get("parent_uris", []))

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
    print(f"    Creator label:{with_creator_label:,}")
    print(f"    Prod. roles:  {role_count:,}")
    print(f"    Attr. quals:  {qualifier_count:,}")
    print(f"    Creators:     {creator_count:,} (from assigned_by)")
    print(f"    Modifications:{modification_count:,}")
    print(f"    Related obj:  {related_object_count:,}")
    print(f"    Examinations: {examination_count:,}")
    print(f"    Title vars:   {title_variant_count:,}")
    print(f"    Assign. pairs:{assignment_pair_count:,}")
    print(f"    Parent links: {parent_count:,}")
    print(f"    Prod. places: {place_count:,}")
    print(f"    Source types: {source_type_count:,}")


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
    # Only idx_mappings_field_vocab is needed. idx_mappings_field_artwork is a
    # performance anti-pattern (9,000-17,000x slower on enrichment queries) and
    # idx_mappings_vocab is redundant (not used by any runtime query path).
    print("  Creating secondary indexes...")
    conn.execute("CREATE INDEX idx_mappings_field_vocab ON mappings(field_id, vocab_rowid)")
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

    # ── New Phase 3 tables (art_id-independent) ──

    # Museum rooms reference table (static data from #212 crawl)
    print("\n--- Museum Rooms ---")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS museum_rooms (
            room_hash  TEXT PRIMARY KEY,
            room_id    TEXT NOT NULL,
            floor      TEXT,
            room_name  TEXT
        )
    """)
    # Data is seeded from an external JSON/CSV file if available
    rooms_json = PROJECT_DIR / "data" / "museum-rooms.json"
    if rooms_json.exists():
        rooms_data = json.loads(rooms_json.read_text(encoding="utf-8"))
        for room in rooms_data:
            conn.execute(
                "INSERT OR IGNORE INTO museum_rooms (room_hash, room_id, floor, room_name) VALUES (?, ?, ?, ?)",
                (room.get("room_hash", ""), room["room_id"], room.get("floor"), room.get("room_name")),
            )
        conn.commit()
        print(f"  Seeded {len(rooms_data)} museum rooms from {rooms_json}")
    else:
        print(f"  Skipping room seeding ({rooms_json} not found)")

    # sync_state table for LDES consumer (#205)
    print("\n--- Sync State ---")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS sync_state (
            key   TEXT PRIMARY KEY,
            value TEXT
        )
    """)
    conn.commit()
    print("  sync_state table ready")

    # geocode_method column on vocabulary
    vocab_cols = get_columns(conn, "vocabulary")
    if "geocode_method" not in vocab_cols:
        conn.execute("ALTER TABLE vocabulary ADD COLUMN geocode_method TEXT")
        conn.commit()
        print("  Added vocabulary.geocode_method column")

    # Convert dimension 0.0 sentinels → NULL (#195)
    print("\n--- Dimension Sentinel Cleanup ---")
    for col in ["height_cm", "width_cm", "depth_cm", "diameter_cm"]:
        if col in get_columns(conn, "artworks"):
            updated = conn.execute(f"UPDATE artworks SET {col} = NULL WHERE {col} = 0.0").rowcount
            if updated > 0:
                print(f"  {col}: {updated:,} zero sentinels → NULL")
    conn.commit()

    # ── Integer-encode mappings & normalize rights for ~1.2 GB savings ──
    print("\n--- Mappings Normalization ---")
    normalize_mappings(conn)
    normalize_rights(conn)

    # ── Post-normalization joins (require art_id from normalize_mappings) ──

    # artwork_exhibitions junction table (from Phase 0 exhibition_members)
    print("\n--- Artwork Exhibitions ---")
    if table_exists(conn, "exhibition_members"):
        conn.execute("""
            CREATE TABLE IF NOT EXISTS artwork_exhibitions (
                art_id        INTEGER NOT NULL,
                exhibition_id INTEGER NOT NULL,
                PRIMARY KEY (art_id, exhibition_id)
            ) WITHOUT ROWID
        """)
        inserted = conn.execute("""
            INSERT OR IGNORE INTO artwork_exhibitions (art_id, exhibition_id)
            SELECT a.art_id, em.exhibition_id
            FROM exhibition_members em
            JOIN artworks a ON a.object_number = em.hmo_id
            WHERE a.art_id IS NOT NULL
        """).rowcount
        conn.commit()
        print(f"  artwork_exhibitions: {inserted:,} rows")

        total_ae = cur.execute("SELECT COUNT(*) FROM artwork_exhibitions").fetchone()[0]
        total_em = cur.execute("SELECT COUNT(*) FROM exhibition_members").fetchone()[0]
        if total_ae < total_em:
            print(f"  Note: {total_em - total_ae:,} exhibition memberships could not be resolved to art_ids")
    else:
        print("  Skipping (no exhibition_members table)")

    # Resolve related_objects.related_art_id
    print("\n--- Resolving Related Object Art IDs ---")
    if table_exists(conn, "related_objects"):
        ro_count = cur.execute("SELECT COUNT(*) FROM related_objects").fetchone()[0]
        if ro_count > 0:
            conn.execute("""
                UPDATE related_objects SET related_art_id = (
                    SELECT a.art_id FROM artworks a
                    WHERE a.object_number = SUBSTR(related_objects.related_la_uri,
                        INSTR(related_objects.related_la_uri, '/object/') + 8)
                )
                WHERE related_art_id IS NULL
            """)
            resolved = cur.execute("SELECT COUNT(*) FROM related_objects WHERE related_art_id IS NOT NULL").fetchone()[0]
            print(f"  Resolved {resolved:,} of {ro_count:,} related objects to art_ids")
        else:
            print("  No related objects to resolve")
        conn.commit()
    else:
        print("  Skipping (no related_objects table)")

    # Resolve artwork_parent.parent_art_id
    print("\n--- Resolving Artwork Parent Art IDs ---")
    if table_exists(conn, "artwork_parent"):
        ap_count = cur.execute("SELECT COUNT(*) FROM artwork_parent").fetchone()[0]
        if ap_count > 0:
            conn.execute("""
                UPDATE artwork_parent SET parent_art_id = (
                    SELECT a.art_id FROM artworks a
                    WHERE a.object_number = SUBSTR(artwork_parent.parent_la_uri,
                        INSTR(artwork_parent.parent_la_uri, '/object/') + 8)
                )
                WHERE parent_art_id IS NULL
            """)
            resolved = cur.execute("SELECT COUNT(*) FROM artwork_parent WHERE parent_art_id IS NOT NULL").fetchone()[0]
            print(f"  Resolved {resolved:,} of {ap_count:,} parent links to art_ids")
        else:
            print("  No parent links to resolve")
        conn.commit()
    else:
        print("  Skipping (no artwork_parent table)")

    # Drop harvest-only index (only useful during Phase 4 to find unresolved artworks)
    conn.execute("DROP INDEX IF EXISTS idx_artworks_tier2")

    # Drop redundant/harmful indexes (safety — in case running against older DB)
    conn.execute("DROP INDEX IF EXISTS idx_mappings_field_artwork")
    conn.execute("DROP INDEX IF EXISTS idx_mappings_vocab")

    # Drop harvest-only columns (SQLite >= 3.35.0)
    for col in ["linked_art_uri", "tier2_done"]:
        try:
            conn.execute(f"ALTER TABLE artworks DROP COLUMN {col}")
            print(f"    Dropped {col} column")
        except Exception:
            print(f"    Note: Could not drop {col} (SQLite < 3.35.0)")
    conn.commit()

    print("\n" + "=" * 60)
    print("DATABASE STATISTICS")
    print("=" * 60)

    for table in ["vocabulary", "artworks", "mappings"]:
        count = cur.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        print(f"  {table}: {count:,} rows")

    # New table stats
    for table in ["exhibitions", "artwork_exhibitions", "modifications", "related_objects",
                   "examinations", "title_variants", "assignment_pairs", "artwork_parent"]:
        if table_exists(conn, table):
            count = cur.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            if count > 0:
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
    # Detect Tier 2 data by checking for non-null text fields (tier2_done column may be dropped)
    has_tier2 = cur.execute(
        "SELECT COUNT(*) FROM artworks WHERE inscription_text IS NOT NULL OR description_text IS NOT NULL OR narrative_text IS NOT NULL"
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
        print(f"\n--- Tier 2 Coverage ({has_tier2:,} artworks with text data) ---")

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
            ("depth_cm",         "Depth"),
            ("diameter_cm",      "Diameter"),
            ("weight_g",         "Weight"),
            ("date_display",     "Date display"),
            ("current_location", "Current loc."),
        ]
        for col, label in text_cols:
            cnt = cur.execute(f"SELECT COUNT(*) FROM artworks WHERE {col} IS NOT NULL AND {col} != ''").fetchone()[0]
            print(f"  {label:20s} {cnt:8,} artworks")
        for col, label in non_null_cols:
            cnt = cur.execute(f"SELECT COUNT(*) FROM artworks WHERE {col} IS NOT NULL").fetchone()[0]
            print(f"  {label:20s} {cnt:8,} artworks")

        # Mapping field coverage
        for field, label in [("production_role", "Prod. roles"), ("attribution_qualifier", "Attr. qualifiers"), ("creator", "Creators")]:
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

        # Creator label coverage (should increase from ~55% to ~95%+ after assigned_by extraction)
        creator_label_cnt = cur.execute(
            "SELECT COUNT(*) FROM artworks WHERE creator_label IS NOT NULL AND creator_label != ''"
        ).fetchone()[0]
        total_artworks_cnt = cur.execute("SELECT COUNT(*) FROM artworks").fetchone()[0]
        pct = (creator_label_cnt / total_artworks_cnt * 100) if total_artworks_cnt > 0 else 0
        print(f"  {'Creator labels':20s} {creator_label_cnt:8,} artworks ({pct:.1f}%)")

        # has_image coverage
        artworks_cols = get_columns(conn, "artworks")
        if "has_image" in artworks_cols:
            has_img_cnt = cur.execute("SELECT COUNT(*) FROM artworks WHERE has_image = 1").fetchone()[0]
            pct = (has_img_cnt / total_artworks_cnt * 100) if total_artworks_cnt > 0 else 0
            print(f"  {'Has image':20s} {has_img_cnt:8,} artworks ({pct:.1f}%)")

        # IIIF ID coverage
        if "iiif_id" in artworks_cols:
            iiif_cnt = cur.execute("SELECT COUNT(*) FROM artworks WHERE iiif_id IS NOT NULL").fetchone()[0]
            pct = (iiif_cnt / total_artworks_cnt * 100) if total_artworks_cnt > 0 else 0
            print(f"  {'IIIF ID':20s} {iiif_cnt:8,} artworks ({pct:.1f}%)")

        # Tier 2 pending (only if columns still exist — they're dropped in Phase 3)
        if "tier2_done" in artworks_cols and "linked_art_uri" in artworks_cols:
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

    # ── Importance score ─────────────────────────────────────────────
    # Delegates to compute-importance.py's shared function to avoid formula duplication.
    print("\n--- Importance Score ---")
    artworks_cols = get_columns(conn, "artworks")
    if "importance" not in artworks_cols:
        conn.execute("ALTER TABLE artworks ADD COLUMN importance INTEGER DEFAULT 0")
        conn.commit()
    from compute_importance import compute_importance_scores
    result = compute_importance_scores(conn, cur)
    for score, cnt in result["distribution"]:
        pct = cnt / result["total"] * 100
        print(f"  {score:3d}: {cnt:8,} ({pct:5.1f}%)")
    print(f"  Computed in {result['elapsed']:.1f}s")

    # Write version_info
    print("\n--- version_info ---")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS version_info (
            key TEXT PRIMARY KEY,
            value TEXT
        )
    """)
    built_at = datetime.now(timezone.utc).isoformat()
    artwork_count = cur.execute("SELECT COUNT(*) FROM artworks").fetchone()[0]
    vocab_count = cur.execute("SELECT COUNT(*) FROM vocabulary").fetchone()[0]
    mapping_count = cur.execute("SELECT COUNT(*) FROM mappings").fetchone()[0]
    version_rows = [
        ("built_at", built_at),
        ("artwork_count", str(artwork_count)),
        ("vocab_count", str(vocab_count)),
        ("mapping_count", str(mapping_count)),
    ]
    conn.executemany(
        "INSERT OR REPLACE INTO version_info (key, value) VALUES (?, ?)",
        version_rows,
    )
    conn.commit()
    for k, v in version_rows:
        print(f"  {k}: {v}")

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
    parser.add_argument(
        "--limit", type=int, default=None, dest="limit_pages",
        help="Limit Phase 1 OAI-PMH harvest to N pages (~200 records/page). "
             "Default: unlimited. Subsequent phases auto-scope to harvested data.",
    )
    parser.add_argument(
        "--db", type=str, default=None,
        help="Override output database path (default: data/vocabulary.db).",
    )
    return parser.parse_args()


def main():
    global DB_PATH
    args = parse_args()

    if args.db:
        DB_PATH = Path(args.db)

    print(f"Database: {DB_PATH}")
    print(f"Options: resume={args.resume}, skip_dump={args.skip_dump}, start_phase={args.start_phase}, threads={args.threads}, geo_csv={args.geo_csv}, limit_pages={args.limit_pages}")
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
        label = f"Harvesting OAI-PMH records (limit: {args.limit_pages} pages)" if args.limit_pages else "Harvesting ALL OAI-PMH records"
        print(f"=== Phase 1: {label} ===")
        t0 = time.time()
        run_phase1(conn, resume=args.resume, max_pages=args.limit_pages)
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

    # ── Orphan vocab audit (before Phase 3 integer-encoding drops them) ──
    print("=== Orphan Vocab Audit ===")
    orphan_sql = """
        SELECT m.vocab_id, m.field, COUNT(*) as cnt
        FROM mappings m
        LEFT JOIN vocabulary v ON m.vocab_id = v.id
        WHERE v.id IS NULL
        GROUP BY m.vocab_id, m.field
        ORDER BY cnt DESC
    """
    mapping_cols = get_columns(conn, "mappings")
    if "vocab_id" in mapping_cols:
        orphans = conn.execute(orphan_sql).fetchall()
        if orphans:
            csv_path = PROJECT_DIR / "data" / "audit" / f"orphan-vocab-ids-v0.24.csv"
            csv_path.parent.mkdir(parents=True, exist_ok=True)
            with open(csv_path, "w") as f:
                f.write("vocab_id,field,count\n")
                for vid, field, cnt in orphans:
                    f.write(f"{vid},{field},{cnt}\n")
            print(f"  WARNING: {len(orphans)} orphan vocab IDs exported to {csv_path}")
            print(f"  Review and add missing codes to EXTERNAL_VOCAB before re-running Phase 3.")
        else:
            print(f"  No orphan vocab IDs found — all mappings have matching vocabulary entries.")
    else:
        print(f"  Skipping (mappings already integer-encoded)")
    print()

    print("=== Phase 3: Validation & Post-processing ===")
    run_phase3(conn, geo_csv=args.geo_csv)

    conn.close()
    print(f"\nDone. Database at: {DB_PATH}")
    db_size = DB_PATH.stat().st_size / (1024 * 1024)
    print(f"Database size: {db_size:.1f} MB")


if __name__ == "__main__":
    main()
