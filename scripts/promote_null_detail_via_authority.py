"""Promote NULL-detail inferred-tier places to the AUTHORITY tier by
fetching coords from any Rijks-supplied authority in VEI and overwriting
the existing coord.

Eligibility:
  - vocabulary.coord_method = 'inferred'
  - vocabulary.coord_method_detail IS NULL
  - vocab_id has a probeable authority in VEI: Wikidata, TGN, or GeoNames
  - current coord_method != 'manual' (defensive)

Authority precedence per place (the *first* one with a successful coord
fetch wins):
  Wikidata > TGN > GeoNames

This is the 'aggressive' variant: it rewrites the existing coord with
the authority's coord regardless of how far they disagree. The
diagnostic argument from the probe was that NULL-detail rows lacking
provenance and disagreeing with their Rijks-supplied authority are
overwhelmingly Layer-A parent-fallback artifacts (round-number coords
like (53.0, -2.0)) — the authority's coord is almost always more
correct.

Cache: data/null-detail-authority-coords.csv (harvest-resilient).

Usage:
    python3 scripts/promote_null_detail_via_authority.py --dry-run
    python3 scripts/promote_null_detail_via_authority.py
    python3 scripts/promote_null_detail_via_authority.py --skip-fetch
"""
import argparse
import csv
import json
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent
sys.path.insert(0, str(SCRIPT_DIR))
import enrichment_methods as em  # noqa: E402
import batch_geocode as bg  # noqa: E402

DATA_DIR = PROJECT_DIR / "data"
DB_PATH = DATA_DIR / "vocabulary.db"
CACHE_CSV = DATA_DIR / "null-detail-authority-coords.csv"
ENV_FILE = PROJECT_DIR / ".env"

USER_AGENT = ("rijksmuseum-mcp-plus/0.30 "
              "(https://github.com/kintopp/rijksmuseum-mcp-plus; "
              "arno.bosse@gmail.com)")

CACHE_FIELDS = (
    "vocab_id", "label", "authority", "authority_id",
    "existing_lat", "existing_lon",
    "auth_lat", "auth_lon", "status", "notes",
)

AUTHORITY_TO_DETAIL = {
    "wikidata": em.WIKIDATA_P625,
    "tgn": em.TGN_RDF_DIRECT,
    "geonames": em.GEONAMES_API,
}


def parse_args():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--skip-fetch", action="store_true",
                   help="Use cache only; skip all network fetches.")
    p.add_argument("--db", type=Path, default=DB_PATH)
    return p.parse_args()


def load_geonames_username() -> str | None:
    if not ENV_FILE.exists():
        return None
    for line in ENV_FILE.read_text().splitlines():
        if line.startswith("GEONAMES_USERNAME="):
            return line.split("=", 1)[1].strip()
    return None


def load_excluded() -> set[str]:
    # curated-place-overrides.csv retired 2026-05-11 (two-tier geo policy);
    # the 'manual' tier is gone, so nothing is excluded any more.
    return set()


def load_cache() -> dict[str, dict]:
    if not CACHE_CSV.exists():
        return {}
    with CACHE_CSV.open(newline="") as f:
        return {r["vocab_id"]: r for r in csv.DictReader(f)}


def write_cache(rows: dict[str, dict]) -> None:
    with CACHE_CSV.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=CACHE_FIELDS, quoting=csv.QUOTE_MINIMAL)
        w.writeheader()
        for vid in sorted(rows):
            w.writerow({k: rows[vid].get(k, "") for k in CACHE_FIELDS})


def fetch_wikidata_p625(qid: str) -> tuple[float, float] | None:
    url = f"https://www.wikidata.org/wiki/Special:EntityData/{qid}.json"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError):
        return None
    entities = data.get("entities", {}) or {}
    if not entities:
        return None
    ent = entities[qid] if qid in entities else entities[next(iter(entities))]
    claims = (ent.get("claims") or {}).get("P625") or []
    pool = ([c for c in claims if c.get("rank") == "preferred"]
            or [c for c in claims if c.get("rank") == "normal"])
    if not pool:
        return None
    snak = pool[0].get("mainsnak") or {}
    if snak.get("snaktype") != "value":
        return None
    val = ((snak.get("datavalue") or {}).get("value") or {})
    if val.get("latitude") is None or val.get("longitude") is None:
        return None
    return (float(val["latitude"]), float(val["longitude"]))


