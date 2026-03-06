#!/usr/bin/env python3
"""Backfill missing dates for artworks in the vocabulary DB.

Phase 3 drops `linked_art_uri` and `tier2_done`, so Phase 4 cannot be re-run.
This standalone script:
  1. Finds artworks with NULL date_earliest
  2. Uses the Search API to look up each artwork's Linked Art URI
  3. Resolves the URI and extracts timespan (list-aware)
  4. UPDATEs date_earliest and date_latest only
"""

import json
import sqlite3
import sys
import time
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "vocabulary.db"
SEARCH_URL = "https://data.rijksmuseum.nl/search/collection"
USER_AGENT = "rijksmuseum-mcp-plus/backfill-dates (github.com/kintopp/rijksmuseum-mcp-plus)"
THREADS = 8
BATCH_SIZE = 200  # commit every N updates


def search_uri(object_number: str) -> str | None:
    """Look up Linked Art URI via Search API."""
    url = f"{SEARCH_URL}?objectNumber={urllib.parse.quote(object_number, safe='')}"
    req = urllib.request.Request(url, headers={
        "Accept": "application/ld+json",
        "User-Agent": USER_AGENT,
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read())
        items = data.get("orderedItems", [])
        return items[0]["id"] if items else None
    except Exception:
        return None


def resolve_dates(uri: str) -> tuple[int | None, int | None]:
    """Resolve Linked Art object and extract date_earliest/date_latest."""
    req = urllib.request.Request(uri, headers={
        "Accept": "application/ld+json",
        "Profile": "https://linked.art/ns/v1/linked-art.json",
        "User-Agent": USER_AGENT,
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())
    except Exception:
        return None, None

    produced_by = data.get("produced_by", {})
    timespan = produced_by.get("timespan", {}) if isinstance(produced_by, dict) else {}

    # Normalize list timespan — take widest date range across all phases
    if isinstance(timespan, list) and timespan:
        all_begins = [t.get("begin_of_the_begin", "") for t in timespan if isinstance(t, dict)]
        all_ends = [t.get("end_of_the_end", "") for t in timespan if isinstance(t, dict)]
        timespan = {
            "begin_of_the_begin": min((b for b in all_begins if b), default=""),
            "end_of_the_end": max((e for e in all_ends if e), default=""),
        }

    if not isinstance(timespan, dict):
        return None, None

    date_earliest = None
    date_latest = None
    for key, target in [("begin_of_the_begin", "earliest"), ("end_of_the_end", "latest")]:
        val = timespan.get(key, "")
        if val and isinstance(val, str) and len(val) >= 4:
            try:
                year_str = val[:5] if val.startswith("-") else val[:4]
                year = int(year_str)
                if target == "earliest":
                    date_earliest = year
                else:
                    date_latest = year
            except (ValueError, IndexError):
                pass

    # If only one is present, use it for both
    if date_earliest is not None and date_latest is None:
        date_latest = date_earliest
    elif date_latest is not None and date_earliest is None:
        date_earliest = date_latest

    return date_earliest, date_latest


def fetch_dates(object_number: str) -> tuple[str, int | None, int | None]:
    """Search for URI then resolve dates. Returns (object_number, earliest, latest)."""
    uri = search_uri(object_number)
    if not uri:
        return object_number, None, None
    earliest, latest = resolve_dates(uri)
    return object_number, earliest, latest


def main():
    import urllib.parse

    dry_run = "--dry-run" in sys.argv

    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("PRAGMA journal_mode=WAL")

    # Find artworks with missing dates
    rows = conn.execute(
        "SELECT object_number FROM artworks WHERE date_earliest IS NULL"
    ).fetchall()

    total = len(rows)
    if total == 0:
        print("No artworks with missing dates.")
        return

    print(f"Found {total:,} artworks with missing dates.")
    if dry_run:
        print("(dry run — no updates will be written)")

    object_numbers = [r[0] for r in rows]

    updated = 0
    not_found = 0
    no_dates = 0
    errors = 0
    t0 = time.time()

    with ThreadPoolExecutor(max_workers=THREADS) as pool:
        futures = {pool.submit(fetch_dates, on): on for on in object_numbers}
        batch = []

        for i, future in enumerate(as_completed(futures), 1):
            on = futures[future]
            try:
                obj_num, earliest, latest = future.result()
            except Exception as e:
                errors += 1
                if i % 500 == 0:
                    print(f"  [{i:,}/{total:,}] Error for {on}: {e}", flush=True)
                continue

            if earliest is not None:
                batch.append((earliest, latest, obj_num))
                updated += 1
            else:
                # Distinguish "URI not found" from "no dates in Linked Art"
                no_dates += 1

            # Commit in batches
            if len(batch) >= BATCH_SIZE and not dry_run:
                conn.executemany(
                    "UPDATE artworks SET date_earliest = ?, date_latest = ? WHERE object_number = ?",
                    batch,
                )
                conn.commit()
                batch.clear()

            if i % 500 == 0:
                elapsed = time.time() - t0
                rate = i / elapsed
                eta = (total - i) / rate if rate > 0 else 0
                print(
                    f"  [{i:,}/{total:,}] updated={updated:,} no_dates={no_dates:,} "
                    f"rate={rate:.1f}/s ETA={eta/60:.1f}m",
                    flush=True,
                )

        # Final batch
        if batch and not dry_run:
            conn.executemany(
                "UPDATE artworks SET date_earliest = ?, date_latest = ? WHERE object_number = ?",
                batch,
            )
            conn.commit()

    elapsed = time.time() - t0
    remaining = conn.execute(
        "SELECT COUNT(*) FROM artworks WHERE date_earliest IS NULL"
    ).fetchone()[0]
    conn.close()

    print(f"\nDone in {elapsed:.0f}s.")
    print(f"  Updated: {updated:,}")
    print(f"  No dates found: {no_dates:,}")
    print(f"  Errors: {errors:,}")
    print(f"  Remaining NULL dates: {remaining:,}")


if __name__ == "__main__":
    main()
