#!/usr/bin/env python3
"""Compare Iconclass subjects from OAI-PMH vs Linked Art VisualItem.represents_instance_of_type.

Runs against all artworks in the Top 100 curated set (133 records).

BUG FIXED 2026-04-17: The original `search_linked_art_uri` helper used
`data.rijksmuseum.nl/search/collection?objectNumber=X` and took the first match.
That endpoint returns prefix/substring matches, not exact matches — so for
NG-2011-1 it returned HMO 200101886 (which is actually NG-2011-18-1-1, a
completely different artwork). The VI fetch then retrieved iconclass for the
wrong artwork, producing spurious "VI-only" divergences that drove the #203
0.9% yield figure. With the fix, measured divergence is ~0 across 1,137 tested
artworks. See #203 closing comment for the full analysis.

Fix: resolve HMO URIs directly from the vocab DB. Supports two schemas:
  - Pre-Phase-3 DBs (v0.23.1, pre-drops): read `artworks.linked_art_uri`
  - Post-Phase-3 DBs with #253 lookup: join `artwork_hmo_ids`
"""

import argparse
import json
import sqlite3
import sys
import time
import urllib.parse
import urllib.request

DEFAULT_DB_PATH = "data/vocabulary.db"
LINKED_ART_BASE = "https://id.rijksmuseum.nl"
USER_AGENT = "rijksmuseum-mcp-plus/probe"

# Top 100 set (260213) — all 133 object numbers
TOP100_OBJECT_NUMBERS = [
    "AK-MAK-187", "AK-MAK-84", "AK-MAK-240", "SK-A-1115", "SK-C-1368",
    "SK-C-1367", "SK-A-742", "SK-C-5", "SK-C-6", "SK-C-216", "SK-A-4691",
    "SK-C-597", "SK-A-4050", "SK-C-211", "SK-C-217", "SK-A-372", "SK-C-229",
    "SK-A-2005", "SK-A-3011", "SK-A-4", "SK-A-1718", "SK-A-799", "SK-A-404",
    "SK-C-109", "SK-A-3584", "SK-A-3580", "SK-A-1365", "SK-A-2344",
    "SK-A-2860", "SK-C-251", "SK-A-3064", "SK-A-4688", "SK-A-447",
    "SK-A-500", "SK-A-1065", "SK-A-1451", "SK-A-2099", "SK-A-128",
    "SK-A-1405", "SK-A-4821", "SK-A-4118", "SK-A-1505", "SK-A-2963",
    "SK-A-1796", "SK-A-133", "SK-A-135", "SK-A-4830", "SK-C-2", "SK-A-147",
    "SK-A-175", "SK-A-180", "SK-A-2382", "SK-A-3841", "SK-A-2815",
    "SK-A-3059", "SK-A-3148", "SK-A-3262", "SK-A-3948", "SK-A-4100",
    "BK-1963-64", "BK-1963-65", "BK-1976-75", "BK-17040-A", "BK-AM-33-A",
    "BK-AM-33-B", "BK-AM-33-C", "BK-AM-33-D", "BK-AM-33-E", "BK-AM-33-F",
    "BK-AM-33-G", "BK-AM-33-H", "BK-AM-33-I", "BK-AM-33-J", "BK-NM-3888",
    "BK-NM-88", "BK-18305", "BK-NM-13150", "BK-1963-101", "BK-1976-49",
    "SK-A-5003", "BK-KOG-656", "BK-NM-1315", "NG-KOG-1208", "SK-A-4981",
    "SK-A-5007", "BK-NM-1010", "SK-C-149", "BK-2009-255-2", "BK-2009-255-1",
    "NG-MC-651", "BK-16676", "BK-15613", "NG-444", "BK-1994-34",
    "BK-1995-3", "BK-17496", "BK-1983-15", "BK-R-4927", "BK-2000-17",
    "SK-C-1672", "NG-NM-7687", "BK-2004-4-A", "BK-2004-4-B", "NG-2005-24",
    "BK-AM-33", "AK-RAK-2007-1-A", "AK-RAK-2007-1-B", "BK-2008-4",
    "SK-A-5002", "SK-A-5005", "BK-2010-1", "NG-2010-37", "NG-2010-38",
    "NG-2010-39", "NG-2010-40", "NG-2010-41", "NG-2011-1", "BK-1985-10",
    "SK-A-5033", "BK-1975-81", "SK-C-1768", "BK-17040-A-1", "BK-2004-4-B-1",
    "BK-2004-4-B-2", "BK-2004-4-B-3", "BK-2004-4-B-4", "BK-2004-4-B-5",
    "BK-2004-4-B-6", "BK-2004-4-B-7", "BK-2004-4-B-8", "BK-2004-4-B-9",
    "BK-2004-4-B-10", "BK-2004-4-B-11",
]


