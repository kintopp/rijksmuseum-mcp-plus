"""Delete the 16 rows in vocabulary_external_ids where authority='tgn' but the
local id is provably not a TGN ID (#335).

Idempotent: only deletes the listed (vocab_id, id) tuples, re-running on an
already-clean DB updates 0 rows.

Usage:
    python3 scripts/cleanup_bogus_tgn_external_ids.py --dry-run
    python3 scripts/cleanup_bogus_tgn_external_ids.py
"""
import argparse
import sqlite3
import sys
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parents[1]
DB_PATH = PROJECT_DIR / "data" / "vocabulary.db"

# (vocab_id, id) tuples from the TGN RDF re-validation dry-run, 2026-05-09.
BOGUS_ROWS: list[tuple[int, str]] = [
    (23022333, "25H214"),     # "Prospect Lake"
    (23022490, "25H214"),     # "Hickling Broad"
    (23020051, "144178830"),  # Polenzko
    (23019753, "155404628"),  # Mendelejewo
    (23019755, "155404628"),  # Juditten
    (23020225, "161252012"),  # Oos
    (23019983, "650997975"),  # Trnove
    (23017819, "704528604"),  # San Ginesio
    (23026247, "130702"),     # Tees
    (23019524, "1766812"),    # Heinsheim
    (23020552, "40913486"),   # San Bernardinopas
    (23019665, "45500512"),   # Knonau
    (2306915,  "600329"),     # La Hogue
    (2304201,  "700828"),     # L'Ile-Bouchard
    (23020037, "7520358"),    # Aboe Simbel (real TGN ID for Abu Simbel: 7000079)
    (330134145, "8714653"),   # Calima
]


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--dry-run", action="store_true",
                   help="Report what would be deleted, make no changes.")
    p.add_argument("--db", type=Path, default=DB_PATH,
                   help=f"Path to the vocabulary DB (default: {DB_PATH}).")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    if not args.db.exists():
        print(f"ERROR: DB not found at {args.db}", file=sys.stderr)
        return 1
    conn = sqlite3.connect(str(args.db))

    present: list[tuple[int, str, str | None]] = []
    for vocab_id, ext_id in BOGUS_ROWS:
        row = conn.execute(
            "SELECT v.label_nl FROM vocabulary_external_ids vei "
            "LEFT JOIN vocabulary v ON v.id = vei.vocab_id "
            "WHERE vei.vocab_id = ? AND vei.authority = 'tgn' AND vei.id = ?",
            (vocab_id, ext_id),
        ).fetchone()
        if row is not None:
            present.append((vocab_id, ext_id, row[0]))

    print(f"Bogus rows targeted:    {len(BOGUS_ROWS)}")
    print(f"  present in this DB:   {len(present)}")
    print(f"  already absent:       {len(BOGUS_ROWS) - len(present)}")
    if present:
        print()
        print("Would delete:" if args.dry_run else "Deleting:")
        for vocab_id, ext_id, label in present:
            print(f"  vocab_id={vocab_id:<10} id={ext_id:<12} label={label!r}")

    if args.dry_run:
        print()
        print("Dry run — no changes written.")
        return 0

    if not present:
        print("Nothing to delete. DB is already clean.")
        return 0

    with conn:
        cur = conn.execute(
            "DELETE FROM vocabulary_external_ids "
            "WHERE authority = 'tgn' AND (vocab_id, id) IN ("
            + ",".join("(?, ?)" for _ in present)
            + ")",
            [v for row in present for v in row[:2]],
        )
    print()
    print(f"Deleted {cur.rowcount} row(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
