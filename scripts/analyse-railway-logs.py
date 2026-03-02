#!/usr/bin/env python3
"""Analyse Railway deployment logs and produce a 7-section markdown report.

Reads a JSONL file of Railway logs (produced by `railway logs --json`) and
generates a structured report covering traffic, performance, errors, sessions,
tool-specific observations, caching patterns, and recommendations.

Usage:
    python3 scripts/analyse-railway-logs.py logs.jsonl              # stdout
    python3 scripts/analyse-railway-logs.py logs.jsonl -o report.md # file

Typically invoked via the wrapper:
    ./scripts/analyse-railway-logs.sh [--lines N] [--limit N]
"""

import json
import re
import sys
import argparse
from datetime import datetime, timedelta
from collections import Counter, defaultdict
from pathlib import Path

# ─── Constants ───────────────────────────────────────────────────────────────

TOOL_ORDER = [
    "search_artwork",
    "inspect_artwork_image",
    "get_artwork_image",
    "navigate_viewer",
    "list_curated_sets",
    "get_artwork_details",
    "lookup_iconclass",
    "semantic_search",
    "get_artist_timeline",
    "browse_set",
    "get_recent_changes",
    "get_artwork_bibliography",
    "open_in_browser",
    "poll_viewer_commands",
]

SESSION_GAP_MINUTES = 30

STARTUP_PATTERNS = [
    "Vocabulary DB loaded",
    "Iconclass DB loaded",
    "Embeddings DB",
    "Embedding model loaded",
    "listening on",
    "pre-warmed",
    "Top artwork",
    "Downloading",
    "Starting Container",
]

# Search-input keys worth surfacing in summaries (order = display priority).
SEARCH_KEYS = [
    "subject", "creator", "depictedPerson", "depictedPlace",
    "productionPlace", "description", "curatorialNarrative",
    "inscription", "query", "iconclass", "collectionSet",
    "type", "material", "technique", "creationDate",
    "nearPlace", "creditLine", "provenance", "productionRole",
    "aboutActor", "title",
]


# ─── Data loading ────────────────────────────────────────────────────────────

def parse_ts(ts_str):
    """Parse ISO 8601 timestamp to timezone-aware UTC datetime."""
    ts = re.sub(r"(\.\d{6})\d*Z$", r"\1+00:00", ts_str)
    ts = ts.replace("Z", "+00:00")
    return datetime.fromisoformat(ts)


def load_logs(path):
    """Load a JSONL log file. Skips malformed lines."""
    logs = []
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if not line:
            continue
        try:
            logs.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return logs


def extract_tool_calls(logs):
    """Extract and sort tool call entries from logs."""
    calls = []
    for log in logs:
        if "tool" not in log:
            continue
        try:
            ts = parse_ts(log["timestamp"])
        except (KeyError, ValueError):
            continue
        inp = log.get("input", {})
        if isinstance(inp, str):
            try:
                inp = json.loads(inp)
            except json.JSONDecodeError:
                inp = {}
        calls.append({
            "ts": ts,
            "tool": log["tool"],
            "ms": int(float(log.get("ms", 0))),
            "ok": log.get("ok", True),
            "input": inp if isinstance(inp, dict) else {},
        })
    calls.sort(key=lambda c: c["ts"])
    return calls


def extract_startup_events(logs):
    """Extract startup-related log messages."""
    events = []
    for log in logs:
        msg = log.get("message", "")
        if any(p in msg for p in STARTUP_PATTERNS):
            try:
                events.append({"ts": parse_ts(log["timestamp"]), "message": msg})
            except (KeyError, ValueError):
                continue
    events.sort(key=lambda e: e["ts"])
    return events


# ─── Statistics ──────────────────────────────────────────────────────────────

def pct(values, p):
    """Percentile (p in 0-100). Returns 0 for empty list."""
    if not values:
        return 0
    vs = sorted(values)
    return vs[min(int(len(vs) * p / 100), len(vs) - 1)]


def latency_stats(values):
    if not values:
        return {k: 0 for k in ("min", "p50", "p90", "p99", "max", "count")}
    vs = sorted(values)
    return {
        "min": vs[0], "p50": pct(vs, 50), "p90": pct(vs, 90),
        "p99": pct(vs, 99), "max": vs[-1], "count": len(vs),
    }


