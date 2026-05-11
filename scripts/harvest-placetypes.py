#!/usr/bin/env python3
"""Populate vocabulary.placetype / placetype_source / is_areal via SPARQL.

Side-pass over places that already carry a TGN or Wikidata authority ID.
No re-harvest required. Writes to the same `vocabulary.db` that
`harvest-vocabulary-db.py` produced.

Priority (enforced via ``WHERE placetype_source IS NULL`` guards, so
this script is idempotent and safe to re-run):

  1. TGN wins when present (authoritative art-historical classification).
  2. Wikidata fills remaining rows.
  3. Manual overrides (scripts/geocoding/apply_areal_overrides.py) run separately
     AFTER this script and can override any authority value — manual is
     the top tier.

Usage:
    python3 scripts/harvest-placetypes.py --db data/vocabulary.db
    python3 scripts/harvest-placetypes.py --db data/vocabulary.db --source tgn
    python3 scripts/harvest-placetypes.py --db data/vocabulary.db --dry-run --limit 100
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib import placetype_map as pm  # noqa: E402

TGN_SPARQL = "https://vocab.getty.edu/sparql.json"
WIKIDATA_SPARQL = "https://query.wikidata.org/sparql"
USER_AGENT = (
    "rijksmuseum-mcp-plus/0.24 (+https://github.com/kintopp/rijksmuseum-mcp-plus)"
)
STATUS_FILE = Path("data/harvest-placetypes-status.json")


# ---------------------------------------------------------------------------
# Schema migration (idempotent) — so this script can run standalone
# ---------------------------------------------------------------------------

def ensure_placetype_schema(conn: sqlite3.Connection) -> None:
    cols = {r[1] for r in conn.execute("PRAGMA table_info(vocabulary)").fetchall()}
    specs = (("placetype", "TEXT"), ("placetype_source", "TEXT"),
             ("is_areal", "INTEGER"))
    changed = False
    for name, typ in specs:
        if name not in cols:
            conn.execute(f"ALTER TABLE vocabulary ADD COLUMN {name} {typ}")
            changed = True
    if changed:
        conn.commit()


# ---------------------------------------------------------------------------
# SPARQL helpers with 429 backoff
# ---------------------------------------------------------------------------

def _sparql_post(endpoint: str, query: str, retries: int = 4) -> dict:
    """POST a SPARQL query; exponential backoff on 429 / 5xx / timeouts."""
    body = urllib.parse.urlencode({"query": query}).encode()
    req = urllib.request.Request(endpoint, data=body, method="POST")
    req.add_header("User-Agent", USER_AGENT)
    req.add_header("Accept", "application/sparql-results+json")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")

    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=90) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            if e.code == 429 or e.code >= 500:
                wait = min(2 ** (attempt + 1) * 5, 300)
                print(f"  [{endpoint}] HTTP {e.code} — backoff {wait}s "
                      f"(attempt {attempt+1}/{retries})", file=sys.stderr)
                time.sleep(wait)
                continue
            raise
        except (urllib.error.URLError, TimeoutError) as e:
            wait = min(2 ** (attempt + 1) * 5, 300)
            print(f"  [{endpoint}] {e} — backoff {wait}s "
                  f"(attempt {attempt+1}/{retries})", file=sys.stderr)
            time.sleep(wait)
            continue
    print(f"  [{endpoint}] exhausted retries", file=sys.stderr)
    return {}


# ---------------------------------------------------------------------------
# Source 1: TGN via vocab.getty.edu
# ---------------------------------------------------------------------------

def harvest_tgn(conn: sqlite3.Connection, dry_run: bool = False,
                limit: int | None = None, batch_size: int = 100,
                inter_batch_s: float = 2.0) -> dict[str, int]:
    """Populate placetype for places with a TGN authority link.

    Only touches rows where ``placetype_source IS NULL`` — idempotent.
    Wikidata pass runs next and honours this row's tag.
    """
    sql = ("SELECT v.id AS vocab_id, vei.id AS tgn_id "
           "FROM vocabulary v "
           "JOIN vocabulary_external_ids vei ON vei.vocab_id = v.id "
           "WHERE v.type = 'place' AND vei.authority = 'tgn' "
           "  AND v.placetype_source IS NULL")
    if limit:
        sql += f" LIMIT {int(limit)}"
    rows = conn.execute(sql).fetchall()

    print(f"[tgn] {len(rows)} places to query (placetype_source IS NULL)",
          file=sys.stderr)

    stats = {"queried": 0, "hits": 0, "areal": 0, "point": 0, "unmapped": 0}
    if not rows or dry_run:
        return stats

    # Build id → vocab_id map (TGN IDs are unique within this batch set)
    tgn_to_vocab: dict[str, list[str]] = {}
    for r in rows:
        tid = r["tgn_id"] if isinstance(r, sqlite3.Row) else r[1]
        vid = r["vocab_id"] if isinstance(r, sqlite3.Row) else r[0]
        tgn_to_vocab.setdefault(tid, []).append(vid)

    tgn_ids = sorted(tgn_to_vocab.keys())

    updates: list[tuple[str, str, int | None, str]] = []  # (placetype, source, is_areal, vocab_id)
    for i in range(0, len(tgn_ids), batch_size):
        batch = tgn_ids[i:i + batch_size]
        values = " ".join(f"tgn:{bid}" for bid in batch)
        query = f"""
