"""Phase-2-extended (TGN edition): promote 'inferred + reconciliation' rows
that have a Rijks-supplied TGN ID in VEI but were never written to
'deterministic' by the original TGN-RDF revalidation pass (likely because
that script's Branch A 'provenance upgrade' path didn't update
coord_method).

Mirrors promote_inferred_via_rijks_wikidata.py exactly, but the authority
is TGN (fetched via per-entity RDF dereferencing).

Eligibility:
  - vocabulary.coord_method = 'inferred'
  - vocabulary.coord_method_detail IN (
        'v0.25-snapshot-backfill:whg_reconciliation',
        'v0.25-snapshot-backfill:wikidata_reconciliation')
  - vocab_id has authority='tgn' in vocabulary_external_ids
  - the TGN ID is ALSO published by Rijksmuseum's 2025 places dump
    (i.e. NOT a reconciliation-introduced TGN ID)
  - current coord_method != 'manual' (defensive)

For each eligible row:
  1. Pick the first Rijks-supplied TGN ID for the place (a place can have
     multiple TGN concordances; we use the Rijks-published one).
  2. Fetch TGN-RDF for that ID via batch_geocode.geocode_getty_rdf
     (parallel keep-alive sessions). Cached in
     data/inferred-rijks-tgn-coords.csv.
  3. If TGN returns coords: apply coord rewrite + tier promotion:
        coord_method        -> 'deterministic'
        coord_method_detail -> 'tgn_rdf_direct'
        lat / lon           -> TGN-RDF coords
  4. If no coords / fetch error: row stays as-is.

Idempotent. The cache file is harvest-resilient — re-running after a
fresh harvest re-uses cached coords for known TGN IDs.

Usage:
    python3 scripts/promote_inferred_via_rijks_tgn.py --dry-run
    python3 scripts/promote_inferred_via_rijks_tgn.py
    python3 scripts/promote_inferred_via_rijks_tgn.py --skip-fetch
"""
import argparse
import csv
import re
import sqlite3
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent
sys.path.insert(0, str(SCRIPT_DIR))
import enrichment_methods as em  # noqa: E402
import batch_geocode as bg       # noqa: E402  — reuse TGN-RDF parser/fetcher

DATA_DIR = PROJECT_DIR / "data"
DB_PATH = DATA_DIR / "vocabulary.db"
COORDS_CACHE = DATA_DIR / "inferred-rijks-tgn-coords.csv"
DUMP_DIR = Path.home() / "Downloads" / "rijksmuseum-data-dumps" / "place_extracted"

ELIGIBLE_DETAILS = (
    "v0.25-snapshot-backfill:whg_reconciliation",
    "v0.25-snapshot-backfill:wikidata_reconciliation",
)

CACHE_FIELDS = (
    "vocab_id", "label", "tgn_id",
    "existing_lat", "existing_lon", "existing_method_detail",
    "tgn_lat", "tgn_lon", "status", "notes",
)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--skip-fetch", action="store_true",
                   help="Skip TGN-RDF fetch entirely; use cache only.")
    p.add_argument("--max-workers", type=int, default=6)
    p.add_argument("--db", type=Path, default=DB_PATH)
    return p.parse_args()


def load_excluded() -> set[str]:
    # curated-place-overrides.csv retired 2026-05-11 (two-tier geo policy);
    # the 'manual' tier is gone, so nothing is excluded any more.
    return set()


def load_cache() -> dict[str, dict]:
    if not COORDS_CACHE.exists():
        return {}
    with COORDS_CACHE.open(newline="") as f:
        return {r["vocab_id"]: r for r in csv.DictReader(f)}


def write_cache(rows: dict[str, dict]) -> None:
    with COORDS_CACHE.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=CACHE_FIELDS, quoting=csv.QUOTE_MINIMAL)
        w.writeheader()
        for vid in sorted(rows):
            w.writerow({k: rows[vid].get(k, "") for k in CACHE_FIELDS})


def make_subject_uri_re(place_id: str) -> re.Pattern:
    return re.compile(
        rf"<https://id\.rijksmuseum\.nl/{re.escape(place_id)}>\s+"
        rf"<http[^>]+>\s+"
        rf"<(http[^>]+)>"
    )


