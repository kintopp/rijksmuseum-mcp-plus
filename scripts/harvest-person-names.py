#!/usr/bin/env python3
"""Harvest all person name variants from Linked Art into person_names table + FTS5 index.

Queries person IDs from the vocabulary table, fetches each person's Linked Art entity,
and extracts all identified_by name variants with language + AAT classification.

Usage:
    python3 scripts/harvest-person-names.py                    # Default: data/vocabulary.db
    python3 scripts/harvest-person-names.py --db path/to.db    # Custom DB path
    python3 scripts/harvest-person-names.py --resume           # Skip persons already harvested
"""

import argparse
import json
import sqlite3
import time
import urllib.request
from pathlib import Path

# ─── Constants ────────────────────────────────────────────────────────

SCRIPT_DIR = Path(__file__).parent
PROJECT_DIR = SCRIPT_DIR.parent
DB_PATH = PROJECT_DIR / "data" / "vocabulary.db"

LINKED_ART_BASE = "https://data.rijksmuseum.nl"
USER_AGENT = "rijksmuseum-mcp-harvest/1.0"
BATCH_SIZE = 500

LANG_EN = "http://vocab.getty.edu/aat/300388277"
LANG_NL = "http://vocab.getty.edu/aat/300388256"

# AAT name classification URIs → short labels
AAT_CLASSIFICATION = {
    "300404670": "display",
    "300404671": "preferred",
    "300404672": "inverted",
}

# ─── Schema ───────────────────────────────────────────────────────────

PERSON_NAMES_SCHEMA = """
CREATE TABLE IF NOT EXISTS person_names (
    person_id       TEXT NOT NULL REFERENCES vocabulary(id),
    name            TEXT NOT NULL,
    lang            TEXT,
    classification  TEXT,
    UNIQUE(person_id, name, lang)
);
CREATE INDEX IF NOT EXISTS idx_person_names_id ON person_names(person_id);
"""


def fetch_person_names(person_id: str) -> list[dict] | None:
    """Fetch a person's Linked Art entity and extract all name variants."""
    url = f"{LINKED_ART_BASE}/{person_id}"
    req = urllib.request.Request(url, headers={
        "Accept": "application/ld+json",
        "Profile": "https://linked.art/ns/v1/linked-art.json",
        "User-Agent": USER_AGENT,
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read())
    except Exception:
        return None

    seen = set()  # deduplicate (name, lang) pairs
    variants = []

    for entry in data.get("identified_by", []):
        # Only harvest Name entries, not Identifier entries (ULAN IDs, registry numbers)
        if entry.get("type") != "Name":
            continue
        content = entry.get("content", "")
        if not content or not isinstance(content, str):
            continue

        # Determine language
        lang = None
        for l in entry.get("language", []):
            lid = l.get("id", "")
            if lid == LANG_EN:
                lang = "en"
                break
            elif lid == LANG_NL:
                lang = "nl"
                break

        # Determine classification from classified_as AAT URIs
        classification = None
        for c in entry.get("classified_as", []):
            cid = c.get("id", "")
            for suffix, label in AAT_CLASSIFICATION.items():
                if cid.endswith(suffix):
                    classification = label
                    break
            if classification:
                break

        key = (content, lang)
        if key not in seen:
            seen.add(key)
            variants.append({
                "person_id": person_id,
                "name": content,
                "lang": lang,
                "classification": classification,
            })

    return variants


def main():
    parser = argparse.ArgumentParser(description="Harvest person name variants into vocabulary DB")
    parser.add_argument("--db", type=str, default=str(DB_PATH), help="Path to vocabulary.db")
    parser.add_argument("--resume", action="store_true", help="Skip persons already in person_names")
    args = parser.parse_args()

    conn = sqlite3.connect(args.db)
    conn.execute("PRAGMA journal_mode=WAL")

    # Create schema
    conn.executescript(PERSON_NAMES_SCHEMA)
    conn.commit()

    # Get person IDs from vocabulary
    all_persons = [r[0] for r in conn.execute(
        "SELECT id FROM vocabulary WHERE type = 'person'"
    ).fetchall()]
    print(f"Total persons in vocabulary: {len(all_persons):,}")

    # Optionally skip already-harvested persons
    if args.resume:
        done = {r[0] for r in conn.execute(
            "SELECT DISTINCT person_id FROM person_names"
        ).fetchall()}
        persons = [p for p in all_persons if p not in done]
        print(f"Resuming: {len(done):,} already done, {len(persons):,} remaining")
    else:
        # Fresh run — clear existing data
        conn.execute("DELETE FROM person_names")
        conn.commit()
        persons = all_persons

    if not persons:
        print("Nothing to do.")
        return

    t0 = time.time()
    fetched = 0
    failed = 0
    total_names = 0
    batch = []

    for i, person_id in enumerate(persons, 1):
        variants = fetch_person_names(person_id)
        if variants is not None:
            batch.extend(variants)
            total_names += len(variants)
            fetched += 1
        else:
            failed += 1

        if i % BATCH_SIZE == 0:
            if batch:
                conn.executemany(
                    "INSERT INTO person_names (person_id, name, lang, classification) "
                    "VALUES (:person_id, :name, :lang, :classification)",
                    batch,
                )
                conn.commit()
                batch = []

        if i % 1000 == 0:
            elapsed = time.time() - t0
            rate = i / elapsed
            remaining = (len(persons) - i) / rate
            print(
                f"  {i:,}/{len(persons):,} ({fetched:,} ok, {failed:,} failed, "
                f"{total_names:,} names, {rate:.0f}/s, ~{remaining:.0f}s left)",
                flush=True,
            )

    # Flush remaining batch
    if batch:
        conn.executemany(
            "INSERT INTO person_names (person_id, name, lang, classification) "
            "VALUES (:person_id, :name, :lang, :classification)",
            batch,
        )
        conn.commit()

    elapsed = time.time() - t0
    print(f"\nHarvest complete: {fetched:,} persons, {failed:,} failed, {total_names:,} names, {elapsed:.0f}s")

    # Build FTS5 index
    print("Building person_names_fts index...")
    conn.execute("DROP TABLE IF EXISTS person_names_fts")
    conn.execute("""
        CREATE VIRTUAL TABLE person_names_fts USING fts5(
            name,
            content='person_names', content_rowid='rowid',
            tokenize='unicode61 remove_diacritics 2'
        )
    """)
    conn.execute("INSERT INTO person_names_fts(person_names_fts) VALUES('rebuild')")
    fts_count = conn.execute("SELECT COUNT(*) FROM person_names_fts").fetchone()[0]
    print(f"  person_names_fts: {fts_count:,} rows")
    conn.commit()

    # Final stats
    distinct_persons = conn.execute("SELECT COUNT(DISTINCT person_id) FROM person_names").fetchone()[0]
    total_rows = conn.execute("SELECT COUNT(*) FROM person_names").fetchone()[0]
    avg_names = total_rows / distinct_persons if distinct_persons else 0
    print(f"\nFinal: {total_rows:,} name rows for {distinct_persons:,} persons ({avg_names:.1f} names/person avg)")

    conn.close()


if __name__ == "__main__":
    main()
