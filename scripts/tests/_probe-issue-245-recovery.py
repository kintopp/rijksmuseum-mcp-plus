#!/usr/bin/env python3
"""One-shot probe: how many dump files dropped by the v0.26 harvest are
recovered by the #245 other-language fallback?

For each dump dir, compare the set of file basenames against the IDs already
present in `data/vocabulary.db`. Files in dump-but-not-DB are the v0.26 drop
residuals. Run those through the *current* parse_nt_file and count how many
now return a non-None record.

Run:
    ~/miniconda3/envs/embeddings/bin/python scripts/tests/_probe-issue-245-recovery.py
"""

import importlib.util
import os
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent  # scripts/tests/ → repo root
DB = ROOT / "data" / "vocabulary.db"

spec = importlib.util.spec_from_file_location(
    "harvest_vocabulary_db", ROOT / "scripts" / "harvest-vocabulary-db.py"
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
parse_nt_file = mod.parse_nt_file
make_iconclass_resolver = mod.make_iconclass_resolver

# #245 Tier 1: pass the iconclass resolver so the probe reflects the full
# recovery picture (parser fix + iconclass fallback). Falls back to None
# if iconclass.db isn't found, which makes the probe still functional.
iconclass_resolver = make_iconclass_resolver()
print(f"Iconclass resolver: {'active' if iconclass_resolver else 'unavailable'}")

DUMP_TO_TYPE = {
    "/tmp/rm-dump-classification": "classification",
    "/tmp/rm-dump-concept": "classification",
    "/tmp/rm-dump-place": "place",
    "/tmp/rm-dump-person": "person",
    "/tmp/rm-dump-organisation": "organisation",
    "/tmp/rm-dump-topical_term": "concept",
    "/tmp/rm-dump-event": "event",
    "/tmp/rm-dump-exhibition": "exhibition",
}

conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
db_ids = {row[0] for row in conn.execute("SELECT id FROM vocabulary").fetchall()}
print(f"DB ids: {len(db_ids):,}\n")

print(f"{'dump':<35}  {'files':>8}  {'in DB':>8}  {'dropped':>8}  {'recovered':>10}  {'remain null':>11}  example")
print("-" * 130)

grand_dropped = 0
grand_recovered = 0
for dump_dir, default_type in DUMP_TO_TYPE.items():
    if not os.path.isdir(dump_dir):
        continue
    files = os.listdir(dump_dir)
    in_db = sum(1 for f in files if f in db_ids)
    dropped_files = [f for f in files if f not in db_ids]
    recovered = 0
    example_recovered = ""
    example_null = ""
    for f in dropped_files:
        r = parse_nt_file(os.path.join(dump_dir, f), default_type,
                          iconclass_resolver=iconclass_resolver)
        if r is not None:
            recovered += 1
            if not example_recovered:
                example_recovered = f"{f}: {r.get('label_en') or r.get('label_nl')!r}"
        else:
            if not example_null:
                example_null = f
    still_null = len(dropped_files) - recovered
    grand_dropped += len(dropped_files)
    grand_recovered += recovered
    ex = example_recovered or f"(null) {example_null}"
    print(f"{dump_dir:<35}  {len(files):>8,}  {in_db:>8,}  {len(dropped_files):>8,}  {recovered:>10,}  {still_null:>11,}  {ex[:50]}")

print("-" * 130)
print(f"{'TOTAL':<35}  {'':>8}  {'':>8}  {grand_dropped:>8,}  {grand_recovered:>10,}  {grand_dropped - grand_recovered:>11,}")

conn.close()
