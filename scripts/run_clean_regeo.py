#!/usr/bin/env python3
"""Orchestrator for the v0.24 clean re-geocode — unattended post-cold-reset run.

Chains the 8-step pipeline defined in the plan:

  1. harvest-placetypes.py                  — TGN/Wikidata SPARQL side-pass
  2. apply_areal_overrides.py               — manual overrides apply
  3. batch_geocode.py                       — refresh batch-level authority lookups
  4. geocode_places.py (all phases)         — 1a/1b/1c/2/3/3b/3c/4
  5. geocode_places.py --propagate-coords   — Step 7 inheritance
  6. tests/audit_broader_id_spread.py       — #255 audit CSV
  7. post_run_diagnostics.py                — target-gate check
  8. export_backfill_csv.py                 — 16-column CSV

Cold-reset SQL is NOT handled here — it's USER-GATED per the plan.
Run this only AFTER the user has wiped lat/lon/coord_method.

Failure policy (per plan Q6 → (iii) with backoff):
  - Per-step retry: 3 attempts, exponential backoff capped at 1 hour.
  - On persistent failure: write resume-hint, exit code 2. The
    AND lat IS NULL / WHERE placetype_source IS NULL guards make every
    step safe to rerun.

Logs: each step writes data/YYYY-MM-DD/<step>-<name>.log; orchestrator
writes data/YYYY-MM-DD/run.log + status.json.

Usage:
    python3 scripts/run_clean_regeo.py \\
        --db data/vocabulary.db \\
        --log-dir data/$(date +%Y-%m-%d)

    # Skip a step (e.g. after manual completion)
    python3 scripts/run_clean_regeo.py --skip-step 1

    # Resume from a specific step after failure
    python3 scripts/run_clean_regeo.py --from-step 4
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
PYTHON = os.environ.get(
    "REGEO_PYTHON",
    str(Path.home() / "miniconda3" / "envs" / "embeddings" / "bin" / "python"),
)


def step_cmd(step: int, db_path: Path, log_dir: Path) -> list[str]:
    """Return the argv for a given step."""
    scripts = REPO_ROOT / "scripts"
    if step == 1:
        return [PYTHON, "-u", str(scripts / "harvest-placetypes.py"),
                "--db", str(db_path)]
    if step == 2:
        return [PYTHON, "-u", str(scripts / "apply_areal_overrides.py"),
                "--db", str(db_path),
                "--overrides", str(scripts / "areal_overrides.tsv")]
    if step == 3:
        return [PYTHON, "-u", str(scripts / "batch_geocode.py"),
                "--db", str(db_path)]
    if step == 4:
        return [PYTHON, "-u", str(scripts / "geocode_places.py"),
                "--db", str(db_path)]
    if step == 5:
        return [PYTHON, "-u", str(scripts / "geocode_places.py"),
                "--db", str(db_path), "--propagate-coords"]
    if step == 6:
        return [PYTHON, "-u", str(scripts / "tests" / "audit_broader_id_spread.py"),
                "--db", str(db_path)]
    if step == 7:
        return [PYTHON, "-u", str(scripts / "post_run_diagnostics.py"),
                "--db", str(db_path),
                "--out", str(log_dir / "diagnostics.md")]
    if step == 8:
        return [PYTHON, "-u", str(scripts / "export_backfill_csv.py"),
                "--db", str(db_path),
                "--out", str(REPO_ROOT / "data/backfills/geocoded-places.csv")]
    raise ValueError(f"unknown step {step}")


STEP_NAMES = {
    1: "harvest-placetypes",
    2: "apply-areal-overrides",
    3: "batch-geocode",
    4: "geocode-places",
    5: "propagate-coords",
    6: "audit-broader-id",
    7: "diagnostics",
    8: "export-backfill",
}


def run_step(step: int, db_path: Path, log_dir: Path, max_retries: int = 3,
             ) -> tuple[int, float]:
    """Run a step with exponential backoff on non-zero exit.

    Returns (exit_code, elapsed_s). Exits the orchestrator only on
    persistent failure.
    """
    name = STEP_NAMES[step]
    cmd = step_cmd(step, db_path, log_dir)
    log_file = log_dir / f"{step}-{name}.log"
    log_dir.mkdir(parents=True, exist_ok=True)

    for attempt in range(1, max_retries + 1):
        t0 = time.time()
        print(f"[step {step}/{name}] attempt {attempt}/{max_retries}: {' '.join(cmd)}")
        with log_file.open("a") as log:
            log.write(f"\n\n===== attempt {attempt} @ {datetime.now().isoformat()} =====\n")
            log.flush()
            proc = subprocess.Popen(
                cmd, stdout=log, stderr=subprocess.STDOUT,
                cwd=str(REPO_ROOT),
            )
            rc = proc.wait()
        elapsed = time.time() - t0
        if rc == 0:
            print(f"[step {step}/{name}] OK in {elapsed:.1f}s → {log_file}")
            return (0, elapsed)
        print(f"[step {step}/{name}] exit {rc} in {elapsed:.1f}s — see {log_file}")
        # Convention: exit 2 is a TERMINAL semantic signal (e.g. diagnostics
        # targets missed) that retrying can't fix. Only retry on exits 1
        # and ≥128 (crashes, signals), which are typically transient
        # network/endpoint issues.
        if rc == 2:
            print(f"[step {step}/{name}] exit 2 = terminal semantic failure "
                  f"(not retrying)")
            return (rc, elapsed)
        if attempt < max_retries:
            wait = min(60 * (2 ** (attempt - 1)), 3600)
            print(f"[step {step}/{name}] backoff {wait}s before retry")
            time.sleep(wait)

    # Persistent failure.
    resume_hint = log_dir / f"resume-from-step-{step}.txt"
    resume_hint.write_text(
        f"Step {step} ({name}) failed after {max_retries} attempts.\n"
        f"Rerun with: python3 scripts/run_clean_regeo.py --from-step {step}\n"
        f"Last log: {log_file}\n"
    )
    return (rc, 0.0)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--db", type=Path, default=Path("data/vocabulary.db"))
    ap.add_argument("--log-dir", type=Path, default=None,
                    help="Per-run log directory. Defaults to data/YYYY-MM-DD.")
    ap.add_argument("--from-step", type=int, default=1,
                    help="Start from this step (1-8). Default: 1.")
    ap.add_argument("--to-step", type=int, default=8,
                    help="End at this step (inclusive). Default: 8.")
    ap.add_argument("--skip-step", type=int, action="append", default=[],
                    help="Skip this step (may be repeated).")
    ap.add_argument("--max-retries", type=int, default=3)
    args = ap.parse_args()

    if args.log_dir is None:
        args.log_dir = Path("data") / datetime.now().strftime("%Y-%m-%d")
    args.log_dir.mkdir(parents=True, exist_ok=True)

    if not args.db.exists():
        print(f"DB not found: {args.db}", file=sys.stderr)
        return 1

    # Pre-flight checks
    preflight_checks = [
        ("WHG_TOKEN env var", bool(os.environ.get("WHG_TOKEN", "").strip())),
        ("GEONAMES_USERNAME env var",
         bool(os.environ.get("GEONAMES_USERNAME", "").strip())),
    ]
    missing = [n for n, ok in preflight_checks if not ok]
    if missing:
        print(f"[preflight] MISSING: {missing}", file=sys.stderr)
        print(f"[preflight] Phases that need these (WHG_TOKEN: step 4; "
              f"GEONAMES_USERNAME: step 4) will fail.", file=sys.stderr)
        # Continue anyway — some steps (1, 2, 5-8) don't need them.

    status = {
        "started_at": datetime.now().isoformat(),
        "db": str(args.db),
        "log_dir": str(args.log_dir),
        "from_step": args.from_step,
        "to_step": args.to_step,
        "skipped": args.skip_step,
        "steps": [],
    }
    status_file = args.log_dir / "status.json"
    overall_ok = True

    for step in range(args.from_step, args.to_step + 1):
        if step in args.skip_step:
            print(f"[step {step}] SKIPPED")
            status["steps"].append({"step": step, "name": STEP_NAMES[step],
                                     "status": "skipped"})
            continue
        rc, elapsed = run_step(step, args.db, args.log_dir,
                               max_retries=args.max_retries)
        status["steps"].append({
            "step": step,
            "name": STEP_NAMES[step],
            "status": "ok" if rc == 0 else "failed",
            "exit_code": rc,
            "elapsed_s": round(elapsed, 1),
        })
        status_file.write_text(json.dumps(status, indent=2))
        if rc != 0:
            overall_ok = False
            print(f"\n[orchestrator] Step {step} failed persistently. "
                  f"Resume hint in {args.log_dir}/resume-from-step-{step}.txt",
                  file=sys.stderr)
            break

    status["finished_at"] = datetime.now().isoformat()
    status["overall"] = "ok" if overall_ok else "failed"
    status_file.write_text(json.dumps(status, indent=2))
    print(f"\n[orchestrator] Overall: {status['overall']}. "
          f"Status JSON at {status_file}.")
    return 0 if overall_ok else 2


if __name__ == "__main__":
    sys.exit(main())
