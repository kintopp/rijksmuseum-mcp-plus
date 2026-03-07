#!/usr/bin/env python3
"""
Enrich vocabulary database with actor bios, place hierarchy, and concept hierarchy
from Rijksmuseum data dumps.

Phases (run in order):
  1. Schema — add columns (birth_year, death_year, gender, bio, wikidata_id)
  2d. Places — broader_id + external_id from 2025 place dump (direct ID match)
  2a. Actors — birth/death/gender/bio from 2019 EDM actors dump (name matching)
  2b. Wikidata — wikidata_id from 2025 person dump (direct ID + name fallback)
  2c. Thesaurus — broader_id from 2019 SKOS thesaurus (AAT + label matching)
  3. Coordinate inheritance — propagate coords from geocoded parents to children
  4. Validation — spot checks and summary stats

Usage:
    python3 scripts/enrich-vocab-from-dumps.py                    # Full run
    python3 scripts/enrich-vocab-from-dumps.py --phase 2a         # Start from phase
    python3 scripts/enrich-vocab-from-dumps.py --dry-run           # Report only, no writes

Output: updates data/vocabulary.db in place (back up first!)
"""

import argparse
import html
import os
import re
import sqlite3
import time
import xml.etree.ElementTree as ET
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

# ─── Configuration ───────────────────────────────────────────────────

SCRIPT_DIR = Path(__file__).parent
PROJECT_DIR = SCRIPT_DIR.parent
DB_PATH = PROJECT_DIR / "data" / "vocabulary.db"
DUMPS_DIR = Path.home() / "Downloads" / "rijksmuseum-data-dumps"

EDM_ACTORS_ZIP = DUMPS_DIR / "201911-rma-edm-actors.zip"
SKOS_THESAURUS_ZIP = DUMPS_DIR / "201911-rma-skos-thesaurus.zip"
PLACE_EXTRACTED_DIR = DUMPS_DIR / "place_extracted"
PERSON_EXTRACTED_DIR = DUMPS_DIR / "person_extracted"

# RDF namespaces
NS = {
    "rdf": "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
    "skos": "http://www.w3.org/2004/02/skos/core#",
    "dc": "http://purl.org/dc/elements/1.1/",
    "rdaGr2": "http://rdvocab.info/ElementsGr2/",
    "edm": "http://www.europeana.eu/schemas/edm/",
}

# Regex for N-Triples parsing
RE_FALLS_WITHIN = re.compile(
    r"<https://id\.rijksmuseum\.nl/(\d+)>\s+"
    r"<http://www\.cidoc-crm\.org/cidoc-crm/P89_falls_within>\s+"
    r"<https://id\.rijksmuseum\.nl/(\d+)>"
)
RE_EQUIVALENT = re.compile(
    r"<https://id\.rijksmuseum\.nl/(\d+)>\s+"
    r"<https://linked\.art/ns/terms/equivalent>\s+"
    r"<(http[^>]+)>"
)
RE_SCHEMA_NAME = re.compile(
    r"<https://id\.rijksmuseum\.nl/(\d+)>\s+"
    r"<http://schema\.org/name>\s+"
    r'"([^"]*)"'
)
RE_SCHEMA_ALT_NAME = re.compile(
    r"<https://id\.rijksmuseum\.nl/(\d+)>\s+"
    r"<http://schema\.org/alternateName>\s+"
    r'"([^"]*)"'
)
RE_SCHEMA_SAME_AS = re.compile(
    r"<https://id\.rijksmuseum\.nl/(\d+)>\s+"
    r"<http://schema\.org/sameAs>\s+"
    r"<(http[^>]+)>"
)
RE_YEAR = re.compile(r"\b(\d{4})\b")
RE_WIKIDATA_QID = re.compile(r"wikidata\.org/entity/(Q\d+)")

PHASE_ORDER = ["1", "2d", "2a", "2b", "2c", "3", "4"]


# ─── Helpers ─────────────────────────────────────────────────────────


def parse_year(text):
    """Extract first 4-digit year from a date string. Returns int or None."""
    if not text:
        return None
    m = RE_YEAR.search(text)
    return int(m.group(1)) if m else None


