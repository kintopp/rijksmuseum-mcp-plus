"""Pilot probe for issue #307: measure Wikidata cross-walk hit-rate on 21xxx
LA-shape creators that lack a direct Wikidata URI in the harvest's
``vocabulary_external_ids`` table.

Read-only against ``data/vocabulary.db``. Queries Wikidata SPARQL.

Three cohorts are reported:

  A. ALREADY-HAVE: 21xxx persons whose ``vocabulary_external_ids`` already
     carries a ``wikidata`` authority row from the original harvest. These can
     be backfilled with a single JOIN — no SPARQL needed.
  B. SPARQL-CANDIDATES: 21xxx persons with NO wikidata URI but ≥1 other
     cross-walk URI (RKDartists / ULAN / VIAF / CERL / Biografisch Portaal /
     NYPL). These are the ones a Phase 2e SPARQL probe could resolve.
  C. UNREACHABLE: 21xxx persons with no external authority IDs at all.

The probe samples ``--sample-size`` rows from cohort B, batch-queries the
Wikidata Query Service using P650 (RKDartists), P245 (ULAN), P214 (VIAF), and
P1871 (CERL), and reports per-property hit-rate plus conflict rate.

Usage:
  python scripts/probe_wikidata_creator_crosswalk.py [--sample-size 200] [--seed 42]
"""
from __future__ import annotations

import argparse
import json
import random
import sqlite3
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

import requests

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DB_PATH = PROJECT_ROOT / "data" / "vocabulary.db"
CACHE_PATH = PROJECT_ROOT / "data" / "audit" / "wikidata-creator-crosswalk-pilot.jsonl"

WDQS_URL = "https://query.wikidata.org/sparql"
USER_AGENT = "rijksmuseum-mcp-plus/0.27 (https://github.com/kintopp/rijksmuseum-mcp-plus; arno.bosse@gmail.com)"

# (authority-in-vei, wikidata-property, label) — order matters: preference for
# tie-breaking when multiple cross-walks resolve to different Q-numbers.
CROSSWALKS = [
    ("rkd",  "P650",  "RKDartists"),
    ("ulan", "P245",  "ULAN"),
    ("viaf", "P214",  "VIAF"),
    ("cerl", "P1871", "CERL Thesaurus"),
]
PROP_BY_AUTH = {auth: prop for auth, prop, _ in CROSSWALKS}
LABEL_BY_AUTH = {auth: label for auth, _, label in CROSSWALKS}

BATCH_SIZE = 80              # Q-number lookups per SPARQL request
SLEEP_BETWEEN_REQUESTS = 1.0  # WDQS etiquette


def cohort_counts(conn: sqlite3.Connection) -> dict[str, int]:
    cur = conn.cursor()
    total = cur.execute(
        "SELECT COUNT(*) FROM vocabulary WHERE type='person' AND id LIKE '21%'"
    ).fetchone()[0]
    already = cur.execute("""
        SELECT COUNT(DISTINCT vei.vocab_id)
        FROM vocabulary_external_ids vei
        JOIN vocabulary v ON v.id = vei.vocab_id
        WHERE v.type='person' AND v.id LIKE '21%' AND vei.authority='wikidata'
    """).fetchone()[0]
    sparql_candidates = cur.execute("""
        WITH no_wiki AS (
          SELECT v.id FROM vocabulary v
          WHERE v.type='person' AND v.id LIKE '21%'
            AND NOT EXISTS (
              SELECT 1 FROM vocabulary_external_ids vei
              WHERE vei.vocab_id=v.id AND vei.authority='wikidata'
            )
        )
        SELECT COUNT(DISTINCT vei.vocab_id)
        FROM vocabulary_external_ids vei
        JOIN no_wiki nw ON nw.id = vei.vocab_id
        WHERE vei.authority IN ('rkd','ulan','viaf','cerl','biografisch_portaal','nypl')
    """).fetchone()[0]
    unreachable = cur.execute("""
        SELECT COUNT(*) FROM vocabulary v
        WHERE v.type='person' AND v.id LIKE '21%'
          AND NOT EXISTS (SELECT 1 FROM vocabulary_external_ids vei WHERE vei.vocab_id=v.id)
    """).fetchone()[0]
    return {
        "total_21xxx_persons": total,
        "cohort_a_already_have_wikidata_uri": already,
        "cohort_b_sparql_candidates": sparql_candidates,
        "cohort_c_unreachable_no_crosswalks": unreachable,
    }


