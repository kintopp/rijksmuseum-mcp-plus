#!/usr/bin/env python3
"""Scaled verification for #231 — is the upstream bare-string fix comprehensive
enough to remove the harvest-side guards WITHOUT a full (~10h) harvest?

Run under the embeddings env (it imports the REAL harvest module, which needs
`requests` + `scripts/lib`):

    ~/miniconda3/envs/embeddings/bin/python scripts/tests/verify-231-guard-removal.py [--per-type N]

Sample path per record:  data/vocabulary.db (type-stratified object_numbers)
    -> public Search API (objectNumber -> numeric HMO URI)
    -> id.rijksmuseum.nl HMO ld+json

Two checks:

  CHECK A — complete proof (recursive bare-string scan).
    Walks every `classified_as` / `equivalent` array in each record. Both real
    guards diverge from their guard-removed forms ONLY on a non-dict (bare
    string) element:
      * has_classification: `... if isinstance(c, dict) else str(c)` (2343)
      * _extract_ids:       `if isinstance(item, dict)` skips non-dicts (2872)
    So **0 bare strings across the sample == removing the guards changes nothing**.
    Tallied by object type and by JSON path-shape.

  CHECK B — empirical differential using the ACTUAL functions.
    Imports the real has_classification / _extract_ids / extract_production_parts
    from scripts/harvest-vocabulary-db.py and runs extract_production_parts on
    each record GUARDED vs GUARD-REMOVED (monkeypatched), asserting byte-identical
    output. A guard-removed run *crashes* (str.get) on a bare string -> flagged.
    This is criterion-3 ("same row counts after harvest") evaluated per-record on
    live data, minus the harvest.

Exit 0 = safe to remove the guards; 1 = bare strings found or differential mismatch.
"""
import argparse
import importlib.util
import json
import re
import sqlite3
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parents[2]
HARVEST_PATH = PROJECT_DIR / "scripts" / "harvest-vocabulary-db.py"
DB_PATH = PROJECT_DIR / "data" / "vocabulary.db"

# Object types chosen for diverse production structures (rich produced_by.part
# attribution on prints/drawings/paintings; sparser on photos/books/medals).
TYPES = [
    "painting", "print", "drawing", "photograph", "photomechanical print",
    "carte-de-visite", "letter", "poster", "history medal", "book",
    "popular print", "stereograph",
]


# ── Load the REAL harvest module (self-bootstraps scripts/lib on its sys.path) ──
def load_harvest():
    spec = importlib.util.spec_from_file_location("harvest_mod", HARVEST_PATH)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


# ── Guard-removed twins (what the code becomes if the #231 guards are deleted) ──
def has_classification_noguard(classified_as, uris):
    if not classified_as:
        return False
    if isinstance(uris, str):
        uris = {uris}
    return any(c.get("id", "") in uris for c in classified_as)  # str.get -> crash


def extract_ids_noguard(items, field):
    result = []
    for item in items:
        uri = item.get("id", "")  # str.get -> crash on a bare string
        if uri:
            result.append((uri.split("/")[-1], field))
    return result


# ── Sampling ───────────────────────────────────────────────────────────────
def db_sample(per_type):
    con = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    type_field = con.execute("SELECT id FROM field_lookup WHERE name='type'").fetchone()[0]
    out = {}
    for t in TYPES:
        rows = con.execute(
            """
            SELECT a.object_number
            FROM mappings m
            JOIN vocabulary v ON v.vocab_int_id = m.vocab_rowid
            JOIN artworks  a ON a.art_id        = m.artwork_id
            WHERE m.field_id = ? AND v.label_en = ?
            ORDER BY RANDOM() LIMIT ?
            """,
            (type_field, t, per_type),
        ).fetchall()
        out[t] = [r[0] for r in rows]
    con.close()
    return out


# ── HTTP ─────────────────────────────────────────────────────────────────────
def _get(url, accept, retries=2):
    last = None
    for _ in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers={"Accept": accept})
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(0.5)
    raise last


def search_numeric(object_number):
    q = urllib.parse.quote(object_number, safe="")
    url = f"https://data.rijksmuseum.nl/search/collection?objectNumber={q}"
    d = json.loads(_get(url, "application/json"))
    items = d.get("orderedItems") or []
    return items[0]["id"] if items else None


def resolve(uri):
    return json.loads(_get(uri, "application/ld+json"))


# ── CHECK A: recursive bare-string scan ──────────────────────────────────────
_IDX = re.compile(r"\[\d+\]")


def scan_bare(obj, path=""):
    """Yield (path_shape, elements_in_array, n_bare) for every classified_as /
    equivalent array; recurse everywhere."""
    if isinstance(obj, dict):
        for field in ("classified_as", "equivalent"):
            arr = obj.get(field)
            if isinstance(arr, list):
                n_bare = sum(1 for c in arr if not isinstance(c, dict))
                shape = _IDX.sub("[]", f"{path}.{field}")
                yield (shape, len(arr), n_bare, [c for c in arr if isinstance(c, str)][:3])
        for k, v in obj.items():
            yield from scan_bare(v, f"{path}.{k}")
    elif isinstance(obj, list):
        for i, x in enumerate(obj):
            yield from scan_bare(x, f"{path}[{i}]")