def clean_bio(text):
    """Clean HTML markup from biographical text."""
    if not text:
        return None
    # Replace <BR> variants with newline
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.IGNORECASE)
    # Strip <I>...</I> tags (keep content)
    text = re.sub(r"</?[iI]>", "", text)
    # Decode HTML entities
    text = html.unescape(text)
    text = text.strip()
    return text if text else None


def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}")


# ─── Phase 1: Schema changes ────────────────────────────────────────


def phase_1_schema(conn):
    """Add new columns for actor data."""
    log("Phase 1: Schema changes")
    cursor = conn.execute("PRAGMA table_info(vocabulary)")
    existing_cols = {row[1] for row in cursor.fetchall()}

    new_cols = [
        ("birth_year", "INTEGER"),
        ("death_year", "INTEGER"),
        ("gender", "TEXT"),
        ("bio", "TEXT"),
        ("wikidata_id", "TEXT"),
    ]

    added = 0
    for col_name, col_type in new_cols:
        if col_name not in existing_cols:
            conn.execute(f"ALTER TABLE vocabulary ADD COLUMN {col_name} {col_type}")
            log(f"  Added column: {col_name} {col_type}")
            added += 1
        else:
            log(f"  Column already exists: {col_name}")

    conn.commit()
    log(f"  Schema: {added} columns added")


# ─── Phase 2d: Place hierarchy ───────────────────────────────────────


def phase_2d_places(conn, dry_run=False):
    """Enrich places with broader_id and external_id from 2025 place dump."""
    log("Phase 2d: Place hierarchy from place dump")

    if not PLACE_EXTRACTED_DIR.exists():
        log("  ERROR: place_extracted/ directory not found")
        return

    # Load vocab place IDs for matching
    vocab_place_ids = set(
        r[0]
        for r in conn.execute("SELECT id FROM vocabulary WHERE type='place'").fetchall()
    )
    log(f"  Vocab places: {len(vocab_place_ids)}")

    files = os.listdir(PLACE_EXTRACTED_DIR)
    log(f"  Place dump files: {len(files)}")

    updates_broader = 0
    updates_external = 0
    skipped_not_in_vocab = 0
    batch = []

    for i, fname in enumerate(files):
        if i % 5000 == 0 and i > 0:
            log(f"  ... processed {i}/{len(files)} files")

        fpath = PLACE_EXTRACTED_DIR / fname
        try:
            text = fpath.read_text()
        except Exception:
            continue

        place_id = fname  # filename IS the ID

        if place_id not in vocab_place_ids:
            skipped_not_in_vocab += 1
            continue

        # Extract falls_within (parent place)
        parent_id = None
        for m in RE_FALLS_WITHIN.finditer(text):
            if m.group(1) == place_id:
                parent_id = m.group(2)
                break

        # Extract equivalent URIs (TGN, Wikidata — skip 330xxxxx Rijksmuseum internal)
        external_uris = []
        for m in RE_EQUIVALENT.finditer(text):
            if m.group(1) == place_id:
                uri = m.group(2)
                if not uri.startswith("https://id.rijksmuseum.nl/330"):
                    external_uris.append(uri)

        # Prefer Wikidata, then TGN
        best_external = None
        for uri in external_uris:
            if "wikidata.org" in uri:
                best_external = uri
                break
        if not best_external:
            for uri in external_uris:
                if "getty.edu/tgn" in uri:
                    best_external = uri
                    break

        batch.append((place_id, parent_id, best_external))

    log(f"  Dump IDs not in vocab: {skipped_not_in_vocab}")

    if dry_run:
        has_parent = sum(1 for _, p, _ in batch if p)
        has_ext = sum(1 for _, _, e in batch if e)
        log(f"  [DRY RUN] Would update: {has_parent} broader_id, {has_ext} external_id")
        return

    # Apply updates — only fill NULLs
    for place_id, parent_id, best_external in batch:
        if parent_id:
            cur = conn.execute(
                "UPDATE vocabulary SET broader_id = ? WHERE id = ? AND broader_id IS NULL",
                (parent_id, place_id),
            )
            updates_broader += cur.rowcount
        if best_external:
            cur = conn.execute(
                "UPDATE vocabulary SET external_id = ? WHERE id = ? AND external_id IS NULL",
                (best_external, place_id),
            )
            updates_external += cur.rowcount

    conn.commit()
    log(f"  Updated: {updates_broader} broader_id, {updates_external} external_id")


