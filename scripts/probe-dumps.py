#!/usr/bin/env python3
"""Quick probe of Schema.org / Linked Art dump archives.

For each .tar.gz under ~/Downloads/rijksmuseum-data-dumps/, extract a few sample
member files (no full untar), inspect the N-Triples/JSON-LD content, enumerate
predicates with counts, and dump samples. Used by the v0.26 dump audit.

Usage:
    python3 scripts/probe-dumps.py                 # probe all unused dumps
    python3 scripts/probe-dumps.py work item       # probe specific names
    python3 scripts/probe-dumps.py --max 20        # sample more per dump
"""

import argparse
import re
import sys
import tarfile
from collections import Counter
from pathlib import Path

DUMPS_DIR = Path.home() / "Downloads" / "rijksmuseum-data-dumps"

UNUSED = ["image", "work", "instance", "item", "set"]
ALL = [
    "classification", "concept", "event", "exhibition", "image",
    "instance", "item", "organisation", "person", "place", "set",
    "topical_term", "work",
]

NT_RE = re.compile(r"^(?:<[^>]+>|\S+)\s+<([^>]+)>\s+(.+?)\s*\.\s*$")


def probe_archive(name: str, max_members: int) -> None:
    archive = DUMPS_DIR / f"{name}.tar.gz"
    if not archive.exists():
        print(f"  ! {archive} not found")
        return
    print(f"\n=== {name}.tar.gz ({archive.stat().st_size / 1024**2:.1f} MB) ===")

    predicates = Counter()
    types = Counter()
    sample_records = []
    member_count = 0

    with tarfile.open(archive, "r:gz") as tar:
        for ti in tar:
            if not ti.isfile():
                continue
            member_count += 1
            if member_count > max_members:
                # Continue counting but stop sampling
                if member_count > max_members * 4:
                    break
                continue

            try:
                f = tar.extractfile(ti)
                if f is None:
                    continue
                text = f.read().decode("utf-8", errors="replace")
            except Exception as e:
                print(f"   ! cannot read {ti.name}: {e}")
                continue

            # Sample first 3 records' content
            if len(sample_records) < 3:
                sample_records.append((ti.name, text[:1500]))

            # Parse N-Triples to enumerate predicates
            for line in text.splitlines():
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                m = NT_RE.match(line)
                if not m:
                    continue
                pred = m.group(1)
                predicates[pred] += 1
                obj = m.group(2).strip()
                if pred.endswith("#type"):
                    if obj.startswith("<") and obj.endswith(">"):
                        types[obj[1:-1]] += 1

    print(f"  member files: {member_count} (sampled first {min(max_members, member_count)})")
    if types:
        print(f"  rdf:type values seen ({len(types)} distinct):")
        for t, c in types.most_common(8):
            print(f"    {c:6d}  {t}")
    print(f"  predicates ({len(predicates)} distinct):")
    for p, c in predicates.most_common(20):
        print(f"    {c:6d}  {p}")
    print(f"  sample records:")
    for name_, text_ in sample_records:
        print(f"\n  --- {name_} ---")
        for ln in text_.splitlines()[:25]:
            print(f"    {ln[:160]}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("dumps", nargs="*", help="Dump names to probe; default: unused only")
    parser.add_argument("--max", type=int, default=50, help="Max member files to sample per archive")
    parser.add_argument("--all", action="store_true", help="Probe all 13 dumps")
    args = parser.parse_args()

    targets = args.dumps if args.dumps else (ALL if args.all else UNUSED)
    for name in targets:
        probe_archive(name, args.max)


if __name__ == "__main__":
    main()
