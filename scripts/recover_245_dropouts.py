#!/usr/bin/env python3
"""Side-pass for #245: re-parse the four affected v0.26 dump dirs with the
post-Tier-1 parser + iconclass.db fallback, INSERT OR IGNORE recovered vocab
rows. Idempotent — safe to re-run.

Targets the 271 entries dropped at v0.26 harvest time (158 parser-fix +
113 iconclass-fallback): classification + organisation + concept + person
dumps. No network, no SPARQL, ~seconds wall time.

Does NOT recover artwork→vocab `mappings` rows. Those were dropped during
Phase 3 integer-encoding and need a separate pass (LIDO subject extractor
or Search API for creators).

Usage:
    python3 scripts/recover_245_dropouts.py --db data/vocabulary.db
    python3 scripts/recover_245_dropouts.py --dry-run
"""
from __future__ import annotations

import argparse
import csv
import importlib.util
import os
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
HARVEST = REPO_ROOT / "scripts" / "harvest-vocabulary-db.py"

DUMPS = [
    ("classification", Path("/tmp/rm-dump-classification")),
    ("organisation",   Path("/tmp/rm-dump-organisation")),
    ("concept",        Path("/tmp/rm-dump-concept")),
    ("person",         Path("/tmp/rm-dump-person")),
]


def load_harvest_module():
    spec = importlib.util.spec_from_file_location("harvest_vocab", HARVEST)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["harvest_vocab"] = mod
    spec.loader.exec_module(mod)
    return mod


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", type=Path, default=REPO_ROOT / "data/vocabulary.db")
    ap.add_argument("--dry-run", action="store_true",
                    help="Report what would be recovered without writing")
    ap.add_argument("--audit-tsv", type=Path,
                    default=REPO_ROOT / f"data/audit/issue-245-recovery-{datetime.now().strftime('%Y-%m-%d')}.tsv")
    args = ap.parse_args()

    if not args.db.exists():
        print(f"ERROR: DB not found: {args.db}", file=sys.stderr)
        return 1

    for default_type, dump_dir in DUMPS:
        if not dump_dir.is_dir() or not any(dump_dir.iterdir()):
            print(f"ERROR: dump dir empty/missing: {dump_dir}", file=sys.stderr)
            return 1

    harvest = load_harvest_module()
    iconclass_resolver = harvest.make_iconclass_resolver()
    if iconclass_resolver is None:
        print("ERROR: iconclass.db not found via auto-discovery — set "
              "ICONCLASS_DB_PATH or place iconclass.db in data/ "
              "or ../rijksmuseum-iconclass-mcp/data/", file=sys.stderr)
        return 1
    print(f"iconclass.db resolver loaded.")

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

    args.audit_tsv.parent.mkdir(parents=True, exist_ok=True)
    audit_rows: list[tuple] = []

    summary: dict[str, dict] = {}

    for default_type, dump_dir in DUMPS:
        files = [f for f in os.listdir(dump_dir)
                 if os.path.isfile(dump_dir / f) and not f.startswith(".")]
        already = 0
        not_in_db = 0
        recovered = 0
        still_dropped = 0

        for fname in files:
            entity_id = fname  # parse_nt_file uses os.path.basename as the id
            if entity_id in existing_ids:
                already += 1
                continue
            not_in_db += 1
            rec = harvest.parse_nt_file(str(dump_dir / fname), default_type,
                                        iconclass_resolver=iconclass_resolver)
            if rec is None:
                still_dropped += 1
                continue
            recovered += 1
            audit_rows.append((default_type, fname, f"https://id.rijksmuseum.nl/{fname}",
                               rec.get("label_en") or "",
                               rec.get("label_nl") or "",
                               rec.get("external_id") or "",
                               rec.get("notation") or ""))
            if not args.dry_run:
                ext_ids = rec.pop("_external_ids", [])
                rec_to_bind = dict(rec)
                conn.execute(harvest.VOCAB_INSERT_SQL, rec_to_bind)
                # Assign vocab_int_id manually (post-Phase-3 schema requires it).
                cur = conn.execute(
                    "UPDATE vocabulary SET vocab_int_id = ? "
                    "WHERE id = ? AND vocab_int_id IS NULL",
                    (next_int_id, rec["id"]),
                )
                if cur.rowcount:
                    next_int_id += 1
                for auth, ext_id, ext_uri in ext_ids:
                    conn.execute(harvest.VEI_INSERT_SQL,
                                 (rec["id"], auth, ext_id, ext_uri))

        summary[default_type] = dict(
            files=len(files), already_loaded=already,
            previously_dropped=not_in_db,
            recovered=recovered, still_dropped=still_dropped,
        )
        print(f"  {default_type:14s} files={len(files):>6}  "
              f"already={already:>6}  prev_dropped={not_in_db:>4}  "
              f"recovered={recovered:>4}  still_dropped={still_dropped:>4}")

    if args.dry_run:
        print("\n[DRY-RUN] no DB writes performed.")
        conn.rollback()
    else:
        conn.commit()
        print(f"\nWrote {sum(s['recovered'] for s in summary.values())} "
              f"vocabulary rows.")
    conn.close()

    with args.audit_tsv.open("w", newline="") as f:
        w = csv.writer(f, delimiter="\t")
        w.writerow(["type", "filename", "entity_id",
                    "label_en", "label_nl", "external_id", "notation"])
        for row in audit_rows:
            w.writerow(row)
    print(f"Audit TSV: {args.audit_tsv} ({len(audit_rows)} rows)")

    total_recovered = sum(s["recovered"] for s in summary.values())
    print(f"\n=== Summary ===\nTotal recovered: {total_recovered}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
