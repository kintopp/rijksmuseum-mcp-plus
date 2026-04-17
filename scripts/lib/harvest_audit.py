"""Post-phase extraction audit for the Rijksmuseum vocabulary harvest (#222).

Compares observed row counts (and non-null column counts) against a calibrated
configuration after each harvest phase. Flags mismatches as PASS / WARN / FAIL /
SKIP and emits both a stdout table and a JSON artifact.

Motivation: the v0.24 harvest shipped with three silent regressions of the same
class (#218, #219, #220) where schema was wired but the population step was
missing or misaligned. All three would have been caught by a post-phase sanity
check that compares observed counts against expected ranges.

This module is purely additive — it only runs SELECT COUNT(*) queries and never
mutates the database. The default policy is warn-only; the harvest's
``--strict-audit`` flag upgrades end-of-run failures to a non-zero exit.
"""

from __future__ import annotations

import json
import sqlite3
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Literal

Status = Literal["PASS", "WARN", "FAIL", "SKIP"]
Kind = Literal["table_count", "column_not_null", "mappings_field"]


# ── Data shapes ─────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class AuditTarget:
    """One configuration entry describing what to count and what to expect."""

    name: str                       # "phase4.modifications" — must be unique
    phase: str                      # "phase0" | "phase2" | "phase3.geocoding" | "phase3" | "phase4"
    kind: Kind
    table: str                      # e.g. "modifications" or "artworks" or "mappings"
    column: str | None              # None for table_count; column name otherwise; field name for mappings_field
    min_rows: int                   # inclusive lower bound; WARN below this (FAIL if 0)
    max_rows: int | None            # inclusive upper bound, None = no cap
    rationale: str                  # one-line explanation of where the range came from
    required: bool = True           # if False, a 0 result is SKIP not FAIL


@dataclass
class AuditResult:
    target: AuditTarget
    actual: int
    status: Status
    note: str = ""


# ── Calibrated expectations ─────────────────────────────────────────────────
#
# Numbers grounded in the v0.24 DB query run 2026-04-12 plus the v23.1 backup,
# with ~30-50% safety margin on stable fields and wider ranges on speculative
# (broken-in-v0.24) targets. After the first clean harvest, ranges should be
# tightened. Status semantics:
#   - PASS:  min_rows <= actual <= max_rows
#   - WARN:  0 < actual < min_rows  OR  actual > max_rows
#   - FAIL:  actual == 0 and required == True, OR table/column missing
#   - SKIP:  actual == 0 and required == False

