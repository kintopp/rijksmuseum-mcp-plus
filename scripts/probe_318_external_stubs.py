#!/usr/bin/env python3
"""Probe for #318 — locate label-less Linked Art place stubs whose only
useful pointer is an external schema:sameAs (TGN / Wikidata / GeoNames)
and measure what LIDO 2020 + (existing pipeline outputs) can do for them.

Outputs:
  - data/audit/issue-318-external-stubs.tsv   (rijks_id, external_uri, authority)
  - stdout summary: total stubs, per-authority counts, LIDO label-coverage
    cross-walk, comparison to geocode-pipeline scope.

No DB writes. Pure read + TSV.
"""
from __future__ import annotations

import argparse
import csv
import os
import re
import sqlite3
import sys
from pathlib import Path
from collections import Counter

REPO_ROOT = Path(__file__).resolve().parent.parent
PLACE_DUMP = Path("/tmp/rm-dump-place")
VOCAB_DB = REPO_ROOT / "data" / "vocabulary.db"
LIDO_DB = REPO_ROOT / "data" / "lido-events-snapshot.db"
OUT_TSV = REPO_ROOT / "data" / "audit" / "issue-318-external-stubs.tsv"

PLACE_TYPE_URI = "<http://schema.org/Place>"

NT_PREDICATE = re.compile(
    r'^<https://id\.rijksmuseum\.nl/(\d+)>\s+<([^>]+)>\s+(.+?)\s*\.\s*$'
)

# External authority recognisers
def classify_external(uri: str) -> str | None:
    if "vocab.getty.edu/tgn" in uri:
        return "tgn"
    if "wikidata.org/entity" in uri or "wikidata.org/wiki" in uri:
        return "wikidata"
    if "sws.geonames.org" in uri or "www.geonames.org" in uri or "geonames.org" in uri:
        return "geonames"
    if "pleiades.stoa.org" in uri:
        return "pleiades"
    if "viaf.org" in uri:
        return "viaf"
    if "loc.gov" in uri:
        return "loc"
    return None


def canon_geonames(uri: str) -> str:
    """Canonicalize GeoNames variants to a single form for joins."""
    m = re.search(r"geonames\.org/(?:rdf/|wiki/)?(\d+)", uri)
    if m:
        return f"geonames:{m.group(1)}"
    return uri


def canon_authority(uri: str, auth: str) -> str:
    if auth == "geonames":
        return canon_geonames(uri)
    if auth == "tgn":
        m = re.search(r"tgn/(\d+)", uri)
        if m:
            return f"tgn:{m.group(1)}"
    if auth == "wikidata":
        m = re.search(r"(?:entity|wiki)/(Q\d+)", uri)
        if m:
            return f"wikidata:{m.group(1)}"
    return uri


