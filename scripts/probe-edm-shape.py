#!/usr/bin/env python3
"""
EDM shape baseline capture (OAI-PMH).

The Rijksmuseum announced (notice dated 2026-06-11 on
https://data.rijksmuseum.nl/docs/oai-pmh/) that a new OAI-PMH release will make
the EDM representations valid against Europeana's XML Schema + Schematron rules,
flagged as potentially breaking for EDM consumers. This project consumes EDM in
two places — `OaiPmhClient.parseEdmRecord` (live, get_recent_changes) and the
OAI-PMH harvest path (authoritative for subjects) — both of which navigate a
specific EDM tree shape and resolve by-reference entities. A tolerant parser
turns a structural change into SILENT empty/partial records, not a crash.

This script captures the CURRENT EDM wire shape so the new release can be diffed
against it. It is read-only (no DB writes, no API writes). Sibling to
`probe-harvest.py`, but that probe monitors the Linked Art (JSON) serialization;
this one covers the EDM (XML) serialization the notice affects.

Outputs (default offline/explorations/edm-baseline-<date>/):
  identify.xml              — raw Identify (records deletedRecord + version)
  listrecords-page1.xml     — raw first ListRecords page (broad distribution)
  records/<objectNumber>.xml — raw GetRecord per curated, stable identifier
  shape-inventory.json      — element/attr/namespace census + entity-ref pattern
  README.md                 — what/why/how-to-diff summary

Usage:
    python3 scripts/probe-edm-shape.py
    python3 scripts/probe-edm-shape.py --out /tmp/edm-baseline --famous 8
"""

import argparse
import datetime
import io
import json
import sqlite3
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from collections import Counter
from pathlib import Path

PROJECT_DIR = Path(__file__).parent.parent
DB_PATH = PROJECT_DIR / "data" / "vocabulary.db"
OAI_BASE = "https://data.rijksmuseum.nl/oai"
LOD_PREFIX = "https://id.rijksmuseum.nl/"
USER_AGENT = "rijksmuseum-mcp-edm-probe/1.0"
TYPE_FIELD_ID = 15  # field_lookup: type

# Type labels to span structural profiles (creator/place/iconclass/material mixes).
# Missing labels are skipped — the famous-by-importance set carries the baseline.
TYPE_LABELS = ["painting", "print", "drawing", "photograph", "sculpture",
               "furniture", "vase", "medal"]


def http_get(params):
    url = f"{OAI_BASE}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT,
                                               "Accept": "text/xml"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read()


def select_sample(famous_n):
    """Pick a reproducible, profile-diverse set of (object_number, art_id)."""
    con = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    try:
        seen = set()
        sample = []  # (object_number, art_id, reason)

        for obj, art_id in con.execute(
            "SELECT object_number, art_id FROM artworks "
            "WHERE art_id IS NOT NULL ORDER BY importance DESC LIMIT ?",
            (famous_n,),
        ):
            if art_id not in seen:
                seen.add(art_id)
                sample.append((obj, art_id, "importance"))

        for label in TYPE_LABELS:
            row = con.execute(
                "SELECT a.object_number, a.art_id FROM artworks a "
                "WHERE a.art_id IN ("
                "  SELECT m.artwork_id FROM mappings m "
                "  WHERE m.field_id = ? AND m.vocab_rowid IN ("
                "    SELECT vocab_int_id FROM vocabulary WHERE label_en = ?"
                "  )) LIMIT 1",
                (TYPE_FIELD_ID, label),
            ).fetchone()
            if row and row[1] not in seen:
                seen.add(row[1])
                sample.append((row[0], row[1], f"type:{label}"))
        return sample
    finally:
        con.close()


# ─── Shape inventory ────────────────────────────────────────────────

# rdf:RDF top-level children that parseEdmRecord resolves references against.
ENTITY_TAGS = {
    "{http://www.w3.org/1999/02/22-rdf-syntax-ns#}Description",
    "{http://www.w3.org/2002/07/owl#}Class",
    "{http://www.w3.org/2004/02/skos/core#}Concept",
    "{http://www.europeana.eu/schemas/edm/}Place",
    "{http://www.europeana.eu/schemas/edm/}Agent",
    "{http://www.openarchives.org/ore/terms/}Aggregation",
    "{http://www.europeana.eu/schemas/edm/}ProvidedCHO",
}
RDF_RESOURCE = "{http://www.w3.org/1999/02/22-rdf-syntax-ns#}resource"


def census_record(xml_bytes, inv):
    """Accumulate element/attr/namespace census + entity-ref pattern from one record."""
    # Namespace prefix → URI (start-ns events expose declarations ET otherwise hides).
    for _ev, (prefix, uri) in ET.iterparse(io.BytesIO(xml_bytes),
                                            events=["start-ns"]):
        inv["namespaces"][f"{prefix or '(default)'}={uri}"] += 1

    root = ET.fromstring(xml_bytes)
    for el in root.iter():
        inv["elements"][el.tag] += 1
        for attr in el.attrib:
            inv["attributes"][attr] += 1
        if RDF_RESOURCE in el.attrib:
            inv["rdf_resource_refs"][el.tag] += 1

    # Entity blocks under each rdf:RDF (the entity-map sources).
    for rdf in root.iter("{http://www.w3.org/1999/02/22-rdf-syntax-ns#}RDF"):
        for child in list(rdf):
            if child.tag in ENTITY_TAGS:
                inv["rdf_children"][child.tag] += 1


