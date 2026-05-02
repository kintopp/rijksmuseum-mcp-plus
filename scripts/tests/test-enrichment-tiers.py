#!/usr/bin/env python3
"""Coverage test for the harmonised enrichment tier vocabulary.

Asserts that:

1. Every fine-axis detail value in enrichment_methods.DETAIL_TO_TIER maps to one
   of the three canonical tiers (deterministic / inferred / manual).
2. Every provenance method literal in
   provenance_enrichment_methods.METHOD_TO_TIER likewise maps cleanly.
3. The Python and JS twin modules agree on the canonical tier strings (so
   .mjs writebacks and Python writebacks can never drift).
4. altname_methods.tier_for_row honours the locked semantics from #268: exact
   matches stay deterministic regardless of reviewer review; only fuzzy
   candidates are elevated to manual.

See kintopp/rijksmuseum-mcp-plus-offline#268."""

from __future__ import annotations

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

from enrichment_tiers import DETERMINISTIC, INFERRED, MANUAL, VALID_TIERS, assert_tier
import enrichment_methods as em
import provenance_enrichment_methods as pem
import altname_methods as am


def test_canonical_tiers() -> None:
    assert DETERMINISTIC == "deterministic"
    assert INFERRED == "inferred"
    assert MANUAL == "manual"
    assert VALID_TIERS == frozenset({"deterministic", "inferred", "manual"})


def test_assert_tier_rejects_unknown() -> None:
    assert_tier("deterministic")
    assert_tier("inferred")
    assert_tier("manual")
    try:
        assert_tier("authority")  # legacy name, not canonical anymore
    except ValueError:
        pass
    else:
        raise AssertionError("assert_tier should have rejected 'authority'")


def test_em_aliases_track_canonical() -> None:
    assert em.AUTHORITY == DETERMINISTIC
    assert em.DERIVED == INFERRED
    assert em.HUMAN == MANUAL


def test_em_detail_to_tier_full_coverage() -> None:
    for detail, tier in em.DETAIL_TO_TIER.items():
        assert tier in VALID_TIERS, f"{detail!r} → {tier!r} not in {VALID_TIERS}"
        assert em.tier_for(detail) == tier


def test_pem_method_to_tier_full_coverage() -> None:
    for method, tier in pem.METHOD_TO_TIER.items():
        assert tier in VALID_TIERS, f"{method!r} → {tier!r} not in {VALID_TIERS}"
        assert pem.tier_for(method) == tier


def test_pem_llm_structural_prefix_is_inferred() -> None:
    assert pem.tier_for("llm_structural:#125") == INFERRED
    assert pem.tier_for("llm_structural:#87") == INFERRED


def test_pem_unknown_returns_none() -> None:
    assert pem.tier_for("not_a_real_method") is None
    assert pem.tier_for(None) is None


def test_altname_derivation_locked_semantics() -> None:
    # #268: exact stays deterministic regardless of review.
    assert am.tier_for_row(exact=True, reviewed_at=None) == DETERMINISTIC
    assert am.tier_for_row(exact=True, reviewed_at="2026-05-02") == DETERMINISTIC
    # Fuzzy promotes to manual only when reviewed.
    assert am.tier_for_row(exact=False, reviewed_at=None) == INFERRED
    assert am.tier_for_row(exact=False, reviewed_at="2026-05-02") == MANUAL


def test_js_twin_in_sync() -> None:
    """Static parse of the JS twin to confirm it exports the same tier strings.

    Catches the most likely drift mode: editing the Python module without
    updating the JS twin. Reads literal exports and compares against the
    Python METHOD_TO_TIER table. Doesn't run JS — that's CI's job.
    """
    js_path = ROOT / "scripts" / "provenance-enrichment-methods.mjs"
    src = js_path.read_text()

    # Pull "export const NAME = "value";" pairs.
    pairs = dict(re.findall(r'export const (\w+) = "([^"]+)"', src))

    # Tier constants must match.
    assert pairs.get("DETERMINISTIC") == DETERMINISTIC
    assert pairs.get("INFERRED") == INFERRED
    assert pairs.get("MANUAL") == MANUAL

    # Every Python method literal should appear in the JS file with the same value.
    expected = {
        "PEG": pem.PEG,
        "REGEX_FALLBACK": pem.REGEX_FALLBACK,
        "CROSS_REF": pem.CROSS_REF,
        "CREDIT_LINE": pem.CREDIT_LINE,
        "LLM_STRUCTURAL": pem.LLM_STRUCTURAL,
        "TYPE_MAPPING": pem.TYPE_MAPPING,
        "LLM_ENRICHMENT": pem.LLM_ENRICHMENT,
        "RULE_TRANSFER_IS_OWNERSHIP": pem.RULE_TRANSFER_IS_OWNERSHIP,
        "ROLE_MAPPING": pem.ROLE_MAPPING,
        "LLM_DISAMBIGUATION": pem.LLM_DISAMBIGUATION,
        "LLM_STRUCTURAL_PREFIX": pem.LLM_STRUCTURAL_PREFIX,
    }
    for name, py_value in expected.items():
        assert pairs.get(name) == py_value, (
            f"JS export {name}={pairs.get(name)!r} disagrees with Python "
            f"{name}={py_value!r}"
        )


def main() -> int:
    tests = [v for k, v in globals().items() if k.startswith("test_") and callable(v)]
    fails = 0
    for t in tests:
        try:
            t()
            print(f"PASS  {t.__name__}")
        except AssertionError as e:
            fails += 1
            print(f"FAIL  {t.__name__}: {e}")
    print()
    print(f"{len(tests) - fails}/{len(tests)} passed")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
