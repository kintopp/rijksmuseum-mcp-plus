"""Q7 — replay gov.genealogy.net API calls from Python `requests` using cookies
captured from dev-browser after Anubis was solved interactively.

Tests batch viability for the planned GOV gazetteer probe.

Usage:
    1. Solve Anubis once via dev-browser, capture cookies to gov-cookies.json
       (already done in offline/geo/gov-probe/sample-responses/q7-cookies.json)
    2. Run: ~/miniconda3/envs/embeddings/bin/python scripts/tests/test-gov-cookie-replay.py

Output: stdout summary + offline/geo/gov-probe/q7-batch-replay.csv
"""
from __future__ import annotations

import csv
import json
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent.parent
COOKIE_FILE = ROOT / "offline" / "geo" / "gov-probe" / "sample-responses" / "q7-cookies.json"
OUT_CSV = ROOT / "offline" / "geo" / "gov-probe" / "q7-batch-replay.csv"

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
)


def main() -> None:
    blob = json.loads(COOKIE_FILE.read_text())
    captured_at = blob["captured_at_unix"]
    cookies = blob["cookies"]
    print(f"loaded {len(cookies)} cookies from dev-browser (captured {int(time.time()) - captured_at}s ago)")

    sess = requests.Session()
    sess.headers.update({
        "User-Agent": UA,
        "Accept-Language": "en-US,en;q=0.9",
    })
    for c in cookies:
        # only attach cookies whose domain matches genealogy.net — both wiki and gov subdomains
        sess.cookies.set(
            c["name"], c["value"],
            domain=c["domain"], path=c["path"],
            secure=c.get("secure", False),
        )
    print(f"  active cookies: {[(ck.name, ck.domain) for ck in sess.cookies]}")

    # 50 sequential GET /api/checkObjectId
    target = "https://gov.genealogy.net/api/checkObjectId"
    rows = []
    accept_text = {"Accept": "text/plain"}
    print("\nbatch — 50 calls @ 1.1s spacing")
    for i in range(50):
        t0 = time.time()
        try:
            r = sess.get(target, params={"itemId": "SCHERGJO54EJ"}, headers=accept_text, timeout=15)
            elapsed_ms = int((time.time() - t0) * 1000)
            body = r.text
            ct = r.headers.get("content-type", "")
            anubis_hint = "anubis" in body.lower() or "ohnoes" in body.lower() or "noes" in body.lower()
            rows.append({
                "i": i,
                "ts_unix": int(t0),
                "status": r.status_code,
                "elapsed_ms": elapsed_ms,
                "content_type": ct,
                "bytes": len(body),
                "body_head": body[:80].replace("\n", "\\n"),
                "anubis_hint": anubis_hint,
            })
            tag = "✓" if r.status_code == 200 and not anubis_hint else "✗"
            if i % 5 == 0 or anubis_hint or r.status_code != 200:
                print(f"  {tag} i={i:>2} HTTP {r.status_code} ({len(body)}b, {ct[:30]}) {elapsed_ms}ms  body[:50]={body[:50]!r}")
        except Exception as e:
            elapsed_ms = int((time.time() - t0) * 1000)
            rows.append({
                "i": i, "ts_unix": int(t0), "status": "ERR", "elapsed_ms": elapsed_ms,
                "content_type": "", "bytes": 0, "body_head": str(e)[:80], "anubis_hint": False,
            })
            print(f"  ✗ i={i:>2} EXCEPTION {e}")
        time.sleep(1.1)

    # write csv
    with OUT_CSV.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    print(f"\nwrote {OUT_CSV.relative_to(ROOT)}")

    # summary
    successes = sum(1 for r in rows if r["status"] == 200 and not r["anubis_hint"])
    anubis_block = sum(1 for r in rows if r["anubis_hint"])
    other_fail = sum(1 for r in rows if r["status"] != 200 and not r["anubis_hint"])
    avg_ms = sum(r["elapsed_ms"] for r in rows) / max(1, len(rows))
    print(f"\nsummary: success={successes}/{len(rows)}  anubis_block={anubis_block}  other_fail={other_fail}  avg_latency={avg_ms:.0f}ms")


if __name__ == "__main__":
    main()
