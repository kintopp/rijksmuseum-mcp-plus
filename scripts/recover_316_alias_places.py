#!/usr/bin/env python3
"""Side-pass for #316 (Tier 2 of #245): recover label-less alias-stub places
that carry an internal `schema:sameAs` link to another already-loaded
`id.rijksmuseum.nl/<id>` row.

Walks the local place dump directory (`/tmp/rm-dump-place` by default, or
`~/Downloads/rijksmuseum-data-dumps/place_extracted`), finds files of shape

    <alias>  rdf:type     schema:Place .
    <alias>  schema:sameAs <https://id.rijksmuseum.nl/<canonical>> .
    (no  <alias> schema:name ...  triples)

and, for each alias whose canonical sibling already exists in `vocabulary`
with a non-NULL label, writes:

    1.  INSERT into vocabulary (id, type='place', label_en, label_nl,
        label_en_norm, label_nl_norm) — labels copied from canonical.
    2.  INSERT into vocabulary_external_ids
        (vocab_id=alias, authority='rijksmuseum_alias', id=canonical,
         uri=https://id.rijksmuseum.nl/<canonical>) — both the alias
        relationship AND its provenance, in one row.
    3.  Two batch markers in version_info:
        recovery_316_alias_merge_at, recovery_316_alias_merge_count.

The alias row carries no coords, broader_id, notation or external_id (cheap
path per #316). Idempotent — INSERT OR IGNORE; safe to re-run.

Per-row provenance lives in the new `vocabulary_external_ids` row: anyone
asking "where did this label come from?" can join on the `rijksmuseum_alias`
authority entry to find the canonical sibling. See
`memory/canonical_label_provenance_gap.md` for the broader context.

Usage:
    ~/miniconda3/envs/embeddings/bin/python scripts/recover_316_alias_places.py --dry-run
    ~/miniconda3/envs/embeddings/bin/python scripts/recover_316_alias_places.py
"""
from __future__ import annotations

import argparse
import csv
import os
import re
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DB = REPO_ROOT / "data" / "vocabulary.db"
DEFAULT_DUMP_DIRS = [
    Path("/tmp/rm-dump-place"),
    Path.home() / "Downloads" / "rijksmuseum-data-dumps" / "place_extracted",
]

RIJKS_PREFIX = "https://id.rijksmuseum.nl/"
SCHEMA_PLACE = "http://schema.org/Place"
SCHEMA_SAMEAS = "http://schema.org/sameAs"
SCHEMA_NAME = "http://schema.org/name"
RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type"

# Bare URI-only triple pattern: <s> <p> <o> .
URI_TRIPLE_RE = re.compile(r"^<([^>]+)>\s+<([^>]+)>\s+<([^>]+)>\s*\.\s*$")
# Triple where object is a literal: <s> <p> "..." [@lang] .
LITERAL_TRIPLE_RE = re.compile(r"^<([^>]+)>\s+<([^>]+)>\s+\".*$")


def find_dump_dir(candidates: list[Path]) -> Path | None:
    for p in candidates:
        if p.is_dir() and any(p.iterdir()):
            return p
    return None


