#!/usr/bin/env python3
"""Rebuild the full docs/vocabulary-professions.md table from the live DB.

Unlike refresh-vocab-doc-counts.py (which only rewrites count cells of the
already-listed rows), this regenerates the entire table layout: every distinct
profession term (accented display labels straight from the DB, so diacritics
are correct), current counts, sorted by casefold(diacritic-folded) label, laid
out column-major across 3 columns. Use when the term set changes (e.g. a newly
added profession that the in-place refresh can't introduce).

Usage:
  python3 scripts/rebuild-professions-table.py            # preview + checks
  python3 scripts/rebuild-professions-table.py --write     # apply
"""
import sqlite3, re, sys, os, unicodedata, math

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(ROOT, "data", "vocabulary.db")
DOC = os.path.join(ROOT, "docs", "vocabulary-professions.md")
FIELD = 9
NCOLS = 3
WRITE = "--write" in sys.argv
SEP_RE = re.compile(r"^\|[\s:|-]+\|\s*$")


def fold(s):
    return "".join(c for c in unicodedata.normalize("NFKD", s)
                   if not unicodedata.combining(c))


def sortkey(s):
    return fold(s).casefold()


def fmt(v):
    if v >= 10000:
        return "~" + format(int(round(v / 1000.0)) * 1000, ",")
    return format(v, ",")


def main():
    conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    terms = conn.execute(
        """SELECT COALESCE(v.label_en, v.label_nl) AS disp, COUNT(*) c
             FROM mappings m JOIN vocabulary v ON v.rowid = m.vocab_rowid
            WHERE m.field_id = ? GROUP BY m.vocab_rowid""",
        (FIELD,),
    ).fetchall()
    terms.sort(key=lambda t: sortkey(t[0]))
    n = len(terms)

    lines = open(DOC, encoding="utf-8").read().splitlines()
    sep = next(i for i, l in enumerate(lines) if SEP_RE.match(l))
    header_idx = sep - 1
    old_data = [i for i in range(sep + 1, len(lines)) if lines[i].startswith("|")]

    # column-major layout
    nrows = math.ceil(n / NCOLS)
    new_rows = []
    for r in range(nrows):
        cells = []
        for c in range(NCOLS):
            i = c * nrows + r
            if i < n:
                cells += [terms[i][0], fmt(terms[i][1])]
            else:
                cells += ["", ""]
        new_rows.append("| " + " | ".join(cells) + " |")

    # sanity report
    diacritic_fixes = sum(1 for t in terms if t[0] != fold(t[0]))
    print(f"DB distinct profession terms: {n}")
    print(f"layout: {nrows} rows x {NCOLS} cols  (old: {len(old_data)} rows)")
    print(f"terms carrying diacritics (now spelled correctly): {diacritic_fixes}")
    tax = [t for t in terms if t[0] == "taxateur"]
    print(f"taxateur present: {tax}")
    # show the rows around the taxateur insertion + the two trailing (short) rows
    tpos = next(i for i, t in enumerate(terms) if t[0] == "taxateur")
    print("\ncontext (sorted index / label / count):")
    for i in range(tpos - 1, tpos + 2):
        print(f"  {i}: {terms[i][0]} = {fmt(terms[i][1])}")
    print("\nlast 3 generated rows:")
    for row in new_rows[-3:]:
        print("  " + row)

    if WRITE:
        new_lines = lines[:sep + 1] + new_rows + lines[max(old_data) + 1:]
        with open(DOC, "w", encoding="utf-8") as f:
            f.write("\n".join(new_lines) + "\n")
        print("\nWROTE rebuilt table.")
    else:
        print("\n(dry-run — pass --write to apply)")


if __name__ == "__main__":
    main()