def fetch_json(url):
    req = urllib.request.Request(url, headers={
        "Accept": "application/ld+json",
        "Profile": "https://linked.art/ns/v1/linked-art.json",
        "User-Agent": USER_AGENT,
    })
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def lookup_linked_art_uri(conn, object_number):
    """Get the authoritative HMO Linked Art URI for an artwork.

    Resolution order:
      1. `artworks.linked_art_uri` column (pre-Phase-3 schema)
      2. `artwork_hmo_ids` lookup (post-Phase-3 + #253)
      3. Search API with result verification (legacy DBs)

    The search-API path verifies each candidate against the exact object_number
    via `identified_by`. Required because the API's `objectNumber=` filter is
    prefix-based, not exact — NG-2011-1 returns 100 prefix matches with the
    wrong one first. The verification adds a few HTTP calls on prefix-colliding
    object numbers only; single-result searches are unaffected.
    """
    cols = {row[1] for row in conn.execute("PRAGMA table_info(artworks)")}
    if "linked_art_uri" in cols:
        row = conn.execute(
            "SELECT linked_art_uri FROM artworks WHERE object_number = ?",
            (object_number,),
        ).fetchone()
        if row and row[0]:
            return row[0]

    has_lookup = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='artwork_hmo_ids'"
    ).fetchone()
    if has_lookup:
        row = conn.execute(
            "SELECT 'https://id.rijksmuseum.nl/' || h.hmo_id "
            "FROM artworks a JOIN artwork_hmo_ids h ON h.art_id = a.art_id "
            "WHERE a.object_number = ?",
            (object_number,),
        ).fetchone()
        if row:
            return row[0]

    # Legacy DB fallback: search API with verification
    return search_and_verify_hmo(object_number)


def search_and_verify_hmo(object_number, max_verify=20):
    """Resolve object_number → HMO URI via the search API, verifying each candidate."""
    url = f"https://data.rijksmuseum.nl/search/collection?objectNumber={urllib.parse.quote(object_number)}"
    try:
        data = fetch_json(url)
    except Exception:
        return None
    items = data.get("orderedItems", []) or []
    if not items:
        return None
    if len(items) == 1:
        return items[0].get("id")
    for item in items[:max_verify]:
        item_id = item.get("id")
        if not item_id:
            continue
        try:
            obj = fetch_json(item_id)
        except Exception:
            continue
        for n in obj.get("identified_by", []) or []:
            if (isinstance(n, dict) and n.get("type") == "Identifier"
                    and n.get("content") == object_number):
                return item_id
    return None


def get_oai_iconclass(conn, object_number):
    """Get Iconclass subjects from vocab DB (OAI-PMH origin)."""
    art_id = conn.execute(
        "SELECT art_id FROM artworks WHERE object_number = ?", (object_number,)
    ).fetchone()
    if not art_id:
        return None
    rows = conn.execute("""
        SELECT v.label_en, v.label_nl, v.external_id
        FROM mappings m
        JOIN vocabulary v ON v.vocab_int_id = m.vocab_rowid
        JOIN field_lookup f ON f.id = m.field_id
        WHERE m.artwork_id = ? AND f.name = 'subject'
          AND v.external_id LIKE '%iconclass.org%'
        ORDER BY v.label_en
    """, (art_id[0],)).fetchall()
    return [(en or nl or "?", ext) for en, nl, ext in rows]


