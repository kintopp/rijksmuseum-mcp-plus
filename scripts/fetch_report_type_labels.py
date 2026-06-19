"""Fetch report-type concept labels → data/backfills/report-types.csv (#278).

Each examinations row carries a Rijksmuseum report-type concept URI
(report_type_id) but report_type_en was NULL for 100% of rows: the harvest
extractor read the wrong key (labels live in the inline notation[], or in the
dereferenced concept's identified_by[]). Only a small set of distinct concept
URIs cover all rows, and each dereferences cleanly to en/nl labels.

This builds the curated lookup that apply_examination_report_types.py uses to
populate report_type_en in place — needed because the parser fix only takes
effect on a full re-harvest, which may never run again (pivot to LDES/OAI).

Reproducible: reads the distinct URIs straight from the DB, dereferences each
once with Accept: application/ld+json, and prefers the English label (Getty AAT
language 300388277) then Dutch (300388256), matching the concept's own tagging.

Usage:
    python3 scripts/fetch_report_type_labels.py
    python3 scripts/fetch_report_type_labels.py --db data/vocabulary.db --out data/backfills/report-types.csv
"""
import argparse
import csv
import datetime
import json
import sqlite3
import sys
import urllib.request
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent
DB_PATH = PROJECT_DIR / "data" / "vocabulary.db"
OUT_PATH = PROJECT_DIR / "data" / "backfills" / "report-types.csv"

AAT_EN = "http://vocab.getty.edu/aat/300388277"  # English
AAT_NL = "http://vocab.getty.edu/aat/300388256"  # Dutch
FIELDS = ("report_type_id", "label_en", "label_nl", "source_url", "fetched_at")


def parse_args():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--db", type=Path, default=DB_PATH)
    p.add_argument("--out", type=Path, default=OUT_PATH)
    p.add_argument("--fetched-at", default=datetime.date.today().isoformat(),
                   help="provenance date stamp (default: today)")
    return p.parse_args()


def label_for(names, want_id, want_label):
    """Pick the Name whose language matches the wanted AAT id (or _label)."""
    for n in names:
        if not isinstance(n, dict):
            continue
        for lang in n.get("language", []):
            if isinstance(lang, dict) and (
                lang.get("id") == want_id or lang.get("_label") == want_label
            ):
                return n.get("content")
    return None


def fetch(uri):
    req = urllib.request.Request(uri, headers={"Accept": "application/ld+json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def main() -> int:
    args = parse_args()
    if not args.db.exists():
        sys.exit(f"missing {args.db}")

    conn = sqlite3.connect(str(args.db))
    uris = [row[0] for row in conn.execute(
        "SELECT DISTINCT report_type_id FROM examinations "
        "WHERE report_type_id IS NOT NULL AND report_type_id != '' "
        "ORDER BY report_type_id")]
    conn.close()
    print(f"{len(uris)} distinct report-type URI(s) in {args.db.name}\n")

    rows, missing = [], []
    for uri in uris:
        try:
            doc = fetch(uri)
        except Exception as e:  # noqa: BLE001 — surface and skip, keep going
            print(f"  ERROR {uri}: {e}", file=sys.stderr)
            missing.append(uri)
            continue
        names = doc.get("identified_by", [])
        en = label_for(names, AAT_EN, "English")
        nl = label_for(names, AAT_NL, "Dutch")
        if not en and not nl:
            print(f"  WARN  {uri}: no en/nl label found", file=sys.stderr)
            missing.append(uri)
        rows.append({
            "report_type_id": uri,
            "label_en": en or "",
            "label_nl": nl or "",
            "source_url": uri,
            "fetched_at": args.fetched_at,
        })
        print(f"  {uri}  en={en!r}  nl={nl!r}")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(rows)

    print(f"\nWrote {len(rows)} row(s) to {args.out}")
    if missing:
        print(f"  {len(missing)} URI(s) had no usable label — review before "
              "applying", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
