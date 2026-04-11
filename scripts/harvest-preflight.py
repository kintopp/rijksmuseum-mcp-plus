#!/usr/bin/env python3
"""
Pre-flight check for harvest-vocabulary-db.py.

Verifies that all runtime prerequisites are in place before starting a full
harvest run (Phase 0 → 0.5 → 1 → 2 → 4 → 2b → 3). Catches problems that
would otherwise surface hours into the pipeline.

Usage:
    python3 scripts/harvest-preflight.py                  # Check everything
    python3 scripts/harvest-preflight.py --skip-dump      # Skip dump checks
    python3 scripts/harvest-preflight.py --db path/to.db  # Check specific DB
"""

import argparse
import importlib.util
import os
import shutil
import sqlite3
import sys
import urllib.request
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
PROJECT_DIR = SCRIPT_DIR.parent
DEFAULT_DB_PATH = PROJECT_DIR / "data" / "vocabulary.db"
DUMPS_DIR = Path.home() / "Downloads" / "rijksmuseum-data-dumps"

OAI_BASE = "https://data.rijksmuseum.nl/oai"
# Phase 2 resolves vocab entities via data.rijksmuseum.nl/{entity_id}
LINKED_ART_VOCAB_PROBE = "https://data.rijksmuseum.nl/21029638"
# Phase 4 resolves artworks via id.rijksmuseum.nl/{id} (from OAI rdf:about URIs)
LINKED_ART_ARTWORK_PROBE = "https://id.rijksmuseum.nl/2001"

DUMP_NAMES = [
    "classification", "concept", "topical_term",
    "person", "organisation", "place", "event", "exhibition",
]

# Minimum free space to safely run full harvest + VACUUM (GB)
MIN_DISK_GB = 3.0

# ---------------------------------------------------------------------------


class Checker:
    def __init__(self):
        self.fails = 0
        self.warns = 0

    def ok(self, msg: str):
        print(f"  OK    {msg}")

    def fail(self, msg: str):
        print(f"  FAIL  {msg}")
        self.fails += 1

    def warn(self, msg: str):
        print(f"  WARN  {msg}")
        self.warns += 1

    @property
    def passed(self) -> bool:
        return self.fails == 0


def check_python(c: Checker):
    """Python version and stdlib sanity."""
    v = sys.version_info
    if v >= (3, 10):
        c.ok(f"Python {v.major}.{v.minor}.{v.micro}")
    else:
        c.fail(f"Python {v.major}.{v.minor} — need ≥3.10 (match syntax used in harvest)")


def check_sqlite_version(c: Checker):
    """SQLite ≥3.35.0 needed for ALTER TABLE DROP COLUMN in Phase 3."""
    ver = sqlite3.sqlite_version
    parts = tuple(int(x) for x in ver.split("."))
    if parts >= (3, 35, 0):
        c.ok(f"SQLite {ver} (DROP COLUMN supported)")
    else:
        c.fail(f"SQLite {ver} — need ≥3.35.0 for Phase 3 DROP COLUMN")


def check_compute_importance(c: Checker):
    """Phase 3 imports compute_importance at runtime via 'from compute_importance import ...'."""
    spec = importlib.util.find_spec("compute_importance", package=None)
    # The harvest script runs from scripts/, so compute_importance.py must be
    # findable from that working directory. Simulate by checking the file directly.
    target = SCRIPT_DIR / "compute_importance.py"
    if target.is_file():
        c.ok(f"compute_importance.py found at {target.relative_to(PROJECT_DIR)}")
    else:
        c.fail("scripts/compute_importance.py missing — Phase 3 will crash on 'from compute_importance import ...'")