def fetch_geonames(gid: str, username: str) -> tuple[float, float] | None:
    params = urllib.parse.urlencode({"geonameId": gid, "username": username})
    url = f"http://api.geonames.org/getJSON?{params}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read())
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError):
        return None
    if "status" in data:
        return None
    lat, lng = data.get("lat"), data.get("lng")
    if lat is None or lng is None:
        return None
    return (float(lat), float(lng))


def fetch_state(conn, vid):
    r = conn.execute(
        "SELECT lat, lon, coord_method, coord_method_detail, "
        "       COALESCE(label_en, label_nl, '∅') AS label "
        "FROM vocabulary WHERE id = ?", (vid,)).fetchone()
    if r is None:
        return None
    return {"lat": r[0], "lon": r[1], "coord_method": r[2],
            "coord_method_detail": r[3], "label": r[4]}


def select_authority(conn, vid: str) -> tuple[str, str] | None:
    """Pick the best authority for this vocab_id. Returns (authority,
    authority_id) or None if no probeable authority."""
    for authority in ("wikidata", "tgn", "geonames"):
        r = conn.execute(
            "SELECT id FROM vocabulary_external_ids "
            "WHERE vocab_id = ? AND authority = ? LIMIT 1",
            (vid, authority)).fetchone()
        if r:
            return (authority, r[0])
    return None


