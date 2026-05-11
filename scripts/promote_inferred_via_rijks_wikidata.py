"""Phase-2-extended: promote 'inferred' places that have a Rijks-supplied
Wikidata QID in VEI but were NEVER in the TGN-RDF discrepancies CSV
(because they have no Rijks-supplied TGN to revalidate against).

Eligibility:
  - vocabulary.coord_method = 'inferred'
  - vocabulary.coord_method_detail IN (
        'v0.25-snapshot-backfill:whg_reconciliation',
        'v0.25-snapshot-backfill:wikidata_reconciliation')
  - vocab_id has authority='wikidata' in vocabulary_external_ids
  - current coord_method != 'manual' (defensive)

For each eligible row:
  1. Fetch Wikidata P625 (preferred>normal rank) for the Rijks-supplied QID
     via the per-entity REST API. Coords cached in
     data/inferred-rijks-wikidata-coords.csv for re-runnability.
  2. If P625 returns coords: apply coord rewrite + tier promotion:
        coord_method        -> 'deterministic'
        coord_method_detail -> 'wikidata_p625'
        lat / lon           -> Wikidata's coords
  3. If no P625 / fetch error: row stays as-is (left for future).

Idempotent (re-running is a no-op once promoted; uses --resume on cached
coords). Output CSV serves as both audit trail and harvest-resilient cache.

Usage:
    python3 scripts/promote_inferred_via_rijks_wikidata.py --dry-run
    python3 scripts/promote_inferred_via_rijks_wikidata.py
    python3 scripts/promote_inferred_via_rijks_wikidata.py --skip-fetch  # use cache only
"""
import argparse
import csv
import json
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent
sys.path.insert(0, str(SCRIPT_DIR))
import enrichment_methods as em  # noqa: E402

DATA_DIR = PROJECT_DIR / "data"
DB_PATH = DATA_DIR / "vocabulary.db"
COORDS_CACHE = DATA_DIR / "inferred-rijks-wikidata-coords.csv"

ELIGIBLE_DETAILS = (
    "v0.25-snapshot-backfill:whg_reconciliation",
    "v0.25-snapshot-backfill:wikidata_reconciliation",
)

ENTITY_DATA_URL = "https://www.wikidata.org/wiki/Special:EntityData/{qid}.json"
USER_AGENT = ("rijksmuseum-mcp-plus/0.30 "
              "(https://github.com/kintopp/rijksmuseum-mcp-plus; "
              "arno.bosse@gmail.com)")
INTER_REQUEST_DELAY = 0.6
TIMEOUT = 30

CACHE_FIELDS = (
    "vocab_id", "label", "qid",
    "existing_lat", "existing_lon", "existing_method_detail",
    "wikidata_lat", "wikidata_lon", "status", "notes",
)

RE_QID_FROM_VEI = re.compile(r"^Q\d+$")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--skip-fetch", action="store_true",
                   help="Skip Wikidata fetch entirely; use cache only.")
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


def fetch_eligible(conn: sqlite3.Connection,
                   excluded: set[str]) -> list[tuple[str, str, str]]:
    """Return [(vocab_id, label, qid)] for places eligible for promotion."""
    placeholders = ",".join("?" * len(ELIGIBLE_DETAILS))
    rows = conn.execute(
        f"""
        SELECT v.id, COALESCE(v.label_en, v.label_nl, '∅') AS label,
               vei.id AS qid
        FROM vocabulary v
        JOIN vocabulary_external_ids vei
          ON vei.vocab_id = v.id AND vei.authority = 'wikidata'
        WHERE v.type = 'place'
          AND v.coord_method = 'inferred'
          AND v.coord_method_detail IN ({placeholders})
        ORDER BY v.id
        """,
        ELIGIBLE_DETAILS,
    ).fetchall()
    out = []
    for vid, label, qid in rows:
        if vid in excluded:
            continue
        if not RE_QID_FROM_VEI.match(qid or ""):
            continue
        out.append((vid, label, qid))
    return out