# ─── Session identification ─────────────────────────────────────────────────

def identify_sessions(calls):
    """Group calls into sessions separated by >SESSION_GAP_MINUTES silence."""
    if not calls:
        return []
    groups = [[calls[0]]]
    for c in calls[1:]:
        if (c["ts"] - groups[-1][-1]["ts"]) > timedelta(minutes=SESSION_GAP_MINUTES):
            groups.append([])
        groups[-1].append(c)

    sessions = []
    for i, group in enumerate(groups):
        tools = Counter(c["tool"] for c in group)
        duration = group[-1]["ts"] - group[0]["ts"]
        artworks = Counter()
        for c in group:
            on = c["input"].get("objectNumber")
            if on:
                artworks[on] += 1
        sessions.append({
            "index": i + 1,
            "calls": group,
            "start": group[0]["ts"],
            "end": group[-1]["ts"],
            "duration": duration,
            "count": len(group),
            "tools": tools,
            "slow": [c for c in group if c["ms"] > 2000],
            "errors": [c for c in group if not c["ok"]],
            "classification": _classify(group, tools, duration),
            "artworks": artworks,
            "topics": _extract_topics(group),
        })
    return sessions


def _classify(calls, tools, duration):
    """Auto-classify session type."""
    first_inputs = " ".join(json.dumps(c["input"]) for c in calls[:5])
    if "Gesina ter Borch" in first_inputs:
        return "warm-cache"
    if len(tools) >= 8 and len(calls) >= 50 and duration < timedelta(minutes=20):
        return "warm-cache"
    inspect = tools.get("inspect_artwork_image", 0)
    navigate = tools.get("navigate_viewer", 0)
    if inspect + navigate > 10:
        return "visual-analysis"
    if tools.get("lookup_iconclass", 0) > 5:
        return "iconclass-exploration"
    if tools.get("semantic_search", 0) > 3:
        return "concept-search"
    if len(calls) <= 5 and duration < timedelta(minutes=5):
        return "quick-lookup"
    return "browsing"


def _extract_topics(calls):
    """Extract unique search topics from session calls."""
    seen, topics = set(), []

    def _add(t):
        if t not in seen:
            seen.add(t)
            topics.append(t)

    for c in calls:
        inp = c["input"]
        for key in ("subject", "creator", "depictedPerson", "depictedPlace",
                     "productionPlace"):
            if key in inp:
                _add(f'{key}: "{inp[key]}"')
        if c["tool"] == "semantic_search" and "query" in inp:
            q = inp["query"]
            _add(f'semantic: "{q[:60]}"')
        if c["tool"] == "inspect_artwork_image" and "objectNumber" in inp:
            _add(f'inspected: {inp["objectNumber"]}')
    return topics[:20]


# ─── Helpers ─────────────────────────────────────────────────────────────────

def fmt_dur(td):
    """Format timedelta as 'Xh Ym' or 'Xm Ys'."""
    s = int(td.total_seconds())
    if s >= 3600:
        return f"{s // 3600}h {(s % 3600) // 60}m"
    return f"{s // 60}m {s % 60}s"


def summarize_input(c):
    """Concise human-readable summary of a tool call's input."""
    inp, tool = c["input"], c["tool"]
    if tool == "semantic_search":
        parts = [f'"{inp.get("query", "")[:60]}"']
        if "type" in inp:
            parts.append(f'type:{inp["type"]}')
        if "creationDate" in inp:
            parts.append(f'date:{inp["creationDate"]}')
        if inp.get("maxResults", 25) != 25:
            parts.append(f'max:{inp["maxResults"]}')
        return ", ".join(parts)
    if tool == "search_artwork":
        parts = []
        for key in SEARCH_KEYS:
            if key in inp:
                parts.append(f'{key}:"{inp[key]}"')
        if inp.get("compact"):
            parts.append("compact")
        if inp.get("maxResults", 25) != 25:
            parts.append(f'max:{inp["maxResults"]}')
        return ", ".join(parts) or json.dumps(inp)[:100]
    if tool in ("inspect_artwork_image", "get_artwork_image",
                "get_artwork_details", "get_artwork_bibliography"):
        on = inp.get("objectNumber", "?")
        extras = []
        if "region" in inp and inp["region"] != "full":
            extras.append(inp["region"])
        if inp.get("quality") == "gray":
            extras.append("gray")
        return f"{on} ({', '.join(extras)})" if extras else on
    if tool == "lookup_iconclass":
        for key in ("query", "semanticQuery", "notation"):
            if key in inp:
                return f'{key}:"{inp[key]}"'
    if tool == "get_artist_timeline":
        return inp.get("artist", "?")
    if tool == "browse_set":
        return f'set:{inp.get("setSpec", "?")}'
    return json.dumps(inp)[:100]