# ─── Phase 2a: Actor biographical data ──────────────────────────────


def phase_2a_actors(conn, dry_run=False):
    """Enrich person entries with birth/death/gender/bio from 2019 EDM actors dump."""
    log("Phase 2a: Actor biographical data from EDM dump")

    if not EDM_ACTORS_ZIP.exists():
        log(f"  ERROR: {EDM_ACTORS_ZIP} not found")
        return

    # Build name → person_id lookup from person_names table
    log("  Building name lookup from person_names...")
    name_to_ids = defaultdict(set)
    for person_id, name in conn.execute("SELECT person_id, name FROM person_names"):
        if name:
            name_to_ids[name].add(person_id)
    log(f"  Name lookup: {len(name_to_ids)} distinct names → {len(set().union(*name_to_ids.values()))} persons")

    # Parse EDM actors XML
    log("  Parsing EDM actors XML...")
    import zipfile

    # Collect all actor data keyed by prefLabel
    # actor_data: list of (prefLabel, altLabels, birth_year, death_year, gender, bio)
    actors = []
    with zipfile.ZipFile(EDM_ACTORS_ZIP) as z:
        with z.open(z.namelist()[0]) as f:
            # Iterparse to handle large file
            context = ET.iterparse(f, events=("end",))
            for event, elem in context:
                if elem.tag == f"{{{NS['edm']}}}Agent":
                    pref_label = None
                    alt_labels = []
                    birth = None
                    death = None
                    gender = None
                    bio = None

                    for child in elem:
                        tag = child.tag
                        if tag == f"{{{NS['skos']}}}prefLabel":
                            pref_label = child.text
                        elif tag == f"{{{NS['skos']}}}altLabel":
                            if child.text:
                                alt_labels.append(child.text)
                        elif tag == f"{{{NS['rdaGr2']}}}dateOfBirth":
                            birth = parse_year(child.text)
                        elif tag == f"{{{NS['rdaGr2']}}}dateOfDeath":
                            death = parse_year(child.text)
                        elif tag == f"{{{NS['rdaGr2']}}}gender":
                            gender = child.text
                        elif tag == f"{{{NS['rdaGr2']}}}biographicalInformation":
                            bio = clean_bio(child.text)

                    if pref_label:
                        # Count non-NULL fields for "most data wins" conflict resolution
                        richness = sum(
                            x is not None for x in (birth, death, gender, bio)
                        )
                        actors.append(
                            (pref_label, alt_labels, birth, death, gender, bio, richness)
                        )

                    # Free memory
                    elem.clear()

    log(f"  Parsed {len(actors)} actors from EDM dump")

    # Count field coverage
    has_birth = sum(1 for a in actors if a[2] is not None)
    has_death = sum(1 for a in actors if a[3] is not None)
    has_gender = sum(1 for a in actors if a[4] is not None)
    has_bio = sum(1 for a in actors if a[5] is not None)
    log(f"  Field coverage: birth={has_birth}, death={has_death}, gender={has_gender}, bio={has_bio}")

    # Match actors to vocab IDs
    # Group by vocab_id → keep the richest dump entry
    vocab_id_to_data = {}  # vocab_id → (birth, death, gender, bio, richness)

    matched = 0
    ambiguous = 0
    unmatched = 0

    for pref_label, alt_labels, birth, death, gender, bio, richness in actors:
        # Try prefLabel first
        candidate_ids = name_to_ids.get(pref_label, set())

        # Fallback to altLabels
        if not candidate_ids:
            for alt in alt_labels:
                candidate_ids = name_to_ids.get(alt, set())
                if candidate_ids:
                    break

        if not candidate_ids:
            unmatched += 1
            continue

        if len(candidate_ids) > 1:
            ambiguous += 1

        matched += 1

        for vid in candidate_ids:
            existing = vocab_id_to_data.get(vid)
            if existing is None or richness > existing[4]:
                vocab_id_to_data[vid] = (birth, death, gender, bio, richness)

    log(f"  Matched: {matched}, ambiguous: {ambiguous}, unmatched: {unmatched}")
    log(f"  Unique vocab IDs to update: {len(vocab_id_to_data)}")

    if dry_run:
        log(f"  [DRY RUN] Would update {len(vocab_id_to_data)} person entries")
        return

    # Apply updates — only fill NULLs per field
    updates = {"birth_year": 0, "death_year": 0, "gender": 0, "bio": 0}
    for vid, (birth, death, gender, bio, _) in vocab_id_to_data.items():
        if birth is not None:
            cur = conn.execute(
                "UPDATE vocabulary SET birth_year = ? WHERE id = ? AND birth_year IS NULL",
                (birth, vid),
            )
            updates["birth_year"] += cur.rowcount
        if death is not None:
            cur = conn.execute(
                "UPDATE vocabulary SET death_year = ? WHERE id = ? AND death_year IS NULL",
                (death, vid),
            )
            updates["death_year"] += cur.rowcount
        if gender is not None:
            cur = conn.execute(
                "UPDATE vocabulary SET gender = ? WHERE id = ? AND gender IS NULL",
                (gender, vid),
            )
            updates["gender"] += cur.rowcount
        if bio is not None:
            cur = conn.execute(
                "UPDATE vocabulary SET bio = ? WHERE id = ? AND bio IS NULL",
                (bio, vid),
            )
            updates["bio"] += cur.rowcount

    conn.commit()
    log(f"  Updates: {updates}")


