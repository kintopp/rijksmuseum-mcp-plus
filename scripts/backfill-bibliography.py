#!/usr/bin/env python3
"""
Backfill scholarly bibliography citations into an existing vocabulary database.

Reads artwork object URIs from artwork_hmo_ids (100% coverage), fetches each
artwork's Linked Art JSON-LD, extracts citation entries from assigned_by[]
(classified AAT 300311954), resolves 301* publication records (Schema.org,
follows 303 redirect), composes citation text, and writes rows to
artwork_citations.

Does NOT require a full re-harvest. Populates additively against the existing
v0.81+ DB. Re-runs are idempotent per artwork (DELETE + re-INSERT).

Usage:
    python3 scripts/backfill-bibliography.py --subset paintings --dry-run --limit 5
    python3 scripts/backfill-bibliography.py --subset paintings --limit 100
    python3 scripts/backfill-bibliography.py --subset provenance
    python3 scripts/backfill-bibliography.py --subset all --resume

Subset counts (verified 2026-06-19 against v0.81 DB):
  paintings   ~4,879  artworks (~10–20 min full run)
  on-display  ~8,472  artworks
  provenance  ~48,559 artworks (~1.5–3 h full run)
  all         ~834,435 artworks

Publication resolution is dedup-cached per run (bounded by distinct publications,
not total citations). Object fetches require network; --dry-run skips fetches.

Dependencies: stdlib only (argparse, json, sqlite3, time, urllib.request).
Shared extraction logic: scripts/lib/bibliography_extract.py.
"""

import argparse
import json
import sqlite3
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
PROJECT_DIR = SCRIPT_DIR.parent

# Make scripts/lib importable
sys.path.insert(0, str(SCRIPT_DIR))
from lib.bibliography_extract import extract_citations, compose_citation  # noqa: E402

DB_PATH = PROJECT_DIR / "data" / "vocabulary.db"
USER_AGENT = "rijksmuseum-mcp-backfill-bibliography/1.0"
CHECKPOINT_TABLE = "backfill_bibliography_progress"

# Subset SQL predicates (applied to artworks table via a JOIN with artwork_hmo_ids)
SUBSET_PREDICATES: dict[str, str | None] = {
    "paintings": (
        "a.art_id IN ("
        "  SELECT DISTINCT m.artwork_id FROM mappings m"
        "  JOIN field_lookup f ON f.id = m.field_id"
        "  JOIN vocabulary v ON v.vocab_int_id = m.vocab_rowid"
        "  WHERE f.name = 'type' AND (v.label_en = 'painting' OR v.label_nl = 'schilderij')"
        ")"
    ),
    "on-display": "a.current_location IS NOT NULL AND a.current_location != ''",
    "provenance": "a.provenance_text IS NOT NULL AND a.provenance_text != ''",
    "all": None,
}


def get_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}


