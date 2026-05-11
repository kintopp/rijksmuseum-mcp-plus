"""List all Rijksmuseum artworks attached to vocabulary entries whose label
contains 'Nicolaaskerk' or 'Nicholas Church', grouped by vocab entry.

Outputs Rijksmuseum collection URLs for each artwork.
"""
import sqlite3
import sys
from pathlib import Path

DB = Path(__file__).resolve().parents[2] / "data" / "vocabulary.db"
URL_BASE = "https://www.rijksmuseum.nl/en/collection/"


def chain(conn, vid, max_depth=4):
    out = []
    cur = vid
    for _ in range(max_depth):
        r = conn.execute("SELECT broader_id, label_en, label_nl FROM vocabulary WHERE id=?",
                         (cur,)).fetchone()
        if not r:
            break
        br, en, nl = r
        out.append(en or nl or "∅")
        if not br or br == cur:
            break
        cur = br
    return out


def main():
    conn = sqlite3.connect(str(DB))
    vocab_rows = conn.execute("""
        SELECT v.id, v.label_en, v.label_nl, v.lat, v.lon, v.vocab_int_id
        FROM vocabulary v
        WHERE v.type='place'
          AND (v.label_nl LIKE '%Nicolaaskerk%' OR v.label_en LIKE '%Nicolaaskerk%'
               OR v.label_nl LIKE '%Nicolas%kerk%' OR v.label_nl LIKE '%Nikolaas%kerk%'
               OR v.label_nl LIKE '%St%Nicolaas%' OR v.label_en LIKE '%St%Nicholas%')
        ORDER BY v.id
    """).fetchall()

    grand_total = 0
    for vid, en, nl, lat, lon, vint in vocab_rows:
        arts = conn.execute("""
            SELECT DISTINCT a.object_number, a.title, a.creator_label, a.date_display, a.date_earliest
            FROM mappings m
            JOIN artworks a ON a.art_id = m.artwork_id
            WHERE m.vocab_rowid = ?
            ORDER BY a.date_earliest, a.object_number
        """, (vint,)).fetchall()
        if not arts:
            continue
        broader = " → ".join(chain(conn, vid))
        coord = f"({lat}, {lon})" if lat is not None else "(no coord)"
        label = nl or en or "∅"
        print(f"\n━━━ vocab_id={vid}  '{label}'  {coord}")
        print(f"     broader: {broader}")
        print(f"     {len(arts)} artwork(s):")
        for obj, title, creator, date, _de in arts:
            url = URL_BASE + obj
            date_str = date or "(no date)"
            creator_str = f" — {creator}" if creator and creator != "anonymous" else ""
            print(f"        {url}")
            print(f"           {title!r}  ({date_str}){creator_str}")
        grand_total += len(arts)

    print(f"\n=== Total: {grand_total} artwork(s) across "
          f"{len([r for r in vocab_rows])} vocab entries ===")


if __name__ == "__main__":
    main()
