"""For every place in data/tgn-rdf-discrepancies.csv, scan its Rijksmuseum
2025 places dump file and tally what external authority URIs Rijks publishes.

Specifically answers: for the 417 places I previously labeled "has Wikidata
only (no TGN)", does Rijks publish ANY non-Wikidata authority IDs alongside —
GeoNames, VIAF, ULAN, etc.?

Looks at every URI value (not just sameAs/equivalent) and classifies by
authority host, scoped to triples with the place itself as subject.
"""
import csv
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent
DUMP_DIR = Path.home() / "Downloads" / "rijksmuseum-data-dumps" / "place_extracted"
CSV_PATH = PROJECT_DIR / "data" / "tgn-rdf-discrepancies.csv"

# Match any triple where the SUBJECT is the place's id.rijksmuseum.nl URI.
# We capture predicate + object (URI) so we can both classify and report.
def make_subject_uri_re(place_id: str) -> re.Pattern:
    return re.compile(
        rf"<https://id\.rijksmuseum\.nl/{re.escape(place_id)}>\s+"
        rf"<(http[^>]+)>\s+"
        rf"<(http[^>]+)>"
    )


AUTHORITY_HOSTS = (
    ("wikidata.org/entity/",   "wikidata"),
    ("vocab.getty.edu/tgn/",   "tgn"),
    ("vocab.getty.edu/ulan/",  "ulan"),
    ("vocab.getty.edu/aat/",   "aat"),
    ("geonames.org/",          "geonames"),
    ("viaf.org/",              "viaf"),
    ("rkd.nl",                 "rkd"),
    ("iconclass.org/",         "iconclass"),
    ("pleiades.stoa.org",      "pleiades"),
    ("whosonfirst.org",        "wof"),
    ("loc.gov",                "loc"),
)

# Predicates we treat as "external concordance" rather than internal hierarchy
# or typing. Conservative: only count predicates that semantically link to
# an external authority record for the place.
CONCORDANCE_PREDICATES = {
    "https://linked.art/ns/terms/equivalent",
    "http://schema.org/sameAs",
    "http://www.w3.org/2002/07/owl#sameAs",
    "http://xmlns.com/foaf/0.1/isPrimaryTopicOf",
    "http://www.cidoc-crm.org/cidoc-crm/P1_is_identified_by",  # rarely external
    "http://www.cidoc-crm.org/cidoc-crm/P67i_is_referred_to_by",
}


def authority_for(uri: str) -> str | None:
    for needle, name in AUTHORITY_HOSTS:
        if needle in uri:
            return name
    return None


def main() -> int:
    with CSV_PATH.open() as f:
        rows = list(csv.DictReader(f))
    seen_vids: set[str] = set()
    unique_rows = []
    for r in rows:
        if r["vocab_id"] not in seen_vids:
            seen_vids.add(r["vocab_id"])
            unique_rows.append(r)
    print(f"Distinct vocab_ids in discrepancies CSV: {len(unique_rows)}")

    # Pass 1: classify the universe by what we find in the Rijks dump.
    bucket_counts: Counter[str] = Counter()
    by_authority_combo: Counter[tuple[str, ...]] = Counter()

    # Pass 2: for those with NO TGN in the dump, capture the full per-place
    # authority breakdown so we can answer "do they ALSO have GeoNames/VIAF/etc?"
    no_tgn_authority_combos: Counter[tuple[str, ...]] = Counter()
    no_tgn_examples: dict[tuple[str, ...], list[str]] = defaultdict(list)

    # Pass 3: count predicates used for external-authority objects, so we can
    # confirm whether `equivalent` is the only carrier.
    predicate_per_authority: dict[str, Counter] = defaultdict(Counter)

    for r in unique_rows:
        vid = r["vocab_id"]
        fpath = DUMP_DIR / vid
        if not fpath.exists():
            bucket_counts["__not_in_dump"] += 1
            continue
        text = fpath.read_text()
        # All triples where the subject is THIS place's URI and object is a URI.
        rx = make_subject_uri_re(vid)
        per_authority: set[str] = set()
        for m in rx.finditer(text):
            pred, obj = m.group(1), m.group(2)
            auth = authority_for(obj)
            if auth and auth != "aat":  # aat is for placetype, not place identity
                per_authority.add(auth)
                predicate_per_authority[auth][pred] += 1
        combo = tuple(sorted(per_authority))
        by_authority_combo[combo] += 1
        if "tgn" not in per_authority:
            no_tgn_authority_combos[combo] += 1
            if len(no_tgn_examples[combo]) < 3:
                no_tgn_examples[combo].append(vid)

    print()
    print("=== Authority combos in Rijks dump (per place, dedup) ===")
    for combo, n in sorted(by_authority_combo.items(), key=lambda kv: -kv[1]):
        label = ", ".join(combo) if combo else "(none)"
        print(f"  {n:>5}  {{ {label} }}")

    print()
    print("=== Predicates used for each authority's URIs ===")
    for auth in sorted(predicate_per_authority):
        print(f"  authority={auth}")
        for pred, n in predicate_per_authority[auth].most_common():
            print(f"      {n:>5}  <{pred}>")

    print()
    print("=== Of the places with NO TGN in dump: what other authorities does Rijks publish? ===")
    no_tgn_total = sum(no_tgn_authority_combos.values())
    print(f"  Total places with no TGN equivalent in dump: {no_tgn_total}")
    for combo, n in sorted(no_tgn_authority_combos.items(), key=lambda kv: -kv[1]):
        label = ", ".join(combo) if combo else "(no external authorities at all)"
        ex = ", ".join(no_tgn_examples[combo])
        print(f"  {n:>5}  {{ {label} }}   examples: {ex}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
