#!/usr/bin/env python3
"""Aggregate output of probe-motivated-by.py."""
import re
import sys
from collections import Counter, defaultdict

path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/probe-prints-drawings.txt"

cur = None
kind = None
hits = defaultdict(int)
entries = defaultdict(int)
dicts = defaultdict(int)
strs = defaultdict(int)
clf = Counter()
bare = Counter()
cb = Counter()

obj_re = re.compile(r"^=== (\S+) ===")
n_re = re.compile(r"(\d+) motivated_by entries")
url_re = re.compile(r"https?://\S+?(?='|]|,|$)")


def kind_of(obj):
    if obj.startswith("RP-P-"): return "PRINT"
    if obj.startswith("RP-T-"): return "DRAW"
    if obj.startswith("SK-A-"): return "PAINT"
    return "OTHER"


with open(path) as f:
    for line in f:
        m = obj_re.match(line)
        if m:
            cur = m.group(1)
            kind = kind_of(cur)
            continue
        if "motivated_by entries" in line:
            mn = n_re.search(line)
            if mn:
                hits[kind] += 1
                entries[kind] += int(mn.group(1))
            continue
        s = line.strip()
        if s.startswith("[part") and "DICT" in s:
            dicts[kind] += 1
        elif s.startswith("[part") and "STR" in s:
            strs[kind] += 1
            for u in url_re.findall(line):
                bare[u.rstrip("',]")] += 1
        elif s.startswith("classified_as:"):
            for u in url_re.findall(line):
                clf[u.rstrip("',]")] += 1
        elif s.startswith("carried_by:"):
            for u in url_re.findall(line):
                cb[u.rstrip("',]")] += 1

print(f"Source: {path}")
print()
for k in sorted(hits):
    avg = entries[k] / hits[k] if hits[k] else 0
    print(f"  {k:6} artworks with motivated_by: {hits[k]:3}   entries: {entries[k]:3}   avg: {avg:.2f}")
print()
print("Entry shape by object type:")
for k in sorted(set(list(dicts) + list(strs))):
    print(f"  {k:6} DICT: {dicts[k]:3}    STR: {strs[k]:3}")
print()
print("classified_as[] AAT codes (dict variant):")
for u, n in clf.most_common():
    print(f"  {n:4}  {u}")
print()
print("Bare-string motivated_by values (str variant):")
if not bare:
    print("  (none)")
for u, n in bare.most_common():
    print(f"  {n:4}  {u}")
print()
print(f"carried_by URIs: {len(cb)} distinct (across {sum(dicts.values())} dict entries)")
