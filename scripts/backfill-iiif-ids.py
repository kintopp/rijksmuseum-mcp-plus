#!/usr/bin/env python3
"""
Backfill IIIF identifiers into an existing vocabulary database.

Iterates all OAI-PMH records, extracts the IIIF UUID from edm:isShownBy or
edm:object URLs, and stores it in the artworks.iiif_id column. Adds the column
if it doesn't already exist.

No extra HTTP requests beyond the OAI-PMH pages — the UUID is embedded in the
image URL that's already present in the EDM metadata.

Usage:
    python3 scripts/backfill-iiif-ids.py              # Full run
    python3 scripts/backfill-iiif-ids.py --resume      # Resume from checkpoint
    python3 scripts/backfill-iiif-ids.py --dry-run     # Count without writing

Output: Updates data/vocabulary.db in-place (adds iiif_id column to artworks)
"""

import argparse
import json
import re
import sqlite3
import time
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

# ─── Configuration ───────────────────────────────────────────────────

SCRIPT_DIR = Path(__file__).parent
PROJECT_DIR = SCRIPT_DIR.parent
DB_PATH = PROJECT_DIR / "data" / "vocabulary.db"
CHECKPOINT_PATH = SCRIPT_DIR / ".backfill-iiif-checkpoint"

OAI_BASE = "https://data.rijksmuseum.nl/oai"
USER_AGENT = "rijksmuseum-mcp-backfill-iiif/1.0"
BATCH_SIZE = 500  # Commit every N pages

# RDF/XML attribute keys
RDF_RESOURCE = "{http://www.w3.org/1999/02/22-rdf-syntax-ns#}resource"
RDF_ABOUT = "{http://www.w3.org/1999/02/22-rdf-syntax-ns#}about"

# Extract UUID from IIIF URL: https://iiif.micr.io/{UUID}/full/max/0/default.jpg
IIIF_ID_RE = re.compile(r"https?://iiif\.micr\.io/([^/]+)")

NS = {
    "oai": "http://www.openarchives.org/OAI/2.0/",
    "dc": "http://purl.org/dc/elements/1.1/",
    "edm": "http://www.europeana.eu/schemas/edm/",
    "ore": "http://www.openarchives.org/ore/terms/",
}


def get_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}


def fetch_oai_page(url: str) -> ET.Element:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return ET.parse(resp).getroot()


def extract_iiif_ids(root: ET.Element) -> list[tuple[str, str]]:
    """Extract (object_number, iiif_id) pairs from an OAI-PMH page."""
    results = []

    for record in root.findall(".//oai:record", NS):
        header = record.find("oai:header", NS)
        if header is None or header.get("status") == "deleted":
            continue

        metadata = record.find("oai:metadata", NS)
        if metadata is None:
            continue

        # Extract object number from dc:identifier
        cho = metadata.find(".//{http://www.europeana.eu/schemas/edm/}ProvidedCHO")
        if cho is None:
            continue
        ident = cho.find("{http://purl.org/dc/elements/1.1/}identifier")
        if ident is None or not ident.text:
            continue
        object_number = ident.text.strip()

        # Find IIIF URL in isShownBy or edm:object on ore:Aggregation
        agg = metadata.find(".//{http://www.openarchives.org/ore/terms/}Aggregation")
        if agg is None:
            continue

        is_shown = agg.find("{http://www.europeana.eu/schemas/edm/}isShownBy")
        edm_obj = agg.find("{http://www.europeana.eu/schemas/edm/}object")

        iiif_url = ""
        if is_shown is not None:
            iiif_url = is_shown.get(RDF_RESOURCE, "")
            if not iiif_url:
                child = next(iter(is_shown), None)
                if child is not None:
                    iiif_url = child.get(RDF_ABOUT, "")
        elif edm_obj is not None:
            iiif_url = edm_obj.get(RDF_RESOURCE, "")
            if not iiif_url:
                child = next(iter(edm_obj), None)
                if child is not None:
                    iiif_url = child.get(RDF_ABOUT, "")

        if iiif_url:
            m = IIIF_ID_RE.match(iiif_url)
            if m:
                results.append((object_number, m.group(1)))

    return results


def save_checkpoint(token: str, page: int):
    with open(CHECKPOINT_PATH, "w") as f:
        json.dump({"resumption_token": token, "page": page}, f)


def load_checkpoint() -> tuple[str, int] | None:
    if not CHECKPOINT_PATH.exists():
        return None
    try:
        with open(CHECKPOINT_PATH) as f:
            data = json.load(f)
        return data["resumption_token"], data["page"]
    except Exception:
        return None