def _brief_input(tool, inp):
    """Very short input summary for cache table."""
    if tool == "semantic_search":
        q = inp.get("query", "")[:30]
        return f'("{q}...")'
    if tool in ("get_artwork_image", "get_artwork_details", "inspect_artwork_image"):
        return f'({inp.get("objectNumber", "?")})'
    if tool == "list_curated_sets":
        q = inp.get("query", "")
        return f'("{q}")' if q else "(all)"
    if tool == "search_artwork":
        for k in ("subject", "creator", "query", "depictedPerson"):
            if k in inp:
                return f'({k}:"{inp[k][:25]}")'
    return ""


def _warm_cache_ranges(sessions):
    """Return list of (start, end) for warm-cache sessions."""
    return [(s["start"], s["end"]) for s in sessions
            if s["classification"] == "warm-cache"]


def _is_in_warm_cache(ts, wc_ranges):
    return any(s <= ts <= e for s, e in wc_ranges)


# ─── Section 1: Traffic Summary ─────────────────────────────────────────────

def section_1(calls, sessions):
    out = ["## 1. Traffic Summary\n"]
    out.append("| Tool | Calls | Errors | Min ms | Median ms | Max ms |")
    out.append("|------|-------|--------|--------|-----------|--------|")
    total_calls = total_errors = 0
    for tool in TOOL_ORDER:
        tc = [c for c in calls if c["tool"] == tool]
        if not tc:
            continue
        ms = [c["ms"] for c in tc]
        errs = sum(1 for c in tc if not c["ok"])
        total_calls += len(tc)
        total_errors += errs
        out.append(
            f"| `{tool}` | {len(tc)} | {errs} "
            f"| {min(ms):,} | ~{pct(ms, 50):,} | {max(ms):,} |"
        )
    rate = f"{100 * total_errors / total_calls:.2f}" if total_calls else "0.00"
    out.append(
        f"\n**{total_calls:,} tool calls total, {total_errors} "
        f"error{'s' if total_errors != 1 else ''}.** Error rate: {rate}%.\n"
    )
    wc_calls = sum(s["count"] for s in sessions if s["classification"] == "warm-cache")
    wc_n = sum(1 for s in sessions if s["classification"] == "warm-cache")
    org_n = len(sessions) - wc_n
    out.append(
        f"Sessions: {len(sessions)} ({wc_n} warm-cache, {org_n} organic). "
        f"Warm-cache calls: {wc_calls} "
        f"({100 * wc_calls // max(total_calls, 1)}% of traffic).\n"
    )
    return "\n".join(out)


# ─── Section 2: Performance ─────────────────────────────────────────────────

