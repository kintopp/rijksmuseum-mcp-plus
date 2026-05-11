#!/usr/bin/env python3
"""Apply curated place-identification overrides from
``data/backfills/curated-place-overrides.csv`` to ``data/vocabulary.db``.

Each CSV row records a manual decision to use a reconciled TGN ID +
coordinates instead of the one Rijksmuseum's place dump publishes. Rows lock
their target via ``coord_method='manual'`` + ``coord_method_detail=<override_kind>``,
which protects them from future TGN-RDF revalidation passes.

The CSV is the system of record. Re-applying it against the current DB is a
no-op. After every full re-harvest, run this script as part of
``scripts/POST-REPARSE-STEPS.md`` to restore the overrides.

Usage:
    python3 scripts/apply_curated_place_overrides.py             # apply
    python3 scripts/apply_curated_place_overrides.py --dry-run   # report only
"""
import argparse
import csv
import sqlite3
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent
sys.path.insert(0, str(SCRIPT_DIR))
import enrichment_methods as em  # noqa: E402

CSV_PATH = PROJECT_DIR / "data" / "backfills" / "curated-place-overrides.csv"
DB_PATH = PROJECT_DIR / "data" / "vocabulary.db"

ALLOWED_OVERRIDE_KINDS = {
    em.RECONCILED_REVIEW_ACCEPTED,
    em.WHG_REVIEW_ACCEPTED,
    em.WHG_BRIDGE_REVIEW_ACCEPTED,
    em.WOF_REVIEW_ACCEPTED,
    em.MANUAL_CENTROID,
}

# Override kinds where reject_tgn/accept_tgn fields are not meaningful
# (no TGN swap is happening — we're just supplying a manual coord). For
# these rows, the TGN-presence-in-VEI validation is also skipped.
NO_TGN_SWAP_KINDS = {em.MANUAL_CENTROID}

REQUIRED_COLS = (
    "vocab_id", "label", "override_kind",
    "reject_tgn", "accept_tgn",
    "lat", "lon", "placetype_aat",
    "reviewed_by", "reviewed_at", "evidence",
)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--dry-run", action="store_true",
                   help="Report planned changes; do not write to DB.")
    p.add_argument("--csv", type=Path, default=CSV_PATH)
    p.add_argument("--db", type=Path, default=DB_PATH)
    return p.parse_args()


def load_overrides(path: Path) -> list[dict]:
    if not path.exists():
        sys.exit(f"missing {path}")
    with path.open(newline="") as f:
        rows = list(csv.DictReader(f))
    if not rows:
        sys.exit(f"{path}: no rows")
    missing = [c for c in REQUIRED_COLS if c not in rows[0]]
    if missing:
        sys.exit(f"{path}: missing columns: {missing}")
    bad = [r["vocab_id"] for r in rows
           if r["override_kind"] not in ALLOWED_OVERRIDE_KINDS]
    if bad:
        sys.exit(f"{path}: unknown override_kind for vocab_ids {bad}; "
                 f"allowed: {sorted(ALLOWED_OVERRIDE_KINDS)}")
    return rows


def fetch_current(conn: sqlite3.Connection, vocab_id: str) -> dict | None:
    r = conn.execute(
        """
        SELECT id, label_en, label_nl, lat, lon,
               coord_method, coord_method_detail,
               external_id, placetype, placetype_source
        FROM vocabulary WHERE id = ?
        """,
        (vocab_id,),
    ).fetchone()
    if r is None:
        return None
    return dict(zip(
        ["id", "label_en", "label_nl", "lat", "lon",
         "coord_method", "coord_method_detail",
         "external_id", "placetype", "placetype_source"],
        r,
    ))


def vei_has_tgn(conn: sqlite3.Connection, vocab_id: str, tgn_id: str) -> bool:
    r = conn.execute(
        "SELECT 1 FROM vocabulary_external_ids "
        "WHERE vocab_id = ? AND authority = 'tgn' AND id = ?",
        (vocab_id, tgn_id),
    ).fetchone()
    return r is not None


def diff_line(label: str, before, after) -> str:
    if before == after:
        return f"      {label:<22} {before!r}  (unchanged)"
    return f"      {label:<22} {before!r}  ->  {after!r}"


