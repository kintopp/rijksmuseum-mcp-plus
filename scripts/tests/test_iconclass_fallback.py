#!/usr/bin/env python3
"""Unit tests for the #245 Tier 1 Iconclass fallback resolver.

Builds a tiny synthetic iconclass.db with a handful of `texts` rows, then
runs `make_iconclass_resolver()` against it to verify the three resolution
strategies (exact, paren-stripped, progressive prefix). Also tests that
`parse_nt_file` calls the resolver only as the very last fallback —
en/nl labels and other-language fallbacks should still take precedence.

Run:
    ~/miniconda3/envs/embeddings/bin/python scripts/tests/test_iconclass_fallback.py
or:
    python3 scripts/tests/test_iconclass_fallback.py
"""

import os
import sqlite3
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _test_helpers import CheckRecorder, load_harvest_module, write_nt_fixture as write_fixture

harvest_mod = load_harvest_module()
parse_nt_file = harvest_mod.parse_nt_file
make_iconclass_resolver = harvest_mod.make_iconclass_resolver

recorder = CheckRecorder()
check = recorder.check


def build_synthetic_iconclass_db(path: Path) -> None:
    """Create a minimal iconclass.db schema with hand-picked notations
    covering the three resolution strategies."""
    conn = sqlite3.connect(path)
    conn.executescript("""
        CREATE TABLE texts (notation TEXT NOT NULL, lang TEXT NOT NULL, text TEXT NOT NULL);
        CREATE INDEX idx_texts_notation_lang ON texts(notation, lang);
    """)
    conn.executemany(
        "INSERT INTO texts VALUES (?, ?, ?)",
        [
            # Exact-match candidate: full canonical Iconclass with + qualifier
            ("41D224(+81)", "en", "sleeves with cuffs"),
            ("41D224(+81)", "nl", "mouwen met manchetten"),
            # Paren-strip candidate: base notation that the (+81) above derives from
            ("41D224", "en", "sleeves"),
            ("41D224", "nl", "mouwen"),
            # Progressive-prefix candidate: ancestor of 41D2619
            ("41D261", "en", "ornamental parts of clothing"),
            ("41D26", "en", "ornaments on clothing"),
            # English-only entry (no Dutch)
            ("99X9", "en", "test english only"),
            # Dutch-only entry (no English)
            ("99Y9", "nl", "alleen-nederlands"),
        ],
    )
    conn.commit()
    conn.close()