# ─── Phase 2b: Wikidata links from 2025 person dump ─────────────────


def phase_2b_wikidata(conn, dry_run=False):
    """Enrich person entries with wikidata_id from 2025 person dump."""
    log("Phase 2b: Wikidata links from person dump")

    if not PERSON_EXTRACTED_DIR.exists():
        log("  ERROR: person_extracted/ directory not found")
        return

    # Load vocab person IDs for direct matching
    vocab_person_ids = set(
        r[0]
        for r in conn.execute("SELECT id FROM vocabulary WHERE type='person'").fetchall()
    )
    log(f"  Vocab persons: {len(vocab_person_ids)}")

    # Build name lookup for fallback matching
    name_to_ids = defaultdict(set)
    for person_id, name in conn.execute("SELECT person_id, name FROM person_names"):
        if name:
            name_to_ids[name].add(person_id)

    files = os.listdir(PERSON_EXTRACTED_DIR)
    log(f"  Person dump files: {len(files)}")

    # Collect wikidata_id updates: vocab_id → wikidata_qid
    wikidata_updates = {}
    direct_matches = 0
    name_matches = 0
    unmatched = 0

    for i, fname in enumerate(files):
        if i % 20000 == 0 and i > 0:
            log(f"  ... processed {i}/{len(files)} files")

        fpath = PERSON_EXTRACTED_DIR / fname
        try:
            text = fpath.read_text()
        except Exception:
            continue

        dump_id = fname  # filename IS the ID

        # Extract sameAs URIs
        wikidata_qid = None
        for m in RE_SCHEMA_SAME_AS.finditer(text):
            if m.group(1) == dump_id:
                uri = m.group(2)
                qm = RE_WIKIDATA_QID.search(uri)
                if qm:
                    wikidata_qid = qm.group(1)
                    break

        if not wikidata_qid:
            continue

        # Try direct ID match first
        if dump_id in vocab_person_ids:
            wikidata_updates[dump_id] = wikidata_qid
            direct_matches += 1
            continue

        # Fallback: name matching
        names = []
        for m in RE_SCHEMA_NAME.finditer(text):
            if m.group(1) == dump_id:
                names.append(m.group(2))
        for m in RE_SCHEMA_ALT_NAME.finditer(text):
            if m.group(1) == dump_id:
                names.append(m.group(2))

        matched_ids = set()
        for name in names:
            matched_ids.update(name_to_ids.get(name, set()))

        if matched_ids:
            name_matches += 1
            for vid in matched_ids:
                if vid not in wikidata_updates:
                    wikidata_updates[vid] = wikidata_qid
        else:
            unmatched += 1

    log(f"  Direct matches: {direct_matches}, name matches: {name_matches}, unmatched: {unmatched}")
    log(f"  Unique vocab IDs with Wikidata: {len(wikidata_updates)}")

    if dry_run:
        log(f"  [DRY RUN] Would update {len(wikidata_updates)} wikidata_id values")
        return

    updates = 0
    for vid, qid in wikidata_updates.items():
        cur = conn.execute(
            "UPDATE vocabulary SET wikidata_id = ? WHERE id = ? AND wikidata_id IS NULL",
            (qid, vid),
        )
        updates += cur.rowcount

    conn.commit()
    log(f"  Updated: {updates} wikidata_id values")


