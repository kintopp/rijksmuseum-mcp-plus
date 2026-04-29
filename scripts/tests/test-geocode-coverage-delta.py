"""Gate 3 — pre/post coverage delta by region. Flags any country bucket
that lost more than 5 percentage points of coverage between the baseline
DB and the post-bundle DB.

Country binning uses the broader_id walk (mirrors Phase 3b's country
hint derivation). Places without a derivable country fall into 'other'.

Run:
    ~/miniconda3/envs/embeddings/bin/python \
      scripts/tests/test-geocode-coverage-delta.py \
      --db data/vocabulary.db \
      --baseline-db offline/backups/vocabulary-pre-v025-cold-rerun.db
"""
from __future__ import annotations

import argparse
import importlib.util
import sqlite3
import sys
from collections import defaultdict
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _test_helpers import run_test_functions

GP_PATH = REPO_ROOT / "scripts" / "geocode_places.py"
spec = importlib.util.spec_from_file_location("geocode_places", GP_PATH)
gp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gp)

DROP_THRESHOLD_PP = 5.0  # flag countries with >5pp coverage drop


def _open_ro(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    return conn


def _country_buckets(conn: sqlite3.Connection
                     ) -> tuple[dict[str, list[str]], dict[str, str]]:
    """Bucket every place into a country ISO2 (or 'other')."""
    broader_by_id, wd_qid_by_id = gp._build_country_derivation_maps(conn)
    rows = conn.execute(
        "SELECT id, lat FROM vocabulary WHERE type='place'"
    ).fetchall()
    by_country: dict[str, list[str]] = defaultdict(list)
    iso_by_id: dict[str, str] = {}
    for vid, _ in rows:
        qid = gp._derive_country_qid(vid, broader_by_id, wd_qid_by_id)
        iso2 = gp.COUNTRY_QID_TO_ISO2.get(qid, "other") if qid else "other"
        by_country[iso2].append(vid)
        iso_by_id[vid] = iso2
    return by_country, iso_by_id


def _coverage_by_country(conn: sqlite3.Connection,
                          by_country: dict[str, list[str]]
                          ) -> dict[str, tuple[int, int]]:
    """Returns {iso2: (with_coords, total)}."""
    out: dict[str, tuple[int, int]] = {}
    for iso2, ids in by_country.items():
        if not ids:
            continue
        chunk = 800
        with_coords = 0
        for i in range(0, len(ids), chunk):
            slice_ = ids[i:i + chunk]
            placeholders = ",".join("?" * len(slice_))
            n = conn.execute(
                f"SELECT COUNT(*) FROM vocabulary "
                f" WHERE id IN ({placeholders}) AND lat IS NOT NULL",
                slice_,
            ).fetchone()[0]
            with_coords += n
        out[iso2] = (with_coords, len(ids))
    return out


def test_no_country_drops_more_than_threshold(ctx) -> None:
    pre = ctx["pre_cov"]
    post = ctx["post_cov"]
    drops: list[tuple[str, float, int, int]] = []
    for iso2, (pre_n, total) in pre.items():
        post_n, _ = post.get(iso2, (0, total))
        if total < 20:
            continue  # skip tiny buckets where 1 row = >5pp
        pre_pct = 100.0 * pre_n / total
        post_pct = 100.0 * post_n / total
        delta = post_pct - pre_pct
        if delta < -DROP_THRESHOLD_PP:
            drops.append((iso2, delta, pre_n, post_n))
    if drops:
        msg = "; ".join(
            f"{iso}: {pre}→{post} ({d:+.1f}pp)"
            for iso, d, pre, post in drops
        )
        raise AssertionError(f"countries with >{DROP_THRESHOLD_PP}pp drop: {msg}")


def test_overall_delta_non_negative(ctx) -> None:
    pre = ctx["pre_cov"]
    post = ctx["post_cov"]
    pre_total = sum(t for _, t in pre.values())
    pre_with = sum(w for w, _ in pre.values())
    post_with = sum(post.get(iso, (0, 0))[0] for iso in pre)
    pre_pct = 100.0 * pre_with / pre_total if pre_total else 0
    post_pct = 100.0 * post_with / pre_total if pre_total else 0
    delta = post_pct - pre_pct
    print(f"  (info) overall coverage: pre={pre_pct:.1f}% post={post_pct:.1f}% "
          f"delta={delta:+.1f}pp", file=sys.stderr)
    # Stage E should net-add coverage; if it doesn't, something's wrong
    assert delta >= 0, f"overall coverage regressed by {-delta:.1f}pp"


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--db", default="data/vocabulary.db", type=Path)
    p.add_argument("--baseline-db",
                   default="offline/backups/vocabulary-pre-v025-cold-rerun.db",
                   type=Path)
    args = p.parse_args()
    if not args.db.exists() or not args.baseline_db.exists():
        print("FAIL: --db or --baseline-db missing", file=sys.stderr)
        return 1

    pre_conn = _open_ro(args.baseline_db)
    post_conn = _open_ro(args.db)
    try:
        # Country binning is computed once against the post DB (current
        # broader-chain shape). We use those buckets to query both DBs.
        by_country, _ = _country_buckets(post_conn)
        ctx = {
            "pre_cov": _coverage_by_country(pre_conn, by_country),
            "post_cov": _coverage_by_country(post_conn, by_country),
        }
        tests = [v for k, v in globals().items()
                 if k.startswith("test_") and callable(v)]
        return run_test_functions(tests, ctx)
    finally:
        pre_conn.close()
        post_conn.close()


if __name__ == "__main__":
    sys.exit(main())