EXPECTATIONS: list[AuditTarget] = [
    # ── Phase 0 (dump parsing) ───────────────────────────────────────────
    AuditTarget(
        name="phase0.exhibitions",
        phase="phase0",
        kind="table_count",
        table="exhibitions",
        column=None,
        min_rows=600,
        max_rows=1000,
        rationale="v0.24 had 870; dump-driven, low cross-harvest fluctuation",
    ),
    AuditTarget(
        name="phase0.exhibition_members",
        phase="phase0",
        kind="table_count",
        table="exhibition_members",
        column=None,
        min_rows=4500,
        max_rows=6500,
        rationale="Observed 5,136 on both 2026-04-13 and 2026-04-17 v0.24 harvests (~5.9 members/exhibition across 868 exhibitions). Dump-driven, very low cross-harvest fluctuation — ±15% either side. Pre-tightening range 4K–12K was #220 smoke-test extrapolation.",
    ),
    AuditTarget(
        name="phase0.vocabulary",
        phase="phase0",
        kind="table_count",
        table="vocabulary",
        column=None,
        min_rows=275000,
        max_rows=325000,
        rationale="2026-04-17 v0.24 harvest: 294,368 (first post-#238 harvest to sweep Schema.org person/org/topical_term/place dumps). Matches the #238 prediction of ~294K almost exactly. Range ±~5% around that measurement.",
    ),
    AuditTarget(
        name="phase0.vocabulary_external_ids",
        phase="phase0",
        kind="table_count",
        table="vocabulary_external_ids",
        column=None,
        min_rows=140000,
        max_rows=175000,
        rationale="2026-04-17 v0.24 harvest: 156,416 (first post-#238 harvest, new table). Linked Art `equivalent` + Schema.org `sameAs` combined. Range ±~10% around that measurement.",
    ),

    # ── Phase 2 / Phase 2b (vocab URI resolution) ────────────────────────
    AuditTarget(
        name="phase2.person_names",
        phase="phase2",
        kind="table_count",
        table="person_names",
        column=None,
        min_rows=200000,
        max_rows=500000,
        rationale="v0.24=346,122; v23.1=359,516. Varies with new vocab needing HTTP lookup",
    ),

    # ── Phase 3 — geocoding sub-audit (after import_geocoding) ───────────
    AuditTarget(
        name="phase3.geocoding.lat",
        phase="phase3.geocoding",
        kind="column_not_null",
        table="vocabulary",
        column="lat",
        min_rows=25000,
        max_rows=60000,
        rationale="v0.24=31,034. Imported from backfill CSV",
    ),
    AuditTarget(
        name="phase3.geocoding.geocode_method",
        phase="phase3.geocoding",
        kind="column_not_null",
        table="vocabulary",
        column="geocode_method",
        min_rows=25000,
        max_rows=60000,
        rationale="Catches #218. Must equal lat NOT NULL count",
    ),

    # ── Phase 3 final (end of run_phase3) ────────────────────────────────
    AuditTarget(
        name="phase3.artwork_exhibitions",
        phase="phase3",
        kind="table_count",
        table="artwork_exhibitions",
        column=None,
        min_rows=4000,
        max_rows=12000,
        rationale="Junction of artworks ∩ exhibition_members; 2026-04-13 backfill: 5,131 (5 hmo_ids HTTP 410/404 — upstream attrition)",
    ),
    AuditTarget(
        name="phase3.museum_rooms",
        phase="phase3",
        kind="table_count",
        table="museum_rooms",
        column=None,
        min_rows=60,
        max_rows=100,
        rationale="Static seed from museum-rooms.json (#229 part A); SKIP until JSON committed",
        required=False,
    ),
    AuditTarget(
        name="phase3.mappings_total",
        phase="phase3",
        kind="table_count",
        table="mappings",
        column=None,
        min_rows=10_000_000,
        max_rows=20_000_000,
        rationale="v0.24=14,652,650 post-normalize",
    ),
    AuditTarget(
        name="phase3.enrichment_birth_year",
        phase="phase3",
        kind="column_not_null",
        table="vocabulary",
        column="birth_year",
        min_rows=30000,
        max_rows=None,
        rationale="#242 part 3 — EDM actors dump populates ~30K+ birth years when dumps are present. SKIPs cleanly when --skip-enrichment or dumps absent (required=False).",
        required=False,
    ),

    # ── Phase 4 — scalar columns on artworks ─────────────────────────────
    AuditTarget(
        name="phase4.inscription_text",
        phase="phase4",
        kind="column_not_null",
        table="artworks",
        column="inscription_text",
        min_rows=400000,
        max_rows=600000,
        rationale="v0.24=501,452; v23.1=500,740",
    ),
    AuditTarget(
        name="phase4.provenance_text",
        phase="phase4",
        kind="column_not_null",
        table="artworks",
        column="provenance_text",
        min_rows=40000,
        max_rows=60000,
        rationale="v0.24=48,538; v23.1=48,316",
    ),
    AuditTarget(
        name="phase4.provenance_text_hash",
        phase="phase4",
        kind="column_not_null",
        table="artworks",
        column="provenance_text_hash",
        min_rows=40000,
        max_rows=60000,
        rationale="Always equal to provenance_text count (set together)",
    ),
    AuditTarget(
        name="phase4.description_text",
        phase="phase4",
        kind="column_not_null",
        table="artworks",
        column="description_text",
        min_rows=400000,
        max_rows=600000,
        rationale="v0.24=511,599; v23.1=510,631",
    ),
    AuditTarget(
        name="phase4.title_all_text",
        phase="phase4",
        kind="column_not_null",
        table="artworks",
        column="title_all_text",
        min_rows=800000,
        max_rows=900000,
        rationale="v0.24=833,428; v23.1=832,193 (near-total)",
    ),
    AuditTarget(
        name="phase4.date_earliest",
        phase="phase4",
        kind="column_not_null",
        table="artworks",
        column="date_earliest",
        min_rows=800000,
        max_rows=900000,
        rationale="v0.24=832,454; v23.1=831,245 (near-total)",
    ),
    AuditTarget(
        name="phase4.date_display",
        phase="phase4",
        kind="column_not_null",
        table="artworks",
        column="date_display",
        min_rows=800000,
        max_rows=900000,
        rationale="v0.24=832,457 (new column, near-total)",
    ),
    AuditTarget(
        name="phase4.current_location",
        phase="phase4",
        kind="column_not_null",
        table="artworks",
        column="current_location",
        min_rows=5000,
        max_rows=50000,
        rationale="v0.24=8,557 (new column, sparse)",
    ),
    AuditTarget(
        name="phase4.height_cm",
        phase="phase4",
        kind="column_not_null",
        table="artworks",
        column="height_cm",
        min_rows=700000,
        max_rows=900000,
        rationale="v0.24=793,089; v23.1=795,270",
    ),
    AuditTarget(
        name="phase4.depth_cm",
        phase="phase4",
        kind="column_not_null",
        table="artworks",
        column="depth_cm",
        min_rows=15000,
        max_rows=80000,
        rationale="v0.24=23,902 (new column, 3D objects only)",
    ),
    AuditTarget(
        name="phase4.weight_g",
        phase="phase4",
        kind="column_not_null",
        table="artworks",
        column="weight_g",
        min_rows=15000,
        max_rows=80000,
        rationale="v0.24=21,308 (new column, sparse)",
    ),
    AuditTarget(
        name="phase4.diameter_cm",
        phase="phase4",
        kind="column_not_null",
        table="artworks",
        column="diameter_cm",
        min_rows=25000,
        max_rows=80000,
        rationale="v0.24=36,857 (new column, sparse)",
    ),

    # ── Phase 4 — new tables (all 0 in v0.24, see #219) ──────────────────
    AuditTarget(
        name="phase4.modifications",
        phase="phase4",
        kind="table_count",
        table="modifications",
        column=None,
        min_rows=500,
        max_rows=5000,
        rationale="Plan estimate ~1,600 ±50% (no real data yet)",
    ),
    AuditTarget(
        name="phase4.related_objects",
        phase="phase4",
        kind="table_count",
        table="related_objects",
        column=None,
        min_rows=10000,
        max_rows=200000,
        rationale="2026-04-13 harvest=155,687; ceiling raised from plan estimate (#240)",
    ),
    AuditTarget(
        name="phase4.examinations",
        phase="phase4",
        kind="table_count",
        table="examinations",
        column=None,
        min_rows=1000,
        max_rows=10000,
        rationale="Plan estimate 2-5k",
    ),
    AuditTarget(
        name="phase4.title_variants",
        phase="phase4",
        kind="table_count",
        table="title_variants",
        column=None,
        min_rows=1_000_000,
        max_rows=6_000_000,
        rationale="2026-04-13 harvest=1,280,226 (~1.54/artwork). Plan's '≥2 variants' assumption was wrong — long tail is single Dutch labels (#241)",
    ),
    AuditTarget(
        name="phase4.assignment_pairs",
        phase="phase4",
        kind="table_count",
        table="assignment_pairs",
        column=None,
        min_rows=100000,
        max_rows=500000,
        rationale="Plan estimate 260-300k",
    ),
    AuditTarget(
        name="phase4.artwork_parent",
        phase="phase4",
        kind="table_count",
        table="artwork_parent",
        column=None,
        min_rows=50000,
        max_rows=500000,
        rationale="Plan estimate ~200k",
    ),

    # ── Phase 4 — mapping field breakdowns (via field column / field_lookup) ─
    AuditTarget(
        name="phase4.mappings.attribution_qualifier",
        phase="phase4",
        kind="mappings_field",
        table="mappings",
        column="attribution_qualifier",
        min_rows=1_200_000,
        max_rows=2_000_000,
        rationale="v0.24=1,560,295",
    ),
    AuditTarget(
        name="phase4.mappings.production_role",
        phase="phase4",
        kind="mappings_field",
        table="mappings",
        column="production_role",
        min_rows=1_000_000,
        max_rows=1_800_000,
        rationale="v0.24=1,360,225",
    ),
    AuditTarget(
        name="phase4.mappings.creator",
        phase="phase4",
        kind="mappings_field",
        table="mappings",
        column="creator",
        min_rows=900_000,
        max_rows=1_600_000,
        rationale="v0.24=1,190,110",
    ),
    AuditTarget(
        name="phase4.mappings.subject",
        phase="phase4",
        kind="mappings_field",
        table="mappings",
        column="subject",
        min_rows=1_500_000,
        max_rows=2_500_000,
        rationale="v0.24=2,017,134",
    ),
    AuditTarget(
        name="phase4.mappings.material",
        phase="phase4",
        kind="mappings_field",
        table="mappings",
        column="material",
        min_rows=900_000,
        max_rows=1_600_000,
        rationale="v0.24=1,192,858",
    ),
    AuditTarget(
        name="phase4.mappings.production_place",
        phase="phase4",
        kind="mappings_field",
        table="mappings",
        column="production_place",
        min_rows=500_000,
        max_rows=1_000_000,
        rationale="v0.24=707,428 (new field)",
    ),
    AuditTarget(
        name="phase4.mappings.source_type",
        phase="phase4",
        kind="mappings_field",
        table="mappings",
        column="source_type",
        min_rows=100_000,
        max_rows=400_000,
        rationale="v0.24=210,884 (new field)",
    ),
]