# ─── Phase 2c: Concept hierarchy from SKOS thesaurus ────────────────


def phase_2c_thesaurus(conn, dry_run=False):
    """Enrich classification entries with broader_id from 2019 SKOS thesaurus."""
    log("Phase 2c: Concept hierarchy from SKOS thesaurus")

    if not SKOS_THESAURUS_ZIP.exists():
        log(f"  ERROR: {SKOS_THESAURUS_ZIP} not found")
        return

    # Load existing external_id → vocab_id mapping for AAT matching
    aat_to_vocab = {}
    for vid, ext_id in conn.execute(
        "SELECT id, external_id FROM vocabulary WHERE external_id LIKE 'http://vocab.getty.edu/aat/%'"
    ):
        aat_to_vocab[ext_id] = vid

    # Load label_nl → vocab_id for fallback matching
    label_to_vocab = defaultdict(set)
    for vid, label in conn.execute(
        "SELECT id, label_nl FROM vocabulary WHERE type='classification' AND label_nl IS NOT NULL"
    ):
        label_to_vocab[label].add(vid)

    log(f"  AAT lookup: {len(aat_to_vocab)} entries, label lookup: {len(label_to_vocab)} labels")

    import zipfile

    concepts = []
    with zipfile.ZipFile(SKOS_THESAURUS_ZIP) as z:
        with z.open(z.namelist()[0]) as f:
            context = ET.iterparse(f, events=("end",))
            for event, elem in context:
                if elem.tag == f"{{{NS['skos']}}}Concept":
                    about = elem.get(f"{{{NS['rdf']}}}about", "")

                    # Extract thesaurus ID number from handle URI
                    thesaurus_id = about.rsplit(".", 1)[-1] if "THESAU." in about else None

                    pref_nl = None
                    broader_handle = None
                    exact_match_aat = None

                    for child in elem:
                        if child.tag == f"{{{NS['skos']}}}prefLabel":
                            lang = child.get(f"{{{NS['rdf']}}}" + "lang", child.get("{http://www.w3.org/XML/1998/namespace}lang", ""))
                            if lang == "nl" and child.text:
                                pref_nl = child.text
                        elif child.tag == f"{{{NS['skos']}}}broader":
                            broader_handle = child.get(f"{{{NS['rdf']}}}resource", "")
                        elif child.tag == f"{{{NS['skos']}}}exactMatch":
                            uri = child.get(f"{{{NS['rdf']}}}resource", "")
                            if "vocab.getty.edu/aat/" in uri:
                                exact_match_aat = uri

                    if broader_handle:
                        broader_thesaurus_id = (
                            broader_handle.rsplit(".", 1)[-1]
                            if "THESAU." in broader_handle
                            else None
                        )
                        concepts.append(
                            (thesaurus_id, pref_nl, exact_match_aat, broader_thesaurus_id)
                        )

                    elem.clear()

    log(f"  Parsed {len(concepts)} concepts with broader links")

    # Build thesaurus_id → vocab_id mapping
    # Strategy: match via AAT exactMatch first, then label_nl fallback
    thesaurus_to_vocab = {}

    for thesaurus_id, pref_nl, exact_match_aat, _ in concepts:
        if not thesaurus_id:
            continue
        # AAT match
        if exact_match_aat and exact_match_aat in aat_to_vocab:
            thesaurus_to_vocab[thesaurus_id] = aat_to_vocab[exact_match_aat]
        # Label fallback (only if unambiguous)
        elif pref_nl and pref_nl in label_to_vocab:
            ids = label_to_vocab[pref_nl]
            if len(ids) == 1:
                thesaurus_to_vocab[thesaurus_id] = next(iter(ids))

    log(f"  Thesaurus→vocab mapping: {len(thesaurus_to_vocab)} concepts matched")

    if dry_run:
        would_update = sum(
            1
            for tid, _, _, broader_tid in concepts
            if tid in thesaurus_to_vocab
            and broader_tid
            and broader_tid in thesaurus_to_vocab
        )
        log(f"  [DRY RUN] Would update: {would_update} broader_id values")
        return

    updates = 0
    for thesaurus_id, _, _, broader_thesaurus_id in concepts:
        if not thesaurus_id or not broader_thesaurus_id:
            continue
        vocab_id = thesaurus_to_vocab.get(thesaurus_id)
        broader_vocab_id = thesaurus_to_vocab.get(broader_thesaurus_id)
        if vocab_id and broader_vocab_id:
            cur = conn.execute(
                "UPDATE vocabulary SET broader_id = ? WHERE id = ? AND broader_id IS NULL",
                (broader_vocab_id, vocab_id),
            )
            updates += cur.rowcount

    conn.commit()
    log(f"  Updated: {updates} broader_id values")


