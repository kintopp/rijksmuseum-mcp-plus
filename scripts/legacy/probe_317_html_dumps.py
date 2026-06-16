#!/usr/bin/env python3
"""Probe rm-dump-* directories for HTML-error pages saved as .nt files.

Issue #317: the dump fetcher silently saved 404 HTML responses without
checking content-type. Two known cases (rm-dump-concept/120512, 120363).
This probe quantifies how widespread the problem is across all 8 dumps.

Detection signals:
  HTML        — file starts with <!doctype, <html, or <?xml html
  EMPTY       — zero bytes
  TINY        — non-empty but < 64 bytes (suspicious; may be truncated)
  NON_NT      — non-empty, doesn't start with <http or _: (not N-Triples)
  OK          — looks like N-Triples (starts with <http or _:)
"""

import os
import sys
from collections import defaultdict
from pathlib import Path

DUMP_ROOT = Path("/tmp")
# Include the two probe dirs we extracted from event.tar.gz / topical_term.tar.gz
GLOBS = ["rm-dump-*"]

NT_PREFIXES = (b"<http", b"_:")


def classify(path: Path) -> tuple[str, int, bytes]:
    size = path.stat().st_size
    if size == 0:
        return "EMPTY", 0, b""
    with open(path, "rb") as f:
        head_raw = f.read(64)
    head = head_raw.lstrip()
    if head.lower().startswith((b"<!doctype", b"<html")):
        return "HTML", size, head[:32]
    if head.startswith(NT_PREFIXES):
        return "OK", size, head[:32]
    if size < 64:
        return "TINY", size, head[:32]
    return "NON_NT", size, head[:32]


def main():
    dumps = []
    for g in GLOBS:
        dumps.extend(sorted(p for p in DUMP_ROOT.glob(g) if p.is_dir()))

    grand_totals: dict[str, int] = defaultdict(int)
    html_files: list[tuple[str, str, int]] = []
    nonNT_files: list[tuple[str, str, int, bytes]] = []
    tiny_files: list[tuple[str, str, int, bytes]] = []
    empty_files: list[tuple[str, str]] = []

    print(f"{'dump':<35} {'total':>8} {'OK':>8} {'HTML':>6} {'EMPTY':>6} {'TINY':>6} {'NON_NT':>7}")
    print("-" * 83)

    for dump in dumps:
        counts: dict[str, int] = defaultdict(int)
        for entry in dump.iterdir():
            if not entry.is_file():
                continue
            cat, size, head = classify(entry)
            counts[cat] += 1
            grand_totals[cat] += 1
            grand_totals["_total"] += 1
            if cat == "HTML":
                html_files.append((dump.name, entry.name, size))
            elif cat == "NON_NT":
                nonNT_files.append((dump.name, entry.name, size, head))
            elif cat == "TINY":
                tiny_files.append((dump.name, entry.name, size, head))
            elif cat == "EMPTY":
                empty_files.append((dump.name, entry.name))
        total = sum(counts.values())
        print(
            f"{dump.name:<35} {total:>8} {counts['OK']:>8} {counts['HTML']:>6} "
            f"{counts['EMPTY']:>6} {counts['TINY']:>6} {counts['NON_NT']:>7}"
        )

    print("-" * 83)
    print(
        f"{'TOTAL':<35} {grand_totals['_total']:>8} {grand_totals['OK']:>8} "
        f"{grand_totals['HTML']:>6} {grand_totals['EMPTY']:>6} {grand_totals['TINY']:>6} "
        f"{grand_totals['NON_NT']:>7}"
    )

    if html_files:
        print(f"\n=== HTML-error files ({len(html_files)}) ===")
        for dump, fname, size in html_files:
            print(f"  {dump}/{fname}  ({size} bytes)")

    if nonNT_files:
        print(f"\n=== NON_NT files ({len(nonNT_files)} — first 20) ===")
        for dump, fname, size, head in nonNT_files[:20]:
            head_repr = head.decode("utf-8", errors="replace").replace("\n", "\\n")
            print(f"  {dump}/{fname}  ({size}b)  prefix={head_repr!r}")
        if len(nonNT_files) > 20:
            print(f"  ... and {len(nonNT_files) - 20} more")

    if tiny_files:
        print(f"\n=== TINY files <64b ({len(tiny_files)} — first 20) ===")
        for dump, fname, size, head in tiny_files[:20]:
            head_repr = head.decode("utf-8", errors="replace").replace("\n", "\\n")
            print(f"  {dump}/{fname}  ({size}b)  content={head_repr!r}")
        if len(tiny_files) > 20:
            print(f"  ... and {len(tiny_files) - 20} more")

    if empty_files:
        print(f"\n=== EMPTY files ({len(empty_files)} — first 10) ===")
        for dump, fname in empty_files[:10]:
            print(f"  {dump}/{fname}")
        if len(empty_files) > 10:
            print(f"  ... and {len(empty_files) - 10} more")


if __name__ == "__main__":
    main()