def get_vi_iconclass(linked_art_uri):
    """Get Iconclass subjects from VisualItem.represents_instance_of_type."""
    try:
        obj = fetch_json(linked_art_uri)
    except Exception as e:
        return None, str(e)

    shows = obj.get("shows", [])
    if isinstance(shows, dict):
        shows = [shows]
    if not shows:
        return [], "no shows"

    vi_ref = shows[0] if isinstance(shows[0], dict) else None
    if not vi_ref or not vi_ref.get("id"):
        return [], "no VisualItem ref"

    try:
        vi = fetch_json(vi_ref["id"])
    except Exception as e:
        return None, f"VisualItem fetch failed: {e}"

    riot = vi.get("represents_instance_of_type", [])
    if isinstance(riot, dict):
        riot = [riot]

    results = []
    for item in riot:
        if not isinstance(item, dict):
            continue
        item_id = item.get("id", "")
        try:
            resolved = fetch_json(item_id)
            labels = resolved.get("identified_by", [])
            label = "?"
            notation = None
            for lb in (labels if isinstance(labels, list) else [labels]):
                if isinstance(lb, dict):
                    content = lb.get("content", "")
                    if content and isinstance(content, str):
                        if any(c.isalpha() for c in content) and len(content) > 10:
                            label = content
                        elif not notation:
                            notation = content

            eq = resolved.get("equivalent", [])
            iconclass_uri = None
            for e in (eq if isinstance(eq, list) else [eq]):
                eid = e.get("id", "") if isinstance(e, dict) else (e if isinstance(e, str) else "")
                if "iconclass.org" in eid:
                    iconclass_uri = eid
                    break

            if iconclass_uri:
                results.append((label if label != "?" else notation or "?", iconclass_uri))
        except Exception:
            results.append(("?", item_id))

    return results, None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", default=DEFAULT_DB_PATH,
                        help=f"Path to vocabulary DB (default: {DEFAULT_DB_PATH})")
    parser.add_argument("--limit", type=int, default=None,
                        help="Limit to first N artworks (for quick checks)")
    args = parser.parse_args()

    print(f"Using DB: {args.db}")
    conn = sqlite3.connect(args.db)

    total_oai = 0
    total_vi = 0
    total_overlap = 0
    total_oai_only = 0
    total_vi_only = 0
    skipped = 0
    no_iconclass = 0
    errors = 0
    processed = 0

    # Deduplicate object numbers
    seen = set()
    object_numbers = []
    for on in TOP100_OBJECT_NUMBERS:
        if on not in seen:
            seen.add(on)
            object_numbers.append(on)

    if args.limit is not None:
        object_numbers = object_numbers[:args.limit]
    total = len(object_numbers)
    print(f"Top 100 set: {total} unique object numbers\n")

    # Track artworks with differences for detailed reporting
    divergent = []

    for i, obj_num in enumerate(object_numbers):
        # Get OAI-PMH data from DB
        oai = get_oai_iconclass(conn, obj_num)
        if oai is None:
            skipped += 1
            continue

        # Get Linked Art URI from the DB (not the search API — see module docstring)
        la_uri = lookup_linked_art_uri(conn, obj_num)
        if not la_uri:
            skipped += 1
            print(f"  [{i+1}/{total}] {obj_num}: no Linked Art URI — skipped")
            continue

        # Get VisualItem data
        vi, err = get_vi_iconclass(la_uri)
        processed += 1

        oai_uris = {uri for _, uri in oai}
        vi_uris = {uri for _, uri in vi} if vi is not None else set()

        if not oai_uris and not vi_uris:
            no_iconclass += 1
            continue

        if vi is None:
            errors += 1
            print(f"  [{i+1}/{total}] {obj_num}: VI error — {err}")
            continue

        overlap = oai_uris & vi_uris
        oai_only = oai_uris - vi_uris
        vi_only = vi_uris - oai_uris

        total_oai += len(oai)
        total_vi += len(vi)
        total_overlap += len(overlap)
        total_oai_only += len(oai_only)
        total_vi_only += len(vi_only)

        status = "=" if not oai_only and not vi_only else "≠"
        print(f"  [{i+1}/{total}] {obj_num}: OAI={len(oai)} VI={len(vi)} overlap={len(overlap)} {status}")

        if oai_only or vi_only:
            divergent.append({
                "obj_num": obj_num,
                "oai": oai,
                "vi": vi,
                "oai_only": oai_only,
                "vi_only": vi_only,
                "overlap": overlap,
            })

        # Rate limit: be polite to the API
        time.sleep(0.2)

    print(f"\n{'='*80}")
    print(f"RESULTS — Top 100 set ({total} unique objects)")
    print(f"{'='*80}")
    print(f"  Processed:            {processed}")
    print(f"  Skipped (no DB/URI):  {skipped}")
    print(f"  No Iconclass:         {no_iconclass}")
    print(f"  Errors:               {errors}")
    print(f"")
    print(f"  OAI-PMH Iconclass:    {total_oai}")
    print(f"  VisualItem Iconclass:  {total_vi}")
    print(f"  Overlap:               {total_overlap}")
    print(f"  OAI-only:              {total_oai_only}")
    print(f"  VI-only:               {total_vi_only}")
    combined = total_oai_only + total_vi_only + total_overlap
    if combined:
        print(f"  Combined unique:       {combined}")
        print(f"  OAI coverage:          {100*(total_oai_only+total_overlap)/combined:.1f}%")
        print(f"  VI coverage:           {100*(total_vi_only+total_overlap)/combined:.1f}%")
        print(f"  Overlap rate:          {100*total_overlap/combined:.1f}%")

    if divergent:
        print(f"\n{'='*80}")
        print(f"DIVERGENT ARTWORKS ({len(divergent)}):")
        print(f"{'='*80}")
        for d in divergent:
            print(f"\n  {d['obj_num']}:")
            if d["oai_only"]:
                print(f"    OAI-only ({len(d['oai_only'])}):")
                for label, uri in d["oai"]:
                    if uri in d["oai_only"]:
                        print(f"      {label:50s} {uri}")
            if d["vi_only"]:
                print(f"    VI-only ({len(d['vi_only'])}):")
                for label, uri in d["vi"]:
                    if uri in d["vi_only"]:
                        print(f"      {label:50s} {uri}")


if __name__ == "__main__":
    main()
