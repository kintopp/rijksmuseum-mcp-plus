#!/usr/bin/env python3
"""
Extract depicted places from the Rijksmuseum vocabulary DB,
deduplicate, geocode missing coordinates, and generate an interactive map.

Usage:
    python3 scripts/map_depicted_places.py [--db PATH] [--output PATH] [--geocode-top N]
"""

import argparse
import csv
import json
import sqlite3
import sys
import time
from pathlib import Path

# ---------------------------------------------------------------------------
# 1. Extract depicted places from vocabulary DB
# ---------------------------------------------------------------------------

EXTRACT_SQL = """
SELECT
    v.id,
    COALESCE(NULLIF(v.label_en, ''), v.label_nl) AS place_name,
    v.label_en,
    v.label_nl,
    v.lat,
    v.lon,
    COUNT(DISTINCT m.object_number) AS artwork_count
FROM mappings m
JOIN vocabulary v ON v.id = m.vocab_id
WHERE v.type = 'place'
  AND m.field IN ('subject', 'spatial')
GROUP BY v.id
ORDER BY artwork_count DESC
"""


def extract_places(db_path: str) -> list[dict]:
    """Pull depicted places from the vocabulary DB."""
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(EXTRACT_SQL).fetchall()
    conn.close()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# 2. Deduplicate
# ---------------------------------------------------------------------------

def deduplicate(places: list[dict]) -> list[dict]:
    """
    Merge places that share the same canonical name.

    The vocabulary DB can have multiple IDs mapping to the same real-world
    place (e.g. different catalog entries for "Amsterdam").  We merge them
    by normalised place_name, summing artwork counts and keeping the best
    available coordinates.
    """
    merged: dict[str, dict] = {}

    for p in places:
        name = (p["place_name"] or "").strip()
        if not name:
            continue

        key = name.lower()

        if key in merged:
            existing = merged[key]
            existing["artwork_count"] += p["artwork_count"]
            existing["vocab_ids"].append(p["id"])
            # Prefer coordinates if we don't have them yet
            if existing["lat"] is None and p["lat"] is not None:
                existing["lat"] = p["lat"]
                existing["lon"] = p["lon"]
        else:
            merged[key] = {
                "place_name": name,
                "label_en": p["label_en"],
                "label_nl": p["label_nl"],
                "lat": p["lat"],
                "lon": p["lon"],
                "artwork_count": p["artwork_count"],
                "vocab_ids": [p["id"]],
            }

    result = sorted(merged.values(), key=lambda x: x["artwork_count"], reverse=True)
    return result


# ---------------------------------------------------------------------------
# 3. Geocode missing coordinates (Nominatim, rate-limited)
# ---------------------------------------------------------------------------

def geocode_missing(places: list[dict], top_n: int = 500) -> int:
    """
    Geocode the top N places that lack coordinates using Nominatim.
    Returns the number of successfully geocoded places.
    """
    try:
        from geopy.geocoders import Nominatim
        from geopy.exc import GeocoderTimedOut, GeocoderServiceError
    except ImportError:
        print("geopy not installed — skipping geocoding", file=sys.stderr)
        return 0

    geolocator = Nominatim(user_agent="rijksmuseum-mcp-depicted-places/1.0", timeout=10)

    missing = [p for p in places if p["lat"] is None and p["artwork_count"] >= 2]
    to_geocode = missing[:top_n]

    print(f"Geocoding {len(to_geocode)} places (of {len(missing)} missing)...",
          file=sys.stderr)

    geocoded = 0
    for i, p in enumerate(to_geocode):
        name = p["place_name"]
        try:
            location = geolocator.geocode(name, language="en")
            if location:
                p["lat"] = location.latitude
                p["lon"] = location.longitude
                geocoded += 1
            # Nominatim rate limit: 1 req/sec
            time.sleep(1.1)
        except (GeocoderTimedOut, GeocoderServiceError) as e:
            print(f"  Geocode error for '{name}': {e}", file=sys.stderr)
            time.sleep(2)
        except Exception as e:
            print(f"  Unexpected error for '{name}': {e}", file=sys.stderr)

        if (i + 1) % 50 == 0:
            print(f"  ... {i + 1}/{len(to_geocode)} done ({geocoded} found)",
                  file=sys.stderr)

    print(f"Geocoded {geocoded}/{len(to_geocode)} places", file=sys.stderr)
    return geocoded