def load_cohort_b(conn: sqlite3.Connection) -> dict[str, dict[str, list[str]]]:
    """Return {vocab_id: {authority: [local_id, ...]}} for cohort B."""
    rows = conn.execute("""
        WITH no_wiki AS (
          SELECT v.id FROM vocabulary v
          WHERE v.type='person' AND v.id LIKE '21%'
            AND NOT EXISTS (
              SELECT 1 FROM vocabulary_external_ids vei
              WHERE vei.vocab_id=v.id AND vei.authority='wikidata'
            )
        )
        SELECT vei.vocab_id, vei.authority, vei.id
        FROM vocabulary_external_ids vei
        JOIN no_wiki nw ON nw.id = vei.vocab_id
        WHERE vei.authority IN ('rkd','ulan','viaf','cerl')
    """).fetchall()
    out: dict[str, dict[str, list[str]]] = defaultdict(lambda: defaultdict(list))
    for vocab_id, authority, local_id in rows:
        out[vocab_id][authority].append(local_id)
    return out


def sparql_query(query: str) -> list[dict]:
    headers = {"User-Agent": USER_AGENT, "Accept": "application/sparql-results+json"}
    r = requests.get(WDQS_URL, params={"query": query}, headers=headers, timeout=60)
    r.raise_for_status()
    return r.json()["results"]["bindings"]