def section_2(calls, startup_events):
    out = ["## 2. Performance\n"]

    # Percentile table
    out.append("### Latency Percentiles\n")
    out.append("| Tool | p50 | p90 | p99 | Max | Count |")
    out.append("|------|-----|-----|-----|-----|-------|")
    for tool in TOOL_ORDER:
        ms = [c["ms"] for c in calls if c["tool"] == tool]
        if not ms:
            continue
        s = latency_stats(ms)
        out.append(
            f"| `{tool}` | {s['p50']:,} | {s['p90']:,} "
            f"| {s['p99']:,} | {s['max']:,} | {s['count']} |"
        )
    out.append("")

    # Semantic search breakdown
    sem = [c for c in calls if c["tool"] == "semantic_search"]
    if sem:
        out.append("### Semantic Search Breakdown\n")
        out.append(f"{len(sem)} calls total.\n")
        filtered = [c for c in sem
                    if "type" in c["input"] or "creationDate" in c["input"]]
        unfiltered = [c for c in sem if c not in filtered]
        cold = sorted([c for c in sem if c["ms"] > 10000], key=lambda c: c["ts"])

        if filtered:
            fms = [c["ms"] for c in filtered]
            out.append(
                f"- **Filtered** ({len(filtered)}): "
                f"p50 = {pct(fms, 50):,}ms, max = {max(fms):,}ms"
            )
        if unfiltered:
            ums = [c["ms"] for c in unfiltered]
            out.append(
                f"- **Unfiltered** ({len(unfiltered)}): "
                f"p50 = {pct(ums, 50):,}ms, max = {max(ums):,}ms"
            )
        if cold:
            out.append(
                f"- **Cold outliers >10s** ({len(cold)}): "
                "likely first-after-restart\n"
            )
            out.append("| Time | ms | Query |")
            out.append("|------|-----|-------|")
            for c in cold:
                q = c["input"].get("query", "")[:60]
                out.append(
                    f'| {c["ts"].strftime("%b %d %H:%M")} '
                    f'| {c["ms"]:,} | "{q}" |'
                )
        out.append("")

    # Slow queries (>5s)
    slow = sorted([c for c in calls if c["ms"] > 5000], key=lambda c: -c["ms"])
    if slow:
        out.append("### Slow Queries (>5s)\n")
        out.append("| Tool | ms | Input |")
        out.append("|------|-----|-------|")
        for c in slow[:15]:
            out.append(
                f"| `{c['tool']}` | {c['ms']:,} | {summarize_input(c)} |"
            )
        out.append("")

    # Startup health
    starts = [e for e in startup_events if "Starting Container" in e["message"]]
    listens = [e for e in startup_events if "listening on" in e["message"]]
    prewarms = [e for e in startup_events if "Vocab cache pre-warmed" in e["message"]]

    out.append("### Startup Health\n")
    out.append(f"{len(starts)} container starts observed.\n")

    if prewarms:
        pw_times = []
        for pw in prewarms:
            m = re.search(r"in (\d+)ms", pw["message"])
            if m:
                pw_times.append(int(m.group(1)))
        if pw_times:
            out.append(
                f"- Vocab pre-warm: {min(pw_times):,}–{max(pw_times):,}ms "
                f"(p50: {pct(pw_times, 50):,}ms)"
            )

    if starts and listens:
        boot_times = []
        for s in starts:
            for l in listens:
                if l["ts"] > s["ts"]:
                    boot_times.append((l["ts"] - s["ts"]).total_seconds())
                    break
        if boot_times:
            out.append(
                f"- Start → listening: {min(boot_times):.0f}–{max(boot_times):.0f}s"
            )

    downloads = [e for e in startup_events if "Downloading" in e["message"]]
    if downloads:
        out.append(f"- DB downloads: {len(downloads)} (cold start with download)")
    else:
        out.append("- No DB downloads (all databases already on volume)")

    if len(starts) > 1:
        first, last = starts[0]["ts"], starts[-1]["ts"]
        span_h = (last - first).total_seconds() / 3600
        if span_h > 0:
            out.append(
                f"- Container cycling: ~1 every {span_h / (len(starts) - 1):.1f}h"
            )

    out.append("")
    return "\n".join(out)


# ─── Section 3: Errors ──────────────────────────────────────────────────────

def section_3(calls):
    out = ["## 3. Errors\n"]
    errors = [c for c in calls if not c["ok"]]
    if not errors:
        out.append(f"**Zero errors** across {len(calls):,} tool calls.\n")
        return "\n".join(out)

    out.append(
        f"**{len(errors)} error{'s' if len(errors) != 1 else ''}** "
        f"in {len(calls):,} calls ({100 * len(errors) / len(calls):.2f}%).\n"
    )
    for c in errors:
        out.append(
            f"- `{c['tool']}` at {c['ts'].strftime('%b %d %H:%M')}: "
            f"{summarize_input(c)}"
        )
    out.append("")
    return "\n".join(out)


# ─── Section 4: Usage Patterns & Sessions ────────────────────────────────────

