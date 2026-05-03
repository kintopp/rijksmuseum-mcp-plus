#!/usr/bin/env python3
"""Unit tests for the #245 other-language label fallback in parse_nt_file.

Synthetic .nt fixtures exercise the five fallback channels (bnode display-name,
skos/rdfs language-tagged, skos/rdfs untagged, schema:name any-lang,
schema:alternateName any-lang) plus the negative case (no labels at all →
still returns None for non-event types).

Each fixture is a minimal handful of N-Triples lines, the smallest shape that
hits exactly one fallback path. Real dropped files in the dumps tend to be a
mix of these shapes; covering them in isolation is more diagnostic if the
fallback ever regresses.

Run:
    ~/miniconda3/envs/embeddings/bin/python scripts/tests/test_other_language_fallback.py
or:
    python3 scripts/tests/test_other_language_fallback.py
"""

import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _test_helpers import CheckRecorder, load_harvest_module

harvest_mod = load_harvest_module()
parse_nt_file = harvest_mod.parse_nt_file

recorder = CheckRecorder()
check = recorder.check


def write_fixture(tmpdir: Path, entity_id: str, lines: list[str]) -> Path:
    """Write an .nt fixture with the entity_id as the basename. The parser
    derives `entity_uri` from the basename, so the test fixture filename
    must match the subject URI used in the triples."""
    p = tmpdir / entity_id
    p.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return p


