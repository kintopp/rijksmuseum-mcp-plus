"""Provenance-enrichment fine-axis literals + their tier mapping.

Centralises the eight+ method literals that flow into
provenance_periods.{parse_method, category_method, position_method,
correction_method}. Each literal is tagged with its coarse tier from
enrichment_tiers.

Runtime contract: src/registration.ts continues to read the fine literals from
the DB without consulting the coarse tier — this module is for write-side
discipline only. The Zod enum at registration.ts:~2842 must stay in sync with
the literals exposed here.

See issue #268.
"""

from enrichment_tiers import DETERMINISTIC, INFERRED, MANUAL  # noqa: F401

# ── parse_method literals ───────────────────────────────────────────────
PEG = "peg"
REGEX_FALLBACK = "regex_fallback"
CROSS_REF = "cross_ref"
CREDIT_LINE = "credit_line"
LLM_STRUCTURAL = "llm_structural"

# ── category_method literals ────────────────────────────────────────────
TYPE_MAPPING = "type_mapping"
LLM_ENRICHMENT = "llm_enrichment"
RULE_TRANSFER_IS_OWNERSHIP = "rule:transfer_is_ownership"

# ── position_method literals ────────────────────────────────────────────
ROLE_MAPPING = "role_mapping"
LLM_DISAMBIGUATION = "llm_disambiguation"
# LLM_ENRICHMENT and LLM_STRUCTURAL also appear as position_method values.

# ── correction_method literals ──────────────────────────────────────────
# Pattern is "llm_structural:#NNN" — no central enum, just a prefix.
LLM_STRUCTURAL_PREFIX = "llm_structural:"


METHOD_TO_TIER: dict[str, str] = {
    PEG: DETERMINISTIC,
    REGEX_FALLBACK: INFERRED,
    CROSS_REF: DETERMINISTIC,
    CREDIT_LINE: DETERMINISTIC,
    LLM_STRUCTURAL: INFERRED,
    TYPE_MAPPING: DETERMINISTIC,
    LLM_ENRICHMENT: INFERRED,
    RULE_TRANSFER_IS_OWNERSHIP: DETERMINISTIC,
    ROLE_MAPPING: DETERMINISTIC,
    LLM_DISAMBIGUATION: INFERRED,
}


def tier_for(method: str | None) -> str | None:
    """Resolve a fine-axis method literal to its coarse tier.

    Returns None if ``method`` is None. Returns INFERRED for the
    ``llm_structural:#NNN`` correction-method prefix variants. Returns None
    (rather than raising) for unrecognised literals — callers decide whether to
    treat that as a hard error.
    """
    if method is None:
        return None
    if method.startswith(LLM_STRUCTURAL_PREFIX):
        return INFERRED
    return METHOD_TO_TIER.get(method)


ALL_METHODS: frozenset[str] = frozenset(METHOD_TO_TIER)
