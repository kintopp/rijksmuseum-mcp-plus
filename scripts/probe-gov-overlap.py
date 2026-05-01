"""Probe GOV overlap for the 200-row suitability sample.

This script deliberately separates two evidence paths:

1. MiniGOV bulk files: useful for coverage/coordinate estimates, but quarantined
   because the MiniGOV page declares CC BY-ND 4.0.
2. Live GOV API: useful for checking operational feasibility and, when accessible,
   richer concordance data from `/api/data/{id}`.

Outputs:
  offline/geo/gov-probe/probe-results.csv
  offline/geo/gov-probe/live-probe-results.csv
  offline/geo/gov-probe/concordance-additions.csv
  offline/geo/gov-probe/live-api-attempt.csv
  offline/geo/gov-probe/probe-summary.md
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT_DIR = ROOT / "offline" / "geo" / "gov-probe"
DEFAULT_INPUT = DEFAULT_OUT_DIR / "probe-input.csv"
DEFAULT_CONCORDANCES = DEFAULT_OUT_DIR / "current-concordances.csv"
DEFAULT_MINIGOV = DEFAULT_OUT_DIR / "minigov-cache" / "gov-data-names_current.zip"

RESULT_COLUMNS = [
    "stratum",
    "vocab_id",
    "label",
    "geonames_id",
    "wikidata_qid",
    "gov_id",
    "gov_lat",
    "gov_lon",
    "gov_type_codes",
    "gov_wikidata",
    "distance_km",
    "bucket",
    "evidence_path",
    "notes",
]

CONCORDANCE_COLUMNS = [
    "vocab_id",
    "gov_id",
    "authority",
    "external_ref",
    "gov_last_modified",
    "notes",
]

LIVE_COLUMNS = [
    "row_number",
    "stratum",
    "vocab_id",
    "label",
    "endpoint",
    "url",
    "http_status",
    "content_type",
    "bytes",
    "looks_like_anubis",
    "response_file",
    "notes",
]


def norm_name(value: str) -> str:
    value = value.casefold()
    value = re.sub(r"[^\w\s-]", " ", value, flags=re.UNICODE)
    value = re.sub(r"\s+", " ", value).strip()
    return value


def parse_float(value: str | None) -> float | None:
    if value is None or value == "":
        return None
    return float(value)


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0088
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def bucket_for(db_lat: float | None, db_lon: float | None, gov_lat: float | None, gov_lon: float | None) -> tuple[str, str]:
    if gov_lat is None or gov_lon is None:
        return "no_match", ""
    if db_lat is None or db_lon is None:
        return "ungeocoded_match", ""
    distance = haversine_km(db_lat, db_lon, gov_lat, gov_lon)
    if distance <= 5:
        return "match_agree", f"{distance:.3f}"
    if distance <= 50:
        return "match_partial", f"{distance:.3f}"
    if distance <= 1000:
        return "match_disagree", f"{distance:.3f}"
    return "match_far_disagree", f"{distance:.3f}"


def read_probe_input(path: Path) -> list[dict[str, str]]:
    with path.open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def read_current_concordances(path: Path) -> dict[str, set[tuple[str, str]]]:
    current: dict[str, set[tuple[str, str]]] = defaultdict(set)
    if not path.exists():
        return current
    with path.open(newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            current[row["vocab_id"]].add((row["authority"], row["id"]))
    return current


def iter_minigov_rows(zip_path: Path):
    with zipfile.ZipFile(zip_path) as zf:
        names = zf.namelist()
        if len(names) != 1:
            raise RuntimeError(f"expected one file in {zip_path}, found {names}")
        with zf.open(names[0]) as raw:
            text = (line.decode("utf-8", errors="replace") for line in raw)
            yield from csv.DictReader(text, delimiter="\t")


def build_name_index(zip_path: Path, wanted_names: set[str]) -> dict[str, list[dict[str, str]]]:
    index: dict[str, list[dict[str, str]]] = defaultdict(list)
    for row in iter_minigov_rows(zip_path):
        keys = {norm_name(row.get("name", "")), norm_name(row.get("name_de", ""))}
        for key in keys:
            if key and key in wanted_names:
                index[key].append(row)
    return index


def choose_candidate(probe_row: dict[str, str], candidates: list[dict[str, str]]) -> tuple[dict[str, str] | None, str]:
    if not candidates:
        return None, "no MiniGOV current-name candidate"
    db_lat = parse_float(probe_row.get("db_lat"))
    db_lon = parse_float(probe_row.get("db_lon"))
    coord_candidates = [
        c for c in candidates if c.get("latitude") not in ("", None) and c.get("longitude") not in ("", None)
    ]
    if db_lat is not None and db_lon is not None and coord_candidates:
        ranked = sorted(
            coord_candidates,
            key=lambda c: haversine_km(db_lat, db_lon, float(c["latitude"]), float(c["longitude"])),
        )
        return ranked[0], f"selected nearest of {len(candidates)} MiniGOV current-name candidates"
    if coord_candidates:
        return coord_candidates[0], f"selected first coordinate-bearing of {len(candidates)} MiniGOV current-name candidates"
    return candidates[0], f"selected first of {len(candidates)} MiniGOV current-name candidates; no coordinates"


def run_minigov_probe(rows: list[dict[str, str]], minigov_zip: Path) -> list[dict[str, str]]:
    wanted_names = {norm_name(r["label"]) for r in rows if norm_name(r["label"])}
    index = build_name_index(minigov_zip, wanted_names)
    results = []
    for row in rows:
        key = norm_name(row["label"])
        candidate, note = choose_candidate(row, index.get(key, []))
        db_lat = parse_float(row.get("db_lat"))
        db_lon = parse_float(row.get("db_lon"))
        gov_lat = parse_float(candidate.get("latitude")) if candidate else None
        gov_lon = parse_float(candidate.get("longitude")) if candidate else None
        bucket, distance = bucket_for(db_lat, db_lon, gov_lat, gov_lon)
        results.append(
            {
                "stratum": row["stratum"],
                "vocab_id": row["vocab_id"],
                "label": row["label"],
                "geonames_id": row.get("geonames_id", ""),
                "wikidata_qid": row.get("wikidata_qid", ""),
                "gov_id": candidate.get("id", "") if candidate else "",
                "gov_lat": candidate.get("latitude", "") if candidate else "",
                "gov_lon": candidate.get("longitude", "") if candidate else "",
                "gov_type_codes": candidate.get("type_id", "") if candidate else "",
                "gov_wikidata": "",
                "distance_km": distance,
                "bucket": bucket,
                "evidence_path": "minigov_cc_by_nd_quarantine",
                "notes": note,
            }
        )
    return results


def write_csv(path: Path, rows: list[dict[str, Any]], columns: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def live_get(url: str, user_agent: str, cookie: str | None, timeout: float) -> tuple[int | str, str, bytes, str]:
    headers = {"User-Agent": user_agent, "Accept": "application/json,text/plain;q=0.9,*/*;q=0.1"}
    if cookie:
        headers["Cookie"] = cookie
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.headers.get("Content-Type", ""), resp.read(), ""
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get("Content-Type", ""), e.read(), ""
    except Exception as e:  # noqa: BLE001 - diagnostic script
        return "error", "", b"", repr(e)


def run_live_attempt(rows: list[dict[str, str]], out_dir: Path, limit: int, rate_s: float, cookie: str | None) -> list[dict[str, str]]:
    raw_dir = out_dir / "live-api-raw"
    raw_dir.mkdir(parents=True, exist_ok=True)
    user_agent = "rijksmuseum-mcp-plus GOV probe / arno.bosse@gmail.com"
    attempts = []
    for idx, row in enumerate(rows[:limit], start=1):
        endpoints = []
        if row.get("geonames_id"):
            endpoints.append(
                (
                    "getObjectByExternalId-geonames",
                    "https://gov.genealogy.net/api/getObjectByExternalId?"
                    + urllib.parse.urlencode({"system": "geonames", "ref": row["geonames_id"]}),
                )
            )
        elif row.get("wikidata_qid"):
            endpoints.append(
                (
                    "getObjectByExternalId-wikidata",
                    "https://gov.genealogy.net/api/getObjectByExternalId?"
                    + urllib.parse.urlencode({"system": "wikidata", "ref": row["wikidata_qid"]}),
                )
            )
        endpoints.append(
            (
                "searchByNameAndType",
                "https://gov.genealogy.net/api/searchByNameAndType?"
                + urllib.parse.urlencode({"placename": row["label"]}),
            )
        )
        for endpoint, url in endpoints:
            status, content_type, body, err = live_get(url, user_agent, cookie, 30)
            safe_stem = f"{idx:03d}-{row['vocab_id']}-{endpoint}"
            response_file = f"live-api-raw/{safe_stem}.body"
            (out_dir / response_file).write_bytes(body)
            text_head = body[:4096].decode("utf-8", errors="ignore").casefold()
            looks_like_anubis = any(marker in text_head for marker in ["anubis", "techaro", "proof-of-work"])
            attempts.append(
                {
                    "row_number": str(idx),
                    "stratum": row["stratum"],
                    "vocab_id": row["vocab_id"],
                    "label": row["label"],
                    "endpoint": endpoint,
                    "url": url,
                    "http_status": str(status),
                    "content_type": content_type,
                    "bytes": str(len(body)),
                    "looks_like_anubis": "true" if looks_like_anubis else "false",
                    "response_file": response_file,
                    "notes": err,
                }
            )
            time.sleep(rate_s)
    return attempts


def parse_json_body(out_dir: Path, response_file: str) -> Any:
    body = (out_dir / response_file).read_bytes()
    if not body:
        return None
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        return None


def record_external_refs(record: dict[str, Any]) -> list[tuple[str, str]]:
    refs = []
    for item in record.get("externalReference", []) or []:
        value = item.get("value") if isinstance(item, dict) else None
        if not value or ":" not in value:
            continue
        authority, ref = value.split(":", 1)
        refs.append((authority, ref))
    return refs


def gov_record_result(
    probe_row: dict[str, str],
    record: dict[str, Any] | None,
    evidence_path: str,
    note: str,
) -> dict[str, str]:
    position = record.get("position") if record else {}
    gov_lat = position.get("lat") if isinstance(position, dict) else None
    gov_lon = position.get("lon") if isinstance(position, dict) else None
    db_lat = parse_float(probe_row.get("db_lat"))
    db_lon = parse_float(probe_row.get("db_lon"))
    bucket, distance = bucket_for(
        db_lat,
        db_lon,
        float(gov_lat) if gov_lat not in ("", None) else None,
        float(gov_lon) if gov_lon not in ("", None) else None,
    )
    type_codes = []
    wikidata = ""
    if record:
        for item in record.get("type", []) or []:
            if isinstance(item, dict) and item.get("value"):
                type_codes.append(str(item["value"]))
        for authority, ref in record_external_refs(record):
            if authority == "wikidata":
                wikidata = ref
                break
    return {
        "stratum": probe_row["stratum"],
        "vocab_id": probe_row["vocab_id"],
        "label": probe_row["label"],
        "geonames_id": probe_row.get("geonames_id", ""),
        "wikidata_qid": probe_row.get("wikidata_qid", ""),
        "gov_id": str(record.get("id", "")) if record else "",
        "gov_lat": str(gov_lat or ""),
        "gov_lon": str(gov_lon or ""),
        "gov_type_codes": ",".join(type_codes),
        "gov_wikidata": wikidata,
        "distance_km": distance,
        "bucket": bucket,
        "evidence_path": evidence_path,
        "notes": note,
    }


def choose_live_record(
    probe_row: dict[str, str],
    direct_record: dict[str, Any] | None,
    search_records: list[dict[str, Any]],
) -> tuple[dict[str, Any] | None, str, str]:
    if direct_record and direct_record.get("id"):
        return direct_record, "live_api_direct_external_id", "selected direct external-ID hit"
    if not search_records:
        return None, "live_api", "no live API direct hit or name-search candidate"
    db_lat = parse_float(probe_row.get("db_lat"))
    db_lon = parse_float(probe_row.get("db_lon"))
    coord_records = [
        r for r in search_records
        if isinstance(r, dict)
        and isinstance(r.get("position"), dict)
        and r["position"].get("lat") is not None
        and r["position"].get("lon") is not None
    ]
    if db_lat is not None and db_lon is not None and coord_records:
        ranked = sorted(
            coord_records,
            key=lambda r: haversine_km(
                db_lat,
                db_lon,
                float(r["position"]["lat"]),
                float(r["position"]["lon"]),
            ),
        )
        return ranked[0], "live_api_name_search", f"selected nearest of {len(search_records)} name-search candidates"
    if coord_records:
        return coord_records[0], "live_api_name_search", f"selected first coordinate-bearing of {len(search_records)} name-search candidates"
    return search_records[0], "live_api_name_search", f"selected first of {len(search_records)} name-search candidates; no coordinates"


def live_results_from_attempts(
    rows: list[dict[str, str]],
    attempts: list[dict[str, str]],
    out_dir: Path,
    current_concordances: dict[str, set[tuple[str, str]]],
) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    by_vocab_endpoint: dict[tuple[str, str], dict[str, str]] = {}
    for attempt in attempts:
        by_vocab_endpoint[(attempt["vocab_id"], attempt["endpoint"])] = attempt

    results = []
    concordance_rows = []
    for row in rows:
        direct = None
        direct_key = "getObjectByExternalId-geonames" if row.get("geonames_id") else "getObjectByExternalId-wikidata"
        if row.get("geonames_id") or row.get("wikidata_qid"):
            attempt = by_vocab_endpoint.get((row["vocab_id"], direct_key))
            if attempt:
                parsed = parse_json_body(out_dir, attempt["response_file"])
                if isinstance(parsed, dict):
                    direct = parsed

        search_records: list[dict[str, Any]] = []
        search_attempt = by_vocab_endpoint.get((row["vocab_id"], "searchByNameAndType"))
        if search_attempt:
            parsed = parse_json_body(out_dir, search_attempt["response_file"])
            if isinstance(parsed, list):
                search_records = [r for r in parsed if isinstance(r, dict)]

        record, evidence_path, note = choose_live_record(row, direct, search_records)
        result = gov_record_result(row, record, evidence_path, note)
        results.append(result)

        if result["bucket"] in {"match_agree", "match_partial", "ungeocoded_match"} and record:
            for authority, ref in record_external_refs(record):
                if (authority, ref) not in current_concordances.get(row["vocab_id"], set()):
                    concordance_rows.append(
                        {
                            "vocab_id": row["vocab_id"],
                            "gov_id": result["gov_id"],
                            "authority": authority,
                            "external_ref": ref,
                            "gov_last_modified": str(record.get("lastModification", "")),
                            "notes": "GOV live API record carries this; not in current-concordances.csv",
                        }
                    )
    return results, concordance_rows


def summarize(
    results: list[dict[str, str]],
    live_attempts: list[dict[str, str]],
    out_dir: Path,
    live_results: list[dict[str, str]] | None = None,
) -> str:
    total = len(results)
    buckets = Counter(r["bucket"] for r in results)
    strata: dict[str, Counter] = defaultdict(Counter)
    for row in results:
        strata[row["stratum"]][row["bucket"]] += 1

    def pct(n: int) -> str:
        return f"{(100 * n / total):.1f}%" if total else "0.0%"

    lines = [
        "# GOV probe summary",
        "",
        "Generated by `scripts/probe-gov-overlap.py`.",
        "",
        "## Evidence Boundary",
        "",
        "MiniGOV results are marked `minigov_cc_by_nd_quarantine`. They are useful for coverage and feasibility analysis only; they should not be used to enrich Rijksmuseum metadata unless the license question is resolved. Live API attempts are recorded separately in `live-api-attempt.csv`.",
        "",
        "## MiniGOV Coverage Buckets",
        "",
        "| Bucket | n | % of total |",
        "|---|---:|---:|",
    ]
    for bucket, count in buckets.most_common():
        lines.append(f"| `{bucket}` | {count} | {pct(count)} |")

    lines.extend(["", "## Per-Stratum Breakdown", "", "| Stratum | Bucket | n |", "|---|---|---:|"])
    for stratum in sorted(strata):
        for bucket, count in strata[stratum].most_common():
            lines.append(f"| {stratum} | `{bucket}` | {count} |")

    far = [r for r in results if r["bucket"] == "match_far_disagree"]
    far.sort(key=lambda r: float(r["distance_km"] or 0), reverse=True)
    lines.extend(["", "## Worst Far Disagreements", ""])
    if far:
        for row in far[:5]:
            lines.append(f"- {row['label']} (`{row['vocab_id']}`) -> GOV `{row['gov_id']}`, {row['distance_km']} km")
    else:
        lines.append("- None in the MiniGOV pass.")

    useful = [r for r in results if r["bucket"] == "ungeocoded_match"]
    lines.extend(["", "## Useful Ungeocoded Matches", ""])
    if useful:
        for row in useful[:5]:
            lines.append(f"- {row['label']} (`{row['vocab_id']}`) -> GOV `{row['gov_id']}` at {row['gov_lat']}, {row['gov_lon']}")
    else:
        lines.append("- None in the MiniGOV pass.")

    live_counter = Counter((r["http_status"], r["looks_like_anubis"]) for r in live_attempts)
    lines.extend(["", "## Live API Feasibility Attempt", ""])
    if live_attempts:
        lines.append("| HTTP status | Anubis-like body | n |")
        lines.append("|---|---|---:|")
        for (status, anubis), count in live_counter.most_common():
            lines.append(f"| `{status}` | `{anubis}` | {count} |")
    else:
        lines.append("No live API attempt was requested.")

    if live_results:
        live_buckets = Counter(r["bucket"] for r in live_results)
        lines.extend(["", "## Live API Coverage Buckets", "", "| Bucket | n | % of live rows |", "|---|---:|---:|"])
        live_total = len(live_results)
        for bucket, count in live_buckets.most_common():
            lines.append(f"| `{bucket}` | {count} | {(100 * count / live_total):.1f}% |")
        live_evidence = Counter(r["evidence_path"] for r in live_results)
        lines.extend(["", "## Live API Evidence Paths", "", "| Evidence path | n |", "|---|---:|"])
        for path, count in live_evidence.most_common():
            lines.append(f"| `{path}` | {count} |")

    ungeocoded_count = buckets.get("ungeocoded_match", 0)
    verdict = "MiniGOV clears the >=30 ungeocoded-match threshold as a coverage signal, but the result is license-quarantined."
    if ungeocoded_count < 30:
        verdict = "MiniGOV does not clear the >=30 ungeocoded-match threshold in this sample."
    if live_results:
        live_ungeocoded = Counter(r["bucket"] for r in live_results).get("ungeocoded_match", 0)
        verdict += f" Live API produced {live_ungeocoded} ungeocoded matches in the attempted set."
    lines.extend(["", "## Verdict", "", verdict])
    text = "\n".join(lines) + "\n"
    (out_dir / "probe-summary.md").write_text(text, encoding="utf-8")
    return text


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--current-concordances", type=Path, default=DEFAULT_CONCORDANCES)
    parser.add_argument("--minigov", type=Path, default=DEFAULT_MINIGOV)
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT_DIR)
    parser.add_argument("--live-limit", type=int, default=0, help="Number of probe rows to test against live GOV API")
    parser.add_argument("--rate-s", type=float, default=1.1)
    parser.add_argument("--cookie", default=os.environ.get("GOV_COOKIE", ""), help="Optional Cookie header for live GOV API")
    args = parser.parse_args()

    rows = read_probe_input(args.input)
    current_concordances = read_current_concordances(args.current_concordances)

    results = run_minigov_probe(rows, args.minigov)
    write_csv(args.out_dir / "probe-results.csv", results, RESULT_COLUMNS)

    live_attempts: list[dict[str, str]] = []
    live_results: list[dict[str, str]] = []
    concordance_rows: list[dict[str, str]] = []
    if args.live_limit:
        live_attempts = run_live_attempt(rows, args.out_dir, args.live_limit, args.rate_s, args.cookie or None)
        write_csv(args.out_dir / "live-api-attempt.csv", live_attempts, LIVE_COLUMNS)
        live_results, concordance_rows = live_results_from_attempts(
            rows[: args.live_limit],
            live_attempts,
            args.out_dir,
            current_concordances,
        )
        write_csv(args.out_dir / "live-probe-results.csv", live_results, RESULT_COLUMNS)
    elif not (args.out_dir / "live-api-attempt.csv").exists():
        write_csv(args.out_dir / "live-api-attempt.csv", [], LIVE_COLUMNS)
        write_csv(args.out_dir / "live-probe-results.csv", [], RESULT_COLUMNS)

    write_csv(args.out_dir / "concordance-additions.csv", concordance_rows, CONCORDANCE_COLUMNS)

    summarize(results, live_attempts, args.out_dir, live_results)
    print(f"wrote {len(results)} rows -> {(args.out_dir / 'probe-results.csv').relative_to(ROOT)}")
    print(f"wrote summary -> {(args.out_dir / 'probe-summary.md').relative_to(ROOT)}")


if __name__ == "__main__":
    main()
