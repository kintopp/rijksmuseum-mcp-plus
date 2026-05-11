"""Pull artworks linked to the 3 disagreement places, with surrounding metadata
that might disambiguate which TGN identification is right (Rijksmuseum's vs.
the reconciliation pipeline's).

For each place, list:
  - field of attachment (production_place / spatial / subject / etc.)
  - artwork title, date range, creator
  - other places attached to the same artwork (and their broader chains)
  - description excerpt
"""
import sqlite3
import sys
from pathlib import Path

DB = Path(__file__).resolve().parents[2] / "data" / "vocabulary.db"

PLACES = [
    ("2305024",  "Ohio",        "Rijks→1034723", "reconciled→7007706 (Ohio, USA)"),
    ("23019133", "Montmorency", "Rijks→7009368", "reconciled→7013077 (Quebec, CA)"),
    ("2303521",  "Bournemouth", "Rijks→7010737", "reconciled→7011274 (UK coast)"),
]


def fetch_artworks(conn: sqlite3.Connection, vocab_id: str) -> list[dict]:
    rows = conn.execute(
        """
        SELECT a.object_number, a.title, a.creator_label,
               a.date_earliest, a.date_latest, a.date_display,
               a.description_text, a.narrative_text,
               f.name AS field
        FROM mappings m
        JOIN artworks a ON a.art_id = m.artwork_id
        JOIN vocabulary v ON v.vocab_int_id = m.vocab_rowid
        JOIN field_lookup f ON f.id = m.field_id
        WHERE v.id = ?
        ORDER BY a.date_earliest, a.object_number
        """,
        (vocab_id,),
    ).fetchall()
    cols = ["object_number", "title", "creator_label",
            "date_earliest", "date_latest", "date_display",
            "description_text", "narrative_text", "field"]
    return [dict(zip(cols, r)) for r in rows]


def fetch_other_places(conn: sqlite3.Connection,
                        object_number: str,
                        exclude_vocab_id: str) -> list[tuple[str, str, str]]:
    """All other place vocab terms attached to this artwork, with their broader chain."""
    rows = conn.execute(
        """
        SELECT v.id, v.label_en, v.label_nl, f.name
        FROM mappings m
        JOIN artworks a ON a.art_id = m.artwork_id
        JOIN vocabulary v ON v.vocab_int_id = m.vocab_rowid
        JOIN field_lookup f ON f.id = m.field_id
        WHERE a.object_number = ?
          AND v.type = 'place'
          AND v.id != ?
        """,
        (object_number, exclude_vocab_id),
    ).fetchall()
    out = []
    for vid, en, nl, field in rows:
        chain_labels: list[str] = []
        cur = vid
        for _ in range(4):
            r = conn.execute(
                "SELECT broader_id, label_en, label_nl FROM vocabulary WHERE id = ?",
                (cur,),
            ).fetchone()
            if r is None:
                break
            br, e, n = r
            chain_labels.append(e or n or "∅")
            if not br or br == cur:
                break
            cur = br
        out.append((vid, en or nl or "∅", field, " → ".join(chain_labels)))
    return out


def main() -> int:
    conn = sqlite3.connect(str(DB))

    for vid, label, rijks_choice, recon_choice in PLACES:
        print(f"\n{'═' * 78}")
        print(f"  vocab_id={vid}  '{label}'")
        print(f"  Rijks identification    : {rijks_choice}")
        print(f"  Reconciled identification: {recon_choice}")
        print('═' * 78)

        arts = fetch_artworks(conn, vid)
        print(f"\n  {len(arts)} artwork(s) attached to this place\n")

        for i, a in enumerate(arts, 1):
            print(f"  ── Artwork {i}/{len(arts)}: {a['object_number']} "
                  f"[field={a['field']}]")
            print(f"     title : {a['title']!r}")
            print(f"     creator: {a['creator_label']!r}")
            date_str = a['date_display'] or (
                f"{a['date_earliest']}–{a['date_latest']}"
                if a['date_earliest'] else "(no date)"
            )
            print(f"     date  : {date_str}")
            desc = (a['description_text'] or '').strip()
            if desc:
                snip = desc[:300] + ("…" if len(desc) > 300 else "")
                print(f"     desc  : {snip}")
            narr = (a['narrative_text'] or '').strip()
            if narr:
                snip = narr[:200] + ("…" if len(narr) > 200 else "")
                print(f"     narr  : {snip}")
            others = fetch_other_places(conn, a['object_number'], vid)
            if others:
                print(f"     other places on same artwork:")
                for ovid, olabel, ofield, ochain in others:
                    print(f"        [{ofield:<18}] {olabel}  (chain: {ochain})")
            print()

    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
