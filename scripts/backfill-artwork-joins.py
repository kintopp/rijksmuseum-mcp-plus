#!/usr/bin/env python3
"""
Backfill artwork_exhibitions, related_objects.related_art_id, and
artwork_parent.parent_art_id via the Linked Art API.

Phase 3 failed to resolve these joins because the URI suffix extraction
used '/objects/' which doesn't appear in id.rijksmuseum.nl URIs. This script
fetches each unique entity, extracts the object_number from identified_by,
and applies the resulting art_id mappings.

All three tables still have their *_la_uri / hmo_id columns intact; only
linked_art_uri was dropped from artworks by Phase 3, which is why these
joins could not be resolved during harvest.

Usage:
    python3 scripts/backfill-artwork-joins.py
    python3 scripts/backfill-artwork-joins.py --dry-run   # report counts, no writes
    python3 scripts/backfill-artwork-joins.py --threads 24

Estimated runtime: ~20 min at default thread count (92K unique API calls).
"""

import argparse
import json
import sqlite3
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

# ─── Configuration ───────────────────────────────────────────────────

SCRIPT_DIR = Path(__file__).parent
PROJECT_DIR = SCRIPT_DIR.parent
DB_PATH = PROJECT_DIR / "data" / "vocabulary.db"

LINKED_ART_BASE = "https://data.rijksmuseum.nl"
USER_AGENT = "rijksmuseum-mcp-harvest/1.0"
DEFAULT_THREADS = 12


# ─── API fetch ───────────────────────────────────────────────────────

def fetch_identifiers(numeric_id: str) -> list[str]:
    """Fetch a Linked Art entity and return all Identifier content values.

    Returns all entries with type=='Identifier' so the caller can try each
    against artworks.object_number (some artworks carry multiple identifiers).
    Returns an empty list on any HTTP or parse error.
    """
    url = f"{LINKED_ART_BASE}/{numeric_id}"
    req = urllib.request.Request(
        url,
        headers={"Accept": "application/ld+json", "User-Agent": USER_AGENT},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read())
    except Exception:
        return []

    return [
        entry["content"]
        for entry in data.get("identified_by", [])
        if entry.get("type") == "Identifier" and entry.get("content")
    ]


