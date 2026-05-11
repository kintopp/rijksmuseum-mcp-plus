"""Phase-2 backfill of Rijks-supplied authority coordinates into
vocabulary.db, under the strict 'lat/long only from place IDs supplied by
the Rijksmuseum' policy.

Two buckets, both produced by upstream phases:

  TGN bucket
    Source : data/tgn-rdf-rijks-tgn-authoritative.csv
    Coords : tgn_lat / tgn_lon  (TGN-RDF response for the Rijks-supplied
             TGN ID, which matches the CSV's tgn_id)
    Detail : 'tgn_rdf_direct'  (em.TGN_RDF_DIRECT, AUTHORITY tier)

  Wikidata bucket
    Source : data/tgn-rdf-rijks-wikidata-coords.csv  (status='ok' only)
    Coords : wikidata_lat / wikidata_lon  (P625 of the Rijks-supplied QID)
    Detail : 'wikidata_p625'  (em.WIKIDATA_P625, AUTHORITY tier)

Defensive skips (in addition to whatever the upstream classifier already
excluded):
  - vocab_ids listed in data/backfills/curated-place-overrides.csv
  - rows where the current vocabulary row has coord_method='manual'

Idempotent: re-applying against the current DB is a no-op for rows that
already match the target state.

Usage:
    python3 scripts/apply_rijks_authority_coords.py --dry-run
    python3 scripts/apply_rijks_authority_coords.py --bucket tgn --dry-run
    python3 scripts/apply_rijks_authority_coords.py --verbose
    python3 scripts/apply_rijks_authority_coords.py
"""
import argparse
import csv
import sqlite3
import sys
from dataclasses import dataclass
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent
sys.path.insert(0, str(SCRIPT_DIR))
import enrichment_methods as em  # noqa: E402

DATA_DIR = PROJECT_DIR / "data"
DB_PATH = DATA_DIR / "vocabulary.db"

TGN_CSV = DATA_DIR / "tgn-rdf-rijks-tgn-authoritative.csv"
WIKIDATA_CSV = DATA_DIR / "tgn-rdf-rijks-wikidata-coords.csv"
OVERRIDES_CSV = DATA_DIR / "backfills" / "curated-place-overrides.csv"

DETAIL_BY_BUCKET = {
    "tgn": em.TGN_RDF_DIRECT,
    "wikidata": em.WIKIDATA_P625,
}


@dataclass
class Plan:
    vocab_id: str
    label: str
    bucket: str
    target_lat: float
    target_lon: float
    target_external_id: str
    target_detail: str
    target_method: str
    cur_lat: float | None
    cur_lon: float | None
    cur_external_id: str | None
    cur_method: str | None
    cur_detail: str | None
    will_change: bool
    skip_reason: str | None = None


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--dry-run", action="store_true",
                   help="Plan and report; do not write to DB.")
    p.add_argument("--bucket", choices=("tgn", "wikidata", "both"),
                   default="both")
    p.add_argument("--verbose", action="store_true",
                   help="Print full per-row diffs (default: summary + first 5).")
    p.add_argument("--db", type=Path, default=DB_PATH)
    return p.parse_args()


def load_excluded() -> set[str]:
    if not OVERRIDES_CSV.exists():
        return set()
    with OVERRIDES_CSV.open(newline="") as f:
        return {r["vocab_id"] for r in csv.DictReader(f)}


def fetch_state(conn: sqlite3.Connection, vid: str) -> dict | None:
    r = conn.execute(
        "SELECT id, label_en, label_nl, lat, lon, "
        "coord_method, coord_method_detail, external_id "
        "FROM vocabulary WHERE id = ?", (vid,)).fetchone()
    if r is None:
        return None
    return dict(zip(
        ["id", "label_en", "label_nl", "lat", "lon",
         "coord_method", "coord_method_detail", "external_id"],
        r,
    ))


def vei_has(conn: sqlite3.Connection, vid: str, authority: str, ext_id: str) -> bool:
    return conn.execute(
        "SELECT 1 FROM vocabulary_external_ids "
        "WHERE vocab_id = ? AND authority = ? AND id = ?",
        (vid, authority, ext_id)).fetchone() is not None


