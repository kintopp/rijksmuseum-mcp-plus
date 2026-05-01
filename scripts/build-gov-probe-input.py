"""Build the 200-row stratified probe-input + current-concordances CSVs for the
GOV gazetteer suitability investigation.

Output:
  offline/geo/gov-probe/probe-input.csv          (200 rows, 4 strata)
  offline/geo/gov-probe/current-concordances.csv (all external_ids for those 200 vocab_ids)
  offline/geo/gov-probe/probe-input-readme.md    (stratum documentation)

Stratification (revised after schema audit 2026-05-01):
  A — 80 rows with `geonames` external_id           (direct getObjectByExternalId(geonames))
  B — 80 rows with `wikidata` Q-ID but no `geonames` (direct getObjectByExternalId(wikidata))
  C — 20 rows with NO external_id, lat IS NULL       (pure searchByNameAndType, long-tail)
  D — 20 rows with `tgn` only, lat IS NULL           (tests name-search rescue path)

Sampling within each stratum is uniform-random with a fixed seed (42) for reproducibility.
"""
from __future__ import annotations

import csv
import random
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "data" / "vocabulary.db"
OUT_DIR = ROOT / "offline" / "geo" / "gov-probe"
OUT_DIR.mkdir(parents=True, exist_ok=True)

PROBE_INPUT_CSV = OUT_DIR / "probe-input.csv"
CONCORDANCES_CSV = OUT_DIR / "current-concordances.csv"
README = OUT_DIR / "probe-input-readme.md"

SEED = 42
TARGET = {"A": 80, "B": 80, "C": 20, "D": 20}


def fetch_stratum(conn: sqlite3.Connection, sql: str, n: int, label: str) -> list[dict]:
    rows = conn.execute(sql).fetchall()
    if not rows:
        raise RuntimeError(f"stratum {label}: query returned 0 rows")
    rng = random.Random(SEED + ord(label))
    sample = rng.sample(rows, k=min(n, len(rows)))
    print(f"  stratum {label}: pool={len(rows)}, sampled={len(sample)}")
    return [dict(r) for r in sample]


