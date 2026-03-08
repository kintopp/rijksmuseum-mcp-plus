#!/usr/bin/env python3
"""Probe Linked Art produced_by structures to find maker relation patterns.

Checks whether the Rijksmuseum website's 16 maker sub-types are present
in the Linked Art data exposed via the resolver API.

Website sub-types we want to find evidence for:
  - Signed by
  - Possibly made by
  - Manner of
  - Made after / Free after / After copy of
  - Falsification after
  - Rejected maker
  - Involved maker
  - Mentions person

Already harvested:
  - Made by (carried_out_by → primary)
  - Attributed to (assigned_by, AAT 300404269)
  - Workshop of (assigned_by, AAT 300404274)
  - Circle of (assigned_by, AAT 300404284)
  - Follower of (assigned_by, AAT 300404282)

Usage:
    python3 scripts/probe-maker-relations.py [--samples 200] [--threads 8]
"""

import argparse
import json
import sqlite3
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

DB_PATH = Path(__file__).parent.parent / "data" / "vocabulary.db"
SEARCH_API = "https://data.rijksmuseum.nl/search/collection"
USER_AGENT = "rijksmuseum-mcp-plus/probe-maker-relations"

# AAT codes we already know about
KNOWN_QUALIFIER_AATS = {
    "300404450": "primary",
    "300404451": "secondary",
    "300379012": "undetermined",
    "300404269": "attributed to",
    "300404274": "workshop of",
    "300404284": "circle of",
    "300404282": "follower of",
    "300404272": "manner of",
    "300404279": "copy after",
    "300404434": "school of",
    "300404273": "studio of",
}

# Production roles that might map to website sub-types
RELATIONAL_ROLES_KEYWORDS = [
    "after", "signed", "copy", "falsif", "reject", "manner", "free after",
    "possibly", "involved", "mention",
]


def lookup_uri(object_number: str) -> str | None:
    """Look up Linked Art URI for an object number via the Search API."""
    url = f"{SEARCH_API}?objectNumber={urllib.parse.quote(object_number)}"
    req = Request(url, headers={
        "Accept": "application/ld+json",
        "User-Agent": USER_AGENT,
    })
    try:
        with urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read())
        items = data.get("orderedItems", [])
        if items:
            return items[0].get("id")
    except Exception:
        pass
    return None


def fetch_linked_art(uri: str, timeout: int = 15) -> dict | None:
    """Fetch Linked Art JSON-LD from the resolver."""
    req = Request(uri, headers={
        "Accept": "application/ld+json",
        "User-Agent": USER_AGENT,
    })
    try:
        with urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read())
    except (HTTPError, URLError, json.JSONDecodeError, TimeoutError):
        return None


def resolve_artwork(object_number: str) -> dict | None:
    """Two-step resolution: object_number → Search API → Linked Art URI → fetch."""
    uri = lookup_uri(object_number)
    if not uri:
        return None
    return fetch_linked_art(uri)


def extract_aat_suffix(uri: str) -> str | None:
    """Extract AAT code from URI like http://vocab.getty.edu/aat/300404269."""
    if "aat/" in uri:
        return uri.rsplit("aat/", 1)[-1]
    return None


