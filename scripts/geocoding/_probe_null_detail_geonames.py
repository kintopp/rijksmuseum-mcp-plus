"""Companion probe to _probe_null_detail_recoverability.py — covers the
GeoNames-only subset of the 195 NULL-detail rows that have a VEI entry.

Reads GEONAMES_USERNAME from .env in the project root (free-tier
GeoNames username, not an API key — the username IS the credential).

Same bucketing logic as the Wikidata/TGN probe so results combine cleanly.
"""
import json
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parents[2]
DB = PROJECT_DIR / "data" / "vocabulary.db"
ENV = PROJECT_DIR / ".env"

USER_AGENT = ("rijksmuseum-mcp-plus/0.30 "
              "(https://github.com/kintopp/rijksmuseum-mcp-plus; "
              "arno.bosse@gmail.com)")
GN_URL = "http://api.geonames.org/getJSON?{params}"


def load_username() -> str:
    if not ENV.exists():
        sys.exit(f"missing {ENV}")
    for line in ENV.read_text().splitlines():
        if line.startswith("GEONAMES_USERNAME="):
            return line.split("=", 1)[1].strip()
    sys.exit("GEONAMES_USERNAME not in .env")


def fetch_geonames(gid: str, username: str) -> tuple[float, float] | None:
    params = urllib.parse.urlencode({"geonameId": gid, "username": username})
    url = f"http://api.geonames.org/getJSON?{params}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read())
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError):
        return None
    # GeoNames returns either the entity or a 'status' error block.
    if "status" in data:
        return None
    lat, lng = data.get("lat"), data.get("lng")
    if lat is None or lng is None:
        return None
    return (float(lat), float(lng))


def bucket(delta: float) -> str:
    if delta <= 0.001: return "exact_or_sub_100m"
    if delta <= 0.01:  return "sub_1km"
    if delta <= 0.1:   return "sub_10km"
    if delta <= 1.0:   return "sub_100km"
    return "over_100km"


def main():
    username = load_username()
    conn = sqlite3.connect(str(DB))

    # GeoNames-only candidates: NULL-detail inferred rows whose ONLY
    # probeable authorities are GeoNames (no TGN, no Wikidata).
    rows = conn.execute("""
        SELECT v.id, v.label_en, v.label_nl, v.lat, v.lon, vei.id AS gn_id
        FROM vocabulary v
        JOIN vocabulary_external_ids vei ON vei.vocab_id = v.id
        WHERE v.type='place'
          AND v.coord_method='inferred'
          AND v.coord_method_detail IS NULL
          AND vei.authority='geonames'
          AND NOT EXISTS (
              SELECT 1 FROM vocabulary_external_ids vei2
              WHERE vei2.vocab_id = v.id
                AND vei2.authority IN ('tgn','wikidata')
          )
    """).fetchall()
    print(f"GeoNames-only candidates: {len(rows)}")

    buckets: Counter[str] = Counter()
    examples: dict[str, list[str]] = {}
    no_data = 0
    print(f"Probing GeoNames (~{len(rows)*1.0:.0f}s ETA, polite 1s/req)...")
    started = time.time()
    for i, (vid, en, nl, ex_lat, ex_lon, gid) in enumerate(rows, 1):
        coord = fetch_geonames(gid, username)
        if coord is None:
            no_data += 1; time.sleep(1.0); continue
        lat, lon = coord
        delta = max(abs(ex_lat - lat), abs(ex_lon - lon))
        b = bucket(delta)
        buckets[b] += 1
        if len(examples.setdefault(b, [])) < 3:
            label = en or nl or "∅"
            examples[b].append(
                f"{vid} ({label}) gn={gid}: ({ex_lat:.4f},{ex_lon:.4f}) "
                f"vs ({lat:.4f},{lon:.4f}) δ={delta:.4f}°"
            )
        if i % 10 == 0:
            elapsed = time.time() - started
            print(f"  {i}/{len(rows)} ({elapsed:.0f}s elapsed)")
        time.sleep(1.0)

    print()
    print("=" * 78)
    print(f"GEONAMES ({len(rows)} candidates)")
    print("=" * 78)
    print(f"  no_data / errors: {no_data}")
    for b in ("exact_or_sub_100m", "sub_1km", "sub_10km", "sub_100km", "over_100km"):
        print(f"  {b:<22}  {buckets[b]}")
    print("\nExamples:")
    for b in ("exact_or_sub_100m", "sub_1km", "sub_10km", "sub_100km", "over_100km"):
        for ex in examples.get(b, []):
            print(f"  [{b}] {ex}")

    recoverable = (buckets["exact_or_sub_100m"] + buckets["sub_1km"] +
                   buckets["sub_10km"])
    total = sum(buckets.values())
    print(f"\n  recoverable (δ ≤ 10km): {recoverable} / {total}  "
          f"({100*recoverable/total if total else 0:.1f}%)")


if __name__ == "__main__":
    main()