def main() -> None:
    if not DB.exists():
        raise FileNotFoundError(f"vocab db not found at {DB}")

    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row

    # ---------------- stratum A: places with a geonames external_id ----------------
    sql_A = """
    SELECT v.id AS vocab_id,
           v.label_en, v.label_nl,
           v.lat AS db_lat, v.lon AS db_lon,
           v.is_areal,
           gn.id AS geonames_id,
           wd.id AS wikidata_qid
    FROM vocabulary v
    JOIN vocabulary_external_ids gn
         ON gn.vocab_id = v.id AND gn.authority = 'geonames'
    LEFT JOIN vocabulary_external_ids wd
         ON wd.vocab_id = v.id AND wd.authority = 'wikidata'
    WHERE v.type = 'place'
    """

    # ---------------- stratum B: wikidata Q-ID, no geonames ----------------
    sql_B = """
    SELECT v.id AS vocab_id,
           v.label_en, v.label_nl,
           v.lat AS db_lat, v.lon AS db_lon,
           v.is_areal,
           NULL AS geonames_id,
           wd.id AS wikidata_qid
    FROM vocabulary v
    JOIN vocabulary_external_ids wd
         ON wd.vocab_id = v.id AND wd.authority = 'wikidata'
    WHERE v.type = 'place'
      AND NOT EXISTS (
          SELECT 1 FROM vocabulary_external_ids gn
          WHERE gn.vocab_id = v.id AND gn.authority = 'geonames'
      )
    """

    # ---------------- stratum C: no external_id, ungeocoded ----------------
    sql_C = """
    SELECT v.id AS vocab_id,
           v.label_en, v.label_nl,
           v.lat AS db_lat, v.lon AS db_lon,
           v.is_areal,
           NULL AS geonames_id,
           NULL AS wikidata_qid
    FROM vocabulary v
    WHERE v.type = 'place'
      AND v.lat IS NULL
      AND NOT EXISTS (
          SELECT 1 FROM vocabulary_external_ids e WHERE e.vocab_id = v.id
      )
      AND (v.label_en IS NOT NULL OR v.label_nl IS NOT NULL)
    """

    # ---------------- stratum D: tgn only, ungeocoded ----------------
    sql_D = """
    SELECT v.id AS vocab_id,
           v.label_en, v.label_nl,
           v.lat AS db_lat, v.lon AS db_lon,
           v.is_areal,
           NULL AS geonames_id,
           NULL AS wikidata_qid
    FROM vocabulary v
    JOIN vocabulary_external_ids tgn
         ON tgn.vocab_id = v.id AND tgn.authority = 'tgn'
    WHERE v.type = 'place'
      AND v.lat IS NULL
      AND NOT EXISTS (
          SELECT 1 FROM vocabulary_external_ids e
          WHERE e.vocab_id = v.id AND e.authority IN ('geonames', 'wikidata')
      )
      AND (v.label_en IS NOT NULL OR v.label_nl IS NOT NULL)
    """

    print("Building strata:")
    sample = []
    for label, sql in [("A", sql_A), ("B", sql_B), ("C", sql_C), ("D", sql_D)]:
        rows = fetch_stratum(conn, sql, TARGET[label], label)
        for r in rows:
            r["stratum"] = label
        sample.extend(rows)

    # write probe-input.csv
    with PROBE_INPUT_CSV.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(
            f,
            fieldnames=[
                "stratum",
                "vocab_id",
                "label",
                "label_en",
                "label_nl",
                "db_lat",
                "db_lon",
                "is_areal",
                "geonames_id",
                "wikidata_qid",
            ],
        )
        w.writeheader()
        for r in sample:
            label = r["label_en"] or r["label_nl"] or ""
            w.writerow(
                {
                    "stratum": r["stratum"],
                    "vocab_id": r["vocab_id"],
                    "label": label,
                    "label_en": r["label_en"] or "",
                    "label_nl": r["label_nl"] or "",
                    "db_lat": r["db_lat"] if r["db_lat"] is not None else "",
                    "db_lon": r["db_lon"] if r["db_lon"] is not None else "",
                    "is_areal": "" if r["is_areal"] is None else r["is_areal"],
                    "geonames_id": r["geonames_id"] or "",
                    "wikidata_qid": r["wikidata_qid"] or "",
                }
            )
    print(f"\nwrote {len(sample)} rows -> {PROBE_INPUT_CSV.relative_to(ROOT)}")

    # write current-concordances.csv covering all those vocab_ids
    vocab_ids = tuple(r["vocab_id"] for r in sample)
    placeholders = ",".join("?" * len(vocab_ids))
    sql_concord = (
        f"SELECT vocab_id, authority, id, uri FROM vocabulary_external_ids "
        f"WHERE vocab_id IN ({placeholders}) ORDER BY vocab_id, authority, id"
    )
    concords = conn.execute(sql_concord, vocab_ids).fetchall()
    with CONCORDANCES_CSV.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["vocab_id", "authority", "id", "uri"])
        for c in concords:
            w.writerow([c["vocab_id"], c["authority"], c["id"], c["uri"]])
    print(f"wrote {len(concords)} rows -> {CONCORDANCES_CSV.relative_to(ROOT)}")

    # write README (note: not an f-string — code blocks contain literal {…} placeholders)
    README.write_text(
        """# probe-input.csv — README

Generated by `scripts/build-gov-probe-input.py`.
Source DB: `data/vocabulary.db` (v0.26 dress-rehearsal harvest, pre-Stage-5.5).
Random seed: 42. Reproducible.

## Strata

| Stratum | Pool | Target | Selection criterion |
|---|---|---|---|
| A | places with `geonames` external_id (1,581 rows in DB) | 80 | direct `getObjectByExternalId(geonames, ref)` |
| B | places with `wikidata` Q-ID but NOT `geonames` (~11,500 rows) | 80 | direct `getObjectByExternalId(wikidata, Q…)` + `searchByName` fallback |
| C | places with NO external_id and `lat IS NULL` (~12,000 rows) | 20 | pure `searchByNameAndType?placename=…` |
| D | places with `tgn` only and `lat IS NULL` (~13,000 rows) | 20 | name search; tests rescue of TGN-anchored places that lack GeoNames/Wikidata |

`is_areal` is uniformly NULL because Stage 5.5.1 (`harvest-placetypes.py`) has not yet
run on the v0.26 DB. Treat it as "unknown" for now.

## Why this stratification differs from the brief

The original brief assumed `geonames` was a wide-coverage join key. Schema audit
2026-05-01 showed otherwise: **only 1,581 places (4 %) carry a `geonames` ID**;
**Wikidata Q-IDs cover 11,633 places (31 %)** and are the realistic primary axis.
Country-ISO stratification was dropped because the DB does not carry a reliable
country_iso column for places, and label-based country inference is noisy.

## Columns

- `stratum` — A / B / C / D (one of the four above)
- `vocab_id` — primary key in `vocabulary` (TEXT, e.g. `23011452`)
- `label` — preferred label (label_en, fall back to label_nl)
- `label_en`, `label_nl` — both raw forms preserved
- `db_lat`, `db_lon` — coordinates (empty for ungeocoded rows)
- `is_areal` — 0 / 1 / empty
- `geonames_id` — populated only for stratum A
- `wikidata_qid` — populated for strata A and B (where present)

## Companion file: `current-concordances.csv`

Columns: `vocab_id`, `authority`, `id`, `uri`.
Contains every existing `vocabulary_external_ids` row for the 200 sampled vocab_ids,
so the Q4 concordance-richness analysis can diff against what GOV adds.

## Running the probe

For each row:
1. If `geonames_id` is non-empty:
   `GET /api/getObjectByExternalId?system=geonames&ref={geonames_id}`
2. Else if `wikidata_qid` is non-empty:
   `GET /api/getObjectByExternalId?system=wikidata&ref={wikidata_qid}`
3. Always (independent fallback for misses + comparator):
   `GET /api/searchByNameAndType?placename={label}`

Bucketing rules (haversine distance from `db_lat`,`db_lon` to GOV `position`):
- `match_agree` — distance ≤ 5 km
- `match_partial` — 5–50 km
- `match_disagree` — 50–1000 km
- `match_far_disagree` — > 1000 km (likely homonym)
- `no_match` — both ID and name lookups failed
- `ungeocoded_match` — `db_lat` was NULL, GOV provided coords
- `error_other` — record details in notes

Output `probe-results.csv` columns per the brief.

Rate limit: 1 request per second to gov.genealogy.net.
""",
        encoding="utf-8",
    )
    print(f"wrote -> {README.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
