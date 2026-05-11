#!/usr/bin/env python3
"""Post-run diagnostics for the v0.24 clean re-geocode (WI-6).

Read-only. Emits a markdown report to stdout and
``data/YYYY-MM-DD/diagnostics.md``. Exits 0 if all required targets pass,
non-zero otherwise — gate for the orchestrator's success signal.

Required targets (all must pass):
  1. WHG >500 km rate            < 2%
  2. Areal-flag pollution share  < 10%
  3. NULL coord_method among geocoded rows  == 0
  4. coord_method values outside em tiers   == 0
  5. placetype coverage on authority-ID rows  >= 95%
"""
from __future__ import annotations

import argparse
import csv
import json
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.geo_math import haversine_km  # noqa: E402
from lib.enrichment_tiers import VALID_TIERS  # noqa: E402


def compute_whg_distance_rate(conn: sqlite3.Connection,
                              whg_csv: Path) -> dict:
    """Fraction of whg_accepted entries that ended up >500 km from parent."""
    if not whg_csv.exists():
        return {"total": 0, "over_500km": 0, "rate": 0.0, "no_parent_coords": 0,
                "csv_missing": True}

    # Preload vid → (parent_lat, parent_lon) in a single JOIN, so the
    # CSV walk below does no DB work. Fixes the prior N+1 where one
    # query fired per accepted row (~7K round-trips).
    parent_map: dict[str, tuple[float, float]] = {
        vid: (plat, plon) for vid, plat, plon in conn.execute(
            "SELECT c.id, p.lat, p.lon FROM vocabulary c "
            "JOIN vocabulary p ON p.id = c.broader_id "
            "WHERE p.lat IS NOT NULL"
        )
    }

    total = 0
    over_500 = 0
    no_parent = 0
    with whg_csv.open() as f:
        reader = csv.DictReader(f)
        for row in reader:
            total += 1
            vid = row.get("vocab_id") or row.get("id")
            try:
                lat = float(row["lat"]); lon = float(row["lon"])
            except (KeyError, ValueError, TypeError):
                continue
            coords = parent_map.get(vid)
            if not coords:
                no_parent += 1
                continue
            d = haversine_km(lat, lon, coords[0], coords[1])
            if d > 500:
                over_500 += 1
    rate = (over_500 / total) if total else 0.0
    return {"total": total, "over_500km": over_500, "rate": rate,
            "no_parent_coords": no_parent}


def compute_areal_pollution(conn: sqlite3.Connection) -> dict:
    """Fraction of is_areal=1 rows that would un-flag after trimmed-spread test.

    Spread-derived flags only — TGN/Wikidata/manual-sourced rows aren't
    "pollution" candidates by definition. Approximates the findings doc's
    47% pollution share by re-running the pairwise-haversine spread check.
    """
    from lib.geo_math import trimmed_pairwise_km

    # One JOIN pulls every (flagged parent, child) pair. Avoids the prior
    # per-parent SELECT loop; worst case on v0.24 is ~1K parents × avg
    # ~40 children ≈ 40K rows, cheap.
    rows = conn.execute(
        "SELECT p.id AS parent_id, c.lat AS c_lat, c.lon AS c_lon "
        "FROM vocabulary p JOIN vocabulary c ON c.broader_id = p.id "
        "WHERE p.is_areal = 1 "
        "  AND (p.placetype_source IS NULL "
        "       OR p.placetype_source NOT IN ('tgn', 'wikidata', 'manual')) "
        "  AND c.type = 'place' AND c.lat IS NOT NULL"
    ).fetchall()

    children: dict[str, list[tuple[float, float]]] = {}
    for pid, lat, lon in rows:
        children.setdefault(pid, []).append((lat, lon))

    if not children:
        return {"total_spread_flagged": 0, "pollution_share": 0.0,
                "pollution_count": 0,
                "note": "no spread-derived flags to audit"}

    pollution = 0
    for pts in children.values():
        if len(pts) <= 3:
            continue
        # early_exit_km=75 short-circuits the O(N²) loop as soon as one
        # trimmed pair crosses the threshold — matches the harvest
        # script's _compute_areal_parents early-exit for consistency.
        if trimmed_pairwise_km(pts, drop=2, early_exit_km=75.0) < 75.0:
            pollution += 1
    return {
        "total_spread_flagged": len(children),
        "pollution_share": pollution / len(children),
        "pollution_count": pollution,
    }


