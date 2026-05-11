#!/usr/bin/env python3
"""Stage 5.5 — authority-IDs-only geocoding chain.

Runs only the steps that resolve coords from gazetteer authority IDs
already attached to harvested place rows (TGN, Wikidata QID, GeoNames ID).
No name-match reconciliation, no parent inheritance, no manual TSVs.

Steps:
  0. preflight_regeo.py
  1. harvest-placetypes.py             — TGN/Wikidata SPARQL classify is_areal
  2. batch_geocode.py                  — bulk Wikidata P625 / GeoNames / TGN
  3. geocode_places.py --phase 1a      — GeoNames ID -> coords
  4. geocode_places.py --phase 1c      — TGN -> Wikidata via P1667 -> P625
  5. geocode_places.py --phase 4       — validation (hemisphere / null-island / swap)
  6. backfill_coord_method_authority   — retroactively tag the 1,888 harvest-time
                                         geocoded rows with authority-tier
                                         coord_method/coord_method_detail based
                                         on their external_id; emit CSV for
                                         the 56 with no external_id.
  7. post_run_diagnostics.py           — coverage report

Skipped vs. run_clean_regeo.py:
  - apply_areal_overrides.py            (manual, not authority-ID-driven)
  - geocode_places.py --phase 1b        (Wikidata alt-props -> related entity coord)
  - geocode_places.py --phase 2         (self-reference / sibling copy)
  - geocode_places.py --phase 3         (Wikidata name search)
  - geocode_places.py --phase 3b        (WHG name reconciliation)
  - geocode_places.py --propagate-coords (parent-areal inheritance)
  - regeo_parent_fallback.py            (cleanup pass for the inheritance step)
  - post-harvest-corrections.py         (manual TSV writes)
  - audit_broader_id_spread.py          (only meaningful if --propagate-coords ran)
  - export_backfill_csv.py              (export, not write)

Each step logs to <log-dir>/NN-<step>.log; the master log is <log-dir>/run.log
and <log-dir>/snapshots.tsv records before/after counts per step.

Usage:
    python3 scripts/run_authority_only_geocode.py \\
        --db data/vocabulary.db \\
        --log-dir data/$(date +%Y-%m-%d)-authority-only

    # Validate without writing:
    python3 scripts/run_authority_only_geocode.py --dry-run

    # Skip preflight (e.g. you already ran it):
    python3 scripts/run_authority_only_geocode.py --skip-preflight

    # Resume from a specific step:
    python3 scripts/run_authority_only_geocode.py --from-step 3
"""
from __future__ import annotations

import argparse
import json
import os
import shlex
import sqlite3
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
PYTHON = sys.executable

# Step definitions: (id, label, argv, dry_run_supported)
def build_steps(db: Path, dry_run: bool) -> list[dict]:
    db_arg = str(db)
    base = [
        {
            "id": 1,
            "label": "harvest-placetypes",
            "script": REPO_ROOT / "scripts/harvest-placetypes.py",
            "argv": ["--db", db_arg],
            "supports_dry_run": True,
            "writes_coords": False,
        },
        {
            "id": 2,
            "label": "batch_geocode",
            "script": REPO_ROOT / "scripts/geocoding/batch_geocode.py",
            "argv": ["--db", db_arg],
            "supports_dry_run": True,
            "writes_coords": True,
        },
        {
            "id": 3,
            "label": "geocode_places.phase-1a",
            "script": REPO_ROOT / "scripts/geocoding/geocode_places.py",
            "argv": ["--db", db_arg, "--phase", "1a"],
            "supports_dry_run": True,
            "writes_coords": True,
        },
        {
            "id": 4,
            "label": "geocode_places.phase-1c",
            "script": REPO_ROOT / "scripts/geocoding/geocode_places.py",
            "argv": ["--db", db_arg, "--phase", "1c"],
            "supports_dry_run": True,
            "writes_coords": True,
        },
        {
            "id": 5,
            "label": "geocode_places.phase-4",
            "script": REPO_ROOT / "scripts/geocoding/geocode_places.py",
            "argv": ["--db", db_arg, "--phase", "4"],
            "supports_dry_run": True,
            "writes_coords": False,
        },
        {
            "id": 6,
            "label": "backfill_coord_method_authority",
            "script": REPO_ROOT / "scripts/geocoding/backfill_coord_method_authority.py",
            # --apply only when not in dry-run mode (handled below via supports_dry_run)
            "argv": ["--db", db_arg, "--apply"],
            "supports_dry_run": False,  # uses presence/absence of --apply, handled below
            "writes_coords": False,  # writes coord_method tags only, not lat/lon
        },
        {
            "id": 7,
            "label": "post_run_diagnostics",
            "script": REPO_ROOT / "scripts/post_run_diagnostics.py",
            "argv": ["--db", db_arg],
            "supports_dry_run": False,
            "writes_coords": False,
        },
    ]
    # backfill uses --apply (not --dry-run) to gate writes; strip it in dry-run.
    if dry_run:
        for step in base:
            if step["label"] == "backfill_coord_method_authority":
                step["argv"] = [a for a in step["argv"] if a != "--apply"]
    if dry_run:
        for step in base:
            if step["supports_dry_run"]:
                step["argv"].append("--dry-run")
    return base