# ---------------------------------------------------------------------------
# 4. Generate interactive map with Folium
# ---------------------------------------------------------------------------

def make_map(places: list[dict], output_path: str):
    """Create an interactive Leaflet map with clustered markers."""
    import folium
    from folium.plugins import MarkerCluster

    # Filter to places with coordinates
    mappable = [p for p in places if p["lat"] is not None and p["lon"] is not None]
    print(f"Mapping {len(mappable)} places (out of {len(places)} total)", file=sys.stderr)

    # Centre on Amsterdam (the collection's heart)
    m = folium.Map(
        location=[52.35, 4.92],
        zoom_start=3,
        tiles="CartoDB positron",
        max_zoom=18,
    )

    # ── Marker cluster for performance ────────────────────────────────
    cluster = MarkerCluster(
        name="Depicted Places",
        options={
            "maxClusterRadius": 50,
            "spiderfyOnMaxZoom": True,
            "showCoverageOnHover": False,
        },
    ).add_to(m)

    # ── Size markers by artwork count (log scale) ─────────────────────
    import math

    max_count = max(p["artwork_count"] for p in mappable)

    for p in mappable:
        count = p["artwork_count"]
        name = p["place_name"]
        # Radius: 4-25px on log scale
        radius = 4 + 21 * (math.log1p(count) / math.log1p(max_count))
        # Color: blue for few, red for many
        ratio = math.log1p(count) / math.log1p(max_count)
        if ratio > 0.6:
            color = "#d32f2f"
        elif ratio > 0.3:
            color = "#f57c00"
        elif ratio > 0.1:
            color = "#1976d2"
        else:
            color = "#64b5f6"

        popup_html = f"""
        <div style="font-family: system-ui; min-width: 180px;">
            <strong style="font-size: 14px;">{name}</strong><br>
            <span style="color: #666;">{count:,} artworks</span><br>
            <a href="https://www.rijksmuseum.nl/en/search?depictedPlace={name}"
               target="_blank" style="font-size: 12px;">
               Browse in Rijksmuseum →
            </a>
        </div>
        """

        folium.CircleMarker(
            location=[p["lat"], p["lon"]],
            radius=radius,
            color=color,
            fill=True,
            fill_color=color,
            fill_opacity=0.7,
            weight=1,
            popup=folium.Popup(popup_html, max_width=300),
            tooltip=f"{name} ({count:,} artworks)",
        ).add_to(cluster)

    # ── Legend ─────────────────────────────────────────────────────────
    legend_html = """
    <div style="position: fixed; bottom: 30px; left: 30px; z-index: 1000;
                background: white; padding: 12px 16px; border-radius: 8px;
                box-shadow: 0 2px 8px rgba(0,0,0,0.15);
                font-family: system-ui; font-size: 13px; line-height: 1.6;">
        <strong>Rijksmuseum – Depicted Places</strong><br>
        <span style="color: #d32f2f;">●</span> 10,000+ artworks<br>
        <span style="color: #f57c00;">●</span> 1,000+ artworks<br>
        <span style="color: #1976d2;">●</span> 100+ artworks<br>
        <span style="color: #64b5f6;">●</span> &lt;100 artworks<br>
        <span style="color: #888; font-size: 11px;">
            {total:,} places · {artworks:,} artwork-place links
        </span>
    </div>
    """.format(
        total=len(mappable),
        artworks=sum(p["artwork_count"] for p in mappable),
    )
    m.get_root().html.add_child(folium.Element(legend_html))

    # ── Title ─────────────────────────────────────────────────────────
    title_html = """
    <div style="position: fixed; top: 10px; left: 50%; transform: translateX(-50%);
                z-index: 1000; background: white; padding: 10px 24px;
                border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.15);
                font-family: system-ui; font-size: 16px; font-weight: 600;">
        Places Depicted in the Rijksmuseum Collection
    </div>
    """
    m.get_root().html.add_child(folium.Element(title_html))

    m.save(output_path)
    print(f"Map saved to: {output_path}", file=sys.stderr)