# ─── Main ────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="Report counts without writing")
    parser.add_argument("--threads", type=int, default=DEFAULT_THREADS)
    parser.add_argument("--db", type=str, default=str(DB_PATH))
    args = parser.parse_args()

    conn = sqlite3.connect(args.db)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")

    # ── 1. Collect unique numeric IDs across all three tables ─────────

    print("Collecting unique entity IDs...")

    # exhibition_members.hmo_id is already the numeric suffix
    exhibition_ids: set[str] = {
        row[0]
        for row in conn.execute("SELECT DISTINCT hmo_id FROM exhibition_members")
    }

    # related_objects / artwork_parent: extract suffix from URI
    related_ids: set[str] = {
        row[0].split("/")[-1]
        for row in conn.execute(
            "SELECT DISTINCT related_la_uri FROM related_objects WHERE related_art_id IS NULL"
        )
    }
    parent_ids: set[str] = {
        row[0].split("/")[-1]
        for row in conn.execute(
            "SELECT DISTINCT parent_la_uri FROM artwork_parent WHERE parent_art_id IS NULL"
        )
    }

    all_ids = exhibition_ids | related_ids | parent_ids
    print(f"  Exhibition hmo_ids:  {len(exhibition_ids):,}")
    print(f"  Related object IDs: {len(related_ids):,}")
    print(f"  Parent link IDs:    {len(parent_ids):,}")
    print(f"  Total unique:       {len(all_ids):,}")

    # ── 2. Build object_number → art_id index (in-memory) ────────────

    print("\nIndexing artworks.object_number → art_id...")
    obj_to_art_id: dict[str, int] = dict(
        conn.execute("SELECT object_number, art_id FROM artworks").fetchall()
    )
    print(f"  {len(obj_to_art_id):,} artworks indexed")

    # ── 3. Fetch all unique IDs via Linked Art API ────────────────────

    print(f"\nFetching {len(all_ids):,} entities ({args.threads} threads)...")
    id_to_identifiers: dict[str, list[str]] = {}
    failed = 0
    t0 = time.time()

    with ThreadPoolExecutor(max_workers=args.threads) as pool:
        futures = {pool.submit(fetch_identifiers, eid): eid for eid in all_ids}
        for i, future in enumerate(as_completed(futures), 1):
            eid = futures[future]
            result = future.result()
            if result:
                id_to_identifiers[eid] = result
            else:
                failed += 1

            if i % 2000 == 0:
                elapsed = time.time() - t0
                rate = i / elapsed
                remaining = (len(all_ids) - i) / rate
                print(
                    f"  {i:,}/{len(all_ids):,}  ({len(id_to_identifiers):,} ok, "
                    f"{failed:,} failed, {rate:.0f}/s, ~{remaining:.0f}s left)",
                    flush=True,
                )

    elapsed = time.time() - t0
    print(f"  Done: {len(id_to_identifiers):,} resolved, {failed:,} failed in {elapsed:.0f}s")

    # ── 4. Map numeric_id → art_id via object_number ─────────────────

    id_to_art_id: dict[str, int] = {}
    unmatched = 0
    for numeric_id, identifiers in id_to_identifiers.items():
        for obj_num in identifiers:
            art_id = obj_to_art_id.get(obj_num)
            if art_id is not None:
                id_to_art_id[numeric_id] = art_id
                break
        else:
            unmatched += 1

    print(f"\n  {len(id_to_art_id):,} IDs mapped to art_id  ({unmatched:,} with no matching object_number)")

    if args.dry_run:
        # Report what would be written
        exh_rows = [
            (id_to_art_id[hmo_id], exh_id)
            for exh_id, hmo_id in conn.execute("SELECT exhibition_id, hmo_id FROM exhibition_members")
            if hmo_id in id_to_art_id
        ]
        rel_rows = [
            (art_id, uri.split("/")[-1])
            for uri, in conn.execute("SELECT DISTINCT related_la_uri FROM related_objects WHERE related_art_id IS NULL")
            if (art_id := id_to_art_id.get(uri.split("/")[-1])) is not None
        ]
        par_rows = [
            (art_id, uri.split("/")[-1])
            for uri, in conn.execute("SELECT DISTINCT parent_la_uri FROM artwork_parent WHERE parent_art_id IS NULL")
            if (art_id := id_to_art_id.get(uri.split("/")[-1])) is not None
        ]
        print("\n[dry-run] Would write:")
        print(f"  artwork_exhibitions:      {len(exh_rows):,} rows")
        print(f"  related_objects resolved: {len(rel_rows):,} unique URIs")
        print(f"  artwork_parent resolved:  {len(par_rows):,} unique URIs")
        conn.close()
        return

    # ── 5. Populate artwork_exhibitions ──────────────────────────────

    print("\n--- artwork_exhibitions ---")
    rows = conn.execute("SELECT exhibition_id, hmo_id FROM exhibition_members").fetchall()
    to_insert = [
        (id_to_art_id[hmo_id], exh_id)
        for exh_id, hmo_id in rows
        if hmo_id in id_to_art_id
    ]
    conn.executemany(
        "INSERT OR IGNORE INTO artwork_exhibitions (art_id, exhibition_id) VALUES (?, ?)",
        to_insert,
    )
    conn.commit()
    total = conn.execute("SELECT COUNT(*) FROM artwork_exhibitions").fetchone()[0]
    unresolved = len(rows) - len(to_insert)
    print(f"  Inserted {len(to_insert):,} rows  ({total:,} total, {unresolved:,} unresolved)")

    # ── 6. Update related_objects.related_art_id ─────────────────────

    print("\n--- related_objects ---")
    to_update = [
        (id_to_art_id[uri.split("/")[-1]], uri)
        for uri, in conn.execute(
            "SELECT DISTINCT related_la_uri FROM related_objects WHERE related_art_id IS NULL"
        )
        if uri.split("/")[-1] in id_to_art_id
    ]
    conn.executemany(
        "UPDATE related_objects SET related_art_id = ? WHERE related_la_uri = ?",
        to_update,
    )
    conn.commit()
    resolved = conn.execute(
        "SELECT COUNT(*) FROM related_objects WHERE related_art_id IS NOT NULL"
    ).fetchone()[0]
    total = conn.execute("SELECT COUNT(*) FROM related_objects").fetchone()[0]
    print(f"  Resolved {len(to_update):,} unique URIs  ({resolved:,}/{total:,} rows now have art_id)")

    # ── 7. Update artwork_parent.parent_art_id ───────────────────────

    print("\n--- artwork_parent ---")
    to_update = [
        (id_to_art_id[uri.split("/")[-1]], uri)
        for uri, in conn.execute(
            "SELECT DISTINCT parent_la_uri FROM artwork_parent WHERE parent_art_id IS NULL"
        )
        if uri.split("/")[-1] in id_to_art_id
    ]
    conn.executemany(
        "UPDATE artwork_parent SET parent_art_id = ? WHERE parent_la_uri = ?",
        to_update,
    )
    conn.commit()
    resolved = conn.execute(
        "SELECT COUNT(*) FROM artwork_parent WHERE parent_art_id IS NOT NULL"
    ).fetchone()[0]
    total = conn.execute("SELECT COUNT(*) FROM artwork_parent").fetchone()[0]
    print(f"  Resolved {len(to_update):,} unique URIs  ({resolved:,}/{total:,} rows now have art_id)")

    conn.close()
    print("\nDone.")


if __name__ == "__main__":
    main()