PREFIX tgn: <http://vocab.getty.edu/tgn/>
PREFIX gvp: <http://vocab.getty.edu/ontology#>
SELECT ?tgn ?placetype WHERE {{
  VALUES ?tgn {{ {values} }}
  ?tgn gvp:placeTypePreferred ?placetype .
}}
"""
        data = _sparql_post(TGN_SPARQL, query)
        stats["queried"] += len(batch)
        bindings = data.get("results", {}).get("bindings", [])
        for b in bindings:
            tgn_uri = b.get("tgn", {}).get("value", "")
            placetype_uri = b.get("placetype", {}).get("value", "")
            tid = tgn_uri.rsplit("/", 1)[-1]
            if tid not in tgn_to_vocab:
                continue
            is_areal = pm.classify_aat(placetype_uri)
            is_areal_int = 1 if is_areal is True else (0 if is_areal is False else None)
            for vid in tgn_to_vocab[tid]:
                updates.append((placetype_uri, "tgn", is_areal_int, vid))
            stats["hits"] += 1
            if is_areal is True:
                stats["areal"] += 1
            elif is_areal is False:
                stats["point"] += 1
            else:
                stats["unmapped"] += 1
        time.sleep(inter_batch_s)

        done = min(i + batch_size, len(tgn_ids))
        if done % 1000 < batch_size or done == len(tgn_ids):
            print(f"  [tgn] ... {done}/{len(tgn_ids)} queried "
                  f"({stats['hits']} placetype hits)", file=sys.stderr)

    # Bulk apply, honouring the placetype_source IS NULL guard.
    if updates:
        conn.executemany(
            "UPDATE vocabulary SET placetype = ?, placetype_source = ?, is_areal = ? "
            "WHERE id = ? AND placetype_source IS NULL",
            updates,
        )
        conn.commit()
    print(f"[tgn] Stats: {stats}", file=sys.stderr)
    return stats


# ---------------------------------------------------------------------------
# Source 2: Wikidata via query.wikidata.org
# ---------------------------------------------------------------------------

def _classify_qids(qids: list[str]) -> bool | None:
    """Reconcile multiple P31 values into a single is_areal.

    Rule: POINT SPECIFICITY WINS. If any mapped QID is False (point), the
    classification is False (the row has at least one specific-enough
    class). Otherwise if any is True, it's True. Otherwise None.
    Rationale: a city that's also a sovereign state (Vatican, Monaco,
    Singapore) should be point-classified because pointing at its centre
    is more useful for artwork attribution than treating it as areal.
    """
    seen_false = False
    seen_true = False
    for q in qids:
        v = pm.classify_qid(q)
        if v is False:
            seen_false = True
        elif v is True:
            seen_true = True
    if seen_false:
        return False
    if seen_true:
        return True
    return None


def harvest_wikidata(conn: sqlite3.Connection, dry_run: bool = False,
                     limit: int | None = None, batch_size: int = 100,
                     inter_batch_s: float = 2.0) -> dict[str, int]:
    """Populate placetype for places with Wikidata link but no TGN-sourced value.

    Idempotent via ``WHERE placetype_source IS NULL`` (which already
    excludes TGN-filled rows from the previous pass).
    """
    sql = ("SELECT v.id AS vocab_id, vei.id AS qid "
           "FROM vocabulary v "
           "JOIN vocabulary_external_ids vei ON vei.vocab_id = v.id "
           "WHERE v.type = 'place' AND vei.authority = 'wikidata' "
           "  AND v.placetype_source IS NULL")
    if limit:
        sql += f" LIMIT {int(limit)}"
    rows = conn.execute(sql).fetchall()

    print(f"[wikidata] {len(rows)} places to query (placetype_source IS NULL)",
          file=sys.stderr)

    stats = {"queried": 0, "hits": 0, "areal": 0, "point": 0, "unmapped": 0}
    if not rows or dry_run:
        return stats

    qid_to_vocab: dict[str, list[str]] = {}
    for r in rows:
        qid = r["qid"] if isinstance(r, sqlite3.Row) else r[1]
        vid = r["vocab_id"] if isinstance(r, sqlite3.Row) else r[0]
        qid_to_vocab.setdefault(qid, []).append(vid)

    qids = sorted(qid_to_vocab.keys())
    updates: list[tuple[str, str, int | None, str]] = []

    for i in range(0, len(qids), batch_size):
        batch = qids[i:i + batch_size]
        values = " ".join(f"wd:{q}" for q in batch)
        query = f"""
PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX wdt: <http://www.wikidata.org/prop/direct/>
SELECT ?item ?class WHERE {{
  VALUES ?item {{ {values} }}
  ?item wdt:P31 ?class .
}}
"""
        data = _sparql_post(WIKIDATA_SPARQL, query)
        stats["queried"] += len(batch)

        # Collect P31 lists per item
        p31_by_qid: dict[str, list[str]] = {}
        for b in data.get("results", {}).get("bindings", []):
            item_uri = b.get("item", {}).get("value", "")
            class_uri = b.get("class", {}).get("value", "")
            qid = item_uri.rsplit("/", 1)[-1]
            klass = class_uri.rsplit("/", 1)[-1]
            p31_by_qid.setdefault(qid, []).append(klass)

        for qid, klasses in p31_by_qid.items():
            if qid not in qid_to_vocab:
                continue
            is_areal = _classify_qids(klasses)
            is_areal_int = 1 if is_areal is True else (0 if is_areal is False else None)
            # Pick a "preferred" QID for the placetype field — first classified
            # class that mapped to a non-None value; fall back to first P31.
            preferred = None
            for k in klasses:
                if pm.classify_qid(k) is not None:
                    preferred = k
                    break
            if preferred is None and klasses:
                preferred = klasses[0]
            placetype_value = f"http://www.wikidata.org/entity/{preferred}" if preferred else None
            for vid in qid_to_vocab[qid]:
                updates.append((placetype_value, "wikidata", is_areal_int, vid))
            stats["hits"] += 1
            if is_areal is True:
                stats["areal"] += 1
            elif is_areal is False:
                stats["point"] += 1
            else:
                stats["unmapped"] += 1

        time.sleep(inter_batch_s)
        done = min(i + batch_size, len(qids))
        if done % 1000 < batch_size or done == len(qids):
            print(f"  [wikidata] ... {done}/{len(qids)} queried "
                  f"({stats['hits']} placetype hits)", file=sys.stderr)

    if updates:
        conn.executemany(
            "UPDATE vocabulary SET placetype = ?, placetype_source = ?, is_areal = ? "
            "WHERE id = ? AND placetype_source IS NULL",
            updates,
        )
        conn.commit()
    print(f"[wikidata] Stats: {stats}", file=sys.stderr)
    return stats


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def reclassify_from_placetype(conn: sqlite3.Connection) -> dict[str, int]:
    """Re-derive ``is_areal`` from the already-populated ``placetype`` column.

    Use when extending placetype_map.py — no SPARQL, no network, purely
    a Python-side classify pass over already-stored placetype URIs.
    Idempotent; safe to run any number of times.
    """
    rows = conn.execute(
        "SELECT id, placetype, placetype_source FROM vocabulary "
        "WHERE placetype IS NOT NULL AND placetype_source IN ('tgn', 'wikidata')"
    ).fetchall()
    stats = {"scanned": 0, "changed": 0, "now_areal": 0, "now_point": 0, "now_null": 0}
    updates: list[tuple[int | None, str]] = []
    for r in rows:
        vid = r["id"]
        pt = r["placetype"] or ""
        src = r["placetype_source"]
        is_areal = pm.classify_aat(pt) if src == "tgn" else pm.classify_qid(pt)
        val = 1 if is_areal is True else (0 if is_areal is False else None)
        updates.append((val, vid))
        stats["scanned"] += 1
        if val == 1:
            stats["now_areal"] += 1
        elif val == 0:
            stats["now_point"] += 1
        else:
            stats["now_null"] += 1
    if updates:
        # Only update where value actually differs, for clean reporting.
        changed_before = conn.execute(
            "SELECT COUNT(*) FROM vocabulary WHERE is_areal IS NOT NULL"
        ).fetchone()[0]
        conn.executemany(
            "UPDATE vocabulary SET is_areal = ? WHERE id = ?",
            updates,
        )
        conn.commit()
        changed_after = conn.execute(
            "SELECT COUNT(*) FROM vocabulary WHERE is_areal IS NOT NULL"
        ).fetchone()[0]
        stats["changed"] = changed_after - changed_before
    return stats


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--db", type=Path, default=Path("data/vocabulary.db"))
    ap.add_argument("--source", choices=("tgn", "wikidata", "both"), default="both")
    ap.add_argument("--limit", type=int, default=None,
                    help="Cap per-source rows for smoke testing")
    ap.add_argument("--dry-run", action="store_true",
                    help="Count candidates; issue no SPARQL queries, no DB writes")
    ap.add_argument("--reclassify-only", action="store_true",
                    help="Skip SPARQL; re-derive is_areal from stored placetype "
                         "URIs using the current placetype_map. Use after "
                         "extending the map to apply updates without re-fetching.")
    ap.add_argument("--batch-size", type=int, default=100)
    ap.add_argument("--inter-batch-s", type=float, default=2.0,
                    help="Seconds to sleep between batches")
    args = ap.parse_args()

    if not args.db.exists():
        print(f"DB not found: {args.db}", file=sys.stderr)
        return 1

    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row
    ensure_placetype_schema(conn)

    if args.reclassify_only:
        stats = reclassify_from_placetype(conn)
        print(f"[reclassify] {stats}", file=sys.stderr)
        print(json.dumps(stats, indent=2))
        conn.close()
        return 0

    t0 = time.time()
    status = {
        "started_at": datetime.now(timezone.utc).isoformat(),
        "dry_run": args.dry_run,
        "source": args.source,
        "tgn": {},
        "wikidata": {},
    }

    if args.source in ("tgn", "both"):
        status["tgn"] = harvest_tgn(
            conn, dry_run=args.dry_run, limit=args.limit,
            batch_size=args.batch_size, inter_batch_s=args.inter_batch_s,
        )
    if args.source in ("wikidata", "both"):
        status["wikidata"] = harvest_wikidata(
            conn, dry_run=args.dry_run, limit=args.limit,
            batch_size=args.batch_size, inter_batch_s=args.inter_batch_s,
        )

    status["duration_s"] = round(time.time() - t0, 1)

    # Final coverage summary.
    coverage = dict(conn.execute(
        "SELECT placetype_source, COUNT(*) FROM vocabulary "
        "WHERE type='place' GROUP BY placetype_source"
    ).fetchall())
    status["final_coverage_by_source"] = {
        (k or "NULL"): v for k, v in coverage.items()
    }
    areal_counts = dict(conn.execute(
        "SELECT is_areal, COUNT(*) FROM vocabulary "
        "WHERE type='place' GROUP BY is_areal"
    ).fetchall())
    status["is_areal_distribution"] = {
        ("NULL" if k is None else str(k)): v for k, v in areal_counts.items()
    }

    STATUS_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATUS_FILE.write_text(json.dumps(status, indent=2))
    print(f"Wrote status to {STATUS_FILE}", file=sys.stderr)
    print(json.dumps(status, indent=2))

    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