# ---------------------------------------------------------------------------
# 5. Save intermediate data
# ---------------------------------------------------------------------------

def save_csv(places: list[dict], path: str):
    """Save deduplicated places to CSV."""
    with open(path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=[
            "place_name", "label_en", "label_nl", "lat", "lon",
            "artwork_count", "vocab_ids",
        ])
        writer.writeheader()
        for p in places:
            row = {**p, "vocab_ids": ";".join(p["vocab_ids"])}
            writer.writerow(row)
    print(f"CSV saved to: {path} ({len(places)} places)", file=sys.stderr)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Map depicted places in the Rijksmuseum")
    parser.add_argument("--db", default="data/vocabulary.db",
                        help="Path to vocabulary.db")
    parser.add_argument("--output", default="offline/geo/depicted_places_map.html",
                        help="Output HTML map path")
    parser.add_argument("--csv-out", default="data/depicted_places_deduped.csv",
                        help="Output CSV path for deduplicated places")
    parser.add_argument("--geocode-top", type=int, default=500,
                        help="Geocode the top N places missing coordinates (0 to skip)")
    parser.add_argument("--no-geocode", action="store_true",
                        help="Skip geocoding entirely")
    args = parser.parse_args()

    # Resolve DB path
    db_path = Path(args.db)
    if not db_path.exists():
        # Try from repo root
        repo_root = Path(__file__).resolve().parent.parent
        db_path = repo_root / args.db
    if not db_path.exists():
        print(f"Database not found: {args.db}", file=sys.stderr)
        sys.exit(1)

    print(f"Using database: {db_path}", file=sys.stderr)

    # Step 1: Extract
    raw = extract_places(str(db_path))
    print(f"Extracted {len(raw)} place entries from DB", file=sys.stderr)

    # Step 2: Deduplicate
    places = deduplicate(raw)
    with_coords = sum(1 for p in places if p["lat"] is not None)
    print(f"After deduplication: {len(places)} unique places "
          f"({with_coords} with coordinates)", file=sys.stderr)

    # Step 3: Geocode
    if not args.no_geocode and args.geocode_top > 0:
        geocode_missing(places, top_n=args.geocode_top)
        with_coords = sum(1 for p in places if p["lat"] is not None)
        print(f"After geocoding: {with_coords} places with coordinates", file=sys.stderr)

    # Step 4: Save CSV
    csv_path = Path(args.csv_out)
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    save_csv(places, str(csv_path))

    # Step 5: Generate map
    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    make_map(places, str(out_path))

    # Summary stats
    mappable = [p for p in places if p["lat"] is not None]
    total_artworks = sum(p["artwork_count"] for p in mappable)
    print(f"\n{'='*60}", file=sys.stderr)
    print(f"Summary:", file=sys.stderr)
    print(f"  Total unique depicted places: {len(places):,}", file=sys.stderr)
    print(f"  Places with coordinates:      {len(mappable):,}", file=sys.stderr)
    print(f"  Artwork-place links mapped:   {total_artworks:,}", file=sys.stderr)
    print(f"  Map:  {out_path}", file=sys.stderr)
    print(f"  CSV:  {csv_path}", file=sys.stderr)
    print(f"{'='*60}", file=sys.stderr)


if __name__ == "__main__":
    main()
