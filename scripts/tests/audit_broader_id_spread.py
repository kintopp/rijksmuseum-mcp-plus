#!/usr/bin/env python3
"""Audit diagnostic for broader_id / children geographic coherence (#255).

Read-only. Produces `offline/geo/broader_id_spread_audit_YYYY-MM-DD.csv`
with one row per parent place that has ≥2 geocoded children, measuring:

  - trimmed_diagonal_km: pairwise-max haversine after dropping the 2
    farthest children (if ≥4 children); otherwise max pairwise. This is
    the "is the parent legitimately areal?" signal — if it stays ≥75 km
    after trimming, the parent really spans a wide area; if it drops
    below 75 km, the original wide spread was pollution-driven by 1-2
    mislocated children (the classic WHG misclassification case).

  - max_child_distance_km: great-circle distance from the parent's own
    coord to the farthest child. This is the "#255 root cause" signal —
    children that are hundreds or thousands of km from their parent
    indicate either broader_id mis-assignment or a Phase 3b WHG wrong-
    country hit.

Run:
    python3 scripts/tests/audit_broader_id_spread.py \\
        --db data/vocabulary.db \\
        --out offline/geo/broader_id_spread_audit_$(date +%Y-%m-%d).csv

Diagnostic expectations (post WI-2 dateline fix):
  - Fiji's trimmed_diagonal_km drops from 40,051 km to <5,000 km
    (was pure antimeridian artefact).
  - Zeeland, Perth and Kinross, Gloucestershire, Hauts-de-Seine
    stay wide (genuine misclassifications, not antimeridian).
"""
from __future__ import annotations

import argparse
import csv
import sqlite3
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from lib.geo_math import haversine_km, trimmed_pairwise_km  # noqa: E402


def column_exists(conn: sqlite3.Connection, table: str, col: str) -> bool:
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return any(r[1] == col for r in rows)


def audit(db_path: Path, out_path: Path) -> int:
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row

    has_is_areal = column_exists(conn, "vocabulary", "is_areal")
    if not has_is_areal:
        print(
            "  [audit] is_areal column not present — WI-4 hasn't landed yet. "
            "Reporting NULL in that column.",
            file=sys.stderr,
        )

    # Fetch all parent + child pairs in one shot.
    select_is_areal = "p.is_areal" if has_is_areal else "NULL"
    rows = conn.execute(
        f"""SELECT
              p.id       AS parent_id,
              p.label_en AS parent_label_en,
              p.label_nl AS parent_label_nl,
              p.lat      AS parent_lat,
              p.lon      AS parent_lon,
              {select_is_areal} AS parent_is_areal,
              c.id       AS child_id,
              c.label_en AS child_label_en,
              c.label_nl AS child_label_nl,
              c.lat      AS child_lat,
              c.lon      AS child_lon
           FROM vocabulary p
           JOIN vocabulary c
             ON c.broader_id = p.id
            AND c.type = 'place'
            AND c.lat IS NOT NULL
           WHERE p.type = 'place' AND p.lat IS NOT NULL"""
    ).fetchall()

    parents: dict[str, dict] = defaultdict(lambda: {
        "label": None,
        "lat": None,
        "lon": None,
        "is_areal": None,
        "children": [],
    })
    for r in rows:
        pid = r["parent_id"]
        p = parents[pid]
        if p["label"] is None:
            p["label"] = r["parent_label_en"] or r["parent_label_nl"] or pid
            p["lat"] = r["parent_lat"]
            p["lon"] = r["parent_lon"]
            p["is_areal"] = r["parent_is_areal"]
        p["children"].append({
            "id": r["child_id"],
            "label": r["child_label_en"] or r["child_label_nl"] or r["child_id"],
            "lat": r["child_lat"],
            "lon": r["child_lon"],
        })

    out_path.parent.mkdir(parents=True, exist_ok=True)
    cols = [
        "parent_id", "parent_label", "parent_lat", "parent_lon",
        "n_children", "trimmed_diagonal_km",
        "max_child_distance_km", "worst_child_id", "worst_child_label",
        "worst_child_distance_km", "worst_child_lat", "worst_child_lon",
        "is_areal",
    ]
    out_rows: list[dict] = []
    for pid, p in parents.items():
        children = p["children"]
        if len(children) < 2:
            continue
        pts = [(c["lat"], c["lon"]) for c in children]
        trimmed = trimmed_pairwise_km(pts)

        # Max child-to-parent distance + the specific worst child.
        worst = None
        worst_d = -1.0
        for c in children:
            d = haversine_km(p["lat"], p["lon"], c["lat"], c["lon"])
            if d > worst_d:
                worst_d = d
                worst = c

        out_rows.append({
            "parent_id": pid,
            "parent_label": p["label"],
            "parent_lat": p["lat"],
            "parent_lon": p["lon"],
            "n_children": len(children),
            "trimmed_diagonal_km": round(trimmed, 1),
            "max_child_distance_km": round(worst_d, 1),
            "worst_child_id": worst["id"],
            "worst_child_label": worst["label"],
            "worst_child_distance_km": round(worst_d, 1),
            "worst_child_lat": worst["lat"],
            "worst_child_lon": worst["lon"],
            "is_areal": p["is_areal"] if p["is_areal"] is not None else "",
        })

    # Sort by max_child_distance_km descending — worst offenders on top.
    out_rows.sort(key=lambda r: r["max_child_distance_km"], reverse=True)

    with out_path.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        for r in out_rows:
            w.writerow(r)

    print(
        f"[audit] {len(out_rows)} parents with ≥2 geocoded children → {out_path}",
        file=sys.stderr,
    )

    # Print headline findings for quick sanity-check against #255 expectations.
    named_targets = {
        "2301492": "Zeeland",
        "23016600": "Perth and Kinross",
        "2306353": "Gloucestershire",
        "23024595": "Hauts-de-Seine",
        "23016698": "Fiji",
    }
    print("\n  Named #255 targets (trial baselines in parens):", file=sys.stderr)
    target_hits = {r["parent_id"]: r for r in out_rows if r["parent_id"] in named_targets}
    for pid, label in named_targets.items():
        if pid in target_hits:
            r = target_hits[pid]
            print(
                f"    {pid:>10} {label:<22} "
                f"trimmed={r['trimmed_diagonal_km']:>10.1f} km  "
                f"max_child={r['max_child_distance_km']:>10.1f} km",
                file=sys.stderr,
            )
        else:
            print(f"    {pid:>10} {label:<22} NOT FOUND", file=sys.stderr)

    conn.close()
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--db", type=Path, default=Path("data/vocabulary.db"))
    ap.add_argument(
        "--out",
        type=Path,
        default=None,
        help=("Output CSV path. Defaults to "
              "offline/geo/broader_id_spread_audit_YYYY-MM-DD.csv."),
    )
    args = ap.parse_args()

    if args.out is None:
        date_str = datetime.now().strftime("%Y-%m-%d")
        args.out = Path("offline/geo") / f"broader_id_spread_audit_{date_str}.csv"

    if not args.db.exists():
        print(f"DB not found: {args.db}", file=sys.stderr)
        return 1

    return audit(args.db, args.out)


if __name__ == "__main__":
    sys.exit(main())
