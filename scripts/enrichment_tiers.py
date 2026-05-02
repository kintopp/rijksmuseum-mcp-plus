"""Shared coarse trust-tier vocabulary across all enrichment audit trails.

Single source of truth for the three-bucket trust axis used by:

* Geo enrichment   (vocabulary.coord_method / broader_method)
* Provenance enrichment (provenance_periods.{parse,category,position,correction}_method)
* Org alt-labels   (entity_alt_names.tier)

Domain modules (enrichment_methods.py, provenance_enrichment_methods.py,
altname_methods.py) import these constants and tag their fine-axis literals
against them. Writebacks should never hard-code 'deterministic' / 'inferred' /
'manual' as string literals — always import.

See issue #268 for design rationale.
"""

DETERMINISTIC = "deterministic"
INFERRED = "inferred"
MANUAL = "manual"

VALID_TIERS = frozenset({DETERMINISTIC, INFERRED, MANUAL})


def assert_tier(tier: str) -> str:
    """Raise ValueError if ``tier`` is not one of the three canonical tiers."""
    if tier not in VALID_TIERS:
        raise ValueError(
            f"unknown tier: {tier!r}; expected one of {sorted(VALID_TIERS)}"
        )
    return tier
