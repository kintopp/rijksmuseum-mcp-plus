#!/usr/bin/env python3
"""LIDO 2020 subject extractor — supplements `data/lido-events-snapshot.db`.

The original `extract-lido-events.py` skipped `lido:subjectSet` content
(only emitted a `subject_count` per record). This second pass streams the
same source XML and writes a focused `lido_subjects` table carrying the
per-record subjectConcept entries — iconclass URIs/notations + bilingual
labels — needed to recover the 88 #245 subject-orphan mappings.

Run:
    ~/miniconda3/envs/embeddings/bin/python scripts/extract-lido-subjects.py

Wall time: ~10 min for 657K records (mirrors extract-lido-events.py's
streaming pattern: XMLPullParser + elem.clear() per record).
"""
from __future__ import annotations

import argparse
import re
import sqlite3
import sys
import time
from pathlib import Path
from xml.etree import ElementTree as ET

LIDO_NS = "http://www.lido-schema.org"
XML_NS = "http://www.w3.org/XML/1998/namespace"
NS = {"lido": LIDO_NS}

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DUMP = Path("/Users/abosse/Downloads/rijksmuseum-data-dumps/202001-rma-lido-collection.xml")
DEFAULT_DB = PROJECT_ROOT / "data" / "lido-events-snapshot.db"

PRIREF_RE = re.compile(r"RM0001\.[Cc][Oo][Ll][Ll][Ee][Cc][Tt]\.(\d+)\b")
RECID_PRIREF_RE = re.compile(r"/lido/(\d+)\b")

# Iconclass URLs in the wild come in several shapes — capture the notation
# from any of them.
ICONCLASS_URL_RES = [
    re.compile(r"^https?://(?:www\.)?iconclass\.org/(?:rkd/)?(\S+)$"),
    re.compile(r"^https?://iconclass\.org/notation/(\S+)$"),
]


SCHEMA_DDL = """
CREATE TABLE IF NOT EXISTS lido_subjects (
    id INTEGER PRIMARY KEY,
    priref INTEGER NOT NULL,
    subject_index INTEGER NOT NULL,
    concept_id TEXT,
    concept_id_type TEXT,
    notation TEXT,
    term_text TEXT,
    term_lang TEXT,
    FOREIGN KEY (priref) REFERENCES lido_records(priref)
);
CREATE INDEX IF NOT EXISTS idx_lido_subjects_priref ON lido_subjects(priref);
CREATE INDEX IF NOT EXISTS idx_lido_subjects_notation ON lido_subjects(notation) WHERE notation IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lido_subjects_concept_id ON lido_subjects(concept_id) WHERE concept_id IS NOT NULL;
"""


def local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def text_of(elem):
    if elem is None or not elem.text:
        return None
    t = elem.text.strip()
    return t or None


def lang_of(elem):
    if elem is None:
        return None
    return elem.attrib.get(f"{{{XML_NS}}}lang")


def attr(elem, name):
    if elem is None:
        return None
    return elem.attrib.get(f"{{{LIDO_NS}}}{name}")


def extract_priref(rec) -> int | None:
    pub = rec.find(".//lido:objectPublishedID", NS)
    if pub is not None and pub.text:
        m = PRIREF_RE.search(pub.text)
        if m:
            return int(m.group(1))
    rid = rec.find(".//lido:lidoRecID", NS)
    if rid is not None and rid.text:
        m = RECID_PRIREF_RE.search(rid.text)
        if m:
            return int(m.group(1))
    return None


def parse_iconclass_notation(uri: str | None) -> str | None:
    if not uri:
        return None
    for pat in ICONCLASS_URL_RES:
        m = pat.match(uri.strip())
        if m:
            return m.group(1)
    return None


def extract_subjects(rec) -> list[dict]:
    """Return a list of subject-row dicts for one <lido:lido> record.

    Walks every subjectConcept inside every subjectSet/subject. One row per
    (subjectConcept, term) pair so multiple language labels become multiple
    rows that share the same concept_id/notation.
    """
    rows: list[dict] = []
    sub_idx = 0
    for sset in rec.findall(".//lido:subjectSet/lido:subject", NS):
        for sc in sset.findall(".//lido:subjectConcept", NS):
            sub_idx += 1
            cid_el = sc.find("./lido:conceptID", NS)
            concept_id = text_of(cid_el)
            concept_type = attr(cid_el, "type") or attr(cid_el, "source")
            notation = parse_iconclass_notation(concept_id)
            terms = sc.findall("./lido:term", NS)
            if not terms:
                rows.append({
                    "subject_index": sub_idx,
                    "concept_id": concept_id,
                    "concept_id_type": concept_type,
                    "notation": notation,
                    "term_text": None,
                    "term_lang": None,
                })
                continue
            for term in terms:
                rows.append({
                    "subject_index": sub_idx,
                    "concept_id": concept_id,
                    "concept_id_type": concept_type,
                    "notation": notation,
                    "term_text": text_of(term),
                    "term_lang": lang_of(term),
                })
    return rows