def check_network(c: Checker):
    """Probe OAI-PMH and Linked Art endpoints."""
    # OAI-PMH: lightweight Identify verb
    oai_url = f"{OAI_BASE}?verb=Identify"
    try:
        req = urllib.request.Request(oai_url, headers={"User-Agent": "harvest-preflight/1.0"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            if resp.status == 200:
                c.ok(f"OAI-PMH reachable ({oai_url})")
            else:
                c.fail(f"OAI-PMH returned HTTP {resp.status}")
    except Exception as e:
        c.fail(f"OAI-PMH unreachable: {e}")

    # Linked Art endpoints (HEAD not supported — use GET and read minimally)
    for label, url in [
        ("Linked Art vocab (Phase 2)", LINKED_ART_VOCAB_PROBE),
        ("Linked Art artworks (Phase 4)", LINKED_ART_ARTWORK_PROBE),
    ]:
        try:
            req = urllib.request.Request(
                url,
                headers={
                    "User-Agent": "harvest-preflight/1.0",
                    "Accept": "application/ld+json",
                },
            )
            with urllib.request.urlopen(req, timeout=15) as resp:
                resp.read(256)  # read just enough to confirm it's serving data
                if resp.status == 200:
                    c.ok(f"{label} reachable ({url})")
                else:
                    c.fail(f"{label} returned HTTP {resp.status}")
        except Exception as e:
            c.fail(f"{label} unreachable: {e}")


def check_dumps(c: Checker):
    """Check data dump tarballs for Phase 0."""
    if not DUMPS_DIR.is_dir():
        c.fail(f"Dumps directory not found: {DUMPS_DIR}")
        c.warn("  Download from: https://data.rijksmuseum.nl/object-metadata/download/")
        return

    missing = []
    for name in DUMP_NAMES:
        tar_path = DUMPS_DIR / f"{name}.tar.gz"
        if not tar_path.exists():
            missing.append(f"{name}.tar.gz")

    found = len(DUMP_NAMES) - len(missing)
    if not missing:
        c.ok(f"All {found} dump tarballs present in {DUMPS_DIR}")
    else:
        c.fail(f"{len(missing)} dump tarball(s) missing: {', '.join(missing)}")


def check_db_state(c: Checker, db_path: Path):
    """Check existing DB for compatibility with a full harvest run."""
    if not db_path.exists():
        c.ok(f"No existing DB at {db_path} — fresh harvest will create it")
        return

    size_mb = db_path.stat().st_size / (1024 * 1024)

    try:
        conn = sqlite3.connect(str(db_path))
    except Exception as e:
        c.fail(f"Cannot open {db_path}: {e}")
        return

    try:
        # Check for the known stale-DB issue: post-Phase-3 DB missing tier2_done
        # causes idx_artworks_tier2 creation to fail in SCHEMA_SQL.
        tables = {row[0] for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()}

        if "artworks" in tables:
            cols = {row[1] for row in conn.execute("PRAGMA table_info(artworks)").fetchall()}
            if "tier2_done" not in cols:
                c.fail(
                    f"Existing DB ({size_mb:.0f} MB) is post-Phase-3 "
                    "(tier2_done column dropped) — SCHEMA_SQL will fail creating "
                    "idx_artworks_tier2. Delete the DB before a fresh harvest."
                )
            else:
                c.ok(f"Existing DB ({size_mb:.0f} MB) has tier2_done column — compatible")
        else:
            c.ok(f"Existing DB ({size_mb:.0f} MB) has no artworks table yet — compatible")
    finally:
        conn.close()


def check_disk_space(c: Checker, db_path: Path):
    """Check free disk space on the volume where the DB will be written."""
    target_dir = db_path.parent
    target_dir.mkdir(parents=True, exist_ok=True)
    usage = shutil.disk_usage(str(target_dir))
    free_gb = usage.free / (1024 ** 3)
    if free_gb >= MIN_DISK_GB:
        c.ok(f"{free_gb:.1f} GB free on {target_dir} (need ≥{MIN_DISK_GB:.0f} GB)")
    else:
        c.fail(f"Only {free_gb:.1f} GB free on {target_dir} — need ≥{MIN_DISK_GB:.0f} GB for harvest + VACUUM")


def check_data_dir_writable(c: Checker, db_path: Path):
    """Check that the data directory is writable."""
    target_dir = db_path.parent
    target_dir.mkdir(parents=True, exist_ok=True)
    test_file = target_dir / ".preflight-write-test"
    try:
        test_file.write_text("ok")
        test_file.unlink()
        c.ok(f"{target_dir} is writable")
    except OSError as e:
        c.fail(f"{target_dir} is not writable: {e}")


def check_geo_csv(c: Checker, geo_csv: str | None):
    """Check geo CSV if specified."""
    if geo_csv is None:
        # Check the default location as a courtesy
        default = PROJECT_DIR / "data" / "backfills" / "geocoded-places.csv"
        if default.exists():
            c.ok(f"Geocoded places CSV found at default location ({default.relative_to(PROJECT_DIR)})")
        else:
            c.warn("No --geo-csv specified and no file at data/backfills/geocoded-places.csv — Phase 3 will skip geocoding")
        return

    path = Path(geo_csv)
    if path.is_file():
        c.ok(f"Geo CSV found: {path}")
    else:
        c.fail(f"Geo CSV not found: {path}")


# ---------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(description="Pre-flight check for harvest-vocabulary-db.py")
    parser.add_argument("--skip-dump", action="store_true", help="Skip dump tarball checks")
    parser.add_argument("--db", type=str, default=None, help="Override DB path to check")
    parser.add_argument("--geo-csv", type=str, default=None, help="Geo CSV path to verify")
    args = parser.parse_args()

    db_path = Path(args.db) if args.db else DEFAULT_DB_PATH

    print("=== Harvest Pre-flight Check ===\n")

    c = Checker()

    print("[Python & SQLite]")
    check_python(c)
    check_sqlite_version(c)
    check_compute_importance(c)

    print("\n[Network]")
    check_network(c)

    if not args.skip_dump:
        print("\n[Data Dumps]")
        check_dumps(c)
    else:
        print("\n[Data Dumps]")
        c.ok("Skipped (--skip-dump)")

    print(f"\n[Database: {db_path}]")
    check_db_state(c, db_path)
    check_data_dir_writable(c, db_path)
    check_disk_space(c, db_path)

    print("\n[Optional Data]")
    check_geo_csv(c, args.geo_csv)

    # Summary
    print()
    if c.passed:
        label = "All checks passed"
        if c.warns > 0:
            label += f" ({c.warns} warning{'s' if c.warns != 1 else ''})"
        print(f"✓ {label} — ready to harvest.")
    else:
        print(f"✗ {c.fails} check(s) FAILED — fix before running harvest-vocabulary-db.py.")
        sys.exit(1)


if __name__ == "__main__":
    main()
