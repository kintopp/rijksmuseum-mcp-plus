#!/usr/bin/env python3
"""Detail report on the 6 rows where Rijksmuseum's published TGN ID differs
from the TGN ID the reconciliation pipeline assigned.

For each disagreement, show:
  - vocabulary row (label, lat/lon, coord_method, broader_id chain)
  - Rijksmuseum dump excerpt (equivalent + sameAs URIs, schema:name)
  - CSV row (existing coord, TGN-RDF coord, deltas)
  - Brief TGN-RDF lookup for both IDs (label only — no coord refetch)
"""
import csv
import re
import sqlite3
import sys
import urllib.request
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent
DUMP_DIR = Path.home() / "Downloads" / "rijksmuseum-data-dumps" / "place_extracted"
CSV_PATH = PROJECT_DIR / "data" / "tgn-rdf-discrepancies.csv"
DB_PATH = PROJECT_DIR / "data" / "vocabulary.db"

RE_EQUIVALENT = re.compile(
    r"<https://id\.rijksmuseum\.nl/(\d+)>\s+"
    r"<https://linked\.art/ns/terms/equivalent>\s+"
    r"<(http[^>]+)>"
)
RE_SAME_AS = re.compile(
    r"<https://id\.rijksmuseum\.nl/(\d+)>\s+"
    r"<http://schema\.org/sameAs>\s+"
    r"<(http[^>]+)>"
)
RE_NAME = re.compile(
    r"<https://id\.rijksmuseum\.nl/(\d+)>\s+"
    r"<http://schema\.org/name>\s+"
    r'"([^"]*)"'
)
RE_PREF_LABEL = re.compile(
    rb"<http://www\.w3\.org/2008/05/skos-xl#prefLabelLiteralForm>\s+"
    rb'"([^"]*)"'
)


def equivalents_for(place_id: str) -> tuple[list[str], str | None]:
    fpath = DUMP_DIR / place_id
    if not fpath.exists():
        return [], None
    text = fpath.read_text()
    eqs: list[str] = []
    for rx in (RE_EQUIVALENT, RE_SAME_AS):
        for m in rx.finditer(text):
            if m.group(1) == place_id:
                eqs.append(m.group(2))
    name = None
    nm = RE_NAME.search(text)
    if nm and nm.group(1) == place_id:
        name = nm.group(2)
    return eqs, name


def fetch_tgn_label(tgn_id: str) -> str:
    url = f"http://vocab.getty.edu/tgn/{tgn_id}.rdf"
    try:
        req = urllib.request.Request(url, headers={"Accept": "application/rdf+xml"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = resp.read()
    except Exception as exc:
        return f"<fetch error: {exc}>"
    m = RE_PREF_LABEL.search(body)
    return m.group(1).decode("utf-8", "replace") if m else "<no label>"


def vocab_row(conn: sqlite3.Connection, vocab_id: str) -> dict | None:
    r = conn.execute(
        """
        SELECT id, label_en, label_nl, lat, lon,
               coord_method, coord_method_detail,
               external_id, broader_id,
               placetype, placetype_source
        FROM vocabulary
        WHERE id = ?
        """,
        (vocab_id,),
    ).fetchone()
    if r is None:
        return None
    cols = ["id", "label_en", "label_nl", "lat", "lon",
            "coord_method", "coord_method_detail",
            "external_id", "broader_id",
            "placetype", "placetype_source"]
    return dict(zip(cols, r))


def vei_rows(conn: sqlite3.Connection, vocab_id: str) -> list[tuple[str, str, str]]:
    rows = conn.execute(
        "SELECT authority, id, uri FROM vocabulary_external_ids WHERE vocab_id = ?",
        (vocab_id,),
    ).fetchall()
    return list(rows)


def broader_chain(conn: sqlite3.Connection, vocab_id: str, depth: int = 4) -> list[str]:
    chain = []
    cur = vocab_id
    for _ in range(depth):
        r = conn.execute(
            "SELECT broader_id, label_en FROM vocabulary WHERE id = ?", (cur,)
        ).fetchone()
        if r is None:
            break
        broader, label = r
        chain.append(f"{cur} ({label or '∅'})")
        if not broader or broader == cur:
            break
        cur = broader
    return chain


def main() -> int:
    rows = []
    with CSV_PATH.open() as f:
        reader = csv.DictReader(f)
        for r in reader:
            rows.append(r)

    seen: set[tuple[str, str]] = set()
    disagreements: list[tuple[dict, list[str], str | None]] = []
    for r in rows:
        vid = r["vocab_id"]
        csv_tgn = r["tgn_id"]
        eqs, name = equivalents_for(vid)
        dump_tgn_ids = {u.rstrip("/").rsplit("/", 1)[-1]
                        for u in eqs if "vocab.getty.edu/tgn/" in u}
        if dump_tgn_ids and csv_tgn not in dump_tgn_ids:
            key = (vid, csv_tgn)
            if key in seen:
                continue
            seen.add(key)
            disagreements.append((r, eqs, name))

    print(f"Found {len(disagreements)} unique disagreement rows.\n")

    conn = sqlite3.connect(str(DB_PATH))

    for i, (r, eqs, dump_name) in enumerate(disagreements, 1):
        vid = r["vocab_id"]
        csv_tgn = r["tgn_id"]
        dump_tgn_ids = sorted(
            u.rstrip("/").rsplit("/", 1)[-1]
            for u in eqs if "vocab.getty.edu/tgn/" in u
        )
        print(f"━━━ #{i}  vocab_id={vid}  ━━━")
        v = vocab_row(conn, vid)
        if v:
            print(f"  vocabulary.label_en   : {v['label_en']!r}")
            print(f"  vocabulary.label_nl   : {v['label_nl']!r}")
            print(f"  vocabulary.lat/lon    : ({v['lat']}, {v['lon']})")
            print(f"  vocabulary.coord_method: {v['coord_method']} / "
                  f"{v['coord_method_detail']}")
            print(f"  vocabulary.external_id: {v['external_id']}")
            print(f"  vocabulary.placetype  : {v['placetype']} "
                  f"(source={v['placetype_source']})")
            chain = broader_chain(conn, vid)
            print(f"  broader chain         : {' → '.join(chain)}")
            vei = vei_rows(conn, vid)
            print(f"  vocabulary_external_ids ({len(vei)}):")
            for auth, lid, uri in vei:
                print(f"      [{auth}] {lid}  {uri}")
        else:
            print(f"  (vocab_id {vid} not in vocabulary.db)")
        print(f"  Rijks dump schema:name: {dump_name!r}")
        print(f"  Rijks dump equivalents ({len(eqs)}):")
        for u in eqs:
            print(f"      {u}")
        print(f"  CSV row:")
        print(f"      tgn_id (reconciled)        = {csv_tgn}")
        print(f"      Rijks dump TGN ID(s)       = {dump_tgn_ids}")
        print(f"      existing lat/lon           = "
              f"({r['existing_lat']}, {r['existing_lon']})")
        print(f"      tgn-rdf lat/lon (csv_tgn)  = "
              f"({r['tgn_lat']}, {r['tgn_lon']})")
        print(f"      delta                      = "
              f"({r['delta_lat']}, {r['delta_lon']})")
        print(f"      via                        = {r['existing_method_detail']}")
        print(f"  Live TGN labels:")
        print(f"      {csv_tgn} (reconciled): {fetch_tgn_label(csv_tgn)}")
        for did in dump_tgn_ids:
            print(f"      {did} (Rijks dump):  {fetch_tgn_label(did)}")
        print()

    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
