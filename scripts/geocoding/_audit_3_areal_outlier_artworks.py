"""For the 3 wildly-mis-coorded areal places, pull the artworks attached
to each plus their titles, dates, creators, and co-tagged places. The
artwork context is the strongest signal for confirming which homonym
the Rijksmuseum actually meant.
"""
import sqlite3
from pathlib import Path

DB = Path(__file__).resolve().parents[2] / "data" / "vocabulary.db"

TARGETS = [
    ("23010302", "Lago d'Agnano",
     "broader: Napoli/Italy → Patagonia? (real: ~40.83, 14.18 near Naples)"),
    ("23022947", "Cana",
     "broader: Galilea/Israel → Tuscany? (real biblical Cana: ~32.82, 35.34)"),
    ("23029377", "Arriano",
     "broader: Lazio/Italy → Basque Country? (real Italian Arriano: ~42.4, 12.9)"),
]


def main():
    conn = sqlite3.connect(str(DB))
    for vid, label, headline in TARGETS:
        print(f"\n{'═'*78}\n  vocab_id={vid}  '{label}'\n  {headline}\n{'═'*78}")
        n_total = conn.execute("""
            SELECT COUNT(DISTINCT a.art_id) FROM mappings m
            JOIN artworks a ON a.art_id = m.artwork_id
            JOIN vocabulary v ON v.vocab_int_id = m.vocab_rowid
            WHERE v.id = ?""", (vid,)).fetchone()[0]
        print(f"  {n_total} artwork(s) attached")
        if n_total == 0:
            print("  (no attached artworks — orphan vocab entry)")
            continue
        arts = conn.execute("""
            SELECT a.object_number, a.title, a.creator_label,
                   a.date_display, a.date_earliest, a.description_text, f.name
            FROM mappings m
            JOIN artworks a ON a.art_id = m.artwork_id
            JOIN vocabulary v ON v.vocab_int_id = m.vocab_rowid
            JOIN field_lookup f ON f.id = m.field_id
            WHERE v.id = ?
            ORDER BY a.date_earliest, a.object_number
            LIMIT 12
        """, (vid,)).fetchall()
        for obj, title, creator, ddisp, dE, desc, field in arts:
            date = ddisp or (f"{dE}-..." if dE else "(no date)")
            print(f"  ── {obj} [{field}] {date}")
            print(f"      title: {title!r}")
            if creator and creator != 'anonymous':
                print(f"      creator: {creator!r}")
            if desc:
                snip = desc.strip()[:200].replace("\n", " ")
                print(f"      desc: {snip}{'…' if len(desc)>200 else ''}")
            co = conn.execute("""
                SELECT v.label_en, v.label_nl FROM mappings m
                JOIN artworks a ON a.art_id = m.artwork_id
                JOIN vocabulary v ON v.vocab_int_id = m.vocab_rowid
                WHERE a.object_number = ? AND v.type='place' AND v.id != ?
            """, (obj, vid)).fetchall()
            if co:
                names = sorted({en or nl or '∅' for en, nl in co})
                print(f"      co-places: {', '.join(names)}")


if __name__ == "__main__":
    main()
