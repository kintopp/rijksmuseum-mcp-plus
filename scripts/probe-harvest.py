#!/usr/bin/env python3
"""
Harvest probe: dry-run shape & data-drift analysis.

Samples artworks from the existing vocab DB, resolves them live via Linked Art,
and reports shape anomalies + data drift — without writing anything.

Usage:
    python3 scripts/probe-harvest.py                  # 500 samples, 8 threads
    python3 scripts/probe-harvest.py --samples 2000   # more samples
    python3 scripts/probe-harvest.py --threads 16     # more parallelism
"""

import argparse
import json
import random
import sqlite3
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from textwrap import indent

# ─── Configuration ───────────────────────────────────────────────────

PROJECT_DIR = Path(__file__).parent.parent
DB_PATH = PROJECT_DIR / "data" / "vocabulary.db"
SEARCH_API = "https://data.rijksmuseum.nl/search/collection"
OAI_BASE = "https://data.rijksmuseum.nl/oai"
USER_AGENT = "rijksmuseum-mcp-probe/1.0"

# AAT URIs (matching harvest script)
AAT_INSCRIPTIONS = "http://vocab.getty.edu/aat/300435414"
AAT_PROVENANCE = "http://vocab.getty.edu/aat/300444174"
AAT_CREDIT_LINE = "http://vocab.getty.edu/aat/300026687"
AAT_DESCRIPTION = "http://vocab.getty.edu/aat/300435452"
AAT_NARRATIVE = "http://vocab.getty.edu/aat/300048722"
AAT_PRODUCTION_STATEMENT = "http://vocab.getty.edu/aat/300435416"
AAT_HEIGHT = "http://vocab.getty.edu/aat/300055644"
AAT_WIDTH = "http://vocab.getty.edu/aat/300055647"
RM_HEIGHT = "https://id.rijksmuseum.nl/22011"
RM_WIDTH = "https://id.rijksmuseum.nl/22012"
HEIGHT_URIS = {AAT_HEIGHT, RM_HEIGHT}
WIDTH_URIS = {AAT_WIDTH, RM_WIDTH}

# ─── Expected shapes ────────────────────────────────────────────────
# Maps JSON path → set of expected Python types.
# Every field touched by the harvest (Phase 4) or TypeScript (query-time) is covered.
# "str_or_dict" entries in classified_as/language are tracked separately.

EXPECTED_SHAPES = {
    # Top-level
    "produced_by":                             {"dict", "NoneType"},
    "referred_to_by":                          {"list", "NoneType"},
    "identified_by":                           {"list", "NoneType"},
    "dimension":                               {"list", "NoneType"},
    "subject_of":                              {"list", "NoneType"},
    "equivalent":                              {"list", "NoneType"},
    "made_of":                                 {"list", "NoneType"},

    # produced_by children
    "produced_by.timespan":                    {"dict", "list", "NoneType"},  # list = multi-phase (bac40d1)
    "produced_by.referred_to_by":              {"list", "NoneType"},
    "produced_by.part":                        {"list", "NoneType"},

    # produced_by.part[] children (extract_production_parts)
    "produced_by.part[].technique":            {"list", "NoneType"},
    "produced_by.part[].classified_as":        {"list", "NoneType"},
    "produced_by.part[].carried_out_by":       {"list", "NoneType"},
    "produced_by.part[].assigned_by":          {"list", "NoneType"},

    # produced_by.part[].assigned_by[] children (AttributeAssignment — #43)
    "assigned_by[].assigned":                  {"list", "NoneType"},
    "assigned_by[].classified_as":             {"list", "NoneType"},
    "assigned_by[].assigned_property":         {"str", "NoneType"},

    # assigned[].formed_by (inline Group pattern)
    "assigned[].formed_by":                    {"dict", "NoneType"},
    "formed_by.influenced_by":                 {"list", "NoneType"},

    # identified_by[] children (titles, identifiers)
    "identified_by[].content":                 {"str", "list", "NoneType"},  # list known (3ac2093)
    "identified_by[].classified_as":           {"list", "NoneType"},
    "identified_by[].language":                {"list", "NoneType"},

    # referred_to_by[] children (statements: inscriptions, descriptions, etc.)
    "referred_to_by[].content":                {"str", "list", "NoneType"},  # list known (3ac2093)
    "referred_to_by[].language":               {"list", "NoneType"},
    "referred_to_by[].classified_as":          {"list", "NoneType"},

    # produced_by.referred_to_by[] children (creator label)
    "prod_ref[].content":                      {"str", "list", "NoneType"},
    "prod_ref[].language":                     {"list", "NoneType"},
    "prod_ref[].classified_as":                {"list", "NoneType"},

    # dimension[] children
    "dimension[].value":                       {"int", "float", "str", "NoneType"},
    "dimension[].classified_as":               {"list", "NoneType"},
    "dimension[].unit":                        {"dict", "str", "NoneType"},

    # subject_of[] children (narrative)
    "subject_of[].language":                   {"list", "NoneType"},
    "subject_of[].part":                       {"list", "NoneType"},

    # subject_of[].part[] children
    "subject_of_part[].classified_as":         {"list", "NoneType"},
    "subject_of_part[].content":               {"str", "list", "NoneType"},

    # timespan children (when dict)
    "timespan.begin_of_the_begin":             {"str", "NoneType"},
    "timespan.end_of_the_end":                 {"str", "NoneType"},
    "timespan.identified_by":                  {"list", "NoneType"},

    # equivalent[] children (Phase 2: Wikidata links)
    "equivalent[].id":                         {"str", "NoneType"},

    # place-specific
    "defined_by":                              {"str", "NoneType"},
}


