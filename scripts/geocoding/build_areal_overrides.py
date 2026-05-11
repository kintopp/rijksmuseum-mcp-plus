#!/usr/bin/env python3
"""Generate ``scripts/areal_overrides.tsv`` from seed + DB sweep.

Part of WI-5 (#254 manual areal overrides — region-scale entities and
oceans that either escape the TGN/Wikidata placetype classification or
sit in the "admin-polygon with meaningless centroid" grey zone).

Seed (hand-transcribed from offline/geo/2026-04-17-trial-findings.md
inventory table, lines 68-71):
  - Continents: Europe, Asia, Africa, South America, Oceania, Southeast
    Asia, Caribbean, Middle East, North and Central America
  - Oceans/seas: Atlantic, Pacific, Indian, Mediterranean, North Sea,
    Zuiderzee, Barents, Caribbean Sea
  - Historical polities: Ottoman Empire, Holy Roman Empire, Austria-
    Hungary, Kingdom of Naples, Dutch East Indies, Netherlands Antilles

DB sweep patterns pick up anything the seed missed:
  - Label suffixes: '% Ocean', '% Oceaan', '% Sea', '%zee' (short labels)
  - Empires: '% Empire', '%Rijk' (Ottomaanse Rijk, Romeinse Rijk, etc.)
  - Kingdoms: 'Kingdom of %', '% Kingdom'
  - Continental Wikidata QIDs: Q48/Q15/Q46/Q18/Q49/Q538 when linked to
    rows that the TGN pass may have missed.

Output format (TSV, committed):
  vocab_id<TAB>label<TAB>category<TAB>reason

Usage:
    python3 scripts/build_areal_overrides.py --db data/vocabulary.db \\
        --out scripts/areal_overrides.tsv
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path

# Hand-curated seed — each entry names a single search pattern that
# should match one or more vocab rows. Match against label_en OR label_nl.
# Category is the "kind" of entity for audit purposes.
SEED_PATTERNS: list[tuple[str, str, str]] = [
    # (display_name, where_clause, category)
    ("Europe",                "label_en = 'Europe' OR label_nl = 'Europa'",                   "continent"),
    ("Asia",                  "label_en = 'Asia' OR label_nl = 'Azië'",                       "continent"),
    ("Africa",                "label_en = 'Africa' OR label_nl = 'Afrika'",                   "continent"),
    ("South America",         "label_en = 'South America' OR label_nl = 'Zuid-Amerika'",      "continent"),
    ("Oceania",               "label_en = 'Oceania' OR label_nl = 'Oceanië'",                 "continent"),
    ("Southeast Asia",        "label_en = 'Southeast Asia' OR label_nl = 'Zuidoost-Azië'",    "continent"),
    ("Caribbean",             "label_en = 'Caribbean' OR label_nl = 'Caraïben'",              "continent"),
    ("Middle East",           "label_en = 'Middle East' OR label_nl = 'Midden-Oosten'",       "continent"),
    ("North and Central America",
     "label_en = 'North and Central America' OR label_nl = 'Noord- en Centraal Amerika'",    "continent"),
    ("Western Europe",        "label_en = 'Western Europe' OR label_nl = 'West-Europa'",      "continent"),
    ("Scandinavia",           "label_en = 'Scandinavia' OR label_nl = 'Scandinavië'",         "continent"),

    # Oceans and major seas
    ("Atlantic Ocean",        "label_en = 'Atlantic Ocean' OR label_nl LIKE '%Atlantische Oceaan%'",  "ocean"),
    ("Pacific Ocean",          "label_en = 'Pacific Ocean' OR label_nl LIKE '%Stille Oceaan%' OR label_nl LIKE '%Grote Oceaan%'",  "ocean"),
    ("Indian Ocean",          "label_en = 'Indian Ocean' OR label_nl LIKE '%Indische Oceaan%'",  "ocean"),
    ("Arctic Ocean",          "label_en = 'Arctic Ocean' OR label_nl LIKE '%Noordelijke IJszee%'", "ocean"),
    ("Mediterranean Sea",     "label_en LIKE '%Mediterranean%' OR label_nl LIKE '%Middellandse%'",  "sea"),
    ("North Sea",             "label_en = 'North Sea' OR label_nl = 'Noordzee'",               "sea"),
    ("Zuiderzee",             "label_nl = 'Zuiderzee' OR label_en = 'Zuiderzee'",              "sea"),
    ("Barents Sea",           "label_en = 'Barents Sea' OR label_nl LIKE '%Barentszzee%'",     "sea"),
    ("Caribbean Sea",         "label_en = 'Caribbean Sea' OR label_nl LIKE '%Caraïbische Zee%'", "sea"),
    ("Baltic Sea",            "label_en = 'Baltic Sea' OR label_nl LIKE '%Oostzee%'",          "sea"),

    # Historical polities
    ("Ottoman Empire",        "label_en LIKE '%Ottoman Empire%' OR label_nl LIKE '%Ottomaanse Rijk%'", "historical_polity"),
    ("Holy Roman Empire",     "label_en LIKE '%Holy Roman Empire%' OR label_nl LIKE '%Heilige Roomse Rijk%'", "historical_polity"),
    ("Austria-Hungary",       "label_en LIKE '%Austria-Hungary%' OR label_en LIKE '%Austro-Hungarian%' OR label_nl LIKE '%Oostenrijk-Hongarije%'", "historical_polity"),
    ("Kingdom of Naples",     "label_en LIKE '%Kingdom of Naples%' OR label_nl LIKE '%Koninkrijk Napels%'", "historical_polity"),
    ("Dutch East Indies",     "label_en LIKE '%Dutch East Indies%' OR label_nl LIKE '%Nederlands-Indië%' OR label_en LIKE '%Netherlands East Indies%'", "historical_polity"),
    ("Netherlands Antilles",  "label_en LIKE '%Netherlands Antilles%' OR label_nl LIKE '%Nederlandse Antillen%'", "historical_polity"),
    ("Roman Empire",          "label_en LIKE '%Roman Empire%' OR label_nl = 'Romeinse Rijk'",  "historical_polity"),
    ("Soviet Union",          "label_en LIKE '%Soviet Union%' OR label_nl LIKE '%Sovjet-Unie%'",  "historical_polity"),
]

# DB sweep patterns (in addition to seed). Each returns zero-or-more rows.
# Patterns are tightened to avoid false positives seen in v0.24 DB:
#   - "aan Zee" / "aan zee" — Dutch coastal villages (Bergen aan Zee etc.)
#   - Dutch cities ending in "rijk" without a space before it (Kortrijk,
#     Oostenrijk, Kamerijk, Hemelrijk) — these are city names, not empires.
#   - Require word-boundary-before "Rijk" via leading space.
SWEEP_PATTERNS: list[tuple[str, str, str]] = [
    ("ocean labels (en)",   "label_en LIKE '% Ocean' AND label_en NOT LIKE '%arm'",                          "ocean"),
    ("ocean labels (nl)",   "label_nl LIKE '%Oceaan%'",                                                       "ocean"),
    ("sea labels (en)",     "label_en LIKE '% Sea' AND LENGTH(label_en) <= 25 "
                            "AND label_en NOT LIKE 'North S%' "
                            "AND label_en NOT LIKE '% by the Sea' "
                            "AND label_en NOT LIKE '% on Sea'",                                                "sea"),
    ("sea labels (nl)",     "label_nl LIKE '% Zee' AND LENGTH(label_nl) < 30 "
                            "AND label_nl NOT LIKE '% aan Zee' "
                            "AND label_nl NOT LIKE '% aan-Zee' "
                            "AND label_nl NOT LIKE '%-aan-Zee'",                                              "sea"),
    ("sea labels ('zee' suffix, nl)",
     "label_nl LIKE '%szee' AND LENGTH(label_nl) < 20",                                                        "sea"),
    ("empire (en)",         "label_en LIKE '% Empire' AND LENGTH(label_en) < 40",                             "historical_polity"),
    ("rijk (nl, word-boundary)",
     "label_nl LIKE '% Rijk' AND LENGTH(label_nl) < 40",                                                      "historical_polity"),
    ("kingdom of (en)",     "label_en LIKE 'Kingdom of %'",                                                    "historical_polity"),
    ("koninkrijk (nl)",     "label_nl LIKE 'Koninkrijk %' AND LENGTH(label_nl) < 50",                         "historical_polity"),
]


def build(db_path: Path, out_path: Path) -> None:
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row

    rows: dict[str, tuple[str, str, str]] = {}  # vocab_id → (label, category, reason)

    # Pass 1: seed patterns
    for display, where, category in SEED_PATTERNS:
        sql = (f"SELECT id, COALESCE(label_en, label_nl) AS label "
               f"FROM vocabulary WHERE type = 'place' AND ({where})")
        for r in conn.execute(sql).fetchall():
            vid = r["id"]
            label = r["label"]
            if vid not in rows:
                rows[vid] = (label, category, f"seed: {display}")

    print(f"[seed] {len(rows)} rows matched from {len(SEED_PATTERNS)} "
          f"seed patterns", file=sys.stderr)

    # Pass 2: DB sweep patterns
    seed_count = len(rows)
    for name, where, category in SWEEP_PATTERNS:
        sql = (f"SELECT id, COALESCE(label_en, label_nl) AS label "
               f"FROM vocabulary WHERE type = 'place' AND ({where})")
        for r in conn.execute(sql).fetchall():
            vid = r["id"]
            label = r["label"]
            if vid not in rows:
                rows[vid] = (label, category, f"sweep: {name}")

    print(f"[sweep] {len(rows) - seed_count} additional rows from "
          f"{len(SWEEP_PATTERNS)} sweep patterns", file=sys.stderr)

    # Write TSV sorted by category then label.
    out_path.parent.mkdir(parents=True, exist_ok=True)
    sorted_rows = sorted(rows.items(), key=lambda kv: (kv[1][1], kv[1][0] or ""))
    with out_path.open("w") as f:
        f.write("# Manual areal overrides for #254 / #256.\n")
        f.write("# Flags vocab rows whose centroid is not meaningful for\n")
        f.write("# point-based runtime queries (oceans, continents,\n")
        f.write("# historical polities, region-scale entities).\n")
        f.write("# Applied by scripts/apply_areal_overrides.py.\n")
        f.write("# Format: vocab_id<TAB>label<TAB>category<TAB>reason\n")
        f.write("# Categories: continent, ocean, sea, historical_polity,\n")
        f.write("#             modern_country, river, mountain_range, other\n")
        f.write("# HUMAN REVIEW: please verify the sweep rows before running\n")
        f.write("# the unattended clean re-geocode run. See build script for\n")
        f.write("# the seed patterns vs sweep patterns distinction.\n")
        for vid, (label, category, reason) in sorted_rows:
            safe_label = (label or "").replace("\t", " ")
            safe_reason = (reason or "").replace("\t", " ")
            f.write(f"{vid}\t{safe_label}\t{category}\t{safe_reason}\n")

    print(f"Wrote {len(sorted_rows)} entries to {out_path}", file=sys.stderr)

    # Category summary
    cat_counts: dict[str, int] = {}
    for _, (_, cat, _) in rows.items():
        cat_counts[cat] = cat_counts.get(cat, 0) + 1
    print("Category counts:", file=sys.stderr)
    for cat in sorted(cat_counts.keys()):
        print(f"  {cat:<22} {cat_counts[cat]:>4}", file=sys.stderr)

    conn.close()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--db", type=Path, default=Path("data/vocabulary.db"))
    ap.add_argument("--out", type=Path,
                    default=Path(__file__).resolve().parent / "areal_overrides.tsv")
    args = ap.parse_args()
    if not args.db.exists():
        print(f"DB not found: {args.db}", file=sys.stderr)
        return 1
    build(args.db, args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
