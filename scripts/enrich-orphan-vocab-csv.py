"""Enrich data/audit/orphan-vocab-ids-v0.24.csv with Phase 2 failure status
and dump-side label lookup (channels A + B from the v0.26 orphan triage).

Usage:
    python3 scripts/enrich-orphan-vocab-csv.py \
        --db data/vocabulary.db \
        --csv data/audit/orphan-vocab-ids-v0.24.csv \
        --dumps-extract /tmp/orphan-dumps \
        --out data/audit/orphan-vocab-ids-v0.24-enriched.csv

The script extracts the relevant dump tarballs once into --dumps-extract
(skipped if already populated). Each dump file's name is the entity's
Rijksmuseum vocab ID, so the lookup is O(1) per orphan: stat the file in
the candidate dump dirs, then parse N-triples for label_en / label_nl / type.

Output columns:
    vocab_id, field, count, phase2_status, dump_dir, dump_type,
    label_en, label_nl

`phase2_status` is the `phase2_failures.reason` string when the orphan was
recorded by Phase 2b's resolver (http_404 / http_410 / unsupported_type:*).
Empty when the orphan is NOT in phase2_failures (i.e. came in via a path
the Phase 2b sweep didn't cover — usually a Phase 4.5 about[] or Phase 4
deep-link).
"""
from __future__ import annotations

import argparse
import csv
import re
import sqlite3
import subprocess
from pathlib import Path

DUMPS_DIR = Path.home() / "Downloads" / "rijksmuseum-data-dumps"

# Field → candidate dump categories, ordered by specificity. First hit wins.
FIELD_DUMPS = {
    "subject":          ["concept", "topical_term", "classification"],
    "theme":            ["concept", "topical_term", "classification"],
    "creator":          ["person", "organisation"],
    "technique":        ["concept", "classification"],
    "spatial":          ["place"],
    "production_place": ["place"],
    "production_role":  ["concept", "classification"],
}

# AAT codes the dump uses to tag language for P190_has_symbolic_content.
AAT_ENGLISH = "300388277"
AAT_DUTCH = "300388256"

# Regex for N-triples lines we care about. The dumps use full URIs so we
# anchor on `data.rijksmuseum.nl/{id}` which matches the file's primary
# entity. `id.rijksmuseum.nl/{id}` is the title-bnode subject form.
RE_TYPE = re.compile(
    r"data\.rijksmuseum\.nl/\d+>\s+<[^>]*rdf-syntax-ns#type>\s+<([^>]+)>"
)
RE_HAS_TYPE = re.compile(
    r"data\.rijksmuseum\.nl/\d+>\s+<[^>]*P2_has_type>\s+<([^>]+)>"
)
RE_LABEL_LINE = re.compile(
    r'^(<[^>]+>|_:\S+)\s+<[^>]*P190_has_symbolic_content>\s+"((?:[^"\\]|\\.)*)"',
    re.MULTILINE,
)
RE_LANG_LINE = re.compile(
    r"^(<[^>]+>|_:\S+)\s+<[^>]*P72_has_language>\s+<[^>]*aat/(\d+)>",
    re.MULTILINE,
)


def maybe_extract(dumps_root: Path, category: str) -> Path:
    """Extract dumps/category.tar.gz to dumps_root/category if not already there.
    Returns the path to the extracted directory."""
    target = dumps_root / category
    if target.exists() and any(target.iterdir()):
        return target
    target.mkdir(parents=True, exist_ok=True)
    tarball = DUMPS_DIR / f"{category}.tar.gz"
    if not tarball.exists():
        return target  # no-op; lookups will miss
    print(f"  Extracting {tarball.name} → {target} …", flush=True)
    subprocess.run(["tar", "xzf", str(tarball), "-C", str(target)], check=True)
    return target


