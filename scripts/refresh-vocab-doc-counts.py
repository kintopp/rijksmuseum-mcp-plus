#!/usr/bin/env python3
"""Refresh the per-term count columns in the docs/vocabulary-*.md tables from the
live vocabulary DB. Re-runnable after any harvest.

Display label == COALESCE(label_en, label_nl) (verified against the DB schema).
Per-label dedup style is auto-detected from the table itself:
  - k doc-rows for a label, m vocab-terms with that label
  - k == 1, m >= 1  -> the single row is the SUM of all m terms (materials/techniques style)
  - k == m          -> one row per term; rank-match doc rows to terms by count (production-roles style)
  - otherwise       -> flagged, left untouched

Rounding convention (matches existing docs): value >= 10,000 -> "~" + nearest 1,000
with thousands separators; otherwise the exact value with thousands separators.

Usage:
  python3 scripts/refresh-vocab-doc-counts.py           # dry-run report
  python3 scripts/refresh-vocab-doc-counts.py --write    # apply edits in place
"""
import sqlite3, re, sys, os, unicodedata

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(ROOT, "data", "vocabulary.db")
WRITE = "--write" in sys.argv

DOCS = [
    ("docs/vocabulary-materials.md", 6),
    ("docs/vocabulary-techniques.md", 13),
    ("docs/vocabulary-production-roles.md", 8),
    ("docs/vocabulary-professions.md", 9),
]

SEP_RE = re.compile(r"^\|[\s:|-]+\|\s*$")


def fmt(v):
    if v >= 10000:
        return "~" + format(int(round(v / 1000.0)) * 1000, ",")
    return format(v, ",")


def parse_count(s):
    s = s.strip().lstrip("~").replace(",", "")
    return int(s) if s.isdigit() else None


def fold(s):
    """Strip diacritics (keep case) so 'Financien' matches DB 'Financiën'."""
    return "".join(c for c in unicodedata.normalize("NFKD", s)
                   if not unicodedata.combining(c))


def field_map(conn, fid):
    """disp -> sorted (desc) list of per-term counts."""
    rows = conn.execute(
        """SELECT COALESCE(v.label_en, v.label_nl) AS disp, COUNT(*) c
             FROM mappings m JOIN vocabulary v ON v.rowid = m.vocab_rowid
            WHERE m.field_id = ? GROUP BY m.vocab_rowid""",
        (fid,),
    ).fetchall()
    d = {}
    for disp, c in rows:
        d.setdefault(disp, []).append(c)
    for k in d:
        d[k].sort(reverse=True)
    return d


def split_cells(line):
    return [c.strip() for c in line.strip().strip("|").split("|")]


def process(conn, path, fid):
    full = os.path.join(ROOT, path)
    with open(full, encoding="utf-8") as f:
        lines = f.readlines()

    # locate the table: first separator row, data rows are the contiguous
    # pipe-rows after it.
    sep_idx = next(i for i, ln in enumerate(lines) if SEP_RE.match(ln))
    data_idx = []
    for i in range(sep_idx + 1, len(lines)):
        if lines[i].lstrip().startswith("|"):
            data_idx.append(i)
        else:
            break

    fmap = field_map(conn, fid)
    # diacritic-folding fallback: folded(disp) -> [disp, ...] (len>1 = ambiguous)
    folded = {}
    for disp in fmap:
        folded.setdefault(fold(disp), []).append(disp)

    def resolve(label):
        if label in fmap:
            return fmap[label]
        cand = folded.get(fold(label))
        return fmap[cand[0]] if cand and len(cand) == 1 else None

    # pass 1: collect cells, group by label -> list of (row_i, pair_j, oldcount)
    rows_cells = {}  # row_i -> cell list
    by_label = {}
    for i in data_idx:
        cells = split_cells(lines[i])
        rows_cells[i] = cells
        for j in range(0, len(cells) - 1, 2):
            label, cnt = cells[j], cells[j + 1]
            if not label:
                continue
            by_label.setdefault(label, []).append((i, j, parse_count(cnt)))

    new_counts = {}  # (row_i, pair_j) -> new int count
    unmatched, flagged, summed = [], [], []
    for label, occ in by_label.items():
        db = resolve(label)
        if not db:
            unmatched.append((label, len(occ)))
            continue
        k, m = len(occ), len(db)
        if m == 1:  # one term -> every doc row with this label gets its count
            for (ri, rj, _old) in occ:
                new_counts[(ri, rj)] = db[0]
        elif k == 1:  # single row, many terms -> the row is their SUM
            total = sum(db)
            new_counts[(occ[0][0], occ[0][1])] = total
            summed.append((label, occ[0][2], db, total))
        elif k == m:  # one row per term -> rank-match by count
            occ_sorted = sorted(occ, key=lambda o: (o[2] is None, -(o[2] or 0)))
            for (ri, rj, _old), newc in zip(occ_sorted, db):  # db already desc
                new_counts[(ri, rj)] = newc
        else:
            flagged.append((label, k, m))

    # build report
    changed = []
    for (ri, rj), newc in new_counts.items():
        cur = rows_cells[ri][rj + 1]
        if fmt(newc) != cur:  # same predicate the write uses
            old = parse_count(cur)
            pct = (abs(newc - old) / old * 100) if old else 100.0
            changed.append((rows_cells[ri][rj], old, newc, pct))

    print(f"\n=== {path} (field {fid}) ===")
    print(f"  data rows: {len(data_idx)} | distinct labels: {len(by_label)} | "
          f"cells matched: {len(new_counts)} | unmatched: {len(unmatched)} | flagged: {len(flagged)}")
    print(f"  summed (k=1,m>1) labels: {len(summed)} | cells changed: {len(changed)}")
    if unmatched:
        print("  UNMATCHED labels (left as-is):")
        for lbl, n in unmatched:
            print(f"    - {lbl!r} (x{n})")
    if flagged:
        print("  FLAGGED labels (k!=m, left as-is):")
        for lbl, k, m in flagged:
            print(f"    - {lbl!r}: {k} doc rows vs {m} db terms")
    if summed:
        print("  SUM validation (label: old_doc -> db_terms -> new_sum):")
        for lbl, old, db, total in sorted(summed):
            print(f"    - {lbl}: {old} -> {db} -> {total}")
    if changed:
        changed.sort(key=lambda c: -c[3])
        print(f"  largest changes (top 8 of {len(changed)} by %):")
        for lbl, old, new, pct in changed[:8]:
            print(f"    - {lbl}: {old} -> {new}  ({pct:.1f}%)")

    if WRITE:
        for i in data_idx:
            cells = rows_cells[i]
            touched = False
            for j in range(0, len(cells) - 1, 2):
                key = (i, j)
                if key in new_counts:
                    f_new = fmt(new_counts[key])
                    if cells[j + 1] != f_new:
                        cells[j + 1] = f_new
                        touched = True
            if touched:
                lines[i] = "| " + " | ".join(cells) + " |\n"
        with open(full, "w", encoding="utf-8") as f:
            f.writelines(lines)
        print("  WROTE updates.")

    return len(unmatched), len(flagged)


def main():
    conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    issues = 0
    for path, fid in DOCS:
        u, fl = process(conn, path, fid)
        issues += u + fl
    print(f"\n{'WROTE' if WRITE else 'DRY-RUN'} complete. unmatched+flagged total: {issues}")
    if issues and not WRITE:
        print("Resolve unmatched/flagged before --write, or accept they stay as-is.")


if __name__ == "__main__":
    main()