def resolve_property(authority: str, local_ids: list[str]) -> dict[str, str]:
    """Map {local_id → Q-number} for one authority by querying WDQS."""
    prop = PROP_BY_AUTH[authority]
    found: dict[str, str] = {}
    unique_ids = sorted(set(local_ids))
    for i in range(0, len(unique_ids), BATCH_SIZE):
        batch = unique_ids[i : i + BATCH_SIZE]
        values_clause = " ".join(f'"{x}"' for x in batch)
        query = f"""
SELECT ?id ?qid WHERE {{
  VALUES ?id {{ {values_clause} }}
  ?qid wdt:{prop} ?id .
}}
"""
        try:
            bindings = sparql_query(query)
        except Exception as e:
            print(f"    SPARQL error for {authority} batch {i}: {e}", file=sys.stderr)
            time.sleep(SLEEP_BETWEEN_REQUESTS * 5)
            continue
        for b in bindings:
            local_id = b["id"]["value"]
            qid_uri = b["qid"]["value"]
            qid = qid_uri.rsplit("/", 1)[-1]
            if local_id not in found:
                found[local_id] = qid
        time.sleep(SLEEP_BETWEEN_REQUESTS)
    return found


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample-size", type=int, default=200)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    if not DB_PATH.exists():
        print(f"ERROR: {DB_PATH} not found", file=sys.stderr)
        return 1

    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)

    print("=" * 70)
    print("Pilot probe — Wikidata cross-walk hit-rate on 21xxx LA creators")
    print("Issue: https://github.com/kintopp/rijksmuseum-mcp-plus-offline/issues/307")
    print("=" * 70)
    print()

    counts = cohort_counts(conn)
    total = counts["total_21xxx_persons"]
    print("Cohort landscape (full 21xxx namespace):")
    for k, v in counts.items():
        if k == "total_21xxx_persons":
            print(f"  {k:50s} {v:>7,}  (100.0%)")
        else:
            print(f"  {k:50s} {v:>7,}  ({100*v/total:>4.1f}%)")
    print()

    cohort_b = load_cohort_b(conn)
    cohort_b_size = len(cohort_b)
    print(f"Cohort B (SPARQL candidates) loaded: {cohort_b_size:,} persons with ≥1 RKD/ULAN/VIAF/CERL URI")

    rng = random.Random(args.seed)
    sample_ids = rng.sample(sorted(cohort_b.keys()), min(args.sample_size, cohort_b_size))
    print(f"Sampling {len(sample_ids)} persons (seed={args.seed})")
    print()

    sample_authority_count: Counter[str] = Counter()
    by_authority_ids: dict[str, list[str]] = defaultdict(list)
    for vocab_id in sample_ids:
        for authority, local_ids in cohort_b[vocab_id].items():
            sample_authority_count[authority] += 1
            by_authority_ids[authority].extend(local_ids)

    print("Sample composition (persons with at least one URI of given authority):")
    for authority, prop, label in CROSSWALKS:
        n = sample_authority_count.get(authority, 0)
        print(f"  {label:18s} ({prop}) : {n:>4,} / {len(sample_ids)} ({100*n/len(sample_ids):>4.1f}%)")
    print()

    print("Querying Wikidata SPARQL ...")
    qid_by_authority: dict[str, dict[str, str]] = {}
    for authority, prop, label in CROSSWALKS:
        ids = by_authority_ids.get(authority, [])
        if not ids:
            qid_by_authority[authority] = {}
            continue
        print(f"  {label:18s} ({prop}) : resolving {len(set(ids)):,} unique IDs ...")
        qid_by_authority[authority] = resolve_property(authority, ids)
        print(f"    → {len(qid_by_authority[authority]):,} resolved to a Q-number")

    print()
    print("Per-person hit-rate (sample):")
    person_hits: dict[str, dict[str, str]] = defaultdict(dict)
    for vocab_id in sample_ids:
        for authority, local_ids in cohort_b[vocab_id].items():
            if authority not in PROP_BY_AUTH:
                continue
            for lid in local_ids:
                qid = qid_by_authority[authority].get(lid)
                if qid:
                    if authority not in person_hits[vocab_id]:
                        person_hits[vocab_id][authority] = qid
                    break

    print()
    print(f"  {'Property':<22s} {'Persons attempted':>20s} {'Persons resolved':>20s} {'Hit rate':>10s}")
    print(f"  {'-'*22} {'-'*20} {'-'*20} {'-'*10}")
    any_resolved = 0
    for authority, prop, label in CROSSWALKS:
        attempted = sample_authority_count.get(authority, 0)
        resolved = sum(1 for vid in sample_ids if person_hits[vid].get(authority))
        rate = (100 * resolved / attempted) if attempted else 0.0
        print(f"  {label + ' (' + prop + ')':<22s} {attempted:>20,} {resolved:>20,} {rate:>9.1f}%")
    for vid in sample_ids:
        if person_hits[vid]:
            any_resolved += 1
    print()
    overall_rate = 100 * any_resolved / len(sample_ids)
    print(f"  Persons resolved by ≥1 cross-walk: {any_resolved:,} / {len(sample_ids):,} ({overall_rate:.1f}%)")
    print()

    conflicts = 0
    conflict_examples = []
    for vid in sample_ids:
        qids = set(person_hits[vid].values())
        if len(qids) > 1:
            conflicts += 1
            if len(conflict_examples) < 5:
                conflict_examples.append((vid, dict(person_hits[vid])))
    print("Conflict analysis (different cross-walks → different Q-numbers):")
    print(f"  Persons with ≥2 distinct Q-numbers: {conflicts:,} / {any_resolved:,} resolved")
    for vid, hits in conflict_examples:
        print(f"    {vid}: {hits}")
    print()

    print("Projection (extrapolating sample rate to full cohort B):")
    proj = int(overall_rate / 100 * counts["cohort_b_sparql_candidates"])
    print(f"  Cohort B size:                              {counts['cohort_b_sparql_candidates']:>7,}")
    print(f"  Estimated resolvable via SPARQL:            {proj:>7,}  ({overall_rate:.1f}% of B)")
    print()
    cohort_a = counts["cohort_a_already_have_wikidata_uri"]
    headline_after = cohort_a + proj
    print(f"  Combined coverage on 21xxx after Phase 2e:  {headline_after:>7,}  ({100*headline_after/total:.1f}% of 21xxx)")
    print(f"  Combined absolute gain over current 5.3%:   +{headline_after:,} wikidata_id rows")
    print()

    CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with CACHE_PATH.open("w") as fh:
        for vid in sample_ids:
            row = {
                "vocab_id": vid,
                "uris": cohort_b[vid],
                "resolved": person_hits.get(vid, {}),
            }
            fh.write(json.dumps(row) + "\n")
    print(f"Wrote sample detail to {CACHE_PATH.relative_to(PROJECT_ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