with tempfile.TemporaryDirectory() as tmp:
    tmpdir = Path(tmp)

    print("=" * 60)
    print("parse_nt_file — #245 other-language fallback")
    print("=" * 60)

    # ── Channel 1: bnode display-name with non-en/non-nl AAT language URI ──
    # Mirrors the LA/CIDOC shape but the language URI is French (300388306).
    fr_lang = "http://vocab.getty.edu/aat/300388306"  # French AAT
    aat_display = "http://vocab.getty.edu/aat/300404670"  # display-name
    p1 = write_fixture(tmpdir, "fr-bnode-display", [
        f'<https://id.rijksmuseum.nl/fr-bnode-display> '
        f'<http://www.cidoc-crm.org/cidoc-crm/P1_is_identified_by> _:b1 .',
        f'_:b1 <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> '
        f'<http://www.cidoc-crm.org/cidoc-crm/E33_E41_Linguistic_Appellation> .',
        f'_:b1 <http://www.cidoc-crm.org/cidoc-crm/P190_has_symbolic_content> '
        f'"Hôtel-Dieu" .',
        f'_:b1 <http://www.cidoc-crm.org/cidoc-crm/P72_has_language> <{fr_lang}> .',
        f'_:b1 <http://www.cidoc-crm.org/cidoc-crm/P2_has_type> <{aat_display}> .',
    ])
    r = parse_nt_file(str(p1), "place")
    check("bnode FR display-name → label_en fallback",
          r is not None and r["label_en"] == "Hôtel-Dieu" and r["label_nl"] is None,
          f"got {r}")

    # ── Channel 2: skos:prefLabel with non-en/non-nl @lang ──
    p2 = write_fixture(tmpdir, "fr-skos-prefLabel", [
        '<https://id.rijksmuseum.nl/fr-skos-prefLabel> '
        '<http://www.w3.org/2004/02/skos/core#prefLabel> "Schéma directeur"@fr .',
    ])
    r = parse_nt_file(str(p2), "classification")
    check("skos:prefLabel @fr → label_en fallback",
          r is not None and r["label_en"] == "Schéma directeur",
          f"got {r}")

    # ── Channel 3: rdfs:label with no @lang tag at all ──
    p3 = write_fixture(tmpdir, "untagged-rdfs-label", [
        '<https://id.rijksmuseum.nl/untagged-rdfs-label> '
        '<http://www.w3.org/2000/01/rdf-schema#label> "untaggedlabel" .',
    ])
    r = parse_nt_file(str(p3), "classification")
    check("rdfs:label untagged → label_en fallback",
          r is not None and r["label_en"] == "untaggedlabel",
          f"got {r}")

    # ── Channel 4: schema:name with only a non-en/non-nl @lang ──
    # Topical_term shape with a German-only schema:name; no en/nl present.
    p4 = write_fixture(tmpdir, "de-schema-name", [
        '<https://id.rijksmuseum.nl/de-schema-name> '
        '<http://www.w3.org/1999/02/22-rdf-syntax-ns#type> '
        '<http://schema.org/DefinedTerm> .',
        '<https://id.rijksmuseum.nl/de-schema-name> '
        '<http://schema.org/name> "Bildhauerei"@de .',
    ])
    r = parse_nt_file(str(p4), "topical_term")
    check("schema:name @de-only → label_en fallback",
          r is not None and r["label_en"] == "Bildhauerei",
          f"got {r}")

    # ── Channel 5: only schema:alternateName in non-en/non-nl ──
    p5 = write_fixture(tmpdir, "fr-alternate-only", [
        '<https://id.rijksmuseum.nl/fr-alternate-only> '
        '<http://www.w3.org/1999/02/22-rdf-syntax-ns#type> '
        '<http://schema.org/Person> .',
        '<https://id.rijksmuseum.nl/fr-alternate-only> '
        '<http://schema.org/alternateName> "DupontPseudo"@fr .',
    ])
    r = parse_nt_file(str(p5), "person")
    check("schema:alternateName @fr-only → label_en fallback",
          r is not None and r["label_en"] == "DupontPseudo",
          f"got {r}")

    # ── Negative: truly no labels → still returns None for non-event ──
    p6 = write_fixture(tmpdir, "no-labels-classification", [
        '<https://id.rijksmuseum.nl/no-labels-classification> '
        '<http://www.cidoc-crm.org/cidoc-crm/P127_has_broader_term> '
        '<https://id.rijksmuseum.nl/some-other-id> .',
    ])
    r = parse_nt_file(str(p6), "classification")
    check("no labels of any kind (classification) → None",
          r is None, f"got {r}")

    # ── Negative-but-event: events still get entity_id as label ──
    p7 = write_fixture(tmpdir, "event-no-labels", [
        '<https://id.rijksmuseum.nl/event-no-labels> '
        '<http://www.w3.org/1999/02/22-rdf-syntax-ns#type> '
        '<http://www.cidoc-crm.org/cidoc-crm/E5_Event> .',
    ])
    r = parse_nt_file(str(p7), "event")
    check("event with no labels → entity_id fallback (preserved)",
          r is not None and r["label_en"] == "event-no-labels",
          f"got {r}")

    # ── Escape-quote regression (#245 second finding): `\"` inside a
    # literal must not terminate the regex match early. Without the fix
    # this case dropped silently — we found 142 organisations, 9 concepts
    # and 7 persons in the v0.26 dumps that hit this path.
    p9 = write_fixture(tmpdir, "embedded-quote-name", [
        '<https://id.rijksmuseum.nl/embedded-quote-name> '
        '<http://www.w3.org/1999/02/22-rdf-syntax-ns#type> '
        '<http://schema.org/Organization> .',
        '<https://id.rijksmuseum.nl/embedded-quote-name> '
        '<http://schema.org/name> "Verein \\"Arbeitsgruppe\\"" .',
    ])
    r = parse_nt_file(str(p9), "organisation")
    check("schema:name with embedded `\\\"` survives + unescapes",
          r is not None and r["label_en"] == 'Verein "Arbeitsgruppe"',
          f"got {r}")

    # Backslash in a literal: \\ should round-trip to a single backslash.
    p10 = write_fixture(tmpdir, "embedded-backslash", [
        '<https://id.rijksmuseum.nl/embedded-backslash> '
        '<http://www.w3.org/1999/02/22-rdf-syntax-ns#type> '
        '<http://schema.org/Organization> .',
        '<https://id.rijksmuseum.nl/embedded-backslash> '
        '<http://schema.org/name> "C:\\\\Windows" .',
    ])
    r = parse_nt_file(str(p10), "organisation")
    check("schema:name with embedded `\\\\` survives + unescapes",
          r is not None and r["label_en"] == "C:\\Windows",
          f"got {r}")

    # ── Regression: en/nl labels still take precedence over fallbacks ──
    en_lang = "http://vocab.getty.edu/aat/300388277"  # English AAT
    p8 = write_fixture(tmpdir, "en-with-fr-fallback", [
        f'<https://id.rijksmuseum.nl/en-with-fr-fallback> '
        f'<http://www.cidoc-crm.org/cidoc-crm/P1_is_identified_by> _:b1 .',
        f'_:b1 <http://www.cidoc-crm.org/cidoc-crm/P190_has_symbolic_content> '
        f'"English Label" .',
        f'_:b1 <http://www.cidoc-crm.org/cidoc-crm/P72_has_language> <{en_lang}> .',
        f'_:b1 <http://www.cidoc-crm.org/cidoc-crm/P2_has_type> <{aat_display}> .',
        '<https://id.rijksmuseum.nl/en-with-fr-fallback> '
        '<http://www.w3.org/2000/01/rdf-schema#label> "untagged extra" .',
    ])
    r = parse_nt_file(str(p8), "classification")
    check("en label present → fallbacks ignored (label_en stays English)",
          r is not None and r["label_en"] == "English Label",
          f"got {r}")

print()
print("=" * 60)
print(recorder.summary())
print("=" * 60)
sys.exit(recorder.exit_code())
