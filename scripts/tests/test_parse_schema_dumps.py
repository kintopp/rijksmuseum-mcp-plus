#!/usr/bin/env python3
"""Unit tests for the Schema.org branch of parse_nt_file (#238).

Runs parse_nt_file against real fixture files sampled from
/tmp/rm-dump-{person,organisation,topical_term,place,classification,event}
and asserts on the returned dict. No database, no harvest — just the parser.

Run with:
    ~/miniconda3/envs/embeddings/bin/python scripts/tests/test_parse_schema_dumps.py
or just `python3 scripts/tests/test_parse_schema_dumps.py` (stdlib only).
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _test_helpers import CheckRecorder, load_harvest_module

harvest_mod = load_harvest_module()
parse_nt_file = harvest_mod.parse_nt_file
classify_authority = harvest_mod.classify_authority

recorder = CheckRecorder()
check = recorder.check


def find_fixture(root: str, matcher) -> Path | None:
    """Walk a dump dir and return the first file where matcher(path, text)
    returns True. Used to locate real examples that exhibit a shape we care
    about (e.g. anonymous person, person with ≥3 sameAs, etc.)."""
    for dirpath, _, filenames in os.walk(root):
        for fn in filenames:
            p = Path(dirpath) / fn
            try:
                txt = p.read_text(encoding="utf-8")
            except OSError:
                continue
            if matcher(p, txt):
                return p
    return None


# ─── 1. classify_authority unit tests ─────────────────────────────────

print("=" * 60)
print("classify_authority() unit tests")
print("=" * 60)

AUTHORITY_CASES = [
    ("http://www.wikidata.org/entity/Q5582", "wikidata", "Q5582"),
    ("https://www.wikidata.org/entity/Q42", "wikidata", "Q42"),
    ("http://viaf.org/viaf/19908139", "viaf", "19908139"),
    ("http://viaf.org/viaf/19908139/", "viaf", "19908139"),
    ("https://rkd.nl/explore/artists/123456", "rkd", "123456"),
    ("http://vocab.getty.edu/ulan/500115493", "ulan", "500115493"),
    ("http://vocab.getty.edu/tgn/7007856", "tgn", "7007856"),
    ("http://vocab.getty.edu/aat/300379475", "aat", "300379475"),
    ("https://iconclass.org/59BB1", "iconclass", "59BB1"),
    ("http://sws.geonames.org/2759794/", "geonames", "2759794"),
    ("http://www.geonames.org/2759794", "geonames", "2759794"),
    ("http://www.biografischportaal.nl/persoon/12345", "biografisch_portaal", "12345"),
    ("https://data.cerl.org/thesaurus/cnp01234567", "cerl", "cnp01234567"),
    ("http://pic.nypl.org/agent/abc", "nypl", "abc"),
    ("http://example.com/weird", "other", "http://example.com/weird"),
    ("", "other", ""),
    # Host-matched URIs with malformed local_id route to 'other'.
    ("http://vocab.getty.edu/tgn/25H214", "other",
     "http://vocab.getty.edu/tgn/25H214"),
    ("http://www.wikidata.org/entity/144178830", "other",
     "http://www.wikidata.org/entity/144178830"),
    ("https://iconclass.org/12345", "other", "https://iconclass.org/12345"),
]
for uri, exp_auth, exp_id in AUTHORITY_CASES:
    auth, local = classify_authority(uri)
    check(
        f"classify {uri or '(empty)'}",
        auth == exp_auth and local == exp_id,
        f"got ({auth!r}, {local!r}), expected ({exp_auth!r}, {exp_id!r})",
    )


# ─── 2. Fixture-based parse tests ─────────────────────────────────────

print()
print("=" * 60)
print("Schema.org dump parse tests (real fixtures)")
print("=" * 60)

PERSON_DUMP = "/tmp/rm-dump-person"
ORG_DUMP = "/tmp/rm-dump-organisation"
TOPICAL_DUMP = "/tmp/rm-dump-topical_term"
PLACE_DUMP = "/tmp/rm-dump-place"
CLASS_DUMP = "/tmp/rm-dump-classification"
EVENT_DUMP = "/tmp/rm-dump-event"

if not os.path.isdir(PERSON_DUMP):
    print(f"SKIP: {PERSON_DUMP} not found; cannot run fixture tests")
    sys.exit(0)

# ── Test 2a: person with schema:name + schema:alternateName + schema:sameAs ──
# Pick one with at least 2 sameAs URIs so we exercise multi-authority classification.
fx = find_fixture(
    PERSON_DUMP,
    lambda _p, t: t.count("<http://schema.org/sameAs>") >= 2
                  and "<http://schema.org/name>" in t
                  and "<http://schema.org/Person>" in t,
)
if fx is None:
    check("fixture 2a person with ≥2 sameAs exists", False, "no matching fixture")
else:
    rec = parse_nt_file(str(fx), default_type="person")
    check("2a parse returns dict", rec is not None, f"got {rec!r}")
    if rec:
        check("2a type=person", rec["type"] == "person", f"got {rec['type']!r}")
        check("2a has label", bool(rec["label_en"] or rec["label_nl"]),
              f"label_en={rec['label_en']!r} label_nl={rec['label_nl']!r}")
        check("2a external_ids populated", len(rec["_external_ids"]) >= 2,
              f"got {len(rec['_external_ids'])} entries: {rec['_external_ids']}")
        authorities = {a for a, _, _ in rec["_external_ids"]}
        check("2a has real authority (not just 'other')",
              any(a != "other" for a in authorities),
              f"authorities: {authorities}")
        # Legacy column should be populated (first-match priority)
        check("2a legacy external_id populated",
              rec["external_id"] is not None,
              f"got {rec['external_id']!r}")
    print(f"  fixture 2a: {fx}")

# ── Test 2b: anonymous person (only schema:alternateName, no schema:name) ──
# There are exactly 7 of these in the person dump per the #238 sweep. They
# may be rare enough that find_fixture is slow; bounded walk.
anon_count = 0
fx = None
for dirpath, _, filenames in os.walk(PERSON_DUMP):
    for fn in filenames:
        p = Path(dirpath) / fn
        try:
            txt = p.read_text(encoding="utf-8")
        except OSError:
            continue
        has_name = "<http://schema.org/name>" in txt
        has_alt = "<http://schema.org/alternateName>" in txt
        if not has_name and has_alt:
            fx = p
            break
    if fx:
        break

if fx is None:
    check("fixture 2b anonymous person exists", False, "none found (expected ~7 in dump)")
else:
    rec = parse_nt_file(str(fx), default_type="person")
    check("2b parse returns dict (alternateName fallback)",
          rec is not None, f"got {rec!r}")
    if rec:
        check("2b type=person", rec["type"] == "person", f"got {rec['type']!r}")
        check("2b fell back to alternateName label",
              bool(rec["label_en"] or rec["label_nl"]),
              f"label_en={rec['label_en']!r} label_nl={rec['label_nl']!r}")
    print(f"  fixture 2b: {fx}")

# ── Test 2c: organisation ──
fx = find_fixture(
    ORG_DUMP,
    lambda _p, t: "<http://schema.org/Organization>" in t
                  and "<http://schema.org/name>" in t,
)
if fx is None:
    check("fixture 2c organisation exists", False, "")
else:
    rec = parse_nt_file(str(fx), default_type="organisation")
    check("2c parse returns dict", rec is not None, f"got {rec!r}")
    if rec:
        check("2c type=organisation", rec["type"] == "organisation",
              f"got {rec['type']!r}")
        check("2c has label", bool(rec["label_en"] or rec["label_nl"]),
              f"{rec}")
    print(f"  fixture 2c: {fx}")

# ── Test 2d: topical_term with @nl-NL label + AAT sameAs ──
fx = find_fixture(
    TOPICAL_DUMP,
    lambda _p, t: "<http://schema.org/DefinedTerm>" in t
                  and '"@nl-NL' in t
                  and "vocab.getty.edu/aat/" in t,
)
if fx is None:
    check("fixture 2d topical_term w/ AAT exists", False, "")
else:
    rec = parse_nt_file(str(fx), default_type="classification")
    check("2d parse returns dict", rec is not None, f"got {rec!r}")
    if rec:
        check("2d type=classification", rec["type"] == "classification",
              f"got {rec['type']!r}")
        # This exercises the BCP 47 `@nl-NL` language-tag fix specifically.
        check("2d @nl-NL label captured as label_nl",
              rec["label_nl"] is not None,
              f"label_en={rec['label_en']!r} label_nl={rec['label_nl']!r}")
        authorities = {a for a, _, _ in rec["_external_ids"]}
        check("2d has aat authority",
              "aat" in authorities,
              f"authorities: {authorities}")
    print(f"  fixture 2d: {fx}")

# ── Test 2e: Schema.org-shape place (schema:Place + schema:sameAs to TGN) ──
fx = find_fixture(
    PLACE_DUMP,
    lambda _p, t: "<http://schema.org/Place>" in t
                  and "<http://schema.org/name>" in t
                  and "vocab.getty.edu/tgn/" in t,
)
if fx is None:
    check("fixture 2e Schema.org place exists", False, "")
else:
    rec = parse_nt_file(str(fx), default_type="place")
    check("2e parse returns dict", rec is not None, f"got {rec!r}")
    if rec:
        check("2e type=place", rec["type"] == "place",
              f"got {rec['type']!r}")
        check("2e has label", bool(rec["label_en"] or rec["label_nl"]),
              f"{rec}")
        authorities = {a for a, _, _ in rec["_external_ids"]}
        check("2e has tgn authority",
              "tgn" in authorities,
              f"authorities: {authorities}")
    print(f"  fixture 2e: {fx}")


# ─── 3. Regression: Linked Art shape still works ──────────────────────

print()
print("=" * 60)
print("Regression: Linked Art dumps still parse correctly")
print("=" * 60)

# ── Test 3a: classification (pure Linked Art, blank-node appellations) ──
if os.path.isdir(CLASS_DUMP):
    fx = find_fixture(
        CLASS_DUMP,
        lambda _p, t: "E33_E41_Linguistic_Appellation" in t
                      and "iconclass.org" in t,
    )
    if fx is None:
        check("fixture 3a classification exists", False, "")
    else:
        rec = parse_nt_file(str(fx), default_type="classification")
        check("3a LA classification parses", rec is not None, f"got {rec!r}")
        if rec:
            check("3a LA classification label present",
                  bool(rec["label_en"] or rec["label_nl"]),
                  f"{rec}")
            check("3a LA classification external_id present",
                  rec["external_id"] is not None,
                  f"got {rec['external_id']!r}")
            # Iconclass reference should classify as 'iconclass'
            authorities = {a for a, _, _ in rec["_external_ids"]}
            check("3a LA classification has iconclass authority",
                  "iconclass" in authorities,
                  f"authorities: {authorities}")
        print(f"  fixture 3a: {fx}")

# ── Test 3b: Linked Art place with POINT coordinates (regression) ──
if os.path.isdir(PLACE_DUMP):
    fx = find_fixture(
        PLACE_DUMP,
        lambda _p, t: "P168_place_is_defined_by" in t
                      and "POINT(" in t,
    )
    if fx is None:
        check("fixture 3b LA place with coords exists", False, "")
    else:
        rec = parse_nt_file(str(fx), default_type="place")
        check("3b LA place parses", rec is not None, f"got {rec!r}")
        if rec:
            check("3b LA place has coords",
                  rec["lat"] is not None and rec["lon"] is not None,
                  f"lat={rec['lat']} lon={rec['lon']}")
            check("3b LA place type=place", rec["type"] == "place",
                  f"got {rec['type']!r}")
        print(f"  fixture 3b: {fx}")

# ── Test 3c: event ──
if os.path.isdir(EVENT_DUMP):
    fx = find_fixture(
        EVENT_DUMP,
        lambda _p, t: "E7_Activity" in t,
    )
    if fx is None:
        check("fixture 3c event exists", False, "")
    else:
        rec = parse_nt_file(str(fx), default_type="event")
        check("3c event parses", rec is not None, f"got {rec!r}")
        if rec:
            check("3c event type=event", rec["type"] == "event",
                  f"got {rec['type']!r}")
        print(f"  fixture 3c: {fx}")


# ─── Summary ──────────────────────────────────────────────────────────

print()
print("=" * 60)
print(recorder.summary())
for f in recorder.failures:
    print(f"  ✗ {f}")
print("=" * 60)

sys.exit(recorder.exit_code())
