"""One-shot extractor over the 2020-01 Rijksmuseum LIDO XML dump.

Streams the 12 GB single-file XML, pulls per-record event/actor/inscription/
classification metadata, and writes a sidecar SQLite at
data/lido-events-snapshot.db.

Schema is joinable to the project vocabulary DB via the numeric `priref`
extracted from the `objectPublishedID` URL (e.g. `RM0001.COLLECT.704235`
→ priref=704235), which matches `artworks.priref` in the v0.26 vocab DB.

Purpose: provide a frozen 2020-vintage reference frame for cross-validating
the PEG-grammar provenance parser, the `acquisition_method` / `acquisition_date`
fields, and the audit-trail tier work (#268).

Run:
  ~/miniconda3/envs/embeddings/bin/python scripts/extract-lido-events.py

Wall time: ~10-15 minutes for 667,894 records.
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
DEFAULT_OUT = PROJECT_ROOT / "data" / "lido-events-snapshot.db"

PRIREF_RE = re.compile(r"RM0001\.[Cc][Oo][Ll][Ll][Ee][Cc][Tt]\.(\d+)\b")
RECID_PRIREF_RE = re.compile(r"/lido/(\d+)\b")

SCHEMA_DDL = """
CREATE TABLE IF NOT EXISTS lido_meta (
    key TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS lido_records (
    priref INTEGER PRIMARY KEY,
    lido_rec_id TEXT NOT NULL,
    object_published_id TEXT,
    work_id TEXT,
    work_type_term_en TEXT,
    work_type_term_nl TEXT,
    work_type_concept_id TEXT,
    repository_place_uri TEXT,
    repository_place_name TEXT,
    credit_line TEXT,
    credit_line_lang TEXT,
    object_description TEXT,
    object_description_lang TEXT,
    title_en TEXT,
    title_nl TEXT,
    title_count INTEGER NOT NULL DEFAULT 0,
    event_count INTEGER NOT NULL DEFAULT 0,
    inscription_count INTEGER NOT NULL DEFAULT 0,
    classification_count INTEGER NOT NULL DEFAULT 0,
    subject_count INTEGER NOT NULL DEFAULT 0,
    related_work_count INTEGER NOT NULL DEFAULT 0,
    measurement_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS lido_events (
    id INTEGER PRIMARY KEY,
    priref INTEGER NOT NULL,
    event_index INTEGER NOT NULL,
    event_type_en TEXT,
    event_type_nl TEXT,
    event_concept_id TEXT,
    event_concept_source TEXT,
    earliest_date TEXT,
    latest_date TEXT,
    display_date TEXT,
    event_method_term_en TEXT,
    event_method_term_nl TEXT,
    event_method_concept_id TEXT,
    period_term_en TEXT,
    period_term_nl TEXT,
    period_concept_id TEXT,
    event_place_uri TEXT,
    event_place_name TEXT,
    materials_text TEXT,
    description_text TEXT,
    description_lang TEXT,
    actor_count INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (priref) REFERENCES lido_records(priref)
);
CREATE INDEX IF NOT EXISTS idx_lido_events_priref ON lido_events(priref);
CREATE INDEX IF NOT EXISTS idx_lido_events_type_en ON lido_events(event_type_en);

CREATE TABLE IF NOT EXISTS lido_event_actors (
    id INTEGER PRIMARY KEY,
    event_id INTEGER NOT NULL,
    priref INTEGER NOT NULL,
    actor_name_en TEXT,
    actor_name_nl TEXT,
    actor_type TEXT,
    role_term_en TEXT,
    role_term_nl TEXT,
    role_concept_id TEXT,
    actor_id_value TEXT,
    actor_id_source TEXT,
    attribution_qualifier TEXT,
    FOREIGN KEY (event_id) REFERENCES lido_events(id),
    FOREIGN KEY (priref) REFERENCES lido_records(priref)
);
CREATE INDEX IF NOT EXISTS idx_lido_event_actors_event ON lido_event_actors(event_id);
CREATE INDEX IF NOT EXISTS idx_lido_event_actors_priref ON lido_event_actors(priref);

CREATE TABLE IF NOT EXISTS lido_inscriptions (
    id INTEGER PRIMARY KEY,
    priref INTEGER NOT NULL,
    inscription_type TEXT,
    transcription TEXT,
    description_text TEXT,
    description_lang TEXT,
    FOREIGN KEY (priref) REFERENCES lido_records(priref)
);
CREATE INDEX IF NOT EXISTS idx_lido_inscriptions_priref ON lido_inscriptions(priref);

CREATE TABLE IF NOT EXISTS lido_classifications (
    id INTEGER PRIMARY KEY,
    priref INTEGER NOT NULL,
    classification_type_uri TEXT,
    term_text TEXT,
    term_lang TEXT,
    FOREIGN KEY (priref) REFERENCES lido_records(priref)
);
CREATE INDEX IF NOT EXISTS idx_lido_classifications_priref ON lido_classifications(priref);

CREATE TABLE IF NOT EXISTS lido_related_works (
    id INTEGER PRIMARY KEY,
    priref INTEGER NOT NULL,
    related_object_id TEXT,
    related_object_id_type TEXT,
    relation_type_term TEXT,
    FOREIGN KEY (priref) REFERENCES lido_records(priref)
);
CREATE INDEX IF NOT EXISTS idx_lido_related_works_priref ON lido_related_works(priref);
"""


def local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def text_of(elem: ET.Element | None) -> str | None:
    if elem is None or not elem.text:
        return None
    t = elem.text.strip()
    return t or None


def lang_of(elem: ET.Element | None) -> str | None:
    if elem is None:
        return None
    return elem.attrib.get(f"{{{XML_NS}}}lang")


def attr(elem: ET.Element | None, name: str) -> str | None:
    if elem is None:
        return None
    return elem.attrib.get(f"{{{LIDO_NS}}}{name}")


def find_lang_term(parent: ET.Element, xpath: str) -> tuple[str | None, str | None]:
    """Return (en, nl) terms from a parent given an xpath that yields lido:term."""
    en, nl = None, None
    for term in parent.findall(xpath, NS):
        lang = lang_of(term)
        text = text_of(term)
        if not text:
            continue
        if lang == "en" and not en:
            en = text
        elif lang == "nl" and not nl:
            nl = text
        elif not en and not lang:
            en = text
    return en, nl


def find_lang_appellation(parent: ET.Element, xpath: str) -> tuple[str | None, str | None, int]:
    """Return (en, nl, total_count) for appellationValue children at xpath."""
    en, nl = None, None
    total = 0
    for app in parent.findall(xpath, NS):
        total += 1
        lang = lang_of(app)
        text = text_of(app)
        if not text:
            continue
        if lang == "en" and not en:
            en = text
        elif lang == "nl" and not nl:
            nl = text
    return en, nl, total


def extract_priref(rec: ET.Element) -> int | None:
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


def extract_record(rec: ET.Element) -> dict:
    """Return a dict of lists/scalars representing all rows for this record."""
    priref = extract_priref(rec)
    if priref is None:
        return {}

    rec_id_text = text_of(rec.find(".//lido:lidoRecID", NS))
    pub_id_text = text_of(rec.find(".//lido:objectPublishedID", NS))

    work_type_el = rec.find(".//lido:objectWorkType", NS)
    work_type_en, work_type_nl = (None, None)
    work_type_concept_id = None
    if work_type_el is not None:
        work_type_en, work_type_nl = find_lang_term(work_type_el, "./lido:term")
        cid = work_type_el.find("./lido:conceptID", NS)
        work_type_concept_id = text_of(cid)

    work_id_el = rec.find(".//lido:repositoryWrap//lido:workID", NS)
    work_id = text_of(work_id_el)

    repo_place_el = rec.find(".//lido:repositoryWrap//lido:repositoryLocation", NS)
    repo_place_uri = None
    repo_place_name = None
    if repo_place_el is not None:
        pid = repo_place_el.find(".//lido:placeID", NS)
        repo_place_uri = text_of(pid)
        name = repo_place_el.find(".//lido:appellationValue", NS)
        repo_place_name = text_of(name)

    credit_el = rec.find(".//lido:rightsWorkSet/lido:creditLine", NS)
    credit_line = text_of(credit_el)
    credit_line_lang = lang_of(credit_el)

    obj_desc_el = rec.find(".//lido:objectDescriptionWrap//lido:descriptiveNoteValue", NS)
    object_description = text_of(obj_desc_el)
    object_description_lang = lang_of(obj_desc_el)

    title_en, title_nl, title_count = find_lang_appellation(
        rec, ".//lido:titleWrap/lido:titleSet/lido:appellationValue"
    )

    inscriptions_rows = []
    for ins in rec.findall(".//lido:inscriptions", NS):
        ins_type = attr(ins, "type")
        trans = text_of(ins.find("./lido:inscriptionTranscription", NS))
        desc_el = ins.find("./lido:inscriptionDescription/lido:descriptiveNoteValue", NS)
        inscriptions_rows.append({
            "inscription_type": ins_type,
            "transcription": trans,
            "description_text": text_of(desc_el),
            "description_lang": lang_of(desc_el),
        })

    classification_rows = []
    for cls in rec.findall(".//lido:classificationWrap/lido:classification", NS):
        ctype = attr(cls, "type")
        for term in cls.findall("./lido:term", NS):
            classification_rows.append({
                "classification_type_uri": ctype,
                "term_text": text_of(term),
                "term_lang": lang_of(term),
            })

    related_rows = []
    for rel in rec.findall(".//lido:relatedWorkSet", NS):
        relation_term = text_of(rel.find("./lido:relatedWorkRelType/lido:term", NS))
        for obj in rel.findall("./lido:relatedWork/lido:object", NS):
            obj_id_el = obj.find("./lido:objectID", NS)
            related_rows.append({
                "related_object_id": text_of(obj_id_el),
                "related_object_id_type": attr(obj_id_el, "type"),
                "relation_type_term": relation_term,
            })
        # Some files inline the objectID directly without the nested object wrapper.
        if not rel.findall("./lido:relatedWork/lido:object", NS):
            for obj_id_el in rel.findall(".//lido:objectID", NS):
                related_rows.append({
                    "related_object_id": text_of(obj_id_el),
                    "related_object_id_type": attr(obj_id_el, "type"),
                    "relation_type_term": relation_term,
                })

    subject_count = sum(1 for _ in rec.findall(".//lido:subjectSet", NS))
    measurement_count = sum(1 for _ in rec.findall(".//lido:measurementsSet", NS))

    events_rows = []
    actors_rows = []
    for idx, ev in enumerate(rec.findall(".//lido:eventSet/lido:event", NS)):
        et_en, et_nl = find_lang_term(ev, "./lido:eventType/lido:term")
        ec_id_el = ev.find("./lido:eventType/lido:conceptID", NS)
        event_concept_id = text_of(ec_id_el)
        event_concept_source = attr(ec_id_el, "source")

        date_el = ev.find("./lido:eventDate/lido:date", NS)
        earliest = text_of(date_el.find("./lido:earliestDate", NS)) if date_el is not None else None
        latest = text_of(date_el.find("./lido:latestDate", NS)) if date_el is not None else None
        display_date = text_of(ev.find("./lido:eventDate/lido:displayDate", NS))

        em_en, em_nl = find_lang_term(ev, "./lido:eventMethod/lido:term")
        em_id_el = ev.find("./lido:eventMethod/lido:conceptID", NS)
        em_concept_id = text_of(em_id_el)

        period_en, period_nl = find_lang_term(ev, "./lido:periodName/lido:term")
        period_id_el = ev.find("./lido:periodName/lido:conceptID", NS)
        period_concept_id = text_of(period_id_el)

        place_el = ev.find("./lido:eventPlace/lido:place", NS)
        place_uri = None
        place_name = None
        if place_el is not None:
            pid = place_el.find("./lido:placeID", NS)
            place_uri = text_of(pid)
            name_en, name_nl, _ = find_lang_appellation(
                place_el, "./lido:namePlaceSet/lido:appellationValue"
            )
            place_name = name_en or name_nl

        materials = []
        for mat_term in ev.findall(
            "./lido:eventMaterialsTech/lido:materialsTech/lido:termMaterialsTech/lido:term", NS
        ):
            t = text_of(mat_term)
            if t:
                materials.append(t)
        materials_text = " | ".join(dict.fromkeys(materials)) if materials else None

        desc_el = ev.find("./lido:eventDescriptionSet/lido:descriptiveNoteValue", NS)
        ev_desc = text_of(desc_el)
        ev_desc_lang = lang_of(desc_el)

        local_actors = []
        for ar in ev.findall("./lido:eventActor/lido:actorInRole", NS):
            actor_el = ar.find("./lido:actor", NS)
            actor_type = attr(actor_el, "type") if actor_el is not None else None
            an_en, an_nl = (None, None)
            if actor_el is not None:
                an_en, an_nl, _ = find_lang_appellation(
                    actor_el, "./lido:nameActorSet/lido:appellationValue"
                )
            actor_id_el = actor_el.find("./lido:actorID", NS) if actor_el is not None else None
            actor_id_value = text_of(actor_id_el)
            actor_id_source = attr(actor_id_el, "source")
            role_term_en, role_term_nl = find_lang_term(ar, "./lido:roleActor/lido:term")
            role_id_el = ar.find("./lido:roleActor/lido:conceptID", NS)
            role_concept_id = text_of(role_id_el)
            qual = text_of(ar.find("./lido:attributionQualifierActor", NS))
            local_actors.append({
                "actor_name_en": an_en,
                "actor_name_nl": an_nl,
                "actor_type": actor_type,
                "role_term_en": role_term_en,
                "role_term_nl": role_term_nl,
                "role_concept_id": role_concept_id,
                "actor_id_value": actor_id_value,
                "actor_id_source": actor_id_source,
                "attribution_qualifier": qual,
            })

        events_rows.append({
            "event_index": idx,
            "event_type_en": et_en,
            "event_type_nl": et_nl,
            "event_concept_id": event_concept_id,
            "event_concept_source": event_concept_source,
            "earliest_date": earliest,
            "latest_date": latest,
            "display_date": display_date,
            "event_method_term_en": em_en,
            "event_method_term_nl": em_nl,
            "event_method_concept_id": em_concept_id,
            "period_term_en": period_en,
            "period_term_nl": period_nl,
            "period_concept_id": period_concept_id,
            "event_place_uri": place_uri,
            "event_place_name": place_name,
            "materials_text": materials_text,
            "description_text": ev_desc,
            "description_lang": ev_desc_lang,
            "_actors": local_actors,
        })

    return {
        "record": {
            "priref": priref,
            "lido_rec_id": rec_id_text or "",
            "object_published_id": pub_id_text,
            "work_id": work_id,
            "work_type_term_en": work_type_en,
            "work_type_term_nl": work_type_nl,
            "work_type_concept_id": work_type_concept_id,
            "repository_place_uri": repo_place_uri,
            "repository_place_name": repo_place_name,
            "credit_line": credit_line,
            "credit_line_lang": credit_line_lang,
            "object_description": object_description,
            "object_description_lang": object_description_lang,
            "title_en": title_en,
            "title_nl": title_nl,
            "title_count": title_count,
            "event_count": len(events_rows),
            "inscription_count": len(inscriptions_rows),
            "classification_count": len(classification_rows),
            "subject_count": subject_count,
            "related_work_count": len(related_rows),
            "measurement_count": measurement_count,
        },
        "events": events_rows,
        "inscriptions": inscriptions_rows,
        "classifications": classification_rows,
        "related_works": related_rows,
    }


RECORD_COLS = [
    "priref", "lido_rec_id", "object_published_id", "work_id",
    "work_type_term_en", "work_type_term_nl", "work_type_concept_id",
    "repository_place_uri", "repository_place_name",
    "credit_line", "credit_line_lang",
    "object_description", "object_description_lang",
    "title_en", "title_nl", "title_count",
    "event_count", "inscription_count", "classification_count",
    "subject_count", "related_work_count", "measurement_count",
]
EVENT_COLS = [
    "priref", "event_index",
    "event_type_en", "event_type_nl", "event_concept_id", "event_concept_source",
    "earliest_date", "latest_date", "display_date",
    "event_method_term_en", "event_method_term_nl", "event_method_concept_id",
    "period_term_en", "period_term_nl", "period_concept_id",
    "event_place_uri", "event_place_name",
    "materials_text", "description_text", "description_lang", "actor_count",
]
ACTOR_COLS = [
    "event_id", "priref",
    "actor_name_en", "actor_name_nl", "actor_type",
    "role_term_en", "role_term_nl", "role_concept_id",
    "actor_id_value", "actor_id_source", "attribution_qualifier",
]
INSCRIPTION_COLS = [
    "priref", "inscription_type", "transcription",
    "description_text", "description_lang",
]
CLASSIFICATION_COLS = [
    "priref", "classification_type_uri", "term_text", "term_lang",
]
RELATED_WORK_COLS = [
    "priref", "related_object_id", "related_object_id_type", "relation_type_term",
]


def stream_records(path: Path):
    """Yield each <lido:lido> Element from the dump."""
    parser = ET.XMLPullParser(["start", "end"])
    with open(path, "rb") as fh:
        # First peek to read the root open tag in the natural way.
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
        # Final flush.
        for event, elem in parser.read_events():
            if event == "end" and local(elem.tag) == "lido":
                yield elem
                elem.clear()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dump", type=Path, default=DEFAULT_DUMP)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--limit", type=int, default=None,
                        help="For dry runs: stop after N records")
    parser.add_argument("--commit-every", type=int, default=2000)
    args = parser.parse_args()

    if not args.dump.exists():
        sys.exit(f"Dump not found: {args.dump}")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    if args.out.exists():
        print(f"Removing existing {args.out}", file=sys.stderr)
        args.out.unlink()

    conn = sqlite3.connect(args.out)
    conn.executescript("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;")
    conn.executescript(SCHEMA_DDL)

    rec_sql = (
        "INSERT INTO lido_records (" + ",".join(RECORD_COLS) + ") VALUES ("
        + ",".join("?" for _ in RECORD_COLS) + ")"
    )
    ev_sql = (
        "INSERT INTO lido_events (" + ",".join(EVENT_COLS) + ") VALUES ("
        + ",".join("?" for _ in EVENT_COLS) + ")"
    )
    actor_sql = (
        "INSERT INTO lido_event_actors (" + ",".join(ACTOR_COLS) + ") VALUES ("
        + ",".join("?" for _ in ACTOR_COLS) + ")"
    )
    ins_sql = (
        "INSERT INTO lido_inscriptions (" + ",".join(INSCRIPTION_COLS) + ") VALUES ("
        + ",".join("?" for _ in INSCRIPTION_COLS) + ")"
    )
    cls_sql = (
        "INSERT INTO lido_classifications (" + ",".join(CLASSIFICATION_COLS) + ") VALUES ("
        + ",".join("?" for _ in CLASSIFICATION_COLS) + ")"
    )
    rel_sql = (
        "INSERT INTO lido_related_works (" + ",".join(RELATED_WORK_COLS) + ") VALUES ("
        + ",".join("?" for _ in RELATED_WORK_COLS) + ")"
    )

    t0 = time.time()
    seen = 0
    skipped_no_priref = 0
    skipped_dupe = 0
    seen_prirefs: set[int] = set()

    conn.execute("BEGIN")
    try:
        for rec in stream_records(args.dump):
            extracted = extract_record(rec)
            if not extracted:
                skipped_no_priref += 1
                continue

            r = extracted["record"]
            priref = r["priref"]
            if priref in seen_prirefs:
                skipped_dupe += 1
                continue
            seen_prirefs.add(priref)

            conn.execute(rec_sql, [r[c] for c in RECORD_COLS])

            for ev in extracted["events"]:
                actors = ev.pop("_actors")
                ev_with_meta = {**ev, "priref": priref, "actor_count": len(actors)}
                cur = conn.execute(ev_sql, [ev_with_meta[c] for c in EVENT_COLS])
                event_id = cur.lastrowid
                for a in actors:
                    a_full = {**a, "event_id": event_id, "priref": priref}
                    conn.execute(actor_sql, [a_full[c] for c in ACTOR_COLS])

            for ins in extracted["inscriptions"]:
                ins_full = {**ins, "priref": priref}
                conn.execute(ins_sql, [ins_full[c] for c in INSCRIPTION_COLS])

            for cls in extracted["classifications"]:
                cls_full = {**cls, "priref": priref}
                conn.execute(cls_sql, [cls_full[c] for c in CLASSIFICATION_COLS])

            for rel in extracted["related_works"]:
                rel_full = {**rel, "priref": priref}
                conn.execute(rel_sql, [rel_full[c] for c in RELATED_WORK_COLS])

            seen += 1
            if seen % args.commit_every == 0:
                conn.execute("COMMIT")
                conn.execute("BEGIN")
            if seen % 10000 == 0:
                rate = seen / max(time.time() - t0, 1e-6)
                print(
                    f"  [extract] {seen:>7,} records "
                    f"({time.time() - t0:6.1f}s, {rate:6.0f} rec/s)",
                    file=sys.stderr,
                )
            if args.limit is not None and seen >= args.limit:
                break

        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise

    elapsed = time.time() - t0

    conn.execute("BEGIN")
    meta_pairs = [
        ("source_path", str(args.dump)),
        ("source_size_bytes", str(args.dump.stat().st_size)),
        ("schema_namespace", LIDO_NS),
        ("snapshot_vintage", "2020-01"),
        ("records_extracted", str(seen)),
        ("records_skipped_no_priref", str(skipped_no_priref)),
        ("records_skipped_duplicate_priref", str(skipped_dupe)),
        ("extractor_script", "scripts/extract-lido-events.py"),
        ("extracted_at_utc", time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())),
        ("elapsed_seconds", f"{elapsed:.1f}"),
    ]
    for k, v in meta_pairs:
        conn.execute("INSERT OR REPLACE INTO lido_meta (key, value) VALUES (?, ?)", (k, v))
    conn.execute("COMMIT")

    print(file=sys.stderr)
    print(f"Extracted {seen:,} records in {elapsed:.1f}s "
          f"({seen / max(elapsed, 1e-6):.0f} rec/s)", file=sys.stderr)
    if skipped_no_priref:
        print(f"  skipped (no priref): {skipped_no_priref:,}", file=sys.stderr)
    if skipped_dupe:
        print(f"  skipped (duplicate priref): {skipped_dupe:,}", file=sys.stderr)
    print(f"Wrote {args.out} ({args.out.stat().st_size / (1024**2):.1f} MB)", file=sys.stderr)

    conn.close()


if __name__ == "__main__":
    main()