def section_4(sessions):
    out = [
        "## 4. Usage Patterns & Sessions\n",
        f"{len(sessions)} distinct sessions identified by "
        f">{SESSION_GAP_MINUTES}-minute gaps.\n",
        "_Session classification is automated. "
        "Add narrative descriptions for notable sessions._\n",
    ]

    current_date = None
    for s in sessions:
        date_str = s["start"].strftime("%b %d")
        if date_str != current_date:
            current_date = date_str
            day_sessions = [
                x for x in sessions if x["start"].strftime("%b %d") == date_str
            ]
            day_calls = sum(x["count"] for x in day_sessions)
            out.append(
                f"### {date_str} "
                f"({len(day_sessions)} session{'s' if len(day_sessions) != 1 else ''}, "
                f"{day_calls} calls)\n"
            )

        cls_label = s["classification"].replace("-", " ").title()
        # Handle midnight-crossing sessions
        if s["start"].date() != s["end"].date():
            time_range = (
                f'{s["start"].strftime("%b %d %H:%M")}–'
                f'{s["end"].strftime("%b %d %H:%M")} UTC'
            )
        else:
            time_range = (
                f'{s["start"].strftime("%H:%M")}–'
                f'{s["end"].strftime("%H:%M")} UTC'
            )
        out.append(
            f"**{s['index']}. {cls_label}** "
            f"({time_range}, {s['count']} calls, {fmt_dur(s['duration'])})"
        )

        # Tool breakdown
        tool_str = ", ".join(f"{t}:{n}" for t, n in s["tools"].most_common())
        out.append(f"\nTools: {tool_str}")

        if s["slow"]:
            out.append(f"Slow (>2s): {len(s['slow'])} calls")
        if s["errors"]:
            out.append(f"Errors: {len(s['errors'])}")
        if s["artworks"]:
            top_art = ", ".join(
                f"{on} ({n})" for on, n in s["artworks"].most_common(5)
            )
            out.append(f"Artworks: {top_art}")

        # Topics
        if s["topics"]:
            out.append("\nKey queries:")
            for t in s["topics"][:10]:
                out.append(f"- {t}")

        # Auto-description for warm-cache sessions
        if s["classification"] == "warm-cache":
            out.append(
                f"\n_Auto: Standard warm-cache validation run "
                f"exercising {len(s['tools'])} tool types._"
            )

        out.append("")

    return "\n".join(out)


# ─── Section 5: Tool-Specific Observations ──────────────────────────────────

def section_5(calls):
    out = ["## 5. Tool-Specific Observations\n"]

    # inspect_artwork_image
    inspect = [c for c in calls if c["tool"] == "inspect_artwork_image"]
    if inspect:
        out.append(f"### inspect_artwork_image ({len(inspect)} calls)\n")
        art_counts = Counter(c["input"].get("objectNumber", "?") for c in inspect)
        out.append(f"- **{len(art_counts)} unique artworks** inspected")
        top = art_counts.most_common(5)
        if top:
            out.append(
                "- Most inspected: "
                + ", ".join(f"{on} ({n})" for on, n in top)
            )
        full = [c for c in inspect if c["input"].get("region") == "full"]
        crop = [c for c in inspect if c not in full]
        if full:
            out.append(
                f"- Full image: {len(full)} calls, "
                f"p50 = {pct([c['ms'] for c in full], 50):,}ms"
            )
        if crop:
            out.append(
                f"- Cropped region: {len(crop)} calls, "
                f"p50 = {pct([c['ms'] for c in crop], 50):,}ms"
            )
        gray = [c for c in inspect if c["input"].get("quality") == "gray"]
        out.append(
            f"- Grayscale mode: "
            f"{'used ' + str(len(gray)) + ' times' if gray else 'never used'}"
        )
        sizes = [c["input"].get("size", 1200) for c in inspect]
        out.append(f"- Size range: {min(sizes)}–{max(sizes)}px")
        out.append("")

    # navigate_viewer
    nav = [c for c in calls if c["tool"] == "navigate_viewer"]
    if nav:
        out.append(f"### navigate_viewer ({len(nav)} calls)\n")
        out.append(
            f"- All calls ≤{max(c['ms'] for c in nav)}ms "
            "(queue push, near-instant)"
        )
        overlay_add = sum(
            1 for c in nav
            for cmd in (c["input"].get("commands") or [])
            if cmd.get("action") == "add_overlay"
        )
        overlay_clear = sum(
            1 for c in nav
            for cmd in (c["input"].get("commands") or [])
            if cmd.get("action") == "clear_overlays"
        )
        navigate_cmds = sum(
            1 for c in nav
            for cmd in (c["input"].get("commands") or [])
            if cmd.get("action") == "navigate"
        )
        out.append(
            f"- Commands: {navigate_cmds} navigate, "
            f"{overlay_add} add_overlay, {overlay_clear} clear_overlays"
        )
        # Extract overlay colours
        colours = Counter(
            cmd.get("color", "orange")
            for c in nav
            for cmd in (c["input"].get("commands") or [])
            if cmd.get("action") == "add_overlay"
        )
        if colours:
            out.append(
                "- Overlay colours: "
                + ", ".join(f"{col} ({n})" for col, n in colours.most_common())
            )
        out.append("")

    # semantic_search
    sem = [c for c in calls if c["tool"] == "semantic_search"]
    if sem:
        out.append(f"### semantic_search ({len(sem)} calls)\n")
        queries = set(c["input"].get("query", "") for c in sem)
        out.append(f"- {len(queries)} unique queries")
        mr = Counter(c["input"].get("maxResults", 25) for c in sem)
        mr_str = ", ".join(f"{v}({n})" for v, n in sorted(mr.items()))
        out.append(f"- maxResults distribution: {mr_str}")
        out.append("")

    # lookup_iconclass
    ic = [c for c in calls if c["tool"] == "lookup_iconclass"]
    if ic:
        out.append(f"### lookup_iconclass ({len(ic)} calls)\n")
        keyword = sum(1 for c in ic if "query" in c["input"])
        semantic = sum(1 for c in ic if "semanticQuery" in c["input"])
        notation = sum(1 for c in ic if "notation" in c["input"])
        out.append(
            f"- Keyword: {keyword}, semantic: {semantic}, "
            f"notation browse: {notation}"
        )
        out.append("")

    # get_artist_timeline
    at = [c for c in calls if c["tool"] == "get_artist_timeline"]
    if at:
        out.append(f"### get_artist_timeline ({len(at)} calls)\n")
        artists = Counter(c["input"].get("artist", "?") for c in at)
        out.append(
            "- Artists: "
            + ", ".join(f"{a} ({n})" for a, n in artists.most_common(5))
        )
        out.append("")

    return "\n".join(out)


