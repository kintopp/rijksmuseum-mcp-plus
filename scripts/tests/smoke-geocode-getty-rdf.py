#!/usr/bin/env python3
"""Smoke-test for batch_geocode.geocode_getty_rdf(): fetch ~12 TGN-tagged
places from the live vocab DB, run them through the function, and verify
the records carry coords + placetype + broader for the expected fraction.
"""
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import batch_geocode

DB = Path(__file__).resolve().parent.parent.parent / "data" / "vocabulary.db"

def main():
    conn = sqlite3.connect(str(DB))
    conn.row_factory = sqlite3.Row
    rows = conn.execute("""
        SELECT v.id, vei.uri AS external_id, v.label_en, v.label_nl,
               v.lat, v.lon, v.placetype, v.placetype_source, v.coord_method_detail
        FROM vocabulary v
        JOIN vocabulary_external_ids vei ON vei.vocab_id = v.id
        WHERE vei.authority='tgn' AND v.type='place'
        ORDER BY (v.lat IS NULL) DESC, random()
        LIMIT 12
    """).fetchall()
    conn.close()
    places = [dict(r) for r in rows]
    print(f"Fetched {len(places)} TGN-tagged places from vocab DB", flush=True)

    results = batch_geocode.geocode_getty_rdf(places, max_workers=4, progress_every=5)

    print(f"\n{'vocab_id':<10}  {'tgn_id':<10}  {'http':<5}  "
          f"{'lat_rdf':<11}  {'lon_rdf':<11}  {'placetype':<25}  "
          f"existing | upgrade?")
    print("-" * 130)
    upgrade_candidates = 0
    new_coords = 0
    placetype_writes = 0
    for p in places:
        rec = results.get(p["id"])
        if rec is None:
            print(f"{p['id']:<10}  (no result)")
            continue
        # Trigger conditions for the upgrade caller to handle
        had_coords = p["lat"] is not None
        coord_match = (had_coords and rec.lat is not None
                       and abs(p["lat"] - rec.lat) < 0.01
                       and abs(p["lon"] - rec.lon) < 0.01)
        if had_coords and rec.lat is not None and coord_match:
            upgrade_action = "provenance-upgrade"
            upgrade_candidates += 1
        elif had_coords and rec.lat is not None and not coord_match:
            upgrade_action = "DISCREPANCY"
        elif not had_coords and rec.lat is not None:
            upgrade_action = "new-coords"
            new_coords += 1
        elif not had_coords and rec.lat is None:
            upgrade_action = "still-missing (areal?)"
        else:
            upgrade_action = "—"
        if rec.placetype_aat and not p["placetype"]:
            placetype_writes += 1
        existing_flag = (f"{p['lat']:.3f},{p['lon']:.3f}" if had_coords
                         else "—")
        print(f"{p['id']:<10}  {rec.tgn_id:<10}  {rec.fetch_status:<5}  "
              f"{str(rec.lat):<11}  {str(rec.lon):<11}  "
              f"{(rec.placetype_aat or '')[-25:]:<25}  "
              f"{existing_flag} | {upgrade_action}")
    print(f"\nWrite plan summary: provenance-upgrade={upgrade_candidates}, "
          f"new-coords={new_coords}, placetype-writes={placetype_writes}")

if __name__ == "__main__":
    main()
