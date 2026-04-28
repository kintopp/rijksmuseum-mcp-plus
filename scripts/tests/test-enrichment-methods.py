"""Unit tests for scripts/enrichment_methods.py invariants.

Run: ~/miniconda3/envs/embeddings/bin/python scripts/tests/test-enrichment-methods.py
"""
from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

import enrichment_methods as em


def _names_of_string_constants(module) -> set[str]:
    """All module-level CONSTANT_NAME = "value" pairs whose value is a str."""
    return {
        name for name in dir(module)
        if name.isupper() and not name.startswith("_")
        and isinstance(getattr(module, name), str)
        and name not in ("AUTHORITY", "DERIVED", "HUMAN")
    }


def test_tier_for_resolves_every_detail() -> None:
    for detail, expected_tier in em.DETAIL_TO_TIER.items():
        assert em.tier_for(detail) == expected_tier, (detail, expected_tier)


def test_tier_for_unknown_raises() -> None:
    try:
        em.tier_for("not_a_real_detail")
    except KeyError:
        return
    raise AssertionError("tier_for(unknown) must raise KeyError")


def test_detail_to_tier_exhaustive_over_module_constants() -> None:
    declared = _names_of_string_constants(em)
    mapped_values = set(em.DETAIL_TO_TIER.keys())
    declared_values = {getattr(em, name) for name in declared}
    missing = declared_values - mapped_values
    assert not missing, f"Constants declared but not in DETAIL_TO_TIER: {missing}"


def test_v025_required_constants_present() -> None:
    required = ["WOF_AUTHORITY", "RCE_VIA_WIKIDATA", "PLEIADES_RECONCILIATION",
                "COUNTRY_FALLBACK", "CITY_FALLBACK"]
    for name in required:
        assert hasattr(em, name), f"missing v0.25 constant: {name}"
    assert em.tier_for(em.WOF_AUTHORITY) == em.AUTHORITY
    assert em.tier_for(em.RCE_VIA_WIKIDATA) == em.AUTHORITY
    assert em.tier_for(em.PLEIADES_RECONCILIATION) == em.DERIVED
    assert em.tier_for(em.COUNTRY_FALLBACK) == em.DERIVED
    assert em.tier_for(em.CITY_FALLBACK) == em.DERIVED


def test_inheritance_allow_list_smoke() -> None:
    # On the allow-list (decisions doc §502)
    assert em._inheritance_allowed("http://vocab.getty.edu/aat/300008347") is True
    assert em._inheritance_allowed("http://www.wikidata.org/entity/Q515") is True
    assert em._inheritance_allowed("http://www.wikidata.org/entity/Q484170") is True
    # Explicitly omitted (decisions doc §524 — physical features)
    assert em._inheritance_allowed("http://vocab.getty.edu/aat/300008761") is False  # valleys
    assert em._inheritance_allowed("http://vocab.getty.edu/aat/300008707") is False  # rivers
    # Fail-closed cases
    assert em._inheritance_allowed(None) is False
    assert em._inheritance_allowed("") is False
    assert em._inheritance_allowed("http://vocab.getty.edu/aat/9999999") is False


def test_allow_list_size_matches_locked_19() -> None:
    assert len(em.INHERITANCE_ALLOWED_PLACETYPES) == 19


def main() -> int:
    tests = [v for k, v in globals().items() if k.startswith("test_") and callable(v)]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"  PASS  {t.__name__}")
        except AssertionError as e:
            print(f"  FAIL  {t.__name__}: {e}")
            failed += 1
    print(f"\n{len(tests) - failed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
