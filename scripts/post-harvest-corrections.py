"""Stage F: re-apply local-vs-prod drift patches lost in the v0.25 cold rerun.

Two input TSVs (data/backfills/):
- 2026-04-26-tgn-redirect-fix.tsv   — 13 TGN-redirect coord overrides
- 2026-04-27-areal-spot-flips.tsv   —  4 manual is_areal flips (#256 spot-pass)

Per-row idempotency: skip rows whose current DB state already matches target.
Once any row applies cleanly, write a marker file at
data/backfills/post-harvest-corrections.applied; subsequent runs short-circuit.

Run:
  python3 scripts/post-harvest-corrections.py --db data/vocabulary.db        # dry-run
  python3 scripts/post-harvest-corrections.py --db data/vocabulary.db --apply
"""
from __future__ import annotations

import argparse
import csv
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

from lib import enrichment_methods as em

REPO_ROOT = Path(__file__).resolve().parents[1]
TGN_TSV = REPO_ROOT / "data/backfills/2026-04-26-tgn-redirect-fix.tsv"
AREAL_TSV = REPO_ROOT / "data/backfills/2026-04-27-areal-spot-flips.tsv"
DEFAULT_MARKER = REPO_ROOT / "data/backfills/post-harvest-corrections.applied"


def read_tsv(path: Path, skip_comment: bool = False) -> list[dict]:
    rows: list[dict] = []
    with path.open() as f:
        if skip_comment:
            lines = [ln for ln in f if not ln.startswith("#")]
            reader = csv.DictReader(lines, delimiter="\t")
        else:
            reader = csv.DictReader(f, delimiter="\t")
        for r in reader:
            rows.append(r)
    return rows


def plan_tgn_redirects(conn: sqlite3.Connection) -> list[dict]:
    """For each TGN-redirect row, classify as already-applied / needs-apply /
    missing-vocab. Returns list of plan dicts with pre/post columns ready for
    audit emission."""
    plans: list[dict] = []
    for row in read_tsv(TGN_TSV):
        vid = row["vocab_id"]
        cur = conn.execute(
            "SELECT lat, lon, coord_method, coord_method_detail "
            "FROM vocabulary WHERE id=?", (vid,)).fetchone()
        if cur is None:
            plans.append({"vocab_id": vid, "kind": "tgn",
                          "action": "skip-missing",
                          "label": row.get("label_en") or row.get("label_nl"),
                          "pre_lat": None, "pre_lon": None,
                          "pre_method": None, "pre_detail": None,
                          "new_lat": None, "new_lon": None,
                          "new_method": None, "new_detail": None,
                          "reason": "vocab_id not in DB"})
            continue
        target = (float(row["new_lat"]), float(row["new_lon"]),
                  row["new_coord_method"], row["new_coord_method_detail"])
        already_applied = (cur[0] == target[0] and cur[1] == target[1] and
                           cur[2] == target[2] and cur[3] == target[3])
        plans.append({
            "vocab_id": vid, "kind": "tgn",
            "action": "skip-applied" if already_applied else "apply",
            "label": row.get("label_en") or row.get("label_nl"),
            "pre_lat": cur[0], "pre_lon": cur[1],
            "pre_method": cur[2], "pre_detail": cur[3],
            "new_lat": target[0], "new_lon": target[1],
            "new_method": target[2], "new_detail": target[3],
            "reason": f"redirect {row['old_tgn_uri']} → {row['new_tgn_uri']}",
        })
    return plans


def plan_areal_flips(conn: sqlite3.Connection) -> list[dict]:
    plans: list[dict] = []
    for row in read_tsv(AREAL_TSV, skip_comment=True):
        vid = row["vocab_id"]
        cur = conn.execute(
            "SELECT is_areal FROM vocabulary WHERE id=?", (vid,)).fetchone()
        if cur is None:
            plans.append({"vocab_id": vid, "kind": "areal",
                          "action": "skip-missing", "label": row.get("label"),
                          "pre_is_areal": None, "new_is_areal": None,
                          "reason": "vocab_id not in DB"})
            continue
        target = int(row["post_is_areal"])
        already_applied = cur[0] == target
        plans.append({
            "vocab_id": vid, "kind": "areal",
            "action": "skip-applied" if already_applied else "apply",
            "label": row.get("label"),
            "pre_is_areal": cur[0], "new_is_areal": target,
            "reason": row.get("flip_reason", ""),
        })
    return plans


