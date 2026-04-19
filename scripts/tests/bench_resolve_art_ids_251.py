#!/usr/bin/env python3
"""Bench harness for issue #251: temp-table-JOIN vs correlated SUBSTR UPDATE.

Builds a tiny synthetic DB (configurable size) with `artworks`, `related_objects`,
and `artwork_parent` tables that mirror the v0.24 layout, runs both the OLD
correlated SUBSTR UPDATE and the NEW temp-table JOIN, and reports:

  * resolution counts (must be identical between old and new)
  * wall-clock time per UPDATE
  * EXPLAIN QUERY PLAN for the NEW path (must show USING INDEX _tmp_hmo_art_idx)

Default size (1k artworks, 500 related, 500 parent) keeps the OLD path under
5 seconds so the bench finishes interactively. Bump --artworks 50000 to
reproduce the harvest-time stall regime (OLD: minutes; NEW: <1 s).

Usage:
    python -u scripts/tests/bench_resolve_art_ids_251.py [--artworks N] [--related M] [--parent M]
"""
from __future__ import annotations

import argparse
import sqlite3
import time


def build_db(conn: sqlite3.Connection, n_artworks: int, n_related: int, n_parent: int) -> None:
    cur = conn.cursor()
    cur.execute("""
        CREATE TABLE artworks (
            art_id INTEGER PRIMARY KEY,
            linked_art_uri TEXT
        )
    """)
    cur.execute("""
        CREATE TABLE related_objects (
            rowid INTEGER PRIMARY KEY,
            related_la_uri TEXT,
            related_art_id INTEGER
        )
    """)
    cur.execute("""
        CREATE TABLE artwork_parent (
            rowid INTEGER PRIMARY KEY,
            parent_la_uri TEXT,
            parent_art_id INTEGER
        )
    """)

    cur.executemany(
        "INSERT INTO artworks (art_id, linked_art_uri) VALUES (?, ?)",
        [(i, f"https://data.rijksmuseum.nl/{200000000 + i}") for i in range(1, n_artworks + 1)],
    )
    # related_objects: every other row references a real artwork (so we can
    # measure resolution counts), the rest reference unknown URIs.
    cur.executemany(
        "INSERT INTO related_objects (related_la_uri, related_art_id) VALUES (?, NULL)",
        [
            (f"https://data.rijksmuseum.nl/{200000000 + (i % n_artworks) + 1}",) if i % 2 == 0
            else (f"https://data.rijksmuseum.nl/{900000000 + i}",)
            for i in range(n_related)
        ],
    )
    cur.executemany(
        "INSERT INTO artwork_parent (parent_la_uri, parent_art_id) VALUES (?, NULL)",
        [
            (f"https://data.rijksmuseum.nl/{200000000 + (i % n_artworks) + 1}",) if i % 2 == 0
            else (f"https://data.rijksmuseum.nl/{900000000 + i}",)
            for i in range(n_parent)
        ],
    )
    conn.commit()


def run_old(conn: sqlite3.Connection) -> tuple[float, float, int, int]:
    cur = conn.cursor()
    cur.execute("UPDATE related_objects SET related_art_id = NULL")
    cur.execute("UPDATE artwork_parent SET parent_art_id = NULL")
    conn.commit()

    t = time.time()
    cur.execute("""
        UPDATE related_objects SET related_art_id = (
            SELECT a.art_id FROM artworks a
            WHERE SUBSTR(a.linked_art_uri, INSTR(a.linked_art_uri, '.nl/') + 4) =
                  SUBSTR(related_objects.related_la_uri, INSTR(related_objects.related_la_uri, '.nl/') + 4)
        )
        WHERE related_art_id IS NULL
    """)
    conn.commit()
    elapsed_ro = time.time() - t

    t = time.time()
    cur.execute("""
        UPDATE artwork_parent SET parent_art_id = (
            SELECT a.art_id FROM artworks a
            WHERE SUBSTR(a.linked_art_uri, INSTR(a.linked_art_uri, '.nl/') + 4) =
                  SUBSTR(artwork_parent.parent_la_uri, INSTR(artwork_parent.parent_la_uri, '.nl/') + 4)
        )
        WHERE parent_art_id IS NULL
    """)
    conn.commit()
    elapsed_ap = time.time() - t

    n_ro = cur.execute("SELECT COUNT(*) FROM related_objects WHERE related_art_id IS NOT NULL").fetchone()[0]
    n_ap = cur.execute("SELECT COUNT(*) FROM artwork_parent WHERE parent_art_id IS NOT NULL").fetchone()[0]
    return elapsed_ro, elapsed_ap, n_ro, n_ap


