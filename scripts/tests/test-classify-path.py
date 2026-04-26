#!/usr/bin/env python3
"""Unit test for the context-aware classifier fix in discover-linked-art-schema.py.
See kintopp/rijksmuseum-mcp-plus-offline#275."""
import importlib.util
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "dlas", ROOT / "scripts" / "discover-linked-art-schema.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
classify = mod.classify_path

# Each tuple: (path, expected_verdict, regression-context-string)
CASES = [
    # The bug fix: motivated_by[] context paths must now be IGNORED, not scaffolding.
    ("produced_by.part[].assigned_by[].motivated_by[].classified_as",
     "ignored", "S5 evidence-type container"),
    ("produced_by.part[].assigned_by[].motivated_by[].classified_as[]",
     "ignored", "S5 evidence-type entries"),
    ("produced_by.part[].assigned_by[].motivated_by[].carried_by",
     "ignored", "S5 bibliography branch (still IGNORED, defer to SRU)"),
    ("produced_by.part[].assigned_by[].motivated_by[].referred_to_by",
     "ignored", "S5 referred-to-by branch"),

    # S4 / S2 ancestor paths — now 'structural' (traversed to reach extracted leaves)
    # after HARVEST_EXTRACTED_PATHS was updated 2026-04-26 to include v0.24 extractors.
    # Pre-2026-04-26 these would have been 'ignored'; the reframing makes them
    # ancestors of extracted paths.
    ("modified_by[].carried_out_by",
     "structural", "ancestor of modified_by[].carried_out_by[].id"),
    ("modified_by[].referred_to_by",
     "structural", "ancestor of modified_by[].referred_to_by[].content"),
    ("attributed_by[].assigned",
     "structural", "ancestor of attributed_by[].assigned[].id"),
    ("attributed_by[].identified_by",
     "structural", "ancestor of attributed_by[].identified_by[].content"),

    # Regression — JSON-LD scaffolding still scaffolding.
    ("produced_by.part[].assigned_by[].motivated_by[].id",
     "scaffolding", "id is JSON-LD scaffolding regardless of context"),
    ("produced_by.part[].assigned_by[].motivated_by[].type",
     "scaffolding", "type is JSON-LD scaffolding regardless of context"),
    ("produced_by.part[].assigned_by[].motivated_by[]._label",
     "scaffolding", "_label is JSON-LD scaffolding regardless of context"),

    # Regression — non-evidence deep-segment paths still scaffolding.
    ("referred_to_by[].language[].identified_by",
     "scaffolding", "language entity internals (depth-3 entity-internal)"),
    ("referred_to_by[].classified_as[].identified_by",
     "scaffolding", "classification-of-classification (2-occurrence)"),
    ("identified_by[].classified_as[]._label",
     "scaffolding", "Phase1 prefix — already harvested"),

    # Regression — extracted paths still extracted.
    ("referred_to_by[].content",
     "extracted", "harvested text content"),
    ("produced_by.part[].carried_out_by[].id",
     "extracted", "harvested creator URI"),

    # Regression — produced_by.part[].assigned_by[].classified_as[].id is
    # already in HARVEST_EXTRACTED_PATHS, must remain extracted.
    ("produced_by.part[].assigned_by[].classified_as[].id",
     "extracted", "harvested rich qualifier"),

    # Regression — v0.24 extractor paths added 2026-04-26 must be extracted.
    ("modified_by[].carried_out_by[].id",
     "extracted", "modifications table — restorer URI"),
    ("modified_by[].timespan.begin_of_the_begin",
     "extracted", "modifications table — treatment date start"),
    ("modified_by[].referred_to_by[].content",
     "extracted", "modifications table — treatment description"),
    ("attributed_by[].assigned[].id",
     "extracted", "related_objects table — peer URI"),
    ("attributed_by[].carried_out_by[].id",
     "extracted", "examinations table — examiner URI"),
    ("attributed_by[].classified_as[].id",
     "extracted", "examinations table — report type AAT"),
    ("part_of[].id",
     "extracted", "artwork_parent table — parent URI"),
    ("dimension[].referred_to_by[].content",
     "extracted", "dimension_note column — annotation text"),

    # Regression — paths that are *structural ancestors* of v0.24 extractors
    # must classify as 'structural', not 'ignored'.
    ("modified_by",
     "structural", "ancestor of modified_by[]"),
    ("attributed_by",
     "structural", "ancestor of attributed_by[]"),
    ("part_of",
     "structural", "ancestor of part_of[]"),

    # Regression — top-level produced_by.assigned_by[] is the #43 fix.
    # Added to HARVEST_EXTRACTED_PATHS 2026-04-26 after the first audit run
    # showed all 66 sub-paths as IGNORED despite the harvest extractor
    # already covering them.
    ("produced_by.assigned_by[].assigned[].id",
     "extracted", "#43 fix — top-level production attribution"),
    ("produced_by.assigned_by[].classified_as[].id",
     "extracted", "#43 fix — top-level qualifier"),
    ("produced_by.assigned_by",
     "structural", "ancestor of produced_by.assigned_by[]"),

    # Regression — `notation` as multilingual-label container on inline
    # entities is scaffolding (added 2026-04-26 after the 10K audit revealed
    # ~13 false-positive notation paths in IGNORED).
    ("dimension[].classified_as[].notation",
     "scaffolding", "Rijksmuseum multilingual label container"),
    ("dimension[].classified_as[].notation[]",
     "scaffolding", "multilingual label container array elements"),
    ("produced_by.part[].technique[].notation",
     "scaffolding", "multilingual label on technique entity"),
    ("produced_by.part[].carried_out_by[].notation",
     "scaffolding", "multilingual label on creator entity"),
    ("classified_as[].notation",
     "scaffolding", "multilingual label on top-level type"),
    ("made_of[].notation",
     "scaffolding", "multilingual label on material entity"),
    # @language and @value leaves
    ("classified_as[].notation[].@language",
     "scaffolding", "JSON-LD language tag"),
    ("classified_as[].notation[].@value",
     "scaffolding", "JSON-LD value carrier"),
]

failures = []
for path, expected, why in CASES:
    got = classify(path)
    if got != expected:
        failures.append((path, expected, got, why))
        print(f"  FAIL  {path}")
        print(f"        expected={expected}  got={got}  ({why})")
    else:
        print(f"  ok    {path}  → {got}")

print()
if failures:
    print(f"{len(failures)} of {len(CASES)} cases FAILED")
    sys.exit(1)
else:
    print(f"all {len(CASES)} cases passed")
