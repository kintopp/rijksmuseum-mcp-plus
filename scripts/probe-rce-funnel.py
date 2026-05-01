"""Part 1 — RCE funnel diagnostic.

Asks three questions:
  (b) how many vocab places carry a Wikidata QID? (DB-only, instant)
  (c) of those QIDs, how many have a wdt:P359 (Rijksmonument ID)? (Wikidata SPARQL)
  (d) Dutch-place ceiling estimate — places under a broader_id chain leading to
      the Netherlands Wikidata Q55, or with a Dutch-flavoured label heuristic.

Output:
  offline/geo/rce-probe/funnel-diagnostic.md  — short markdown report
  offline/geo/rce-probe/p359-qids.csv          — list of (qid, rmid) pairs we found

Rate-limit: Wikidata SPARQL is ~1 query / few-seconds at 200 QID batches.
"""
from __future__ import annotations

import csv
import sqlite3
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "data" / "vocabulary.db"
OUT_DIR = ROOT / "offline" / "geo" / "rce-probe"
OUT_DIR.mkdir(parents=True, exist_ok=True)

WIKIDATA_SPARQL = "https://query.wikidata.org/sparql"
UA = "rijksmuseum-mcp-plus rce-funnel-diagnostic / arno.bosse@gmail.com"

BATCH_SIZE = 250  # QIDs per VALUES clause; safely under URL-length limits
HEADERS = {"User-Agent": UA, "Accept": "application/sparql-results+json"}


def fetch_wikidata_qids_for_places(conn: sqlite3.Connection) -> list[tuple[str, str]]:
    """Return (vocab_id, qid) pairs for every place with a Wikidata external_id."""
    rows = conn.execute(
        "SELECT vei.vocab_id, vei.id "
        "FROM vocabulary_external_ids vei "
        "JOIN vocabulary v ON v.id = vei.vocab_id "
        "WHERE v.type='place' AND vei.authority='wikidata'"
    ).fetchall()
    return [(r[0], r[1]) for r in rows]


def query_p359(qids: list[str]) -> dict[str, list[str]]:
    """Return {qid: [rmid, ...]} for any QIDs in `qids` that have P359 statements."""
    values = " ".join(f"wd:{q}" for q in qids)
    query = (
        "SELECT ?qid ?rmid WHERE { "
        f"VALUES ?qid {{ {values} }} "
        "?qid wdt:P359 ?rmid . }"
    )
    r = requests.get(WIKIDATA_SPARQL, params={"query": query}, headers=HEADERS, timeout=60)
    r.raise_for_status()
    out: dict[str, list[str]] = {}
    for b in r.json()["results"]["bindings"]:
        qid_uri = b["qid"]["value"]
        qid = qid_uri.rsplit("/", 1)[-1]
        rmid = b["rmid"]["value"]
        out.setdefault(qid, []).append(rmid)
    return out


def dutch_place_heuristic_count(conn: sqlite3.Connection) -> dict[str, int]:
    """Several rough signals for Dutch-bias places."""
    out = {}
    out["all_places"] = conn.execute("SELECT COUNT(*) FROM vocabulary WHERE type='place'").fetchone()[0]
    # heuristic 1: label_nl populated AND label_en NULL or matches label_nl
    out["nl_dominant_label"] = conn.execute(
        "SELECT COUNT(*) FROM vocabulary "
        "WHERE type='place' AND label_nl IS NOT NULL "
        "  AND (label_en IS NULL OR label_en = label_nl)"
    ).fetchone()[0]
    # heuristic 2: any place whose broader_id chain mentions a known Netherlands node
    # We don't have ISO codes, so approximate: places whose broader chain hits a
    # vocab id whose label is exactly "Nederland" or "Netherlands".
    # First find the Netherlands vocab IDs:
    nl_root_ids = [
        r[0] for r in conn.execute(
            "SELECT id FROM vocabulary "
            "WHERE type='place' AND (label_nl='Nederland' OR label_en='Netherlands')"
        ).fetchall()
    ]
    out["nl_root_vocab_ids_found"] = len(nl_root_ids)

    # walk broader_id graph in SQL using a recursive CTE; collect descendants
    if nl_root_ids:
        placeholders = ",".join("?" * len(nl_root_ids))
        cte = f"""
        WITH RECURSIVE descendants(id) AS (
          SELECT id FROM vocabulary WHERE id IN ({placeholders})
          UNION
          SELECT v.id FROM vocabulary v JOIN descendants d ON v.broader_id = d.id
        )
        SELECT COUNT(DISTINCT id) FROM descendants
        """
        out["nl_broader_descendants"] = conn.execute(cte, nl_root_ids).fetchone()[0]
    else:
        out["nl_broader_descendants"] = 0

    return out


