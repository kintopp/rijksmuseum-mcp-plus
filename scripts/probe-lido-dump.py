"""Exploratory probe of the Rijksmuseum 2020-01 LIDO XML dump.

Reads the 12 GB single-file XML in streaming mode (xml.etree.iterparse) so it
never holds more than one record in memory. Three passes:

  1. Full census of the first N records (default 2000) — every tag path,
     attribute, classification/role/event URI is tallied.
  2. Tail sample: same census on N records starting from a byte offset
     (default 50%) to check that the head sample is representative.
  3. Total record count via grep on `<lido:lido>` opens.

Outputs a markdown report + JSON dump to data/audit/.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

LIDO_NS = "http://www.lido-schema.org"
NS = {"lido": LIDO_NS}

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DUMP = Path("/Users/abosse/Downloads/rijksmuseum-data-dumps/202001-rma-lido-collection.xml")
AUDIT_DIR = PROJECT_ROOT / "data" / "audit"


def local(tag: str) -> str:
    """Strip the {namespace} prefix from an etree tag name."""
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def walk_paths(elem: ET.Element, prefix: str = "") -> list[tuple[str, str | None]]:
    """Yield (path, text-snippet) for every descendant of elem.

    Path uses '/'-joined local tags. Text is stripped + truncated for sampling.
    """
    out: list[tuple[str, str | None]] = []
    here = f"{prefix}/{local(elem.tag)}" if prefix else local(elem.tag)
    text = (elem.text or "").strip()
    out.append((here, text or None))
    for child in elem:
        out.extend(walk_paths(child, here))
    return out


def collect_attrs(elem: ET.Element, prefix: str = "") -> list[tuple[str, str, str]]:
    """Yield (path, attr-localname, value) over the subtree."""
    out: list[tuple[str, str, str]] = []
    here = f"{prefix}/{local(elem.tag)}" if prefix else local(elem.tag)
    for k, v in elem.attrib.items():
        out.append((here, local(k), v))
    for child in elem:
        out.extend(collect_attrs(child, here))
    return out


class CensusAccumulator:
    """Aggregates per-record findings across a sample window."""

    def __init__(self) -> None:
        self.records = 0
        self.path_counts: Counter[str] = Counter()
        self.path_with_text: Counter[str] = Counter()
        self.attr_counts: Counter[tuple[str, str]] = Counter()
        # (path, attr_name, value-host) — value-host is just the URI scheme+host
        # (or "literal") so we can see the namespace mix without exploding.
        self.attr_value_hosts: Counter[tuple[str, str, str]] = Counter()
        self.event_types: Counter[str] = Counter()
        self.classification_uris: Counter[str] = Counter()
        self.role_uris: Counter[str] = Counter()
        self.subject_uris: Counter[str] = Counter()
        self.place_uris: Counter[str] = Counter()
        self.actor_id_sources: Counter[str] = Counter()
        self.languages: Counter[str] = Counter()
        self.has_inscriptions = 0
        self.has_measurements = 0
        self.has_subjects = 0
        self.has_events = 0
        self.has_resourceset = 0
        self.has_relatedwork = 0
        self.has_repository_place = 0
        self.measurement_types: Counter[str] = Counter()
        self.inscription_types: Counter[str] = Counter()
        self.material_terms: Counter[str] = Counter()
        self.record_id_samples: list[str] = []
        self.priref_samples: list[str] = []
        self.title_lang_combos: Counter[tuple[str, ...]] = Counter()
        self.descriptive_note_lengths: list[int] = []
        self.unique_record_ids: set[str] = set()

    def absorb(self, rec: ET.Element) -> None:
        self.records += 1

        # Collect paths + attrs across the whole record.
        for path, text in walk_paths(rec):
            self.path_counts[path] += 1
            if text:
                self.path_with_text[path] += 1

        for path, attr, value in collect_attrs(rec):
            self.attr_counts[(path, attr)] += 1
            host = uri_host(value)
            self.attr_value_hosts[(path, attr, host)] += 1

        # Headline IDs.
        rec_id_el = rec.find(".//lido:lidoRecID", NS)
        if rec_id_el is not None and rec_id_el.text:
            rid = rec_id_el.text.strip()
            self.unique_record_ids.add(rid)
            if len(self.record_id_samples) < 5:
                self.record_id_samples.append(rid)

        pub_id_el = rec.find(".//lido:objectPublishedID", NS)
        if pub_id_el is not None and pub_id_el.text and len(self.priref_samples) < 5:
            self.priref_samples.append(pub_id_el.text.strip())

        # Languages used on this record.
        for el in rec.iter():
            lang = el.attrib.get("{http://www.w3.org/XML/1998/namespace}lang")
            if lang:
                self.languages[lang] += 1

        # Event types.
        events = rec.findall(".//lido:event", NS)
        if events:
            self.has_events += 1
        for ev in events:
            for term in ev.findall("./lido:eventType/lido:term", NS):
                if term.text:
                    self.event_types[term.text.strip()] += 1

        # Classification URIs (the @lido:type on classification IS the AAT URI).
        for cls in rec.findall(".//lido:classification", NS):
            ctype = cls.attrib.get(f"{{{LIDO_NS}}}type")
            if ctype:
                self.classification_uris[ctype] += 1

        # Subject URIs (Iconclass etc.) live on conceptID.
        subjects = rec.findall(".//lido:subjectSet", NS)
        if subjects:
            self.has_subjects += 1
        for cid in rec.findall(".//lido:subject//lido:conceptID", NS):
            ctype = cid.attrib.get(f"{{{LIDO_NS}}}type")
            if ctype:
                self.subject_uris[ctype] += 1

        # Actor roles.
        for role in rec.findall(".//lido:roleActor//lido:term", NS):
            if role.text:
                self.role_uris[role.text.strip()] += 1
        # Actor ID sources (so we can see what authority files are referenced).
        for actor_id in rec.findall(".//lido:actor/lido:actorID", NS):
            src = actor_id.attrib.get(f"{{{LIDO_NS}}}source", "(unsourced)")
            self.actor_id_sources[src] += 1

        # Place URIs (eventPlace + repository).
        for pid in rec.findall(".//lido:placeID", NS):
            ptype = pid.attrib.get(f"{{{LIDO_NS}}}type")
            if ptype:
                self.place_uris[ptype] += 1

        # Inscriptions.
        ins = rec.findall(".//lido:inscriptions", NS)
        if ins:
            self.has_inscriptions += 1
        for i in ins:
            t = i.attrib.get(f"{{{LIDO_NS}}}type", "(notype)")
            self.inscription_types[t] += 1

        # Measurements.
        meas = rec.findall(".//lido:measurementsSet", NS)
        if meas:
            self.has_measurements += 1
        for m in meas:
            mt = m.find("./lido:measurementType", NS)
            if mt is not None and mt.text:
                self.measurement_types[mt.text.strip()] += 1

        # Materials.
        for mat in rec.findall(".//lido:materialsTech//lido:term", NS):
            if mat.text:
                self.material_terms[mat.text.strip()] += 1

        # Resource set (images / IIIF / linkResource).
        if rec.find(".//lido:resourceSet", NS) is not None:
            self.has_resourceset += 1

        # Related works (relevant to lineage / pendants).
        if rec.find(".//lido:relatedWork", NS) is not None:
            self.has_relatedwork += 1

        # Repository place (provenance hint).
        if rec.find(".//lido:repositoryLocation/lido:placeID", NS) is not None:
            self.has_repository_place += 1

        # Title sets per record — what languages?
        langs_in_title = []
        for title in rec.findall(".//lido:titleSet/lido:appellationValue", NS):
            lang = title.attrib.get("{http://www.w3.org/XML/1998/namespace}lang", "")
            langs_in_title.append(lang)
        if langs_in_title:
            self.title_lang_combos[tuple(sorted(langs_in_title))] += 1

        # Descriptive note lengths (raw text size).
        for note in rec.findall(".//lido:descriptiveNoteValue", NS):
            if note.text:
                self.descriptive_note_lengths.append(len(note.text.strip()))


URI_HOST_RE = re.compile(r"^(?P<scheme>https?|ftp)://(?P<host>[^/]+)")


def uri_host(value: str) -> str:
    """Reduce a value to its scheme+host (or 'literal' / 'urn'/etc.) for tally."""
    if not value:
        return "(empty)"
    m = URI_HOST_RE.match(value)
    if m:
        return f"{m.group('scheme')}://{m.group('host')}"
    if value.startswith("urn:"):
        return value.split(":", 2)[0] + ":" + value.split(":", 2)[1]
    if "/" not in value and len(value) < 80:
        return "literal"
    return "other"


def stream_records(path: Path, *, start_at_byte: int = 0, limit: int | None = None):
    """Yield each <lido:lido> Element in document order, releasing memory after."""
    with open(path, "rb") as fh:
        if start_at_byte:
            fh.seek(start_at_byte)
            # Skip until we land on the next <lido:lido open tag — etree won't
            # tolerate mid-element entry. Read forward; report bytes skipped.
            buf = b""
            while True:
                chunk = fh.read(64 * 1024)
                if not chunk:
                    return
                buf += chunk
                idx = buf.find(b"<lido:lido>")
                if idx >= 0:
                    fh.seek(start_at_byte + idx)
                    break
                # Keep tail in case the marker straddles boundary.
                buf = buf[-32:]

        # iterparse needs a top-level wrapper, but starting mid-stream we don't
        # have one. Wrap a synthetic root by feeding ET.XMLPullParser manually.
        parser = ET.XMLPullParser(["start", "end"])
        parser.feed(b'<root xmlns:lido="http://www.lido-schema.org" '
                    b'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">')
        depth = 0
        records_yielded = 0
        try:
            while True:
                chunk = fh.read(256 * 1024)
                if not chunk:
                    parser.feed(b"</root>")
                    for _ in parser.read_events():
                        pass
                    return
                parser.feed(chunk)
                for event, elem in parser.read_events():
                    if event == "start" and local(elem.tag) == "lido":
                        depth += 1
                    elif event == "end" and local(elem.tag) == "lido":
                        depth -= 1
                        yield elem
                        elem.clear()
                        records_yielded += 1
                        if limit is not None and records_yielded >= limit:
                            return
        finally:
            pass


def census(path: Path, label: str, *, start_at_byte: int, limit: int) -> CensusAccumulator:
    print(f"\n[{label}] start_at_byte={start_at_byte:,} limit={limit:,}", file=sys.stderr)
    acc = CensusAccumulator()
    t0 = time.time()
    for rec in stream_records(path, start_at_byte=start_at_byte, limit=limit):
        acc.absorb(rec)
        if acc.records % 500 == 0:
            print(f"  [{label}] {acc.records:,} records ({time.time() - t0:.1f}s)", file=sys.stderr)
    print(f"[{label}] done: {acc.records:,} records in {time.time() - t0:.1f}s", file=sys.stderr)
    return acc


def total_record_count(path: Path) -> tuple[int, float]:
    """Use grep -c to count <lido:lido> opens. Fast sequential scan."""
    print("\n[total] grep-counting <lido:lido> opens (~12 GB scan)...", file=sys.stderr)
    t0 = time.time()
    out = subprocess.check_output(["grep", "-c", "<lido:lido>", str(path)], text=True)
    elapsed = time.time() - t0
    return int(out.strip()), elapsed


def topn(counter: Counter, n: int = 25) -> list[tuple[Any, int]]:
    return counter.most_common(n)


def render_markdown(
    head: CensusAccumulator,
    tail: CensusAccumulator | None,
    total_count: int | None,
    path: Path,
    file_size: int,
) -> str:
    lines: list[str] = []
    lines.append("# LIDO XML Dump Probe — 2020-01 Rijksmuseum Snapshot")
    lines.append("")
    lines.append(f"**Source:** `{path}`  ")
    lines.append(f"**Size:** {file_size / (1024**3):.1f} GB  ")
    lines.append(f"**Schema:** LIDO v1.0 (`http://www.lido-schema.org`)  ")
    if total_count is not None:
        lines.append(f"**Total `<lido:lido>` records (full file scan):** {total_count:,}  ")
    lines.append(f"**Head sample:** {head.records:,} records  ")
    if tail:
        lines.append(f"**Tail sample:** {tail.records:,} records  ")
    lines.append("")

    # Per-record presence rates (head sample).
    lines.append("## Per-record presence (head sample)")
    lines.append("")
    lines.append("| Feature | Records w/ feature | % |")
    lines.append("|---|---:|---:|")
    n = max(head.records, 1)
    for label, value in [
        ("eventSet", head.has_events),
        ("subjectSet", head.has_subjects),
        ("inscriptions", head.has_inscriptions),
        ("measurementsSet", head.has_measurements),
        ("resourceSet", head.has_resourceset),
        ("relatedWork", head.has_relatedwork),
        ("repository placeID", head.has_repository_place),
    ]:
        lines.append(f"| {label} | {value:,} | {100 * value / n:.1f}% |")
    lines.append("")

    # Languages.
    lines.append("## Languages on `xml:lang` (head sample, element-occurrences)")
    lines.append("")
    lines.append("| Lang | Count |")
    lines.append("|---|---:|")
    for lang, c in topn(head.languages, 10):
        lines.append(f"| `{lang}` | {c:,} |")
    lines.append("")

    # Event types.
    lines.append("## Event types (head sample)")
    lines.append("")
    lines.append("| Type | Count |")
    lines.append("|---|---:|")
    for et, c in topn(head.event_types, 30):
        lines.append(f"| {et} | {c:,} |")
    lines.append("")

    # Classification URIs.
    lines.append("## Classification @lido:type URIs (head sample)")
    lines.append("")
    lines.append("| URI | Count |")
    lines.append("|---|---:|")
    for u, c in topn(head.classification_uris, 20):
        lines.append(f"| `{u}` | {c:,} |")
    lines.append("")

    # Subject conceptID URIs.
    lines.append("## Subject conceptID @lido:type URIs (head sample)")
    lines.append("")
    lines.append("| URI | Count |")
    lines.append("|---|---:|")
    for u, c in topn(head.subject_uris, 20):
        lines.append(f"| `{u}` | {c:,} |")
    lines.append("")

    # Place URIs.
    lines.append("## Place @lido:type URIs (head sample)")
    lines.append("")
    lines.append("| URI | Count |")
    lines.append("|---|---:|")
    for u, c in topn(head.place_uris, 20):
        lines.append(f"| `{u}` | {c:,} |")
    lines.append("")

    # Actor ID sources.
    lines.append("## Actor `actorID/@lido:source` (head sample)")
    lines.append("")
    lines.append("| Source | Count |")
    lines.append("|---|---:|")
    for s, c in topn(head.actor_id_sources, 20):
        lines.append(f"| `{s}` | {c:,} |")
    lines.append("")

    # Inscription types.
    lines.append("## Inscription `@lido:type` (head sample)")
    lines.append("")
    lines.append("| Type | Count |")
    lines.append("|---|---:|")
    for t, c in topn(head.inscription_types, 15):
        lines.append(f"| `{t}` | {c:,} |")
    lines.append("")

    # Measurement types.
    lines.append("## Measurement types (head sample)")
    lines.append("")
    lines.append("| Type | Count |")
    lines.append("|---|---:|")
    for t, c in topn(head.measurement_types, 20):
        lines.append(f"| {t} | {c:,} |")
    lines.append("")

    # Top tag paths.
    lines.append("## Top tag paths by occurrence (head sample)")
    lines.append("")
    lines.append("| Path | Records |")
    lines.append("|---|---:|")
    for p, c in topn(head.path_counts, 40):
        lines.append(f"| `{p}` | {c:,} |")
    lines.append("")

    # Tail comparison: just deltas in event types.
    if tail is not None:
        lines.append("## Head vs tail consistency (event types)")
        lines.append("")
        lines.append("| Event type | Head/Nh | Tail/Nt |")
        lines.append("|---|---:|---:|")
        nh, nt = max(head.records, 1), max(tail.records, 1)
        all_types = sorted(set(head.event_types) | set(tail.event_types))
        for et in all_types[:20]:
            lines.append(
                f"| {et} | {head.event_types.get(et, 0)}/{nh} "
                f"({100 * head.event_types.get(et, 0) / nh:.1f}%) | "
                f"{tail.event_types.get(et, 0)}/{nt} "
                f"({100 * tail.event_types.get(et, 0) / nt:.1f}%) |"
            )
        lines.append("")

    # Sample IDs.
    lines.append("## Sample record IDs")
    lines.append("")
    for rid in head.record_id_samples:
        lines.append(f"- `{rid}`")
    lines.append("")
    for pid in head.priref_samples:
        lines.append(f"- `{pid}`")
    lines.append("")

    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dump", type=Path, default=DEFAULT_DUMP)
    parser.add_argument("--head-limit", type=int, default=2000)
    parser.add_argument("--tail-limit", type=int, default=2000)
    parser.add_argument("--no-tail", action="store_true", help="Skip tail sample")
    parser.add_argument("--no-total", action="store_true", help="Skip the full grep-count")
    parser.add_argument("--out-stem", type=str, default="lido-dump-probe")
    args = parser.parse_args()

    if not args.dump.exists():
        sys.exit(f"Dump not found: {args.dump}")

    file_size = args.dump.stat().st_size
    print(f"Probing {args.dump} ({file_size / (1024**3):.2f} GB)", file=sys.stderr)

    head = census(args.dump, "head", start_at_byte=0, limit=args.head_limit)

    tail: CensusAccumulator | None = None
    if not args.no_tail:
        tail = census(
            args.dump,
            "tail",
            start_at_byte=file_size // 2,
            limit=args.tail_limit,
        )

    total_count: int | None = None
    total_elapsed: float | None = None
    if not args.no_total:
        total_count, total_elapsed = total_record_count(args.dump)
        print(f"[total] {total_count:,} records (grep took {total_elapsed:.1f}s)", file=sys.stderr)

    AUDIT_DIR.mkdir(parents=True, exist_ok=True)
    md_path = AUDIT_DIR / f"{args.out_stem}.md"
    json_path = AUDIT_DIR / f"{args.out_stem}.json"

    md_path.write_text(render_markdown(head, tail, total_count, args.dump, file_size))

    summary = {
        "dump": str(args.dump),
        "file_size_bytes": file_size,
        "schema_namespace": LIDO_NS,
        "total_records_grep": total_count,
        "total_grep_elapsed_seconds": total_elapsed,
        "head_sample_size": head.records,
        "tail_sample_size": tail.records if tail else 0,
        "head": {
            "presence": {
                "events": head.has_events,
                "subjects": head.has_subjects,
                "inscriptions": head.has_inscriptions,
                "measurements": head.has_measurements,
                "resource_set": head.has_resourceset,
                "related_work": head.has_relatedwork,
                "repository_place": head.has_repository_place,
            },
            "languages": dict(head.languages),
            "event_types": dict(head.event_types),
            "classification_uris": dict(head.classification_uris),
            "subject_uris": dict(head.subject_uris),
            "place_uris": dict(head.place_uris),
            "actor_id_sources": dict(head.actor_id_sources),
            "inscription_types": dict(head.inscription_types),
            "measurement_types": dict(head.measurement_types),
            "title_lang_combos": {",".join(k): v for k, v in head.title_lang_combos.items()},
            "top_paths": dict(head.path_counts.most_common(60)),
            "top_attrs": {f"{p}@{a}": c for (p, a), c in head.attr_counts.most_common(40)},
            "record_id_samples": head.record_id_samples,
            "priref_samples": head.priref_samples,
        },
    }
    if tail:
        summary["tail"] = {
            "presence": {
                "events": tail.has_events,
                "subjects": tail.has_subjects,
                "inscriptions": tail.has_inscriptions,
                "measurements": tail.has_measurements,
                "resource_set": tail.has_resourceset,
                "related_work": tail.has_relatedwork,
            },
            "event_types": dict(tail.event_types),
            "classification_uris": dict(tail.classification_uris),
            "subject_uris": dict(tail.subject_uris),
            "record_id_samples": tail.record_id_samples,
        }

    json_path.write_text(json.dumps(summary, indent=2, ensure_ascii=False))
    print(f"\nWrote {md_path}", file=sys.stderr)
    print(f"Wrote {json_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