# ─── Phase 3: Coordinate inheritance ────────────────────────────────


def phase_3_coord_inheritance(conn, dry_run=False):
    """Propagate coordinates from geocoded parents to ungeocoded children via broader_id."""
    log("Phase 3: Coordinate inheritance")

    max_depth = 10
    total_inherited = 0

    for depth in range(1, max_depth + 1):
        if dry_run:
            count = conn.execute(
                """SELECT COUNT(*) FROM vocabulary v
                   JOIN vocabulary p ON v.broader_id = p.id
                   WHERE v.type = 'place' AND v.lat IS NULL AND p.lat IS NOT NULL"""
            ).fetchone()[0]
            log(f"  [DRY RUN] Depth {depth}: {count} places would inherit coordinates")
            if count == 0:
                break
            total_inherited += count
        else:
            cur = conn.execute(
                """UPDATE vocabulary SET lat = (
                       SELECT p.lat FROM vocabulary p WHERE p.id = vocabulary.broader_id
                   ), lon = (
                       SELECT p.lon FROM vocabulary p WHERE p.id = vocabulary.broader_id
                   )
                   WHERE type = 'place'
                     AND lat IS NULL
                     AND broader_id IS NOT NULL
                     AND EXISTS (
                         SELECT 1 FROM vocabulary p
                         WHERE p.id = vocabulary.broader_id AND p.lat IS NOT NULL
                     )"""
            )
            inherited = cur.rowcount
            log(f"  Depth {depth}: {inherited} places inherited coordinates")
            if inherited == 0:
                break
            total_inherited += inherited

    conn.commit()
    log(f"  Total inherited: {total_inherited} places")


# ─── Phase 4: Validation ────────────────────────────────────────────


def phase_4_validation(conn):
    """Run validation checks and print summary stats."""
    log("Phase 4: Validation")

    # Column stats
    for col in ("birth_year", "death_year", "gender", "bio", "wikidata_id"):
        count = conn.execute(
            f"SELECT COUNT(*) FROM vocabulary WHERE {col} IS NOT NULL"
        ).fetchone()[0]
        log(f"  {col}: {count} non-NULL values")

    # Place hierarchy stats
    places_with_broader = conn.execute(
        "SELECT COUNT(*) FROM vocabulary WHERE type='place' AND broader_id IS NOT NULL"
    ).fetchone()[0]
    places_with_coords = conn.execute(
        "SELECT COUNT(*) FROM vocabulary WHERE type='place' AND lat IS NOT NULL"
    ).fetchone()[0]
    total_places = conn.execute(
        "SELECT COUNT(*) FROM vocabulary WHERE type='place'"
    ).fetchone()[0]
    log(f"  Places: {places_with_broader}/{total_places} have broader_id, {places_with_coords}/{total_places} have coordinates")

    # Gender distribution
    for row in conn.execute(
        "SELECT gender, COUNT(*) FROM vocabulary WHERE gender IS NOT NULL GROUP BY gender ORDER BY COUNT(*) DESC"
    ):
        log(f"  Gender '{row[0]}': {row[1]}")

    # Spot checks
    log("  Spot checks:")
    rembrandt = conn.execute(
        "SELECT id, label_en, birth_year, death_year, gender FROM vocabulary WHERE id = '2103429'"
    ).fetchone()
    if rembrandt:
        log(f"    Rembrandt (2103429): birth={rembrandt[2]}, death={rembrandt[3]}, gender={rembrandt[4]}")
    else:
        log("    Rembrandt (2103429): NOT FOUND")

    # Check for broader_id cycles
    cycles = conn.execute(
        "SELECT COUNT(*) FROM vocabulary WHERE broader_id = id"
    ).fetchone()[0]
    log(f"  Self-referencing broader_id: {cycles}")

    # DB size
    db_size = os.path.getsize(DB_PATH)
    log(f"  DB size: {db_size / 1024 / 1024:.1f} MB")


