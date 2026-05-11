"""Partition data/tgn-rdf-discrepancies.csv into three buckets by what
Rijksmuseum's 2025 places dump publishes for each place:

  rijks_tgn_authoritative      — Rijks publishes a TGN equivalent that
                                 matches the CSV's tgn_id. CSV's tgn_lat/tgn_lon
                                 are the Rijks-authoritative coords (TGN-RDF
                                 fetched them from the Rijks-supplied TGN
                                 entity). Backfill-ready under the strict
                                 'Rijks-supplied IDs only' policy.

  rijks_wikidata_authoritative — Rijks publishes a Wikidata equivalent but
                                 either no TGN, or a TGN that doesn't match
                                 the CSV's reconciled one. The CSV's
                                 tgn_lat/tgn_lon are NOT usable as
                                 authoritative — they belong to the
                                 reconciled (non-Rijks) TGN. A follow-up
                                 Wikidata P625 lookup is needed before
                                 backfill.

  pending_manual_review        — Rijks publishes neither TGN nor Wikidata
                                 (or place not in dump). Cannot be
                                 backfilled under any authority-only
                                 policy without curator review.

Rows already overridden via data/backfills/curated-place-overrides.csv are excluded
entirely — they're locked as MANUAL and shouldn't be re-evaluated.

Outputs:
  data/tgn-rdf-discrepancies-classified.csv  (master, all rows + new columns)
  data/tgn-rdf-rijks-tgn-authoritative.csv   (bucket 1)
  data/tgn-rdf-rijks-wikidata-authoritative.csv (bucket 2)
  data/tgn-rdf-pending-manual-review.csv     (bucket 3)
"""
import csv
import re
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent
DUMP_DIR = Path.home() / "Downloads" / "rijksmuseum-data-dumps" / "place_extracted"
DATA_DIR = PROJECT_DIR / "data"

INPUT_CSV = DATA_DIR / "tgn-rdf-discrepancies.csv"
OVERRIDES_CSV = DATA_DIR / "backfills" / "curated-place-overrides.csv"

OUT_MASTER = DATA_DIR / "tgn-rdf-discrepancies-classified.csv"
OUT_TGN = DATA_DIR / "tgn-rdf-rijks-tgn-authoritative.csv"
OUT_WIKIDATA = DATA_DIR / "tgn-rdf-rijks-wikidata-authoritative.csv"
OUT_REVIEW = DATA_DIR / "tgn-rdf-pending-manual-review.csv"

STATUS_TGN = "rijks_tgn_authoritative"
STATUS_WIKIDATA = "rijks_wikidata_authoritative"
STATUS_REVIEW = "pending_manual_review"


def make_subject_uri_re(place_id: str) -> re.Pattern:
    return re.compile(
        rf"<https://id\.rijksmuseum\.nl/{re.escape(place_id)}>\s+"
        rf"<http[^>]+>\s+"
        rf"<(http[^>]+)>"
    )


def rijks_external_uris(vocab_id: str) -> list[str]:
    """All external URIs Rijks publishes with the place as subject."""
    fpath = DUMP_DIR / vocab_id
    if not fpath.exists():
        return []
    text = fpath.read_text()
    rx = make_subject_uri_re(vocab_id)
    return [m.group(1) for m in rx.finditer(text)]


def load_overrides() -> set[str]:
    if not OVERRIDES_CSV.exists():
        return set()
    with OVERRIDES_CSV.open(newline="") as f:
        return {r["vocab_id"] for r in csv.DictReader(f)}


def main() -> int:
    excluded = load_overrides()
    print(f"Excluding {len(excluded)} vocab_id(s) already in {OVERRIDES_CSV.name}: "
          f"{sorted(excluded)}")

    with INPUT_CSV.open(newline="") as f:
        reader = csv.DictReader(f)
        in_fields = list(reader.fieldnames or [])
        rows = list(reader)
    print(f"Read {len(rows)} rows from {INPUT_CSV.name}")

    # Dedup on vocab_id (the source CSV has identical duplicates for some).
    seen: set[str] = set()
    deduped = []
    for r in rows:
        if r["vocab_id"] in seen:
            continue
        seen.add(r["vocab_id"])
        deduped.append(r)
    print(f"After dedup: {len(deduped)} unique vocab_ids")

    out_fields = in_fields + [
        "rijks_authority_status",
        "rijks_tgn_uri",
        "rijks_wikidata_uri",
    ]

    classified: list[dict] = []
    for r in deduped:
        vid = r["vocab_id"]
        if vid in excluded:
            continue
        external = rijks_external_uris(vid)
        tgn_uris = [u for u in external if "vocab.getty.edu/tgn/" in u]
        wd_uris = [u for u in external if "wikidata.org/entity/" in u]

        rijks_tgn_match = next(
            (u for u in tgn_uris
             if u.rstrip("/").rsplit("/", 1)[-1] == r["tgn_id"]),
            None,
        )

        if rijks_tgn_match:
            status = STATUS_TGN
            tgn_uri_field = rijks_tgn_match
            wd_uri_field = wd_uris[0] if wd_uris else ""
        elif wd_uris:
            status = STATUS_WIKIDATA
            tgn_uri_field = ""
            wd_uri_field = wd_uris[0]
        else:
            status = STATUS_REVIEW
            tgn_uri_field = ""
            wd_uri_field = ""

        out = dict(r)
        out["rijks_authority_status"] = status
        out["rijks_tgn_uri"] = tgn_uri_field
        out["rijks_wikidata_uri"] = wd_uri_field
        classified.append(out)

    # Write master + 3 splits.
    def write(path: Path, rows: list[dict]) -> None:
        with path.open("w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=out_fields, quoting=csv.QUOTE_MINIMAL)
            w.writeheader()
            w.writerows(rows)
        print(f"  wrote {path.name}  ({len(rows)} rows)")

    print()
    print("Writing outputs:")
    write(OUT_MASTER, classified)
    write(OUT_TGN,      [r for r in classified if r["rijks_authority_status"] == STATUS_TGN])
    write(OUT_WIKIDATA, [r for r in classified if r["rijks_authority_status"] == STATUS_WIKIDATA])
    write(OUT_REVIEW,   [r for r in classified if r["rijks_authority_status"] == STATUS_REVIEW])

    print()
    print("=== Summary ===")
    counts = {STATUS_TGN: 0, STATUS_WIKIDATA: 0, STATUS_REVIEW: 0}
    for r in classified:
        counts[r["rijks_authority_status"]] += 1
    total = len(classified)
    for status, n in counts.items():
        pct = (n / total * 100) if total else 0
        print(f"  {status:<32}  {n:>5}  ({pct:5.1f}%)")
    print(f"  {'TOTAL':<32}  {total:>5}")
    print(f"  Excluded (already manual):       {len(excluded):>5}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
