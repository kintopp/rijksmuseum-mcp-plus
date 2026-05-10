"""Enrichment method vocabulary for the vocabulary DB's provenance columns.

See issues #218 and #268 for the design rationale.

Two layers of granularity:
  - Coarse (imported into ``vocabulary.coord_method`` / ``external_id_method`` /
    ``broader_method``): deterministic | inferred | manual | NULL
  - Fine (CSV-only, archival in ``data/backfills/geocoded-places.csv``):
    specific phase identifier naming the exact code path that produced the row

The coarse tier vocabulary is shared across all three audit-trail systems (geo,
provenance, alt-labels) — see ``enrichment_tiers.py``. Module-level aliases
(AUTHORITY / DERIVED / HUMAN) preserve compatibility with in-flight call sites
that haven't been swapped yet; new code should import from ``enrichment_tiers``
directly.

Invariant: every detail value maps to exactly one coarse tier via DETAIL_TO_TIER.
Write-site code calls ``tier_for(detail)`` to derive the coarse tag — no
duplication, no drift between the two layers possible.
"""

from enrichment_tiers import DETERMINISTIC, INFERRED, MANUAL  # noqa: F401

# ── Coarse tiers (imported into vocabulary.*_method columns) ───────────
# Legacy aliases — kept so existing call sites (em.AUTHORITY etc.) keep
# producing the new canonical tier strings without an immediate sweep.
AUTHORITY = DETERMINISTIC
DERIVED = INFERRED
HUMAN = MANUAL


# ── Fine-grained detail values (CSV-only) ──────────────────────────────

# Authority tier — direct canonical lookup against a known external ID
GEONAMES_API = "geonames_api"
WIKIDATA_P625 = "wikidata_p625"
WIKIDATA_P159 = "wikidata_p159"
WIKIDATA_P131 = "wikidata_p131"
WIKIDATA_P276 = "wikidata_p276"
TGN_DIRECT = "tgn_direct"               # SPARQL endpoint (vocab.getty.edu/sparql)
TGN_RDF_DIRECT = "tgn_rdf_direct"       # per-entity RDF dereference (used while SPARQL was out 2026-05; resilient successor)
TGN_VIA_WIKIDATA = "tgn_via_wikidata_p1667"
TGN_VIA_REPLACEMENT = "tgn_via_replacement"  # one-shot: follow dc:isReplacedBy on obsolete TGN IDs
WOF_AUTHORITY = "wof_authority"
RCE_VIA_WIKIDATA = "rce_via_wikidata"
RIJKSMUSEUM_LOD = "rijksmuseum_lod"

# Derived tier — heuristic / inference
SELF_REF = "self_ref"
WIKIDATA_RECONCILIATION = "wikidata_reconciliation"
WHG_RECONCILIATION = "whg_reconciliation"
WHG_BRIDGE = "whg_bridge"
VALIDATION_HEMISPHERE_FIX = "validation_hemisphere_fix"
VALIDATION_SWAP_FIX = "validation_swap_fix"
PARENT_FALLBACK = "parent_fallback"
COUNTRY_FALLBACK = "country_fallback"
CITY_FALLBACK = "city_fallback"
PLEIADES_RECONCILIATION = "pleiades_reconciliation"

# Human tier — manual review
RECONCILED_REVIEW_ACCEPTED = "reconciled_review_accepted"
WHG_REVIEW_ACCEPTED = "whg_review_accepted"
WHG_BRIDGE_REVIEW_ACCEPTED = "whg_bridge_review_accepted"
WOF_REVIEW_ACCEPTED = "wof_review_accepted"
# Curator-supplied centroid for an entity TGN classified as areal (squares,
# capes, lakes, etc.) where a single point coord is acceptable for downstream
# rendering. Source is typically Wikidata P625 of the same entity.
MANUAL_CENTROID = "manual_centroid"