SNAPSHOT_SQL = """
SELECT
  (SELECT COUNT(*) FROM vocabulary WHERE type='place')                                         AS total_places,
  (SELECT COUNT(*) FROM vocabulary WHERE type='place' AND lat IS NOT NULL)                     AS geocoded,
  (SELECT COUNT(*) FROM vocabulary WHERE type='place' AND placetype IS NOT NULL)               AS placetyped,
  (SELECT COUNT(*) FROM vocabulary WHERE type='place' AND is_areal IS NOT NULL)                AS classified_areal,
  (SELECT COUNT(*) FROM vocabulary WHERE type='place' AND lat IS NOT NULL AND coord_method = 'deterministic') AS tagged_authority,
  (SELECT COUNT(*) FROM vocabulary WHERE type='place' AND coord_method_detail = 'geonames_api')    AS m_geonames_api,
  (SELECT COUNT(*) FROM vocabulary WHERE type='place' AND coord_method_detail = 'wikidata_p625')   AS m_wikidata_p625,
  (SELECT COUNT(*) FROM vocabulary WHERE type='place' AND coord_method_detail = 'tgn_p1667')       AS m_tgn_p1667,
  (SELECT COUNT(*) FROM vocabulary WHERE type='place' AND coord_method_detail = 'tgn_direct')      AS m_tgn_direct,
  (SELECT COUNT(*) FROM vocabulary WHERE type='place' AND coord_method_detail = 'rijksmuseum_lod') AS m_rijks_lod
"""


def snapshot(db: Path) -> dict:
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        cur = con.execute(SNAPSHOT_SQL)
        cols = [c[0] for c in cur.description]
        row = cur.fetchone()
    finally:
        con.close()
    return dict(zip(cols, row))


def diff(before: dict, after: dict) -> dict:
    return {k: after[k] - before[k] for k in before}


def fmt_snapshot(s: dict) -> str:
    return (
        f"places={s['total_places']} geo={s['geocoded']} "
        f"tagged={s['tagged_authority']} "
        f"ptype={s['placetyped']} areal={s['classified_areal']} "
        f"gn={s['m_geonames_api']} wd={s['m_wikidata_p625']} "
        f"tgn1667={s['m_tgn_p1667']} tgndirect={s['m_tgn_direct']} "
        f"rijks={s['m_rijks_lod']}"
    )


def fmt_diff(d: dict) -> str:
    parts = []
    for k, v in d.items():
        if v != 0:
            sign = "+" if v > 0 else ""
            parts.append(f"{k}{sign}{v}")
    return ", ".join(parts) if parts else "no-change"


def run_step(step: dict, log_dir: Path, master_log) -> int:
    step_log = log_dir / f"{step['id']:02d}-{step['label']}.log"
    cmd = [PYTHON, str(step["script"]), *step["argv"]]
    msg = f"\n[{datetime.now(timezone.utc).isoformat()}] step {step['id']} {step['label']} -> {shlex.join(cmd)}"
    print(msg)
    master_log.write(msg + "\n")
    master_log.flush()
    with step_log.open("w") as out:
        proc = subprocess.run(cmd, stdout=out, stderr=subprocess.STDOUT, cwd=REPO_ROOT)
    return proc.returncode