def apply_plans(conn: sqlite3.Connection, plans: list[dict]) -> int:
    n = 0
    for p in plans:
        if p["action"] != "apply":
            continue
        if p["kind"] == "tgn":
            conn.execute(
                "UPDATE vocabulary SET lat=?, lon=?, "
                "  coord_method=?, coord_method_detail=? WHERE id=?",
                (p["new_lat"], p["new_lon"], p["new_method"],
                 p["new_detail"], p["vocab_id"]))
        elif p["kind"] == "areal":
            conn.execute(
                "UPDATE vocabulary SET is_areal=? WHERE id=?",
                (p["new_is_areal"], p["vocab_id"]))
        n += 1
    return n


def write_audit(plans: list[dict], path: Path, applied: bool) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="") as f:
        w = csv.writer(f, delimiter="\t")
        w.writerow(["timestamp", "kind", "vocab_id", "label", "action",
                    "pre", "post", "reason"])
        ts = datetime.now().isoformat(timespec="seconds")
        for p in plans:
            if p["kind"] == "tgn":
                pre = (f"({p['pre_lat']},{p['pre_lon']},"
                       f"{p['pre_method']},{p['pre_detail']})")
                post = (f"({p['new_lat']},{p['new_lon']},"
                        f"{p['new_method']},{p['new_detail']})")
            else:
                pre = f"is_areal={p['pre_is_areal']}"
                post = f"is_areal={p['new_is_areal']}"
            w.writerow([ts, p["kind"], p["vocab_id"], p["label"],
                        p["action"] + ("-applied" if applied
                                        and p["action"] == "apply" else ""),
                        pre, post, p["reason"]])


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--apply", action="store_true", help="apply changes")
    ap.add_argument("--audit-output", default=str(
        REPO_ROOT / f"data/audit/post-harvest-corrections-"
                    f"{datetime.now().strftime('%Y-%m-%d')}.tsv"))
    ap.add_argument("--marker", default=str(DEFAULT_MARKER))
    args = ap.parse_args()

    marker = Path(args.marker)
    if marker.exists() and args.apply:
        print(f"Marker file present at {marker}; no-op.")
        print(f"  Created: {marker.stat().st_mtime}")
        print(f"  To re-run: rm {marker}")
        return 0

    conn = sqlite3.connect(args.db)
    plans = plan_tgn_redirects(conn) + plan_areal_flips(conn)

    counts = {"apply": 0, "skip-applied": 0, "skip-missing": 0}
    for p in plans:
        counts[p["action"]] += 1
    print(f"Plan: {counts['apply']} to apply, "
          f"{counts['skip-applied']} already applied, "
          f"{counts['skip-missing']} missing vocab_id")
    by_kind = {"tgn": [0, 0, 0], "areal": [0, 0, 0]}
    for p in plans:
        idx = ["apply", "skip-applied", "skip-missing"].index(p["action"])
        by_kind[p["kind"]][idx] += 1
    print(f"  TGN redirects: apply={by_kind['tgn'][0]} "
          f"already={by_kind['tgn'][1]} missing={by_kind['tgn'][2]}")
    print(f"  Areal flips:   apply={by_kind['areal'][0]} "
          f"already={by_kind['areal'][1]} missing={by_kind['areal'][2]}")

    if not args.apply:
        print("\nDry-run only. Pass --apply to execute.")
        write_audit(plans, Path(args.audit_output), applied=False)
        print(f"Audit (dry): {args.audit_output}")
        return 0

    n = apply_plans(conn, plans)
    conn.commit()
    print(f"\nApplied {n} updates.")
    write_audit(plans, Path(args.audit_output), applied=True)
    print(f"Audit: {args.audit_output}")

    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text(
        f"applied at {datetime.now().isoformat(timespec='seconds')}\n"
        f"updates: {n}\nhost: post-harvest-corrections.py\n")
    print(f"Marker: {marker}")
    return 0


if __name__ == "__main__":
    sys.path.insert(0, str(REPO_ROOT / "scripts"))
    raise SystemExit(main())
