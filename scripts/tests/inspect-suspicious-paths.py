#!/usr/bin/env python3
"""Inspect the actual content of notation, used_specific_object, and equivalent
paths flagged as suspicious in the v0.25 audit. Goal: characterise what each
path captures so we can decide whether they're classifier residuals or genuinely
new data."""
import json
import urllib.parse
import urllib.request

UA = "rijksmuseum-mcp-plus/v0.25-suspicious-path-probe"
SEARCH = "https://data.rijksmuseum.nl/search/collection"


def get_la(obj):
    url = f"{SEARCH}?objectNumber={urllib.parse.quote(obj)}"
    req = urllib.request.Request(url, headers={
        "Accept": "application/ld+json", "User-Agent": UA})
    with urllib.request.urlopen(req, timeout=15) as r:
        items = json.loads(r.read()).get("orderedItems", [])
    if not items:
        return None
    uri = items[0]["id"]
    req2 = urllib.request.Request(uri, headers={
        "Accept": "application/ld+json",
        "Profile": "https://linked.art/ns/v1/linked-art.json",
        "User-Agent": UA})
    with urllib.request.urlopen(req2, timeout=30) as r:
        return json.loads(r.read())


def show_notation(obj, ent, label):
    notations = ent.get("notation", [])
    if not notations:
        return
    print(f"  [{label}] {len(notations)} notation entries")
    for n in notations[:2]:
        print(f"    keys: {sorted(n.keys()) if isinstance(n, dict) else type(n).__name__}")
        if isinstance(n, dict):
            for k in ("content", "type", "_label"):
                if k in n:
                    print(f"      {k} = {n[k]!r}")
            cls = n.get("classified_as") or []
            for c in cls[:1]:
                if isinstance(c, dict):
                    print(f"      classified_as[0].id = {c.get('id')!r}  _label = {c.get('_label')!r}")


def show_equivalent(actor, label):
    eq = actor.get("equivalent") or []
    if not eq:
        return
    print(f"  [{label}] {len(eq)} equivalent entries")
    for e in eq[:5]:
        if isinstance(e, dict):
            print(f"    {e.get('id', '?')!r}  type={e.get('type', '?')!r}  _label={e.get('_label', '?')!r}")
        else:
            print(f"    {e!r}")


def show_used_specific(la):
    for ab in (la.get("assigned_by") or []):
        for uso in (ab.get("used_specific_object") or []):
            print(f"  used_specific_object: id={uso.get('id')!r}")
            print(f"    type = {uso.get('type')}")
            print(f"    classified_as = {uso.get('classified_as')}")
            return  # one is enough


# Pick a few artworks likely to have multiple notation surfaces
TARGETS = ["SK-A-2330", "SK-C-5", "RP-T-1979-229-A"]  # painting (with motivated_by), Night Watch, drawing

for obj in TARGETS:
    print(f"\n========== {obj} ==========")
    la = get_la(obj)
    if not la:
        print("  not found")
        continue

    # Top-level classified_as
    print("\n top-level classified_as:")
    for c in (la.get("classified_as") or [])[:3]:
        if isinstance(c, dict):
            print(f"  - id={c.get('id')!r} _label={c.get('_label')!r}")
            show_notation(obj, c, "top-level classified_as")

    # Dimension classified_as
    print("\n dimension[*].classified_as:")
    dims = la.get("dimension") or []
    if dims:
        d0 = dims[0]
        cls = d0.get("classified_as") or []
        if cls:
            print(f"  dimension[0] value={d0.get('value')!r}")
            for c in cls[:1]:
                if isinstance(c, dict):
                    print(f"    classified_as.id = {c.get('id')!r}  _label = {c.get('_label')!r}")
                    show_notation(obj, c, "dim.classified_as")

    # Production technique
    print("\n produced_by.part[0].technique:")
    parts = (la.get("produced_by") or {}).get("part") or []
    if parts:
        for t in (parts[0].get("technique") or [])[:1]:
            if isinstance(t, dict):
                print(f"  technique.id = {t.get('id')!r}  _label = {t.get('_label')!r}")
                show_notation(obj, t, "technique")

    # Production carried_out_by
    print("\n produced_by.part[0].carried_out_by:")
    if parts:
        for c in (parts[0].get("carried_out_by") or [])[:1]:
            if isinstance(c, dict):
                print(f"  creator.id = {c.get('id')!r}  _label = {c.get('_label')!r}")
                show_notation(obj, c, "carried_out_by")
                show_equivalent(c, "carried_out_by.equivalent")

    # used_specific_object
    print("\n assigned_by[*].used_specific_object:")
    show_used_specific(la)

    # produced_by.part[*].assigned_by[*].assigned[*].equivalent
    print("\n assigned[].equivalent (creator authority IDs):")
    if parts:
        for ab in (parts[0].get("assigned_by") or [])[:1]:
            for ass in (ab.get("assigned") or [])[:1]:
                show_equivalent(ass, "assigned")
