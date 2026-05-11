"""Tier derivation for entity_alt_names rows (System 3 audit trail).

Replaces the legacy match_tier (0–5) + match_method + match_score columns with
a single tier column drawing from the shared three-tier vocabulary.

Derivation rule (locked per issue #268):

  exact match (match_tier == 0)            → deterministic
  fuzzy match, no review                   → inferred
  fuzzy match, reviewer-accepted           → manual

Reviewer review elevates a fuzzy candidate to manual; it does NOT promote an
exact match (the deterministic rule already covers that case).
"""

from lib.enrichment_tiers import DETERMINISTIC, INFERRED, MANUAL  # noqa: F401


def tier_for_row(*, exact: bool, reviewed_at: str | None) -> str:
    """Return the canonical tier for an entity_alt_names row.

    Args:
        exact: True if the candidate matched by string equality after
            deterministic normalisation (legacy match_tier == 0).
        reviewed_at: ISO timestamp if a human reviewer accepted the row,
            otherwise None.
    """
    if exact:
        return DETERMINISTIC
    if reviewed_at is not None:
        return MANUAL
    return INFERRED