# Self-contained copies of get_columns / table_exists so this module can be
# imported without pulling in the harvest script (whose hyphenated filename
# is import-hostile and would couple the audit tests to importlib hacks).


def _table_exists(conn: sqlite3.Connection, name: str) -> bool:
    return conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone() is not None


def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
    if not _table_exists(conn, table):
        return set()
    return {row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}


# ── Counting and classification ─────────────────────────────────────────────


def count_target(conn: sqlite3.Connection, target: AuditTarget) -> tuple[int, str]:
    """Return (actual, note). On missing schema, returns (-1, reason)."""

    if not _table_exists(conn, target.table):
        return -1, f"table {target.table!r} does not exist"

    cols = _columns(conn, target.table)

    if target.kind == "table_count":
        actual = conn.execute(f"SELECT COUNT(*) FROM {target.table}").fetchone()[0]
        return actual, ""

    if target.kind == "column_not_null":
        if target.column not in cols:
            return -1, f"column {target.column!r} missing from {target.table}"
        actual = conn.execute(
            f"SELECT COUNT(*) FROM {target.table} WHERE {target.column} IS NOT NULL"
        ).fetchone()[0]
        return actual, ""

    if target.kind == "mappings_field":
        # Schema-aware routing: integer-encoded mappings join field_lookup,
        # legacy text-encoded mappings filter on the field column directly.
        if "field_id" in cols:
            if not _table_exists(conn, "field_lookup"):
                return -1, "field_lookup table missing for integer-encoded mappings"
            row = conn.execute(
                "SELECT COUNT(*) FROM mappings m "
                "JOIN field_lookup f ON m.field_id = f.id "
                "WHERE f.name = ?",
                (target.column,),
            ).fetchone()
            return row[0], "via field_lookup"
        if "field" in cols:
            row = conn.execute(
                "SELECT COUNT(*) FROM mappings WHERE field = ?", (target.column,)
            ).fetchone()
            return row[0], "via mappings.field"
        return -1, "neither field_id nor field column present on mappings"

    return -1, f"unknown kind {target.kind!r}"