def fetch_p625(qid: str) -> tuple[tuple[float, float] | None, str, str]:
    url = ENTITY_DATA_URL.format(qid=qid)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            data = json.loads(resp.read())
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as exc:
        return None, "error", f"fetch failed: {exc}"
    entities = data.get("entities", {}) or {}
    if qid in entities:
        ent = entities[qid]; notes = ""
    elif len(entities) == 1:
        canonical = next(iter(entities)); ent = entities[canonical]
        notes = f"redirected: {qid} -> {canonical}"
    else:
        return None, "error", f"unexpected entities payload: {list(entities)}"
    claims = (ent.get("claims") or {}).get("P625") or []
    if not claims:
        return None, "no_p625", notes or "Entity has no P625 coordinate"
    preferred = [c for c in claims if c.get("rank") == "preferred"]
    normal = [c for c in claims if c.get("rank") == "normal"]
    pool = preferred or normal
    if not pool:
        return None, "no_p625", notes or "Only deprecated P625 claims"
    snak = pool[0].get("mainsnak") or {}
    if snak.get("snaktype") != "value":
        return None, "no_p625", notes or "P625 has snaktype != value"
    val = ((snak.get("datavalue") or {}).get("value") or {})
    lat, lon = val.get("latitude"), val.get("longitude")
    if lat is None or lon is None:
        return None, "error", notes or "P625 value missing lat/lon"
    return (float(lat), float(lon)), "ok", notes


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

    # Phase 1: ensure each eligible vocab_id has a cache entry. Fetch
    # Wikidata P625 for any that's missing or previously errored.
    to_fetch: list[tuple[str, str, str]] = []
    for vid, label, qid in eligible:
        cur = cache.get(vid)
        if cur is None or cur.get("status") in ("error", ""):
            to_fetch.append((vid, label, qid))

    if args.skip_fetch:
        print(f"--skip-fetch: skipping {len(to_fetch)} fetch(es).")
    elif to_fetch:
        print(f"Fetching P625 for {len(to_fetch)} QIDs "
              f"(~{len(to_fetch) * INTER_REQUEST_DELAY:.0f}s ETA)...")
        started = time.time()
        for i, (vid, label, qid) in enumerate(to_fetch, 1):
            coord, status, notes = fetch_p625(qid)
            db_state = fetch_state(conn, vid)
            cache[vid] = {
                "vocab_id": vid, "label": label, "qid": qid,
                "existing_lat": str(db_state["lat"]) if db_state else "",
                "existing_lon": str(db_state["lon"]) if db_state else "",
                "existing_method_detail":
                    db_state["coord_method_detail"] if db_state else "",
                "wikidata_lat": f"{coord[0]:.6f}" if coord else "",
                "wikidata_lon": f"{coord[1]:.6f}" if coord else "",
                "status": status, "notes": notes,
            }
            if i % 25 == 0 or i == len(to_fetch):
                elapsed = time.time() - started
                rate = i / elapsed if elapsed else 0
                eta = (len(to_fetch) - i) / rate if rate else 0
                ok = sum(1 for r in cache.values() if r["status"] == "ok")
                print(f"  {i}/{len(to_fetch)}  ok-cumulative={ok} "
                      f"({rate:.1f}/s, ETA {eta:.0f}s)")
            time.sleep(INTER_REQUEST_DELAY)
        write_cache(cache)
        print(f"Wrote {COORDS_CACHE.name}")

    # Phase 2: plan applies from cache.
    plans: list[dict] = []
    skips: list[tuple[str, str]] = []
    for vid, label, qid in eligible:
        c = cache.get(vid)
        if c is None or c.get("status") != "ok":
            skips.append((vid, c.get("status") if c else "no-cache"))
            continue
        cur = fetch_state(conn, vid)
        if cur is None:
            skips.append((vid, "vocab missing")); continue
        if cur["coord_method"] == em.MANUAL:
            skips.append((vid, "manual lock")); continue
        target_lat = float(c["wikidata_lat"])
        target_lon = float(c["wikidata_lon"])
        plans.append({
            "vocab_id": vid, "label": label, "qid": qid,
            "cur_lat": cur["lat"], "cur_lon": cur["lon"],
            "cur_detail": cur["coord_method_detail"],
            "target_lat": target_lat, "target_lon": target_lon,
            "target_detail": em.WIKIDATA_P625,
            "target_method": em.tier_for(em.WIKIDATA_P625),
        })

    # Bucket by change-type for the summary.
    coord_changes = [p for p in plans
                     if p["cur_lat"] != p["target_lat"]
                     or p["cur_lon"] != p["target_lon"]]
    provenance_only = [p for p in plans if p not in coord_changes]
    print(f"\n━━━ Phase-2 plan ━━━")
    print(f"  eligible (cached + fetchable): {len(plans)}")
    print(f"  coord rewrites:                {len(coord_changes)}")
    print(f"  provenance-only writes:        {len(provenance_only)}")
    print(f"  skips:                         {len(skips)}")
    if skips and len(skips) <= 20:
        for vid, why in skips:
            print(f"      SKIP {vid}: {why}")
    elif skips:
        for vid, why in skips[:10]:
            print(f"      SKIP {vid}: {why}")
        print(f"      ... +{len(skips) - 10} more")

    # Show a few sample diffs.
    print("\n  Sample diffs (first 5):")
    for p in plans[:5]:
        print(f"    {p['vocab_id']} ({p['label']}) qid={p['qid']}")
        print(f"        coord  {p['cur_lat']!r:<22} -> {p['target_lat']!r}")
        print(f"               {p['cur_lon']!r:<22} -> {p['target_lon']!r}")
        print(f"        detail {p['cur_detail']!r}")
        print(f"            -> {p['target_detail']!r}")

    if args.dry_run:
        print(f"\n[dry-run] would write {len(plans)} row(s). "
              "Re-run without --dry-run to commit.")
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
