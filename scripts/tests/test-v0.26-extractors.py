#!/usr/bin/env python3
"""Unit tests for v0.26 extractors against synthetic fixtures.

Loads each fixture from scripts/tests/fixtures-v0.26/, calls the
corresponding extractor in scripts/harvest-vocabulary-db.py, and
asserts the expected output structure.

Run:
    ~/miniconda3/envs/embeddings/bin/python scripts/tests/test-v0.26-extractors.py
"""
from __future__ import annotations

import importlib.util
import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
FIXTURES = Path(__file__).resolve().parent / "fixtures-v0.26"


def load_harvest_module():
    """Import scripts/harvest-vocabulary-db.py as a module."""
    path = ROOT / "scripts" / "harvest-vocabulary-db.py"
    spec = importlib.util.spec_from_file_location("harvest_vocabulary_db", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def assert_eq(label: str, actual, expected) -> None:
    if actual != expected:
        print(f"  FAIL {label}\n    expected: {expected!r}\n    actual:   {actual!r}")
        sys.exit(1)
    print(f"  PASS {label}")


def assert_true(label: str, cond: bool, detail: str = "") -> None:
    if not cond:
        print(f"  FAIL {label} {detail}")
        sys.exit(1)
    print(f"  PASS {label}")


def test_record_timestamps(hv):
    data = json.load(open(FIXTURES / "record-timestamps-sample.json"))
    rc, rm = hv.extract_record_timestamps(data)
    assert_eq("record_timestamps.created", rc, "2019-06-21T00:00:00Z")
    assert_eq("record_timestamps.modified", rm, "2025-03-12T23:59:59Z")

    # Empty case
    rc2, rm2 = hv.extract_record_timestamps({})
    assert_eq("record_timestamps.empty.created", rc2, None)
    assert_eq("record_timestamps.empty.modified", rm2, None)


def test_attribution_evidence(hv):
    data = json.load(open(FIXTURES / "attribution-evidence-sample.json"))
    rows = hv.extract_attribution_evidence(data)
    # 2 part entries, each with one motivated_by → 2 rows
    assert_eq("attribution_evidence.row_count", len(rows), 2)
    # First row: full evidence trail
    r0 = rows[0]
    assert_eq("attribution_evidence[0].part_index", r0["part_index"], 0)
    assert_eq("attribution_evidence[0].evidence_type_aat",
              r0["evidence_type_aat"], "http://vocab.getty.edu/aat/300404670")
    assert_eq("attribution_evidence[0].carried_by_uri",
              r0["carried_by_uri"], "https://id.rijksmuseum.nl/300999999")
    assert_true("attribution_evidence[0].label_text non-empty",
                bool(r0["label_text"]))
    # Second row: bare-string shape (production-realistic)
    r1 = rows[1]
    assert_eq("attribution_evidence[1].part_index", r1["part_index"], 1)
    assert_eq("attribution_evidence[1].evidence_type_aat",
              r1["evidence_type_aat"], "http://vocab.getty.edu/aat/300028705")
    assert_eq("attribution_evidence[1].carried_by_uri",
              r1["carried_by_uri"], "https://id.rijksmuseum.nl/2001")


def test_about(hv):
    data = json.load(open(FIXTURES / "about-sample.json"))
    ids = hv.extract_about(data)
    assert_eq("about.ids", ids, ["22014775", "22014777"])
    assert_eq("about.empty", hv.extract_about({}), [])


def test_artwork_external_ids(hv):
    data = json.load(open(FIXTURES / "artwork-external-ids-sample.json"))
    rows = hv.extract_artwork_external_ids(data)
    auths = sorted(a for a, _, _ in rows)
    # Wikidata + handle on root, rijks_internal via shown_by[].equivalent
    assert_eq("artwork_external_ids.authorities", auths,
              ["handle", "rijks_internal", "wikidata"])
    # Wikidata local_id
    wikidata = next(r for r in rows if r[0] == "wikidata")
    assert_eq("artwork_external_ids.wikidata.local_id", wikidata[1], "Q12345")


def test_cho_sameas_and_extent(hv):
    """SHIP-3, SHIP-4, SHIP-6 — exercise extract_records on the EDM fixture."""
    tree = ET.parse(FIXTURES / "cho-sameas-sample.xml")
    root = tree.getroot()
    records = hv.extract_records(root)
    assert_eq("cho.record_count", len(records), 1)
    rec = records[0]
    assert_eq("cho.object_number", rec["object_number"], "SK-A-0001")
    # SHIP-6: extent_text
    assert_true(
        "cho.extent_text contains height",
        "height 100 mm" in (rec.get("extent_text") or ""),
        f"got: {rec.get('extent_text')}",
    )
    assert_true(
        "cho.extent_text contains hoogte",
        "hoogte 100 mm" in (rec.get("extent_text") or ""),
    )
    # SHIP-3 + SHIP-4: ext_ids
    ext_ids = rec.get("ext_ids") or []
    by_authority = {}
    for vocab_id, authority, local_id, uri in ext_ids:
        by_authority.setdefault(authority, []).append((vocab_id, local_id, uri))
    assert_true(
        "cho.ext_ids has iconclass",
        "iconclass" in by_authority,
        f"authorities: {sorted(by_authority)}",
    )
    assert_true(
        "cho.ext_ids has wikidata",
        "wikidata" in by_authority,
    )
    assert_true(
        "cho.ext_ids has geonames",
        "geonames" in by_authority,
    )
    # subject vocab_id 2212675 → iconclass 41D92
    icon = by_authority["iconclass"][0]
    assert_eq("cho.iconclass.vocab_id", icon[0], "2212675")
    assert_eq("cho.iconclass.local_id", icon[1], "41D92")


def test_classify_authority_v026(hv):
    """SHIP-7 + SHIP-10: ensure new needles match."""
    a, lid = hv.classify_authority("https://hdl.handle.net/10934/RM0001.COLLECT.123")
    assert_eq("classify_authority.handle.bucket", a, "handle")
    a, lid = hv.classify_authority("https://id.rijksmuseum.nl/300999999")
    assert_eq("classify_authority.rijks_internal.bucket", a, "rijks_internal")
    # Wikidata still wins over rijks_internal even if URL contains rijks substring
    a, lid = hv.classify_authority("http://www.wikidata.org/entity/Q12345")
    assert_eq("classify_authority.wikidata.bucket", a, "wikidata")


def main():
    print("Loading harvest-vocabulary-db.py module...")
    hv = load_harvest_module()
    print()
    print("test_record_timestamps")
    test_record_timestamps(hv)
    print("test_attribution_evidence")
    test_attribution_evidence(hv)
    print("test_about")
    test_about(hv)
    print("test_artwork_external_ids")
    test_artwork_external_ids(hv)
    print("test_cho_sameas_and_extent")
    test_cho_sameas_and_extent(hv)
    print("test_classify_authority_v026")
    test_classify_authority_v026(hv)
    print()
    print("All v0.26 extractor tests passed.")


if __name__ == "__main__":
    main()