# ─── Resolve & probe ────────────────────────────────────────────────

def lookup_uri(object_number: str) -> str | None:
    """Look up Linked Art URI for an object number via the Search API."""
    url = f"{SEARCH_API}?objectNumber={urllib.parse.quote(object_number)}"
    req = urllib.request.Request(url, headers={
        "Accept": "application/ld+json",
        "User-Agent": USER_AGENT,
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read())
        items = data.get("orderedItems", [])
        if items:
            return items[0].get("id")
    except Exception:
        pass
    return None


def resolve_artwork(uri: str) -> dict | None:
    """Fetch Linked Art JSON-LD for one artwork."""
    req = urllib.request.Request(uri, headers={
        "Accept": "application/ld+json",
        "Profile": "https://linked.art/ns/v1/linked-art.json",
        "User-Agent": USER_AGENT,
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return {"_status": "not_found"}
        return {"_status": f"http_{e.code}"}
    except Exception as e:
        return {"_status": f"error: {e}"}


def type_name(val) -> str:
    if val is None:
        return "NoneType"
    return type(val).__name__


def probe_shapes(data: dict, shape_counts: Counter) -> list[dict]:
    """Check all expected field shapes and track distributions. Return anomalies."""
    anomalies = []

    def check(path: str, val):
        tn = type_name(val)
        shape_counts[f"{path}:{tn}"] += 1
        expected = EXPECTED_SHAPES.get(path)
        if expected and tn not in expected:
            anomalies.append({
                "path": path,
                "expected": sorted(expected),
                "actual": tn,
                "sample": repr(val)[:200],
            })

    def check_classified_as_entries(path: str, classified_as):
        """Track whether classified_as entries are dicts or bare strings."""
        if not isinstance(classified_as, list):
            return
        for c in classified_as:
            shape_counts[f"{path}_entry:{type_name(c)}"] += 1

    def check_language_entries(path: str, language):
        """Track whether language entries are dicts or bare strings."""
        if not isinstance(language, list):
            return
        for l in language:
            shape_counts[f"{path}_entry:{type_name(l)}"] += 1

    # ── Top-level fields ──
    check("produced_by", data.get("produced_by"))
    for field in ("referred_to_by", "identified_by", "dimension", "subject_of", "equivalent", "made_of"):
        check(field, data.get(field))

    # ── produced_by internals ──
    produced_by = data.get("produced_by")
    if isinstance(produced_by, dict):
        timespan = produced_by.get("timespan")
        check("produced_by.timespan", timespan)
        check("produced_by.referred_to_by", produced_by.get("referred_to_by"))
        check("produced_by.part", produced_by.get("part"))

        # Timespan children (when dict — or first element when list)
        ts = timespan[0] if isinstance(timespan, list) and timespan else timespan
        if isinstance(ts, dict):
            check("timespan.begin_of_the_begin", ts.get("begin_of_the_begin"))
            check("timespan.end_of_the_end", ts.get("end_of_the_end"))
            check("timespan.identified_by", ts.get("identified_by"))

        # produced_by.referred_to_by[] (creator label extraction)
        for ref in (produced_by.get("referred_to_by") or []):
            if not isinstance(ref, dict):
                shape_counts["prod_ref[]:non_dict"] += 1
                continue
            check("prod_ref[].content", ref.get("content"))
            check("prod_ref[].language", ref.get("language"))
            check("prod_ref[].classified_as", ref.get("classified_as"))
            check_classified_as_entries("prod_ref[].classified_as", ref.get("classified_as"))
            check_language_entries("prod_ref[].language", ref.get("language"))

        # produced_by.part[] (production roles, qualifiers, creators)
        parts = produced_by.get("part", [])
        if not isinstance(parts, list):
            parts = [produced_by]  # mirrors harvest fallback
        for part in parts:
            if not isinstance(part, dict):
                shape_counts["produced_by.part[]:non_dict"] += 1
                continue
            check("produced_by.part[].technique", part.get("technique"))
            check("produced_by.part[].classified_as", part.get("classified_as"))
            check("produced_by.part[].carried_out_by", part.get("carried_out_by"))
            check("produced_by.part[].assigned_by", part.get("assigned_by"))
            check_classified_as_entries("part.classified_as", part.get("classified_as"))

            # assigned_by[] (AttributeAssignment — #43)
            for assignment in (part.get("assigned_by") or []):
                if not isinstance(assignment, dict):
                    shape_counts["assigned_by[]:non_dict"] += 1
                    continue
                check("assigned_by[].assigned", assignment.get("assigned"))
                check("assigned_by[].classified_as", assignment.get("classified_as"))
                check("assigned_by[].assigned_property", assignment.get("assigned_property"))
                check_classified_as_entries("assigned_by.classified_as", assignment.get("classified_as"))

                # assigned[] items (creators — direct person or inline Group)
                for item in (assignment.get("assigned") or []):
                    if not isinstance(item, dict):
                        shape_counts["assigned[]:non_dict"] += 1
                        continue
                    if item.get("type") == "Group":
                        formed_by = item.get("formed_by")
                        check("assigned[].formed_by", formed_by)
                        if isinstance(formed_by, dict):
                            check("formed_by.influenced_by", formed_by.get("influenced_by"))

    # ── identified_by[] (titles, identifiers) ──
    for entry in (data.get("identified_by") or []):
        if not isinstance(entry, dict):
            shape_counts["identified_by[]:non_dict"] += 1
            continue
        check("identified_by[].content", entry.get("content"))
        check("identified_by[].classified_as", entry.get("classified_as"))
        check("identified_by[].language", entry.get("language"))
        check_classified_as_entries("identified_by.classified_as", entry.get("classified_as"))
        check_language_entries("identified_by.language", entry.get("language"))

    # ── referred_to_by[] (inscriptions, descriptions, credit lines, etc.) ──
    for entry in (data.get("referred_to_by") or []):
        if not isinstance(entry, dict):
            shape_counts["referred_to_by[]:non_dict"] += 1
            continue
        check("referred_to_by[].content", entry.get("content"))
        check("referred_to_by[].language", entry.get("language"))
        check("referred_to_by[].classified_as", entry.get("classified_as"))
        check_classified_as_entries("referred_to_by.classified_as", entry.get("classified_as"))
        check_language_entries("referred_to_by.language", entry.get("language"))

    # ── dimension[] (height, width) ──
    for entry in (data.get("dimension") or []):
        if not isinstance(entry, dict):
            shape_counts["dimension[]:non_dict"] += 1
            continue
        check("dimension[].value", entry.get("value"))
        check("dimension[].classified_as", entry.get("classified_as"))
        check("dimension[].unit", entry.get("unit"))
        check_classified_as_entries("dimension.classified_as", entry.get("classified_as"))

    # ── subject_of[] (narrative) ──
    for entry in (data.get("subject_of") or []):
        if not isinstance(entry, dict):
            shape_counts["subject_of[]:non_dict"] += 1
            continue
        check("subject_of[].language", entry.get("language"))
        check("subject_of[].part", entry.get("part"))
        check_language_entries("subject_of.language", entry.get("language"))
        for part in (entry.get("part") or []):
            if not isinstance(part, dict):
                shape_counts["subject_of_part[]:non_dict"] += 1
                continue
            check("subject_of_part[].classified_as", part.get("classified_as"))
            check("subject_of_part[].content", part.get("content"))
            check_classified_as_entries("subject_of_part.classified_as", part.get("classified_as"))

    # ── equivalent[] (Wikidata, external IDs) ──
    for entry in (data.get("equivalent") or []):
        if isinstance(entry, dict):
            check("equivalent[].id", entry.get("id"))
        else:
            shape_counts["equivalent[]:non_dict"] += 1

    # ── Discover unknown top-level keys ──
    known_top = {
        "@context", "id", "type", "_label", "identified_by", "classified_as",
        "referred_to_by", "representation", "produced_by", "dimension",
        "member_of", "subject_of", "current_owner", "current_location",
        "shows", "carries", "about", "part_of", "equivalent",
        "made_of", "assigned_by", "attributed_by", "modified_by",
        "defined_by",
        "_status",  # our internal key
    }
    for key in data:
        if key not in known_top:
            anomalies.append({
                "path": f"<unknown_key:{key}>",
                "expected": ["known keys"],
                "actual": type_name(data[key]),
                "sample": repr(data[key])[:200],
            })

    return anomalies


def has_classification(classified_as, aat_uri: str) -> bool:
    if not isinstance(classified_as, list):
        return False
    return any(
        (c.get("id", "") if isinstance(c, dict) else str(c)) == aat_uri
        for c in classified_as
    )


def extract_text_by_aat(referred_to_by, aat_uri: str) -> str | None:
    """Extract text from referred_to_by classified by AAT URI (mirrors harvest)."""
    if not isinstance(referred_to_by, list):
        return None
    texts = []
    for stmt in referred_to_by:
        if not isinstance(stmt, dict):
            continue
        if has_classification(stmt.get("classified_as"), aat_uri):
            content = stmt.get("content", "")
            if isinstance(content, list):
                texts.extend(s for s in content if isinstance(s, str))
            elif content:
                texts.append(content)
    return " | ".join(texts) if texts else None


def extract_dates(data: dict) -> tuple[int | None, int | None]:
    """Extract date_earliest/date_latest (mirrors harvest logic)."""
    produced_by = data.get("produced_by", {})
    timespan = produced_by.get("timespan", {}) if isinstance(produced_by, dict) else {}
    if isinstance(timespan, list) and timespan:
        all_begins = [t.get("begin_of_the_begin", "") for t in timespan if isinstance(t, dict)]
        all_ends = [t.get("end_of_the_end", "") for t in timespan if isinstance(t, dict)]
        timespan = {
            "begin_of_the_begin": min((b for b in all_begins if b), default=""),
            "end_of_the_end": max((e for e in all_ends if e), default=""),
        }
    date_earliest = date_latest = None
    if isinstance(timespan, dict):
        for key, target in [("begin_of_the_begin", "earliest"), ("end_of_the_end", "latest")]:
            val = timespan.get(key, "")
            if val and isinstance(val, str) and len(val) >= 4:
                try:
                    year_str = val[:5] if val.startswith("-") else val[:4]
                    year = int(year_str)
                    if target == "earliest":
                        date_earliest = year
                    else:
                        date_latest = year
                except (ValueError, IndexError):
                    pass
    if date_earliest is not None and date_latest is None:
        date_latest = date_earliest
    elif date_latest is not None and date_earliest is None:
        date_earliest = date_latest
    return date_earliest, date_latest


def extract_titles(data: dict) -> str | None:
    """Extract title_all_text (mirrors harvest logic)."""
    parts = []
    for entry in data.get("identified_by", []):
        if isinstance(entry, dict) and entry.get("type") == "Name":
            content = entry.get("content", "")
            if isinstance(content, list):
                parts.extend(s for s in content if isinstance(s, str))
            elif content:
                parts.append(content)
    return "\n".join(parts) if parts else None


def extract_creator_label(data: dict) -> str | None:
    """Extract creator_label from production statement (mirrors harvest logic)."""
    produced_by = data.get("produced_by", {})
    if not isinstance(produced_by, dict):
        return None
    prod_refs = produced_by.get("referred_to_by", [])
    if not isinstance(prod_refs, list):
        return None
    label_by_lang: dict[str, str] = {}
    for ref in prod_refs:
        if not isinstance(ref, dict):
            continue
        if not has_classification(ref.get("classified_as"), AAT_PRODUCTION_STATEMENT):
            continue
        content = ref.get("content", "")
        if isinstance(content, list):
            content = " ".join(s for s in content if isinstance(s, str))
        if not content:
            continue
        for lang in ref.get("language", []):
            lid = lang.get("id", "") if isinstance(lang, dict) else ""
            if lid and lid not in label_by_lang:
                label_by_lang[lid] = content
                break
    # Prefer English
    en_uri = "http://vocab.getty.edu/aat/300388277"
    nl_uri = "http://vocab.getty.edu/aat/300388256"
    return label_by_lang.get(en_uri) or label_by_lang.get(nl_uri) or next(iter(label_by_lang.values()), None)


# ─── Data drift comparison ──────────────────────────────────────────

def compare_fields(obj_num: str, live: dict, db_row: dict) -> list[dict]:
    """Compare live-resolved fields to DB values. Return list of drifts."""
    drifts = []
    referred_to_by = live.get("referred_to_by", [])

    comparisons = {
        "inscription_text": extract_text_by_aat(referred_to_by, AAT_INSCRIPTIONS),
        "description_text": extract_text_by_aat(referred_to_by, AAT_DESCRIPTION),
        "credit_line": extract_text_by_aat(referred_to_by, AAT_CREDIT_LINE),
        "title_all_text": extract_titles(live),
        "creator_label": extract_creator_label(live),
    }

    date_earliest, date_latest = extract_dates(live)
    comparisons["date_earliest"] = date_earliest
    comparisons["date_latest"] = date_latest

    for field, live_val in comparisons.items():
        db_val = db_row.get(field)
        # Normalize for comparison
        live_norm = str(live_val).strip() if live_val is not None else None
        db_norm = str(db_val).strip() if db_val is not None else None
        if live_norm != db_norm:
            drifts.append({
                "object_number": obj_num,
                "field": field,
                "db_value": db_norm[:100] if db_norm else None,
                "live_value": live_norm[:100] if live_norm else None,
            })
    return drifts


# ─── OAI-PMH new record check ───────────────────────────────────────

def check_new_records(since_date: str) -> dict:
    """Check OAI-PMH for new/modified records since a date."""
    # Just fetch the first page to get the completeListSize
    from_date = since_date[:10]  # YYYY-MM-DD
    url = f"{OAI_BASE}?verb=ListRecords&metadataPrefix=edm&from={from_date}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            xml_bytes = resp.read()
        root = ET.fromstring(xml_bytes)
        ns = {"oai": "http://www.openarchives.org/OAI/2.0/"}
        token_el = root.find(".//oai:resumptionToken", ns)
        if token_el is not None:
            total = token_el.get("completeListSize", "unknown")
            return {"status": "records_found", "total": total, "since": from_date}
        # No resumption token — either 0 or ≤1 page of records
        records = root.findall(".//oai:record", ns)
        return {"status": "records_found", "total": str(len(records)), "since": from_date}
    except urllib.error.HTTPError as e:
        if e.code == 422:
            return {"status": "no_records", "total": "0", "since": from_date}
        return {"status": f"error (HTTP {e.code})", "total": "?", "since": from_date}
    except Exception as e:
        return {"status": f"error: {e}", "total": "?", "since": from_date}


# ─── Main ────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Harvest probe: shape & drift analysis")
    parser.add_argument("--samples", type=int, default=500, help="Number of artworks to sample (default: 500)")
    parser.add_argument("--threads", type=int, default=8, help="Thread count (default: 8)")
    args = parser.parse_args()

    if not DB_PATH.exists():
        print(f"ERROR: vocab DB not found at {DB_PATH}")
        sys.exit(1)

    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row

    # Get last harvest date
    built_at = conn.execute("SELECT value FROM version_info WHERE key='built_at'").fetchone()
    built_at = built_at[0] if built_at else "unknown"
    print(f"Vocab DB built at: {built_at}")

    # Sample random artwork URIs + their stored data
    all_rows = conn.execute("""
        SELECT object_number, title, creator_label, inscription_text,
               description_text, credit_line, date_earliest, date_latest,
               title_all_text
        FROM artworks
        ORDER BY RANDOM()
        LIMIT ?
    """, (args.samples,)).fetchall()
    conn.close()

    sample_rows = {row["object_number"]: dict(row) for row in all_rows}

    print(f"Sampled {len(sample_rows)} artworks for probing")
    print(f"Threads: {args.threads}")
    print()

    # ─── Phase A: Resolve & check shapes ─────────────────────────────

    print("=" * 60)
    print("PHASE A: Shape Anomaly Detection")
    print("=" * 60)

    # Step 1: Look up Linked Art URIs via Search API
    print("  Looking up URIs via Search API...")
    uris: dict[str, str] = {}

    def lookup_one(obj_num: str):
        return obj_num, lookup_uri(obj_num)

    with ThreadPoolExecutor(max_workers=args.threads) as pool:
        futures = [pool.submit(lookup_one, obj) for obj in sample_rows]
        done = 0
        for future in as_completed(futures):
            done += 1
            if done % 100 == 0 or done == len(futures):
                print(f"    Looked up {done}/{len(futures)}...", flush=True)
            obj_num, uri = future.result()
            if uri:
                uris[obj_num] = uri

    print(f"    Found URIs: {len(uris)}/{len(sample_rows)}")
    if len(uris) < len(sample_rows):
        print(f"    Missing URIs: {len(sample_rows) - len(uris)} (artwork may have been removed)")
    print()

    # Step 2: Resolve and check shapes
    print("  Resolving artworks...")
    results: dict[str, dict] = {}
    all_anomalies: list[dict] = []
    shape_counts: Counter = Counter()  # path:type → count
    errors = Counter()
    not_found = 0
    resolved = 0

    def resolve_one(obj_num: str, uri: str):
        return obj_num, resolve_artwork(uri)

    with ThreadPoolExecutor(max_workers=args.threads) as pool:
        futures = {pool.submit(resolve_one, obj, uri): obj for obj, uri in uris.items()}
        done = 0
        for future in as_completed(futures):
            done += 1
            if done % 100 == 0 or done == len(futures):
                print(f"    Resolved {done}/{len(futures)}...", flush=True)
            obj_num, data = future.result()
            if data is None:
                errors["resolve_failed"] += 1
                continue
            if data.get("_status") == "not_found":
                not_found += 1
                continue
            if "_status" in data:
                errors[data["_status"]] += 1
                continue
            results[obj_num] = data
            resolved += 1

            # Check shapes (also populates shape_counts)
            anomalies = probe_shapes(data, shape_counts)
            for a in anomalies:
                a["object_number"] = obj_num
            all_anomalies.extend(anomalies)

    print()
    print(f"  Resolved: {resolved}")
    print(f"  Not found (404): {not_found}")
    if errors:
        print(f"  Errors: {dict(errors)}")
    print()

    if all_anomalies:
        # Group by path
        by_path = defaultdict(list)
        for a in all_anomalies:
            by_path[a["path"]].append(a)

        print(f"  ANOMALIES FOUND: {len(all_anomalies)} across {len(by_path)} field paths")
        print()
        for path, items in sorted(by_path.items()):
            print(f"  {path}: {len(items)} occurrences")
            print(f"    Expected: {items[0]['expected']}")
            print(f"    Actual: {items[0]['actual']}")
            # Show up to 3 examples
            for item in items[:3]:
                print(f"    Example ({item['object_number']}): {item['sample'][:120]}")
            print()
    else:
        print("  No shape anomalies found.")
    print()

    # Shape distribution — grouped by category
    def print_shape_group(title: str, prefix_filter):
        keys = [k for k in sorted(shape_counts) if prefix_filter(k)]
        if not keys:
            return
        print(f"  {title}:")
        for key in keys:
            path, tn = key.rsplit(":", 1)
            count = shape_counts[key]
            print(f"    {path}: {tn} = {count:,}")
        print()

    # Top-level and produced_by fields (per-artwork counts)
    top_paths = {
        "produced_by", "referred_to_by", "identified_by", "dimension",
        "subject_of", "equivalent", "made_of",
        "produced_by.timespan", "produced_by.referred_to_by", "produced_by.part",
    }
    print_shape_group("Top-level & produced_by fields",
        lambda k: k.rsplit(":", 1)[0] in top_paths)

    # Timespan internals
    print_shape_group("Timespan fields",
        lambda k: k.rsplit(":", 1)[0].startswith("timespan."))

    # Production parts & attribution
    prod_paths = {"produced_by.part[].technique", "produced_by.part[].classified_as",
                  "produced_by.part[].carried_out_by", "produced_by.part[].assigned_by",
                  "assigned_by[].assigned", "assigned_by[].classified_as",
                  "assigned_by[].assigned_property", "assigned[].formed_by",
                  "formed_by.influenced_by"}
    print_shape_group("Production parts & attribution",
        lambda k: k.rsplit(":", 1)[0] in prod_paths)

    # Content/language/classified_as inside list entries
    entry_prefixes = ("identified_by[].", "referred_to_by[].", "prod_ref[].",
                      "dimension[].", "subject_of[].", "subject_of_part[].", "equivalent[].")
    print_shape_group("List entry fields",
        lambda k: any(k.rsplit(":", 1)[0].startswith(p) for p in entry_prefixes))

    # classified_as / language entry shapes (dict vs bare string)
    print_shape_group("classified_as & language entry shapes (dict vs bare string)",
        lambda k: "_entry:" in k)

    # Non-dict entries in lists (should be 0)
    non_dict_keys = [k for k in shape_counts if "non_dict" in k]
    if non_dict_keys:
        print("  Non-dict entries in lists (unexpected):")
        for key in sorted(non_dict_keys):
            print(f"    {key} = {shape_counts[key]:,}")
        print()

    # ─── Phase B: Data Drift ─────────────────────────────────────────

    print("=" * 60)
    print("PHASE B: Data Drift Detection")
    print("=" * 60)

    all_drifts: list[dict] = []
    for obj_num, data in results.items():
        db_row = sample_rows.get(obj_num)
        if db_row:
            drifts = compare_fields(obj_num, data, db_row)
            all_drifts.extend(drifts)

    if all_drifts:
        # Group by field
        by_field = defaultdict(list)
        for d in all_drifts:
            by_field[d["field"]].append(d)

        print(f"  Data drifts found: {len(all_drifts)} across {len(by_field)} fields")
        print(f"  Artworks with drift: {len(set(d['object_number'] for d in all_drifts))}/{resolved}")
        print()
        for field, items in sorted(by_field.items(), key=lambda x: -len(x[1])):
            null_to_val = sum(1 for d in items if d["db_value"] is None and d["live_value"] is not None)
            val_to_null = sum(1 for d in items if d["db_value"] is not None and d["live_value"] is None)
            changed = len(items) - null_to_val - val_to_null
            print(f"  {field}: {len(items)} drifts")
            print(f"    NULL→value: {null_to_val}, value→NULL: {val_to_null}, changed: {changed}")
            # Show up to 2 examples
            for item in items[:2]:
                print(f"    Example ({item['object_number']}):")
                print(f"      DB:   {item['db_value']}")
                print(f"      Live: {item['live_value']}")
            print()
    else:
        print("  No data drift detected.")
    print()

    # ─── Phase C: New Records Since Last Harvest ─────────────────────

    print("=" * 60)
    print("PHASE C: New/Modified Records Since Last Harvest")
    print("=" * 60)

    if built_at and built_at != "unknown":
        result = check_new_records(built_at)
        print(f"  Since: {result['since']}")
        print(f"  Status: {result['status']}")
        print(f"  Total new/modified records: {result['total']}")
    else:
        print("  Cannot determine last harvest date — skipping.")
    print()

    # ─── Summary ─────────────────────────────────────────────────────

    print("=" * 60)
    print("SUMMARY")
    print("=" * 60)
    print(f"  Artworks sampled: {len(uris)}")
    print(f"  Resolved successfully: {resolved}")
    print(f"  Shape anomalies: {len(all_anomalies)}")
    print(f"  Data drifts: {len(all_drifts)}")
    drift_artworks = len(set(d["object_number"] for d in all_drifts)) if all_drifts else 0
    print(f"  Artworks with drift: {drift_artworks}/{resolved} ({drift_artworks/resolved*100:.1f}%)" if resolved else "")
    if all_anomalies:
        print(f"  ⚠ SHAPE ANOMALIES DETECTED — review before harvesting")
    if drift_artworks > resolved * 0.1:
        print(f"  ⚠ SIGNIFICANT DATA DRIFT — >10% of artworks changed")
    elif all_drifts:
        print(f"  Data drift is minor (<10% of sample)")
    else:
        print(f"  No issues detected")


if __name__ == "__main__":
    main()
