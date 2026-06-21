"""bibliography_extract.py — shared pure module for extracting artwork citations.

Imported by:
  - scripts/harvest-vocabulary-db.py  (harvest fold-in, Step 1c)
  - scripts/backfill-bibliography.py  (standalone subset backfill)

No DB or HTTP at import time. Publication resolution is the caller's
responsibility: each caller fetches the publication record and passes the
resolved dict to ``compose_citation`` — so the module stays unit-testable and
caller-agnostic.

AAT URIs used:
  300311954 — bibliography/citation entry
  300456575 — sequence number
  300311705 — citation string / page locus
"""

AAT_CITATION = "http://vocab.getty.edu/aat/300311954"
AAT_SEQUENCE = "http://vocab.getty.edu/aat/300456575"
AAT_CITATION_TEXT = "http://vocab.getty.edu/aat/300311705"
BIBFRAME_INSTANCE = "http://id.loc.gov/ontologies/bibframe/Instance"


def _has_classification(classified_as, aat_uri: str) -> bool:
    """Return True if any item in classified_as matches aat_uri."""
    if not classified_as:
        return False
    for cls in classified_as:
        cid = cls.get("id", "") if isinstance(cls, dict) else (cls if isinstance(cls, str) else "")
        if cid == aat_uri:
            return True
    return False


def _extract_content(content) -> str | None:
    """Extract a string from a content field (may be a list or a string)."""
    if content is None:
        return None
    if isinstance(content, list):
        parts = [s for s in content if isinstance(s, str) and s]
        return " ".join(parts) if parts else None
    if isinstance(content, str):
        return content or None
    return None


def _first_text(value) -> str | None:
    """Coerce a Schema.org field that may be a string or a list-of-strings to a
    single string (the first non-empty element). Schema.org/Linked Art records
    return some fields (e.g. isPartOf.name with multiple title spellings) as a
    list; take the first variant rather than joining near-duplicates. Returns
    None for empty/missing/non-text values.
    """
    if isinstance(value, list):
        for item in value:
            if isinstance(item, str) and item:
                return item
        return None
    if isinstance(value, str):
        return value or None
    return None


def extract_citations(data: dict) -> list[dict]:
    """Parse the OBJECT-level assigned_by[] for bibliography/citation entries.

    Returns a list of raw dicts with keys:
      seq (int|None), ctype ('A'|'B'|'C'), inline_text (str|None),
      publication_id (int|None), pages (str|None).

    Pure function — no HTTP, no DB. Each caller resolves publication_id URIs
    separately via a dependency-injected resolver + run-scoped dedup cache.
    """
    assigned_by = data.get("assigned_by", [])
    if not isinstance(assigned_by, list):
        return []

    results: list[dict] = []
    for entry in assigned_by:
        if not isinstance(entry, dict):
            continue
        if not _has_classification(entry.get("classified_as"), AAT_CITATION):
            continue

        # Sequence number: identified_by classified as AAT 300456575
        seq = None
        for ident in entry.get("identified_by", []) or []:
            if not isinstance(ident, dict):
                continue
            if _has_classification(ident.get("classified_as"), AAT_SEQUENCE):
                raw_seq = _extract_content(ident.get("content"))
                if raw_seq is not None:
                    try:
                        seq = int(raw_seq)
                    except (ValueError, TypeError):
                        seq = None
                break

        # assigned[0] is the core element
        assigned_list = entry.get("assigned") or []
        assigned = assigned_list[0] if assigned_list else None

        if not assigned:
            # No assigned element — Type B with empty inline text
            results.append({
                "seq": seq,
                "ctype": "B",
                "inline_text": "",
                "publication_id": None,
                "pages": None,
            })
            continue

        # Find the identified_by entry classified as AAT_CITATION_TEXT (300311705)
        cit_id_entry = None
        for ident in assigned.get("identified_by", []) or []:
            if not isinstance(ident, dict):
                continue
            if _has_classification(ident.get("classified_as"), AAT_CITATION_TEXT):
                cit_id_entry = ident
                break

        # Type A: has part_of[0].id (publication URI reference)
        part_of = assigned.get("part_of") or []
        if part_of and isinstance(part_of, list) and isinstance(part_of[0], dict):
            pub_uri = part_of[0].get("id", "")
            if pub_uri:
                # Extract the trailing path segment as publication_id (INTEGER)
                segment = pub_uri.rstrip("/").rsplit("/", 1)[-1]
                pub_id: int | None = None
                if segment.isdigit():
                    pub_id = int(segment)
                else:
                    # Non-numeric segment — keep entry as degraded row, no publication link
                    pub_id = None

                # Pages for Type A: cit_id_entry's part[0].content (per-artwork page locus)
                pages: str | None = None
                if cit_id_entry is not None:
                    parts_list = cit_id_entry.get("part") or []
                    if parts_list and isinstance(parts_list[0], dict):
                        pages = _extract_content(parts_list[0].get("content"))

                results.append({
                    "seq": seq,
                    "ctype": "A",
                    "inline_text": None,
                    "publication_id": pub_id,
                    "pages": pages,
                })
                continue

        # Type C: BIBFRAME Instance with bare id
        if (assigned.get("type") == BIBFRAME_INSTANCE and assigned.get("id")):
            uri = assigned["id"]
            segment = uri.rstrip("/").rsplit("/", 1)[-1]
            pub_id = int(segment) if segment.isdigit() else None
            results.append({
                "seq": seq,
                "ctype": "C",
                "inline_text": None,
                "publication_id": pub_id,
                "pages": None,
            })
            continue

        # Type B: inline citation string (with part[0].content fallback)
        inline_text = None
        if cit_id_entry is not None:
            inline_text = _extract_content(cit_id_entry.get("content"))
            if inline_text is None:
                parts_list = cit_id_entry.get("part") or []
                if parts_list and isinstance(parts_list[0], dict):
                    inline_text = _extract_content(parts_list[0].get("content"))

        results.append({
            "seq": seq,
            "ctype": "B",
            "inline_text": inline_text or "",
            "publication_id": None,
            "pages": None,  # Type B pages: None — NOT the inline string (avoids double-print)
        })

    return results