# ─── Post-enrichment: Indexes + version_info ────────────────────────


def create_indexes(conn):
    """Create indexes on new columns."""
    log("Creating indexes on new columns...")
    indexes = [
        ("idx_vocab_gender", "CREATE INDEX IF NOT EXISTS idx_vocab_gender ON vocabulary(gender) WHERE gender IS NOT NULL"),
        ("idx_vocab_birth_year", "CREATE INDEX IF NOT EXISTS idx_vocab_birth_year ON vocabulary(birth_year) WHERE birth_year IS NOT NULL"),
        ("idx_vocab_wikidata", "CREATE INDEX IF NOT EXISTS idx_vocab_wikidata ON vocabulary(wikidata_id) WHERE wikidata_id IS NOT NULL"),
    ]
    for name, sql in indexes:
        conn.execute(sql)
        log(f"  Created: {name}")
    conn.commit()


def update_version_info(conn):
    """Update version_info with enrichment metadata."""
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    conn.execute(
        "INSERT OR REPLACE INTO version_info (key, value) VALUES ('enriched_at', ?)",
        (now,),
    )
    conn.execute(
        "INSERT OR REPLACE INTO version_info (key, value) VALUES ('enrichment', 'actors+places+thesaurus')",
    )
    conn.execute(
        "UPDATE version_info SET value = ? WHERE key = 'built_at'",
        (now,),
    )
    conn.commit()
    log(f"  version_info updated: enriched_at={now}")


# ─── Main ────────────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(description="Enrich vocab DB from Rijksmuseum data dumps")
    parser.add_argument(
        "--phase",
        choices=PHASE_ORDER,
        help="Start from this phase (default: run all)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report what would change without writing to DB",
    )
    args = parser.parse_args()

    if not DB_PATH.exists():
        print(f"ERROR: {DB_PATH} not found")
        return 1

    start_phase = args.phase or "1"
    start_idx = PHASE_ORDER.index(start_phase)
    phases_to_run = PHASE_ORDER[start_idx:]

    log(f"Database: {DB_PATH} ({os.path.getsize(DB_PATH) / 1024 / 1024:.1f} MB)")
    log(f"Phases to run: {', '.join(phases_to_run)}")
    if args.dry_run:
        log("DRY RUN — no changes will be written")

    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")

    t0 = time.time()

    try:
        if "1" in phases_to_run:
            phase_1_schema(conn)

        if "2d" in phases_to_run:
            phase_2d_places(conn, dry_run=args.dry_run)

        if "2a" in phases_to_run:
            phase_2a_actors(conn, dry_run=args.dry_run)

        if "2b" in phases_to_run:
            phase_2b_wikidata(conn, dry_run=args.dry_run)

        if "2c" in phases_to_run:
            phase_2c_thesaurus(conn, dry_run=args.dry_run)

        if "3" in phases_to_run:
            phase_3_coord_inheritance(conn, dry_run=args.dry_run)

        if not args.dry_run and start_idx <= PHASE_ORDER.index("3"):
            create_indexes(conn)
            update_version_info(conn)

        if "4" in phases_to_run:
            phase_4_validation(conn)

    finally:
        conn.close()

    elapsed = time.time() - t0
    log(f"Done in {elapsed:.1f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