# ─── Section 6: Caching & Performance Patterns ──────────────────────────────

def section_6(calls):
    out = ["## 6. Caching & Performance Patterns\n"]

    # Cache hits
    groups = defaultdict(list)
    for c in calls:
        key = (c["tool"], json.dumps(c["input"], sort_keys=True))
        groups[key].append(c["ms"])

    cache_hits = []
    for (tool, inp_str), times in groups.items():
        if len(times) >= 2 and times[0] > 50:
            ratio = times[0] / max(times[1], 1)
            if ratio > 3:
                cache_hits.append(
                    (tool, json.loads(inp_str), times[0], times[1], ratio)
                )
    cache_hits.sort(key=lambda x: -x[4])

    if cache_hits:
        out.append("### Response Cache Hits\n")
        out.append("| Pattern | First | Repeat | Speedup |")
        out.append("|---------|-------|--------|---------|")
        for tool, inp, first, repeat, ratio in cache_hits[:10]:
            label = f"`{tool}` {_brief_input(tool, inp)}"
            out.append(f"| {label} | {first:,}ms | {repeat:,}ms | {ratio:.0f}× |")
        out.append("")

    # search_artwork bimodal latency
    sa = [c for c in calls if c["tool"] == "search_artwork"]
    if sa:
        out.append("### search_artwork Bimodal Latency\n")
        fast = [c for c in sa if c["ms"] <= 50]
        slow = [c for c in sa if c["ms"] > 500]
        mid = [c for c in sa if 50 < c["ms"] <= 500]
        out.append("| Category | Calls | % |")
        out.append("|----------|-------|---|")
        for label, group in [
            ("Search API (≤50ms)", fast),
            ("Vocab DB (>500ms)", slow),
            ("Middle (50–500ms)", mid),
        ]:
            out.append(
                f"| {label} | {len(group)} "
                f"| {100 * len(group) // len(sa)}% |"
            )
        out.append("")

    # Semantic search cold vs warm
    sem = [c for c in calls if c["tool"] == "semantic_search"]
    if sem:
        out.append("### Semantic Search: Cold vs Warm\n")
        cold = [c for c in sem if c["ms"] > 10000]
        filtered = [c for c in sem
                    if c not in cold
                    and ("type" in c["input"] or "creationDate" in c["input"])]
        warm_unfiltered = [c for c in sem
                          if c not in cold and c not in filtered]
        out.append("| Category | Calls | p50 | Max |")
        out.append("|----------|-------|-----|-----|")
        for label, group in [
            ("First after restart (cold)", cold),
            ("Warm, unfiltered", warm_unfiltered),
            ("Warm, filtered", filtered),
        ]:
            if group:
                ms = [c["ms"] for c in group]
                out.append(
                    f"| {label} | {len(group)} "
                    f"| {pct(ms, 50):,}ms | {max(ms):,}ms |"
                )
        out.append("")

    return "\n".join(out)