def analyse_production(data: dict) -> dict:
    """Analyse produced_by structure, returning all patterns found."""
    result = {
        "has_produced_by": False,
        "part_count": 0,
        "patterns": [],
        "classified_as_aats": [],
        "assigned_by_aats": [],
        "assigned_properties": [],
        "technique_ids": [],
        "referred_to_by_texts": [],
        "unknown_keys": [],
        "influenced_by": [],
    }

    produced_by = data.get("produced_by")
    if not isinstance(produced_by, dict):
        return result
    result["has_produced_by"] = True

    # Check top-level produced_by keys beyond what we expect
    expected_top = {"type", "id", "@context", "timespan", "part", "carried_out_by",
                    "technique", "classified_as", "referred_to_by", "assigned_by",
                    "took_place_at", "influenced_by"}
    for k in produced_by:
        if k not in expected_top:
            result["unknown_keys"].append(f"produced_by.{k}")

    parts = produced_by.get("part", [])
    if not isinstance(parts, list):
        parts = [produced_by]
    result["part_count"] = len(parts)

    for i, part in enumerate(parts):
        if not isinstance(part, dict):
            continue

        # Check for unexpected keys on parts
        expected_part = {"type", "id", "carried_out_by", "technique",
                         "classified_as", "referred_to_by", "assigned_by",
                         "influenced_by", "timespan", "took_place_at"}
        for k in part:
            if k not in expected_part:
                result["unknown_keys"].append(f"part[{i}].{k}")

        # classified_as on part (priority levels)
        for cls in part.get("classified_as", []):
            if isinstance(cls, dict):
                aat = extract_aat_suffix(cls.get("id", ""))
                if aat:
                    label = KNOWN_QUALIFIER_AATS.get(aat, f"UNKNOWN:{aat}")
                    result["classified_as_aats"].append(label)
            elif isinstance(cls, str):
                aat = extract_aat_suffix(cls)
                if aat:
                    label = KNOWN_QUALIFIER_AATS.get(aat, f"UNKNOWN:{aat}")
                    result["classified_as_aats"].append(label)

        # assigned_by (attribution qualifiers)
        for assignment in part.get("assigned_by", []):
            if not isinstance(assignment, dict):
                continue
            prop = assignment.get("assigned_property", "")
            result["assigned_properties"].append(prop)
            for cls in assignment.get("classified_as", []):
                if isinstance(cls, dict):
                    aat = extract_aat_suffix(cls.get("id", ""))
                    if aat:
                        label = KNOWN_QUALIFIER_AATS.get(aat, f"UNKNOWN:{aat}")
                        result["assigned_by_aats"].append(label)
                elif isinstance(cls, str):
                    aat = extract_aat_suffix(cls)
                    if aat:
                        label = KNOWN_QUALIFIER_AATS.get(aat, f"UNKNOWN:{aat}")
                        result["assigned_by_aats"].append(label)

        # technique (production roles)
        for tech in part.get("technique", []):
            if isinstance(tech, dict):
                result["technique_ids"].append(tech.get("id", ""))
            elif isinstance(tech, str):
                result["technique_ids"].append(tech)

        # referred_to_by (production statement text — may contain "signed by" etc.)
        for ref in part.get("referred_to_by", []):
            if isinstance(ref, dict):
                content = ref.get("content", "")
                if isinstance(content, list):
                    content = " ".join(str(c) for c in content)
                if content:
                    result["referred_to_by_texts"].append(content)

        # influenced_by (separate from carried_out_by)
        for inf in part.get("influenced_by", []):
            if isinstance(inf, dict):
                result["influenced_by"].append(inf.get("id", ""))
            elif isinstance(inf, str):
                result["influenced_by"].append(inf)

    # Also check top-level (non-part) influenced_by
    for inf in produced_by.get("influenced_by", []):
        if isinstance(inf, dict):
            result["influenced_by"].append(inf.get("id", ""))

    return result


