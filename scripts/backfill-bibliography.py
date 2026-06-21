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

Dependencies: requests (HTTP keep-alive). Shared extraction logic: scripts/lib/bibliography_extract.py.

Example with concurrency:
    python3 scripts/backfill-bibliography.py --subset provenance --threads 8
    python3 scripts/backfill-bibliography.py --subset paintings --threads 4 --dry-run --limit 5
"""

import argparse
import sqlite3
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import requests

SCRIPT_DIR = Path(__file__).parent
PROJECT_DIR = SCRIPT_DIR.parent

# Make scripts/lib importable
sys.path.insert(0, str(SCRIPT_DIR))
from lib.bibliography_extract import (  # noqa: E402
    extract_citations, compose_citation, CITATION_INSERT_SQL, citation_rows,
)

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


class PermanentFetchError(Exception):
    """Raised for HTTP 404/410 — the resource is gone upstream (e.g. a
    deaccessioned object). Callers should give up on it rather than retry."""


def fetch_json(session: requests.Session, uri: str, timeout: int = 15) -> dict | None:
    """GET a URI with Accept: application/ld+json over a pooled keep-alive
    session (follows the 303 redirect by default). Returns the parsed JSON dict,
    or None on a *transient* failure (timeout, connection error, 5xx, bad JSON).
    Raises PermanentFetchError on HTTP 404/410 ("gone for good")."""
    try:
        resp = session.get(
            uri,
            headers={"Accept": "application/ld+json", "User-Agent": USER_AGENT},
            timeout=timeout,
        )
    except requests.RequestException:
        return None
    if resp.status_code in (404, 410):
        raise PermanentFetchError(f"HTTP {resp.status_code} {uri}")
    if not resp.ok:
        return None
    try:
        return resp.json()
    except ValueError:
        return None


def make_session(pool_size: int) -> requests.Session:
    """A keep-alive session whose connection pool is sized to the worker count,
    so pooled connections are reused across concurrent fetches."""
    s = requests.Session()
    adapter = requests.adapters.HTTPAdapter(
        pool_connections=pool_size, pool_maxsize=pool_size, max_retries=0,
    )
    s.mount("https://", adapter)
    s.mount("http://", adapter)
    return s


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
    parser.add_argument("--threads", type=int, default=8, metavar="N",
                        help="Concurrent fetch workers (default: 8; 1 = sequential). Keep modest (<=12) to be polite to the API.")
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

    session = make_session(args.threads)

    # Run-scoped publication cache shared across workers (dedup by publication_id)
    _pub_cache: dict[int, dict | None] = {}
    _pub_lock = threading.Lock()

    def resolve_pub(publication_id: int) -> dict | None:
        with _pub_lock:
            if publication_id in _pub_cache:
                return _pub_cache[publication_id]
        uri = f"https://id.rijksmuseum.nl/{publication_id}"
        try:
            pub = fetch_json(session, uri)  # fetch OUTSIDE the lock
        except PermanentFetchError:
            # Publication gone upstream — compose_citation falls back to a
            # "(publication NNN)" stub, so the citation row is still written.
            pub = None
        with _pub_lock:
            _pub_cache[publication_id] = pub
        return pub

    def process_artwork(art_id: int, hmo_id: str) -> dict:
        """Worker: all HTTP for one artwork. Returns a result; does NO DB I/O."""
        object_uri = f"https://id.rijksmuseum.nl/{hmo_id}"
        try:
            data = fetch_json(session, object_uri)
        except PermanentFetchError:
            return {"art_id": art_id, "status": "gone", "rows": []}
        if data is None:
            return {"art_id": art_id, "status": "transient", "rows": []}
        composed = []
        for rc in extract_citations(data):
            pub = resolve_pub(rc["publication_id"]) if rc.get("publication_id") is not None else None
            composed.append(compose_citation(rc, pub))
        if args.sleep:
            time.sleep(args.sleep)  # per-worker politeness delay
        return {"art_id": art_id, "status": "ok", "rows": composed}

    processed = 0
    citation_total = 0
    gone = 0
    t0 = time.time()
    PROGRESS_EVERY = 100
    total_to_do = len(rows)

    with ThreadPoolExecutor(max_workers=args.threads) as pool:
        futures = [pool.submit(process_artwork, r["art_id"], r["hmo_id"]) for r in rows]
        for fut in as_completed(futures):
            result = fut.result()
            art_id = result["art_id"]
            status = result["status"]
            if status == "gone":
                conn.execute(f"INSERT OR REPLACE INTO {CHECKPOINT_TABLE} (art_id) VALUES (?)", (art_id,))
                conn.commit()
                gone += 1
            elif status == "transient":
                pass  # no checkpoint → retried on a later --resume
            else:  # ok
                rows_out = result["rows"]
                # Idempotent per artwork: delete existing rows then re-insert
                conn.execute("DELETE FROM artwork_citations WHERE art_id = ?", (art_id,))
                if rows_out:
                    conn.executemany(CITATION_INSERT_SQL, citation_rows(art_id, rows_out))
                conn.execute(f"INSERT OR REPLACE INTO {CHECKPOINT_TABLE} (art_id) VALUES (?)", (art_id,))
                conn.commit()
                citation_total += len(rows_out)
            processed += 1
            if processed % PROGRESS_EVERY == 0 or processed == total_to_do:
                elapsed = time.time() - t0
                rate = processed / elapsed if elapsed > 0 else 0
                remaining_est = (total_to_do - processed) / rate if rate > 0 else 0
                with _pub_lock:
                    pubs_cached = len(_pub_cache)
                print(
                    f"  {processed:,}/{total_to_do:,} ({rate:.1f}/s, {citation_total:,} citations, "
                    f"~{remaining_est / 60:.0f}min left, {pubs_cached:,} pubs cached, {args.threads} threads)",
                    flush=True,
                )

    elapsed = time.time() - t0
    print(f"\nDone: {processed:,} artworks in {elapsed / 60:.1f}min, "
          f"{citation_total:,} citations written, {gone:,} skipped (gone upstream, checkpointed).")
    conn.close()


if __name__ == "__main__":
    main()
