"""Phase 1 of the Wikidata-authoritative backfill: fetch Wikidata P625
(coordinate location) for every place in
``data/tgn-rdf-rijks-wikidata-authoritative.csv`` and write the results to
``data/tgn-rdf-rijks-wikidata-coords.csv``.

Network-dependent, idempotent, re-runnable. Does NOT write to vocabulary.db
— that's Phase 2 (separate apply script, modeled on
apply_curated_place_overrides.py).

The Wikidata QID is the Rijks-supplied authority for these 417 places, so
their coords from P625 are 'authority' tier under the existing
``enrichment_methods.WIKIDATA_P625`` constant.

Edge cases:
  - Entity has no P625 -> status='no_p625', no coord written.
  - Multiple P625 values -> take the SPARQL `wdt:` prefix's preferred-rank
    pick (Wikidata's standard 'best value' resolution). If multiple
    preferred, take the first.
  - Entity redirected -> SPARQL follows redirects automatically; coord
    returns under the canonical QID. We log a redirect note.
  - Network error -> status='error', leave coord empty so a re-run picks
    up only the failed rows.

Usage:
    python3 scripts/lookup_wikidata_coords_for_rijks_authority.py
    python3 scripts/lookup_wikidata_coords_for_rijks_authority.py --limit 10
    python3 scripts/lookup_wikidata_coords_for_rijks_authority.py --resume
"""
import argparse
import csv
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent
DATA_DIR = PROJECT_DIR / "data"

INPUT_CSV = DATA_DIR / "tgn-rdf-rijks-wikidata-authoritative.csv"
OUTPUT_CSV = DATA_DIR / "tgn-rdf-rijks-wikidata-coords.csv"

ENTITY_DATA_URL = "https://www.wikidata.org/wiki/Special:EntityData/{qid}.json"
USER_AGENT = (
    "rijksmuseum-mcp-plus/0.30 "
    "(https://github.com/kintopp/rijksmuseum-mcp-plus; arno.bosse@gmail.com)"
)
INTER_REQUEST_DELAY = 0.6  # seconds — polite per-entity throttling
TIMEOUT = 30
# Note: WDQS (query.wikidata.org/sparql) is in active outage as of 2026-05
# (aggressive 1-req/min rate-limit). The per-entity REST API is unaffected.

OUT_FIELDS = (
    "vocab_id", "label_en", "qid",
    "existing_lat", "existing_lon", "existing_method_detail",
    "wikidata_lat", "wikidata_lon",
    "status", "notes",
)

RE_QID = re.compile(r"wikidata\.org/entity/(Q\d+)")
RE_WKT_POINT = re.compile(r"Point\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--limit", type=int, default=None,
                   help="Process only the first N input rows (debug aid).")
    p.add_argument("--resume", action="store_true",
                   help="Skip vocab_ids already present in OUTPUT_CSV with "
                        "status='ok' or 'no_p625' (re-fetch only errors).")
    return p.parse_args()


def qid_from_uri(uri: str) -> str | None:
    m = RE_QID.search(uri)
    return m.group(1) if m else None


def fetch_p625(qid: str) -> tuple[tuple[float, float] | None, str, str]:
    """Fetch a single entity's P625 (preferred-then-normal rank) coord via
    the REST API. Returns ``(coord_or_none, status, notes)`` where status
    is one of 'ok' | 'no_p625' | 'error' and coord is (lat, lon) on ok.
    Follows entity redirects automatically (urllib does this). The
    canonical QID in the response may differ from the requested one when
    a redirect happened — we record that in notes."""
    url = ENTITY_DATA_URL.format(qid=qid)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            data = json.loads(resp.read())
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as exc:
        return None, "error", f"fetch failed: {exc}"
    entities = data.get("entities", {}) or {}
    # Pick the (possibly redirected) entity record. Redirects mean the key
    # is the canonical QID, not the requested one.
    if qid in entities:
        ent = entities[qid]
        notes = ""
    elif len(entities) == 1:
        canonical = next(iter(entities))
        ent = entities[canonical]
        notes = f"redirected: {qid} -> {canonical}"
    else:
        return None, "error", f"unexpected entities payload keys: {list(entities)}"
    claims = (ent.get("claims") or {}).get("P625") or []
    if not claims:
        return None, "no_p625", notes or "Entity has no P625 coordinate"
    # Wikidata claim ranks: 'preferred' > 'normal' > 'deprecated'. Match
    # the SPARQL `wdt:` prefix's "best value" semantics: prefer 'preferred'
    # if any exists, else fall back to 'normal'. Always skip 'deprecated'.
    preferred = [c for c in claims if c.get("rank") == "preferred"]
    normal = [c for c in claims if c.get("rank") == "normal"]
    pool = preferred or normal
    if not pool:
        return None, "no_p625", notes or "Only deprecated P625 claims"
    snak = pool[0].get("mainsnak") or {}
    if snak.get("snaktype") != "value":
        return None, "no_p625", notes or "P625 has snaktype != value"
    val = ((snak.get("datavalue") or {}).get("value") or {})
    lat = val.get("latitude")
    lon = val.get("longitude")
    if lat is None or lon is None:
        return None, "error", notes or "P625 value missing lat/lon"
    return (float(lat), float(lon)), "ok", notes