def plan_tgn_bucket(conn, excluded: set[str]) -> tuple[list[Plan], list[str]]:
    if not TGN_CSV.exists():
        return [], [f"missing {TGN_CSV}"]
    plans: list[Plan] = []
    errors: list[str] = []
    with TGN_CSV.open(newline="") as f:
        for r in csv.DictReader(f):
            vid = r["vocab_id"]
            if vid in excluded:
                continue
            try:
                target_lat = float(r["tgn_lat"])
                target_lon = float(r["tgn_lon"])
            except (ValueError, KeyError):
                errors.append(f"tgn:{vid}: bad tgn_lat/tgn_lon")
                continue
            target_uri = r.get("rijks_tgn_uri") \
                or f"http://vocab.getty.edu/tgn/{r['tgn_id']}"
            cur = fetch_state(conn, vid)
            if cur is None:
                errors.append(f"tgn:{vid}: not in vocabulary")
                continue
            if cur["coord_method"] == em.MANUAL:
                plans.append(_skip_plan(vid, cur, "tgn", target_lat, target_lon,
                                        target_uri, em.TGN_RDF_DIRECT,
                                        "current coord_method=manual"))
                continue
            tgn_local_id = target_uri.rstrip("/").rsplit("/", 1)[-1]
            if not vei_has(conn, vid, "tgn", tgn_local_id):
                errors.append(f"tgn:{vid}: TGN {tgn_local_id} not in VEI")
                continue
            plans.append(_make_plan(vid, cur, "tgn",
                                    target_lat, target_lon, target_uri,
                                    em.TGN_RDF_DIRECT))
    return plans, errors


def plan_wikidata_bucket(conn, excluded: set[str]) -> tuple[list[Plan], list[str]]:
    if not WIKIDATA_CSV.exists():
        return [], [f"missing {WIKIDATA_CSV}"]
    plans: list[Plan] = []
    errors: list[str] = []
    with WIKIDATA_CSV.open(newline="") as f:
        for r in csv.DictReader(f):
            vid = r["vocab_id"]
            if vid in excluded:
                continue
            if r.get("status") != "ok":
                continue  # no_p625 / error / invalid_qid → skip silently
            qid = r["qid"]
            try:
                target_lat = float(r["wikidata_lat"])
                target_lon = float(r["wikidata_lon"])
            except (ValueError, KeyError):
                errors.append(f"wd:{vid}: bad wikidata_lat/lon")
                continue
            target_uri = f"http://www.wikidata.org/entity/{qid}"
            cur = fetch_state(conn, vid)
            if cur is None:
                errors.append(f"wd:{vid}: not in vocabulary")
                continue
            if cur["coord_method"] == em.MANUAL:
                plans.append(_skip_plan(vid, cur, "wikidata", target_lat, target_lon,
                                        target_uri, em.WIKIDATA_P625,
                                        "current coord_method=manual"))
                continue
            if not vei_has(conn, vid, "wikidata", qid):
                errors.append(f"wd:{vid}: Wikidata {qid} not in VEI")
                continue
            plans.append(_make_plan(vid, cur, "wikidata",
                                    target_lat, target_lon, target_uri,
                                    em.WIKIDATA_P625))
    return plans, errors


def _make_plan(vid, cur, bucket, lat, lon, uri, detail) -> Plan:
    # Note: external_id is NOT in the change set. We only touch coords +
    # coord provenance. The vocabulary's primary external_id was chosen
    # by the harvest (Wikidata-preferred when present); changing it here
    # would silently invert that preference for a large subset.
    target_method = em.tier_for(detail)
    will_change = (
        cur["lat"] != lat or cur["lon"] != lon
        or cur["coord_method"] != target_method
        or cur["coord_method_detail"] != detail
    )
    return Plan(
        vocab_id=vid, label=cur["label_en"] or cur["label_nl"] or "∅",
        bucket=bucket,
        target_lat=lat, target_lon=lon,
        target_external_id=uri,
        target_detail=detail,
        target_method=target_method,
        cur_lat=cur["lat"], cur_lon=cur["lon"],
        cur_external_id=cur["external_id"],
        cur_method=cur["coord_method"],
        cur_detail=cur["coord_method_detail"],
        will_change=will_change,
    )


def _skip_plan(vid, cur, bucket, lat, lon, uri, detail, reason) -> Plan:
    target_method = em.tier_for(detail)
    return Plan(
        vocab_id=vid, label=cur["label_en"] or cur["label_nl"] or "∅",
        bucket=bucket,
        target_lat=lat, target_lon=lon,
        target_external_id=uri,
        target_detail=detail,
        target_method=target_method,
        cur_lat=cur["lat"], cur_lon=cur["lon"],
        cur_external_id=cur["external_id"],
        cur_method=cur["coord_method"],
        cur_detail=cur["coord_method_detail"],
        will_change=False,
        skip_reason=reason,
    )