def run_new(conn: sqlite3.Connection) -> tuple[float, float, int, int, str]:
    cur = conn.cursor()
    cur.execute("UPDATE related_objects SET related_art_id = NULL")
    cur.execute("UPDATE artwork_parent SET parent_art_id = NULL")
    conn.commit()

    cur.execute("""
        CREATE TEMP TABLE _tmp_hmo_art AS
        SELECT art_id,
               SUBSTR(linked_art_uri, INSTR(linked_art_uri, '.nl/') + 4) AS hmo_id
        FROM artworks
        WHERE linked_art_uri IS NOT NULL
          AND linked_art_uri != ''
          AND art_id IS NOT NULL
    """)
    cur.execute("CREATE INDEX _tmp_hmo_art_idx ON _tmp_hmo_art(hmo_id)")

    plan_rows = cur.execute("""
        EXPLAIN QUERY PLAN
        UPDATE related_objects SET related_art_id = (
            SELECT hmo.art_id FROM _tmp_hmo_art hmo
            WHERE hmo.hmo_id = SUBSTR(related_objects.related_la_uri,
                                      INSTR(related_objects.related_la_uri, '.nl/') + 4)
        )
        WHERE related_art_id IS NULL
    """).fetchall()
    plan = "\n".join(str(r) for r in plan_rows)

    t = time.time()
    cur.execute("""
        UPDATE related_objects SET related_art_id = (
            SELECT hmo.art_id FROM _tmp_hmo_art hmo
            WHERE hmo.hmo_id = SUBSTR(related_objects.related_la_uri,
                                      INSTR(related_objects.related_la_uri, '.nl/') + 4)
        )
        WHERE related_art_id IS NULL
    """)
    conn.commit()
    elapsed_ro = time.time() - t

    t = time.time()
    cur.execute("""
        UPDATE artwork_parent SET parent_art_id = (
            SELECT hmo.art_id FROM _tmp_hmo_art hmo
            WHERE hmo.hmo_id = SUBSTR(artwork_parent.parent_la_uri,
                                      INSTR(artwork_parent.parent_la_uri, '.nl/') + 4)
        )
        WHERE parent_art_id IS NULL
    """)
    conn.commit()
    elapsed_ap = time.time() - t

    n_ro = cur.execute("SELECT COUNT(*) FROM related_objects WHERE related_art_id IS NOT NULL").fetchone()[0]
    n_ap = cur.execute("SELECT COUNT(*) FROM artwork_parent WHERE parent_art_id IS NOT NULL").fetchone()[0]
    cur.execute("DROP TABLE _tmp_hmo_art")
    return elapsed_ro, elapsed_ap, n_ro, n_ap, plan


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--artworks", type=int, default=1000)
    p.add_argument("--related", type=int, default=500)
    p.add_argument("--parent",  type=int, default=500)
    args = p.parse_args()

    conn = sqlite3.connect(":memory:")
    print(f"Building synthetic DB: {args.artworks:,} artworks, "
          f"{args.related:,} related_objects, {args.parent:,} artwork_parent")
    build_db(conn, args.artworks, args.related, args.parent)

    print("\n--- OLD: correlated SUBSTR UPDATE ---")
    old_ro, old_ap, n_ro_old, n_ap_old = run_old(conn)
    print(f"  related_objects: {old_ro*1000:.1f} ms, resolved {n_ro_old:,}")
    print(f"  artwork_parent:  {old_ap*1000:.1f} ms, resolved {n_ap_old:,}")

    print("\n--- NEW: temp-table JOIN (#251 fix) ---")
    new_ro, new_ap, n_ro_new, n_ap_new, plan = run_new(conn)
    print(f"  related_objects: {new_ro*1000:.1f} ms, resolved {n_ro_new:,}")
    print(f"  artwork_parent:  {new_ap*1000:.1f} ms, resolved {n_ap_new:,}")

    print("\n--- EXPLAIN QUERY PLAN (NEW related_objects) ---")
    print(plan)

    print("\n--- Parity check ---")
    parity_ok = (n_ro_old == n_ro_new) and (n_ap_old == n_ap_new)
    print(f"  related_objects: {'OK' if n_ro_old == n_ro_new else 'MISMATCH'} ({n_ro_old} vs {n_ro_new})")
    print(f"  artwork_parent:  {'OK' if n_ap_old == n_ap_new else 'MISMATCH'} ({n_ap_old} vs {n_ap_new})")

    print("\n--- Index usage check ---")
    uses_index = "_tmp_hmo_art_idx" in plan
    print(f"  USING INDEX _tmp_hmo_art_idx: {'OK' if uses_index else 'MISSING'}")

    speedup_ro = old_ro / max(new_ro, 1e-9)
    speedup_ap = old_ap / max(new_ap, 1e-9)
    print(f"\nSpeedup: related_objects ×{speedup_ro:.1f}, artwork_parent ×{speedup_ap:.1f}")

    return 0 if parity_ok and uses_index else 1


if __name__ == "__main__":
    raise SystemExit(main())
