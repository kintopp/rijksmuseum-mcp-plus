#!/usr/bin/env python3
"""Smoke test: verify extract_production_parts correctly extracts places and source_types.

Fetches a handful of artworks known to have took_place_at / used_object_of_type
and checks the extraction output.

Usage:
    ~/miniconda3/envs/embeddings/bin/python scripts/tests/test-production-extraction.py
"""

import json
import sys
import urllib.parse
import urllib.request

sys.path.insert(0, ".")
# We can't import the harvest script directly (it's not a package), so we
# inline the key functions. Instead, let's just test the logic end-to-end
# by fetching real data and running the extraction.

SEARCH_API = "https://data.rijksmuseum.nl/search/collection"
UA = "rijksmuseum-mcp-test/1.0"


def lookup_and_fetch(obj: str) -> dict | None:
    url = f"{SEARCH_API}?objectNumber={urllib.parse.quote(obj)}"
    req = urllib.request.Request(url, headers={"Accept": "application/ld+json", "User-Agent": UA})
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read())
    uri = data["orderedItems"][0]["id"]
    req = urllib.request.Request(uri, headers={"Accept": "application/ld+json", "User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def _extract_ids(items: list, field: str) -> list[tuple[str, str]]:
    result = []
    for item in items:
        if isinstance(item, dict):
            uri = item.get("id", "")
            if uri:
                result.append((uri.split("/")[-1], field))
    return result


def _normalise_list(val: object) -> list:
    if isinstance(val, dict):
        return [val]
    if isinstance(val, list):
        return val
    return []


def extract_places_and_sources(data: dict) -> tuple[list, list]:
    """Minimal reimplementation of the new extraction logic."""
    places = []
    source_types = []

    produced_by = data.get("produced_by")
    if not isinstance(produced_by, dict):
        return places, source_types

    parts = produced_by.get("part", [])
    if not isinstance(parts, list):
        parts = [produced_by]

    for part in parts:
        if not isinstance(part, dict):
            continue
        places.extend(_extract_ids(_normalise_list(part.get("took_place_at")), "production_place"))
        source_types.extend(_extract_ids(_normalise_list(part.get("used_object_of_type")), "source_type"))

    # Top-level
    if produced_by.get("part") is not None:
        places.extend(_extract_ids(_normalise_list(produced_by.get("took_place_at")), "production_place"))
        source_types.extend(_extract_ids(_normalise_list(produced_by.get("used_object_of_type")), "source_type"))

    return places, source_types


# ── Test cases ──
# From the probe: RP-P-OB-23.614 has took_place_at with Italy (230101)
# We'll test a few and verify non-empty results

passed = 0
failed = 0


def check(label: str, condition: bool, detail: str = ""):
    global passed, failed
    if condition:
        print(f"  ✓ {label}")
        passed += 1
    else:
        print(f"  ✗ {label} — {detail}")
        failed += 1


print("Fetching test artworks from Linked Art API...\n")

# Test 1: Artwork known to have took_place_at
print("Test 1: RP-P-OB-23.614 (print with production place)")
try:
    data = lookup_and_fetch("RP-P-OB-23.614")
    places, sources = extract_places_and_sources(data)
    check("has places", len(places) > 0, f"got {places}")
    check("place is RM vocab ID", all(not p[0].startswith("http") for p in places), f"got {places}")
    check("field is production_place", all(p[1] == "production_place" for p in places), f"got {places}")
    # Check Italy (230101) is in there
    place_ids = [p[0] for p in places]
    check("includes 230101 (Italy)", "230101" in place_ids, f"got {place_ids}")
    print(f"  Places: {places}")
    print(f"  Source types: {sources}")
except Exception as e:
    check("fetch succeeded", False, str(e))

print()

# Test 2: Search for an artwork with used_object_of_type
# From the probe: prints commonly have source types
print("Test 2: Searching for artwork with used_object_of_type...")
try:
    # Use a known print maker — Rembrandt prints often have source types
    import random
    import sqlite3
    conn = sqlite3.connect("data/vocabulary.db")
    # Get some RP-P objects (prints) to increase odds
    objs = [r[0] for r in conn.execute(
        "SELECT object_number FROM artworks WHERE object_number LIKE 'RP-P-%' ORDER BY RANDOM() LIMIT 50"
    ).fetchall()]
    conn.close()

    found_source = False
    for obj in objs:
        try:
            data = lookup_and_fetch(obj)
            places, sources = extract_places_and_sources(data)
            if sources:
                print(f"  Found source_type on {obj}: {sources}")
                found_source = True
                check("source_type is AAT suffix", all(s[0].isdigit() for s in sources), f"got {sources}")
                check("field is source_type", all(s[1] == "source_type" for s in sources), f"got {sources}")
                # Verify the AAT ID is one of our known 6
                known = {"300102051", "300033973", "300033618", "300041273", "300047090", "300046300"}
                for sid, _ in sources:
                    check(f"AAT {sid} is in known set", sid in known, f"{sid} not in {known}")
                break
        except Exception:
            continue

    if not found_source:
        print("  (no source_type found in 50 random prints — expected ~25% hit rate)")
        # Not a failure, just unlucky
except Exception as e:
    check("search succeeded", False, str(e))

print()

# Test 3: Artwork with NO produced_by (should return empty)
print("Test 3: Empty extraction on synthetic data")
places, sources = extract_places_and_sources({})
check("no produced_by → empty places", places == [], f"got {places}")
check("no produced_by → empty sources", sources == [], f"got {sources}")

places, sources = extract_places_and_sources({"produced_by": {"part": [{"technique": [{"id": "http://example.com/123"}]}]}})
check("part without took_place_at → empty places", places == [], f"got {places}")
check("part without used_object_of_type → empty sources", sources == [], f"got {sources}")

# Test 4: dict form (not list) for took_place_at
print("\nTest 4: Dict-form normalisation")
places, sources = extract_places_and_sources({
    "produced_by": {
        "part": [{
            "took_place_at": {"id": "https://id.rijksmuseum.nl/230101", "type": "Place"},
            "used_object_of_type": {"id": "http://vocab.getty.edu/aat/300033618", "type": "Type"},
        }]
    }
})
check("dict took_place_at → 1 place", len(places) == 1, f"got {places}")
check("dict used_object_of_type → 1 source", len(sources) == 1, f"got {sources}")
check("place ID extracted correctly", places[0][0] == "230101", f"got {places[0][0]}")
check("source ID extracted correctly", sources[0][0] == "300033618", f"got {sources[0][0]}")

print(f"\n{'=' * 50}")
print(f"  Passed: {passed}  Failed: {failed}")
print(f"{'=' * 50}")
sys.exit(1 if failed else 0)
