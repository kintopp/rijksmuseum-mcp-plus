"""Unit tests for scripts/lib/bibliography_extract.py.

Tests the pure A/B/C classifier and compose_citation combiner.
Run: python3 scripts/tests/test-bibliography-extract.py
Not included in npm run test:ci (Python, not Node).
"""
import sys
import traceback
from pathlib import Path

# Make scripts/ importable so `from lib.bibliography_extract import …` resolves.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from lib.bibliography_extract import extract_citations, compose_citation

AAT_CITATION = "http://vocab.getty.edu/aat/300311954"
AAT_SEQUENCE = "http://vocab.getty.edu/aat/300456575"
AAT_CITATION_TEXT = "http://vocab.getty.edu/aat/300311705"
BIBFRAME_INSTANCE = "http://id.loc.gov/ontologies/bibframe/Instance"

passed = 0
failed = 0


def check(label: str, fn):
    global passed, failed
    try:
        fn()
        print(f"  PASS  {label}")
        passed += 1
    except AssertionError as e:
        print(f"  FAIL  {label}: {e}")
        traceback.print_exc()
        failed += 1


# ─── Fixture helpers ──────────────────────────────────────────────────

def make_entry(ctype: str, seq: int | None = 1, pub_id_segment: str = "301154354",
               inline: str | None = None, pages: str | None = None):
    """Build a minimal assigned_by[] entry for each type."""
    classified_as = [{"id": AAT_CITATION}]
    identified_by = []
    if seq is not None:
        identified_by.append({
            "classified_as": [{"id": AAT_SEQUENCE}],
            "content": str(seq),
        })

    if ctype == "B":
        # assigned[0] has identified_by with the inline string
        assigned = [{
            "identified_by": [
                {
                    "classified_as": [{"id": AAT_CITATION_TEXT}],
                    "content": inline or "E. van Duijn, The Art of Conservation, Burlington, 2016",
                }
            ]
        }]
    elif ctype == "B_fallback":
        # B variant where the string is nested in part[0].content
        assigned = [{
            "identified_by": [
                {
                    "classified_as": [{"id": AAT_CITATION_TEXT}],
                    "content": None,  # primary content absent
                    "part": [{"content": inline or "Fallback citation from part[0].content"}],
                }
            ]
        }]
        ctype = "B"
    elif ctype == "A":
        # assigned[0] has part_of[0].id referencing a publication URI
        # + identified_by[0] carries the per-artwork page locus in part[0].content
        assigned = [{
            "part_of": [{"id": f"https://id.rijksmuseum.nl/{pub_id_segment}"}],
            "identified_by": [
                {
                    "classified_as": [{"id": AAT_CITATION_TEXT}],
                    "part": [{"content": pages or "p. 169-170, afb. 6"}],
                }
            ],
        }]
    elif ctype == "C":
        assigned = [{
            "type": BIBFRAME_INSTANCE,
            "id": f"https://id.rijksmuseum.nl/{pub_id_segment}",
        }]
    else:
        raise ValueError(f"Unknown ctype {ctype!r}")

    return {
        "classified_as": classified_as,
        "identified_by": identified_by,
        "assigned": assigned,
    }


def make_no_assigned_entry(seq: int | None = 5):
    """Entry with no 'assigned' — Type B empty."""
    classified_as = [{"id": AAT_CITATION}]
    identified_by = []
    if seq is not None:
        identified_by.append({
            "classified_as": [{"id": AAT_SEQUENCE}],
            "content": str(seq),
        })
    return {
        "classified_as": classified_as,
        "identified_by": identified_by,
        # no "assigned" key
    }


STUB_PUB = {
    "creditText": "J.F. Heijbroek; Herbert Henkels",
    "name": "Het Rijksmuseum voor Moderne Kunst van Willem Steenhoff",
    "isPartOf": {"name": "Bulletin van het Rijksmuseum"},
    "pagination": "39(1991), p. 163-249",
    "sameAs": "http://www.worldcat.org/oclc/775938344",
    "url": "https://library.rijksmuseum.nl/cgi-bin/koha/opac-detail.pl?biblionumber=154354",
}

# ─── Tests ────────────────────────────────────────────────────────────

# --- extract_citations tests ---

def check_extract_a():
    data = {"assigned_by": [make_entry("A", seq=1, pub_id_segment="301154354", pages="p. 169-170, afb. 6")]}
    raws = extract_citations(data)
    assert len(raws) == 1, f"Expected 1, got {len(raws)}"
    r = raws[0]
    assert r["ctype"] == "A", f"ctype should be A, got {r['ctype']!r}"
    assert r["publication_id"] == 301154354, f"pub_id {r['publication_id']!r}"
    assert r["pages"] == "p. 169-170, afb. 6", f"pages {r['pages']!r}"
    assert r["seq"] == 1, f"seq {r['seq']!r}"
    assert r["inline_text"] is None, f"inline_text should be None, got {r['inline_text']!r}"

check("Type A: correct ctype, publication_id, pages, seq", check_extract_a)


def check_extract_b_inline():
    inline = "E. van Duijn, The Art of Conservation, Burlington, 2016"
    data = {"assigned_by": [make_entry("B", seq=2, inline=inline)]}
    raws = extract_citations(data)
    assert len(raws) == 1
    r = raws[0]
    assert r["ctype"] == "B", f"ctype {r['ctype']!r}"
    assert r["publication_id"] is None, "B should have no publication_id"
    assert r["pages"] is None, f"B pages should be None, got {r['pages']!r}"
    assert r["inline_text"] == inline, f"inline_text {r['inline_text']!r}"
    assert r["seq"] == 2, f"seq {r['seq']!r}"

check("Type B: ctype=B, publication_id=None, pages=None, inline_text set", check_extract_b_inline)


