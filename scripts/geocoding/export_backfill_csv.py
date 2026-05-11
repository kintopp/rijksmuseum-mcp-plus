#!/usr/bin/env python3
"""Step 8: produce ``data/backfills/geocoded-places.csv`` for downstream consumers.

One row per artwork-place mapping — a wide row per depicted place so
consumers don't need to JOIN vocabulary against mappings themselves.

16-column schema (matches v0.24 clean re-geocode plan):

  art_id, vocab_id, label_en, label_nl, lat, lon,
  coord_method, coord_method_detail,
  external_id_authority, external_id, external_id_method,
  broader_id, broader_method,
  placetype, placetype_source, is_areal

The three columns an LLM needs to answer *"did Rijksmuseum supply this,
did we infer it, or is it manual?"* are ``coord_method``,
``placetype_source``, and ``external_id_method``. Together they make
the provenance fully LLM-readable without log archaeology.
"""
from __future__ import annotations

import argparse
import csv
import sqlite3
import sys
from pathlib import Path

COLUMNS = [
    "art_id", "vocab_id", "label_en", "label_nl", "lat", "lon",
    "coord_method", "coord_method_detail",
    "external_id_authority", "external_id", "external_id_method",
    "broader_id", "broader_method",
    "placetype", "placetype_source", "is_areal",
]


def run(db_path: Path, out_path: Path) -> int:
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row

    # Which columns actually exist? New DBs from v0.24+ have all the
    # provenance columns; older fixtures may not. Fall back gracefully
    # by writing NULL for any missing column.
    vocab_cols = {r[1] for r in conn.execute(
        "PRAGMA table_info(vocabulary)"
    ).fetchall()}

    # Helper SELECT expressions — use NULL for columns the DB doesn't have.
    def col_or_null(name: str, alias: str | None = None) -> str:
        expr = f"v.{name}" if name in vocab_cols else "NULL"
        return f"{expr} AS {alias or name}"

    # Place-field rows from mappings: object_number → vocab_id, where
    # vocab corresponds to a 'place' type and carries a depicted place
    # role. We include *all* mappings from places whose field label
    # starts with 'depicted' or is 'production_place', to keep the CSV
    # focused on geographic attributes an LLM would care about.
    field_filter_sql = (
        "(fl.name LIKE 'depicted_%' OR fl.name = 'production_place' "
        " OR fl.name LIKE 'place_%')"
    )

    sql = f"""
        SELECT
          a.art_id                            AS art_id,
          v.id                                AS vocab_id,
          v.label_en                          AS label_en,
          v.label_nl                          AS label_nl,
          v.lat                               AS lat,
          v.lon                               AS lon,
          v.coord_method                      AS coord_method,
          {col_or_null('coord_method_detail')},
          vei.authority                       AS external_id_authority,
          v.external_id                       AS external_id,
          {col_or_null('external_id_method')},
          v.broader_id                        AS broader_id,
          {col_or_null('broader_method')},
          {col_or_null('placetype')},
          {col_or_null('placetype_source')},
          {col_or_null('is_areal')}
        FROM artworks a
        JOIN mappings m       ON m.artwork_id  = a.art_id
        JOIN field_lookup fl  ON fl.id         = m.field_id
        JOIN vocabulary v     ON v.vocab_int_id = m.vocab_rowid
        LEFT JOIN vocabulary_external_ids vei ON vei.vocab_id = v.id
        WHERE v.type = 'place'
          AND {field_filter_sql}
        ORDER BY a.art_id, v.id
    """

    out_path.parent.mkdir(parents=True, exist_ok=True)
    n_rows = 0
    n_unique_places = set()
    with out_path.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=COLUMNS, extrasaction="ignore")
        w.writeheader()
        for row in conn.execute(sql):
            d = dict(row)
            w.writerow(d)
            n_rows += 1
            n_unique_places.add(d.get("vocab_id"))

    conn.close()
    print(f"[backfill] {n_rows} artwork-place rows, "
          f"{len(n_unique_places)} unique places → {out_path}",
          file=sys.stderr)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--db", type=Path, default=Path("data/vocabulary.db"))
    ap.add_argument("--out", type=Path,
                    default=Path("data/backfills/geocoded-places.csv"))
    args = ap.parse_args()
    if not args.db.exists():
        print(f"DB not found: {args.db}", file=sys.stderr)
        return 1
    return run(args.db, args.out)


if __name__ == "__main__":
    sys.exit(main())