SUBJECT_COLS = [
    "priref", "subject_index", "concept_id", "concept_id_type",
    "notation", "term_text", "term_lang",
]


def stream_records(path: Path):
    parser = ET.XMLPullParser(["start", "end"])
    with open(path, "rb") as fh:
        chunk = fh.read(2048)
        parser.feed(chunk)
        while True:
            for event, elem in parser.read_events():
                if event == "end" and local(elem.tag) == "lido":
                    yield elem
                    elem.clear()
            chunk = fh.read(256 * 1024)
            if not chunk:
                break
            parser.feed(chunk)
        for event, elem in parser.read_events():
            if event == "end" and local(elem.tag) == "lido":
                yield elem
                elem.clear()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dump", type=Path, default=DEFAULT_DUMP)
    ap.add_argument("--db", type=Path, default=DEFAULT_DB)
    ap.add_argument("--limit", type=int, default=None,
                    help="Stop after N records (probe mode)")
    ap.add_argument("--reset", action="store_true",
                    help="Drop & recreate lido_subjects before extraction")
    args = ap.parse_args()

    if not args.dump.exists():
        print(f"ERROR: dump not found: {args.dump}", file=sys.stderr)
        return 1
    if not args.db.exists():
        print(f"ERROR: snapshot DB not found: {args.db}", file=sys.stderr)
        return 1

    conn = sqlite3.connect(args.db)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    if args.reset:
        conn.execute("DROP TABLE IF EXISTS lido_subjects")
    conn.executescript(SCHEMA_DDL)
    conn.commit()

    placeholders = ", ".join(["?"] * len(SUBJECT_COLS))
    INSERT_SQL = f"INSERT INTO lido_subjects ({', '.join(SUBJECT_COLS)}) VALUES ({placeholders})"

    BATCH = 5000
    pending: list[tuple] = []
    total_records = 0
    total_subjects = 0
    records_with_subjects = 0
    records_with_iconclass = 0
    t0 = time.time()

    for rec in stream_records(args.dump):
        priref = extract_priref(rec)
        if priref is None:
            continue
        total_records += 1
        rows = extract_subjects(rec)
        if rows:
            records_with_subjects += 1
            if any(r["notation"] for r in rows):
                records_with_iconclass += 1
            for r in rows:
                pending.append(tuple(r.get(k) if k != "priref" else priref
                                     for k in SUBJECT_COLS))
            total_subjects += len(rows)

        if total_records % 10000 == 0:
            elapsed = time.time() - t0
            print(f"  {total_records:>7,} records  "
                  f"{total_subjects:>9,} subjects  "
                  f"{elapsed:>6.0f}s", flush=True)

        if len(pending) >= BATCH:
            conn.executemany(INSERT_SQL, pending)
            pending.clear()

        if args.limit is not None and total_records >= args.limit:
            break

    if pending:
        conn.executemany(INSERT_SQL, pending)
    conn.commit()

    elapsed = time.time() - t0
    print(f"\n=== complete ===")
    print(f"  records scanned:           {total_records:,}")
    print(f"  records w/ subjects:       {records_with_subjects:,}")
    print(f"  records w/ iconclass code: {records_with_iconclass:,}")
    print(f"  total subject rows:        {total_subjects:,}")
    print(f"  wall time:                 {elapsed:.1f}s")

    distinct = conn.execute(
        "SELECT COUNT(DISTINCT notation) FROM lido_subjects WHERE notation IS NOT NULL"
    ).fetchone()[0]
    print(f"  distinct iconclass notations: {distinct:,}")

    sample = conn.execute(
        "SELECT priref, concept_id, notation, term_text, term_lang "
        "FROM lido_subjects WHERE notation IS NOT NULL LIMIT 5"
    ).fetchall()
    print(f"\n  sample iconclass rows:")
    for r in sample:
        print(f"    priref={r[0]}  notation={r[2]}  term={r[3]!r}@{r[4]}  uri={r[1]}")

    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