def classify(target: AuditTarget, actual: int, note: str) -> AuditResult:
    """Convert a raw count into a PASS / WARN / FAIL / SKIP result."""

    if actual < 0:
        # Schema problem (table or column missing) — always FAIL
        return AuditResult(target=target, actual=0, status="FAIL", note=note)

    if actual == 0:
        if target.required:
            return AuditResult(target=target, actual=0, status="FAIL", note=note or "zero rows")
        return AuditResult(target=target, actual=0, status="SKIP", note=note or "zero rows (optional)")

    if actual < target.min_rows:
        return AuditResult(
            target=target,
            actual=actual,
            status="WARN",
            note=f"undershoot: actual {actual:,} < min {target.min_rows:,}",
        )

    if target.max_rows is not None and actual > target.max_rows:
        return AuditResult(
            target=target,
            actual=actual,
            status="WARN",
            note=f"overshoot: actual {actual:,} > max {target.max_rows:,}",
        )

    return AuditResult(target=target, actual=actual, status="PASS", note=note)


def run_phase_audit(conn: sqlite3.Connection, phase: str) -> list[AuditResult]:
    """Run every EXPECTATIONS target tagged with the given phase."""

    results: list[AuditResult] = []
    for target in EXPECTATIONS:
        if target.phase != phase:
            continue
        actual, note = count_target(conn, target)
        results.append(classify(target, actual, note))
    return results


# ── Reporting ───────────────────────────────────────────────────────────────