def ensure_citations_table(conn: sqlite3.Connection) -> None:
    """Create artwork_citations and backfill checkpoint table if absent."""
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS artwork_citations (
          art_id          INTEGER NOT NULL,
          seq             INTEGER,
          citation_text   TEXT NOT NULL,
          publication_id  INTEGER,
          pages           TEXT,
          isbn            TEXT,
          worldcat_uri    TEXT,
          library_url     TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_artwork_citations_art ON artwork_citations(art_id);
        CREATE INDEX IF NOT EXISTS idx_artwork_citations_pub ON artwork_citations(publication_id);
        CREATE TABLE IF NOT EXISTS backfill_bibliography_progress (
          art_id INTEGER PRIMARY KEY
        );
    """)
    conn.commit()


def fetch_json(uri: str, timeout: int = 15) -> dict | None:
    """GET a URI with Accept: application/ld+json (follows 303 redirect).
    Returns the parsed JSON dict, or None on failure.
    """
    req = urllib.request.Request(
        uri,
        headers={"Accept": "application/ld+json", "User-Agent": USER_AGENT},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, ValueError, OSError):
        return None


def build_subset_query(subset: str, where_extra: str | None, limit: int) -> str:
    """Build the SELECT query for the subset."""
    predicate = SUBSET_PREDICATES.get(subset)
    parts = ["SELECT a.art_id, h.hmo_id FROM artworks a JOIN artwork_hmo_ids h ON h.art_id = a.art_id"]
    wheres = []
    if predicate:
        wheres.append(predicate)
    if where_extra:
        wheres.append(f"({where_extra})")
    if wheres:
        parts.append("WHERE " + " AND ".join(wheres))
    if limit > 0:
        parts.append(f"LIMIT {limit}")
    return " ".join(parts)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Backfill artwork citations from Linked Art assigned_by[] into artwork_citations.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--db", default=str(DB_PATH), help="Path to vocabulary.db (default: data/vocabulary.db)")
    group = parser.add_mutually_exclusive_group()
    group.add_argument(
        "--subset", choices=list(SUBSET_PREDICATES), default="paintings",
        help="Which artworks to process (default: paintings ~4,879)"
    )
    group.add_argument("--where", metavar="SQL", help="Custom SQL predicate on artworks table (overrides --subset)")
    parser.add_argument("--limit", type=int, default=0, metavar="N", help="Stop after N artworks (0 = all)")
    parser.add_argument("--sleep", type=float, default=0.1, metavar="SEC", help="Seconds to sleep between artworks (default: 0.1)")
    parser.add_argument("--dry-run", action="store_true", help="Print subset count; do not fetch or write")
    parser.add_argument("--resume", action="store_true", help="Skip art_ids already in checkpoint table")
    args = parser.parse_args()

    db_path = Path(args.db)
    if not db_path.exists():
        print(f"ERROR: database not found: {db_path}", file=sys.stderr)
        print("Set --db or ensure data/vocabulary.db exists.", file=sys.stderr)
        sys.exit(1)

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row

    # Ensure the table + checkpoint table exist
    ensure_citations_table(conn)

    # Build subset query
    subset = args.subset if not args.where else "all"
    where_extra = args.where
    query = build_subset_query(subset, where_extra, args.limit)

    rows = conn.execute(query).fetchall()
    total = len(rows)

    effective_subset = args.subset if not args.where else f"--where '{args.where}'"
    print(f"Subset: {effective_subset} → {total:,} artworks")

    if args.dry_run:
        print("--dry-run: no fetches or writes.")
        print(f"  Query: {query}")
        conn.close()
        return

    # Filter already-processed art_ids when --resume
    if args.resume:
        done = {r[0] for r in conn.execute(f"SELECT art_id FROM {CHECKPOINT_TABLE}").fetchall()}
        rows = [r for r in rows if r["art_id"] not in done]
        print(f"  Resuming: {len(done):,} already done, {len(rows):,} remaining")

    # Run-scoped publication cache (dedup by publication_id)
    _pub_cache: dict[int, dict | None] = {}

    def resolve_pub(publication_id: int) -> dict | None:
        if publication_id in _pub_cache:
            return _pub_cache[publication_id]
        uri = f"https://id.rijksmuseum.nl/{publication_id}"
        pub = fetch_json(uri)
        _pub_cache[publication_id] = pub
        return pub

    processed = 0
    citation_total = 0
    t0 = time.time()
    PROGRESS_EVERY = 100

    for row in rows:
        art_id: int = row["art_id"]
        hmo_id: str = row["hmo_id"]
        object_uri = f"https://id.rijksmuseum.nl/{hmo_id}"

        data = fetch_json(object_uri)
        if data is None:
            processed += 1
            if args.sleep:
                time.sleep(args.sleep)
            continue

        raw_cits = extract_citations(data)
        composed = []
        for rc in raw_cits:
            pub = None
            if rc.get("publication_id") is not None:
                pub = resolve_pub(rc["publication_id"])
            composed.append(compose_citation(rc, pub))

        # Idempotent per artwork: delete existing rows then re-insert
        conn.execute("DELETE FROM artwork_citations WHERE art_id = ?", (art_id,))
        if composed:
            conn.executemany(
                "INSERT INTO artwork_citations "
                "(art_id, seq, citation_text, publication_id, pages, isbn, worldcat_uri, library_url) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                [
                    (art_id, r["seq"], r["citation_text"], r["publication_id"],
                     r["pages"], r["isbn"], r["worldcat_uri"], r["library_url"])
                    for r in composed
                ],
            )
        # Mark as processed in checkpoint table
        conn.execute(f"INSERT OR REPLACE INTO {CHECKPOINT_TABLE} (art_id) VALUES (?)", (art_id,))
        conn.commit()

        citation_total += len(composed)
        processed += 1

        if processed % PROGRESS_EVERY == 0 or processed == len(rows):
            elapsed = time.time() - t0
            rate = processed / elapsed if elapsed > 0 else 0
            remaining_est = (len(rows) - processed) / rate if rate > 0 else 0
            print(
                f"  {processed:,}/{len(rows):,} ({rate:.1f}/s, {citation_total:,} citations, "
                f"~{remaining_est / 60:.0f}min left, {len(_pub_cache):,} pubs cached)",
                flush=True,
            )

        if args.sleep:
            time.sleep(args.sleep)

    elapsed = time.time() - t0
    print(f"\nDone: {processed:,} artworks in {elapsed / 60:.1f}min, {citation_total:,} citations written.")
    conn.close()


if __name__ == "__main__":
    main()