# ── Single source of truth: detail → coarse mapping ────────────────────
DETAIL_TO_TIER = {
    GEONAMES_API: AUTHORITY,
    WIKIDATA_P625: AUTHORITY,
    WIKIDATA_P159: AUTHORITY,
    WIKIDATA_P131: AUTHORITY,
    WIKIDATA_P276: AUTHORITY,
    TGN_DIRECT: AUTHORITY,
    TGN_RDF_DIRECT: AUTHORITY,
    TGN_VIA_WIKIDATA: AUTHORITY,
    TGN_VIA_REPLACEMENT: AUTHORITY,
    WOF_AUTHORITY: AUTHORITY,
    RCE_VIA_WIKIDATA: AUTHORITY,
    RIJKSMUSEUM_LOD: AUTHORITY,
    SELF_REF: DERIVED,
    WIKIDATA_RECONCILIATION: DERIVED,
    WHG_RECONCILIATION: DERIVED,
    WHG_BRIDGE: DERIVED,
    VALIDATION_HEMISPHERE_FIX: DERIVED,
    VALIDATION_SWAP_FIX: DERIVED,
    PARENT_FALLBACK: DERIVED,
    COUNTRY_FALLBACK: DERIVED,
    CITY_FALLBACK: DERIVED,
    PLEIADES_RECONCILIATION: DERIVED,
    RECONCILED_REVIEW_ACCEPTED: HUMAN,
    WHG_REVIEW_ACCEPTED: HUMAN,
    WHG_BRIDGE_REVIEW_ACCEPTED: HUMAN,
    WOF_REVIEW_ACCEPTED: HUMAN,
    MANUAL_CENTROID: HUMAN,
}


def tier_for(detail: str) -> str:
    """Resolve a detail value to its coarse tier.

    Raises KeyError if ``detail`` is unknown — by design: an unrecognised
    detail value is a bug (mis-spelling, removed constant, etc.) that should
    fail fast at the write site rather than silently land a NULL tier.
    """
    return DETAIL_TO_TIER[detail]


# ── Layer B (#262): fail-closed inheritance allow-list ─────────────────
# Locked URI set from offline/drafts/v0.25-schema-decisions.md §502-§522.
# When propagate_place_coordinates() considers inheriting from a parent
# place, the parent's placetype URI must be in this set or inheritance is
# refused. NULL placetypes are also refused (fail-closed on missing data).
INHERITANCE_ALLOWED_PLACETYPES: frozenset[str] = frozenset({
    "http://vocab.getty.edu/aat/300008347",  # inhabited places (umbrella)
    "http://vocab.getty.edu/aat/300008389",  # cities
    "http://vocab.getty.edu/aat/300008375",  # towns
    "http://vocab.getty.edu/aat/300008372",  # villages
    "http://vocab.getty.edu/aat/300008393",  # hamlets
    "http://vocab.getty.edu/aat/300008777",  # quarters / urban districts
    "http://vocab.getty.edu/aat/300008734",  # streets
    "http://www.wikidata.org/entity/Q486972",  # human settlement (umbrella)
    "http://www.wikidata.org/entity/Q515",      # city
    "http://www.wikidata.org/entity/Q532",      # village
    "http://www.wikidata.org/entity/Q3957",     # town
    "http://www.wikidata.org/entity/Q5084",     # hamlet
    "http://www.wikidata.org/entity/Q1549591",  # metropolis (e.g. Berlin)
    "http://www.wikidata.org/entity/Q123705",   # neighborhood
    "http://www.wikidata.org/entity/Q150093",   # neighborhood (variant)
    "http://www.wikidata.org/entity/Q188509",   # suburb
    "http://www.wikidata.org/entity/Q484170",   # commune of France
    "http://www.wikidata.org/entity/Q747074",   # comune of Italy
    "http://www.wikidata.org/entity/Q79007",    # street
})


def _inheritance_allowed(parent_placetype: str | None) -> bool:
    """Layer B guard: True iff parent placetype is on the locked allow-list.

    Fail-closed semantics: NULL/empty/unknown placetypes return False. New
    harmful parent placetypes that appear in future harvests are refused
    automatically until explicitly added to ``INHERITANCE_ALLOWED_PLACETYPES``.
    """
    if not parent_placetype:
        return False
    return parent_placetype in INHERITANCE_ALLOWED_PLACETYPES
