#!/usr/bin/env python3
"""
Linked Art Schema Discovery — exhaustive field-path analysis for Rijksmuseum artworks.

Resolves a sample of artworks via the Linked Art API, recursively walks every path
in the JSON-LD tree, and reports:
  1. Every unique key path that exists, with type/cardinality/coverage stats
  2. Which paths the harvest script currently extracts vs which it ignores
  3. Value distributions for enumerated fields (type, classified_as URIs)
  4. Anomalies: unexpected types, missing expected paths, new top-level keys

The goal is to eliminate "stumbling across fields after the fact" — run this before
each harvest to get a complete map of what's available in the data.

Usage:
    python3 scripts/discover-linked-art-schema.py                    # 500 samples
    python3 scripts/discover-linked-art-schema.py --samples 1000     # more samples
    python3 scripts/discover-linked-art-schema.py --threads 12       # faster
    python3 scripts/discover-linked-art-schema.py --output report.md # custom output
    python3 scripts/discover-linked-art-schema.py --raw-json out.json # dump raw stats

Requires: vocabulary.db (for artwork URI lookup via Search API)
"""

import argparse
import json
import random
import sqlite3
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

# ─── Configuration ───────────────────────────────────────────────────

SCRIPT_DIR = Path(__file__).parent
PROJECT_DIR = SCRIPT_DIR.parent
DB_PATH = PROJECT_DIR / "data" / "vocabulary.db"

SEARCH_API = "https://data.rijksmuseum.nl/search/collection"
USER_AGENT = "rijksmuseum-mcp-discover/1.0"
DEFAULT_SAMPLES = 500
DEFAULT_THREADS = 8

# Maximum depth for recursive tree walk (Linked Art nests deeply but finitely)
MAX_DEPTH = 12

# LDES (Linked Data Event Stream) — used by --mode ldes
LDES_ROOT = "https://data.rijksmuseum.nl/ldes/collection.json"
LDES_CACHE_DIR = PROJECT_DIR / "data" / "ldes-cache"
LDES_REQUEST_INTERVAL_S = 1.0  # be a polite citizen — confirmed acceptable with operator
# Profiles whose @graph carries the inline JSON-LD payload we can walk.
# Skip `oai_dc` (bare-minimum), `la` and `edm` (n-triples, no inline payload).
LDES_FRAMED_PROFILES = {"la-framed", "edm-framed"}

# ─── Paths the harvest currently extracts ────────────────────────────
# Each entry is a dotted path ([] = array traversal) that resolve_artwork()
# or Phase 1/2 touches. Used for the "extracted vs ignored" diff.

HARVEST_EXTRACTED_PATHS = {
    # ─── Phase 4: resolve_artwork() — text + structured ─────────────────
    "referred_to_by[].classified_as[].id",       # text field classification
    "referred_to_by[].content",                   # inscriptions, provenance, credit, description
    "referred_to_by[].language[].id",             # language preference
    "dimension[].value",                          # dimension values
    "dimension[].unit.id",                        # dimension units
    "dimension[].classified_as[].id",             # dimension type (height/width)
    "produced_by.part[].technique[].id",          # production roles
    "produced_by.part[].classified_as[].id",      # attribution qualifiers (priority)
    "produced_by.part[].carried_out_by[].id",     # direct creator refs
    "produced_by.part[].assigned_by[].type",      # AttributeAssignment guard
    "produced_by.part[].assigned_by[].assigned_property",  # carried_out_by filter
    "produced_by.part[].assigned_by[].assigned[].id",      # assigned creator refs
    "produced_by.part[].assigned_by[].assigned[].type",    # Person/Group guard
    "produced_by.part[].assigned_by[].assigned[].formed_by.influenced_by[].id",  # inline Group
    "produced_by.part[].assigned_by[].classified_as[].id", # rich qualifiers
    "produced_by.referred_to_by[].classified_as[].id",     # production statement
    "produced_by.referred_to_by[].content",                # creator label text
    "produced_by.referred_to_by[].language[].id",          # creator label language
    "produced_by.timespan.begin_of_the_begin",   # date earliest
    "produced_by.timespan.end_of_the_end",       # date latest
    "identified_by[].type",                       # Name guard
    "identified_by[].content",                    # title variants (also feeds title_variants table)
    "subject_of[].language[].id",                 # narrative language
    "subject_of[].part[].classified_as[].id",     # narrative classification
    "subject_of[].part[].content",                # narrative text

    # ─── Phase 4: v0.24 extractors added 2026-04-26 (kintopp/...#275) ──
    # extract_dimension_note() → dimension_note column on artworks
    "dimension[].referred_to_by[].content",       # dimension annotations (e.g. "trimmed within plate mark")

    # extract_modifications() → modifications table
    "modified_by[]",                              # restoration/treatment events container
    "modified_by[].carried_out_by[]",             # restorer URIs (str or dict.id)
    "modified_by[].carried_out_by[].id",
    "modified_by[].timespan.begin_of_the_begin",  # treatment date range start
    "modified_by[].timespan.end_of_the_end",      # treatment date range end
    "modified_by[].timespan.identified_by[].content",  # date display
    "modified_by[].referred_to_by[].content",     # treatment description

    # extract_attributed_by() → related_objects + examinations tables
    "attributed_by[]",                            # peer-relationship + examination container
    "attributed_by[].assigned[].id",              # related artwork URIs
    "attributed_by[].identified_by[].content",    # relationship label text (recto/verso, etc.)
    "attributed_by[].carried_out_by[]",           # examiner — presence splits relations vs. examinations
    "attributed_by[].carried_out_by[].id",
    "attributed_by[].carried_out_by[].identified_by[].content",  # examiner name
    "attributed_by[].classified_as[].id",         # examination report type AAT
    "attributed_by[].classified_as[].identified_by[].content",   # report type label
    "attributed_by[].timespan.begin_of_the_begin",  # examination date range
    "attributed_by[].timespan.end_of_the_end",

    # extract_title_variants() → title_variants table (also overlaps with identified_by[].content above)
    "identified_by[].language[].id",              # title language
    "identified_by[].classified_as[].id",         # title qualifier (brief/full/display/former)

    # extract_part_of() → artwork_parent table
    "part_of[]",
    "part_of[].id",                               # parent HumanMadeObject URI
    "part_of[].type",                             # HumanMadeObject guard

    # extract_production_parts() top-level branch (#43 fix at harvest-vocabulary-db.py:2357-2360)
    # Top-level produced_by.assigned_by[] (NOT inside part[]) processed via
    # _process_assigned_by(..., -1). Same extraction logic as part-level, different entry.
    "produced_by.assigned_by[]",
    "produced_by.assigned_by[].type",
    "produced_by.assigned_by[].assigned_property",
    "produced_by.assigned_by[].assigned[]",
    "produced_by.assigned_by[].assigned[].id",
    "produced_by.assigned_by[].assigned[].type",
    "produced_by.assigned_by[].classified_as[].id",

    # ─── Phase 2: resolve_uri() for vocabulary entities ─────────────────
    "type",                                       # entity type
    "equivalent[].id",                            # external IDs (Wikidata)
    "defined_by",                                 # Place WKT geometry

    # ─── Phase 1: OAI-PMH (not JSON-LD, but for completeness) ───────────
    # "dc:identifier", "dc:title", "dc:subject", "dcterms:medium",
    # "dc:type", "dc:creator", "dcterms:spatial", "edmfp:technique",
    # "edm:rights", "edm:isShownBy", "edm:object"

    # ─── Structural paths the harvest traverses but doesn't store ──────
    "produced_by",
    "produced_by.part[]",
    "produced_by.timespan",
    "classified_as[].id",                         # top-level object classification
    "classified_as[]._label",                     # type label
    "member_of[].id",                             # collection sets (TypeScript only)
}


# ─── Resolution ──────────────────────────────────────────────────────

def get_sample_object_numbers(db_path: Path, n: int) -> list[str]:
    """Sample N random object numbers from the vocabulary database."""
    conn = sqlite3.connect(str(db_path))
    try:
        total = conn.execute("SELECT COUNT(*) FROM artworks").fetchone()[0]
        # Random sample using RANDOM() — faster than loading all + random.sample
        rows = conn.execute(
            "SELECT object_number FROM artworks ORDER BY RANDOM() LIMIT ?", (n,)
        ).fetchall()
        print(f"  Sampled {len(rows)} artworks from {total:,} total")
        return [r[0] for r in rows]
    finally:
        conn.close()