def main():
    parser = argparse.ArgumentParser(description="Backfill IIIF IDs into vocabulary DB")
    parser.add_argument("--db", type=str, default=str(DB_PATH), help="Path to vocabulary DB")
    parser.add_argument("--resume", action="store_true", help="Resume from checkpoint")
    parser.add_argument("--dry-run", action="store_true", help="Count without writing")
    args = parser.parse_args()

    db_path = Path(args.db)
    if not db_path.exists():
        print(f"Error: DB not found at {db_path}")
        return

    conn = sqlite3.connect(str(db_path))
    conn.execute("PRAGMA journal_mode=WAL")

    # Ensure iiif_id column exists
    cols = get_columns(conn, "artworks")
    if "iiif_id" not in cols:
        if args.dry_run:
            print("Would add iiif_id column to artworks table")
        else:
            conn.execute("ALTER TABLE artworks ADD COLUMN iiif_id TEXT")
            conn.commit()
            print("Added iiif_id column to artworks table")
    else:
        existing = conn.execute("SELECT COUNT(*) FROM artworks WHERE iiif_id IS NOT NULL").fetchone()[0]
        total = conn.execute("SELECT COUNT(*) FROM artworks").fetchone()[0]
        print(f"iiif_id column already exists: {existing:,}/{total:,} artworks already have values")

    # Resume or start fresh
    if args.resume:
        cp = load_checkpoint()
        if cp:
            token, start_page = cp
            url = f"{OAI_BASE}?verb=ListRecords&resumptionToken={token}"
            print(f"Resuming from page {start_page + 1}")
        else:
            print("No checkpoint found, starting from scratch")
            url = f"{OAI_BASE}?verb=ListRecords&metadataPrefix=edm"
            start_page = 0
    else:
        url = f"{OAI_BASE}?verb=ListRecords&metadataPrefix=edm"
        start_page = 0

    page = start_page
    total_found = 0
    total_updated = 0
    t0 = time.time()

    print(f"\nScanning OAI-PMH records for IIIF IDs...")

    while url:
        page += 1
        try:
            root = fetch_oai_page(url)
        except Exception as e:
            print(f"  Error on page {page}: {e}")
            print("  Use --resume to continue")
            break

        pairs = extract_iiif_ids(root)
        total_found += len(pairs)

        if not args.dry_run and pairs:
            # UPDATE only NULLs — never overwrite existing values
            conn.executemany(
                "UPDATE artworks SET iiif_id = ? WHERE object_number = ? AND iiif_id IS NULL",
                [(iiif_id, obj_num) for obj_num, iiif_id in pairs],
            )
            total_updated += conn.total_changes  # approximation (cumulative)

        # Check for resumption token
        token_el = root.find(".//oai:resumptionToken", NS)
        if token_el is not None and token_el.text:
            token = token_el.text
            url = f"{OAI_BASE}?verb=ListRecords&resumptionToken={token}"
            save_checkpoint(token, page)
        else:
            url = None

        if page % 10 == 0:
            elapsed = time.time() - t0
            rate = (page - start_page) / elapsed * 60 if elapsed > 0 else 0
            print(f"  Page {page}: {total_found:,} IIIF IDs found ({rate:.0f} pages/min)")

        if page % BATCH_SIZE == 0 and not args.dry_run:
            conn.commit()

    if not args.dry_run:
        conn.commit()

    elapsed = time.time() - t0

    # Final stats
    if not args.dry_run:
        final_count = conn.execute("SELECT COUNT(*) FROM artworks WHERE iiif_id IS NOT NULL").fetchone()[0]
        total_artworks = conn.execute("SELECT COUNT(*) FROM artworks").fetchone()[0]
        pct = (final_count / total_artworks * 100) if total_artworks > 0 else 0
        print(f"\nDone in {elapsed:.0f}s ({page} pages)")
        print(f"  IIIF IDs found in OAI-PMH: {total_found:,}")
        print(f"  Artworks with iiif_id:     {final_count:,}/{total_artworks:,} ({pct:.1f}%)")
    else:
        print(f"\nDry run complete in {elapsed:.0f}s ({page} pages)")
        print(f"  IIIF IDs found: {total_found:,}")

    # Clean up checkpoint
    if CHECKPOINT_PATH.exists() and url is None:
        CHECKPOINT_PATH.unlink()

    conn.close()


if __name__ == "__main__":
    main()
