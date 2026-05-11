// JS twin of scripts/provenance_enrichment_methods.py — single source of truth
// for the fine-axis provenance method literals across .mjs writebacks.
//
// Issue #268. Keep in lockstep with the Python sibling.

export const DETERMINISTIC = "deterministic";
export const INFERRED = "inferred";
export const MANUAL = "manual";

// parse_method
export const PEG = "peg";
export const REGEX_FALLBACK = "regex_fallback";
export const CROSS_REF = "cross_ref";
export const CREDIT_LINE = "credit_line";
export const LLM_STRUCTURAL = "llm_structural";

// category_method
export const TYPE_MAPPING = "type_mapping";
export const LLM_ENRICHMENT = "llm_enrichment";
export const RULE_TRANSFER_IS_OWNERSHIP = "rule:transfer_is_ownership";

// position_method
export const ROLE_MAPPING = "role_mapping";
export const LLM_DISAMBIGUATION = "llm_disambiguation";

// correction_method prefix (full value is e.g. "llm_structural:#214")
export const LLM_STRUCTURAL_PREFIX = "llm_structural:";

export const METHOD_TO_TIER = Object.freeze({
  [PEG]: DETERMINISTIC,
  [REGEX_FALLBACK]: INFERRED,
  [CROSS_REF]: DETERMINISTIC,
  [CREDIT_LINE]: DETERMINISTIC,
  [LLM_STRUCTURAL]: INFERRED,
  [TYPE_MAPPING]: DETERMINISTIC,
  [LLM_ENRICHMENT]: INFERRED,
  [RULE_TRANSFER_IS_OWNERSHIP]: DETERMINISTIC,
  [ROLE_MAPPING]: DETERMINISTIC,
  [LLM_DISAMBIGUATION]: INFERRED,
});

export function tierFor(method) {
  if (method == null) return null;
  if (typeof method === "string" && method.startsWith(LLM_STRUCTURAL_PREFIX)) {
    return INFERRED;
  }
  return METHOD_TO_TIER[method] ?? null;
}
