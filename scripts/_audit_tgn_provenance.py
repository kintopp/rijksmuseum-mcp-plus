#!/usr/bin/env python3
"""One-shot audit: of the 3,578 places in data/tgn-rdf-discrepancies.csv, how
many have a TGN equivalent URI in the Rijksmuseum 2025 places dump?

Answers the conservative-policy question: "could we have sourced this TGN ID
directly from Rijksmuseum metadata, or did the reconciliation pipeline introduce
it?"
"""
import csv
import re
import sys
from collections import Counter
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent
DUMP_DIR = Path.home() / "Downloads" / "rijksmuseum-data-dumps" / "place_extracted"
CSV_PATH = PROJECT_DIR / "data" / "tgn-rdf-discrepancies.csv"

RE_EQUIVALENT = re.compile(
    r"<https://id\.rijksmuseum\.nl/(\d+)>\s+"
    r"<https://linked\.art/ns/terms/equivalent>\s+"
    r"<(http[^>]+)>"
)
RE_SAME_AS = re.compile(
    r"<https://id\.rijksmuseum\.nl/(\d+)>\s+"
    r"<http://schema\.org/sameAs>\s+"
    r"<(http[^>]+)>"
)


def equivalents_for(place_id: str) -> list[str]:
    fpath = DUMP_DIR / place_id
    if not fpath.exists():
        return []
    try:
        text = fpath.read_text()
    except Exception:
        return []
    out = []
    for rx in (RE_EQUIVALENT, RE_SAME_AS):
        for m in rx.finditer(text):
            if m.group(1) == place_id:
                out.append(m.group(2))
    return out


def main() -> int:
    if not CSV_PATH.exists():
        print(f"missing {CSV_PATH}", file=sys.stderr)
        return 1
    if not DUMP_DIR.exists():
        print(f"missing {DUMP_DIR}", file=sys.stderr)
        return 1

    rows = []
    with CSV_PATH.open() as f:
        reader = csv.DictReader(f)
        for r in reader:
            rows.append(r)
    print(f"Loaded {len(rows)} rows from {CSV_PATH.name}")

    in_dump = 0
    not_in_dump = 0
    has_tgn = 0
    has_wikidata_only = 0
    has_other_only = 0
    has_no_external = 0
    tgn_id_matches = 0
    tgn_id_differs = 0
    tgn_only_no_wikidata = 0

    by_method: Counter[str] = Counter()
    by_method_has_tgn: Counter[str] = Counter()
    differing_examples: list[dict] = []

    for r in rows:
        vid = r["vocab_id"]
        method = r["existing_method_detail"] or "(blank)"
        by_method[method] += 1
        eqs = equivalents_for(vid)
        if eqs == [] and not (DUMP_DIR / vid).exists():
            not_in_dump += 1
            continue
        in_dump += 1

        tgn_uris = [u for u in eqs if "vocab.getty.edu/tgn/" in u]
        wd_uris = [u for u in eqs if "wikidata.org/entity/" in u]

        if tgn_uris:
            has_tgn += 1
            by_method_has_tgn[method] += 1
            csv_tgn = r["tgn_id"]
            dump_tgn_ids = {u.rstrip("/").rsplit("/", 1)[-1] for u in tgn_uris}
            if csv_tgn in dump_tgn_ids:
                tgn_id_matches += 1
            else:
                tgn_id_differs += 1
                if len(differing_examples) < 5:
                    differing_examples.append({
                        "vocab_id": vid,
                        "csv_tgn": csv_tgn,
                        "dump_tgn": sorted(dump_tgn_ids),
                        "method": method,
                    })
            if not wd_uris:
                tgn_only_no_wikidata += 1
        elif wd_uris:
            has_wikidata_only += 1
        elif eqs:
            has_other_only += 1
        else:
            has_no_external += 1

    print()
    print("=== Coverage in Rijksmuseum 2025 places dump ===")
    print(f"  in dump:     {in_dump:>5} / {len(rows)}")
    print(f"  not in dump: {not_in_dump:>5}")
    print()
    print("=== Of those in the dump, what equivalents does Rijksmuseum publish? ===")
    print(f"  has TGN equivalent URI:                 {has_tgn:>5}")
    print(f"      └─ TGN ID matches CSV's tgn_id:    {tgn_id_matches:>5}")
    print(f"      └─ TGN ID differs from CSV:        {tgn_id_differs:>5}")
    print(f"      └─ TGN only (no Wikidata):         {tgn_only_no_wikidata:>5}")
    print(f"  has Wikidata only (no TGN):             {has_wikidata_only:>5}")
    print(f"  has other external only (no TGN/WD):    {has_other_only:>5}")
    print(f"  no external equivalent at all:          {has_no_external:>5}")
    print()
    print("=== If we adopted the conservative policy (TGN must be in Rijks dump) ===")
    print(f"  rows that would survive:    {tgn_id_matches:>5}")
    rejected = len(rows) - tgn_id_matches
    print(f"  rows that would be dropped: {rejected:>5} "
          f"({rejected / len(rows) * 100:.1f}%)")
    print()

    if differing_examples:
        print("=== Examples where Rijksmuseum's TGN ID differs from the CSV's ===")
        for ex in differing_examples:
            print(f"  vocab_id={ex['vocab_id']}  csv_tgn={ex['csv_tgn']}  "
                  f"dump_tgn={ex['dump_tgn']}  via={ex['method']}")
        print()

    print("=== Top methods that would lose rows under the conservative policy ===")
    rows_by_method = Counter()
    surviving_by_method = Counter()
    for r in rows:
        m = r["existing_method_detail"] or "(blank)"
        rows_by_method[m] += 1
    # surviving = rows whose dump-published TGN matches the CSV's tgn_id
    survivors_set: set[str] = set()
    for r in rows:
        vid = r["vocab_id"]
        csv_tgn = r["tgn_id"]
        eqs = equivalents_for(vid)
        dump_tgn_ids = {u.rstrip("/").rsplit("/", 1)[-1]
                        for u in eqs if "vocab.getty.edu/tgn/" in u}
        if csv_tgn in dump_tgn_ids:
            survivors_set.add(vid)
            surviving_by_method[r["existing_method_detail"] or "(blank)"] += 1

    print(f"  {'method':<55} {'total':>7} {'survives':>9} {'drops':>7}")
    for method, total in rows_by_method.most_common():
        surv = surviving_by_method.get(method, 0)
        print(f"  {method:<55} {total:>7} {surv:>9} {total - surv:>7}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