def print_plan(plans: list[Plan], verbose: bool) -> None:
    by_bucket: dict[str, list[Plan]] = {}
    for p in plans:
        by_bucket.setdefault(p.bucket, []).append(p)

    for bucket, ps in by_bucket.items():
        skips = [p for p in ps if p.skip_reason]
        active = [p for p in ps if not p.skip_reason]
        coord_changes = [p for p in active
                         if p.cur_lat != p.target_lat or p.cur_lon != p.target_lon]
        external_changes = [p for p in active
                            if p.cur_external_id != p.target_external_id]
        provenance_only = [p for p in active
                           if p.will_change and p not in coord_changes
                           and p not in external_changes]
        no_ops = [p for p in active if not p.will_change]

        print(f"\n━━━ Bucket: {bucket}  ({len(ps)} candidate row(s)) ━━━")
        print(f"  coord rewrites:                  {len(coord_changes):>5}")
        print(f"  provenance-only writes:          {len(provenance_only):>5}")
        print(f"  already up-to-date:              {len(no_ops):>5}")
        print(f"  defensively skipped:             {len(skips):>5}")
        print(f"  external_id divergences (NOT    {len(external_changes):>5}")
        print(f"    written — left as harvest set them)")
        if skips:
            for p in skips:
                print(f"      SKIP {p.vocab_id} ({p.label}): {p.skip_reason}")

        sample = (active if verbose else active[:5])
        if sample:
            header = "all" if verbose else f"first {len(sample)}"
            print(f"\n  Diffs ({header}):")
            for p in sample:
                marker = "✓no-op" if not p.will_change else " "
                print(f"    [{marker}] {p.vocab_id} ({p.label})")
                if p.cur_lat != p.target_lat:
                    print(f"        lat   {p.cur_lat!r:<22} -> {p.target_lat!r}")
                if p.cur_lon != p.target_lon:
                    print(f"        lon   {p.cur_lon!r:<22} -> {p.target_lon!r}")
                if p.cur_external_id != p.target_external_id:
                    print(f"        ext   {p.cur_external_id!r:<60}")
                    print(f"           -> {p.target_external_id!r}")
                if p.cur_method != p.target_method:
                    print(f"        method   {p.cur_method!r} -> {p.target_method!r}")
                if p.cur_detail != p.target_detail:
                    print(f"        detail   {p.cur_detail!r} -> {p.target_detail!r}")


def apply_plans(conn: sqlite3.Connection, plans: list[Plan]) -> int:
    """Single transaction. Returns the number of rows actually written."""
    writes = [p for p in plans if p.will_change and not p.skip_reason]
    if not writes:
        return 0
    with conn:
        for p in writes:
            conn.execute(
                """
                UPDATE vocabulary SET
                    lat = ?, lon = ?,
                    coord_method = ?,
                    coord_method_detail = ?
                WHERE id = ?
                """,
                (p.target_lat, p.target_lon,
                 p.target_method, p.target_detail, p.vocab_id),
            )
    return len(writes)


def verify(conn: sqlite3.Connection, plans: list[Plan]) -> int:
    """Re-read each written row and confirm target state. Returns # mismatches."""
    bad = 0
    for p in plans:
        if p.skip_reason or not p.will_change:
            continue
        cur = fetch_state(conn, p.vocab_id)
        if (cur is None
                or cur["lat"] != p.target_lat
                or cur["lon"] != p.target_lon
                or cur["coord_method"] != p.target_method
                or cur["coord_method_detail"] != p.target_detail):
            print(f"  [FAIL] {p.vocab_id} ({p.label}): post-write state mismatch")
            bad += 1
    return bad


def main() -> int:
    args = parse_args()
    excluded = load_excluded()
    print(f"Excluded vocab_ids (from {OVERRIDES_CSV.name}): {sorted(excluded)}")

    conn = sqlite3.connect(str(args.db))

    all_plans: list[Plan] = []
    all_errors: list[str] = []
    if args.bucket in ("tgn", "both"):
        plans, errors = plan_tgn_bucket(conn, excluded)
        all_plans += plans
        all_errors += errors
    if args.bucket in ("wikidata", "both"):
        plans, errors = plan_wikidata_bucket(conn, excluded)
        all_plans += plans
        all_errors += errors

    print_plan(all_plans, args.verbose)

    if all_errors:
        print(f"\n=== {len(all_errors)} validation error(s) ===", file=sys.stderr)
        for e in all_errors[:20]:
            print(f"  {e}", file=sys.stderr)
        if len(all_errors) > 20:
            print(f"  ... and {len(all_errors) - 20} more", file=sys.stderr)
        return 1

    writes_planned = sum(1 for p in all_plans if p.will_change and not p.skip_reason)
    if args.dry_run:
        print(f"\n[dry-run] would write {writes_planned} row(s). "
              "Re-run without --dry-run to commit.")
        conn.close()
        return 0

    print(f"\nApplying {writes_planned} update(s)...")
    written = apply_plans(conn, all_plans)
    print(f"Wrote {written} row(s).")

    print("Verifying...")
    bad = verify(conn, all_plans)
    print(f"  Verification: {written - bad} OK, {bad} FAIL")
    conn.close()
    return 0 if bad == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