def compose_citation(raw: dict, pub: dict | None) -> dict:
    """Compose a final citation row from a raw extracted dict and an optional resolved publication.

    ``pub`` should be a Schema.org record with current field shape:
      creditText, name, isPartOf (dict with 'name'), pagination, sameAs, url, isbn.

    Returns a dict with keys:
      seq, citation_text, publication_id, pages, isbn, worldcat_uri, library_url.
    """
    ctype = raw["ctype"]
    publication_id = raw.get("publication_id")
    pages = raw.get("pages")

    if ctype == "B":
        # Inline string — no publication resolution needed
        citation_text = raw.get("inline_text") or ""
        return {
            "seq": raw.get("seq"),
            "citation_text": citation_text,
            "publication_id": None,
            "pages": None,
            "isbn": None,
            "worldcat_uri": None,
            "library_url": None,
        }

    # Types A and C — prefer resolved publication
    if pub is not None:
        # Compose against verified current Schema.org shape (NOT the stale OLD formatter
        # which used pub.publication[0].location.name + pub.publication[0].startDate —
        # those fields don't exist on today's records).
        # Schema.org fields may be strings OR lists (Linked Art array quirk);
        # _first_text coerces each to a single string so the join below can't
        # raise TypeError. isPartOf itself is occasionally a list of dicts.
        is_part_of = pub.get("isPartOf")
        if isinstance(is_part_of, list):
            is_part_of = next((x for x in is_part_of if isinstance(x, dict)), None)
        is_part_of_name = _first_text(is_part_of.get("name")) if isinstance(is_part_of, dict) else None

        parts = [
            _first_text(pub.get("creditText")),
            _first_text(pub.get("name")),
            is_part_of_name,
            _first_text(pub.get("pagination")),
            pages,  # artwork-specific page locus (Type A) or None (Type C)
        ]
        citation_text = ", ".join(p for p in parts if p)
        if not citation_text:
            citation_text = f"(publication {publication_id})"

        # isbn: flatten array to scalar string (column is TEXT, schema is nullable string)
        raw_isbn = pub.get("isbn")
        if isinstance(raw_isbn, list):
            isbn = "; ".join(str(i) for i in raw_isbn if i) or None
        elif raw_isbn:
            isbn = str(raw_isbn)
        else:
            isbn = None

        return {
            "seq": raw.get("seq"),
            "citation_text": citation_text,
            "publication_id": publication_id,
            "pages": pages,
            "isbn": isbn,
            "worldcat_uri": _first_text(pub.get("sameAs")),
            "library_url": _first_text(pub.get("url")),
        }
    else:
        # Resolution failed or not attempted — fallback, never empty (NOT NULL column)
        fallback = f"(publication {publication_id})"
        if pages:
            fallback += f", {pages}"
        return {
            "seq": raw.get("seq"),
            "citation_text": fallback,
            "publication_id": publication_id,
            "pages": pages,
            "isbn": None,
            "worldcat_uri": None,
            "library_url": None,
        }


# ─── Persistence shape ────────────────────────────────────────────────
# The artwork_citations column order has ONE owner here so the harvest and
# backfill writers can't drift. compose_citation() produces the 7 row fields;
# art_id is supplied by the caller at write time.
CITATION_COLUMNS = (
    "art_id", "seq", "citation_text", "publication_id",
    "pages", "isbn", "worldcat_uri", "library_url",
)
CITATION_INSERT_SQL = (
    "INSERT INTO artwork_citations (" + ", ".join(CITATION_COLUMNS) + ") "
    "VALUES (" + ", ".join(["?"] * len(CITATION_COLUMNS)) + ")"
)


def citation_rows(art_id: int, composed: list[dict]) -> list[tuple]:
    """Build executemany() tuples for artwork_citations from composed rows."""
    return [
        (art_id, r["seq"], r["citation_text"], r["publication_id"],
         r["pages"], r["isbn"], r["worldcat_uri"], r["library_url"])
        for r in composed
    ]