def parse_dump_file(path: Path) -> tuple[str | None, str | None, str | None]:
    """Return (rdf_type_short, label_en, label_nl) parsed from N-triples."""
    text = path.read_text(errors="replace")

    # rdf:type — pick the first non-Linguistic_Object/Appellation type.
    rdf_type = None
    for m in RE_TYPE.finditer(text):
        t = m.group(1)
        if "E33" in t or "E41" in t or "E55" in t:
            continue
        rdf_type = t.rsplit("/", 1)[-1]
        break
    # has_type fallback (Getty AAT typing)
    if rdf_type is None:
        m = RE_HAS_TYPE.search(text)
        if m:
            rdf_type = "aat:" + m.group(1).rsplit("/", 1)[-1]

    # Map bnode → language by collecting both label lines and lang lines,
    # then joining on bnode id. We accept literal bnodes (`_:Nfoo`) and full
    # IRI subjects identically.
    bnode_lang: dict[str, str] = {}
    for m in RE_LANG_LINE.finditer(text):
        bnode_lang[m.group(1)] = m.group(2)

    label_en = None
    label_nl = None
    for m in RE_LABEL_LINE.finditer(text):
        bnode, raw = m.group(1), m.group(2)
        # unescape minimal n-triples escapes
        s = raw.encode("utf-8").decode("unicode_escape", errors="replace")
        lang = bnode_lang.get(bnode)
        if lang == AAT_ENGLISH and label_en is None:
            label_en = s
        elif lang == AAT_DUTCH and label_nl is None:
            label_nl = s
        elif lang is None and label_en is None:
            label_en = s  # fallback for entries with no language tag
    return rdf_type, label_en, label_nl


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="data/vocabulary.db")
    ap.add_argument("--csv", default="data/audit/orphan-vocab-ids-v0.24.csv")
    ap.add_argument("--dumps-extract", default="/tmp/orphan-dumps")
    ap.add_argument("--out", default="data/audit/orphan-vocab-ids-v0.24-enriched.csv")
    args = ap.parse_args()

    dumps_root = Path(args.dumps_extract)
    dumps_root.mkdir(parents=True, exist_ok=True)

    needed = set()
    with open(args.csv) as f:
        reader = csv.DictReader(f)
        rows = list(reader)
    for row in rows:
        for cat in FIELD_DUMPS.get(row["field"], []):
            needed.add(cat)

    print(f"Extracting {len(needed)} dump categories: {sorted(needed)}")
    extracted = {cat: maybe_extract(dumps_root, cat) for cat in needed}

    conn = sqlite3.connect(args.db)
    p2_status = dict(conn.execute(
        "SELECT uri, reason FROM phase2_failures"
    ).fetchall())
    conn.close()

    out_rows = []
    hit_dump = miss_dump = 0
    p2_hits = 0
    for row in rows:
        vid = row["vocab_id"]
        field = row["field"]
        cnt = row["count"]
        status = p2_status.get(vid, "")
        if status:
            p2_hits += 1
        dump_dir = ""
        dump_type = ""
        label_en = ""
        label_nl = ""
        for cat in FIELD_DUMPS.get(field, []):
            cand = extracted[cat] / vid
            if cand.exists():
                dump_dir = cat
                dump_type, le, ln = parse_dump_file(cand)
                dump_type = dump_type or ""
                label_en = le or ""
                label_nl = ln or ""
                hit_dump += 1
                break
        else:
            miss_dump += 1
        out_rows.append({
            "vocab_id": vid,
            "field": field,
            "count": cnt,
            "phase2_status": status,
            "dump_dir": dump_dir,
            "dump_type": dump_type,
            "label_en": label_en,
            "label_nl": label_nl,
        })

    with open(args.out, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=[
            "vocab_id", "field", "count",
            "phase2_status", "dump_dir", "dump_type",
            "label_en", "label_nl",
        ])
        writer.writeheader()
        writer.writerows(out_rows)

    print()
    print(f"Wrote {args.out}")
    print(f"  {len(out_rows)} orphans")
    print(f"  {p2_hits} cross-referenced with phase2_failures")
    print(f"  {hit_dump} found in dumps (label resolved)")
    print(f"  {miss_dump} missing from dumps")


if __name__ == "__main__":
    main()
