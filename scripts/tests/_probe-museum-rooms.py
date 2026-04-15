"""Crawl the Rijksmuseum website search API to build the complete
museum-rooms directory — *stable reference data only*.

Captures the 75 physical rooms (hash, id, floor, named-gallery flag),
which is what the vocab DB's `museum_rooms` table needs. Does NOT
capture on-display object counts — those are inherently live and
belong in a future `live_queries` tool that hits the website API at
runtime, not in a harvest-time snapshot (see #212 comment on Persian
miniatures for the design).

Uses the `onlyInMuseum=true` filter from #212 so every returned artwork
carries a `museumLocationFacet` — the result set is restricted to the
~8,552 on-display objects (not the full 833K collection). At pageSize=30
(the API's silent maximum) that's ~286 pages, comfortably under the
~380-page deep-pagination 500 ceiling.

Writes `data/seed/museum-rooms.json` in the schema expected by
harvest-vocabulary-db.py's run_phase3 museum_rooms seed block:

    [{"room_hash": "<32-char facet id>",
      "room_id":   "0.7",
      "floor":     "ground",
      "room_name":  null}, ...]

Progress is saved on every 20 pages *and* on Ctrl-C / SIGTERM via a
signal handler, so a partial crawl is always recoverable.
"""
import json
import re
import signal
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

BASE = "https://www.rijksmuseum.nl/api/v1/collection/search"
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
OUT = REPO_ROOT / "data" / "seed" / "museum-rooms.json"
PARTIAL_OUT = REPO_ROOT / "data" / "seed" / "museum-rooms.partial.json"


# Prefix → floor label, per #212's room directory (75 rooms across 7 zones).
FLOOR_RULES: list[tuple[re.Pattern, str]] = [
    (re.compile(r"^PV-", re.I),    "philips_wing"),
    (re.compile(r"^AP-", re.I),    "asian_pavilion"),
    (re.compile(r"^0\."),          "ground"),
    (re.compile(r"^1\."),          "first"),
    (re.compile(r"^2\."),          "second"),
    (re.compile(r"^3\."),          "third"),
]

# Rooms with human-readable names rather than floor.room numbering. #212's
# v0.24 crawl found exactly two; update if new named galleries appear.
NAMED_GALLERIES = {
    "Gallery of Honour",
    "Night Watch Gallery",
}


def floor_for(room_id: str) -> str | None:
    """Derive a floor label from a room_id. Returns None for named galleries
    or unknown prefixes — the latter are flagged in the crawl summary so
    the operator can decide whether to extend FLOOR_RULES."""
    if room_id in NAMED_GALLERIES:
        return None
    for pattern, label in FLOOR_RULES:
        if pattern.match(room_id):
            return label
    return None


def fetch(params):
    url = BASE + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def save_partial(rooms: dict[str, dict], reason: str) -> None:
    """Persist whatever we have so an interrupt or error never loses work."""
    if not rooms:
        return
    shaped = shape_for_harvest(rooms)
    PARTIAL_OUT.parent.mkdir(parents=True, exist_ok=True)
    PARTIAL_OUT.write_text(json.dumps(shaped, indent=2) + "\n")
    print(f"  → saved {len(shaped)} rooms to {PARTIAL_OUT.name} ({reason})", flush=True)


