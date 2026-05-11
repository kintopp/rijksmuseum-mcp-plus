"""Phase 4 PIP validation — read-only WOF point-in-polygon audit.

Audits coords in ``vocabulary`` against Who's On First admin polygons via
DuckDB's spatial extension. Produces ``disagreements.csv`` for places whose
coords fall outside our 11-country WOF coverage (potential geocoding errors)
and ``summary.txt`` with bucket counts.

Stage A of the v0.25 geocoding bundle uses this as a baseline; Stages C and E
re-run it to confirm coverage doesn't regress and disagreement count drops.

The DB is opened read-only — this script never writes to ``vocabulary.db``.

CLI:
    python3 scripts/phase4_pip_validation.py \
      --db data/vocabulary.db \
      --wof-parquet 'data/seed/wof/whosonfirst-data-admin-*.parquet' \
      --output-dir data/audit/phase4-validation/2026-04-28-baseline-v024/
"""
from __future__ import annotations

import argparse
import csv
import glob as glob_module
import re
import sqlite3
import sys
from collections import Counter
from pathlib import Path
from typing import Callable, Optional

import duckdb


# Inferred from WOF parquet filenames: whosonfirst-data-admin-<iso2>-latest.parquet
WOF_COVERAGE_ISO2 = {"nl", "de", "at", "fr", "be", "it", "gb", "us", "id", "jp", "cn"}

BUCKET_AGREE = "agree"
BUCKET_MILD = "mildly_disagree"
BUCKET_WRONG = "definitely_wrong"
BUCKET_NO_COVERAGE = "unknown_no_coverage"


