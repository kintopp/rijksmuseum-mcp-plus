"""Backfill entity_alt_names rows for vocabulary.type='group' (and opportunistically
'organisation') by matching EDM actors-dump prefLabels against vocabulary labels
and inserting the corresponding altLabels.

One-shot for v0.26 dress-rehearsal DB. The same logic should land in
scripts/enrich-vocab-from-dumps.py as Phase 2e per issue #306; this script
exists so the dress-rehearsal DB can exercise the cluster-B findOrgIdsFts
path for groups without waiting for the next harvest.

Usage:
    ~/miniconda3/envs/embeddings/bin/python scripts/backfill_group_altnames_from_edm.py
    ~/miniconda3/envs/embeddings/bin/python scripts/backfill_group_altnames_from_edm.py --dry-run
"""

from __future__ import annotations

import argparse
import sqlite3
import sys
import time
import xml.etree.ElementTree as ET
import zipfile
from collections import defaultdict
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parents[1]
DB_PATH = PROJECT_DIR / "data" / "vocabulary.db"
EDM_ZIP = Path.home() / "Downloads" / "rijksmuseum-data-dumps" / "201911-rma-edm-actors.zip"

NS = {
    "edm": "http://www.europeana.eu/schemas/edm/",
    "skos": "http://www.w3.org/2004/02/skos/core#",
}


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def iter_edm_agents(zip_path: Path):
    """Yield (pref_label, [alt_labels]) for each <edm:Agent> in the dump."""
    with zipfile.ZipFile(zip_path) as z:
        with z.open(z.namelist()[0]) as f:
            ctx = ET.iterparse(f, events=("end",))
            for _, elem in ctx:
                if elem.tag == f"{{{NS['edm']}}}Agent":
                    pref = None
                    alts: list[str] = []
                    for child in elem:
                        if child.tag == f"{{{NS['skos']}}}prefLabel" and child.text:
                            pref = child.text.strip()
                        elif child.tag == f"{{{NS['skos']}}}altLabel" and child.text:
                            alts.append(child.text.strip())
                    if pref and alts:
                        yield pref, alts
                    elem.clear()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="report only, no writes")
    args = ap.parse_args()

    if not DB_PATH.exists():
        log(f"ERROR: DB not found at {DB_PATH}")
        return 1
    if not EDM_ZIP.exists():
        log(f"ERROR: EDM actors zip not found at {EDM_ZIP}")
        return 1

    log(f"DB: {DB_PATH} ({DB_PATH.stat().st_size / 1024 / 1024:.1f} MB)")
    log(f"EDM zip: {EDM_ZIP}")
    log(f"Mode: {'DRY RUN' if args.dry_run else 'WRITE'}")

    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row

    # Build label → [(vocab_id, type)] lookup for groups + organisations only
    log("Building label→vocab lookup for groups + organisations...")
    label_to_vocab: dict[str, list[tuple[str, str]]] = defaultdict(list)
    rows = conn.execute(
        "SELECT id, type, label_en, label_nl FROM vocabulary "
        "WHERE type IN ('group', 'organisation')"
    ).fetchall()
    for r in rows:
        for label in (r["label_en"], r["label_nl"]):
            if label:
                label_to_vocab[label.strip()].append((r["id"], r["type"]))
    n_groups = sum(1 for r in rows if r["type"] == "group")
    n_orgs = sum(1 for r in rows if r["type"] == "organisation")
    log(f"  Lookup: {len(label_to_vocab):,} distinct labels covering {n_groups:,} groups + {n_orgs:,} organisations")

    # Pre-flight: existing entity_alt_names baseline by type
    baseline = dict(conn.execute(
        "SELECT entity_type, COUNT(*) FROM entity_alt_names GROUP BY entity_type"
    ).fetchall())
    log(f"  Baseline entity_alt_names: {baseline}")

    # Walk the EDM dump, accumulate (entity_id, entity_type, name) candidates
    log("Parsing EDM actors dump...")
    candidates: list[tuple[str, str, str]] = []  # (entity_id, entity_type, name)
    matched_agents = 0
    seen_agents = 0
    for pref, alts in iter_edm_agents(EDM_ZIP):
        seen_agents += 1
        matches = label_to_vocab.get(pref)
        if not matches:
            continue
        matched_agents += 1
        for vocab_id, v_type in matches:
            for alt in alts:
                candidates.append((vocab_id, v_type, alt))
    log(f"  Walked {seen_agents:,} agents with altLabels; matched {matched_agents:,} to a group/org vocab row")
    log(f"  Candidate rows (pre-dedup): {len(candidates):,}")

    # Tabulate by entity_type for reporting
    by_type: dict[str, int] = defaultdict(int)
    for _, t, _ in candidates:
        by_type[t] += 1
    log(f"  Candidate breakdown by entity_type: {dict(by_type)}")

    # Distinct (entity_id, name) pairs that aren't already in entity_alt_names
    log("Filtering out rows already present in entity_alt_names (by UNIQUE(entity_id, name))...")
    existing = set(conn.execute(
        "SELECT entity_id, name FROM entity_alt_names"
    ).fetchall())
    existing_keys = {(eid, n) for eid, n in existing}
    novel: list[tuple[str, str, str]] = []
    novel_keys: set[tuple[str, str]] = set()
    for vocab_id, v_type, alt in candidates:
        key = (vocab_id, alt)
        if key in existing_keys or key in novel_keys:
            continue
        novel_keys.add(key)
        novel.append((vocab_id, v_type, alt))
    log(f"  Novel rows to insert: {len(novel):,}")

    # Per-type novel breakdown
    novel_by_type: dict[str, int] = defaultdict(int)
    novel_distinct_entities: dict[str, set] = defaultdict(set)
    for eid, t, _ in novel:
        novel_by_type[t] += 1
        novel_distinct_entities[t].add(eid)
    log(f"  Novel by entity_type: {dict(novel_by_type)}")
    log(f"  Novel distinct entities by type: {{ {', '.join(f'{k}: {len(v):,}' for k, v in novel_distinct_entities.items())} }}")

    if args.dry_run:
        log("DRY RUN: no writes performed.")
        # Show 5 sample insertions
        log("Sample (first 5 candidates):")
        for vocab_id, v_type, alt in novel[:5]:
            # Look up the canonical for context
            r = conn.execute(
                "SELECT label_en, label_nl FROM vocabulary WHERE id=?", (vocab_id,)
            ).fetchone()
            canonical = r["label_en"] or r["label_nl"] or "(no label)"
            log(f"  [{v_type}] {vocab_id} {canonical!r} ← altLabel {alt!r}")
        conn.close()
        return 0

    # Write
    log(f"Writing {len(novel):,} rows to entity_alt_names...")
    cur = conn.cursor()
    cur.executemany(
        "INSERT OR IGNORE INTO entity_alt_names (entity_id, entity_type, name, lang, classification) "
        "VALUES (?, ?, ?, NULL, 'edm_altlabel')",
        novel,
    )
    inserted = cur.rowcount
    conn.commit()
    log(f"  Inserted {inserted:,} rows (rowcount; INSERT OR IGNORE may report -1 on some sqlite builds)")

    # Refresh FTS index
    log("Refreshing entity_alt_names_fts...")
    conn.execute("INSERT INTO entity_alt_names_fts(entity_alt_names_fts) VALUES('rebuild')")
    fts_count = conn.execute("SELECT COUNT(*) FROM entity_alt_names_fts").fetchone()[0]
    conn.commit()
    log(f"  entity_alt_names_fts: {fts_count:,} rows")

    # Final state
    final = dict(conn.execute(
        "SELECT entity_type, COUNT(*) FROM entity_alt_names GROUP BY entity_type"
    ).fetchall())
    log(f"  Final entity_alt_names: {final}")
    delta = {k: final.get(k, 0) - baseline.get(k, 0) for k in set(final) | set(baseline)}
    log(f"  Delta: {delta}")

    # Smoke test: random 3 group entries
    log("Smoke test (3 random group altLabels):")
    for r in conn.execute(
        "SELECT ean.entity_id, ean.name, v.label_en, v.label_nl "
        "FROM entity_alt_names ean JOIN vocabulary v ON ean.entity_id = v.id "
        "WHERE ean.entity_type='group' AND ean.classification='edm_altlabel' "
        "ORDER BY RANDOM() LIMIT 3"
    ):
        canonical = r["label_en"] or r["label_nl"] or "(no label)"
        log(f"  {r['entity_id']} {canonical!r} ← {r['name']!r}")

    conn.close()
    log("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
