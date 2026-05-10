"""Sanity-check spot inspection: for a curated set of vocab_ids from the
Wikidata-authoritative bucket, pull
  - vocabulary row (label, current lat/lon, broader chain)
  - Rijksmuseum dump's published external equivalents
  - Wikidata entity's English + Dutch label (live REST fetch)
  - Artworks attached (titles, dates, co-tagged places)
  - Side-by-side existing-vs-Wikidata coord comparison

Goal: confirm before any DB write that for the dramatic-Δ rewrites the
Wikidata answer is geographically correct AND consistent with what
Rijksmuseum's other metadata says about the place.
"""
import csv
import json
import re
import sqlite3
import sys
import time
import urllib.request
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent
DUMP_DIR = Path.home() / "Downloads" / "rijksmuseum-data-dumps" / "place_extracted"
DB = PROJECT_DIR / "data" / "vocabulary.db"
COORDS_CSV = PROJECT_DIR / "data" / "tgn-rdf-rijks-wikidata-coords.csv"

USER_AGENT = ("rijksmuseum-mcp-plus/0.30 "
              "(https://github.com/kintopp/rijksmuseum-mcp-plus; "
              "arno.bosse@gmail.com)")

# 5 sample cases: 4 large-Δ + 1 small-Δ control.
SAMPLES: list[tuple[str, str]] = [
    ("23022453", "Q16635 — 243° delta — Guam vs US-centroid"),
    ("23028873", "Q42070  — 105° delta — Mongolia vs Burkina Faso"),
    ("23030846", "Q46197  — 62°  delta — Ascension Is. vs Isle of Man"),
    ("23025981", "Q782    — 59°  delta — Hawaii vs US centroid"),
    ("23029447", "Q485553 — ~10km delta — small-Δ control"),
]

RE_EQUIVALENT = re.compile(
    r"<https://id\.rijksmuseum\.nl/(\d+)>\s+<http[^>]+>\s+<(http[^>]+)>"
)
RE_NAME = re.compile(
    r"<https://id\.rijksmuseum\.nl/(\d+)>\s+"
    r"<http://www\.cidoc-crm\.org/cidoc-crm/P190_has_symbolic_content>\s+"
    r'"([^"]*)"'
)


def fetch_wikidata_labels(qid: str) -> dict[str, str]:
    url = f"https://www.wikidata.org/wiki/Special:EntityData/{qid}.json"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read())
    entities = data.get("entities", {}) or {}
    if not entities:
        return {}
    ent = entities[next(iter(entities))]
    labels = ent.get("labels") or {}
    return {lang: labels[lang]["value"]
            for lang in ("en", "nl", "de", "fr") if lang in labels}


def rijks_dump(vid: str) -> tuple[list[str], str | None]:
    fpath = DUMP_DIR / vid
    if not fpath.exists():
        return [], None
    text = fpath.read_text()
    eqs: list[str] = []
    for m in RE_EQUIVALENT.finditer(text):
        if m.group(1) == vid:
            obj = m.group(2)
            if obj.startswith(("http://vocab.getty.edu/", "http://www.wikidata.org",
                               "https://sws.geonames.org", "http://sws.geonames.org")):
                eqs.append(obj)
    name = None
    for m in RE_NAME.finditer(text):
        # Bnode names attach via P190; skip — keep only direct subject names if any.
        pass
    return eqs, name


def vocab_row(conn, vid):
    r = conn.execute(
        "SELECT id, label_en, label_nl, lat, lon, coord_method, "
        "coord_method_detail, external_id, broader_id, placetype "
        "FROM vocabulary WHERE id = ?", (vid,)).fetchone()
    if r is None:
        return None
    cols = ["id", "label_en", "label_nl", "lat", "lon", "coord_method",
            "coord_method_detail", "external_id", "broader_id", "placetype"]
    return dict(zip(cols, r))


def broader_chain(conn, vid):
    chain = []
    cur = vid
    for _ in range(5):
        r = conn.execute(
            "SELECT broader_id, label_en, label_nl FROM vocabulary WHERE id = ?",
            (cur,)).fetchone()
        if r is None:
            break
        br, en, nl = r
        chain.append(f"{cur} ({en or nl or '∅'})")
        if not br or br == cur:
            break
        cur = br
    return chain


