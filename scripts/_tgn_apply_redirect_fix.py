"""One-shot: apply the 13 TGN-deprecation redirects to vocabulary.db.

Reads the 'via_replacement' rows from _tgn_chain_results.tsv, writes
lat/lon + coord_method='deterministic' + coord_method_detail='tgn_via_replacement'
to vocabulary, and inserts the new TGN URI into vocabulary_external_ids.
The original (obsolete) TGN URI is left in place — it remains a valid
identifier for the place, just deprecated upstream.

Audit log written to data/backfills/2026-04-26-tgn-redirect-fix.tsv.
"""
from __future__ import annotations

import csv
import sqlite3
from pathlib import Path

DB = Path("data/vocabulary.db")
SOURCE = Path("data/audit/areal-classifier-extension/_tgn_chain_results.tsv")
AUDIT = Path("data/backfills/2026-04-26-tgn-redirect-fix.tsv")


def main() -> None:
    AUDIT.parent.mkdir(parents=True, exist_ok=True)
    with SOURCE.open() as f:
        rows = [r for r in csv.DictReader(f, delimiter="\t") if r["resolved"] == "via_replacement"]
    print(f"redirects to apply: {len(rows)}")

    audit_rows: list[dict[str, str]] = []
    with sqlite3.connect(DB) as conn:
        conn.execute("BEGIN")
        try:
            for r in rows:
                vocab_id = r["vocab_id"]
                old_uri = r["tgn_uri"]
                new_uri = r["replacement_uri"]
                lat = float(r["replacement_lat"])
                lon = float(r["replacement_lon"])

                # Read existing row state for the audit log
                existing = conn.execute(
                    "SELECT lat, lon, coord_method, coord_method_detail FROM vocabulary WHERE id = ?",
                    (vocab_id,),
                ).fetchone()

                # Apply the coord write
                conn.execute(
                    """UPDATE vocabulary
                       SET lat = ?, lon = ?, coord_method = 'deterministic', coord_method_detail = 'tgn_via_replacement'
                       WHERE id = ?""",
                    (lat, lon, vocab_id),
                )

                # Add the new TGN URI as a fresh authority record
                # (keeps the old URI in place — it remains a valid identifier)
                new_tgn_id = new_uri.rsplit("/", 1)[-1]
                conn.execute(
                    """INSERT OR IGNORE INTO vocabulary_external_ids (vocab_id, authority, id, uri)
                       VALUES (?, 'tgn', ?, ?)""",
                    (vocab_id, new_tgn_id, new_uri),
                )

                audit_rows.append({
                    "vocab_id": vocab_id,
                    "label_en": r["label_en"],
                    "label_nl": r["label_nl"],
                    "old_tgn_uri": old_uri,
                    "new_tgn_uri": new_uri,
                    "prev_lat": str(existing[0]) if existing[0] is not None else "",
                    "prev_lon": str(existing[1]) if existing[1] is not None else "",
                    "prev_coord_method": existing[2] or "",
                    "prev_coord_method_detail": existing[3] or "",
                    "new_lat": str(lat),
                    "new_lon": str(lon),
                    "new_coord_method": "authority",
                    "new_coord_method_detail": "tgn_via_replacement",
                })
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise

    with AUDIT.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(audit_rows[0].keys()), delimiter="\t")
        w.writeheader()
        w.writerows(audit_rows)
    print(f"applied {len(audit_rows)} updates")
    print(f"audit log: {AUDIT}")

    # Verify
    with sqlite3.connect(DB) as conn:
        cnt = conn.execute(
            "SELECT COUNT(*) FROM vocabulary WHERE coord_method_detail = 'tgn_via_replacement'"
        ).fetchone()[0]
    print(f"vocab rows now tagged tgn_via_replacement: {cnt}")


if __name__ == "__main__":
    main()