with tempfile.TemporaryDirectory() as tmp:
    tmpdir = Path(tmp)
    db_path = tmpdir / "iconclass.db"
    build_synthetic_iconclass_db(db_path)

    print("=" * 60)
    print("make_iconclass_resolver() — resolution strategies")
    print("=" * 60)

    resolver = make_iconclass_resolver(str(db_path))
    check("resolver builds when DB exists", resolver is not None,
          f"got {resolver!r}")

    # ── Strategy 1: exact match ──
    r = resolver("41D224(+81)")
    check("exact: 41D224(+81) → en+nl pair",
          r == ("sleeves with cuffs", "mouwen met manchetten"), f"got {r}")

    # ── Strategy 2: paren-strip (Rijksmuseum-specific keys) ──
    r = resolver("41D224(SIERMOUWEN)")
    check("paren-strip: 41D224(SIERMOUWEN) → 41D224 → 'sleeves'",
          r == ("sleeves", "mouwen"), f"got {r}")

    # ── Strategy 3: progressive prefix ──
    # 41D2619 doesn't exist; 41D261 does (after 1-char shave)
    r = resolver("41D2619")
    check("prefix-shave: 41D2619 → 41D261 → 'ornamental parts'",
          r == ("ornamental parts of clothing", None), f"got {r}")

    # Combined paren-strip + prefix-shave
    r = resolver("41D2619(+82)")
    check("combined: 41D2619(+82) → 41D2619 → 41D261 → 'ornamental parts'",
          r == ("ornamental parts of clothing", None), f"got {r}")

    # ── English-only / Dutch-only entries ──
    r = resolver("99X9")
    check("english-only: 99X9 → ('test english only', None)",
          r == ("test english only", None), f"got {r}")

    r = resolver("99Y9")
    check("dutch-only: 99Y9 → (None, 'alleen-nederlands')",
          r == (None, "alleen-nederlands"), f"got {r}")

    # ── Negative: no candidate matches at any prefix ──
    r = resolver("ZZZNOEXIST")
    # Z, ZZ, ... none exist
    check("no-match: ZZZNOEXIST → None", r is None, f"got {r}")

    # ── Empty / whitespace ──
    r = resolver("")
    check("empty notation → None", r is None, f"got {r}")

    # ── Resolver not built when DB missing ──
    none_resolver = make_iconclass_resolver(str(tmpdir / "doesnotexist.db"))
    check("missing DB → resolver is None", none_resolver is None,
          f"got {none_resolver!r}")

    # ─────────────────────────────────────────────────────────────────
    print()
    print("=" * 60)
    print("parse_nt_file() — iconclass fallback wiring")
    print("=" * 60)

    # Synthetic dropped-classification fixture: notation only, no label
    aat_e42 = "http://www.cidoc-crm.org/cidoc-crm/E42_Identifier"
    aat_p190 = "http://www.cidoc-crm.org/cidoc-crm/P190_has_symbolic_content"
    aat_rdf_type = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type"

    p1 = write_fixture(tmpdir, "siermouwen-fixture", [
        f'<https://id.rijksmuseum.nl/siermouwen-fixture> '
        f'<http://www.cidoc-crm.org/cidoc-crm/P1_is_identified_by> _:b1 .',
        f'_:b1 <{aat_rdf_type}> <{aat_e42}> .',
        f'_:b1 <{aat_p190}> "41D224(SIERMOUWEN)" .',
    ])
    # Without resolver: returns None (notation-only is dropped)
    r = parse_nt_file(str(p1), "classification", iconclass_resolver=None)
    check("no resolver → notation-only classification still drops",
          r is None, f"got {r}")
    # With resolver: paren-strip recovers "sleeves"/"mouwen"
    r = parse_nt_file(str(p1), "classification", iconclass_resolver=resolver)
    check("with resolver → notation-only recovers via iconclass.db",
          r is not None and r["label_en"] == "sleeves" and r["label_nl"] == "mouwen",
          f"got {r}")
    check("recovered row preserves notation field",
          r is not None and r["notation"] == "41D224(SIERMOUWEN)", f"got {r}")

    # Resolver should NOT fire when other label channels work
    en_lang = "http://vocab.getty.edu/aat/300388277"
    aat_display = "http://vocab.getty.edu/aat/300404670"
    p2 = write_fixture(tmpdir, "labelled-fixture", [
        f'<https://id.rijksmuseum.nl/labelled-fixture> '
        f'<http://www.cidoc-crm.org/cidoc-crm/P1_is_identified_by> _:b1 .',
        f'_:b1 <{aat_rdf_type}> <{aat_e42}> .',
        f'_:b1 <{aat_p190}> "41D224(SIERMOUWEN)" .',
        f'<https://id.rijksmuseum.nl/labelled-fixture> '
        f'<http://www.cidoc-crm.org/cidoc-crm/P1_is_identified_by> _:b2 .',
        f'_:b2 <{aat_p190}> "User-supplied English Label" .',
        f'_:b2 <http://www.cidoc-crm.org/cidoc-crm/P72_has_language> <{en_lang}> .',
        f'_:b2 <http://www.cidoc-crm.org/cidoc-crm/P2_has_type> <{aat_display}> .',
    ])
    r = parse_nt_file(str(p2), "classification", iconclass_resolver=resolver)
    check("resolver bypassed when en label is present",
          r is not None and r["label_en"] == "User-supplied English Label",
          f"got {r}")

    # ── URI-only path: notation derived from iconclass.org `equivalent` URI
    # when no P190 literal exists. ~11 dropped classifications carry only
    # `<entity> linked.art/equivalent <https://iconclass.org/61BB11%28%2B0%29>`
    # with NO `P190_has_symbolic_content` literal anywhere. Earlier the
    # resolver couldn't fire because `notation` was unset; now we URL-decode
    # the URI path and feed that to the resolver. The decoded form for `+0`
    # is `61BB11(+0)` → progressive prefix shaves to `41D224` doesn't match,
    # but for the synthetic test we use a notation that DOES exist in our
    # tiny iconclass.db: 41D224.
    p_uri_only = write_fixture(tmpdir, "uri-only-fixture", [
        f'<https://id.rijksmuseum.nl/uri-only-fixture> '
        f'<https://linked.art/ns/terms/equivalent> '
        f'<https://iconclass.org/41D224%28SIERMOUWEN%29> .',
    ])
    r = parse_nt_file(str(p_uri_only), "classification", iconclass_resolver=resolver)
    check("URI-only: iconclass.org URI URL-decoded → notation → resolver",
          r is not None and r["label_en"] == "sleeves" and r["notation"] == "41D224(SIERMOUWEN)",
          f"got {r}")

    # Resolver should NOT fire on places. Per #328, places no longer carry
    # POINT in `notation` — the WKT lives only in `defined_by` for lat/lon
    # extraction. A place fixture with no labels is dropped regardless.
    p3 = write_fixture(tmpdir, "place-fixture", [
        f'<https://id.rijksmuseum.nl/place-fixture> '
        f'<http://www.cidoc-crm.org/cidoc-crm/P168_place_is_defined_by> '
        f'"POINT(4.5 52.3)" .',
    ])
    r = parse_nt_file(str(p3), "place", iconclass_resolver=resolver)
    check("label-less place is dropped, regardless of POINT defined_by",
          r is None, f"got {r}")

    # #328: a labelled place keeps lat/lon from POINT but notation stays None.
    p3b = write_fixture(tmpdir, "labelled-place-fixture", [
        f'<https://id.rijksmuseum.nl/labelled-place-fixture> '
        f'<http://www.cidoc-crm.org/cidoc-crm/P1_is_identified_by> _:b1 .',
        f'_:b1 <{aat_p190}> "Amsterdam" .',
        f'_:b1 <http://www.cidoc-crm.org/cidoc-crm/P72_has_language> <{en_lang}> .',
        f'_:b1 <http://www.cidoc-crm.org/cidoc-crm/P2_has_type> <{aat_display}> .',
        f'<https://id.rijksmuseum.nl/labelled-place-fixture> '
        f'<http://www.cidoc-crm.org/cidoc-crm/P168_place_is_defined_by> '
        f'"POINT(4.916667 52.3500)" .',
    ])
    r = parse_nt_file(str(p3b), "place", iconclass_resolver=resolver)
    check("labelled place: lat/lon populated, notation is None (#328)",
          r is not None
          and r["notation"] is None
          and r["lat"] == 52.3500
          and r["lon"] == 4.916667,
          f"got {r}")

    # Resolver should NOT fire on non-classification types
    p4 = write_fixture(tmpdir, "person-fixture", [
        f'<https://id.rijksmuseum.nl/person-fixture> '
        f'<http://www.cidoc-crm.org/cidoc-crm/P1_is_identified_by> _:b1 .',
        f'_:b1 <{aat_rdf_type}> <{aat_e42}> .',
        f'_:b1 <{aat_p190}> "41D224(SIERMOUWEN)" .',
    ])
    r = parse_nt_file(str(p4), "person", iconclass_resolver=resolver)
    check("non-classification type doesn't trigger iconclass resolver",
          r is None, f"got {r}")

print()
print("=" * 60)
print(recorder.summary())
print("=" * 60)
sys.exit(recorder.exit_code())