def classify_place_file(path: Path) -> tuple[str, str | None]:
    """Return (status, internal_canonical_id) for a place dump file.

    status ∈ {
        "alias_stub_internal",   # label-less stub, internal sameAs
        "has_label",             # has a schema:name triple (not our concern)
        "external_only",         # alias stub but only external sameAs (#318)
        "no_sameas",             # neither labelled nor sameAs (#318 'other')
        "not_place",             # missing rdf:type schema:Place
    }
    """
    entity_uri = f"{RIJKS_PREFIX}{path.name}"
    is_place = False
    has_name = False
    internal_target: str | None = None
    has_external_sameas = False

    try:
        with path.open("r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                # Quick subject filter — skip lines whose subject is a bnode
                # or another entity (containedInPlace target etc.).
                if not line.startswith(f"<{entity_uri}>"):
                    continue
                m = URI_TRIPLE_RE.match(line)
                if m:
                    _s, p, o = m.groups()
                    if p == RDF_TYPE and o == SCHEMA_PLACE:
                        is_place = True
                    elif p == SCHEMA_SAMEAS:
                        if o.startswith(RIJKS_PREFIX):
                            if internal_target is None:
                                internal_target = o[len(RIJKS_PREFIX):]
                        else:
                            has_external_sameas = True
                    continue
                # Literal-object triples — only schema:name matters here.
                lm = LITERAL_TRIPLE_RE.match(line)
                if lm:
                    _s, p = lm.groups()
                    if p == SCHEMA_NAME:
                        has_name = True
    except OSError:
        return ("not_place", None)

    if not is_place:
        return ("not_place", None)
    if has_name:
        return ("has_label", None)
    if internal_target is not None:
        return ("alias_stub_internal", internal_target)
    if has_external_sameas:
        return ("external_only", None)
    return ("no_sameas", None)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    ap.add_argument("--db", type=Path, default=DEFAULT_DB)
    ap.add_argument("--dump-dir", type=Path, default=None,
                    help=f"Override place dump dir. Default: first existing of "
                         f"{[str(p) for p in DEFAULT_DUMP_DIRS]}")
    ap.add_argument("--dry-run", action="store_true",
                    help="Scan and report; no DB writes.")
    ap.add_argument("--audit-tsv", type=Path,
                    default=REPO_ROOT / f"data/audit/issue-316-recovery-{datetime.now().strftime('%Y-%m-%d')}.tsv")
    args = ap.parse_args()

    if not args.db.exists():
        print(f"ERROR: DB not found: {args.db}", file=sys.stderr)
        return 1

    dump_dir = args.dump_dir or find_dump_dir(DEFAULT_DUMP_DIRS)
    if dump_dir is None or not dump_dir.is_dir():
        print(f"ERROR: no place dump dir found among {DEFAULT_DUMP_DIRS}",
              file=sys.stderr)
        return 1
    print(f"Place dump dir: {dump_dir}")

    conn = sqlite3.connect(args.db)
    conn.execute("PRAGMA foreign_keys = OFF")
    existing_ids: set[str] = {
        r[0] for r in conn.execute("SELECT id FROM vocabulary").fetchall()
    }
    next_int_id = (conn.execute(
        "SELECT COALESCE(MAX(vocab_int_id), 0) FROM vocabulary"
    ).fetchone()[0]) + 1
    print(f"Vocab rows already loaded: {len(existing_ids):,}. "
          f"Next vocab_int_id: {next_int_id}")

    files = sorted(f for f in os.listdir(dump_dir)
                   if (dump_dir / f).is_file() and not f.startswith("."))
    print(f"Place dump files to scan: {len(files):,}")

    counters = {
        "already_loaded": 0,
        "alias_stub_internal": 0,
        "has_label": 0,
        "external_only": 0,
        "no_sameas": 0,
        "not_place": 0,
        "canonical_missing": 0,
        "canonical_unlabelled": 0,
        "self_reference": 0,
        "recovered": 0,
    }
    audit_rows: list[tuple] = []

    for fname in files:
        if fname in existing_ids:
            counters["already_loaded"] += 1
            continue
        status, canonical_id = classify_place_file(dump_dir / fname)
        counters[status] += 1
        if status != "alias_stub_internal":
            continue
        assert canonical_id is not None
        if canonical_id == fname:
            counters["self_reference"] += 1
            continue
        row = conn.execute(
            "SELECT label_en, label_nl FROM vocabulary WHERE id = ?",
            (canonical_id,),
        ).fetchone()
        if row is None:
            counters["canonical_missing"] += 1
            continue
        label_en, label_nl = row
        if label_en is None and label_nl is None:
            counters["canonical_unlabelled"] += 1
            continue

        counters["recovered"] += 1
        audit_rows.append((
            fname, f"{RIJKS_PREFIX}{fname}",
            canonical_id, f"{RIJKS_PREFIX}{canonical_id}",
            label_en or "", label_nl or "",
        ))

        if not args.dry_run:
            conn.execute(
                "INSERT OR IGNORE INTO vocabulary "
                "(id, type, label_en, label_nl, label_en_norm, label_nl_norm, "
                " external_id, broader_id, notation, lat, lon) "
                "VALUES (?, 'place', ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL)",
                (
                    fname, label_en, label_nl,
                    (label_en.lower().replace(" ", "") if label_en else None),
                    (label_nl.lower().replace(" ", "") if label_nl else None),
                ),
            )
            cur = conn.execute(
                "UPDATE vocabulary SET vocab_int_id = ? "
                "WHERE id = ? AND vocab_int_id IS NULL",
                (next_int_id, fname),
            )
            if cur.rowcount:
                next_int_id += 1
            conn.execute(
                "INSERT OR IGNORE INTO vocabulary_external_ids "
                "(vocab_id, authority, id, uri) VALUES (?, ?, ?, ?)",
                (fname, "rijksmuseum_alias", canonical_id,
                 f"{RIJKS_PREFIX}{canonical_id}"),
            )
            existing_ids.add(fname)

    print("\nScan results:")
    for k in ("already_loaded", "alias_stub_internal", "has_label",
              "external_only", "no_sameas", "not_place",
              "canonical_missing", "canonical_unlabelled",
              "self_reference", "recovered"):
        print(f"  {k:>22s}  {counters[k]:>7,}")

    args.audit_tsv.parent.mkdir(parents=True, exist_ok=True)
    with args.audit_tsv.open("w", newline="") as f:
        w = csv.writer(f, delimiter="\t")
        w.writerow([
            "alias_id", "alias_uri",
            "canonical_id", "canonical_uri",
            "label_en", "label_nl",
        ])
        for row in audit_rows:
            w.writerow(row)
    print(f"\nAudit TSV: {args.audit_tsv} ({len(audit_rows)} rows)")

    if args.dry_run:
        print("[DRY-RUN] no DB writes performed.")
        conn.rollback()
        conn.close()
        return 0

    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    conn.execute(
        "INSERT OR REPLACE INTO version_info (key, value) VALUES (?, ?)",
        ("recovery_316_alias_merge_at", now_iso),
    )
    conn.execute(
        "INSERT OR REPLACE INTO version_info (key, value) VALUES (?, ?)",
        ("recovery_316_alias_merge_count", str(counters["recovered"])),
    )
    conn.commit()
    conn.close()
    print(f"Wrote {counters['recovered']} alias-place rows. "
          f"version_info markers set ({now_iso}).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
