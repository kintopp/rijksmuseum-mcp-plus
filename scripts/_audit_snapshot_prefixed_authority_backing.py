"""For every place currently labelled coord_method='inferred' with a
'v0.25-snapshot-backfill:*' prefixed detail whose underlying base name is
AUTHORITY-tier, check whether the relevant authority ID is actually
present in vocabulary_external_ids.

Answers: 'Are these 2,064 rows truly authority-backed (and thus mis-tagged
as inferred), or did the snapshot prefix mask a missing authority that
makes 'inferred' the honest label?'

Reports per detail bucket:
  - rows where the expected authority IS present in VEI  (truly authority-backed)
  - rows where the expected authority is MISSING from VEI (label cannot be deterministic
    under the strict policy; current 'inferred' tag is in fact correct)
"""
import sqlite3
import sys
from collections import defaultdict
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent
DB = PROJECT_DIR / "data" / "vocabulary.db"

# Map each prefixed-snapshot detail to the VEI authority that should back it.
# These are the 9 detail values whose base name is AUTHORITY-tier.
DETAIL_TO_AUTHORITY = {
    "v0.25-snapshot-backfill:wikidata_p131":         "wikidata",
    "v0.25-snapshot-backfill:wikidata_p276":         "wikidata",
    "v0.25-snapshot-backfill:wikidata_p159":         "wikidata",
    "v0.25-snapshot-backfill:wof_authority":         "wof",
    "v0.25-snapshot-backfill:tgn_via_replacement":   "tgn",
    "v0.25-snapshot-backfill:tgn_via_wikidata_p1667": "wikidata",  # crosswalk via wd's P1667
    "v0.25-snapshot-backfill:rijksmuseum_lod":       "rijks_internal",
    "v0.25-snapshot-backfill:geonames_api":          "geonames",
    "v0.25-snapshot-backfill:rce_via_wikidata":      "wikidata",
}


def main() -> int:
    conn = sqlite3.connect(str(DB))

    print(f"{'detail':<55}  {'auth':<14}  {'rows':>5}  {'with':>5}  {'missing':>7}  {'%backed':>7}")
    grand_total = 0
    grand_backed = 0
    grand_missing = 0
    missing_examples: dict[str, list[tuple[str, str]]] = defaultdict(list)

    for detail, expected_auth in DETAIL_TO_AUTHORITY.items():
        # All vocab_ids carrying this detail.
        rows = conn.execute(
            "SELECT id, label_en, label_nl FROM vocabulary "
            "WHERE type='place' AND coord_method='inferred' "
            "AND coord_method_detail = ?",
            (detail,),
        ).fetchall()
        n_total = len(rows)
        if not n_total:
            continue
        n_backed = 0
        for vid, en, nl in rows:
            r = conn.execute(
                "SELECT 1 FROM vocabulary_external_ids "
                "WHERE vocab_id = ? AND authority = ? LIMIT 1",
                (vid, expected_auth),
            ).fetchone()
            if r:
                n_backed += 1
            elif len(missing_examples[detail]) < 3:
                missing_examples[detail].append((vid, en or nl or "∅"))
        n_missing = n_total - n_backed
        pct = (n_backed / n_total * 100) if n_total else 0
        print(f"{detail:<55}  {expected_auth:<14}  "
              f"{n_total:>5}  {n_backed:>5}  {n_missing:>7}  {pct:>6.1f}%")
        grand_total += n_total
        grand_backed += n_backed
        grand_missing += n_missing

    print()
    print(f"{'TOTAL':<55}  {'':<14}  "
          f"{grand_total:>5}  {grand_backed:>5}  {grand_missing:>7}  "
          f"{(grand_backed/grand_total*100 if grand_total else 0):>6.1f}%")

    if grand_missing:
        print()
        print("=== Examples of rows with NO matching authority in VEI ===")
        for detail, examples in missing_examples.items():
            if examples:
                print(f"  {detail}:")
                for vid, label in examples:
                    print(f"      {vid}  ({label})")
    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
