"""Pull full DB context for the 4 places lacking authority backing in VEI:
Kew, Sint-Nicolaaskerk, Haarlemmermeer, Boxburghshire.

For each: label, current coord, broader chain, attached artworks (titles +
co-tagged places). The artwork context is the strongest signal for
disambiguating common homonyms (e.g. there are several 'Kew's worldwide).
"""
import sqlite3
import sys
from pathlib import Path

DB = Path(__file__).resolve().parents[2] / "data" / "vocabulary.db"
TARGETS = ["130561", "130898", "2301118", "2304716"]


def chain(conn, vid):
    out = []
    cur = vid
    for _ in range(5):
        r = conn.execute("SELECT broader_id, label_en, label_nl FROM vocabulary WHERE id=?",
                         (cur,)).fetchone()
        if not r:
            break
        br, en, nl = r
        out.append(f"{cur} ({en or nl or '∅'})")
        if not br or br == cur:
            break
        cur = br
    return out


def main():
    conn = sqlite3.connect(str(DB))
    for vid in TARGETS:
        print(f"\n{'═'*78}\n  vocab_id = {vid}\n{'═'*78}")
        r = conn.execute(
            "SELECT label_en, label_nl, lat, lon, coord_method, coord_method_detail, "
            "external_id, placetype FROM vocabulary WHERE id=?", (vid,)).fetchone()
        if not r:
            print(f"  not found"); continue
        en, nl, lat, lon, cm, cmd, ext, pt = r
        print(f"  label_en : {en!r}")
        print(f"  label_nl : {nl!r}")
        print(f"  coord    : ({lat}, {lon})")
        print(f"  method   : {cm} / {cmd}")
        print(f"  external_id: {ext}")
        print(f"  placetype: {pt}")
        print(f"  broader  : {' → '.join(chain(conn, vid))}")
        # VEI rows
        veis = conn.execute(
            "SELECT authority, id, uri FROM vocabulary_external_ids "
            "WHERE vocab_id=?", (vid,)).fetchall()
        print(f"  VEI rows ({len(veis)}):")
        for a, lid, u in veis:
            print(f"      [{a}] {lid}  {u}")
        # Artworks
        arts = conn.execute("""
            SELECT a.object_number, a.title, a.creator_label, a.date_display,
                   a.date_earliest, a.date_latest, f.name AS field
            FROM mappings m
            JOIN artworks a ON a.art_id = m.artwork_id
            JOIN vocabulary v ON v.vocab_int_id = m.vocab_rowid
            JOIN field_lookup f ON f.id = m.field_id
            WHERE v.id = ?
            ORDER BY a.date_earliest, a.object_number
            LIMIT 12
        """, (vid,)).fetchall()
        n_total = conn.execute("""
            SELECT COUNT(DISTINCT a.art_id) FROM mappings m
            JOIN artworks a ON a.art_id = m.artwork_id
            JOIN vocabulary v ON v.vocab_int_id = m.vocab_rowid
            WHERE v.id = ?
        """, (vid,)).fetchone()[0]
        print(f"  artworks: {n_total} total, first {len(arts)} shown:")
        for obj, title, creator, ddisp, dE, dL, field in arts:
            date = ddisp or (f"{dE}-{dL}" if dE else "(no date)")
            print(f"      {obj} [{field}] {date}")
            print(f"        title : {title!r}")
            if creator and creator != 'anonymous':
                print(f"        creator: {creator!r}")
            # co-places
            co = conn.execute("""
                SELECT v.label_en, v.label_nl FROM mappings m
                JOIN artworks a ON a.art_id = m.artwork_id
                JOIN vocabulary v ON v.vocab_int_id = m.vocab_rowid
                WHERE a.object_number = ? AND v.type='place' AND v.id != ?
            """, (obj, vid)).fetchall()
            if co:
                names = sorted({en or nl or '∅' for en, nl in co})
                print(f"        co-places: {', '.join(names[:6])}")
    conn.close()


if __name__ == "__main__":
    main()