def load_existing(path: Path) -> dict[str, dict]:
    if not path.exists():
        return {}
    out: dict[str, dict] = {}
    with path.open(newline="") as f:
        for r in csv.DictReader(f):
            out[r["vocab_id"]] = r
    return out


def main() -> int:
    args = parse_args()

    if not INPUT_CSV.exists():
        sys.exit(f"missing {INPUT_CSV}; run "
                 "classify_tgn_discrepancies_by_rijks_authority.py first")

    with INPUT_CSV.open(newline="") as f:
        rows = list(csv.DictReader(f))
    if args.limit:
        rows = rows[:args.limit]
    print(f"Input: {len(rows)} place(s) from {INPUT_CSV.name}")

    existing = load_existing(OUTPUT_CSV)
    print(f"Existing output: {len(existing)} row(s) in {OUTPUT_CSV.name}")

    todo: list[dict] = []
    skipped_resume = 0
    invalid_qid = 0
    for r in rows:
        vid = r["vocab_id"]
        wd_uri = r.get("rijks_wikidata_uri") or ""
        qid = qid_from_uri(wd_uri)
        if not qid:
            invalid_qid += 1
            existing[vid] = {
                "vocab_id": vid,
                "label_en": r.get("label_en") or "",
                "qid": "",
                "existing_lat": r.get("existing_lat") or "",
                "existing_lon": r.get("existing_lon") or "",
                "existing_method_detail": r.get("existing_method_detail") or "",
                "wikidata_lat": "",
                "wikidata_lon": "",
                "status": "invalid_qid",
                "notes": f"Could not extract QID from {wd_uri!r}",
            }
            continue
        if args.resume and vid in existing \
                and existing[vid].get("status") in ("ok", "no_p625"):
            skipped_resume += 1
            continue
        todo.append({**r, "_qid": qid})

    print(f"To fetch: {len(todo)}  "
          f"(resume-skipped: {skipped_resume}, invalid_qid: {invalid_qid})")

    counts = {"ok": 0, "no_p625": 0, "error": 0}
    started = time.time()

    for i, r in enumerate(todo, 1):
        vid = r["vocab_id"]
        qid = r["_qid"]
        coord, status, notes = fetch_p625(qid)
        base = {
            "vocab_id": vid,
            "label_en": r.get("label_en") or "",
            "qid": qid,
            "existing_lat": r.get("existing_lat") or "",
            "existing_lon": r.get("existing_lon") or "",
            "existing_method_detail": r.get("existing_method_detail") or "",
        }
        if coord is None:
            existing[vid] = {**base, "wikidata_lat": "", "wikidata_lon": "",
                             "status": status, "notes": notes}
        else:
            lat, lon = coord
            existing[vid] = {**base,
                             "wikidata_lat": f"{lat:.6f}",
                             "wikidata_lon": f"{lon:.6f}",
                             "status": status, "notes": notes}
        counts[status] = counts.get(status, 0) + 1

        if i % 25 == 0 or i == len(todo):
            elapsed = time.time() - started
            rate = i / elapsed if elapsed else 0
            eta = (len(todo) - i) / rate if rate else 0
            print(f"  {i}/{len(todo)}  ok={counts['ok']} "
                  f"no_p625={counts['no_p625']} err={counts['error']}  "
                  f"({rate:.1f}/s, ETA {eta:.0f}s)")
        time.sleep(INTER_REQUEST_DELAY)

    # Write output: deterministic order = INPUT_CSV order.
    with OUTPUT_CSV.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=OUT_FIELDS, quoting=csv.QUOTE_MINIMAL)
        w.writeheader()
        # Preserve input order; append any extras (e.g. previously fetched
        # rows not in this run's slice) afterwards.
        seen: set[str] = set()
        with INPUT_CSV.open(newline="") as src:
            for r in csv.DictReader(src):
                vid = r["vocab_id"]
                if vid in existing:
                    w.writerow({k: existing[vid].get(k, "") for k in OUT_FIELDS})
                    seen.add(vid)
        for vid, row in existing.items():
            if vid not in seen:
                w.writerow({k: row.get(k, "") for k in OUT_FIELDS})

    print()
    print(f"Wrote {OUTPUT_CSV}")
    print()
    print("=== Summary ===")
    statuses = {}
    for r in existing.values():
        statuses[r.get("status", "?")] = statuses.get(r.get("status", "?"), 0) + 1
    for s, n in sorted(statuses.items(), key=lambda kv: -kv[1]):
        print(f"  {s:<12}  {n:>4}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