def rijks_published_tgn_ids(vocab_id: str) -> set[str]:
    """Return the set of TGN IDs Rijksmuseum publishes for this place via
    its place dump's equivalent/sameAs predicates."""
    fpath = DUMP_DIR / vocab_id
    if not fpath.exists():
        return set()
    text = fpath.read_text()
    out: set[str] = set()
    for m in make_subject_uri_re(vocab_id).finditer(text):
        obj = m.group(1)
        if "vocab.getty.edu/tgn/" in obj:
            out.add(obj.rstrip("/").rsplit("/", 1)[-1])
    return out


def fetch_eligible(conn: sqlite3.Connection,
                   excluded: set[str]) -> list[tuple[str, str, str]]:
    """Return [(vocab_id, label, rijks_supplied_tgn_id)]. For places with
    multiple Rijks-supplied TGNs, picks the lexicographically first."""
    placeholders = ",".join("?" * len(ELIGIBLE_DETAILS))
    rows = conn.execute(
        f"""
        SELECT v.id,
               COALESCE(v.label_en, v.label_nl, '∅') AS label,
               vei.id AS tgn_id
        FROM vocabulary v
        JOIN vocabulary_external_ids vei
          ON vei.vocab_id = v.id AND vei.authority = 'tgn'
        WHERE v.type = 'place'
          AND v.coord_method = 'inferred'
          AND v.coord_method_detail IN ({placeholders})
        ORDER BY v.id
        """,
        ELIGIBLE_DETAILS,
    ).fetchall()

    # Group VEI rows per place; intersect with Rijks dump.
    per_place: dict[str, dict] = {}
    for vid, label, tgn in rows:
        e = per_place.setdefault(vid, {"label": label, "vei_tgns": set()})
        e["vei_tgns"].add(tgn)

    out: list[tuple[str, str, str]] = []
    for vid, info in per_place.items():
        if vid in excluded:
            continue
        rijks_set = rijks_published_tgn_ids(vid)
        eligible_tgns = sorted(info["vei_tgns"] & rijks_set)
        if not eligible_tgns:
            continue
        out.append((vid, info["label"], eligible_tgns[0]))
    return out


def fetch_state(conn, vid):
    r = conn.execute(
        "SELECT lat, lon, coord_method, coord_method_detail "
        "FROM vocabulary WHERE id = ?", (vid,)).fetchone()
    if r is None:
        return None
    return {"lat": r[0], "lon": r[1], "coord_method": r[2],
            "coord_method_detail": r[3]}


