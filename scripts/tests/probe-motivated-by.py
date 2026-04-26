#!/usr/bin/env python3
"""One-off probe: dump produced_by.part[].assigned_by[].motivated_by[] payloads
from real Rijksmuseum Linked Art records. For v0.25 schema-decision review."""
import json
import sys
import urllib.parse
import urllib.request

SEARCH_API = "https://data.rijksmuseum.nl/search/collection"
UA = "rijksmuseum-mcp-plus/v0.25-decision-probe"

OBJ_NUMS = sys.argv[1:] if len(sys.argv) > 1 else []


def lookup_uri(obj):
    url = f"{SEARCH_API}?objectNumber={urllib.parse.quote(obj)}"
    req = urllib.request.Request(url, headers={
        "Accept": "application/ld+json", "User-Agent": UA})
    with urllib.request.urlopen(req, timeout=15) as r:
        items = json.loads(r.read()).get("orderedItems", [])
    return items[0]["id"] if items else None


def fetch_la(uri):
    req = urllib.request.Request(uri, headers={
        "Accept": "application/ld+json",
        "Profile": "https://linked.art/ns/v1/linked-art.json",
        "User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def walk_motivated_by(la):
    """Yield (creator_path, motivated_by entry) tuples for every attribution."""
    produced = la.get("produced_by") or {}
    parts = produced.get("part") or []
    for i, part in enumerate(parts):
        creators = []
        for c in part.get("carried_out_by") or []:
            if isinstance(c, dict):
                creators.append(c.get("_label") or c.get("id") or "?")
            elif isinstance(c, str):
                creators.append(c)
        for ab in part.get("assigned_by") or []:
            mb_list = ab.get("motivated_by") or []
            for entry in mb_list:
                yield i, creators, entry


for obj in OBJ_NUMS:
    print(f"\n=== {obj} ===")
    try:
        uri = lookup_uri(obj)
        if not uri:
            print("  no URI found")
            continue
        la = fetch_la(uri)
        title = la.get("_label") or ""
        if not title:
            for ib in la.get("identified_by") or []:
                if isinstance(ib, dict) and ib.get("type") == "Name":
                    title = ib.get("content") or ""
                    if title:
                        break
        found = list(walk_motivated_by(la))
        if not found:
            print(f"  {title!r}: NO motivated_by populated")
            continue
        print(f"  {title!r}: {len(found)} motivated_by entries")
        for idx, creators, entry in found:
            ctxt = "+".join(creators) if creators else "?"
            if isinstance(entry, str):
                print(f"  [part {idx} | {ctxt}] STR  {entry}")
            elif isinstance(entry, dict):
                eid = entry.get("id", "?")
                etype = entry.get("type", "?")
                cb = entry.get("carried_by") or []
                cb_ids = [c.get("id", "?") if isinstance(c, dict) else str(c) for c in cb]
                clf = entry.get("classified_as") or []
                clf_ids = [c.get("id", "?") if isinstance(c, dict) else str(c) for c in clf]
                print(f"  [part {idx} | {ctxt}] DICT type={etype} id={eid}")
                if cb_ids:
                    print(f"      carried_by: {cb_ids}")
                if clf_ids:
                    print(f"      classified_as: {clf_ids}")
            else:
                print(f"  [part {idx}] OTHER {type(entry).__name__} {entry!r}")
    except Exception as e:
        print(f"  ERROR: {e}")
