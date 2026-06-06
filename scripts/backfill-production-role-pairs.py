#!/usr/bin/env python3
"""Backfill production_role_pairs from Rijksmuseum Linked Art.

Issue: #357 — same-row matching for creator + productionRole on search_artwork.

The mappings table loses per-part association between creators and roles at harvest
time, so two independent EXISTS clauses on the same artwork can match across
different production rows (a reproductive print's "after painting by" row + a
separate creator-name row catalogue under the master's name). This script extracts
the row association directly from Linked Art's produced_by.part[] structure, where
part.carried_out_by (creators) and part.technique (roles) co-occur within the same
part dict and are therefore inherently same-row.

Schema added on first run:

    CREATE TABLE production_role_pairs (
        artwork_id   INTEGER NOT NULL,
        creator_id   TEXT NOT NULL,
        role_id      TEXT NOT NULL,
        part_index   INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (artwork_id, creator_id, role_id)
    ) WITHOUT ROWID;

    CREATE INDEX idx_production_role_pairs_role
      ON production_role_pairs(role_id, creator_id, artwork_id);

Resumable: per-artwork progress is recorded in backfill_role_pairs_progress.
Re-running the script processes only artworks that have no progress row or
that previously errored. The role-pair INSERTs are idempotent (INSERT OR IGNORE)
so partial commits are safe.

Parallelism: thread-pool of HTTP workers (default 20) — about 30 minutes
wall-clock for the full 834K-artwork corpus on a stable home connection.

Usage:
    uv run scripts/backfill-production-role-pairs.py
    uv run scripts/backfill-production-role-pairs.py --target data/vocabulary.db --workers 20
    uv run scripts/backfill-production-role-pairs.py --limit 1000   # sample run
"""

import argparse
import sqlite3
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

import requests