def main():
    ap = argparse.ArgumentParser()
    today = datetime.date.today().isoformat()
    ap.add_argument("--out", default=str(
        PROJECT_DIR / "offline" / "explorations" / f"edm-baseline-{today}"))
    ap.add_argument("--famous", type=int, default=6)
    args = ap.parse_args()

    out = Path(args.out)
    (out / "records").mkdir(parents=True, exist_ok=True)
    print(f"Output → {out}")

    print("Identify…")
    identify = http_get({"verb": "Identify"})
    (out / "identify.xml").write_bytes(identify)
    time.sleep(0.3)

    print("ListRecords (page 1)…")
    page = http_get({"verb": "ListRecords", "metadataPrefix": "edm"})
    (out / "listrecords-page1.xml").write_bytes(page)
    time.sleep(0.3)

    sample = select_sample(args.famous)
    print(f"GetRecord × {len(sample)} curated identifiers…")

    inv = {k: Counter() for k in
           ["namespaces", "elements", "attributes", "rdf_resource_refs", "rdf_children"]}
    captured = []
    for obj, art_id, reason in sample:
        ident = f"{LOD_PREFIX}{art_id}"
        try:
            xml = http_get({"verb": "GetRecord", "metadataPrefix": "edm",
                            "identifier": ident})
        except Exception as e:  # noqa: BLE001 — probe should not abort on one bad record
            print(f"  ✗ {obj} ({ident}): {e}")
            continue
        safe = obj.replace("/", "_")
        (out / "records" / f"{safe}.xml").write_bytes(xml)
        census_record(xml, inv)
        captured.append({"object_number": obj, "art_id": art_id,
                         "identifier": ident, "reason": reason})
        print(f"  ✓ {obj}  ({reason})")
        time.sleep(0.3)

    # Also census the ListRecords page for broader coverage.
    census_record(page, inv)

    inventory = {
        "captured_at": today,
        "oai_base": OAI_BASE,
        "records_captured": captured,
        "namespaces": dict(inv["namespaces"]),
        "rdf_children": dict(inv["rdf_children"]),
        "rdf_resource_refs": dict(inv["rdf_resource_refs"]),
        "elements": dict(sorted(inv["elements"].items(),
                                key=lambda kv: -kv[1])),
        "attributes": dict(sorted(inv["attributes"].items(),
                                  key=lambda kv: -kv[1])),
    }
    (out / "shape-inventory.json").write_text(json.dumps(inventory, indent=2))

    readme = f"""# EDM shape baseline — {today}

Captured by `scripts/probe-edm-shape.py` ahead of the announced OAI-PMH EDM
release (notice dated 2026-06-11 on https://data.rijksmuseum.nl/docs/oai-pmh/,
making EDM valid against Europeana XML Schema + Schematron — flagged as possibly
breaking for EDM consumers).

## Why
`src/api/OaiPmhClient.ts:parseEdmRecord` (live, powers `get_recent_changes`) and
the OAI-PMH harvest path both navigate a specific EDM tree
(`ore:Aggregation → edm:aggregatedCHO → edm:ProvidedCHO`) and resolve
by-reference entities (`rdf:Description`/`skos:Concept`/`edm:Place`/`edm:Agent`)
via an `@rdf:about` entity map. A structural change yields silent empty/partial
records, not an error. This snapshot is the before-image to diff against.

## Contents
- `identify.xml` — deletedRecord support + repo version
- `listrecords-page1.xml` — first ListRecords page (broad distribution)
- `records/*.xml` — raw GetRecord per stable identifier ({len(captured)} records)
- `shape-inventory.json` — element/attr/namespace census + entity-reference pattern

## How to diff after the release
1. Re-run `python3 scripts/probe-edm-shape.py --out <new-dir>`.
2. `diff <(jq -S . {out.name}/shape-inventory.json) <(jq -S . <new-dir>/shape-inventory.json)`
   — watch `rdf_children` (inline-vs-reference shift), `namespaces` (prefix/URI
   churn), and any disappeared `elements` keys parseEdmRecord reads.
3. Per-record: `diff records/<obj>.xml <new-dir>/records/<obj>.xml` (same
   identifiers → clean structural diff).
"""
    (out / "README.md").write_text(readme)

    print(f"\nCaptured {len(captured)} records + Identify + ListRecords page.")
    print(f"Inventory: {len(inventory['elements'])} distinct element tags, "
          f"{len(inventory['namespaces'])} namespace decls.")
    print(f"See {out / 'README.md'}")


if __name__ == "__main__":
    main()