def format_stdout_table(results: list[AuditResult], phase: str) -> None:
    """Print a one-phase audit table to stdout."""

    if not results:
        print(f"\n--- Audit ({phase}) ---  (no targets)")
        return

    name_width = max(len(r.target.name) for r in results)
    name_width = max(name_width, len("target"))

    print(f"\n--- Audit ({phase}) ---")
    print(f"  {'target'.ljust(name_width)}  status   actual          range")
    print(f"  {'-' * name_width}  -------  --------------  ---------------------------")

    for r in results:
        max_disp = "∞" if r.target.max_rows is None else f"{r.target.max_rows:,}"
        rng = f"{r.target.min_rows:,} – {max_disp}"
        actual_disp = f"{r.actual:,}" if r.actual else "0"
        print(
            f"  {r.target.name.ljust(name_width)}  "
            f"{r.status.ljust(7)}  "
            f"{actual_disp.rjust(14)}  {rng}"
        )
        if r.note and r.status != "PASS":
            print(f"  {' ' * name_width}    └ {r.note}")

    counts = _tally(results)
    summary = "  ".join(f"{k}={v}" for k, v in counts.items() if v)
    print(f"  → {summary}")


def _tally(results: Iterable[AuditResult]) -> dict[str, int]:
    counts = {"PASS": 0, "WARN": 0, "FAIL": 0, "SKIP": 0}
    for r in results:
        counts[r.status] += 1
    return counts


def _result_to_dict(r: AuditResult) -> dict:
    return {
        "target": r.target.name,
        "kind": r.target.kind,
        "table": r.target.table,
        "column": r.target.column,
        "expected_min": r.target.min_rows,
        "expected_max": r.target.max_rows,
        "actual": r.actual,
        "status": r.status,
        "rationale": r.target.rationale,
        "note": r.note,
        "required": r.target.required,
    }


def write_audit_json(
    path: Path,
    all_results: dict[str, list[AuditResult]],
    strict_mode: bool,
    version: str,
) -> dict:
    """Write the JSON artifact and return the meta block (for tests)."""

    flat = [r for results in all_results.values() for r in results]
    counts = _tally(flat)

    payload = {
        "meta": {
            "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "harvest_version": version,
            "strict_mode": strict_mode,
            "total_targets": len(flat),
            "pass": counts["PASS"],
            "warn": counts["WARN"],
            "fail": counts["FAIL"],
            "skip": counts["SKIP"],
        },
        "results_by_phase": {
            phase: [_result_to_dict(r) for r in results]
            for phase, results in all_results.items()
        },
    }

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2))
    return payload["meta"]


def final_summary(
    all_results: dict[str, list[AuditResult]],
    strict_mode: bool,
    version: str,
    json_path: Path | None = None,
) -> int:
    """Print a whole-run summary, write the JSON artifact, optionally exit non-zero.

    Returns the exit code that strict mode *would* use (0 or 1). The harvest
    script can call ``sys.exit(code)`` itself if it prefers; we also exit here
    when ``strict_mode`` is True and there are failures, so callers don't have
    to remember.
    """

    flat = [r for results in all_results.values() for r in results]
    counts = _tally(flat)

    print("\n=== Harvest audit summary ===")
    for phase, results in all_results.items():
        c = _tally(results)
        print(
            f"  {phase:<22}  PASS={c['PASS']:>3}  WARN={c['WARN']:>3}  "
            f"FAIL={c['FAIL']:>3}  SKIP={c['SKIP']:>3}"
        )
    print(
        f"  {'TOTAL':<22}  PASS={counts['PASS']:>3}  WARN={counts['WARN']:>3}  "
        f"FAIL={counts['FAIL']:>3}  SKIP={counts['SKIP']:>3}"
    )

    failures = [r for r in flat if r.status == "FAIL"]
    if failures:
        print("\n  Failures:")
        for r in failures:
            print(f"    - {r.target.name}: {r.note or 'zero rows'}")

    warnings = [r for r in flat if r.status == "WARN"]
    if warnings:
        print("\n  Warnings:")
        for r in warnings:
            print(f"    - {r.target.name}: {r.note}")

    if json_path is None:
        json_path = Path("data/audit") / f"harvest-audit-{version}.json"
    write_audit_json(json_path, all_results, strict_mode, version)
    print(f"\n  Audit JSON written to {json_path}")

    exit_code = 1 if (strict_mode and counts["FAIL"] > 0) else 0
    if exit_code:
        print(
            f"\n  --strict-audit: {counts['FAIL']} FAIL result(s) — exiting non-zero."
        )
        sys.exit(exit_code)
    return exit_code