def main() -> int:
    args = parse_args()
    excluded = load_excluded()

    conn = sqlite3.connect(str(args.db))
    eligible = fetch_eligible(conn, excluded)
    print(f"Eligible rows: {len(eligible)}\n")

    cache = load_cache()
    print(f"Cache: {len(cache)} row(s) in {COORDS_CACHE.name}")

    # Phase 1: TGN-RDF fetch for any eligible row not in cache (or previously
    # errored). Re-uses batch_geocode.geocode_getty_rdf for parallel fetches.
    to_fetch = []
    for vid, label, tgn_id in eligible:
        cur = cache.get(vid)
        if cur is None or cur.get("status") in ("error", ""):
            to_fetch.append((vid, label, tgn_id))

    if args.skip_fetch:
        print(f"--skip-fetch: skipping {len(to_fetch)} fetch(es).")
    elif to_fetch:
        # batch_geocode expects places list of dicts with 'id' + 'external_id'.
        places = [{"id": vid,
                   "external_id": f"http://vocab.getty.edu/tgn/{tgn_id}"}
                  for vid, _label, tgn_id in to_fetch]
        print(f"Fetching TGN-RDF for {len(places)} unique places "
              f"(workers={args.max_workers})...")
        records = bg.geocode_getty_rdf(places, max_workers=args.max_workers)
        for vid, label, tgn_id in to_fetch:
            rec = records.get(vid)
            db_state = fetch_state(conn, vid)
            base = {
                "vocab_id": vid, "label": label, "tgn_id": tgn_id,
                "existing_lat": str(db_state["lat"]) if db_state else "",
                "existing_lon": str(db_state["lon"]) if db_state else "",
                "existing_method_detail":
                    db_state["coord_method_detail"] if db_state else "",
            }
            if rec is None or rec.fetch_error:
                cache[vid] = {**base, "tgn_lat": "", "tgn_lon": "",
                              "status": "error",
                              "notes": (rec.fetch_error if rec else "no_record")}
            elif rec.lat is None or rec.lon is None:
                cache[vid] = {**base, "tgn_lat": "", "tgn_lon": "",
                              "status": "no_coords",
                              "notes": "TGN entity has no wgs:lat/long"}
            else:
                cache[vid] = {**base,
                              "tgn_lat": f"{rec.lat:.6f}",
                              "tgn_lon": f"{rec.lon:.6f}",
                              "status": "ok", "notes": ""}
        write_cache(cache)
        print(f"Wrote {COORDS_CACHE.name}")

    # Phase 2: plan applies from cache.
    plans: list[dict] = []
    skips: list[tuple[str, str]] = []
    for vid, label, tgn_id in eligible:
        c = cache.get(vid)
        if c is None or c.get("status") != "ok":
            skips.append((vid, c.get("status") if c else "no-cache"))
            continue
        cur = fetch_state(conn, vid)
        if cur is None:
            skips.append((vid, "vocab missing")); continue
        if cur["coord_method"] == em.MANUAL:
            skips.append((vid, "manual lock")); continue
        target_lat = float(c["tgn_lat"])
        target_lon = float(c["tgn_lon"])
        plans.append({
            "vocab_id": vid, "label": label, "tgn_id": tgn_id,
            "cur_lat": cur["lat"], "cur_lon": cur["lon"],
            "cur_detail": cur["coord_method_detail"],
            "target_lat": target_lat, "target_lon": target_lon,
            "target_detail": em.TGN_RDF_DIRECT,
            "target_method": em.tier_for(em.TGN_RDF_DIRECT),
        })

    coord_changes = [p for p in plans
                     if p["cur_lat"] != p["target_lat"]
                     or p["cur_lon"] != p["target_lon"]]
    provenance_only = [p for p in plans if p not in coord_changes]
    print(f"\n━━━ Phase-2 plan ━━━")
    print(f"  eligible (cached + ok):     {len(plans)}")
    print(f"  coord rewrites:             {len(coord_changes)}")
    print(f"  provenance-only writes:     {len(provenance_only)}")
    print(f"  skips:                      {len(skips)}")
    if skips:
        skip_buckets: dict[str, int] = {}
        for _, why in skips:
            skip_buckets[why] = skip_buckets.get(why, 0) + 1
        for why, n in sorted(skip_buckets.items(), key=lambda kv: -kv[1]):
            print(f"      {why}: {n}")

    print("\n  Sample diffs (first 5):")
    for p in plans[:5]:
        print(f"    {p['vocab_id']} ({p['label']}) tgn={p['tgn_id']}")
        print(f"        coord  {p['cur_lat']!r:<22} -> {p['target_lat']!r}")
        print(f"               {p['cur_lon']!r:<22} -> {p['target_lon']!r}")
        print(f"        detail {p['cur_detail']!r}")
        print(f"            -> {p['target_detail']!r}")

    if args.dry_run:
        print(f"\n[dry-run] would write {len(plans)} row(s).")
        conn.close()
        return 0

    if not plans:
        print("\nNothing to apply.")
        conn.close()
        return 0

    print(f"\nApplying {len(plans)} promotions...")
    with conn:
        for p in plans:
            conn.execute(
                """
                UPDATE vocabulary SET
                    lat = ?, lon = ?,
                    coord_method = ?, coord_method_detail = ?
                WHERE id = ? AND coord_method = 'inferred'
                """,
                (p["target_lat"], p["target_lon"],
                 p["target_method"], p["target_detail"], p["vocab_id"]),
            )

    print("Verifying...")
    bad = 0
    for p in plans:
        cur = fetch_state(conn, p["vocab_id"])
        if (cur is None
                or cur["lat"] != p["target_lat"]
                or cur["lon"] != p["target_lon"]
                or cur["coord_method"] != p["target_method"]
                or cur["coord_method_detail"] != p["target_detail"]):
            print(f"  [FAIL] {p['vocab_id']} ({p['label']})", file=sys.stderr)
            bad += 1
    print(f"  Verification: {len(plans) - bad} OK, {bad} FAIL")
    conn.close()
    return 0 if bad == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
