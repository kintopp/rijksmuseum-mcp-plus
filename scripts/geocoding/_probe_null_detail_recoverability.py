"""Probe whether the 4,549 NULL-detail inferred-tier coords might be
retroactively classifiable. Focuses on the ~155 of those rows that have a
Wikidata or TGN authority in vocabulary_external_ids — fetches the
authority's published coord and compares against the existing DB coord.

Bucketing tolerance:
  exact / sub-100m  → δ ≤ 0.001°
  sub-1km           → δ ≤ 0.01°
  sub-10km          → δ ≤ 0.1°
  sub-100km         → δ ≤ 1.0°
  >100km            → δ > 1.0°

Read-only — does not write to the DB. Output drives the decision on
whether a retroactive promotion script is worth building.
"""
import json
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent.parent
sys.path.insert(0, str(SCRIPT_DIR.parent))
from geocoding import batch_geocode as bg  # noqa: E402

DB = PROJECT_DIR / "data" / "vocabulary.db"
USER_AGENT = ("rijksmuseum-mcp-plus/0.30 "
              "(https://github.com/kintopp/rijksmuseum-mcp-plus; "
              "arno.bosse@gmail.com)")
ENTITY_DATA_URL = "https://www.wikidata.org/wiki/Special:EntityData/{qid}.json"


def fetch_p625(qid: str) -> tuple[float, float] | None:
    url = ENTITY_DATA_URL.format(qid=qid)
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


def bucket(delta: float) -> str:
    if delta <= 0.001: return "exact_or_sub_100m"
    if delta <= 0.01:  return "sub_1km"
    if delta <= 0.1:   return "sub_10km"
    if delta <= 1.0:   return "sub_100km"
    return "over_100km"


def main():
    conn = sqlite3.connect(str(DB))
    # Wikidata candidates
    wd_rows = conn.execute("""
        SELECT v.id, v.label_en, v.label_nl, v.lat, v.lon, vei.id AS qid
        FROM vocabulary v
        JOIN vocabulary_external_ids vei ON vei.vocab_id = v.id
        WHERE v.type='place' AND v.coord_method='inferred'
          AND v.coord_method_detail IS NULL
          AND vei.authority='wikidata'
    """).fetchall()
    print(f"Wikidata candidates: {len(wd_rows)}")

    # TGN candidates
    tgn_rows = conn.execute("""
        SELECT v.id, v.label_en, v.label_nl, v.lat, v.lon, vei.id AS tgn_id
        FROM vocabulary v
        JOIN vocabulary_external_ids vei ON vei.vocab_id = v.id
        WHERE v.type='place' AND v.coord_method='inferred'
          AND v.coord_method_detail IS NULL
          AND vei.authority='tgn'
    """).fetchall()
    print(f"TGN candidates:      {len(tgn_rows)}\n")

    # ── Wikidata probe (sequential REST) ─────────────────────────────
    wd_buckets: Counter[str] = Counter()
    wd_no_p625 = 0
    wd_errors = 0
    wd_examples: dict[str, list[str]] = {}
    print(f"Probing Wikidata (~{len(wd_rows)*0.6:.0f}s ETA)...")
    started = time.time()
    for i, (vid, en, nl, ex_lat, ex_lon, qid) in enumerate(wd_rows, 1):
        coord = fetch_p625(qid)
        if coord is None:
            wd_no_p625 += 1
            time.sleep(0.6); continue
        lat, lon = coord
        delta = max(abs(ex_lat - lat), abs(ex_lon - lon))
        b = bucket(delta)
        wd_buckets[b] += 1
        if len(wd_examples.setdefault(b, [])) < 3:
            label = en or nl or "∅"
            wd_examples[b].append(
                f"{vid} ({label}) qid={qid}: ({ex_lat:.4f},{ex_lon:.4f}) "
                f"vs ({lat:.4f},{lon:.4f}) δ={delta:.4f}°"
            )
        if i % 25 == 0:
            elapsed = time.time() - started
            print(f"  {i}/{len(wd_rows)} ({elapsed:.0f}s elapsed)")
        time.sleep(0.6)

    # ── TGN probe (parallel) ─────────────────────────────────────────
    tgn_buckets: Counter[str] = Counter()
    tgn_no_coords = 0
    tgn_errors = 0
    tgn_examples: dict[str, list[str]] = {}
    if tgn_rows:
        print(f"\nProbing TGN ({len(tgn_rows)} rows)...")
        places = [{"id": vid,
                   "external_id": f"http://vocab.getty.edu/tgn/{tgn_id}"}
                  for vid, _en, _nl, _lat, _lon, tgn_id in tgn_rows]
        records = bg.geocode_getty_rdf(places, max_workers=3)
        for vid, en, nl, ex_lat, ex_lon, tgn_id in tgn_rows:
            rec = records.get(vid)
            if rec is None or rec.fetch_error:
                tgn_errors += 1; continue
            if rec.lat is None or rec.lon is None:
                tgn_no_coords += 1; continue
            delta = max(abs(ex_lat - rec.lat), abs(ex_lon - rec.lon))
            b = bucket(delta)
            tgn_buckets[b] += 1
            if len(tgn_examples.setdefault(b, [])) < 3:
                label = en or nl or "∅"
                tgn_examples[b].append(
                    f"{vid} ({label}) tgn={tgn_id}: ({ex_lat:.4f},{ex_lon:.4f}) "
                    f"vs ({rec.lat:.4f},{rec.lon:.4f}) δ={delta:.4f}°"
                )

    print()
    print("=" * 78)
    print("WIKIDATA (152 candidates)")
    print("=" * 78)
    print(f"  no_p625: {wd_no_p625}, errors: {wd_errors}")
    for b in ("exact_or_sub_100m", "sub_1km", "sub_10km", "sub_100km", "over_100km"):
        n = wd_buckets[b]
        print(f"  {b:<22}  {n}")
    print()
    print("Examples:")
    for b in ("exact_or_sub_100m", "sub_1km", "sub_10km", "sub_100km", "over_100km"):
        for ex in wd_examples.get(b, []):
            print(f"  [{b}] {ex}")

    print()
    print("=" * 78)
    print("TGN (3 candidates)")
    print("=" * 78)
    print(f"  no_coords: {tgn_no_coords}, errors: {tgn_errors}")
    for b in ("exact_or_sub_100m", "sub_1km", "sub_10km", "sub_100km", "over_100km"):
        n = tgn_buckets[b]
        print(f"  {b:<22}  {n}")
    print("Examples:")
    for b in ("exact_or_sub_100m", "sub_1km", "sub_10km", "sub_100km", "over_100km"):
        for ex in tgn_examples.get(b, []):
            print(f"  [{b}] {ex}")

    print()
    print("=" * 78)
    print("RECOVERABILITY (existing coord matches authority within tolerance)")
    print("=" * 78)
    recoverable = (wd_buckets["exact_or_sub_100m"] + wd_buckets["sub_1km"] +
                   wd_buckets["sub_10km"] +
                   tgn_buckets["exact_or_sub_100m"] + tgn_buckets["sub_1km"] +
                   tgn_buckets["sub_10km"])
    total_probed = sum(wd_buckets.values()) + sum(tgn_buckets.values())
    print(f"  recoverable (δ ≤ 10km): {recoverable} / {total_probed}  "
          f"({100*recoverable/total_probed if total_probed else 0:.1f}%)")


if __name__ == "__main__":
    main()