# ─── Section 7: Recommendations ─────────────────────────────────────────────

def section_7(calls, sessions, startup_events):
    out = ["## 7. Recommendations\n"]
    recs_high, recs_med, recs_low = [], [], []

    # Cold semantic outliers
    sem_cold = [c for c in calls
                if c["tool"] == "semantic_search" and c["ms"] > 10000]
    if sem_cold:
        recs_high.append(
            f"**Pre-warm embeddings DB mmap pages** — {len(sem_cold)} semantic "
            f"search calls exceeded 10s (all first-after-restart). A dummy "
            f"semantic query during startup would eliminate these cold spikes."
        )

    # Container cycling
    starts = [e for e in startup_events if "Starting Container" in e["message"]]
    if len(starts) > 3:
        span_h = (starts[-1]["ts"] - starts[0]["ts"]).total_seconds() / 3600
        avg = span_h / (len(starts) - 1) if len(starts) > 1 else 0
        if avg < 12:
            recs_med.append(
                f"**Monitor container cycling** — {len(starts)} restarts "
                f"(~1 every {avg:.1f}h). Investigate if idle-timeout or "
                f"resource-based. Frequent restarts amplify cold-page costs."
            )

    # Errors
    errors = [c for c in calls if not c["ok"]]
    if errors:
        top = Counter(c["tool"] for c in errors).most_common(1)[0]
        recs_high.append(
            f"**Investigate `{top[0]}` errors** — {top[1]} failures. "
            f"Check error messages in raw logs."
        )

    # Grayscale mode
    inspect = [c for c in calls if c["tool"] == "inspect_artwork_image"]
    if inspect and not any(c["input"].get("quality") == "gray" for c in inspect):
        recs_med.append(
            f'**Promote `quality:"gray"`** — 0/{len(inspect)} inspect calls '
            f"used grayscale. Add an explicit inscription-reading example "
            f"to the tool description."
        )

    # Slow search_artwork
    slow_sa = [c for c in calls
               if c["tool"] == "search_artwork" and c["ms"] > 5000]
    if slow_sa:
        recs_med.append(
            f"**{len(slow_sa)} search_artwork calls >5s** — investigate "
            f"subject term cardinality or cross-filter optimizations."
        )

    # get_artist_timeline organic usage
    at = [c for c in calls if c["tool"] == "get_artist_timeline"]
    wc_ranges = _warm_cache_ranges(sessions)
    at_organic = [c for c in at if not _is_in_warm_cache(c["ts"], wc_ranges)]
    if at and not at_organic:
        recs_low.append(
            f"**`get_artist_timeline` no organic use** — all {len(at)} calls "
            f"from warm-cache runs."
        )
    elif at_organic:
        recs_low.append(
            f"**`get_artist_timeline` organic use confirmed** — "
            f"{len(at_organic)} call{'s' if len(at_organic) != 1 else ''}."
        )

    # Error-free note
    if not errors:
        recs_low.append("**Error rate at 0%** — no action needed.")

    # Output
    idx = 1
    if recs_high:
        out.append("### High impact\n")
        for r in recs_high:
            out.append(f"{idx}. {r}\n")
            idx += 1
    if recs_med:
        out.append("### Medium impact\n")
        for r in recs_med:
            out.append(f"{idx}. {r}\n")
            idx += 1
    if recs_low:
        out.append("### Low impact / monitoring\n")
        for r in recs_low:
            out.append(f"{idx}. {r}\n")
            idx += 1

    return "\n".join(out)


# ─── Appendix ────────────────────────────────────────────────────────────────