def main() -> int:
    args = parse_args()
    overrides = load_overrides(args.csv)
    print(f"Loaded {len(overrides)} override(s) from {args.csv.name}\n")

    conn = sqlite3.connect(str(args.db))
    conn.execute("PRAGMA foreign_keys = ON")

    plans: list[tuple[dict, dict, str]] = []  # (override_row, current, target_external_id)
    errors: list[str] = []

    for o in overrides:
        vid = o["vocab_id"]
        cur = fetch_current(conn, vid)
        if cur is None:
            errors.append(f"vocab_id {vid}: not found in vocabulary table")
            continue

        is_tgn_swap = o["override_kind"] not in NO_TGN_SWAP_KINDS
        if is_tgn_swap:
            if not vei_has_tgn(conn, vid, o["accept_tgn"]):
                errors.append(
                    f"vocab_id {vid}: accept_tgn {o['accept_tgn']} not present "
                    "in vocabulary_external_ids — cannot promote a TGN ID the "
                    "DB doesn't know about."
                )
                continue
            target_external = f"http://vocab.getty.edu/tgn/{o['accept_tgn']}"
        else:
            # No TGN swap — keep whatever external_id the harvest set.
            target_external = cur["external_id"]
        target_lat = float(o["lat"])
        target_lon = float(o["lon"])
        target_placetype = o["placetype_aat"] or cur["placetype"]
        target_kind = o["override_kind"]

        print(f"━━━ vocab_id={vid}  ({o['label']})  by {o['reviewed_by']} "
              f"on {o['reviewed_at']} ━━━")
        if is_tgn_swap:
            print(f"   reject_tgn={o['reject_tgn']}  accept_tgn={o['accept_tgn']}")
        else:
            print(f"   override_kind={target_kind}  (no TGN swap; "
                  f"external_id left as harvest set it)")
        print(diff_line("lat",                  cur["lat"],                  target_lat))
        print(diff_line("lon",                  cur["lon"],                  target_lon))
        if is_tgn_swap:
            print(diff_line("external_id",      cur["external_id"],          target_external))
        print(diff_line("coord_method",         cur["coord_method"],         em.MANUAL))
        print(diff_line("coord_method_detail",  cur["coord_method_detail"],  target_kind))
        print(diff_line("placetype",            cur["placetype"],            target_placetype))
        print(diff_line("placetype_source",     cur["placetype_source"],     em.MANUAL))
        print(f"   evidence: {o['evidence']}")
        print()
        plans.append((o, cur, target_external))

    if errors:
        print("=== Errors ===", file=sys.stderr)
        for e in errors:
            print(f"  {e}", file=sys.stderr)
        return 1

    if args.dry_run:
        print(f"[dry-run] {len(plans)} override(s) would be applied. "
              "Re-run without --dry-run to commit.")
        conn.close()
        return 0

    print(f"Applying {len(plans)} override(s) to {args.db}...")
    with conn:
        for o, _cur, target_external in plans:
            target_placetype = o["placetype_aat"] or None
            is_tgn_swap = o["override_kind"] not in NO_TGN_SWAP_KINDS
            if is_tgn_swap:
                conn.execute(
                    """
                    UPDATE vocabulary SET
                        lat = ?,
                        lon = ?,
                        external_id = ?,
                        coord_method = ?,
                        coord_method_detail = ?,
                        placetype = COALESCE(?, placetype),
                        placetype_source = ?
                    WHERE id = ?
                    """,
                    (
                        float(o["lat"]),
                        float(o["lon"]),
                        target_external,
                        em.MANUAL,
                        o["override_kind"],
                        target_placetype,
                        em.MANUAL,
                        o["vocab_id"],
                    ),
                )
            else:
                # MANUAL_CENTROID: no external_id swap; clear is_areal since
                # we're now providing a centroid coord.
                conn.execute(
                    """
                    UPDATE vocabulary SET
                        lat = ?,
                        lon = ?,
                        coord_method = ?,
                        coord_method_detail = ?,
                        placetype = COALESCE(?, placetype),
                        placetype_source = ?,
                        is_areal = 0
                    WHERE id = ?
                    """,
                    (
                        float(o["lat"]),
                        float(o["lon"]),
                        em.MANUAL,
                        o["override_kind"],
                        target_placetype,
                        em.MANUAL,
                        o["vocab_id"],
                    ),
                )

    print("Verifying post-write state...")
    for o, _cur, target_external in plans:
        after = fetch_current(conn, o["vocab_id"])
        is_tgn_swap = o["override_kind"] not in NO_TGN_SWAP_KINDS
        ok = (
            after["lat"] == float(o["lat"])
            and after["lon"] == float(o["lon"])
            and (after["external_id"] == target_external if is_tgn_swap else True)
            and after["coord_method"] == em.MANUAL
            and after["coord_method_detail"] == o["override_kind"]
            and after["placetype_source"] == em.MANUAL
        )
        marker = "OK" if ok else "FAIL"
        print(f"  [{marker}] {o['vocab_id']} ({o['label']})")
        if not ok:
            print(f"        actual: {after}", file=sys.stderr)

    conn.close()
    print(f"\nApplied {len(plans)} override(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