def parse_stub(filepath: str) -> tuple[str, list[str]] | None:
    """Return (rijks_id, sameAs_uris) iff the file is a label-less Place stub
    with at least one external sameAs link.
    """
    rijks_id = os.path.basename(filepath)
    is_place = False
    has_label = False
    same_as_external: list[str] = []
    has_internal_sameAs = False

    with open(filepath, "r", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue

            # rdf:type schema:Place check
            if "<http://www.w3.org/1999/02/22-rdf-syntax-ns#type>" in line and PLACE_TYPE_URI in line:
                is_place = True

            # Any flavour of label/name → mark as labelled (don't keep)
            if any(p in line for p in (
                "<http://schema.org/name>",
                "<http://www.w3.org/2004/02/skos/core#prefLabel>",
                "<http://www.w3.org/2004/02/skos/core#altLabel>",
                "<http://www.w3.org/2000/01/rdf-schema#label>",
                "<http://www.cidoc-crm.org/cidoc-crm/P190_has_symbolic_content>",
                "<http://schema.org/alternateName>",
            )) and '"' in line:
                # Has a literal label — not a stub for our purposes
                has_label = True

            # schema:sameAs links
            if "<http://schema.org/sameAs>" in line or "<https://schema.org/sameAs>" in line:
                m = re.search(r'<((?:https?:)?//[^>]+)>\s*\.\s*$', line)
                if m:
                    target = m.group(1)
                    if "id.rijksmuseum.nl/" in target:
                        has_internal_sameAs = True
                    elif classify_external(target):
                        same_as_external.append(target)

    if not is_place or has_label or not same_as_external:
        return None
    if has_internal_sameAs:
        # Tier 2 territory (#316), not Tier 4 (#318)
        return None
    return rijks_id, same_as_external


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--place-dump", type=Path, default=PLACE_DUMP)
    ap.add_argument("--vocab-db", type=Path, default=VOCAB_DB)
    ap.add_argument("--lido-db", type=Path, default=LIDO_DB)
    ap.add_argument("--out", type=Path, default=OUT_TSV)
    args = ap.parse_args()

    if not args.place_dump.is_dir():
        print(f"ERROR: place dump not found: {args.place_dump}", file=sys.stderr)
        return 1

    # Walk place dump, collect external-only sameAs stubs
    stubs: list[tuple[str, str, str, str]] = []  # (rijks_id, external_uri, authority, canonical)
    files = [f for f in os.listdir(args.place_dump)
             if os.path.isfile(args.place_dump / f) and not f.startswith(".")]
    print(f"Walking {len(files):,} place dump files...")

    by_authority = Counter()
    distinct_stubs = set()
    for i, fname in enumerate(files):
        if i and i % 5000 == 0:
            print(f"  {i:,}/{len(files):,}", flush=True)
        result = parse_stub(str(args.place_dump / fname))
        if not result:
            continue
        rijks_id, external_uris = result
        distinct_stubs.add(rijks_id)
        for uri in external_uris:
            auth = classify_external(uri)
            if not auth:
                continue
            canonical = canon_authority(uri, auth)
            stubs.append((rijks_id, uri, auth, canonical))
            by_authority[auth] += 1

    print(f"\n=== #318 stub population ===")
    print(f"  distinct label-less external-sameAs Place stubs: {len(distinct_stubs):,}")
    print(f"  total (rijks_id, external_uri) pairs:            {len(stubs):,}")
    print(f"  per-authority breakdown:")
    for auth, n in by_authority.most_common():
        print(f"    {auth:>10}: {n:,}")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", newline="") as f:
        w = csv.writer(f, delimiter="\t")
        w.writerow(["rijks_id", "external_uri", "authority", "canonical"])
        for row in stubs:
            w.writerow(row)
    print(f"\n  wrote {args.out}")

    # Coverage probe: cross-walk against LIDO event_place_uri
    if not args.lido_db.exists():
        print(f"\nWARN: LIDO snapshot not found at {args.lido_db} — skipping coverage probe")
        return 0

    conn = sqlite3.connect(":memory:")
    conn.execute(f"ATTACH DATABASE ? AS lido", (str(args.lido_db),))
    conn.execute("CREATE TABLE stubs (rijks_id TEXT, external_uri TEXT, authority TEXT, canonical TEXT)")
    conn.executemany("INSERT INTO stubs VALUES (?,?,?,?)", stubs)
    conn.execute("CREATE INDEX idx_stubs_canonical ON stubs(canonical)")

    # Pre-canonicalise LIDO place URIs into a temp view
    print(f"\n=== LIDO 2020 cross-walk ===")
    print(f"  building LIDO place index...")

    conn.execute("""
        CREATE TEMP TABLE lido_places AS
        SELECT DISTINCT event_place_uri AS uri, event_place_name AS name
        FROM lido.lido_events
        WHERE event_place_uri IS NOT NULL AND event_place_name IS NOT NULL
        UNION
        SELECT DISTINCT repository_place_uri, repository_place_name
        FROM lido.lido_records
        WHERE repository_place_uri IS NOT NULL AND repository_place_name IS NOT NULL
    """)
    n_lido_places = conn.execute("SELECT COUNT(*) FROM lido_places").fetchone()[0]
    print(f"  LIDO distinct (place_uri, place_name) pairs: {n_lido_places:,}")

    # Canonicalise LIDO URIs same way as stubs
    rows = conn.execute("SELECT uri, name FROM lido_places").fetchall()
    conn.execute("CREATE TABLE lido_canon (canonical TEXT, name TEXT)")
    canon_rows = []
    for uri, name in rows:
        if not uri:
            continue
        if "geonames.org" in uri:
            canon_rows.append((canon_geonames(uri), name))
        elif "vocab.getty.edu/tgn" in uri:
            m = re.search(r"tgn/(\d+)", uri)
            if m:
                canon_rows.append((f"tgn:{m.group(1)}", name))
        elif "wikidata.org" in uri:
            m = re.search(r"(?:entity|wiki)/(Q\d+)", uri)
            if m:
                canon_rows.append((f"wikidata:{m.group(1)}", name))
    conn.executemany("INSERT INTO lido_canon VALUES (?,?)", canon_rows)
    conn.execute("CREATE INDEX idx_lc_canon ON lido_canon(canonical)")
    print(f"  canonicalised LIDO entries: {len(canon_rows):,}")

    # Per-authority coverage
    print(f"\n  --- coverage by authority ---")
    for auth in by_authority:
        result = conn.execute(f"""
            SELECT COUNT(DISTINCT s.rijks_id), COUNT(DISTINCT s.canonical)
            FROM stubs s JOIN lido_canon l ON s.canonical = l.canonical
            WHERE s.authority = ?
        """, (auth,)).fetchone()
        total_stubs_in_auth = conn.execute(
            "SELECT COUNT(DISTINCT rijks_id) FROM stubs WHERE authority = ?", (auth,)
        ).fetchone()[0]
        rijks_hit, canon_hit = result
        if total_stubs_in_auth:
            print(f"    {auth:>10}: {rijks_hit:>4}/{total_stubs_in_auth:<4} stubs ({100*rijks_hit/total_stubs_in_auth:.1f}%) "
                  f"via {canon_hit} distinct LIDO entries")

    overall = conn.execute("""
        SELECT COUNT(DISTINCT s.rijks_id)
        FROM stubs s JOIN lido_canon l ON s.canonical = l.canonical
    """).fetchone()[0]
    total_distinct = conn.execute("SELECT COUNT(DISTINCT rijks_id) FROM stubs").fetchone()[0]
    print(f"\n  TOTAL: {overall}/{total_distinct} stubs ({100*overall/total_distinct:.1f}%) recoverable via LIDO labels")

    # Sample matches
    print(f"\n  --- sample matches ---")
    samples = conn.execute("""
        SELECT s.rijks_id, s.authority, s.canonical, l.name
        FROM stubs s JOIN lido_canon l ON s.canonical = l.canonical
        LIMIT 8
    """).fetchall()
    for r, a, c, n in samples:
        print(f"    {r}  [{a}]  {c}  →  {n!r}")

    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
