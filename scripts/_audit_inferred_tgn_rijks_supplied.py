"""For the 2,826 places currently in coord_method='inferred' with a
'whg_reconciliation' or 'wikidata_reconciliation' detail that ALSO have a
TGN authority in vocabulary_external_ids: verify whether each place's TGN
ID is actually Rijks-supplied (present in the Rijksmuseum 2025 places
dump's equivalent/sameAs predicates) or was added later by a
reconciliation pipeline.

The strict-policy distinction matters: only Rijks-supplied TGN IDs are
eligible for AUTHORITY-tier promotion under the conservative policy.
Reconciliation-introduced TGN IDs (e.g. via WHG bridging) are not.

Reports per detail bucket:
  - rows where AT LEAST ONE of the place's TGN IDs is in the Rijks dump
  - rows where NONE of the place's TGN IDs are in the Rijks dump
  - rows where the place isn't in the Rijks dump at all (cannot verify)
"""
import re
import sqlite3
import sys
from collections import Counter
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent
DUMP_DIR = Path.home() / "Downloads" / "rijksmuseum-data-dumps" / "place_extracted"
DB = PROJECT_DIR / "data" / "vocabulary.db"

ELIGIBLE_DETAILS = (
    "v0.25-snapshot-backfill:whg_reconciliation",
    "v0.25-snapshot-backfill:wikidata_reconciliation",
)


def make_subject_uri_re(place_id: str) -> re.Pattern:
    return re.compile(
        rf"<https://id\.rijksmuseum\.nl/{re.escape(place_id)}>\s+"
        rf"<http[^>]+>\s+"
        rf"<(http[^>]+)>"
    )


def rijks_published_tgn_ids(vocab_id: str) -> tuple[set[str], bool]:
    """Returns (set_of_tgn_ids_in_dump, dump_file_exists)."""
    fpath = DUMP_DIR / vocab_id
    if not fpath.exists():
        return set(), False
    text = fpath.read_text()
    rx = make_subject_uri_re(vocab_id)
    out: set[str] = set()
    for m in rx.finditer(text):
        obj = m.group(1)
        if "vocab.getty.edu/tgn/" in obj:
            tgn_local = obj.rstrip("/").rsplit("/", 1)[-1]
            out.add(tgn_local)
    return out, True


def main() -> int:
    conn = sqlite3.connect(str(DB))
    placeholders = ",".join("?" * len(ELIGIBLE_DETAILS))

    # All eligible vocab_ids with their VEI-recorded TGN IDs.
    rows = conn.execute(
        f"""
        SELECT v.id,
               COALESCE(v.label_en, v.label_nl, '∅') AS label,
               v.coord_method_detail AS detail,
               vei.id AS tgn_id
        FROM vocabulary v
        JOIN vocabulary_external_ids vei
          ON vei.vocab_id = v.id AND vei.authority = 'tgn'
        WHERE v.type = 'place'
          AND v.coord_method = 'inferred'
          AND v.coord_method_detail IN ({placeholders})
        ORDER BY v.id
        """,
        ELIGIBLE_DETAILS,
    ).fetchall()
    conn.close()

    # Group VEI rows by vocab_id (a place can have multiple TGN entries).
    per_place: dict[str, dict] = {}
    for vid, label, detail, tgn in rows:
        e = per_place.setdefault(vid, {"label": label, "detail": detail,
                                       "vei_tgns": set()})
        e["vei_tgns"].add(tgn)

    print(f"Eligible places (inferred + reconciliation detail + TGN in VEI): "
          f"{len(per_place)}\n")

    # Bucket each place by Rijks-publication status.
    bucket_counts: dict[str, Counter] = {d: Counter() for d in ELIGIBLE_DETAILS}
    examples: dict[tuple[str, str], list[str]] = {}
    for vid, info in per_place.items():
        rijks_tgns, dump_exists = rijks_published_tgn_ids(vid)
        if not dump_exists:
            bucket = "not_in_dump"
        elif info["vei_tgns"] & rijks_tgns:
            bucket = "rijks_supplied"
        else:
            bucket = "reconciliation_only"
        bucket_counts[info["detail"]][bucket] += 1
        key = (info["detail"], bucket)
        examples.setdefault(key, [])
        if len(examples[key]) < 3:
            extra = ""
            if bucket == "reconciliation_only":
                extra = (f"  (vei_tgns={sorted(info['vei_tgns'])}, "
                         f"rijks_tgns={sorted(rijks_tgns)})")
            examples[key].append(f"{vid} ({info['label']}){extra}")

    print(f"{'detail':<55}  {'rijks_supplied':>14}  "
          f"{'reconciliation_only':>20}  {'not_in_dump':>11}")
    for detail in ELIGIBLE_DETAILS:
        c = bucket_counts[detail]
        total = sum(c.values())
        print(f"{detail:<55}  "
              f"{c.get('rijks_supplied', 0):>14}  "
              f"{c.get('reconciliation_only', 0):>20}  "
              f"{c.get('not_in_dump', 0):>11}   (total={total})")

    grand = Counter()
    for c in bucket_counts.values():
        grand.update(c)
    print(f"\nGRAND TOTAL: {dict(grand)}")
    print(f"  STRICT-POLICY ELIGIBLE  (has Rijks-supplied TGN): "
          f"{grand['rijks_supplied']}")
    print(f"  NOT eligible (TGN was added by reconciliation):  "
          f"{grand['reconciliation_only']}")
    print(f"  Cannot verify (vocab not in dump):                "
          f"{grand['not_in_dump']}")

    print("\n=== Examples per bucket ===")
    for detail in ELIGIBLE_DETAILS:
        for bucket in ("rijks_supplied", "reconciliation_only", "not_in_dump"):
            ex = examples.get((detail, bucket), [])
            if not ex:
                continue
            print(f"\n  {detail}  /  {bucket}:")
            for line in ex:
                print(f"      {line}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