def main() -> None:
    conn = sqlite3.connect(DB)

    print("=== Part 1 — RCE funnel diagnostic ===\n")

    # (a) Dutch-place context
    print("(a) Dutch-place ceiling estimates:")
    counts = dutch_place_heuristic_count(conn)
    for k, v in counts.items():
        print(f"    {k}: {v}")

    # (b) wikidata-tagged places
    pairs = fetch_wikidata_qids_for_places(conn)
    n_wd = len(pairs)
    print(f"\n(b) Wikidata QIDs on place rows: {n_wd}")

    # (c) of those, how many carry P359?
    print(f"\n(c) Querying Wikidata for P359 (Rijksmonument ID) — batches of {BATCH_SIZE}…")
    qid_to_rmids: dict[str, list[str]] = {}
    qids = [q for _, q in pairs]
    for i in range(0, len(qids), BATCH_SIZE):
        batch = qids[i:i + BATCH_SIZE]
        try:
            res = query_p359(batch)
        except Exception as e:
            print(f"    batch {i}-{i+len(batch)} failed: {e}")
            time.sleep(5)
            continue
        qid_to_rmids.update(res)
        if i % (BATCH_SIZE * 5) == 0:
            print(f"    {i+len(batch):>5} / {len(qids)}  cumulative P359 hits: {len(qid_to_rmids)}")
        time.sleep(1.0)

    n_p359 = len(qid_to_rmids)
    n_p359_total_rmids = sum(len(v) for v in qid_to_rmids.values())
    print(f"\n  → QIDs with at least one P359: {n_p359}")
    print(f"  → total P359 statements found:  {n_p359_total_rmids}")

    # save mapping
    p359_csv = OUT_DIR / "p359-qids.csv"
    qid_vocab = {q: v for v, q in pairs}
    with p359_csv.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["vocab_id", "wikidata_qid", "rijksmonument_id"])
        for qid, rmids in sorted(qid_to_rmids.items()):
            for rmid in rmids:
                w.writerow([qid_vocab.get(qid, ""), qid, rmid])
    print(f"  → wrote {p359_csv.relative_to(ROOT)}")

    # phase 1e pre-flight gate
    pre_flight = n_wd >= 9000
    print(f"\nphase 1e pre-flight gate (≥9000 wikidata-place IDs): {'PASS' if pre_flight else 'FAIL'}")

    # write report
    report = OUT_DIR / "funnel-diagnostic.md"
    report.write_text(f"""# RCE Phase 1e funnel diagnostic — {time.strftime('%Y-%m-%d')}

Source DB: `data/vocabulary.db` (v0.26 dress-rehearsal harvest, pre-Stage-5.5).

## Counts

| Metric | Value |
|---|---|
| All places in `vocabulary` | {counts['all_places']:,} |
| Places with NL-dominant label (heuristic A) | {counts['nl_dominant_label']:,} |
| "Nederland"/"Netherlands" root vocab IDs found | {counts['nl_root_vocab_ids_found']} |
| Places under NL broader-id chain (heuristic B) | {counts['nl_broader_descendants']:,} |
| **(b) Places with a Wikidata QID** | **{n_wd:,}** |
| **(c) QIDs that carry a `wdt:P359` (Rijksmonument ID)** | **{n_p359:,}** |
| Total P359 statements found (some QIDs have >1) | {n_p359_total_rmids:,} |
| Phase 1e pre-flight gate | {'PASS' if pre_flight else 'FAIL'} |

## Funnel interpretation

```
all places ({counts['all_places']:,})
  → with Wikidata QID ({n_wd:,})
     → with P359 attached ({n_p359:,})  ← Phase 1e bridge-mode ceiling
```

Phase 1e bridge mode currently caps at **~{n_p359:,} places** — modulo the
Wikidata→RCE round-trip (which sometimes loses records when RCE has no
`heeftGeometrie` Point on the matching monument).

## Comparison vs Dutch-place ceiling

The two NL heuristics give different lower bounds for the population that
*could in principle* match RCE:

- NL-dominant label: {counts['nl_dominant_label']:,}
- NL broader-id chain: {counts['nl_broader_descendants']:,}

These are not Rijksmonument-specific (most are cities/regions/neighbourhoods,
not monuments) so the ceiling on RCE matches in any mode is well under either
of them. **The relevant question is: how many of these are buildings**
(churches, country houses, town gates, etc.) — not how many are places at all.

A name-search rescue arm (Part 3 of the user's brief) would need to filter to
building-shaped strings before searching, otherwise false-positive rate on
RCE's `ceo:objectnaam` field will dominate.

## Verdict on widening the funnel

- Bridge funnel: {n_wd:,} → {n_p359:,} = {(n_p359 / n_wd * 100 if n_wd else 0):.1f}% of QIDs have P359.
- If P359 is sparse on Wikidata, name-search could double or triple the
  recoverable yield. If it's well-populated, we're already capturing most of
  what's recoverable via the bridge.
- Whichever side dominates, the **structural ceiling** is bounded by the
  Rijksmonumenten registry (~63,000 monuments), of which only a small
  fraction overlap with Rijksmuseum-relevant subjects.

## Raw output

- `p359-qids.csv` — {n_p359_total_rmids:,} rows of (vocab_id, wikidata_qid, rijksmonument_id)
""", encoding="utf-8")
    print(f"\n  → wrote {report.relative_to(ROOT)}")
    print("\nDone.")


if __name__ == "__main__":
    main()