LINKED_ART_BASE = "https://data.rijksmuseum.nl"
USER_AGENT = "rijksmuseum-mcp-plus backfill-production-role-pairs/1.0"

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS production_role_pairs (
    artwork_id   INTEGER NOT NULL,
    creator_id   TEXT NOT NULL,
    role_id      TEXT NOT NULL,
    part_index   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (artwork_id, creator_id, role_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_production_role_pairs_role
  ON production_role_pairs(role_id, creator_id, artwork_id);

CREATE TABLE IF NOT EXISTS backfill_role_pairs_progress (
    art_id       INTEGER PRIMARY KEY,
    processed_at INTEGER NOT NULL,
    status       TEXT NOT NULL
);
"""


def make_session() -> requests.Session:
    """Pool-sized session mirroring the harvest script's policy."""
    s = requests.Session()
    adapter = requests.adapters.HTTPAdapter(
        pool_connections=40, pool_maxsize=40, max_retries=0
    )
    s.mount("https://", adapter)
    return s


def _ids_from(items, key: str = "id") -> list[str]:
    """Extract trailing-segment IDs from a Linked Art reference list."""
    out: list[str] = []
    if not isinstance(items, list):
        return out
    for it in items:
        if isinstance(it, dict) and isinstance(it.get(key), str):
            vid = it[key].rsplit("/", 1)[-1]
            if vid:
                out.append(vid)
    return out


def extract_role_pairs(la_json: dict) -> list[tuple[str, str, int]]:
    """Return (creator_id, role_id, part_index) tuples from produced_by.part[]."""
    pairs: list[tuple[str, str, int]] = []
    produced_by = la_json.get("produced_by")
    if not isinstance(produced_by, dict):
        return pairs

    parts = produced_by.get("part")
    if not isinstance(parts, list):
        parts = [produced_by]

    for part_idx, part in enumerate(parts):
        if not isinstance(part, dict):
            continue
        # Direct creators: part.carried_out_by[].id
        creator_ids = _ids_from(part.get("carried_out_by", []))
        # Qualified creators: part.assigned_by[].assigned[].id where assigned_property
        # is carried_out_by or influenced_by — mirrors the harvest's assignment_pairs path.
        for ab in part.get("assigned_by", []) or []:
            if not isinstance(ab, dict):
                continue
            if ab.get("type") != "AttributeAssignment":
                continue
            if ab.get("assigned_property") not in ("carried_out_by", "influenced_by"):
                continue
            creator_ids.extend(_ids_from(ab.get("assigned", [])))

        role_ids = _ids_from(part.get("technique", []))

        for cid in creator_ids:
            for rid in role_ids:
                pairs.append((cid, rid, part_idx))

    return pairs


def fetch_la(session: requests.Session, hmo_id: str, timeout: int = 30):
    """Fetch one Linked Art JSON. Returns (status, data | None)."""
    url = f"{LINKED_ART_BASE}/{hmo_id}"
    try:
        r = session.get(
            url,
            headers={
                "Accept": "application/ld+json",
                "Profile": "https://linked.art/ns/v1/linked-art.json",
                "User-Agent": USER_AGENT,
            },
            timeout=timeout,
        )
    except requests.RequestException:
        return "error", None
    # 404 (Not Found) and 410 (Gone) are both terminal — the record isn't served
    # by the live API even though it still exists in our local DB from an older
    # harvest. Marking these "not_found" prevents infinite retry loops.
    if r.status_code in (404, 410):
        return "not_found", None
    if not r.ok:
        return "error", None
    try:
        return "ok", r.json()
    except ValueError:
        return "error", None


def process_one(session, art_id: int, hmo_id: str):
    status, data = fetch_la(session, hmo_id)
    if data is None:
        return art_id, status, []
    return art_id, status, extract_role_pairs(data)


def get_pending(conn: sqlite3.Connection, limit: int | None) -> list[tuple[int, str]]:
    """Artworks with no progress row, plus any that previously errored."""
    sql = """
        SELECT ahi.art_id, ahi.hmo_id
        FROM artwork_hmo_ids ahi
        LEFT JOIN backfill_role_pairs_progress p ON p.art_id = ahi.art_id
        WHERE p.art_id IS NULL OR p.status = 'error'
        ORDER BY ahi.art_id
    """
    if limit is not None:
        sql += f" LIMIT {int(limit)}"
    return conn.execute(sql).fetchall()


def commit_batch(conn: sqlite3.Connection, batch: list[tuple[int, str, list]]) -> None:
    cur = conn.cursor()
    now = int(time.time())
    for art_id, status, pairs in batch:
        for cid, rid, pidx in pairs:
            cur.execute(
                "INSERT OR IGNORE INTO production_role_pairs "
                "(artwork_id, creator_id, role_id, part_index) VALUES (?, ?, ?, ?)",
                (art_id, cid, rid, pidx),
            )
        cur.execute(
            "INSERT OR REPLACE INTO backfill_role_pairs_progress "
            "(art_id, processed_at, status) VALUES (?, ?, ?)",
            (art_id, now, status),
        )
    conn.commit()


def stamp_version_info(conn: sqlite3.Connection) -> None:
    """Record backfill provenance so the server can detect art_id drift.

    production_role_pairs.artwork_id is the harvest-assigned art_id, so the table is
    only valid against the harvest it was built from. We stamp the vocab build we ran
    against (version_info.built_at) so VocabularyDb.warnIfProductionRolePairsStale()
    can warn if a later harvest swaps that out from under the table. Mirrors the
    embeddings-DB convention (vocab_db_built_at / vocab_db_version).
    """
    conn.execute("CREATE TABLE IF NOT EXISTS version_info (key TEXT PRIMARY KEY, value TEXT)")
    row = conn.execute("SELECT value FROM version_info WHERE key='built_at'").fetchone()
    vocab_built_at = row[0] if row else "unknown"
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    conn.execute(
        "INSERT OR REPLACE INTO version_info (key, value) VALUES (?, ?)",
        ("production_role_pairs_built_at", now),
    )
    conn.execute(
        "INSERT OR REPLACE INTO version_info (key, value) VALUES (?, ?)",
        ("production_role_pairs_vocab_built_at", vocab_built_at),
    )
    print(f"Stamped version_info: production_role_pairs_vocab_built_at={vocab_built_at}, built_at={now}")


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Backfill production_role_pairs for #357.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    ap.add_argument("--target", default="data/vocabulary.db", help="Path to vocabulary.db")
    ap.add_argument("--workers", type=int, default=20, help="Concurrent HTTP workers")
    ap.add_argument("--limit", type=int, default=None, help="Max artworks to process this run")
    ap.add_argument("--batch-size", type=int, default=500, help="Commit batch size")
    args = ap.parse_args()

    db_path = Path(args.target)
    if not db_path.exists():
        print(f"ERROR: {db_path} does not exist", file=sys.stderr)
        sys.exit(1)

    conn = sqlite3.connect(str(db_path), isolation_level=None)
    conn.executescript("BEGIN; " + SCHEMA_SQL + " COMMIT;")

    pending = get_pending(conn, args.limit)
    total = len(pending)
    existing_pairs = conn.execute("SELECT COUNT(*) FROM production_role_pairs").fetchone()[0]
    print(f"production_role_pairs (before): {existing_pairs:,}")
    print(f"Pending artworks: {total:,}")
    if total == 0:
        print("Nothing to do.")
        stamp_version_info(conn)
        return

    session = make_session()
    batch: list[tuple[int, str, list]] = []
    processed = 0
    ok = err = notfound = 0
    pair_total = 0
    t0 = time.time()

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {
            ex.submit(process_one, session, aid, hmo): (aid, hmo)
            for aid, hmo in pending
        }
        for f in as_completed(futs):
            try:
                art_id, status, pairs = f.result()
            except Exception as e:
                aid, hmo = futs[f]
                print(f"  Exception art_id={aid} hmo={hmo}: {e}", flush=True)
                batch.append((aid, "error", []))
                err += 1
            else:
                batch.append((art_id, status, pairs))
                if status == "ok":
                    ok += 1
                    pair_total += len(pairs)
                elif status == "not_found":
                    notfound += 1
                else:
                    err += 1

            processed += 1
            if len(batch) >= args.batch_size:
                commit_batch(conn, batch)
                batch.clear()
                elapsed = time.time() - t0
                rate = processed / elapsed if elapsed > 0 else 0
                eta_min = (total - processed) / rate / 60 if rate > 0 else 0
                print(
                    f"  [{processed:,}/{total:,}] ok={ok:,} 404={notfound:,} "
                    f"err={err:,} new_pairs={pair_total:,} "
                    f"({rate:.1f}/s, ETA {eta_min:.1f} min)",
                    flush=True,
                )

    if batch:
        commit_batch(conn, batch)

    after = conn.execute("SELECT COUNT(*) FROM production_role_pairs").fetchone()[0]
    elapsed = time.time() - t0
    print(
        f"\nDone. Processed {processed:,} in {elapsed/60:.1f} min. "
        f"ok={ok:,}, 404={notfound:,}, err={err:,}. "
        f"production_role_pairs (after): {after:,} (+{after - existing_pairs:,})."
    )
    stamp_version_info(conn)
    if err > 0:
        print(f"WARNING: {err:,} fetch errors — rerun to retry only those.")
        sys.exit(2)


if __name__ == "__main__":
    main()