def run_pip_validation(
    conn: sqlite3.Connection,
    wof_parquet_glob: str,
    output_dir: Path,
    expected_country_lookup: Optional[Callable[[int], Optional[str]]] = None,
) -> dict[str, int]:
    """Run PIP audit; write CSV + summary; return bucket counts.

    ``expected_country_lookup`` maps vocab_id → ISO2 (lowercase). ``None`` for
    rows where no expectation is known. Pass ``None`` (the default) to skip
    expected-vs-actual bucketing entirely.
    """
    output_dir.mkdir(parents=True, exist_ok=True)

    places = conn.execute(
        """
        SELECT id, label_en, label_nl, lat, lon, coord_method, coord_method_detail
          FROM vocabulary
         WHERE type = 'place'
           AND lat IS NOT NULL AND lon IS NOT NULL
        """
    ).fetchall()

    parquet_paths = sorted(glob_module.glob(wof_parquet_glob))
    if not parquet_paths:
        raise SystemExit(f"No WOF parquets matched: {wof_parquet_glob}")

    iso2_re = re.compile(r"admin-([a-z]{2})-")
    placetype_priority_sql = (
        "CASE w.placetype "
        "WHEN 'microhood' THEN 1 "
        "WHEN 'neighbourhood' THEN 2 "
        "WHEN 'macrohood' THEN 3 "
        "WHEN 'borough' THEN 4 "
        "WHEN 'locality' THEN 5 "
        "WHEN 'localadmin' THEN 6 "
        "WHEN 'county' THEN 7 "
        "WHEN 'region' THEN 8 "
        "WHEN 'country' THEN 9 "
        "ELSE 99 END"
    )

    # Process one parquet at a time to stay in memory budget. Each pass:
    #   1) Read country bbox.
    #   2) Filter places to that bbox.
    #   3) Spatial join only the bbox subset.
    #   4) Keep finest hit per vocab_id across passes.
    hits_by_vocab: dict[int, tuple] = {}

    placetype_rank = {
        "microhood": 1, "neighbourhood": 2, "macrohood": 3, "borough": 4,
        "locality": 5, "localadmin": 6, "county": 7, "region": 8, "country": 9,
    }

    duck = duckdb.connect()
    duck.execute("SET memory_limit='8GB'")
    duck.execute("SET threads=1")
    duck.execute("SET preserve_insertion_order=false")
    duck.execute("INSTALL spatial; LOAD spatial")
    try:
        for pq_path in parquet_paths:
            m = iso2_re.search(Path(pq_path).name)
            wof_iso2 = m.group(1) if m else "?"

            bbox = duck.execute(
                f"SELECT MIN(lat), MAX(lat), MIN(lon), MAX(lon) "
                f"FROM read_parquet('{pq_path}') WHERE geometry IS NOT NULL"
            ).fetchone()
            if not bbox or bbox[0] is None:
                continue
            min_lat, max_lat, min_lon, max_lon = bbox

            bbox_places = [
                r for r in places
                if (r[3] is not None and r[4] is not None
                    and min_lat <= float(r[3]) <= max_lat
                    and min_lon <= float(r[4]) <= max_lon)
            ]
            if not bbox_places:
                continue

            duck.execute("DROP TABLE IF EXISTS places")
            duck.execute(
                "CREATE TABLE places (vocab_id INT, lat DOUBLE, lon DOUBLE)"
            )
            duck.executemany(
                "INSERT INTO places VALUES (?, ?, ?)",
                [(int(r[0]), float(r[3]), float(r[4])) for r in bbox_places],
            )

            # Two-stage filter to avoid OOM on large-country parquets:
            #   1) bbox prefilter using parquet's `geometry_bbox` STRUCT — cheap.
            #   2) ST_Contains only on bbox-overlap candidates.
            result = duck.execute(
                f"""
                WITH candidates AS (
                    SELECT p.vocab_id, p.lat, p.lon, w.id AS wof_id,
                           w.name AS wof_name, w.placetype
                      FROM places p
                      JOIN read_parquet('{pq_path}') w
                        ON w.placetype IN ('country','region','county','locality',
                                           'localadmin','borough','dependency')
                       AND w.geometry_bbox.xmin <= p.lon
                       AND p.lon <= w.geometry_bbox.xmax
                       AND w.geometry_bbox.ymin <= p.lat
                       AND p.lat <= w.geometry_bbox.ymax
                ),
                verified AS (
                    SELECT c.vocab_id, c.wof_name, c.placetype,
                           ROW_NUMBER() OVER (
                               PARTITION BY c.vocab_id
                               ORDER BY CASE c.placetype
                                   WHEN 'borough' THEN 4
                                   WHEN 'locality' THEN 5
                                   WHEN 'localadmin' THEN 6
                                   WHEN 'county' THEN 7
                                   WHEN 'region' THEN 8
                                   WHEN 'country' THEN 9
                                   WHEN 'dependency' THEN 10
                                   ELSE 99
                               END
                           ) AS rn
                      FROM candidates c
                      JOIN read_parquet('{pq_path}') w2 ON w2.id = c.wof_id
                     WHERE ST_Contains(w2.geometry, ST_Point(c.lon, c.lat))
                )
                SELECT vocab_id, wof_name, placetype
                  FROM verified
                 WHERE rn = 1
                """
            ).fetchall()

            for vid, wof_name, wof_pt in result:
                new_rank = placetype_rank.get(wof_pt, 99)
                existing = hits_by_vocab.get(int(vid))
                if existing is None or new_rank < existing[3]:
                    hits_by_vocab[int(vid)] = (wof_iso2, wof_name, wof_pt, new_rank)
    finally:
        duck.close()

    buckets: Counter[str] = Counter()
    disagreements_path = output_dir / "disagreements.csv"
    coverage_path = output_dir / "all_results.csv"

    with disagreements_path.open("w", newline="") as dis_f, \
         coverage_path.open("w", newline="") as all_f:
        dis_w = csv.writer(dis_f)
        all_w = csv.writer(all_f)
        header = [
            "vocab_id", "label_en", "lat", "lon",
            "coord_method", "coord_method_detail",
            "wof_iso2", "wof_admin", "wof_placetype",
            "expected_iso2", "bucket",
        ]
        dis_w.writerow(header)
        all_w.writerow(header)

        for vid, label_en, label_nl, lat, lon, c_method, c_detail in places:
            expected = expected_country_lookup(vid) if expected_country_lookup else None
            hit = hits_by_vocab.get(int(vid))
            if hit:
                wof_iso2, wof_name, wof_pt, _rank = hit
                if expected is None or expected.lower() == (wof_iso2 or "").lower():
                    bucket = BUCKET_AGREE
                else:
                    bucket = BUCKET_MILD
                row = [vid, label_en, lat, lon, c_method or "", c_detail or "",
                       wof_iso2 or "", wof_name or "", wof_pt or "",
                       expected or "", bucket]
            else:
                if expected and expected.lower() in WOF_COVERAGE_ISO2:
                    bucket = BUCKET_WRONG
                else:
                    bucket = BUCKET_NO_COVERAGE
                row = [vid, label_en, lat, lon, c_method or "", c_detail or "",
                       "", "", "", expected or "", bucket]

            buckets[bucket] += 1
            all_w.writerow(row)
            if bucket in (BUCKET_WRONG, BUCKET_MILD):
                dis_w.writerow(row)

    summary_path = output_dir / "summary.txt"
    with summary_path.open("w") as f:
        f.write(f"PIP validation summary\n")
        f.write(f"DB rows scanned: {len(places)}\n")
        f.write(f"WOF parquet glob: {wof_parquet_glob}\n")
        for bucket in (BUCKET_AGREE, BUCKET_MILD, BUCKET_WRONG, BUCKET_NO_COVERAGE):
            f.write(f"  {bucket}: {buckets[bucket]}\n")

    return dict(buckets)


def _load_expected_countries(path: Path) -> Callable[[int], Optional[str]]:
    table: dict[int, str] = {}
    with path.open() as f:
        reader = csv.reader(f)
        next(reader, None)  # header
        for row in reader:
            if len(row) >= 2 and row[0] and row[1]:
                table[int(row[0])] = row[1].strip().lower()
    return lambda vid: table.get(vid)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--db", required=True, type=Path)
    p.add_argument("--wof-parquet", required=True,
                   help="Glob pattern for WOF parquet files")
    p.add_argument("--output-dir", required=True, type=Path)
    p.add_argument("--expected-countries", type=Path, default=None,
                   help="Optional CSV (vocab_id,iso2) for expected-vs-actual bucketing")
    args = p.parse_args(argv)

    expected = _load_expected_countries(args.expected_countries) if args.expected_countries else None

    conn = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
    try:
        result = run_pip_validation(conn, args.wof_parquet, args.output_dir, expected)
    finally:
        conn.close()

    print(f"PIP validation complete: {result}")
    print(f"Outputs: {args.output_dir}/{{disagreements.csv, all_results.csv, summary.txt}}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