def search_api_lookup(object_number: str) -> str | None:
    """Look up the Linked Art URI for an object number via the Search API."""
    url = f"{SEARCH_API}?objectNumber={urllib.parse.quote(object_number)}"
    req = urllib.request.Request(url, headers={
        "Accept": "application/ld+json",
        "User-Agent": USER_AGENT,
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read())
        items = data.get("orderedItems", [])
        if items:
            item = items[0]
            return item.get("id") if isinstance(item, dict) else item
    except Exception:
        pass
    return None


def resolve_linked_art(uri: str) -> dict | None:
    """Resolve a Linked Art URI to its full JSON-LD document."""
    req = urllib.request.Request(uri, headers={
        "Accept": "application/ld+json",
        "Profile": "https://linked.art/ns/v1/linked-art.json",
        "User-Agent": USER_AGENT,
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        if e.code != 404:
            print(f"    HTTP {e.code} for {uri}", flush=True)
        return None
    except Exception as e:
        print(f"    Error for {uri}: {e}", flush=True)
        return None


def resolve_one(object_number: str) -> tuple[str, dict | None]:
    """Resolve a single artwork: Search API → Linked Art. Returns (object_number, data)."""
    uri = search_api_lookup(object_number)
    if not uri:
        return (object_number, None)
    data = resolve_linked_art(uri)
    return (object_number, data)


# ─── Tree Walking ────────────────────────────────────────────────────

class PathStats:
    """Tracks statistics for a single JSON path."""
    __slots__ = ("count", "types", "values", "array_lengths", "is_leaf")

    def __init__(self):
        self.count = 0             # how many artworks have this path
        self.types = Counter()     # Python type names seen at this path
        self.values = Counter()    # for short string/number values, track distribution
        self.array_lengths = []    # for array nodes, track lengths
        self.is_leaf = True        # True if no children observed

    def to_dict(self, total: int) -> dict:
        coverage = self.count / total if total else 0
        result = {
            "count": self.count,
            "coverage": f"{coverage:.1%}",
            "types": dict(self.types.most_common(10)),
            "is_leaf": self.is_leaf,
        }
        if self.array_lengths:
            lengths = self.array_lengths
            result["array_len"] = {
                "min": min(lengths),
                "max": max(lengths),
                "mean": f"{sum(lengths) / len(lengths):.1f}",
            }
        if self.values:
            # Show top 15 values for enumerated fields (URIs, types, etc.)
            top = self.values.most_common(15)
            if len(self.values) <= 15:
                result["values"] = dict(top)
            else:
                result["values_sample"] = dict(top)
                result["unique_values"] = len(self.values)
        return result


def walk_tree(data: dict, stats: dict[str, PathStats], depth: int = 0, prefix: str = ""):
    """Recursively walk a JSON-LD document, recording every path encountered."""
    if depth > MAX_DEPTH:
        return

    if isinstance(data, dict):
        for key, value in data.items():
            # Skip JSON-LD context/framing keys
            if key.startswith("@"):
                continue

            path = f"{prefix}.{key}" if prefix else key

            if path not in stats:
                stats[path] = PathStats()
            ps = stats[path]
            ps.count += 1  # will be deduplicated per-artwork later

            if isinstance(value, list):
                ps.types["list"] += 1
                ps.array_lengths.append(len(value))
                ps.is_leaf = False

                # Walk into array elements
                array_path = f"{path}[]"
                for item in value:
                    if array_path not in stats:
                        stats[array_path] = PathStats()

                    if isinstance(item, dict):
                        stats[array_path].types["dict"] += 1
                        stats[array_path].is_leaf = False
                        walk_tree(item, stats, depth + 1, array_path)
                    elif isinstance(item, str):
                        stats[array_path].types["str"] += 1
                        stats[array_path].count += 1
                        # Track short string values (URIs, type labels)
                        if len(item) < 200:
                            stats[array_path].values[item] += 1
                    else:
                        stats[array_path].types[type(item).__name__] += 1
                        stats[array_path].count += 1

            elif isinstance(value, dict):
                ps.types["dict"] += 1
                ps.is_leaf = False
                walk_tree(value, stats, depth + 1, path)

            elif isinstance(value, str):
                ps.types["str"] += 1
                if len(value) < 200:
                    ps.values[value] += 1

            elif isinstance(value, (int, float)):
                ps.types[type(value).__name__] += 1
                ps.values[str(value)] += 1

            elif isinstance(value, bool):
                ps.types["bool"] += 1
                ps.values[str(value)] += 1

            elif value is None:
                ps.types["null"] += 1

            else:
                ps.types[type(value).__name__] += 1

    # (lists and primitives at top level are handled by the caller)


def walk_artwork(data: dict, global_stats: dict[str, PathStats],
                 per_artwork_paths: set[str], depth: int = 0, prefix: str = ""):
    """Walk an artwork JSON-LD tree, tracking which paths this artwork contributes to.

    Uses per_artwork_paths to ensure each path is only counted once per artwork
    in the global coverage stats (count field).
    """
    if depth > MAX_DEPTH:
        return

    if isinstance(data, dict):
        for key, value in data.items():
            if key.startswith("@"):
                continue

            path = f"{prefix}.{key}" if prefix else key

            if path not in global_stats:
                global_stats[path] = PathStats()
            ps = global_stats[path]

            # Count this artwork once for this path
            if path not in per_artwork_paths:
                per_artwork_paths.add(path)
                ps.count += 1

            if isinstance(value, list):
                ps.types["list"] += 1
                ps.array_lengths.append(len(value))
                ps.is_leaf = False

                array_path = f"{path}[]"
                if array_path not in global_stats:
                    global_stats[array_path] = PathStats()

                # Count array-level once per artwork
                if array_path not in per_artwork_paths:
                    per_artwork_paths.add(array_path)
                    global_stats[array_path].count += 1

                for item in value:
                    if isinstance(item, dict):
                        global_stats[array_path].types["dict"] += 1
                        global_stats[array_path].is_leaf = False
                        walk_artwork(item, global_stats, per_artwork_paths, depth + 1, array_path)
                    elif isinstance(item, str):
                        global_stats[array_path].types["str"] += 1
                        if len(item) < 200:
                            global_stats[array_path].values[item] += 1
                    else:
                        global_stats[array_path].types[type(item).__name__] += 1

            elif isinstance(value, dict):
                ps.types["dict"] += 1
                ps.is_leaf = False
                walk_artwork(value, global_stats, per_artwork_paths, depth + 1, path)

            elif isinstance(value, str):
                ps.types["str"] += 1
                if len(value) < 200:
                    ps.values[value] += 1

            elif isinstance(value, (int, float)):
                ps.types[type(value).__name__] += 1
                ps.values[str(value)] += 1

            elif isinstance(value, bool):
                ps.types["bool"] += 1
                ps.values[str(value)] += 1

            elif value is None:
                ps.types["null"] += 1

            else:
                ps.types[type(value).__name__] += 1


# ─── Feature Synthesis ────────────────────────────────────────────────

# Each feature definition: (name, root path prefix, description template, harvest status note)
# The synthesizer finds all ignored paths under each root and computes coverage from the
# root path's stats. Features are ordered by coverage descending.

FEATURE_DEFINITIONS = [
    {
        "name": "Materials (Linked Art)",
        "roots": ["made_of"],
        "description": (
            "Materials as Linked Art entities with full structure (identifiers, notations, "
            "equivalences). Currently harvested via OAI-PMH `dcterms:medium` as bare URIs, "
            "which are resolved in Phase 2. The Linked Art version has the same data inline, "
            "plus `notation` codes on ~16% of artworks. No new information unless notation "
            "codes are needed."
        ),
        "harvest_status": (
            "Already harvested via Phase 1 OAI-PMH. Linked Art version is redundant "
            "unless inline notation codes are needed for a specific use case."
        ),
    },
    {
        "name": "Production Places (inline entities)",
        "roots": ["produced_by.part[].took_place_at"],
        "description": (
            "Production places as full Linked Art Place entities nested inside production "
            "parts. Contains the same place URIs harvested via OAI-PMH `dcterms:spatial`, "
            "but inline with their notation codes and possibly richer structure. "
            "Place URIs are already resolved in Phase 2."
        ),
        "harvest_status": (
            "Place URIs already harvested via OAI-PMH + Phase 2 resolution. Inline "
            "structure is redundant unless notation codes or geometry are needed per "
            "production-part (not just per artwork)."
        ),
    },
    {
        "name": "Cataloguing Provenance (who wrote it, when)",
        "roots": ["referred_to_by[].created_by", "subject_of[].created_by"],
        "description": (
            "Metadata about who authored or last edited each textual statement and when. "
            "Appears on `referred_to_by` entries (descriptions, inscriptions, credit lines, "
            "provenance text) at ~60% coverage, and on `subject_of` entries (curatorial "
            "narratives) at ~1% coverage. The `timespan` gives ISO-8601 dates. This is "
            "cataloguing provenance — when was each piece of textual metadata last touched?"
        ),
        "harvest_status": (
            "Not harvested. Potential value: tracking catalogue freshness, identifying "
            "recently revised descriptions, filtering by description authorship date."
        ),
    },
    {
        "name": "Attribution Motivation (evidence chain)",
        "roots": [
            "produced_by.part[].assigned_by[].motivated_by",
        ],
        "description": (
            "What motivated the attribution decision. The `motivated_by` field links to "
            "objects (often publications via `carried_by`) that served as evidence for "
            "the attribution. This is citation provenance for who-made-what decisions."
        ),
        "harvest_status": (
            "Not harvested. Potential value: building an evidence graph for attributions, "
            "linking attributions to scholarly publications."
        ),
    },
    {
        "name": "Top-level `assigned_by` (bibliography links)",
        "roots": ["assigned_by"],
        "description": (
            "Object-level attribution assignments — distinct from `produced_by.part[].assigned_by` "
            "(which is creator attribution inside production events). These have "
            "`assigned_property: \"referred_to_by\"` and point to bibliographic references "
            "with page numbers (`part_of`, `identified_by[].part[].content`). This is "
            "structured bibliography: which publications reference this artwork, and at "
            "which page/plate/catalogue number."
        ),
        "harvest_status": (
            "Not harvested. Currently only `bibliographyCount` is computed (a count of "
            "`assigned_by` entries classified as citations). The actual reference content "
            "(publication URI, page numbers, reference text) is discarded."
        ),
    },
    {
        "name": "Top-level `attributed_by` (artwork relationships)",
        "roots": ["attributed_by"],
        "description": (
            "Artwork-to-artwork relationships. Each entry has `assigned[].id` pointing to "
            "a related artwork (type `HumanMadeObject`) and `identified_by[].content` with "
            "a relationship label. Labels include 'related object', 'recto | verso', "
            "'object | voormalige lijst' (former frame). Some entries have `carried_out_by` "
            "(examiner) and `timespan` (examination date) — these are condition reports, "
            "not similarity relationships."
        ),
        "harvest_status": (
            "Not harvested. TypeScript `parseRelatedObjects()` reads this at resolution time "
            "but does not store it. Relationship labels are generic — mostly 'related object' "
            "which includes frames, recto/verso, and genuine thematic links without "
            "distinction. Value for similarity search ground truth is limited without "
            "sub-classifying the relationship types."
        ),
    },
    {
        "name": "`part_of` (physical containment)",
        "roots": ["part_of"],
        "description": (
            "Physical containment relationships — this artwork is part of a larger object "
            "(e.g., a page in a book, a panel in a diptych, a tile in a set). Points to "
            "a parent `HumanMadeObject`."
        ),
        "harvest_status": (
            "Not harvested. Potential value: navigating multi-part objects, linking album "
            "pages to their albums, panels to polyptychs."
        ),
    },
    {
        "name": "Statement Identifiers (sequence numbers)",
        "roots": ["referred_to_by[].identified_by[].content"],
        "description": (
            "Sequence numbers on `referred_to_by` entries. Values are mostly '1', '2', '3' "
            "— ordinal identifiers for the position of each statement within the artwork's "
            "description block."
        ),
        "harvest_status": (
            "Not harvested. Low value — only useful if statement ordering matters."
        ),
    },
    {
        "name": "Notation codes (entity identifiers)",
        "roots": [
            "classified_as[].notation",
            "identified_by[].classified_as[].notation",
            "dimension[].classified_as[].notation",
            "produced_by.part[].technique[].notation",
            "produced_by.part[].carried_out_by[].notation",
            "produced_by.part[].assigned_by[].assigned[].notation",
        ],
        "description": (
            "Structured notation identifiers on entities at various nesting levels — "
            "classifications, techniques, creators, attribution targets. These are "
            "registry codes (AAT numbers, Rijksmuseum internal codes) embedded inline "
            "in the Linked Art entity descriptions. Appear on ~17% of artworks for "
            "techniques and ~9% for creators."
        ),
        "harvest_status": (
            "Not harvested. Low value — the same codes are already available via the "
            "`vocabulary.external_id` column (resolved in Phase 2)."
        ),
    },
    {
        "name": "Dimension annotations",
        "roots": ["dimension[].referred_to_by[].content"],
        "description": (
            "Textual annotations on dimensions. Contains notes like 'binnen plaatrand "
            "afgesneden' (trimmed within plate mark), 'maximale breedte' (maximum width), "
            "'drager' (support). These qualify how the measurement was taken."
        ),
        "harvest_status": (
            "Not harvested. Potential value: disambiguating dimension semantics (plate mark "
            "vs image vs support). Currently dimensions are stored as raw height_cm/width_cm "
            "without qualification notes."
        ),
    },
    {
        "name": "Production tool/object type",
        "roots": ["produced_by.part[].used_object_of_type"],
        "description": (
            "The type of tool or object used in production (e.g., a specific plate, "
            "a press, a mould). Points to a Type entity."
        ),
        "harvest_status": (
            "Not harvested. Potential value for printmaking research — identifying which "
            "plate was used, linking impressions to their plate."
        ),
    },
    {
        "name": "Identifier provenance (`identified_by[].assigned_by`)",
        "roots": ["identified_by[].assigned_by"],
        "description": (
            "Provenance of identifier assignments — who assigned each object number or "
            "catalogue identifier, with `assigned_property: \"influenced_by\"`. Links "
            "identifiers to their authoritative source."
        ),
        "harvest_status": (
            "Not harvested. Low value for current use cases."
        ),
    },
    {
        "name": "Identifier physical carrier (`identified_by[].carried_by`)",
        "roots": ["identified_by[].carried_by"],
        "description": (
            "Physical objects that carry an identifier (e.g., a label, a tag, a stamp "
            "on the artwork). Points to HumanMadeObject URIs."
        ),
        "harvest_status": (
            "Not harvested. Niche use case — provenance research on physical labels."
        ),
    },
    {
        "name": "Production composition (`produced_by.assigned_by`)",
        "roots": ["produced_by.assigned_by"],
        "description": (
            "Attribution assignments at the `produced_by` level (not inside `part[]`). "
            "These have `assigned_property: \"part_of\"` and assign full production sub-events "
            "with technique, creator, and place. Appears on ~4% of artworks — likely "
            "complex multi-stage productions (e.g., photography with separate printing)."
        ),
        "harvest_status": (
            "Not harvested. Low coverage (4%). The production parts inside are similar "
            "to `produced_by.part[]` but wrapped in an additional AttributeAssignment "
            "layer. May contain creator names not captured by the standard part[] path."
        ),
    },
    {
        "name": "Multi-phase timespan (list variant)",
        "roots": ["produced_by.timespan[]"],
        "description": (
            "When `produced_by.timespan` is a list instead of a dict, each element "
            "represents a separate production phase with its own date range. ~2.4% of "
            "artworks have this. The harvest already handles this case (takes min/max "
            "across phases for widest date range), but the individual phase dates appear "
            "as 'ignored' because they're accessed via the list-handling code path."
        ),
        "harvest_status": (
            "Already handled by harvest — `resolve_artwork()` detects list timespans "
            "and takes the widest range (min begin, max end). Individual phase dates "
            "are collapsed into a single date_earliest/date_latest pair."
        ),
    },
    {
        "name": "Narrative sub-parts (`subject_of[].part[].part`)",
        "roots": ["subject_of[].part[].part"],
        "description": (
            "Nested sub-sections within the curatorial narrative. Contains structured "
            "text subdivisions (e.g., separate paragraphs or sections of the wall text). "
            "~1% coverage."
        ),
        "harvest_status": (
            "Not harvested. Low coverage. The parent `subject_of[].part[].content` already "
            "captures the narrative text."
        ),
    },
]


def synthesize_features(stats: dict[str, "PathStats"], total: int) -> list[dict]:
    """Group ignored paths into coherent data features with coverage and value assessment."""
    features = []

    for fdef in FEATURE_DEFINITIONS:
        # Collect all ignored paths under this feature's roots
        feature_paths = []
        for path, ps in stats.items():
            if classify_path(path) != "ignored":
                continue
            if any(path == root or path.startswith(root + ".") or path.startswith(root + "[")
                   for root in fdef["roots"]):
                feature_paths.append((path, ps))

        if not feature_paths:
            continue

        # Coverage = max coverage among the feature's root paths
        root_coverage = 0
        for root in fdef["roots"]:
            if root in stats:
                root_coverage = max(root_coverage, stats[root].count)
            # Also check with [] suffix
            root_arr = root + "[]"
            if root_arr in stats:
                root_coverage = max(root_coverage, stats[root_arr].count)

        if root_coverage == 0:
            # Try the first feature path
            root_coverage = max(ps.count for _, ps in feature_paths)

        coverage_pct = root_coverage / total if total else 0
        coverage_str = f"{root_coverage}/{total} ({coverage_pct:.0%})"

        # Collect interesting sample values from leaf paths
        sample_values = []
        for path, ps in feature_paths:
            if ps.values and ps.is_leaf:
                top = ps.values.most_common(3)
                for val, count in top:
                    if len(val) < 100 and val not in sample_values:
                        sample_values.append(val)
                        if len(sample_values) >= 6:
                            break
                if len(sample_values) >= 6:
                    break

        features.append({
            "name": fdef["name"],
            "coverage": coverage_str,
            "description": fdef["description"],
            "harvest_status": fdef["harvest_status"],
            "paths": [p for p, _ in sorted(feature_paths, key=lambda x: -x[1].count)],
            "sample_values": sample_values,
            "coverage_num": coverage_pct,
        })

    # Sort by coverage descending
    features.sort(key=lambda f: -f["coverage_num"])
    return features


# ─── Report Generation ───────────────────────────────────────────────

def classify_path(path: str) -> str:
    """Classify a path as 'extracted', 'structural', 'scaffolding', or 'ignored'.

    - extracted: directly read by the harvest and stored in the DB
    - structural: an ancestor of an extracted path (traversed to reach it)
    - scaffolding: JSON-LD structural fields (id, type, _label) at any level,
      or deeply nested paths inside entities already harvested via Phase 1/2
    - ignored: data paths present in Linked Art but not touched by the harvest

    Context-aware override (added 2026-04-26, kintopp/rijksmuseum-mcp-plus-offline#275):
    Paths whose ancestor includes one of EVIDENCE_DATA_PARENTS treat their
    descendant ENTITY_INTERNAL_KEYS as data, not scaffolding. The 2026-03-10
    run misclassified `motivated_by[].classified_as[]` (evidence-type AAT
    vocabulary — see v0.25-schema-decisions.md §S5) under the generic
    deep-entity-internal-key rule. Live probe 2026-04-26 disproved that
    classification.
    """
    if path in HARVEST_EXTRACTED_PATHS:
        return "extracted"

    # Check if it's a prefix of an extracted path (structural traversal)
    for ep in HARVEST_EXTRACTED_PATHS:
        if ep.startswith(path + ".") or ep.startswith(path + "[]"):
            return "structural"

    # JSON-LD scaffolding: id, type, _label at any nesting level
    leaf = path.rsplit(".", 1)[-1] if "." in path else path
    # Strip trailing [] for array element paths
    leaf_clean = leaf.rstrip("[]")
    if leaf_clean in JSONLD_SCAFFOLDING:
        return "scaffolding"

    # Paths inside entities that are already harvested via Phase 1 OAI-PMH or
    # Phase 2 vocab resolution (we only need their IDs, not their internal structure).
    for prefix in PHASE1_ENTITY_PREFIXES:
        if path.startswith(prefix):
            return "scaffolding"

    segments = path.replace("[]", "").split(".")

    # Context-aware: inside evidence-data parents (motivated_by, modified_by,
    # attributed_by, assigned_by), descendant ENTITY_INTERNAL_KEYS carry data
    # semantics (e.g. AAT evidence-type codes). Skip the deep-segment and
    # 2-occurrence scaffolding rules so these paths reach IGNORED for triage.
    in_evidence_context = any(seg in EVIDENCE_DATA_PARENTS for seg in segments[:-1])

    if not in_evidence_context:
        # Linked Art recursive self-description: entities that contain their own
        # identified_by, classified_as, etc. These are structural verbose patterns,
        # not new data fields. Detect via deeply nested entity-internal paths.
        # E.g., identified_by[].identified_by[] = identifiers having identifiers
        #        classified_as[].classified_as[] = classifications of classifications
        #        referred_to_by[].language[].identified_by[] = language entity internals
        for key in ENTITY_INTERNAL_KEYS:
            # Count how many times this key appears in the path (at any depth)
            occurrences = path.count(f".{key}") + (1 if path.startswith(f"{key}") else 0)
            if occurrences >= 2:
                return "scaffolding"

        # Deeply nested sub-entity descriptions (depth ≥ 3 dot-segments and ending in
        # a known entity-internal key) are almost always Linked Art verbosity.
        # Depth 3+ catches e.g. referred_to_by[].identified_by[].content
        if len(segments) >= 3 and segments[-1] in ENTITY_INTERNAL_KEYS:
            return "scaffolding"

    # Entity-internal paths at any depth that start with an entity-internal key
    # directly under a known entity (e.g., identified_by[].classified_as is
    # "what type of identifier is this?" — structural, not data we'd harvest).
    # This rule still applies inside evidence context to catch true type-discriminator
    # envelopes, but only when the parent is itself a structural container.
    if len(segments) >= 2 and segments[-1] in ENTITY_INTERNAL_KEYS:
        parent = segments[-2]
        if parent in ENTITY_INTERNAL_KEYS or parent in ENTITY_CONTAINERS:
            # Don't fire inside evidence context if the path's grandparent is
            # an evidence parent — that's the motivated_by[].classified_as case.
            if not in_evidence_context:
                return "scaffolding"

    return "ignored"


# Containers where descendant ENTITY_INTERNAL_KEYS (notably classified_as[])
# carry actual data semantics rather than scaffolding. Without this list, the
# generic deep-entity-internal-key rule misclassifies real evidence-type
# vocabularies (e.g. AAT codes inside motivated_by[].classified_as[]) as
# structural plumbing and filters them out of the IGNORED triage list.
# See kintopp/rijksmuseum-mcp-plus-offline#275 and v0.25-schema-decisions.md §S5.
EVIDENCE_DATA_PARENTS = {
    "motivated_by",   # attribution-evidence type (S5)
    "modified_by",    # conservation event type (S4)
    "attributed_by",  # peer-relationship type (S2)
    "assigned_by",    # AttributeAssignment context — partial v0.24 extract; rest still IGNORED-worthy
}


# Keys that are internal to Linked Art entity descriptions
ENTITY_INTERNAL_KEYS = {
    "identified_by", "classified_as", "equivalent", "conforms_to",
    "referred_to_by", "language", "format", "access_point",
    "digitally_carried_by", "digitally_available_via",
    "subject_to",  # rights/restrictions
}

# Linked Art entity containers (arrays of entities that can have internal structure)
ENTITY_CONTAINERS = {
    "dimension", "member_of", "subject_of", "made_of",
    "representation", "current_owner", "current_location",
    "shows", "carries", "about",
}


# JSON-LD structural fields that appear at every nesting level
JSONLD_SCAFFOLDING = {
    "id", "type", "_label", "@context",
    # Linked Art internal reference patterns
    "conforms_to",  # API conformance
    # Rijksmuseum-specific: `notation` on inline entities is a multilingual
    # label container (e.g. notation: [{"@language": "nl", "@value":
    # "schilderij"}, {"@language": "en", "@value": "painting"}]) — not a
    # Linked Art Identifier notation code. Phase 2 already harvests the same
    # text into vocabulary.label_en / vocabulary.label_nl, so we'd never
    # extract this. Verified 2026-04-26 against SK-C-5 / SK-A-2330 /
    # RP-T-1979-229-A. See offline/drafts/v0.25-schema-decisions.md §"2026-04-26
    # reframing" and the suspicious-paths characterisation.
    "notation",
    # JSON-LD multilingual value container leaves (used inside `notation` arrays
    # and any other multilingual property the Rijksmuseum API surfaces).
    "@language", "@value",
}

# Prefixes for entities whose IDs are already harvested via Phase 1 OAI-PMH
# or Phase 2 vocab resolution. Their internal structure (identified_by, etc.)
# is resolved by Phase 2 when needed — we don't need to traverse them in Phase 4.
PHASE1_ENTITY_PREFIXES = {
    # Technique entities nested inside produced_by
    "produced_by.technique",
    # Material entities at top level (harvested via dcterms:medium)
    "made_of[].id",
    "made_of[].type",
    "made_of[].identified_by",
    "made_of[]._label",
    # Classification entities (harvested via dc:type, dc:subject)
    "classified_as[].identified_by",
    "classified_as[].equivalent",
    # Creator entities inside produced_by.part (harvested via dc:creator)
    "produced_by.part[].carried_out_by[].identified_by",
    "produced_by.part[].carried_out_by[].classified_as",
    "produced_by.part[].carried_out_by[].equivalent",
    "produced_by.part[].carried_out_by[]._label",
    "produced_by.part[].carried_out_by[].type",
    # Technique entities inside production parts
    "produced_by.part[].technique[].identified_by",
    "produced_by.part[].technique[]._label",
    "produced_by.part[].technique[].type",
    # Classification entities inside production parts
    "produced_by.part[].classified_as[].identified_by",
    "produced_by.part[].classified_as[]._label",
    "produced_by.part[].classified_as[].type",
    # member_of entity internals (collection sets)
    "member_of[].type",
    "member_of[]._label",
    "member_of[].identified_by",
    # equivalent entity internals
    "equivalent[].type",
    "equivalent[]._label",
    # dimension entity internals already harvested
    "dimension[].unit.type",
    "dimension[].unit._label",
    "dimension[].classified_as[]._label",
    "dimension[].classified_as[].type",
    # subject_of entity internals (narrative container)
    "subject_of[].type",
    "subject_of[]._label",
    "subject_of[].id",
    "subject_of[].conforms_to",
    "subject_of[].part[].type",
    "subject_of[].part[]._label",
    # referred_to_by entity internals
    "referred_to_by[].type",
    "referred_to_by[]._label",
    "referred_to_by[].classified_as[]._label",
    "referred_to_by[].classified_as[].type",
    # identified_by entity internals
    "identified_by[]._label",
    "identified_by[].classified_as[]._label",
    "identified_by[].classified_as[].type",
    "identified_by[].language[]._label",
    "identified_by[].language[].type",
    # produced_by.referred_to_by internals
    "produced_by.referred_to_by[].type",
    "produced_by.referred_to_by[]._label",
    "produced_by.referred_to_by[].classified_as[]._label",
    "produced_by.referred_to_by[].classified_as[].type",
    "produced_by.referred_to_by[].language[]._label",
    "produced_by.referred_to_by[].language[].type",
    # timespan internals
    "produced_by.timespan.identified_by",
    # produced_by internal structure
    "produced_by.part[].type",
    "produced_by.part[]._label",
    # produced_by.part[].identified_by — production part identifiers (internal)
    "produced_by.part[].identified_by",
    "produced_by.part[].referred_to_by",
    # assigned_by entity internals
    "produced_by.part[].assigned_by[].identified_by",
    "produced_by.part[].assigned_by[]._label",
    "produced_by.part[].assigned_by[].type",
    "produced_by.part[].assigned_by[].assigned[].identified_by",
    "produced_by.part[].assigned_by[].assigned[]._label",
    "produced_by.part[].assigned_by[].classified_as[]._label",
    "produced_by.part[].assigned_by[].classified_as[].type",
    "produced_by.part[].assigned_by[].assigned[].formed_by",
    # subject_of digitally_carried_by (IIIF manifest URLs — internal)
    "subject_of[].digitally_carried_by",
    # dimension internal identifiers
    "dimension[].identified_by",
    # representation (IIIF image references — harvested via OAI-PMH edm:isShownBy)
    "representation",
    # current_owner / current_location (always Rijksmuseum — no data value)
    "current_owner",
    "current_location",
    # shows / carries (visual/textual content — Linked Art structural, not data)
    "shows",
    "carries",
    # about (subject references — already harvested via dc:subject)
    "about",
}


def generate_report(stats: dict[str, PathStats], total_resolved: int,
                    total_failed: int, elapsed: float) -> str:
    """Generate the markdown discovery report."""
    lines = []
    lines.append("# Linked Art Schema Discovery Report")
    lines.append("")
    lines.append(f"- **Date:** {time.strftime('%Y-%m-%d %H:%M')}")
    lines.append(f"- **Artworks resolved:** {total_resolved}")
    lines.append(f"- **Resolution failures:** {total_failed}")
    lines.append(f"- **Elapsed:** {elapsed:.0f}s ({elapsed/60:.1f}min)")
    lines.append(f"- **Unique paths discovered:** {len(stats)}")
    lines.append("")

    # ── Section 1: Top-level keys ──
    lines.append("## 1. Top-Level Keys")
    lines.append("")
    top_keys = sorted(
        [(p, s) for p, s in stats.items() if "." not in p and "[]" not in p],
        key=lambda x: -x[1].count
    )
    lines.append(f"| Key | Coverage | Types | Status |")
    lines.append(f"|-----|----------|-------|--------|")
    for path, ps in top_keys:
        cov = f"{ps.count}/{total_resolved} ({ps.count/total_resolved:.0%})"
        types = ", ".join(f"{t}({n})" for t, n in ps.types.most_common(3))
        status = classify_path(path)
        marker = {"extracted": "harvested", "structural": "traversed", "ignored": "**IGNORED**", "scaffolding": "scaffolding"}[status]
        lines.append(f"| `{path}` | {cov} | {types} | {marker} |")
    lines.append("")

    # ── Section 2: Ignored paths with significant coverage ──
    lines.append("## 2. Ignored Paths (≥5% coverage)")
    lines.append("")
    lines.append("These paths exist on a meaningful fraction of artworks but are not")
    lines.append("extracted by the harvest script. Review for potential data value.")
    lines.append("")

    threshold = max(1, int(total_resolved * 0.05))
    ignored = sorted(
        [(p, s) for p, s in stats.items()
         if classify_path(p) == "ignored" and s.count >= threshold],
        key=lambda x: -x[1].count
    )

    if ignored:
        lines.append(f"| Path | Coverage | Types | Leaf? | Sample Values |")
        lines.append(f"|------|----------|-------|-------|---------------|")
        for path, ps in ignored:
            cov = f"{ps.count}/{total_resolved} ({ps.count/total_resolved:.0%})"
            types = ", ".join(f"{t}({n})" for t, n in ps.types.most_common(3))
            leaf = "yes" if ps.is_leaf else "no"
            vals = ""
            if ps.values:
                top3 = ps.values.most_common(3)
                vals = "; ".join(f"`{v}`({n})" for v, n in top3)
                if len(vals) > 80:
                    vals = vals[:77] + "..."
            lines.append(f"| `{path}` | {cov} | {types} | {leaf} | {vals} |")
        lines.append("")
    else:
        lines.append("*None found — all paths with ≥5% coverage are already harvested.*")
        lines.append("")

    # ── Section 3: Ignored paths with low coverage (1-5%) ──
    lines.append("## 3. Ignored Paths (1–5% coverage)")
    lines.append("")

    low_threshold = max(1, int(total_resolved * 0.01))
    ignored_low = sorted(
        [(p, s) for p, s in stats.items()
         if classify_path(p) == "ignored"
         and low_threshold <= s.count < threshold],
        key=lambda x: -x[1].count
    )

    if ignored_low:
        lines.append(f"| Path | Coverage | Types | Sample Values |")
        lines.append(f"|------|----------|-------|---------------|")
        for path, ps in ignored_low:
            cov = f"{ps.count}/{total_resolved} ({ps.count/total_resolved:.0%})"
            types = ", ".join(f"{t}({n})" for t, n in ps.types.most_common(3))
            vals = ""
            if ps.values:
                top3 = ps.values.most_common(3)
                vals = "; ".join(f"`{v}`({n})" for v, n in top3)
                if len(vals) > 80:
                    vals = vals[:77] + "..."
            lines.append(f"| `{path}` | {cov} | {types} | {vals} |")
        lines.append("")
    else:
        lines.append("*None found.*")
        lines.append("")

    # ── Section 4: classified_as URI inventory ──
    lines.append("## 4. `classified_as` URI Inventory")
    lines.append("")
    lines.append("All URIs seen in any `classified_as[].id` path, with frequency.")
    lines.append("")

    # Collect all classified_as URI values across all paths
    ca_uris = Counter()
    for path, ps in stats.items():
        if path.endswith("classified_as[].id") or path.endswith("classified_as[]"):
            for val, count in ps.values.items():
                if val.startswith("http"):
                    ca_uris[val] += count

    if ca_uris:
        lines.append(f"| URI | Count |")
        lines.append(f"|-----|-------|")
        for uri, count in ca_uris.most_common(50):
            lines.append(f"| `{uri}` | {count:,} |")
        if len(ca_uris) > 50:
            lines.append(f"| ... | ({len(ca_uris) - 50} more) |")
        lines.append("")
    else:
        lines.append("*No classified_as URIs found.*")
        lines.append("")

    # ── Section 5: attributed_by deep dive ──
    lines.append("## 5. `attributed_by` Deep Dive")
    lines.append("")
    lines.append("Paths under top-level `attributed_by` — the artwork-to-artwork")
    lines.append("relationship field that the harvest currently ignores.")
    lines.append("")

    ab_paths = sorted(
        [(p, s) for p, s in stats.items()
         if p.startswith("attributed_by")],
        key=lambda x: (-x[1].count, x[0])
    )
    if ab_paths:
        lines.append(f"| Path | Coverage | Types | Sample Values |")
        lines.append(f"|------|----------|-------|---------------|")
        for path, ps in ab_paths:
            cov = f"{ps.count}/{total_resolved} ({ps.count/total_resolved:.0%})"
            types = ", ".join(f"{t}({n})" for t, n in ps.types.most_common(3))
            vals = ""
            if ps.values:
                top3 = ps.values.most_common(3)
                vals = "; ".join(f"`{v}`({n})" for v, n in top3)
                if len(vals) > 80:
                    vals = vals[:77] + "..."
            lines.append(f"| `{path}` | {cov} | {types} | {vals} |")
        lines.append("")
    else:
        lines.append("*`attributed_by` not present in any sampled artwork.*")
        lines.append("")

    # ── Section 6: Type anomalies ──
    lines.append("## 6. Type Anomalies")
    lines.append("")
    lines.append("Paths where multiple Python types were observed (e.g., sometimes")
    lines.append("dict, sometimes string — indicates shape inconsistency).")
    lines.append("")

    anomalies = sorted(
        [(p, s) for p, s in stats.items() if len(s.types) > 1],
        key=lambda x: -x[1].count
    )
    if anomalies:
        lines.append(f"| Path | Coverage | Type Distribution |")
        lines.append(f"|------|----------|-------------------|")
        for path, ps in anomalies[:40]:
            cov = f"{ps.count}/{total_resolved} ({ps.count/total_resolved:.0%})"
            types = ", ".join(f"{t}: {n}" for t, n in ps.types.most_common())
            lines.append(f"| `{path}` | {cov} | {types} |")
        lines.append("")
    else:
        lines.append("*No type anomalies found.*")
        lines.append("")

    # ── Section 7: Array cardinality ──
    lines.append("## 7. Array Cardinalities")
    lines.append("")
    lines.append("For array-valued paths, min/max/mean element counts.")
    lines.append("")

    arrays = sorted(
        [(p, s) for p, s in stats.items() if s.array_lengths],
        key=lambda x: -x[1].count
    )
    if arrays:
        lines.append(f"| Path | Coverage | Min | Max | Mean |")
        lines.append(f"|------|----------|-----|-----|------|")
        for path, ps in arrays[:40]:
            cov = f"{ps.count}/{total_resolved} ({ps.count/total_resolved:.0%})"
            lengths = ps.array_lengths
            lines.append(
                f"| `{path}` | {cov} | {min(lengths)} | {max(lengths)} "
                f"| {sum(lengths)/len(lengths):.1f} |"
            )
        lines.append("")
    else:
        lines.append("*No arrays found.*")
        lines.append("")

    # ── Section 8: Feature Synthesis ──
    lines.append("## 8. Feature Synthesis")
    lines.append("")
    lines.append("Ignored paths grouped into coherent data features, with coverage")
    lines.append("and value assessment. Generated automatically from path patterns.")
    lines.append("")

    features = synthesize_features(stats, total_resolved)
    for feat in features:
        lines.append(f"### {feat['name']} — {feat['coverage']}")
        lines.append("")
        lines.append(feat["description"])
        lines.append("")
        if feat.get("sample_values"):
            lines.append("**Sample values:**")
            for sv in feat["sample_values"]:
                lines.append(f"- `{sv}`")
            lines.append("")
        lines.append(f"**Paths:** {len(feat['paths'])} ({', '.join(f'`{p}`' for p in feat['paths'][:5])}"
                     + (f", +{len(feat['paths'])-5} more" if len(feat['paths']) > 5 else "") + ")")
        lines.append("")
        lines.append(f"**Harvest status:** {feat['harvest_status']}")
        lines.append("")
        lines.append("---")
        lines.append("")

    # ── Section 8b: Uncategorized ignored paths ──
    # Safety net: any ignored paths not grouped into a feature definition
    categorized_paths = set()
    for feat in features:
        categorized_paths.update(feat["paths"])

    orphans = sorted(
        [(p, s) for p, s in stats.items()
         if classify_path(p) == "ignored" and p not in categorized_paths
         and s.count >= max(1, int(total_resolved * 0.01))],
        key=lambda x: -x[1].count
    )

    if orphans:
        lines.append("### Uncategorized Ignored Paths (≥1% coverage)")
        lines.append("")
        lines.append("Ignored paths not grouped into any feature above. These may represent")
        lines.append("new data features that need a feature definition added to the script.")
        lines.append("")
        lines.append(f"| Path | Coverage | Types | Sample Values |")
        lines.append(f"|------|----------|-------|---------------|")
        for path, ps in orphans:
            cov = f"{ps.count}/{total_resolved} ({ps.count/total_resolved:.0%})"
            types = ", ".join(f"{t}({n})" for t, n in ps.types.most_common(3))
            vals = ""
            if ps.values:
                top3 = ps.values.most_common(3)
                vals = "; ".join(f"`{v}`({n})" for v, n in top3)
                if len(vals) > 80:
                    vals = vals[:77] + "..."
            lines.append(f"| `{path}` | {cov} | {types} | {vals} |")
        lines.append("")

    # ── Section 9: Full path inventory ──
    lines.append("## 9. Full Path Inventory")
    lines.append("")
    lines.append(f"All {len(stats)} unique paths, sorted by coverage.")
    lines.append("")
    lines.append(f"| Path | Coverage | Status |")
    lines.append(f"|------|----------|--------|")
    for path, ps in sorted(stats.items(), key=lambda x: -x[1].count):
        cov = f"{ps.count/total_resolved:.0%}" if total_resolved else "0%"
        status = classify_path(path)
        lines.append(f"| `{path}` | {cov} | {status} |")
    lines.append("")

    return "\n".join(lines)


# ─── LDES Walker ─────────────────────────────────────────────────────
# Refit per kintopp/rijksmuseum-mcp-plus-offline#270/#271/#283 — use the LDES
# feed as a thorough path enumerator instead of per-artwork Search-API+LA fetches.
# Empirically (2026-04-29 probe): each day-fragment carries `member[]` of LDES
# events. Each event's `object` describes one of five profiles (la, la-framed,
# edm, edm-framed, oai_dc); the two *-framed JSON-LD profiles carry the inline
# `@graph` payload we walk. n-triples profiles are referenced but not embedded.
# Retention is `LatestVersionSubset/1`; only 2026+ data is available.

import re

_LDES_LAST_REQUEST = [0.0]


def _ldes_throttle():
    """Sleep so requests are spaced ≥ LDES_REQUEST_INTERVAL_S apart."""
    elapsed = time.time() - _LDES_LAST_REQUEST[0]
    if elapsed < LDES_REQUEST_INTERVAL_S:
        time.sleep(LDES_REQUEST_INTERVAL_S - elapsed)
    _LDES_LAST_REQUEST[0] = time.time()


def _ldes_url_to_cache_path(url: str) -> Path:
    """Map an LDES URL to a local cache path under LDES_CACHE_DIR.

    https://data.rijksmuseum.nl/ldes/collection.json    → LDES_CACHE_DIR/collection.json
    https://data.rijksmuseum.nl/ldes/2026.json          → LDES_CACHE_DIR/2026.json
    https://data.rijksmuseum.nl/ldes/2026/3.json        → LDES_CACHE_DIR/2026/3.json
    https://data.rijksmuseum.nl/ldes/2026/3/23.json     → LDES_CACHE_DIR/2026/3/23.json
    """
    m = re.match(r"^https?://data\.rijksmuseum\.nl/ldes/(.+)$", url)
    if not m:
        raise ValueError(f"Not an LDES URL: {url}")
    return LDES_CACHE_DIR / m.group(1)


def fetch_ldes_node(url: str, *, force: bool = False) -> dict:
    """Fetch one LDES node (root, year, month, or day fragment) with caching.

    Conditional GET via stored ETag/Last-Modified — the Rijksmuseum infra is
    reportedly robust, so we still always hit the network for top-level
    navigation nodes (root/year/month) but rely on conditional GET to short-
    circuit body re-downloads. Day fragments are immutable enough to skip
    revalidation entirely once cached.
    """
    cache_path = _ldes_url_to_cache_path(url)
    meta_path = cache_path.with_suffix(cache_path.suffix + ".meta")

    is_day = bool(re.search(r"/\d{4}/\d{1,2}/\d{1,2}\.json$", url))
    if cache_path.exists() and is_day and not force:
        return json.loads(cache_path.read_text(encoding="utf-8"))

    headers = {
        "Accept": "application/ld+json",
        "User-Agent": USER_AGENT,
    }
    if cache_path.exists() and meta_path.exists() and not force:
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            if meta.get("etag"):
                headers["If-None-Match"] = meta["etag"]
            if meta.get("last_modified"):
                headers["If-Modified-Since"] = meta["last_modified"]
        except Exception:
            pass

    _ldes_throttle()
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read()
            etag = resp.headers.get("ETag")
            last_modified = resp.headers.get("Last-Modified")
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            cache_path.write_bytes(body)
            if etag or last_modified:
                meta_path.write_text(json.dumps({
                    "etag": etag,
                    "last_modified": last_modified,
                    "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                }), encoding="utf-8")
            return json.loads(body)
    except urllib.error.HTTPError as e:
        if e.code == 304 and cache_path.exists():
            return json.loads(cache_path.read_text(encoding="utf-8"))
        raise


def _node_relations(node: dict) -> list[dict]:
    """Return the `tree:relation` array for an LDES node (root, year, month).

    Some node-types put it at the top level, others nest under `view`.
    """
    if isinstance(node.get("relation"), list):
        return node["relation"]
    view = node.get("view")
    if isinstance(view, dict) and isinstance(view.get("relation"), list):
        return view["relation"]
    return []


def _relation_node_url(rel: dict) -> str | None:
    n = rel.get("node")
    if isinstance(n, dict):
        return n.get("@id") or n.get("id")
    if isinstance(n, str):
        return n
    return None


_PAGINATION_RE = re.compile(r"[?&]pageToken=")


def _is_pagination_url(url: str) -> bool:
    """Pagination relations within a single day fragment carry `?pageToken=`."""
    return bool(_PAGINATION_RE.search(url))


def collect_day_fragments(
    *,
    from_date: str | None = None,
    to_date: str | None = None,
    progress: bool = True,
) -> list[str]:
    """Walk the LDES tree:relation hierarchy and return day-fragment START URLs.

    `from_date` / `to_date` are ISO-8601 strings (inclusive lower, exclusive
    upper). If omitted, all available fragments are collected.

    The Rijksmuseum LDES exposes navigation as a tree:relation hierarchy with
    two distinct kinds of relation:
      - **Navigation** — partition by time. Root → year (`/2026.json`) →
        month (`/2026/3.json`) → day (`/2026/3/23.json`). These are the
        partitions of the calendar.
      - **Pagination** — within a single day, a `?pageToken=…` query string
        chains successive pages of `member[]`. These are NOT additional
        time partitions; they're more events from the same day.

    This collector only follows navigation relations and returns the day-start
    URL (the plain `.json` form, no query string). Pagination is followed
    separately by `iter_day_fragment_pages` so the caller can cap how many
    pages per day get walked.
    """

    def in_window(value: str) -> bool:
        if from_date and value < from_date:
            return False
        if to_date and value >= to_date:
            return False
        return True

    seen: set[str] = set()
    leaves: list[str] = []

    def descend(url: str, level: int):
        if url in seen:
            return
        seen.add(url)
        node = fetch_ldes_node(url)
        rels = _node_relations(node)

        # Filter out pagination relations — they belong to the day-walker.
        nav_rels = [r for r in rels
                    if not _is_pagination_url(_relation_node_url(r) or "")]

        if not nav_rels and "member" in node:
            # Day-start fragment: has member[] and only pagination relations
            # (no further navigation children).
            leaves.append(url)
            return

        # Group by child URL (year/month/day relations come in pairs of
        # GreaterThanOrEqualTo + LessThan, both pointing at the same node).
        children: dict[str, list[str]] = {}
        for rel in nav_rels:
            child_url = _relation_node_url(rel)
            if not child_url:
                continue
            val = rel.get("value", {})
            v = val.get("@value") if isinstance(val, dict) else val
            if isinstance(v, str):
                children.setdefault(child_url, []).append(v)

        for child_url, values in children.items():
            if (from_date or to_date) and values:
                # Keep child if any bound is in window OR the child straddles
                # the window. Conservative — if no values, descend anyway.
                if not any(in_window(v) for v in values):
                    if not (
                        (not to_date or min(values) < to_date)
                        and (not from_date or max(values) >= from_date)
                    ):
                        continue
            descend(child_url, level + 1)
            if progress and level <= 1:
                print(f"    descended into {child_url} ({len(leaves)} day starts so far)", flush=True)

    descend(LDES_ROOT, 0)
    leaves.sort()
    return leaves


def iter_day_fragment_pages(
    start_url: str,
    max_pages: int | None = None,
):
    """Yield successive pages of a day fragment, following pagination relations.

    Yields each fragment dict (with its `member[]`). Caps at `max_pages` if set.
    """
    visited: set[str] = set()
    queue: list[str] = [start_url]
    pages_yielded = 0

    while queue and (max_pages is None or pages_yielded < max_pages):
        url = queue.pop(0)
        if url in visited:
            continue
        visited.add(url)
        try:
            node = fetch_ldes_node(url)
        except Exception as e:
            print(f"      page fetch failed {url}: {e}", flush=True)
            continue
        yield node
        pages_yielded += 1

        # Enqueue pagination successors (skip navigation children — there
        # shouldn't be any at the day level, but be defensive).
        for rel in _node_relations(node):
            child = _relation_node_url(rel) or ""
            if _is_pagination_url(child) and child not in visited:
                queue.append(child)


def _profile_of_member(member: dict) -> str | None:
    """Extract the profile string (e.g. 'la-framed') from a member's `object`."""
    obj = member.get("object")
    if not isinstance(obj, dict):
        return None
    # Preferred: `?_profile=<name>` query param on object.@id
    obj_id = obj.get("@id") or obj.get("id") or ""
    m = re.search(r"[?&]_profile=([^&]+)", obj_id)
    if m:
        return m.group(1)
    # Fallback: object.profile (full URI for the profile spec, less useful)
    return obj.get("profile")


def iter_ldes_payloads(fragment: dict):
    """Yield (profile, event_type, payload) for every walkable member in a fragment."""
    members = fragment.get("member") or []
    if isinstance(members, dict):
        members = [members]
    for m in members:
        if not isinstance(m, dict):
            continue
        graph = m.get("@graph")
        if not isinstance(graph, dict):
            continue  # n-triples profiles have no inline payload
        profile = _profile_of_member(m)
        if profile not in LDES_FRAMED_PROFILES:
            continue
        event_type = m.get("@type") or m.get("type")
        yield profile, event_type, graph


def walk_ldes(
    *,
    from_date: str | None,
    to_date: str | None,
    profiles: set[str],
    sample_per_day: int | None,
    pages_per_day: int | None,
) -> tuple[dict[str, dict[str, PathStats]], dict]:
    """Walk LDES day-fragments in the date window and return per-profile path stats.

    `pages_per_day` caps how many paginated pages we fetch per day-fragment
    (default None = unlimited). `sample_per_day` caps how many members per
    profile per day get walked into the path stats (default None = unlimited).

    Returns ({profile: {path: PathStats}}, summary-dict).
    """
    print(f"  Collecting day fragments (window: {from_date or '∅'} → {to_date or '∅'})...", flush=True)
    days = collect_day_fragments(from_date=from_date, to_date=to_date)
    print(f"  Found {len(days)} day fragments.", flush=True)

    per_profile_stats: dict[str, dict[str, PathStats]] = {p: {} for p in profiles}
    per_profile_payload_count: dict[str, int] = {p: 0 for p in profiles}
    event_type_counts: Counter = Counter()
    days_walked = 0
    pages_walked_total = 0
    member_count = 0
    skipped_unknown_profile: Counter = Counter()
    delete_events_with_payload = 0

    t_start = time.time()

    for day_url in days:
        per_day_seen = {p: 0 for p in profiles}
        pages_this_day = 0

        for page in iter_day_fragment_pages(day_url, max_pages=pages_per_day):
            pages_this_day += 1
            pages_walked_total += 1

            for profile, event_type, payload in iter_ldes_payloads(page):
                member_count += 1
                event_type_counts[event_type or "Unknown"] += 1
                if profile not in profiles:
                    skipped_unknown_profile[profile] += 1
                    continue
                if sample_per_day is not None and per_day_seen[profile] >= sample_per_day:
                    continue
                per_day_seen[profile] += 1
                per_profile_payload_count[profile] += 1
                if event_type == "Delete":
                    delete_events_with_payload += 1

                per_artwork_paths: set[str] = set()
                walk_artwork(payload, per_profile_stats[profile], per_artwork_paths)

        days_walked += 1
        if days_walked % 5 == 0 or days_walked == len(days):
            elapsed = time.time() - t_start
            rate = days_walked / elapsed if elapsed > 0 else 0
            eta = (len(days) - days_walked) / rate if rate > 0 else 0
            print(
                f"    days {days_walked}/{len(days)} "
                f"(pages={pages_walked_total}, members={member_count}, "
                f"per-profile={dict(per_profile_payload_count)}) "
                f"{rate:.2f} days/s ETA {eta:.0f}s",
                flush=True,
            )

    summary = {
        "days_walked": days_walked,
        "days_total": len(days),
        "pages_walked": pages_walked_total,
        "pages_per_day_cap": pages_per_day,
        "members_seen": member_count,
        "payloads_per_profile": dict(per_profile_payload_count),
        "event_type_counts": dict(event_type_counts),
        "skipped_profiles": dict(skipped_unknown_profile),
        "delete_events_with_payload": delete_events_with_payload,
        "from_date": from_date,
        "to_date": to_date,
    }
    return per_profile_stats, summary


# ─── LDES mode entry point ────────────────────────────────────────────

def run_ldes_mode(args) -> None:
    """Walk LDES day-fragments and emit per-profile schema-discovery reports."""
    profiles = set(args.ldes_profile) if args.ldes_profile else set(LDES_FRAMED_PROFILES)
    unknown = profiles - LDES_FRAMED_PROFILES
    if unknown:
        print(f"Warning: profile(s) not in framed-profile set: {sorted(unknown)}")
        print(f"         walking anyway, but expect zero payloads for them.")

    print(f"=== LDES mode ===")
    print(f"  Window: {args.ldes_from or '(start of feed)'} → "
          f"{args.ldes_to or '(end of feed)'}")
    print(f"  Profiles: {sorted(profiles)}")
    print(f"  Cache dir: {LDES_CACHE_DIR}")
    print(f"  Throttle: ≥{LDES_REQUEST_INTERVAL_S}s/request")

    t0 = time.time()
    per_profile_stats, summary = walk_ldes(
        from_date=args.ldes_from,
        to_date=args.ldes_to,
        profiles=profiles,
        sample_per_day=args.ldes_sample_per_day,
        pages_per_day=args.ldes_pages_per_day,
    )
    elapsed = time.time() - t0

    print()
    print(f"  Walked {summary['days_walked']}/{summary['days_total']} day fragments "
          f"({summary['pages_walked']} pages) in {elapsed:.0f}s")
    print(f"  Members observed: {summary['members_seen']}")
    print(f"  Event types: {summary['event_type_counts']}")
    print(f"  Payloads per profile: {summary['payloads_per_profile']}")
    if summary["skipped_profiles"]:
        print(f"  Skipped profiles (non-framed): {summary['skipped_profiles']}")
    if summary["delete_events_with_payload"]:
        print(f"  Delete events that carried a payload: {summary['delete_events_with_payload']}")

    if not any(summary["payloads_per_profile"].values()):
        print("\nError: no walkable payloads collected. Check window or profile filters.")
        sys.exit(1)

    audit_dir = PROJECT_DIR / "data" / "audit"
    audit_dir.mkdir(parents=True, exist_ok=True)

    if args.output:
        # User specified a base path — derive per-profile siblings.
        base = Path(args.output)
    else:
        base = audit_dir / "oai-coverage-v0.26-ldes"

    base.parent.mkdir(parents=True, exist_ok=True)

    profile_outputs: dict[str, dict[str, Path]] = {}
    for profile, stats in per_profile_stats.items():
        n_payloads = summary["payloads_per_profile"].get(profile, 0)
        if n_payloads == 0 or not stats:
            print(f"  [{profile}] no payloads — skipping report")
            continue

        suffix = f".{profile}"
        md_path = base.with_name(base.name + f"{suffix}.md")
        json_path = base.with_name(base.name + f"{suffix}.json")
        profile_outputs[profile] = {"md": md_path, "json": json_path}

        report = generate_report(stats, n_payloads, 0, elapsed)
        # Prepend an LDES-specific header noting the profile + window
        cap_str = f", capped at {summary['pages_per_day_cap']} pages/day" \
            if summary.get("pages_per_day_cap") else ""
        ldes_header = (
            f"# Schema Discovery — LDES `{profile}` profile\n\n"
            f"- Window: `{args.ldes_from or '(start of feed)'}` → "
            f"`{args.ldes_to or '(end of feed)'}`\n"
            f"- Day fragments walked: {summary['days_walked']}{cap_str}\n"
            f"- Pagination pages walked: {summary['pages_walked']}\n"
            f"- Members observed (all profiles): {summary['members_seen']}\n"
            f"- Payloads walked for this profile: {n_payloads}\n"
            f"- Event types (all profiles): "
            f"{', '.join(f'{k}: {v}' for k, v in summary['event_type_counts'].items())}\n\n"
        )
        md_path.write_text(ldes_header + report, encoding="utf-8")
        print(f"  [{profile}] report → {md_path}")

        json_stats = {
            path: ps.to_dict(n_payloads)
            for path, ps in sorted(stats.items(), key=lambda x: -x[1].count)
        }
        json_path.write_text(
            json.dumps(
                {
                    "profile": profile,
                    "summary": summary,
                    "total_resolved": n_payloads,
                    "paths": json_stats,
                },
                indent=2,
            ),
            encoding="utf-8",
        )
        print(f"  [{profile}] raw stats → {json_path}")

    # Per-profile summaries to stdout (mirrors --mode linked-art Summary)
    print(f"\n=== Summary (per profile) ===")
    for profile in sorted(per_profile_stats):
        stats = per_profile_stats[profile]
        n_payloads = summary["payloads_per_profile"].get(profile, 0)
        if n_payloads == 0:
            continue
        n_extracted = sum(1 for p in stats if classify_path(p) == "extracted")
        n_structural = sum(1 for p in stats if classify_path(p) == "structural")
        n_scaffolding = sum(1 for p in stats if classify_path(p) == "scaffolding")
        n_ignored = sum(1 for p in stats if classify_path(p) == "ignored")
        print(f"  [{profile}] {n_payloads} payloads, {len(stats)} unique paths")
        print(f"    extracted: {n_extracted}, structural: {n_structural}, "
              f"scaffolding: {n_scaffolding}, ignored: {n_ignored}")

        threshold = max(1, int(n_payloads * 0.05))
        sig_ignored = [
            (p, s) for p, s in stats.items()
            if classify_path(p) == "ignored" and s.count >= threshold
        ]
        if sig_ignored:
            print(f"    ⚠ {len(sig_ignored)} ignored paths with ≥5% coverage:")
            for path, ps in sorted(sig_ignored, key=lambda x: -x[1].count)[:8]:
                cov = f"{ps.count/n_payloads:.0%}"
                print(f"      {cov}  {path}")


# ─── Main ────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Discover all Linked Art JSON-LD paths for Rijksmuseum artworks"
    )
    parser.add_argument(
        "--mode", choices=["linked-art", "ldes"], default="linked-art",
        help="Input source: 'linked-art' resolves artworks via Search API + per-artwork "
             "fetch (legacy); 'ldes' walks the LDES feed and enumerates JSON-LD paths "
             "across the la-framed and edm-framed profiles (preferred for v0.26 audit)."
    )
    parser.add_argument(
        "--samples", type=int, default=DEFAULT_SAMPLES,
        help=f"[linked-art mode] Number of artworks to sample (default: {DEFAULT_SAMPLES})"
    )
    parser.add_argument(
        "--threads", type=int, default=DEFAULT_THREADS,
        help=f"[linked-art mode] Thread count for HTTP resolution (default: {DEFAULT_THREADS})"
    )
    parser.add_argument(
        "--output", type=str, default=None,
        help="Output markdown file (default: data/schema-discovery-report.md, "
             "or per-profile reports in LDES mode)"
    )
    parser.add_argument(
        "--raw-json", type=str, default=None,
        help="Also dump raw stats as JSON to this file"
    )
    parser.add_argument(
        "--object-numbers", type=str, nargs="*", default=None,
        help="[linked-art mode] Resolve specific object numbers instead of sampling"
    )
    parser.add_argument(
        "--db", type=str, default=str(DB_PATH),
        help=f"Path to vocabulary.db (default: {DB_PATH})"
    )
    parser.add_argument(
        "--ldes-from", type=str, default=None,
        help="[ldes mode] Lower-bound date (inclusive), e.g. 2026-01-01"
    )
    parser.add_argument(
        "--ldes-to", type=str, default=None,
        help="[ldes mode] Upper-bound date (exclusive), e.g. 2026-05-01"
    )
    parser.add_argument(
        "--ldes-profile", type=str, action="append", default=None,
        help=f"[ldes mode] Restrict walk to one profile; repeatable. "
             f"Default: all framed profiles ({sorted(LDES_FRAMED_PROFILES)})"
    )
    parser.add_argument(
        "--ldes-sample-per-day", type=int, default=None,
        help="[ldes mode] Cap members walked per day per profile (default: no cap)"
    )
    parser.add_argument(
        "--ldes-pages-per-day", type=int, default=None,
        help="[ldes mode] Cap paginated pages per day fragment. Each day has "
             "intra-day pagination (?pageToken=...) chaining ~10 events per page. "
             "Default: no cap (full thorough walk). Set to 1 for fastest sampling."
    )
    args = parser.parse_args()

    if args.mode == "ldes":
        return run_ldes_mode(args)

    db_path = Path(args.db)
    if not db_path.exists():
        print(f"Error: vocabulary.db not found at {db_path}")
        sys.exit(1)

    output_path = Path(args.output) if args.output else PROJECT_DIR / "data" / "schema-discovery-report.md"

    # Phase 1: Get object numbers
    print("=== Phase 1: Sampling artworks ===")
    if args.object_numbers:
        object_numbers = args.object_numbers
        print(f"  Using {len(object_numbers)} specified object numbers")
    else:
        object_numbers = get_sample_object_numbers(db_path, args.samples)

    # Phase 2: Resolve via Search API + Linked Art (threaded)
    print(f"\n=== Phase 2: Resolving {len(object_numbers)} artworks ({args.threads} threads) ===")
    t0 = time.time()

    global_stats: dict[str, PathStats] = {}
    resolved_count = 0
    failed_count = 0
    raw_documents = {}  # for optional JSON dump

    with ThreadPoolExecutor(max_workers=args.threads) as pool:
        futures = {
            pool.submit(resolve_one, on): on
            for on in object_numbers
        }

        for i, future in enumerate(as_completed(futures), 1):
            on = futures[future]
            try:
                obj_num, data = future.result()
            except Exception as e:
                print(f"    [{i}/{len(object_numbers)}] {on}: exception {e}")
                failed_count += 1
                continue

            if data is None:
                failed_count += 1
                if i % 50 == 0 or i == len(object_numbers):
                    print(f"    [{i}/{len(object_numbers)}] {on}: failed")
                continue

            resolved_count += 1

            # Walk the full tree for this artwork
            per_artwork_paths: set[str] = set()
            walk_artwork(data, global_stats, per_artwork_paths)

            if args.raw_json:
                raw_documents[obj_num] = data

            if i % 50 == 0 or i == len(object_numbers):
                elapsed = time.time() - t0
                rate = i / elapsed if elapsed > 0 else 0
                eta = (len(object_numbers) - i) / rate if rate > 0 else 0
                print(
                    f"    [{i}/{len(object_numbers)}] "
                    f"resolved: {resolved_count}, failed: {failed_count}, "
                    f"{rate:.1f}/s, ETA: {eta:.0f}s"
                )

    elapsed = time.time() - t0
    print(f"\n  Resolved {resolved_count}/{len(object_numbers)} in {elapsed:.0f}s")

    if resolved_count == 0:
        print("Error: No artworks resolved. Check network connectivity.")
        sys.exit(1)

    # Phase 3: Generate report
    print(f"\n=== Phase 3: Generating report ({len(global_stats)} paths) ===")
    report = generate_report(global_stats, resolved_count, failed_count, elapsed)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(report, encoding="utf-8")
    print(f"  Report written to {output_path}")

    # Optional: raw JSON dump
    if args.raw_json:
        json_path = Path(args.raw_json)
        json_stats = {
            path: ps.to_dict(resolved_count)
            for path, ps in sorted(global_stats.items(), key=lambda x: -x[1].count)
        }
        json_path.write_text(
            json.dumps({"total_resolved": resolved_count, "paths": json_stats}, indent=2),
            encoding="utf-8"
        )
        print(f"  Raw stats written to {json_path}")

    # Phase 4: Summary to stdout
    print(f"\n=== Summary ===")
    print(f"  Total paths discovered: {len(global_stats)}")

    n_extracted = sum(1 for p in global_stats if classify_path(p) == "extracted")
    n_structural = sum(1 for p in global_stats if classify_path(p) == "structural")
    n_scaffolding = sum(1 for p in global_stats if classify_path(p) == "scaffolding")
    n_ignored = sum(1 for p in global_stats if classify_path(p) == "ignored")
    print(f"  Extracted by harvest: {n_extracted}")
    print(f"  Structural (traversed): {n_structural}")
    print(f"  Scaffolding (JSON-LD/entity internals): {n_scaffolding}")
    print(f"  Ignored (potential new data): {n_ignored}")

    threshold = max(1, int(resolved_count * 0.05))
    significant_ignored = [
        (p, s) for p, s in global_stats.items()
        if classify_path(p) == "ignored" and s.count >= threshold
    ]
    if significant_ignored:
        print(f"\n  ⚠ {len(significant_ignored)} ignored paths with ≥5% coverage:")
        for path, ps in sorted(significant_ignored, key=lambda x: -x[1].count)[:15]:
            cov = f"{ps.count/resolved_count:.0%}"
            print(f"    {cov}  {path}")


if __name__ == "__main__":
    main()