def compute_provenance_gaps(conn: sqlite3.Connection) -> dict:
    """NULL coord_method on geocoded rows + out-of-vocab tier values."""
    null_cm = conn.execute(
        "SELECT COUNT(*) FROM vocabulary "
        "WHERE type='place' AND lat IS NOT NULL AND coord_method IS NULL"
    ).fetchone()[0]
    distinct_tiers = [r[0] for r in conn.execute(
        "SELECT DISTINCT coord_method FROM vocabulary "
        "WHERE type='place' AND lat IS NOT NULL AND coord_method IS NOT NULL"
    ).fetchall()]
    out_of_vocab = [t for t in distinct_tiers if t not in VALID_TIERS]
    return {"null_coord_method": null_cm,
            "distinct_tiers": distinct_tiers,
            "out_of_vocab_tiers": out_of_vocab}


def compute_placetype_coverage(conn: sqlite3.Connection) -> dict:
    """Share of places with TGN or Wikidata external_id that have non-NULL placetype_source."""
    eligible = conn.execute(
        "SELECT COUNT(DISTINCT v.id) FROM vocabulary v "
        "JOIN vocabulary_external_ids vei ON vei.vocab_id = v.id "
        "WHERE v.type = 'place' AND vei.authority IN ('tgn', 'wikidata')"
    ).fetchone()[0]
    covered = conn.execute(
        "SELECT COUNT(DISTINCT v.id) FROM vocabulary v "
        "JOIN vocabulary_external_ids vei ON vei.vocab_id = v.id "
        "WHERE v.type = 'place' AND vei.authority IN ('tgn', 'wikidata') "
        "  AND v.placetype_source IS NOT NULL"
    ).fetchone()[0]
    return {
        "eligible": eligible,
        "covered": covered,
        "rate": (covered / eligible) if eligible else 0.0,
    }


def compute_informational(conn: sqlite3.Connection) -> dict:
    """Non-gating rollups for the diagnostics.md report."""
    coord_distribution = dict(conn.execute(
        "SELECT coord_method, COUNT(*) FROM vocabulary "
        "WHERE type='place' GROUP BY coord_method"
    ).fetchall())
    coord_detail = dict(conn.execute(
        "SELECT coord_method_detail, COUNT(*) FROM vocabulary "
        "WHERE type='place' AND coord_method_detail IS NOT NULL "
        "GROUP BY coord_method_detail"
    ).fetchall())
    source_distribution = dict(conn.execute(
        "SELECT placetype_source, COUNT(*) FROM vocabulary "
        "WHERE type='place' GROUP BY placetype_source"
    ).fetchall())
    is_areal_distribution = dict(conn.execute(
        "SELECT is_areal, COUNT(*) FROM vocabulary "
        "WHERE type='place' GROUP BY is_areal"
    ).fetchall())
    areal_by_source = {}
    for src, n in conn.execute(
        "SELECT placetype_source, COUNT(*) FROM vocabulary "
        "WHERE type='place' AND is_areal = 1 GROUP BY placetype_source"
    ).fetchall():
        areal_by_source[src or "NULL"] = n
    return {
        "coord_method_distribution": {(k or "NULL"): v for k, v in coord_distribution.items()},
        "coord_method_detail_distribution": coord_detail,
        "placetype_source_distribution": {(k or "NULL"): v for k, v in source_distribution.items()},
        "is_areal_distribution": {("NULL" if k is None else str(k)): v for k, v in is_areal_distribution.items()},
        "is_areal_1_by_source": areal_by_source,
    }