def crawl_rooms():
    """Walk onlyInMuseum=true results and collect unique museumLocationFacet
    entries. Returns dict[room_hash] = {"room_id": str, "seen": int}.

    Registers a SIGINT/SIGTERM handler that dumps a partial JSON on exit
    so an interrupted crawl is always recoverable."""
    rooms: dict[str, dict] = {}
    # API silently caps pageSize at 30 — larger values are accepted but the
    # response only contains 30 objects. Deep pagination 500s past ~page 380.
    # At 8,552 on-display objects, 286 pages at pageSize=30 is sufficient with
    # ~94 pages of headroom under the ceiling.
    PAGE_SIZE = 30
    MAX_PAGES = 370
    EMPTY_STREAK_LIMIT = 3

    def _save_on_signal(signum, frame):
        print(f"\n  signal {signum} received — saving partial and exiting", flush=True)
        save_partial(rooms, f"signal {signum}")
        sys.exit(130 if signum == signal.SIGINT else 143)

    signal.signal(signal.SIGINT, _save_on_signal)
    signal.signal(signal.SIGTERM, _save_on_signal)

    empty_streak = 0
    for page in range(1, MAX_PAGES + 1):
        try:
            d = fetch({
                "onlyInMuseum": "true",
                "language": "en",
                "page": page,
                "pageSize": PAGE_SIZE,
                "collectionSearchContext": "Art",
                "sortingType": "Popularity",
            })
        except Exception as e:
            print(f"  page {page}: error {e}; retrying after 2s", flush=True)
            time.sleep(2)
            continue

        art_objects = d.get("artObjects", []) or []
        before = len(rooms)
        for a in art_objects:
            f = a.get("museumLocationFacet")
            if not f or not f.get("id"):
                continue
            rh = f["id"]
            room_id = f.get("value") or "(unnamed)"
            entry = rooms.get(rh)
            if entry is None:
                rooms[rh] = {"room_id": room_id, "seen": 1}
            else:
                entry["seen"] += 1

        added = len(rooms) - before
        print(
            f"  page {page}: +{added} rooms, total={len(rooms)} "
            f"(objects on page: {len(art_objects)})",
            flush=True,
        )

        # Periodic partial save — survives a hard kill that bypasses signals
        if page % 20 == 0:
            save_partial(rooms, f"checkpoint at page {page}")

        if not art_objects:
            empty_streak += 1
            if empty_streak >= EMPTY_STREAK_LIMIT:
                print(f"  no artObjects for {EMPTY_STREAK_LIMIT} consecutive pages — stopping")
                break
        else:
            empty_streak = 0

        if not d.get("hasMoreResults"):
            print(f"  hasMoreResults=false at page {page}; stopping")
            break

        time.sleep(0.15)

    return rooms


def shape_for_harvest(rooms: dict[str, dict]) -> list[dict]:
    """Transform crawl output into the schema the harvest reads from
    data/seed/museum-rooms.json. Rows are sorted by room_id for diff
    stability across crawls. `seen` is internal-only — live per-room
    counts belong in a runtime live_queries tool, not a seed file."""
    out = []
    for room_hash, entry in sorted(rooms.items(), key=lambda kv: kv[1]["room_id"]):
        room_id = entry["room_id"]
        out.append({
            "room_hash": room_hash,
            "room_id": room_id,
            "floor": floor_for(room_id),
            "room_name": room_id if room_id in NAMED_GALLERIES else None,
        })
    return out


def main():
    print("=== Crawling museum rooms via onlyInMuseum=true ===")
    t0 = time.time()
    rooms = crawl_rooms()
    elapsed = time.time() - t0
    print(f"\nDiscovered {len(rooms)} unique rooms in {elapsed:.0f}s "
          f"({sum(r['seen'] for r in rooms.values())} objects seen)")

    shaped = shape_for_harvest(rooms)

    by_floor = Counter(r["floor"] for r in shaped)
    print("\nFloor distribution:")
    for floor, count in sorted(by_floor.items(), key=lambda kv: (kv[0] is None, kv[0] or "")):
        label = floor or "(null — named or unknown)"
        print(f"  {label:32s} {count}")

    named = [r for r in shaped if r["room_name"]]
    if named:
        print(f"\nNamed galleries ({len(named)}):")
        for r in named:
            print(f"  {r['room_id']!r}")

    unknown = [r for r in shaped if r["floor"] is None and r["room_name"] is None]
    if unknown:
        print(f"\nWARNING: {len(unknown)} rooms with neither floor nor name (unexpected prefix):")
        for r in unknown:
            print(f"  {r['room_id']!r} (hash={r['room_hash']})")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(shaped, indent=2) + "\n")
    print(f"\nWrote {OUT} ({len(shaped)} rooms)")

    # Clean up the checkpoint file on a successful run so a stale partial
    # isn't confused with a fresh one on the next invocation.
    if PARTIAL_OUT.exists():
        PARTIAL_OUT.unlink()


if __name__ == "__main__":
    main()
