#!/usr/bin/env python3
"""
Probe: fetch modified_by[] (conservation events) from Linked Art records.
Targets famous paintings first (high likelihood of restoration history),
then samples SK-C-* and SK-A-* systematically.

Usage:
  python3 probe-modified-by.py [--output OUTPUT_FILE]
  
Outputs JSON to scripts/tests/modified-by-samples.json by default.
"""
import json
import sys
import urllib.parse
import urllib.request
import argparse

SEARCH_API = "https://data.rijksmuseum.nl/search/collection"
UA = "rijksmuseum-mcp-plus/v0.25-decision-probe"

# High-probability targets (famous paintings with known restoration history)
HIGH_PROB_TARGETS = [
    "SK-C-5",      # The Night Watch (famous restoration 2019-2021)
    "SK-C-216",    # The Jewish Bride
    "SK-A-2344",   # The Milkmaid
    "SK-C-6",      # The Sampling Officials
    "SK-C-1",      # Portrait of a man (history painting)
    "SK-A-3262",   # Vermeer-related
    "SK-C-2399",   # History painting
]

def lookup_uri(obj):
    """Look up object_number -> Linked Art URI via search API."""
    url = f"{SEARCH_API}?objectNumber={urllib.parse.quote(obj)}"
    req = urllib.request.Request(url, headers={
        "Accept": "application/ld+json", "User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            items = json.loads(r.read()).get("orderedItems", [])
        return items[0]["id"] if items else None
    except Exception as e:
        print(f"  [lookup_uri] ERROR: {e}", file=sys.stderr)
        return None

def fetch_la(uri):
    """Fetch Linked Art JSON-LD record."""
    req = urllib.request.Request(uri, headers={
        "Accept": "application/ld+json",
        "Profile": "https://linked.art/ns/v1/linked-art.json",
        "User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())
    except Exception as e:
        print(f"  [fetch_la] ERROR: {e}", file=sys.stderr)
        return None

def extract_modified_by(la):
    """Extract all modified_by[] entries from Linked Art record."""
    entries = la.get("modified_by") or []
    if not isinstance(entries, list):
        entries = [entries]
    return entries

def format_entry_summary(entry):
    """Convert modified_by entry to a normalized dict for JSON output."""
    if not isinstance(entry, dict):
        return None
    
    summary = {
        "raw_type": entry.get("type"),
        "carried_out_by": [],
        "timespan": None,
        "referred_to_by": [],
    }
    
    # Extract restorer names
    cob = entry.get("carried_out_by") or []
    if not isinstance(cob, list):
        cob = [cob]
    for person in cob:
        if isinstance(person, dict):
            summary["carried_out_by"].append({
                "id": person.get("id"),
                "label": person.get("_label") or person.get("label"),
            })
        elif isinstance(person, str):
            summary["carried_out_by"].append({"id": person})
    
    # Extract timespan (date range)
    ts = entry.get("timespan")
    if isinstance(ts, dict):
        summary["timespan"] = {
            "begin_of_the_begin": ts.get("begin_of_the_begin"),
            "end_of_the_end": ts.get("end_of_the_end"),
            "identified_by": ts.get("identified_by"),
        }
    
    # Extract treatment description
    rtb = entry.get("referred_to_by") or []
    if not isinstance(rtb, list):
        rtb = [rtb]
    for ref in rtb:
        if isinstance(ref, dict):
            content = ref.get("content") or ref.get("value")
            if content:
                summary["referred_to_by"].append({
                    "type": ref.get("type"),
                    "content": content[:200],  # Truncate to 200 chars
                })
    
    return summary

def generate_sample_phrase(entry, obj_num, title):
    """
    Build a candidate provenance-style phrase that the PEG grammar might parse.
    Returns a string candidate for PEG testing.
    
    Typical structure: "restorer_name, date_range, treatment_description"
    """
    if not isinstance(entry, dict):
        return None
    
    parts = []
    
    # Restorer name
    cob = entry.get("carried_out_by") or []
    if not isinstance(cob, list):
        cob = [cob]
    restorer_names = []
    for person in cob:
        if isinstance(person, dict):
            label = person.get("_label") or person.get("label")
            if label:
                restorer_names.append(label)
        elif isinstance(person, str):
            restorer_names.append(person)
    
    if restorer_names:
        parts.append(", ".join(restorer_names))
    
    # Timespan: try to extract a readable date range
    ts = entry.get("timespan")
    if isinstance(ts, dict):
        begin = ts.get("begin_of_the_begin")
        end = ts.get("end_of_the_end")
        # Try ISO 8601 format: "2019-01-01" -> extract year
        date_str = None
        if begin and end:
            # Extract years from ISO dates
            try:
                begin_year = int(begin[:4])
                end_year = int(end[:4])
                if begin_year == end_year:
                    date_str = str(begin_year)
                else:
                    date_str = f"{begin_year}-{end_year}"
            except (ValueError, IndexError):
                pass
        elif begin:
            try:
                date_str = begin[:4]
            except:
                pass
        
        if date_str:
            parts.append(date_str)
    
    # Treatment description
    rtb = entry.get("referred_to_by") or []
    if not isinstance(rtb, list):
        rtb = [rtb]
    for ref in rtb:
        if isinstance(ref, dict):
            content = ref.get("content") or ref.get("value")
            if content:
                # Truncate and simplify for PEG testing
                desc = content.strip()[:150]
                parts.append(desc)
    
    if parts:
        return ", ".join(parts)
    return None

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="scripts/tests/modified-by-samples.json",
                        help="Output JSON file")
    args = parser.parse_args()
    
    samples = []
    
    # Phase 1: Try high-probability targets
    print("Phase 1: Testing high-probability targets...")
    for obj_num in HIGH_PROB_TARGETS:
        print(f"  {obj_num}...", end=" ", flush=True)
        uri = lookup_uri(obj_num)
        if not uri:
            print("no URI")
            continue
        
        la = fetch_la(uri)
        if not la:
            print("fetch failed")
            continue
        
        title = la.get("_label") or ""
        if not title:
            for ib in la.get("identified_by") or []:
                if isinstance(ib, dict) and ib.get("type") == "Name":
                    title = ib.get("content") or ""
                    if title:
                        break
        
        entries = extract_modified_by(la)
        if entries:
            print(f"FOUND {len(entries)} entry(ies)")
            for entry in entries:
                phrase = generate_sample_phrase(entry, obj_num, title)
                samples.append({
                    "object_number": obj_num,
                    "title": title,
                    "modified_by_entry": format_entry_summary(entry),
                    "candidate_phrase": phrase,
                })
        else:
            print("no modified_by")
    
    # Phase 2: Systematic sampling of SK-C-* (history paintings, large, likely restored)
    if len(samples) < 30:
        print(f"\nPhase 2: Sampling SK-C-* (need {30 - len(samples)} more)...")
        for i in range(1, 3000, max(1, 3000 // (30 - len(samples)))):
            if len(samples) >= 30:
                break
            obj_num = f"SK-C-{i}"
            print(f"  {obj_num}...", end=" ", flush=True)
            uri = lookup_uri(obj_num)
            if not uri:
                print("-")
                continue
            
            la = fetch_la(uri)
            if not la:
                print("X")
                continue
            
            title = la.get("_label") or ""
            entries = extract_modified_by(la)
            if entries:
                print(f"FOUND {len(entries)}")
                for entry in entries:
                    phrase = generate_sample_phrase(entry, obj_num, title)
                    samples.append({
                        "object_number": obj_num,
                        "title": title,
                        "modified_by_entry": format_entry_summary(entry),
                        "candidate_phrase": phrase,
                    })
            else:
                print(".")
    
    # Phase 3: Systematic sampling of SK-A-* (paintings)
    if len(samples) < 30:
        print(f"\nPhase 3: Sampling SK-A-* (need {30 - len(samples)} more)...")
        for i in range(1, 4000, max(1, 4000 // (30 - len(samples)))):
            if len(samples) >= 30:
                break
            obj_num = f"SK-A-{i}"
            print(f"  {obj_num}...", end=" ", flush=True)
            uri = lookup_uri(obj_num)
            if not uri:
                print("-")
                continue
            
            la = fetch_la(uri)
            if not la:
                print("X")
                continue
            
            title = la.get("_label") or ""
            entries = extract_modified_by(la)
            if entries:
                print(f"FOUND {len(entries)}")
                for entry in entries:
                    phrase = generate_sample_phrase(entry, obj_num, title)
                    samples.append({
                        "object_number": obj_num,
                        "title": title,
                        "modified_by_entry": format_entry_summary(entry),
                        "candidate_phrase": phrase,
                    })
            else:
                print(".")
    
    # Write output
    print(f"\nWriting {len(samples)} samples to {args.output}...")
    with open(args.output, "w") as f:
        json.dump(samples, f, indent=2)
    
    print(f"Done. Found {len(samples)} artworks with modified_by[] entries.")

if __name__ == "__main__":
    main()