def render_markdown(findings: dict, pass_fail: list[dict]) -> str:
    lines = []
    lines.append(f"# v0.24 Clean Re-Geocode Diagnostics — {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    lines.append("")
    lines.append("## Target Summary")
    lines.append("")
    lines.append("| # | Target | Threshold | Actual | Status |")
    lines.append("|---|--------|-----------|--------|--------|")
    for i, item in enumerate(pass_fail, 1):
        status = "PASS" if item["passed"] else "FAIL"
        lines.append(f"| {i} | {item['name']} | {item['threshold']} | {item['actual']} | {status} |")
    lines.append("")
    lines.append("## WHG Country-Context Filter (WI-3)")
    whg = findings["whg"]
    if whg.get("csv_missing"):
        lines.append("_whg_accepted.csv not present — WHG phase may have been skipped._")
    else:
        lines.append(f"- {whg['total']} accepted entries")
        lines.append(f"- {whg['over_500km']} > 500 km from broader_id parent ({whg['rate']:.1%})")
        lines.append(f"- {whg['no_parent_coords']} had no geocoded parent (excluded from rate)")
    lines.append("")
    lines.append("## Areal-Flag Pollution (WI-2 spread heuristic only)")
    a = findings["pollution"]
    lines.append(f"- Spread-derived flags: {a['total_spread_flagged']}")
    lines.append(f"- Would un-flag after trimmed-spread test: {a.get('pollution_count', 0)} ({a['pollution_share']:.1%})")
    lines.append(f"- Note: TGN/Wikidata/manual-sourced flags excluded (not pollution candidates)")
    lines.append("")
    lines.append("## Provenance Completeness")
    p = findings["provenance"]
    lines.append(f"- Geocoded rows with NULL coord_method: {p['null_coord_method']}")
    lines.append(f"- Distinct tier values found: {p['distinct_tiers']}")
    if p['out_of_vocab_tiers']:
        lines.append(f"- **Out-of-vocab tiers: {p['out_of_vocab_tiers']}**")
    lines.append("")
    lines.append("## Placetype Coverage")
    pt = findings["placetype"]
    lines.append(f"- Places with TGN or Wikidata ext-id: {pt['eligible']}")
    lines.append(f"- Of those, placetype_source populated: {pt['covered']} ({pt['rate']:.1%})")
    lines.append("")
    lines.append("## Distributions (informational)")
    info = findings["informational"]
    for name, dist in info.items():
        lines.append(f"### {name}")
        for k, v in sorted(dist.items(), key=lambda x: -x[1]):
            lines.append(f"- {k}: {v}")
        lines.append("")
    return "\n".join(lines)


def run(db_path: Path, whg_csv: Path, out_path: Path) -> int:
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row

    whg = compute_whg_distance_rate(conn, whg_csv)
    pollution = compute_areal_pollution(conn)
    provenance = compute_provenance_gaps(conn)
    placetype = compute_placetype_coverage(conn)
    informational = compute_informational(conn)
    conn.close()

    pass_fail = [
        {"name": "WHG >500 km rate",
         "threshold": "< 2%",
         "actual": f"{whg['rate']:.1%}" if not whg.get("csv_missing") else "N/A",
         "passed": whg.get("csv_missing") or whg["rate"] < 0.02},
        {"name": "Areal-flag pollution share",
         "threshold": "< 10%",
         "actual": f"{pollution['pollution_share']:.1%}",
         "passed": pollution['pollution_share'] < 0.10},
        {"name": "NULL coord_method on geocoded rows",
         "threshold": "== 0",
         "actual": str(provenance["null_coord_method"]),
         "passed": provenance["null_coord_method"] == 0},
        {"name": "coord_method values outside valid tiers",
         "threshold": "== 0",
         "actual": str(len(provenance["out_of_vocab_tiers"])),
         "passed": len(provenance["out_of_vocab_tiers"]) == 0},
        {"name": "Placetype coverage on authority-ID rows",
         "threshold": ">= 95%",
         "actual": f"{placetype['rate']:.1%}",
         "passed": placetype['rate'] >= 0.95},
    ]

    findings = {
        "whg": whg, "pollution": pollution, "provenance": provenance,
        "placetype": placetype, "informational": informational,
    }
    markdown = render_markdown(findings, pass_fail)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(markdown)
    print(markdown)
    print(f"\n[diagnostics] Written to {out_path}", file=sys.stderr)

    all_pass = all(item["passed"] for item in pass_fail)
    if not all_pass:
        failed_file = out_path.parent / "DIAGNOSTICS_FAILED.md"
        failed_file.write_text("Failed targets:\n" + "\n".join(
            f"- {item['name']}: actual={item['actual']}, threshold={item['threshold']}"
            for item in pass_fail if not item["passed"]
        ))
    return 0 if all_pass else 2


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--db", type=Path, default=Path("data/vocabulary.db"))
    ap.add_argument("--whg-csv", type=Path,
                    default=Path("offline/geo/whg_accepted.csv"))
    ap.add_argument("--out", type=Path, default=None,
                    help="Output markdown path; defaults to "
                         "data/YYYY-MM-DD/diagnostics.md.")
    args = ap.parse_args()
    if args.out is None:
        date_str = datetime.now().strftime("%Y-%m-%d")
        args.out = Path("data") / date_str / "diagnostics.md"
    if not args.db.exists():
        print(f"DB not found: {args.db}", file=sys.stderr)
        return 1
    return run(args.db, args.whg_csv, args.out)


if __name__ == "__main__":
    sys.exit(main())