def section_appendix(calls, logs, sessions):
    out = ["## Appendix: Raw Statistics\n", "```"]

    timestamps = []
    for log in logs:
        try:
            timestamps.append(parse_ts(log["timestamp"]))
        except (KeyError, ValueError):
            continue
    if timestamps:
        out.append(
            f"Time range: {min(timestamps).strftime('%Y-%m-%dT%H:%M:%SZ')} to "
            f"{max(timestamps).strftime('%Y-%m-%dT%H:%M:%SZ')}"
        )
    out.append(f"Total log lines: {len(logs):,}")
    out.append(f"Tool call lines: {len(calls):,}")
    errors = sum(1 for c in calls if not c["ok"])
    out.append(f"Error rate: {100 * errors / max(len(calls), 1):.2f}% ({errors}/{len(calls)})")
    wc = sum(1 for s in sessions if s["classification"] == "warm-cache")
    out.append(f"Sessions: {len(sessions)} ({wc} warm-cache, {len(sessions) - wc} organic)")
    out.append("")
    out.append("Tool call distribution:")
    tool_counts = Counter(c["tool"] for c in calls)
    for tool in TOOL_ORDER:
        if tool in tool_counts:
            p = 100 * tool_counts[tool] / len(calls)
            out.append(f"  {tool_counts[tool]:>5} {tool:<30s} ({p:.1f}%)")

    all_art = set()
    for c in calls:
        on = c["input"].get("objectNumber")
        if on:
            all_art.add(on)
    out.append(f"\nUnique artworks accessed: {len(all_art)}")

    inspect_counts = Counter(
        c["input"].get("objectNumber", "?")
        for c in calls if c["tool"] == "inspect_artwork_image"
    )
    if inspect_counts:
        out.append(
            "Most inspected: "
            + ", ".join(f"{on} ({n})" for on, n in inspect_counts.most_common(5))
        )

    out.append("```")
    return "\n".join(out)


# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Analyse Railway deployment logs → markdown report."
    )
    parser.add_argument("input", help="Path to JSONL log file")
    parser.add_argument(
        "-o", "--output", help="Write report to file (default: stdout)"
    )
    args = parser.parse_args()

    print(f"Loading {args.input}...", file=sys.stderr)
    logs = load_logs(args.input)
    if not logs:
        print(f"No log lines found in {args.input}", file=sys.stderr)
        sys.exit(1)

    calls = extract_tool_calls(logs)
    if not calls:
        print(
            f"No tool calls found in {len(logs)} log lines. "
            "Only startup/infrastructure logs present.",
            file=sys.stderr,
        )
        sys.exit(1)

    startup = extract_startup_events(logs)
    sessions = identify_sessions(calls)
    print(
        f"  {len(calls)} tool calls, {len(sessions)} sessions, "
        f"{len(startup)} startup events",
        file=sys.stderr,
    )

    # Report header
    first_ts, last_ts = calls[0]["ts"], calls[-1]["ts"]
    span = last_ts - first_ts
    span_days = span.days + span.seconds / 86400

    header = "\n".join([
        f"# Railway Log Analysis: "
        f"{first_ts.strftime('%Y-%m-%d')} to {last_ts.strftime('%Y-%m-%d')}\n",
        f"**Coverage:** {first_ts.strftime('%Y-%m-%dT%H:%MZ')} to "
        f"{last_ts.strftime('%Y-%m-%dT%H:%MZ')} (~{span_days:.1f} days)",
        f"**Source:** `railway logs --json` via analyse-railway-logs.sh",
        f"**Next analysis should start from:** "
        f"{last_ts.strftime('%Y-%m-%dT%H:%MZ')}\n",
        "---\n",
    ])

    sections = [
        header,
        section_1(calls, sessions),
        "---\n",
        section_2(calls, startup),
        "---\n",
        section_3(calls),
        "---\n",
        section_4(sessions),
        "---\n",
        section_5(calls),
        "---\n",
        section_6(calls),
        "---\n",
        section_7(calls, sessions, startup),
        "---\n",
        section_appendix(calls, logs, sessions),
    ]

    report = "\n".join(sections)

    if args.output:
        Path(args.output).write_text(report, encoding="utf-8")
        print(f"Report written to {args.output}", file=sys.stderr)
    else:
        print(report)


if __name__ == "__main__":
    main()