def run_preflight(log_dir: Path, master_log) -> int:
    step_log = log_dir / "00-preflight.log"
    cmd = [PYTHON, str(REPO_ROOT / "scripts/geocoding/preflight_regeo.py"), "--skip-live-api"]
    msg = f"\n[{datetime.now(timezone.utc).isoformat()}] preflight -> {shlex.join(cmd)}"
    print(msg)
    master_log.write(msg + "\n")
    master_log.flush()
    with step_log.open("w") as out:
        proc = subprocess.run(cmd, stdout=out, stderr=subprocess.STDOUT, cwd=REPO_ROOT)
    return proc.returncode


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", type=Path, default=REPO_ROOT / "data/vocabulary.db")
    ap.add_argument("--log-dir", type=Path,
                    default=REPO_ROOT / f"data/{datetime.now().strftime('%Y-%m-%d')}-authority-only")
    ap.add_argument("--dry-run", action="store_true",
                    help="Pass --dry-run to scripts that support it; no DB writes")
    ap.add_argument("--skip-preflight", action="store_true")
    ap.add_argument("--from-step", type=int, default=1, help="Resume from step N (1..7)")
    ap.add_argument("--only-step", type=int, default=None, help="Run only step N then stop")
    args = ap.parse_args()

    if not args.db.exists():
        print(f"ERROR: DB not found: {args.db}", file=sys.stderr)
        return 1

    args.log_dir.mkdir(parents=True, exist_ok=True)
    master_log_path = args.log_dir / "run.log"
    snapshots_path = args.log_dir / "snapshots.tsv"

    steps = build_steps(args.db, args.dry_run)

    with master_log_path.open("a") as master_log, snapshots_path.open("w") as snap_log:
        snap_log.write("step\tlabel\twhen\t" + "\t".join(snapshot(args.db).keys()) + "\n")
        master_log.write(
            f"\n=== authority-only geocode run {datetime.now(timezone.utc).isoformat()} ===\n"
            f"db={args.db}\nlog_dir={args.log_dir}\ndry_run={args.dry_run}\n"
        )

        # Initial snapshot
        s0 = snapshot(args.db)
        master_log.write(f"INITIAL: {fmt_snapshot(s0)}\n")
        snap_log.write(f"0\tinitial\t{datetime.now(timezone.utc).isoformat()}\t" +
                       "\t".join(str(v) for v in s0.values()) + "\n")
        print(f"INITIAL  {fmt_snapshot(s0)}")

        # Preflight
        if not args.skip_preflight and not args.dry_run:
            rc = run_preflight(args.log_dir, master_log)
            if rc != 0:
                msg = f"\nPREFLIGHT FAILED (rc={rc}). See {args.log_dir}/00-preflight.log"
                print(msg, file=sys.stderr)
                master_log.write(msg + "\n")
                return rc

        # Run steps
        prev = s0
        for step in steps:
            if step["id"] < args.from_step:
                continue
            if args.only_step is not None and step["id"] != args.only_step:
                continue

            rc = run_step(step, args.log_dir, master_log)
            after = snapshot(args.db)
            d = diff(prev, after)
            line = (f"step {step['id']} ({step['label']}) rc={rc} | "
                    f"{fmt_snapshot(after)} | delta: {fmt_diff(d)}")
            print(line)
            master_log.write(line + "\n")
            snap_log.write(f"{step['id']}\t{step['label']}\t"
                           f"{datetime.now(timezone.utc).isoformat()}\t" +
                           "\t".join(str(v) for v in after.values()) + "\n")
            master_log.flush()
            snap_log.flush()
            prev = after

            if rc != 0:
                msg = (f"\nSTEP {step['id']} FAILED (rc={rc}). "
                       f"See {args.log_dir}/{step['id']:02d}-{step['label']}.log\n"
                       f"Resume with: --from-step {step['id']}")
                print(msg, file=sys.stderr)
                master_log.write(msg + "\n")
                return rc

        # Summary
        final_diff = diff(s0, prev)
        summary = (f"\n=== complete ===\nINITIAL: {fmt_snapshot(s0)}\n"
                   f"FINAL:   {fmt_snapshot(prev)}\nDELTA:   {fmt_diff(final_diff)}")
        print(summary)
        master_log.write(summary + "\n")

    return 0


if __name__ == "__main__":
    sys.exit(main())