def check_extract_b_fallback():
    """B variant where the string is nested in identified_by[0].part[0].content."""
    fallback = "Fallback citation from part[0].content"
    entry = make_entry("B_fallback", seq=3, inline=fallback)
    data = {"assigned_by": [entry]}
    raws = extract_citations(data)
    assert len(raws) == 1
    r = raws[0]
    assert r["ctype"] == "B"
    assert r["inline_text"] == fallback, f"inline_text {r['inline_text']!r}"
    assert r["pages"] is None

check("Type B fallback (part[0].content): inline_text from nested part", check_extract_b_fallback)


def check_extract_c():
    data = {"assigned_by": [make_entry("C", seq=4, pub_id_segment="301234479")]}
    raws = extract_citations(data)
    assert len(raws) == 1
    r = raws[0]
    assert r["ctype"] == "C", f"ctype {r['ctype']!r}"
    assert r["publication_id"] == 301234479, f"pub_id {r['publication_id']!r}"
    assert r["pages"] is None
    assert r["inline_text"] is None

check("Type C: ctype=C, publication_id set, pages=None", check_extract_c)


def check_no_assigned():
    entry = make_no_assigned_entry(seq=5)
    data = {"assigned_by": [entry]}
    raws = extract_citations(data)
    assert len(raws) == 1
    r = raws[0]
    assert r["ctype"] == "B", f"ctype {r['ctype']!r}"
    assert r["inline_text"] == "", f"inline_text should be empty string, got {r['inline_text']!r}"
    assert r["seq"] == 5

check("No assigned element: ctype=B, inline_text=''", check_no_assigned)


def check_skips_non_citation():
    """Entries without AAT_CITATION classification are ignored."""
    data = {"assigned_by": [
        {
            "classified_as": [{"id": "http://vocab.getty.edu/aat/999999999"}],
            "identified_by": [],
            "assigned": [],
        },
        make_entry("B", seq=1),
    ]}
    raws = extract_citations(data)
    assert len(raws) == 1, f"Should skip non-citation entry, got {len(raws)}"
    assert raws[0]["ctype"] == "B"

check("Non-citation entries are skipped", check_skips_non_citation)


def check_non_digit_pub_segment():
    """A non-digit publication URI segment → publication_id=None (not an exception)."""
    entry = make_entry("A", seq=1, pub_id_segment="not-a-number", pages="p. 5")
    data = {"assigned_by": [entry]}
    raws = extract_citations(data)
    assert len(raws) == 1
    r = raws[0]
    # ctype is still A, but publication_id should be None since segment is non-numeric
    assert r["publication_id"] is None, f"Expected None for non-digit segment, got {r['publication_id']!r}"

check("Non-digit publication URI segment → publication_id=None (no exception)", check_non_digit_pub_segment)


# --- compose_citation tests ---

def check_compose_a_with_pub():
    raw = {"seq": 2, "ctype": "A", "publication_id": 301154354, "pages": "p. 169-170", "inline_text": None}
    row = compose_citation(raw, STUB_PUB)
    assert "creditText" not in row, "should return composed row, not raw pub"
    assert "J.F. Heijbroek" in row["citation_text"], f"creditText missing: {row['citation_text']!r}"
    assert "Het Rijksmuseum" in row["citation_text"], f"name missing: {row['citation_text']!r}"
    assert "Bulletin van het Rijksmuseum" in row["citation_text"], f"journal missing: {row['citation_text']!r}"
    assert "39(1991)" in row["citation_text"], f"pagination missing: {row['citation_text']!r}"
    assert row["worldcat_uri"] == STUB_PUB["sameAs"]
    assert row["library_url"] == STUB_PUB["url"]
    assert row["publication_id"] == 301154354
    assert row["pages"] == "p. 169-170"

check("compose_citation A+pub: creditText/name/journal/pagination all present", check_compose_a_with_pub)


def check_compose_c_no_pub():
    """Type C with failed resolution → fallback starts with '(publication ...'."""
    raw = {"seq": 3, "ctype": "C", "publication_id": 301234479, "pages": None, "inline_text": None}
    row = compose_citation(raw, None)
    assert row["citation_text"].startswith("(publication "), f"fallback missing: {row['citation_text']!r}"
    assert len(row["citation_text"]) > 0, "citation_text must not be empty (NOT NULL)"
    assert row["isbn"] is None
    assert row["worldcat_uri"] is None

check("compose_citation C+None pub: fallback non-empty, starts with '(publication'", check_compose_c_no_pub)


def check_compose_b():
    raw = {"seq": 1, "ctype": "B", "publication_id": None, "pages": None,
           "inline_text": "E. van Duijn, The Art of Conservation, Burlington, 2016"}
    row = compose_citation(raw, None)
    assert row["citation_text"] == raw["inline_text"]
    assert row["publication_id"] is None
    assert row["isbn"] is None

check("compose_citation B: uses inline_text verbatim", check_compose_b)


def check_compose_isbn_list():
    """isbn as list → flattened to scalar string."""
    pub = dict(STUB_PUB, isbn=["978-90-12345-1", "978-90-12345-2"])
    raw = {"seq": 1, "ctype": "A", "publication_id": 301154354, "pages": None, "inline_text": None}
    row = compose_citation(raw, pub)
    assert isinstance(row["isbn"], str), f"isbn should be str, got {type(row['isbn'])}"
    assert ";" in row["isbn"], f"should join multiple isbns: {row['isbn']!r}"

check("compose_citation: isbn list → scalar string (F1 guard)", check_compose_isbn_list)


# ─── Summary ─────────────────────────────────────────────────────────

print(f"\n{'='*50}")
print(f"  {passed} passed, {failed} failed")
if failed:
    sys.exit(1)