def main() -> int:
    args = parse_args()
    excluded = load_excluded()
    print(f"Excluded vocab_ids: {len(excluded)}")

    conn = sqlite3.connect(str(args.db))

    # Eligibility: NULL-detail inferred rows with at least one probeable
    # authority in VEI.
    candidates_raw = conn.execute("""
        SELECT v.id
        FROM vocabulary v
        WHERE v.type = 'place'
          AND v.coord_method = 'inferred'
          AND v.coord_method_detail IS NULL
          AND EXISTS (
              SELECT 1 FROM vocabulary_external_ids vei
              WHERE vei.vocab_id = v.id
                AND vei.authority IN ('wikidata','tgn','geonames')
          )
    """).fetchall()
    candidates = []
    for (vid,) in candidates_raw:
        if vid in excluded:
            continue
        sel = select_authority(conn, vid)
        if sel is None:
            continue
        authority, authority_id = sel
        candidates.append((vid, authority, authority_id))
    print(f"Eligible candidates: {len(candidates)}")

    cache = load_cache()
    print(f"Cache: {len(cache)} row(s)")

    # Phase 1: fetch authority coords for any candidate not yet cached
    # (or cached as 'error').
    geonames_user = load_geonames_username()
    if not geonames_user:
        print("WARN: GEONAMES_USERNAME not in .env — skipping any "
              "geonames-only fetches.", file=sys.stderr)

    # Group remaining work by authority.
    to_fetch_wd: list[tuple[str, str]] = []
    to_fetch_tgn: list[tuple[str, str]] = []
    to_fetch_gn: list[tuple[str, str]] = []
    for vid, authority, authority_id in candidates:
        c = cache.get(vid)
        if c is not None and c.get("status") in ("ok", "no_coord"):
            continue
        if authority == "wikidata":
            to_fetch_wd.append((vid, authority_id))
        elif authority == "tgn":
            to_fetch_tgn.append((vid, authority_id))
        elif authority == "geonames":
            if geonames_user:
                to_fetch_gn.append((vid, authority_id))

    if args.skip_fetch:
        print("--skip-fetch: skipping all fetches; using cache only.")
    else:
        # Wikidata fetches (sequential, ~0.6s/req).
        if to_fetch_wd:
            print(f"\nFetching Wikidata: {len(to_fetch_wd)} row(s) "
                  f"(~{len(to_fetch_wd)*0.6:.0f}s)...")
            for i, (vid, qid) in enumerate(to_fetch_wd, 1):
                coord = fetch_wikidata_p625(qid)
                state = fetch_state(conn, vid)
                base = {
                    "vocab_id": vid,
                    "label": state["label"] if state else "",
                    "authority": "wikidata", "authority_id": qid,
                    "existing_lat": str(state["lat"]) if state else "",
                    "existing_lon": str(state["lon"]) if state else "",
                }
                if coord is None:
                    cache[vid] = {**base, "auth_lat": "", "auth_lon": "",
                                  "status": "no_coord", "notes": "no P625"}
                else:
                    cache[vid] = {**base,
                                  "auth_lat": f"{coord[0]:.6f}",
                                  "auth_lon": f"{coord[1]:.6f}",
                                  "status": "ok", "notes": ""}
                if i % 25 == 0 or i == len(to_fetch_wd):
                    print(f"  {i}/{len(to_fetch_wd)}")
                time.sleep(0.6)
            write_cache(cache)

        # TGN fetches (parallel via batch_geocode).
        if to_fetch_tgn:
            print(f"\nFetching TGN: {len(to_fetch_tgn)} row(s)...")
            places = [{"id": vid,
                       "external_id": f"http://vocab.getty.edu/tgn/{tid}"}
                      for vid, tid in to_fetch_tgn]
            records = bg.geocode_getty_rdf(places, max_workers=3)
            for vid, tid in to_fetch_tgn:
                rec = records.get(vid)
                state = fetch_state(conn, vid)
                base = {
                    "vocab_id": vid,
                    "label": state["label"] if state else "",
                    "authority": "tgn", "authority_id": tid,
                    "existing_lat": str(state["lat"]) if state else "",
                    "existing_lon": str(state["lon"]) if state else "",
                }
                if rec is None or rec.fetch_error:
                    cache[vid] = {**base, "auth_lat": "", "auth_lon": "",
                                  "status": "error",
                                  "notes": rec.fetch_error if rec else "no_record"}
                elif rec.lat is None or rec.lon is None:
                    cache[vid] = {**base, "auth_lat": "", "auth_lon": "",
                                  "status": "no_coord", "notes": "TGN areal"}
                else:
                    cache[vid] = {**base,
                                  "auth_lat": f"{rec.lat:.6f}",
                                  "auth_lon": f"{rec.lon:.6f}",
                                  "status": "ok", "notes": ""}
            write_cache(cache)

        # GeoNames fetches (sequential, polite ~1s/req).
        if to_fetch_gn:
            print(f"\nFetching GeoNames: {len(to_fetch_gn)} row(s) "
                  f"(~{len(to_fetch_gn)*1.0:.0f}s)...")
            for i, (vid, gid) in enumerate(to_fetch_gn, 1):
                coord = fetch_geonames(gid, geonames_user)
                state = fetch_state(conn, vid)
                base = {
                    "vocab_id": vid,
                    "label": state["label"] if state else "",
                    "authority": "geonames", "authority_id": gid,
                    "existing_lat": str(state["lat"]) if state else "",
                    "existing_lon": str(state["lon"]) if state else "",
                }
                if coord is None:
                    cache[vid] = {**base, "auth_lat": "", "auth_lon": "",
                                  "status": "no_coord", "notes": "geonames returned no coord"}
                else:
                    cache[vid] = {**base,
                                  "auth_lat": f"{coord[0]:.6f}",
                                  "auth_lon": f"{coord[1]:.6f}",
                                  "status": "ok", "notes": ""}
                if i % 10 == 0 or i == len(to_fetch_gn):
                    print(f"  {i}/{len(to_fetch_gn)}")
                time.sleep(1.0)
            write_cache(cache)

    # Phase 2: plan applies from cache.
    plans: list[dict] = []
    skips: dict[str, int] = {}
    for vid, _authority, _authority_id in candidates:
        c = cache.get(vid)
        if c is None or c.get("status") != "ok":
            skips[c.get("status") if c else "no_cache"] = (
                skips.get(c.get("status") if c else "no_cache", 0) + 1)
            continue
        cur = fetch_state(conn, vid)
        if cur is None or cur["coord_method"] == em.MANUAL:
            skips["manual_or_missing"] = skips.get("manual_or_missing", 0) + 1
            continue
        # IMPORTANT: a row that is no longer NULL-detail (e.g., touched by
        # an earlier apply pass) should not be re-promoted by this script.
        if cur["coord_method_detail"] is not None:
            skips["already_promoted"] = skips.get("already_promoted", 0) + 1
            continue
        target_lat = float(c["auth_lat"])
        target_lon = float(c["auth_lon"])
        target_detail = AUTHORITY_TO_DETAIL[c["authority"]]
        plans.append({
            "vocab_id": vid, "label": c["label"],
            "authority": c["authority"],
            "cur_lat": cur["lat"], "cur_lon": cur["lon"],
            "target_lat": target_lat, "target_lon": target_lon,
            "target_detail": target_detail,
        })

    # Bucket by coord-change magnitude for visibility.
    coord_unchanged = sum(1 for p in plans
                          if p["cur_lat"] == p["target_lat"]
                          and p["cur_lon"] == p["target_lon"])
    coord_changed = len(plans) - coord_unchanged
    print(f"\n━━━ Plan ━━━")
    print(f"  promotions:                {len(plans)}")
    print(f"    coord rewrites:          {coord_changed}")
    print(f"    provenance-only writes:  {coord_unchanged}")
    print(f"  by authority:")
    auth_counts = {}
    for p in plans:
        auth_counts[p["authority"]] = auth_counts.get(p["authority"], 0) + 1
    for a, n in sorted(auth_counts.items(), key=lambda kv: -kv[1]):
        print(f"      {a:<10} {n}")
    print(f"  skips:")
    for k, n in sorted(skips.items(), key=lambda kv: -kv[1]):
        print(f"      {k:<22} {n}")

    print("\n  Sample diffs (first 5):")
    for p in plans[:5]:
        print(f"    {p['vocab_id']} ({p['label']}) authority={p['authority']}")
        print(f"        coord {p['cur_lat']!r} {p['cur_lon']!r}")
        print(f"           -> {p['target_lat']!r} {p['target_lon']!r}")
        print(f"        detail (NULL) -> {p['target_detail']!r}")

    if args.dry_run:
        print(f"\n[dry-run] would write {len(plans)} row(s).")
        conn.close()
        return 0

    if not plans:
        print("\nNothing to apply.")
        conn.close()
        return 0

    print(f"\nApplying {len(plans)} promotions...")
    target_method = em.tier_for(em.WIKIDATA_P625)  # all three details map to AUTHORITY
    with conn:
        for p in plans:
            conn.execute(
                """
                UPDATE vocabulary SET
                    lat = ?, lon = ?,
                    coord_method = ?, coord_method_detail = ?
                WHERE id = ? AND coord_method = 'inferred'
                  AND coord_method_detail IS NULL
                """,
                (p["target_lat"], p["target_lon"],
                 target_method, p["target_detail"], p["vocab_id"]),
            )

    print("Verifying...")
    bad = 0
    for p in plans:
        cur = fetch_state(conn, p["vocab_id"])
        if (cur is None
                or cur["lat"] != p["target_lat"]
                or cur["lon"] != p["target_lon"]
                or cur["coord_method"] != target_method
                or cur["coord_method_detail"] != p["target_detail"]):
            print(f"  [FAIL] {p['vocab_id']}", file=sys.stderr); bad += 1
    print(f"  Verification: {len(plans) - bad} OK, {bad} FAIL")
    conn.close()
    return 0 if bad == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
