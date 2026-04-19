#!/usr/bin/env python3
"""Preflight checks for the v0.24 clean re-geocode run.

Run this on any machine before invoking ``scripts/run_clean_regeo.py``.
It verifies every precondition the orchestrator's 8 steps depend on:

  - Python interpreter + stdlib modules + optional packages
  - Environment variables (WHG_TOKEN, GEONAMES_USERNAME)
  - Repository files (all committed TSVs + helper scripts present)
  - Vocabulary DB schema (tables + required columns)
  - Writable output directories + free disk space
  - Network reachability to each authority (GeoNames, Wikidata, Getty, WHG)
  - Live API credential checks (WHG bearer-token, GeoNames free-tier credits)

Exits 0 if all required checks pass, 1 otherwise. Warnings never cause
a non-zero exit — they flag things to watch but don't block the run.

Usage:
    python3 scripts/preflight_regeo.py
    python3 scripts/preflight_regeo.py --db /custom/vocabulary.db
    python3 scripts/preflight_regeo.py --skip-network --skip-live-api
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import sqlite3
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


def _load_dotenv() -> bool:
    """Fold project-root ``.env`` into ``os.environ`` — same shape as geocode_places.py.

    Returns True if a .env was found, False otherwise. The preflight reports
    which case so the user knows where env vars will be sourced from during
    the actual run.
    """
    env_file = REPO_ROOT / ".env"
    if not env_file.exists():
        return False
    for raw in env_file.read_text().splitlines():
        s = raw.strip()
        if s and not s.startswith("#") and "=" in s:
            key, _, value = s.partition("=")
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))
    return True


_DOTENV_LOADED = _load_dotenv()

REQUIRED_PYTHON = (3, 10)
DEFAULT_REGEO_PYTHON = str(Path.home() / "miniconda3" / "envs" / "embeddings" / "bin" / "python")

REQUIRED_COMMITTED_FILES = [
    "scripts/enrichment_methods.py",
    "scripts/placetype_map.py",
    "scripts/country_qid_to_iso2.tsv",
    "scripts/areal_overrides.tsv",
    "scripts/lib/geo_math.py",
    "scripts/lib/harvest_audit.py",
    "scripts/harvest-placetypes.py",
    "scripts/apply_areal_overrides.py",
    "scripts/batch_geocode.py",
    "scripts/geocode_places.py",
    "scripts/post_run_diagnostics.py",
    "scripts/export_backfill_csv.py",
    "scripts/run_clean_regeo.py",
    "scripts/tests/audit_broader_id_spread.py",
]

REQUIRED_TABLES = [
    "vocabulary", "vocabulary_external_ids",
    "artworks", "mappings", "field_lookup",
]

REQUIRED_VOCAB_COLUMNS = [
    "id", "type", "label_en", "label_nl",
    "lat", "lon", "external_id", "broader_id",
    "coord_method", "coord_method_detail",
    "external_id_method", "external_id_method_detail",
    "broader_method", "broader_method_detail",
    "placetype", "placetype_source", "is_areal",
]

NETWORK_HOSTS = [
    ("GeoNames API",     "api.geonames.org",       443),
    ("Wikidata SPARQL",  "query.wikidata.org",     443),
    ("Getty SPARQL",     "vocab.getty.edu",        443),
    ("WHG API",          "whgazetteer.org",        443),
]

MIN_FREE_GB = 2.0
USER_AGENT = "rijksmuseum-mcp-plus/preflight (+https://github.com/kintopp/rijksmuseum-mcp-plus)"


class Report:
    def __init__(self) -> None:
        self.passes: list[tuple[str, str]] = []
        self.failures: list[tuple[str, str]] = []
        self.warnings: list[tuple[str, str]] = []

    def ok(self, name: str, detail: str = "") -> None:
        self.passes.append((name, detail))
        suffix = f" — {detail}" if detail else ""
        print(f"  [OK]   {name}{suffix}")

    def fail(self, name: str, detail: str = "") -> None:
        self.failures.append((name, detail))
        suffix = f" — {detail}" if detail else ""
        print(f"  [FAIL] {name}{suffix}")

    def warn(self, name: str, detail: str = "") -> None:
        self.warnings.append((name, detail))
        suffix = f" — {detail}" if detail else ""
        print(f"  [WARN] {name}{suffix}")


# ---------------------------------------------------------------------------
# Individual checks
# ---------------------------------------------------------------------------

def check_python_version(r: Report) -> None:
    v = sys.version_info
    if (v.major, v.minor) >= REQUIRED_PYTHON:
        r.ok("Python version",
             f"{v.major}.{v.minor}.{v.micro} (required ≥ {REQUIRED_PYTHON[0]}.{REQUIRED_PYTHON[1]})")
    else:
        r.fail("Python version",
               f"{v.major}.{v.minor}.{v.micro} < required {REQUIRED_PYTHON[0]}.{REQUIRED_PYTHON[1]}")


def check_regeo_python(r: Report) -> None:
    """The orchestrator spawns subprocesses with $REGEO_PYTHON or the default path."""
    target = os.environ.get("REGEO_PYTHON", DEFAULT_REGEO_PYTHON)
    p = Path(target)
    if p.exists() and os.access(p, os.X_OK):
        r.ok("REGEO_PYTHON interpreter", str(p))
    else:
        if os.environ.get("REGEO_PYTHON"):
            r.fail("REGEO_PYTHON interpreter",
                   f"set to {target!r} but not executable/found")
        else:
            r.warn("REGEO_PYTHON interpreter",
                   f"default {target!r} not found. Export REGEO_PYTHON=/path/to/python "
                   "before running the orchestrator.")


def check_stdlib(r: Report) -> None:
    for mod in ("sqlite3", "urllib.request", "json", "csv", "subprocess"):
        try:
            __import__(mod)
            r.ok(f"stdlib: {mod}")
        except ImportError as e:
            r.fail(f"stdlib: {mod}", str(e))


def check_optional_packages(r: Report) -> None:
    try:
        import aiohttp  # noqa: F401
        r.ok("optional: aiohttp", "present — Phase 3 Wikidata reconciliation runs in async mode")
    except ImportError:
        r.warn("optional: aiohttp",
               "missing — Phase 3 falls back to synchronous Wikidata reconciliation (slower but functional)")


def check_env_vars(r: Report) -> None:
    if _DOTENV_LOADED:
        r.ok(".env loaded", f"{REPO_ROOT / '.env'}")
    else:
        r.warn(".env missing",
               f"no {REPO_ROOT / '.env'}; env vars must be exported in the shell instead.")
    whg = os.environ.get("WHG_TOKEN", "").strip().strip('"').strip("'")
    if whg:
        r.ok("env: WHG_TOKEN", f"set ({len(whg)} chars)")
    else:
        r.fail("env: WHG_TOKEN",
               "unset. Needed for Phase 3b/3c. Generate at whgazetteer.org Profile page "
               "(ORCID linking required).")

    gn = os.environ.get("GEONAMES_USERNAME", "").strip()
    if gn:
        r.ok("env: GEONAMES_USERNAME", f"{gn!r}")
    else:
        r.fail("env: GEONAMES_USERNAME",
               "unset. Needed for Phase 1a. Register at geonames.org and activate Free Web Services.")


def check_committed_files(r: Report) -> None:
    for rel in REQUIRED_COMMITTED_FILES:
        path = REPO_ROOT / rel
        if path.exists():
            r.ok(f"file: {rel}")
        else:
            r.fail(f"file: {rel}", "missing from repository")


def check_tsv_parseable(r: Report) -> None:
    """Smoke-check that committed TSVs parse cleanly (catches transit corruption)."""
    checks = [
        ("scripts/country_qid_to_iso2.tsv", 2, 100),
        ("scripts/areal_overrides.tsv",     4,  50),
    ]
    for rel, min_cols, min_rows in checks:
        path = REPO_ROOT / rel
        if not path.exists():
            continue  # already reported by check_committed_files
        rows = 0
        bad = 0
        for line in path.read_text().splitlines():
            if not line.strip() or line.startswith("#"):
                continue
            fields = line.split("\t")
            if len(fields) < min_cols:
                bad += 1
            rows += 1
        if bad > 0:
            r.fail(f"TSV: {rel}", f"{bad}/{rows} rows have < {min_cols} tab-separated fields")
        elif rows < min_rows:
            r.warn(f"TSV: {rel}", f"only {rows} rows (expected ≥ {min_rows})")
        else:
            r.ok(f"TSV: {rel}", f"{rows} rows")


def check_db(r: Report, db_path: Path) -> None:
    if not db_path.exists():
        r.fail(f"DB: {db_path}", "file not found. Copy data/vocabulary.db from source machine.")
        return
    size_gb = db_path.stat().st_size / (1024 ** 3)
    r.ok(f"DB file: {db_path}", f"{size_gb:.2f} GB")

    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    except sqlite3.Error as e:
        r.fail("DB open", str(e))
        return

    tables = {row[0] for row in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ).fetchall()}
    missing_tables = [t for t in REQUIRED_TABLES if t not in tables]
    if not missing_tables:
        r.ok("DB tables", f"all {len(REQUIRED_TABLES)} present")
    else:
        r.fail("DB tables", f"missing: {missing_tables}")

    if "vocabulary" in tables:
        vcols = {row[1] for row in conn.execute("PRAGMA table_info(vocabulary)").fetchall()}
        missing_cols = [c for c in REQUIRED_VOCAB_COLUMNS if c not in vcols]
        if not missing_cols:
            r.ok("vocabulary columns", f"all {len(REQUIRED_VOCAB_COLUMNS)} present")
        else:
            r.fail("vocabulary columns",
                   f"missing {missing_cols}. "
                   "Run scripts/harvest-placetypes.py first to trigger schema migration, "
                   "or copy a DB that already has the v0.24 schema.")

    # Sanity counts
    try:
        n_places = conn.execute(
            "SELECT COUNT(*) FROM vocabulary WHERE type='place'"
        ).fetchone()[0]
        if n_places >= 10000:
            r.ok("place row count", f"{n_places:,}")
        else:
            r.warn("place row count",
                   f"only {n_places:,} (v0.24 DB expects ~36K places)")
    except sqlite3.Error as e:
        r.warn("place row count", str(e))

    conn.close()


def check_writable_dirs(r: Report) -> None:
    for rel in ("data", "data/backfills", "offline/geo", f"data/{_today()}"):
        path = REPO_ROOT / rel
        path.mkdir(parents=True, exist_ok=True)
        probe = path / ".preflight_write_test"
        try:
            probe.write_text("ok")
            probe.unlink()
            r.ok(f"writable: {rel}")
        except OSError as e:
            r.fail(f"writable: {rel}", str(e))


def check_disk_space(r: Report) -> None:
    stat = shutil.disk_usage(REPO_ROOT)
    free_gb = stat.free / (1024 ** 3)
    if free_gb >= MIN_FREE_GB:
        r.ok("disk space", f"{free_gb:.1f} GB free (≥ {MIN_FREE_GB})")
    else:
        r.warn("disk space",
               f"only {free_gb:.1f} GB free. Recommend ≥ {MIN_FREE_GB} GB "
               "for logs + backfill CSV + DB backup.")


def check_network(r: Report) -> None:
    for label, host, port in NETWORK_HOSTS:
        try:
            with socket.create_connection((host, port), timeout=5):
                r.ok(f"network: {label}", f"{host}:{port}")
        except OSError as e:
            r.fail(f"network: {label}", f"{host}:{port} — {e}")


def check_whg_live(r: Report) -> None:
    """Probe WHG's /reconcile endpoint with one minimal valid query.

    Exercises auth + the exact shape Phase 3b will use. Costs 1 WHG
    credit out of 4977/day. A 401/403 definitively means the token is
    bad; any other response (200, 4xx) means auth was accepted and the
    run can proceed.
    """
    token = os.environ.get("WHG_TOKEN", "").strip().strip('"').strip("'")
    if not token:
        return
    queries = json.dumps({"q0": {"query": "Amsterdam", "limit": 1}})
    body = urllib.parse.urlencode({"queries": queries}).encode()
    req = urllib.request.Request(
        "https://whgazetteer.org/reconcile", data=body, method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "User-Agent": USER_AGENT,
            "Content-Type": "application/x-www-form-urlencoded",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            r.ok("WHG token live", f"HTTP {resp.status} on /reconcile probe")
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            r.fail("WHG token live",
                   f"HTTP {e.code} — token rejected. Regenerate at whgazetteer.org Profile page.")
        else:
            r.warn("WHG token live",
                   f"HTTP {e.code} ({e.reason}) — auth was accepted but endpoint returned error.")
    except OSError as e:
        r.warn("WHG token live", str(e))


def check_geonames_live(r: Report) -> None:
    user = os.environ.get("GEONAMES_USERNAME", "").strip()
    if not user:
        return
    # geonameId 2759794 is Amsterdam — a tiny response, doesn't burn credits meaningfully.
    url = ("http://api.geonames.org/getJSON?"
           + urllib.parse.urlencode({"geonameId": "2759794", "username": user}))
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode())
        if "lat" in data and "lng" in data:
            r.ok("GeoNames account live", f"user={user!r} returned lat/lng")
        elif "status" in data:
            msg = data["status"].get("message", "")
            low = msg.lower()
            if "limit" in low or "credits" in low:
                r.fail("GeoNames account",
                       f"credit/limit error: {msg!r}. "
                       "Check https://www.geonames.org/manageaccount — Free Web Services may need activating.")
            elif "not enabled" in low or "not authorized" in low:
                r.fail("GeoNames account",
                       f"{msg!r}. Enable Free Web Services in the account settings.")
            else:
                r.warn("GeoNames account", f"status: {msg!r}")
        else:
            r.warn("GeoNames account", "unexpected response shape")
    except OSError as e:
        r.warn("GeoNames account", str(e))


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def _today() -> str:
    from datetime import datetime
    return datetime.now().strftime("%Y-%m-%d")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", type=Path, default=REPO_ROOT / "data" / "vocabulary.db",
                    help="Path to vocabulary.db (default: %(default)s)")
    ap.add_argument("--skip-network", action="store_true",
                    help="Skip TCP reachability checks to the 4 authority hosts")
    ap.add_argument("--skip-live-api", action="store_true",
                    help="Skip live WHG token + GeoNames credential checks")
    args = ap.parse_args()

    print("=== v0.24 clean re-geocode preflight ===\n")

    r = Report()

    print("[python]")
    check_python_version(r)
    check_regeo_python(r)
    check_stdlib(r)
    check_optional_packages(r)
    print()

    print("[environment]")
    check_env_vars(r)
    print()

    print("[repository files]")
    check_committed_files(r)
    check_tsv_parseable(r)
    print()

    print("[database]")
    check_db(r, args.db)
    print()

    print("[filesystem]")
    check_writable_dirs(r)
    check_disk_space(r)
    print()

    if not args.skip_network:
        print("[network]")
        check_network(r)
        print()

    if not args.skip_live_api:
        print("[live APIs]")
        check_whg_live(r)
        check_geonames_live(r)
        print()

    # Summary
    print("=" * 50)
    print(f"PASS:  {len(r.passes)}")
    print(f"WARN:  {len(r.warnings)}")
    print(f"FAIL:  {len(r.failures)}")

    if r.failures:
        print("\nRequired checks failed — fix before invoking run_clean_regeo.py:")
        for name, detail in r.failures:
            print(f"  - {name}: {detail}")
    if r.warnings:
        print("\nWarnings (run may proceed but be aware):")
        for name, detail in r.warnings:
            print(f"  - {name}: {detail}")

    if not r.failures:
        print("\n✓ Preflight clean. Ready for the user-gated cold reset, then:")
        print("  python scripts/run_clean_regeo.py --db data/vocabulary.db")

    return 0 if not r.failures else 1


if __name__ == "__main__":
    sys.exit(main())