# ── CHECK B: real-function differential ──────────────────────────────────────
def differential(H, data):
    """Run real extract_production_parts guarded vs guard-removed. Returns
    ('same' | 'diff' | 'crash:<Err>' | 'guarded-error:<Err>')."""
    try:
        guarded = H.extract_production_parts(data)
    except Exception as e:  # noqa: BLE001
        return f"guarded-error:{type(e).__name__}"
    real_hc, real_ei = H.has_classification, H._extract_ids
    H.has_classification, H._extract_ids = has_classification_noguard, extract_ids_noguard
    try:
        unguarded = H.extract_production_parts(data)
        return "same" if guarded == unguarded else "diff"
    except Exception as e:  # noqa: BLE001
        return f"crash:{type(e).__name__}"
    finally:
        H.has_classification, H._extract_ids = real_hc, real_ei


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--per-type", type=int, default=60, help="records per object type (default 60)")
    ap.add_argument("--delay", type=float, default=0.1, help="seconds between records")
    args = ap.parse_args()

    H = load_harvest()
    sample = db_sample(args.per_type)

    # CHECK A tallies
    arrays_inspected = 0
    elements_inspected = 0
    bare_total = 0
    bare_by_path = Counter()
    bare_examples = []
    arrays_by_path = Counter()          # coverage: which historically-bare paths we actually hit
    # CHECK B tallies
    diff_counts = Counter()
    diff_examples = defaultdict(list)
    # bookkeeping
    per_type_records = Counter()
    per_type_bare = Counter()
    lookup_fail = []
    resolve_fail = []

    total = sum(len(v) for v in sample.values())
    print(f"Sampling {total} records ({args.per_type}/type × {len(sample)} types)\n")

    done = 0
    for t, objs in sample.items():
        for obj in objs:
            done += 1
            try:
                uri = search_numeric(obj)
            except Exception as e:  # noqa: BLE001
                lookup_fail.append((obj, str(e))); continue
            if not uri:
                lookup_fail.append((obj, "no orderedItems")); continue
            try:
                data = resolve(uri)
            except Exception as e:  # noqa: BLE001
                resolve_fail.append((obj, uri, str(e))); continue

            per_type_records[t] += 1
            rec_bare = 0
            for shape, n_elems, n_bare, strs in scan_bare(data):
                arrays_inspected += 1
                elements_inspected += n_elems
                arrays_by_path[shape] += 1
                if n_bare:
                    bare_total += n_bare
                    rec_bare += n_bare
                    bare_by_path[shape] += n_bare
                    if len(bare_examples) < 15:
                        bare_examples.append((t, obj, shape, strs))
            per_type_bare[t] += rec_bare

            verdict = differential(H, data)
            diff_counts[verdict] += 1
            if verdict != "same" and len(diff_examples[verdict]) < 5:
                diff_examples[verdict].append((t, obj, uri))

            if done % 50 == 0:
                print(f"  {done}/{total}  bare={bare_total}  diff!=same={sum(v for k,v in diff_counts.items() if k!='same')}")
            time.sleep(args.delay)

    sampled_ok = sum(per_type_records.values())
    print("\n" + "=" * 64)
    print("CHECK A — bare-string scan")
    print("=" * 64)
    print(f"Records resolved:            {sampled_ok}/{total}")
    print(f"classified_as/equivalent arrays inspected: {arrays_inspected}")
    print(f"array elements inspected:    {elements_inspected}")
    print(f"BARE-STRING HITS:            {bare_total}")
    if bare_by_path:
        print("\n  bare by path-shape:")
        for p, c in bare_by_path.most_common():
            print(f"    {c:>5}  {p}")
        print("\n  examples:")
        for t, obj, shape, strs in bare_examples:
            print(f"    [{t}] {obj}  {shape}  {strs}")

    print("\n  per-type coverage (records | bare):")
    for t in TYPES:
        print(f"    {t:<24} {per_type_records[t]:>4} | {per_type_bare[t]}")

    print("\n  historically-affected paths — arrays actually inspected:")
    for needle in (".equivalent",
                   ".produced_by.part[].referred_to_by[].classified_as",
                   ".produced_by.referred_to_by[].classified_as",
                   ".subject_of[].classified_as",
                   ".identified_by[].classified_as"):
        hit = sum(c for p, c in arrays_by_path.items() if p.endswith(needle))
        print(f"    {hit:>6}  *{needle}")

    print("\n" + "=" * 64)
    print("CHECK B — real-function differential (extract_production_parts)")
    print("=" * 64)
    for verdict, c in diff_counts.most_common():
        print(f"  {verdict:<22} {c}")
    for verdict, exs in diff_examples.items():
        print(f"  examples [{verdict}]: {exs}")

    if lookup_fail or resolve_fail:
        print(f"\n  lookup failures: {len(lookup_fail)} | resolve failures: {len(resolve_fail)}")
        for x in (lookup_fail + resolve_fail)[:5]:
            print(f"    {x}")

    print("\n" + "=" * 64)
    safe = bare_total == 0 and set(diff_counts) <= {"same"}
    if safe:
        print("VERDICT: ✅ SAFE TO REMOVE the #231 guards.")
        print(f"  0 bare strings across {elements_inspected} elements in {sampled_ok} records;")
        print("  extract_production_parts is byte-identical with the guards removed.")
    else:
        print("VERDICT: ⛔ DO NOT remove the guards yet — see hits above.")
    print("=" * 64)
    return 0 if safe else 1


if __name__ == "__main__":
    sys.exit(main())