def fetch_artworks(conn, vid, max_rows=10):
    rows = conn.execute(
        """
        SELECT a.object_number, a.title, a.creator_label,
               a.date_earliest, a.date_latest, a.date_display, f.name AS field
        FROM mappings m
        JOIN artworks a ON a.art_id = m.artwork_id
        JOIN vocabulary v ON v.vocab_int_id = m.vocab_rowid
        JOIN field_lookup f ON f.id = m.field_id
        WHERE v.id = ?
        ORDER BY a.date_earliest, a.object_number LIMIT ?
        """, (vid, max_rows)).fetchall()
    cols = ["object_number", "title", "creator_label",
            "date_earliest", "date_latest", "date_display", "field"]
    return [dict(zip(cols, r)) for r in rows]


def co_places(conn, object_number, exclude_vid):
    rows = conn.execute(
        """
        SELECT v.label_en, v.label_nl, f.name
        FROM mappings m
        JOIN artworks a ON a.art_id = m.artwork_id
        JOIN vocabulary v ON v.vocab_int_id = m.vocab_rowid
        JOIN field_lookup f ON f.id = m.field_id
        WHERE a.object_number = ?
          AND v.type = 'place'
          AND v.id != ?
        """, (object_number, exclude_vid)).fetchall()
    return [(en or nl or "∅", field) for en, nl, field in rows]


def total_artwork_count(conn, vid):
    r = conn.execute(
        """
        SELECT COUNT(DISTINCT a.art_id)
        FROM mappings m
        JOIN artworks a ON a.art_id = m.artwork_id
        JOIN vocabulary v ON v.vocab_int_id = m.vocab_rowid
        WHERE v.id = ?
        """, (vid,)).fetchone()
    return r[0] if r else 0


def main() -> int:
    coords = {r["vocab_id"]: r for r in csv.DictReader(COORDS_CSV.open(newline=""))}
    conn = sqlite3.connect(str(DB))

    for vid, headline in SAMPLES:
        print("\n" + "═" * 78)
        print(f"  {headline}")
        print(f"  vocab_id = {vid}")
        print("═" * 78)

        v = vocab_row(conn, vid)
        if v is None:
            print(f"  vocab_id {vid} not found in DB"); continue
        c = coords.get(vid)
        if c is None:
            print(f"  vocab_id {vid} not found in coords CSV"); continue

        print(f"  Rijks vocabulary entry:")
        print(f"      label_en   : {v['label_en']!r}")
        print(f"      label_nl   : {v['label_nl']!r}")
        print(f"      placetype  : {v['placetype']}")
        chain = broader_chain(conn, vid)
        print(f"      broader chain: {' → '.join(chain)}")

        eqs, _ = rijks_dump(vid)
        print(f"  Rijks dump equivalents ({len(eqs)}):")
        for u in eqs:
            print(f"      {u}")

        # Live Wikidata label fetch.
        try:
            wd_labels = fetch_wikidata_labels(c["qid"])
        except Exception as exc:
            wd_labels = {}
            print(f"  Wikidata label fetch failed: {exc}")
        print(f"  Wikidata {c['qid']} labels:")
        for lang in ("en", "nl", "de", "fr"):
            if lang in wd_labels:
                print(f"      [{lang}] {wd_labels[lang]}")

        ex_lat = float(c["existing_lat"]) if c["existing_lat"] else None
        ex_lon = float(c["existing_lon"]) if c["existing_lon"] else None
        wd_lat = float(c["wikidata_lat"])
        wd_lon = float(c["wikidata_lon"])
        print(f"  Coord comparison:")
        print(f"      existing  : ({ex_lat}, {ex_lon})  via "
              f"{c['existing_method_detail']}")
        print(f"      wikidata  : ({wd_lat}, {wd_lon})  via P625")

        n_total = total_artwork_count(conn, vid)
        arts = fetch_artworks(conn, vid, max_rows=8)
        print(f"  Artworks attached: {n_total} total — first {len(arts)} shown")
        for a in arts:
            date_str = a['date_display'] or (
                f"{a['date_earliest']}–{a['date_latest']}"
                if a['date_earliest'] else "(no date)")
            print(f"      {a['object_number']} [{a['field']}]  {date_str}")
            print(f"        title: {a['title']!r}")
            cops = co_places(conn, a['object_number'], vid)
            if cops:
                co_str = ", ".join(f"{lab}[{f}]" for lab, f in cops[:5])
                print(f"        co-places: {co_str}")
        time.sleep(0.6)

    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