def sample_artworks(db_path: Path, n: int) -> list[str]:
    """Sample object numbers from vocab DB, biased toward those with interesting relations."""
    conn = sqlite3.connect(str(db_path))
    results = []

    # 1. Sample artworks with non-primary attribution qualifiers (rich qualifiers)
    rows = conn.execute("""
        SELECT DISTINCT a.object_number
        FROM mappings m
        JOIN field_lookup fl ON m.field_id = fl.id
        JOIN vocabulary v ON m.vocab_rowid = v.vocab_int_id
        JOIN artworks a ON m.artwork_id = a.art_id
        WHERE fl.name = 'attribution_qualifier'
          AND v.label_en NOT IN ('primary', 'secondary', 'undetermined')
        ORDER BY RANDOM()
        LIMIT ?
    """, (n // 4,)).fetchall()
    results.extend(r[0] for r in rows)

    # 2. Sample artworks with relational production roles (after design by, etc.)
    rows = conn.execute("""
        SELECT DISTINCT a.object_number
        FROM mappings m
        JOIN field_lookup fl ON m.field_id = fl.id
        JOIN vocabulary v ON m.vocab_rowid = v.vocab_int_id
        JOIN artworks a ON m.artwork_id = a.art_id
        WHERE fl.name = 'production_role'
          AND (v.label_en LIKE '%after%' OR v.label_nl LIKE '%naar%'
               OR v.label_en LIKE '%copy%' OR v.label_en LIKE '%sign%')
        ORDER BY RANDOM()
        LIMIT ?
    """, (n // 4,)).fetchall()
    results.extend(r[0] for r in rows)

    # 3. Sample artworks with empty creator_label (often attributed/workshop pieces)
    rows = conn.execute("""
        SELECT a.object_number
        FROM artworks a
        WHERE (a.creator_label IS NULL OR a.creator_label = '')
        ORDER BY RANDOM()
        LIMIT ?
    """, (n // 4,)).fetchall()
    results.extend(r[0] for r in rows)

    # 4. Random sample for baseline
    rows = conn.execute("""
        SELECT a.object_number
        FROM artworks a
        ORDER BY RANDOM()
        LIMIT ?
    """, (n // 4,)).fetchall()
    results.extend(r[0] for r in rows)

    conn.close()

    # Deduplicate
    seen = set()
    unique = []
    for obj in results:
        if obj not in seen:
            seen.add(obj)
            unique.append(obj)
    return unique[:n]


def main():
    parser = argparse.ArgumentParser(description="Probe Linked Art maker relation patterns")
    parser.add_argument("--samples", type=int, default=200, help="Number of artworks to sample")
    parser.add_argument("--threads", type=int, default=8, help="Concurrent fetches")
    args = parser.parse_args()

    if not DB_PATH.exists():
        print(f"Error: vocab DB not found at {DB_PATH}", file=sys.stderr)
        sys.exit(1)

    print(f"Sampling {args.samples} artworks from {DB_PATH}...")
    artworks = sample_artworks(DB_PATH, args.samples)
    print(f"  Got {len(artworks)} unique artworks")

    # Fetch and analyse
    classified_as_counter = Counter()
    assigned_by_counter = Counter()
    assigned_prop_counter = Counter()
    unknown_keys_counter = Counter()
    influenced_by_count = 0
    referred_to_by_patterns = Counter()
    technique_counter = Counter()

    fetched = 0
    failed = 0
    no_production = 0

    # Look up technique IDs → labels
    conn = sqlite3.connect(str(DB_PATH))

    def resolve_technique(tech_id: str) -> str:
        """Resolve a technique URI to its label."""
        row = conn.execute(
            "SELECT label_en, label_nl FROM vocabulary WHERE id = ?", (tech_id,)
        ).fetchone()
        if row:
            return row[0] or row[1] or tech_id
        return tech_id

    print(f"Resolving and fetching Linked Art for {len(artworks)} artworks ({args.threads} threads)...")
    print(f"  (2 HTTP requests per artwork: Search API → resolver)")
    t0 = time.time()

    def fetch_one(obj_num):
        data = resolve_artwork(obj_num)
        return obj_num, data

    with ThreadPoolExecutor(max_workers=args.threads) as pool:
        futures = {pool.submit(fetch_one, obj): obj for obj in artworks}
        for future in as_completed(futures):
            obj_num, data = future.result()
            fetched += 1
            if data is None:
                failed += 1
                continue

            analysis = analyse_production(data)
            if not analysis["has_produced_by"]:
                no_production += 1
                continue

            for aat in analysis["classified_as_aats"]:
                classified_as_counter[aat] += 1
            for aat in analysis["assigned_by_aats"]:
                assigned_by_counter[aat] += 1
            for prop in analysis["assigned_properties"]:
                assigned_prop_counter[prop] += 1
            for k in analysis["unknown_keys"]:
                unknown_keys_counter[k] += 1
            if analysis["influenced_by"]:
                influenced_by_count += 1
            for text in analysis["referred_to_by_texts"]:
                # Classify production statement text patterns
                text_lower = text.lower()
                for kw in RELATIONAL_ROLES_KEYWORDS:
                    if kw in text_lower:
                        # Truncate to first 80 chars for display
                        snippet = text[:80].replace("\n", " ")
                        referred_to_by_patterns[f"{kw}: {snippet}"] += 1
            for tech in analysis["technique_ids"]:
                label = resolve_technique(tech)
                technique_counter[label] += 1

            if fetched % 50 == 0:
                elapsed = time.time() - t0
                print(f"  {fetched}/{len(artworks)} fetched ({elapsed:.0f}s)")

    conn.close()
    elapsed = time.time() - t0

    # Report
    print(f"\n{'='*70}")
    print(f"MAKER RELATION PROBE REPORT")
    print(f"{'='*70}")
    print(f"Artworks sampled: {len(artworks)}")
    print(f"Fetched: {fetched - failed}, Failed: {failed}, No produced_by: {no_production}")
    print(f"Time: {elapsed:.1f}s")

    print(f"\n--- part[].classified_as (priority levels) ---")
    for label, cnt in classified_as_counter.most_common():
        marker = " ← UNKNOWN" if label.startswith("UNKNOWN:") else ""
        print(f"  {label}: {cnt}{marker}")

    print(f"\n--- assigned_by[].classified_as (attribution qualifiers) ---")
    if assigned_by_counter:
        for label, cnt in assigned_by_counter.most_common():
            marker = " ← NEW/UNKNOWN" if label.startswith("UNKNOWN:") else ""
            print(f"  {label}: {cnt}{marker}")
    else:
        print("  (none found)")

    print(f"\n--- assigned_by[].assigned_property values ---")
    for prop, cnt in assigned_prop_counter.most_common():
        print(f"  {prop}: {cnt}")

    print(f"\n--- influenced_by on production ---")
    print(f"  Artworks with influenced_by: {influenced_by_count}")

    print(f"\n--- Unknown keys on produced_by / parts ---")
    if unknown_keys_counter:
        for k, cnt in unknown_keys_counter.most_common():
            print(f"  {k}: {cnt} ← INVESTIGATE")
    else:
        print("  (none — all keys are expected)")

    print(f"\n--- Production roles (technique) — top 20 ---")
    for label, cnt in technique_counter.most_common(20):
        print(f"  {label}: {cnt}")

    print(f"\n--- referred_to_by text containing relational keywords ---")
    if referred_to_by_patterns:
        for pattern, cnt in referred_to_by_patterns.most_common(20):
            print(f"  {pattern}: {cnt}")
    else:
        print("  (none found)")

    # Summary: which website sub-types have evidence?
    print(f"\n{'='*70}")
    print(f"WEBSITE SUB-TYPE EVIDENCE SUMMARY")
    print(f"{'='*70}")

    evidence = {
        "Made by": ("classified_as", "primary" in classified_as_counter),
        "Attributed to": ("assigned_by", "attributed to" in assigned_by_counter),
        "Workshop of": ("assigned_by", "workshop of" in assigned_by_counter),
        "Circle of": ("assigned_by", "circle of" in assigned_by_counter),
        "Follower of": ("assigned_by", "follower of" in assigned_by_counter),
        "Manner of": ("assigned_by", "manner of" in assigned_by_counter),
        "Copy after": ("assigned_by", "copy after" in assigned_by_counter),
        "School of": ("assigned_by", "school of" in assigned_by_counter),
        "Studio of": ("assigned_by", "studio of" in assigned_by_counter),
        "Signed by": ("referred_to_by", any("sign" in k for k in referred_to_by_patterns)),
        "Possibly made by": ("assigned_by/other", any("UNKNOWN" in k for k in assigned_by_counter)),
        "Made after": ("technique", any("after" in k.lower() for k in technique_counter)),
        "Free after": ("technique/text", any("free after" in k.lower() for k in referred_to_by_patterns)),
        "Falsification after": ("technique/text", any("falsif" in k.lower() for k in referred_to_by_patterns)),
        "After copy of": ("technique/text", any("copy" in k.lower() for k in referred_to_by_patterns)),
        "Rejected maker": ("text/other", any("reject" in k.lower() for k in referred_to_by_patterns)),
        "Involved maker": ("carried_out_by", True),  # any production = involved
    }

    for subtype, (location, found) in evidence.items():
        status = "✓ FOUND" if found else "✗ NOT FOUND"
        print(f"  {status:14s}  {subtype:25s}  (via {location})")

    # Unknown AATs found
    unknown_aats = [k for k in assigned_by_counter if k.startswith("UNKNOWN:")]
    unknown_aats += [k for k in classified_as_counter if k.startswith("UNKNOWN:")]
    if unknown_aats:
        print(f"\n--- Unknown AAT codes found (need investigation) ---")
        for aat in unknown_aats:
            print(f"  {aat}")


if __name__ == "__main__":
    main()
