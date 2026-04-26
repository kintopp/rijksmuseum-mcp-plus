"""Enrichment method vocabulary for the vocabulary DB's provenance columns.

See issue #218 for the design rationale.

Two layers of granularity:
  - Coarse (imported into ``vocabulary.coord_method`` / ``external_id_method`` /
    ``broader_method``): authority | derived | human | NULL
  - Fine (CSV-only, archival in ``data/backfills/geocoded-places.csv``):
    specific phase identifier naming the exact code path that produced the row

Invariant: every detail value maps to exactly one coarse tier via DETAIL_TO_TIER.
Write-site code calls ``tier_for(detail)`` to derive the coarse tag — no
duplication, no drift between the two layers possible.
"""

# ── Coarse tiers (imported into vocabulary.*_method columns) ───────────
AUTHORITY = "authority"
DERIVED = "derived"
HUMAN = "human"


# ── Fine-grained detail values (CSV-only) ──────────────────────────────

# Authority tier — direct canonical lookup against a known external ID
GEONAMES_API = "geonames_api"
WIKIDATA_P625 = "wikidata_p625"
WIKIDATA_P159 = "wikidata_p159"
WIKIDATA_P131 = "wikidata_p131"
WIKIDATA_P276 = "wikidata_p276"
TGN_DIRECT = "tgn_direct"
TGN_VIA_WIKIDATA = "tgn_via_wikidata_p1667"
TGN_VIA_REPLACEMENT = "tgn_via_replacement"  # one-shot: follow dc:isReplacedBy on obsolete TGN IDs

# Derived tier — heuristic / inference
SELF_REF = "self_ref"
WIKIDATA_RECONCILIATION = "wikidata_reconciliation"
WHG_RECONCILIATION = "whg_reconciliation"
WHG_BRIDGE = "whg_bridge"
VALIDATION_HEMISPHERE_FIX = "validation_hemisphere_fix"
VALIDATION_SWAP_FIX = "validation_swap_fix"
PARENT_FALLBACK = "parent_fallback"

# Human tier — manual review
RECONCILED_REVIEW_ACCEPTED = "reconciled_review_accepted"
WHG_REVIEW_ACCEPTED = "whg_review_accepted"
WHG_BRIDGE_REVIEW_ACCEPTED = "whg_bridge_review_accepted"
WOF_REVIEW_ACCEPTED = "wof_review_accepted"


# ── Single source of truth: detail → coarse mapping ────────────────────
DETAIL_TO_TIER = {
    GEONAMES_API: AUTHORITY,
    WIKIDATA_P625: AUTHORITY,
    WIKIDATA_P159: AUTHORITY,
    WIKIDATA_P131: AUTHORITY,
    WIKIDATA_P276: AUTHORITY,
    TGN_DIRECT: AUTHORITY,
    TGN_VIA_WIKIDATA: AUTHORITY,
    TGN_VIA_REPLACEMENT: AUTHORITY,
    SELF_REF: DERIVED,
    WIKIDATA_RECONCILIATION: DERIVED,
    WHG_RECONCILIATION: DERIVED,
    WHG_BRIDGE: DERIVED,
    VALIDATION_HEMISPHERE_FIX: DERIVED,
    VALIDATION_SWAP_FIX: DERIVED,
    PARENT_FALLBACK: DERIVED,
    RECONCILED_REVIEW_ACCEPTED: HUMAN,
    WHG_REVIEW_ACCEPTED: HUMAN,
    WHG_BRIDGE_REVIEW_ACCEPTED: HUMAN,
    WOF_REVIEW_ACCEPTED: HUMAN,
}


def tier_for(detail: str) -> str:
    """Resolve a detail value to its coarse tier.

    Raises KeyError if ``detail`` is unknown — by design: an unrecognised
    detail value is a bug (mis-spelling, removed constant, etc.) that should
    fail fast at the write site rather than silently land a NULL tier.
    """
    return DETAIL_TO_TIER[detail]
