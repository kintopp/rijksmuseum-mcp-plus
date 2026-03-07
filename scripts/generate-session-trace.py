#!/usr/bin/env python3
"""Generate debug traces from Claude Desktop MCP logs.

Parses the MCP server log file written by Claude Desktop at
~/Library/Logs/Claude/mcp-server-<name>.log, matches JSON-RPC
requests with responses, groups tool calls into sessions, and
outputs structured markdown traces.

Usage:
    # List sessions in a log file
    python3 scripts/generate-session-trace.py ~/Library/Logs/Claude/mcp-server-rijksmuseum.log --list

    # Generate trace for most recent session
    python3 scripts/generate-session-trace.py ~/Library/Logs/Claude/mcp-server-rijksmuseum.log

    # Generate trace for a specific session by index
    python3 scripts/generate-session-trace.py ~/Library/Logs/Claude/mcp-server-rijksmuseum.log --session 3

    # Generate trace for a specific date
    python3 scripts/generate-session-trace.py ~/Library/Logs/Claude/mcp-server-rijksmuseum.log --date 2026-03-07

    # Write to file
    python3 scripts/generate-session-trace.py ~/Library/Logs/Claude/mcp-server-rijksmuseum.log -o trace.md

    # Batch: generate one trace per session, auto-named
    python3 scripts/generate-session-trace.py ... --batch --output-dir ./traces

    # Period filtering (sugar for --since)
    python3 scripts/generate-session-trace.py ... --period daily --batch --output-dir ./traces
    python3 scripts/generate-session-trace.py ... --period weekly --list
    python3 scripts/generate-session-trace.py ... --since 2026-03-01 --until 2026-03-07 --batch

    # Incremental: only sessions since last run
    python3 scripts/generate-session-trace.py ... --since last --batch --output-dir ./traces

    # Include poll_viewer_commands (collapsed by default)
    python3 scripts/generate-session-trace.py ... --include-polls

    # Show full result payloads (truncated by default)
    python3 scripts/generate-session-trace.py ... --full-results
"""

import json
import re
import sys
import argparse
from datetime import datetime, timedelta, timezone
from pathlib import Path

# ── Constants ────────────────────────────────────────────────────────────────

SESSION_GAP_MINUTES = 30
RESULT_TRUNCATE_LEN = 1200      # chars of result text to show
BASE64_TRUNCATE_LEN = 40        # chars of base64 data to show
POLL_TOOL = "poll_viewer_commands"
WATERMARK_FILE = ".trace-watermark.json"
PERIOD_DAYS = {"daily": 1, "weekly": 7, "monthly": 30}


# ── Watermark ────────────────────────────────────────────────────────────────

def load_watermark(output_dir):
    """Load the last-run watermark from the output directory."""
    p = Path(output_dir) / WATERMARK_FILE
    if p.exists():
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            return datetime.fromisoformat(data["last_session_end"])
        except (json.JSONDecodeError, KeyError, ValueError):
            pass
    return None


def save_watermark(output_dir, last_session_end):
    """Save watermark after a successful batch run."""
    p = Path(output_dir) / WATERMARK_FILE
    p.write_text(json.dumps({
        "last_run": datetime.now(timezone.utc).isoformat(),
        "last_session_end": last_session_end.isoformat(),
    }, indent=2), encoding="utf-8")


def resolve_since(since_str, output_dir):
    """Resolve --since value to a datetime.

    Accepts 'last' (read watermark), 'YYYY-MM-DD', or ISO datetime.
    """
    if since_str == "last":
        wm = load_watermark(output_dir or ".")
        if wm is None:
            print("No watermark found — processing all sessions.", file=sys.stderr)
            return None
        print(f"  Watermark: since {wm.strftime('%Y-%m-%d %H:%M')} UTC",
              file=sys.stderr)
        return wm
    try:
        if len(since_str) == 10:  # YYYY-MM-DD
            return datetime.fromisoformat(since_str + "T00:00:00+00:00")
        return datetime.fromisoformat(since_str.replace("Z", "+00:00"))
    except ValueError:
        print(f"Invalid --since value: {since_str}", file=sys.stderr)
        sys.exit(1)


def resolve_until(until_str):
    """Resolve --until value to a datetime (end of day)."""
    try:
        if len(until_str) == 10:
            return datetime.fromisoformat(until_str + "T23:59:59+00:00")
        return datetime.fromisoformat(until_str.replace("Z", "+00:00"))
    except ValueError:
        print(f"Invalid --until value: {until_str}", file=sys.stderr)
        sys.exit(1)


def filter_sessions(sessions, since=None, until=None):
    """Filter sessions by date range."""
    filtered = sessions
    if since:
        filtered = [s for s in filtered if s[0]["ts"] >= since]
    if until:
        filtered = [s for s in filtered if s[0]["ts"] <= until]
    return filtered

# Tools to skip in the trace (meta-protocol, not user-facing)
META_METHODS = {"initialize", "notifications/initialized", "tools/list",
                "prompts/list", "resources/list", "resources/read",
                "prompts/get"}

# Log line regex: timestamp [server] [level] Message from {client|server}: {JSON} { metadata: ... }
LOG_RE = re.compile(
    r"^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+"  # timestamp
    r"\[([^\]]+)\]\s+"                     # server name
    r"\[(\w+)\]\s+"                        # level
    r"Message from (client|server):\s+"    # direction
    r"(.+?)\s+\{\s*metadata:.*$"           # JSON payload + metadata suffix
)


# ── Parsing ──────────────────────────────────────────────────────────────────

def parse_ts(ts_str):
    ts = ts_str.replace("Z", "+00:00")
    return datetime.fromisoformat(ts)


def parse_log(path):
    """Parse MCP log file into a list of structured messages."""
    messages = []
    for line in open(path, encoding="utf-8"):
        m = LOG_RE.match(line.strip())
        if not m:
            continue
        ts_str, server, level, direction, payload_str = m.groups()
        try:
            payload = json.loads(payload_str)
        except json.JSONDecodeError:
            continue
        messages.append({
            "ts": parse_ts(ts_str),
            "server": server,
            "direction": direction,
            "payload": payload,
        })
    return messages


def match_calls(messages):
    """Match tools/call requests with their responses by JSON-RPC id.

    Returns a list of matched call records sorted by request timestamp.
    """
    # Index: id -> request message (within each server session)
    # Server restarts reset IDs, so we track by (server_start_index, id)
    requests = {}   # id -> request msg
    responses = {}  # id -> response msg
    calls = []

    # Track server sessions by looking at initialize calls
    session_offset = 0
    for msg in messages:
        p = msg["payload"]
        method = p.get("method", "")
        msg_id = p.get("id")

        if method == "initialize" and msg["direction"] == "client":
            # New server session — reset ID tracking
            session_offset += 1
            requests.clear()
            responses.clear()

        if msg["direction"] == "client" and method == "tools/call" and msg_id is not None:
            requests[msg_id] = msg
        elif msg["direction"] == "server" and "result" in p and msg_id is not None:
            if msg_id in requests:
                req = requests.pop(msg_id)
                params = req["payload"].get("params", {})
                tool = params.get("name", "unknown")
                args = params.get("arguments", {})
                latency_ms = int((msg["ts"] - req["ts"]).total_seconds() * 1000)
                result = p.get("result", {})

                calls.append({
                    "ts": req["ts"],
                    "ts_response": msg["ts"],
                    "tool": tool,
                    "args": args,
                    "result": result,
                    "latency_ms": latency_ms,
                    "rpc_id": msg_id,
                    "ok": "error" not in p,
                })
        elif msg["direction"] == "server" and "error" in p and msg_id is not None:
            if msg_id in requests:
                req = requests.pop(msg_id)
                params = req["payload"].get("params", {})
                tool = params.get("name", "unknown")
                args = params.get("arguments", {})
                latency_ms = int((msg["ts"] - req["ts"]).total_seconds() * 1000)

                calls.append({
                    "ts": req["ts"],
                    "ts_response": msg["ts"],
                    "tool": tool,
                    "args": args,
                    "result": p.get("error", {}),
                    "latency_ms": latency_ms,
                    "rpc_id": msg_id,
                    "ok": False,
                })

    calls.sort(key=lambda c: c["ts"])
    return calls


def extract_available_tools(messages):
    """Extract tool names from tools/list responses."""
    for msg in reversed(messages):
        p = msg["payload"]
        if msg["direction"] == "server" and "result" in p:
            tools = p["result"].get("tools", [])
            if tools:
                return [t["name"] for t in tools]
    return []


def extract_server_name(messages):
    """Extract server name from log entries."""
    for msg in messages:
        return msg.get("server", "unknown")
    return "unknown"


# ── Session grouping ─────────────────────────────────────────────────────────

def group_sessions(calls):
    """Group calls into sessions by time gaps."""
    if not calls:
        return []

    sessions = [[calls[0]]]
    for c in calls[1:]:
        gap = (c["ts"] - sessions[-1][-1]["ts"]).total_seconds() / 60
        if gap > SESSION_GAP_MINUTES:
            sessions.append([])
        sessions[-1].append(c)
    return sessions


def classify_session(calls):
    """Auto-classify session type based on tool usage patterns."""
    tools = {c["tool"] for c in calls}
    tool_counts = {}
    for c in calls:
        tool_counts[c["tool"]] = tool_counts.get(c["tool"], 0) + 1

    non_poll = [c for c in calls if c["tool"] != POLL_TOOL]
    duration = (calls[-1]["ts"] - calls[0]["ts"]).total_seconds()

    if len(tools) >= 6 and len(non_poll) >= 30 and duration < 1200:
        return "warm-cache"
    if tool_counts.get("inspect_artwork_image", 0) > 5:
        return "visual-analysis"
    if tool_counts.get("semantic_search", 0) > 3:
        return "concept-search"
    if tool_counts.get("lookup_iconclass", 0) > 3:
        return "iconclass-exploration"
    if len(non_poll) <= 5 and duration < 300:
        return "quick-lookup"
    return "browsing"


# ── Result formatting ────────────────────────────────────────────────────────

def truncate_base64(text, limit=BASE64_TRUNCATE_LEN):
    """Replace long base64 strings with a truncated marker."""
    def replacer(m):
        data = m.group(1)
        if len(data) > limit:
            return f'"data:image/jpeg;base64,{data[:limit]}...[{len(data)} chars]"'
        return m.group(0)
    return re.sub(r'"data:image/[^;]+;base64,([A-Za-z0-9+/=]+)"', replacer, text)


def extract_result_text(result):
    """Extract the text content from a tool result."""
    content = result.get("content", [])
    texts = []
    has_image = False
    if isinstance(content, list):
        for item in content:
            if isinstance(item, dict):
                if item.get("type") == "text":
                    texts.append(item.get("text", ""))
                elif item.get("type") == "image":
                    has_image = True
                elif item.get("type") == "resource":
                    uri = item.get("resource", {}).get("uri", "?")
                    texts.append(f"[resource: {uri}]")
    return "\n".join(texts), has_image, result.get("structuredContent")


def _format_structured_content(sc, tool):
    """Format structuredContent metadata into a readable summary."""
    if not sc or not isinstance(sc, dict):
        return None

    if tool == "inspect_artwork_image":
        on = sc.get("objectNumber", "?")
        region = sc.get("region", "full")
        w = sc.get("nativeWidth", "?")
        h = sc.get("nativeHeight", "?")
        size = sc.get("requestedSize", "?")
        fetch = sc.get("fetchTimeMs", "?")
        return (f"`{on}` | region: {region} | native: {w}x{h}px | "
                f"requested: {size}px | fetch: {fetch}ms | [image returned]")

    if tool == "get_artwork_image":
        on = sc.get("objectNumber", "?")
        title = sc.get("title", "?")
        w = sc.get("width", "?")
        h = sc.get("height", "?")
        creator = sc.get("creator", "")
        return (f"`{on}` *{title}*"
                + (f" by {creator}" if creator else "")
                + f" | {w}x{h}px")

    if tool == "get_artwork_details":
        on = sc.get("objectNumber", "?")
        title = sc.get("title", "?")
        creator = sc.get("creator", "")
        date = sc.get("date", "")
        parts = [f"**{title}** (`{on}`)"]
        if creator:
            parts[0] += f" by {creator}"
        if date:
            parts[0] += f", {date}"
        return "\n".join(parts)

    if tool == "navigate_viewer":
        cmds = sc.get("commands")
        if cmds is not None:
            return f"{len(cmds) if isinstance(cmds, list) else '?'} commands queued"

    if tool == "poll_viewer_commands":
        cmds = sc.get("commands")
        if cmds is not None:
            return f"{len(cmds) if isinstance(cmds, list) else 0} pending commands"

    # Generic: show keys
    keys = list(sc.keys())
    return f"structuredContent keys: {keys}"


def format_result_summary(call, full=False):
    """Create a concise summary of a tool call result."""
    text, has_image, sc = extract_result_text(call["result"])

    if not call["ok"]:
        # Error responses have different structure
        err = call["result"]
        if isinstance(err, dict) and "message" in err:
            return f"**Error {err.get('code', '?')}:** {err['message'][:400]}"
        return f"**Error:** `{text[:300]}`"

    # Prefer structuredContent for rich metadata
    sc_summary = _format_structured_content(sc, call["tool"])

    # Combine: compact text (human-readable) + structuredContent metadata
    if text and sc_summary:
        lines = [f"```\n{text}\n```"]
        if has_image:
            lines.append(f"+ image data returned")
        return "\n".join(lines)
    elif sc_summary:
        result = sc_summary
        if has_image:
            result += " + image data"
        return result

    # Try JSON parsing for older (pre-compact) responses
    if text:
        try:
            data = json.loads(text)
            if isinstance(data, dict):
                total = data.get("totalResults")
                results = data.get("results", [])
                if total is not None and results:
                    lines = [f"**{total} results** (showing {len(results)})"]
                    for r in results[:8]:
                        on = r.get("objectNumber", "")
                        title = r.get("title", "?")
                        creator = r.get("creator", "")
                        date = r.get("date", "")
                        parts = [f"`{on}`" if on else "", f"*{title}*"]
                        if creator:
                            parts.append(f"by {creator}")
                        if date:
                            parts.append(f"({date})")
                        lines.append("  - " + " ".join(p for p in parts if p))
                    if len(results) > 8:
                        lines.append(f"  - ... and {len(results) - 8} more")
                    return "\n".join(lines)
        except (json.JSONDecodeError, TypeError):
            pass

    if text:
        text = truncate_base64(text)
        if not full and len(text) > RESULT_TRUNCATE_LEN:
            return f"```\n{text[:RESULT_TRUNCATE_LEN]}...\n```\n*({len(text)} chars total, truncated)*"
        return f"```\n{text}\n```"

    if has_image:
        return "_image returned (no text)_"

    return "_empty result_"


def summarize_args(tool, args):
    """One-line summary of tool arguments for session listing."""
    if tool == "search_artwork":
        parts = []
        for k in ("subject", "creator", "query", "title", "type", "material",
                   "technique", "productionPlace", "depictedPerson",
                   "depictedPlace", "iconclass", "collectionSet",
                   "aboutActor", "creationDate"):
            if k in args:
                parts.append(f'{k}:"{args[k]}"')
        if args.get("imageAvailable"):
            parts.append("img")
        if args.get("compact"):
            parts.append("compact")
        mr = args.get("maxResults")
        if mr and mr != 25:
            parts.append(f"max:{mr}")
        return ", ".join(parts) or json.dumps(args)[:80]
    if tool == "semantic_search":
        q = args.get("query", "")[:50]
        parts = [f'"{q}"']
        for k in ("type", "material", "technique", "creationDate"):
            if k in args:
                parts.append(f'{k}:"{args[k]}"')
        return ", ".join(parts)
    if tool in ("get_artwork_image", "get_artwork_details",
                "get_artwork_bibliography", "inspect_artwork_image"):
        on = args.get("objectNumber", "?")
        extras = []
        if "region" in args and args["region"] != "full":
            extras.append(args["region"])
        if args.get("quality") == "gray":
            extras.append("gray")
        return f"{on} ({', '.join(extras)})" if extras else on
    if tool == "lookup_iconclass":
        for k in ("query", "semanticQuery", "notation"):
            if k in args:
                return f'{k}:"{args[k]}"'
    if tool == "navigate_viewer":
        cmds = args.get("commands", [])
        actions = [c.get("action", "?") for c in cmds]
        return ", ".join(actions)
    if tool == POLL_TOOL:
        return args.get("viewUUID", "?")[:12] + "..."
    return json.dumps(args)[:80]


# ── Trace generation ─────────────────────────────────────────────────────────

def generate_trace(calls, available_tools, server_name,
                   include_polls=False, full_results=False):
    """Generate a markdown trace for a single session."""
    if not calls:
        return "# Empty session\n"

    # Filter polls unless requested
    if not include_polls:
        poll_calls = [c for c in calls if c["tool"] == POLL_TOOL]
        display_calls = [c for c in calls if c["tool"] != POLL_TOOL]
    else:
        poll_calls = []
        display_calls = calls

    start = calls[0]["ts"]
    end = calls[-1]["ts"]
    duration = end - start
    classification = classify_session(calls)

    out = []

    # Header
    out.append(f"# Session Trace: {server_name}")
    out.append("")
    out.append(f"**Date:** {start.strftime('%Y-%m-%d')}")
    out.append(f"**Time:** {start.strftime('%H:%M:%S')}--{end.strftime('%H:%M:%S')} UTC "
               f"({int(duration.total_seconds())}s)")
    out.append(f"**Classification:** {classification}")
    out.append(f"**Tool calls:** {len(display_calls)} "
               + (f"(+ {len(poll_calls)} poll)" if poll_calls else ""))
    if available_tools:
        out.append(f"**Tools available:** `{'`, `'.join(available_tools)}`")
    out.append("")
    out.append("---")
    out.append("")

    # Quick stats
    tool_counts = {}
    for c in display_calls:
        tool_counts[c["tool"]] = tool_counts.get(c["tool"], 0) + 1
    errors = [c for c in display_calls if not c["ok"]]
    latencies = [c["latency_ms"] for c in display_calls]

    out.append("## Summary")
    out.append("")
    out.append("| Tool | Calls | Avg ms |")
    out.append("|------|-------|--------|")
    for tool, count in sorted(tool_counts.items(), key=lambda x: -x[1]):
        ms_vals = [c["latency_ms"] for c in display_calls if c["tool"] == tool]
        avg = sum(ms_vals) // len(ms_vals)
        out.append(f"| `{tool}` | {count} | {avg:,} |")
    if poll_calls:
        poll_ms = [c["latency_ms"] for c in poll_calls]
        out.append(f"| `{POLL_TOOL}` | {len(poll_calls)} (collapsed) "
                   f"| {sum(poll_ms) // len(poll_ms):,} |")
    out.append("")
    if errors:
        out.append(f"**Errors:** {len(errors)}")
        out.append("")

    out.append("---")
    out.append("")

    # Tool interactions
    out.append("## Tool Interactions")
    out.append("")

    for i, call in enumerate(display_calls, 1):
        # Header
        status = "ERROR" if not call["ok"] else f"{call['latency_ms']}ms"
        out.append(f"### {i}. `{call['tool']}` ({status})")
        out.append("")

        # Timestamp
        out.append(f"**Time:** {call['ts'].strftime('%H:%M:%S')} UTC")
        out.append("")

        # Parameters
        out.append("**Parameters:**")
        out.append(f"```json\n{json.dumps(call['args'], indent=2)}\n```")
        out.append("")

        # Result
        out.append("**Result:**")
        out.append(format_result_summary(call, full=full_results))
        out.append("")

        # Poll activity between this call and the next
        if not include_polls and poll_calls:
            polls_between = [
                p for p in poll_calls
                if p["ts"] >= call["ts"]
                and (i == len(display_calls)
                     or p["ts"] < display_calls[i]["ts"] if i < len(display_calls) else True)
            ]
            if polls_between:
                uuid = polls_between[0]["args"].get("viewUUID", "?")[:12]
                out.append(f"*({len(polls_between)} poll_viewer_commands calls "
                           f"for `{uuid}...` collapsed)*")
                out.append("")

        out.append("---")
        out.append("")

    # Artwork summary
    artworks_seen = {}
    for c in display_calls:
        on = c["args"].get("objectNumber")
        if on and on not in artworks_seen:
            artworks_seen[on] = c["tool"]
    if artworks_seen:
        out.append("## Artworks Referenced")
        out.append("")
        out.append("| Object Number | First Tool |")
        out.append("|---------------|------------|")
        for on, tool in artworks_seen.items():
            out.append(f"| `{on}` | `{tool}` |")
        out.append("")

    # Footer
    out.append("---")
    out.append("")
    out.append(f"*Trace generated {datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')} "
               f"from `{Path(sys.argv[1]).name}` by generate-session-trace.py*")

    return "\n".join(out)


def list_sessions(all_calls, include_polls=False):
    """Print a table of all sessions in the log."""
    sessions = group_sessions(all_calls)
    if not sessions:
        print("No sessions found.", file=sys.stderr)
        return

    print(f"\n{'#':>3}  {'Date':10}  {'Time (UTC)':17}  {'Dur':>6}  "
          f"{'Calls':>5}  {'Type':20}  Key queries")
    print("-" * 100)

    for i, calls in enumerate(sessions):
        non_poll = [c for c in calls if c["tool"] != POLL_TOOL]
        display = non_poll if not include_polls else calls
        start = calls[0]["ts"]
        end = calls[-1]["ts"]
        dur = end - start
        dur_s = int(dur.total_seconds())
        if dur_s >= 3600:
            dur_str = f"{dur_s // 3600}h{(dur_s % 3600) // 60}m"
        else:
            dur_str = f"{dur_s // 60}m{dur_s % 60}s"

        cls = classify_session(calls)

        # Extract key queries
        topics = []
        seen = set()
        for c in display:
            if c["tool"] in ("search_artwork", "semantic_search",
                              "lookup_iconclass"):
                s = summarize_args(c["tool"], c["args"])
                if s not in seen:
                    seen.add(s)
                    topics.append(s)
                    if len(topics) >= 3:
                        break

        poll_note = f" (+{len(calls) - len(non_poll)}p)" if not include_polls and len(calls) != len(non_poll) else ""
        print(f"{i + 1:>3}  {start.strftime('%Y-%m-%d')}  "
              f"{start.strftime('%H:%M:%S')}--{end.strftime('%H:%M:%S')}  "
              f"{dur_str:>6}  {len(display):>5}{poll_note:<6}  "
              f"{cls:20}  {'; '.join(topics[:3])}")


# ── Batch output ─────────────────────────────────────────────────────────────

def batch_filename(session_calls, session_index):
    """Generate auto-named filename for a session trace."""
    start = session_calls[0]["ts"]
    date_str = start.strftime("%Y-%m-%d")
    time_str = start.strftime("%H%M")
    return f"{date_str}--session-trace-{session_index}-{time_str}.md"


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Generate debug traces from Claude Desktop MCP logs.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # List and single-session
  %(prog)s LOG --list
  %(prog)s LOG --session 3 -o trace.md
  %(prog)s LOG --date 2026-03-07

  # Batch with period filtering
  %(prog)s LOG --period weekly --batch --output-dir ./traces
  %(prog)s LOG --since 2026-03-01 --until 2026-03-07 --batch
  %(prog)s LOG --since last --batch --output-dir ./traces

  LOG = ~/Library/Logs/Claude/mcp-server-rijksmuseum.log (or similar)
        """
    )
    parser.add_argument("input", help="Path to Claude Desktop MCP log file")

    # Selection modes
    mode = parser.add_argument_group("selection")
    mode.add_argument("--list", action="store_true",
                      help="List all sessions (respects --since/--until)")
    mode.add_argument("--session", "-s", type=int,
                      help="Session index (1-based, within filtered set)")
    mode.add_argument("--date", "-d",
                      help="Filter to sessions on this date (YYYY-MM-DD)")
    mode.add_argument("--batch", action="store_true",
                      help="Generate one trace per session in the filtered set")

    # Date range filtering
    daterange = parser.add_argument_group("date range")
    daterange.add_argument("--since",
                           help="Sessions on/after DATE (YYYY-MM-DD or 'last')")
    daterange.add_argument("--until",
                           help="Sessions on/before DATE (YYYY-MM-DD)")
    daterange.add_argument("--period", choices=["daily", "weekly", "monthly"],
                           help="Sugar for --since: daily=1d, weekly=7d, monthly=30d")

    # Output
    output = parser.add_argument_group("output")
    output.add_argument("--output", "-o",
                        help="Write single trace to file (default: stdout)")
    output.add_argument("--output-dir",
                        help="Output directory for --batch mode (default: .)")
    output.add_argument("--include-polls", action="store_true",
                        help="Include poll_viewer_commands (collapsed by default)")
    output.add_argument("--full-results", action="store_true",
                        help="Show full result payloads (truncated by default)")
    args = parser.parse_args()

    output_dir = args.output_dir or "."

    # ── Resolve date range ───────────────────────────────────────────────────
    since_dt = None
    until_dt = None

    if args.period and args.since:
        print("Cannot use both --period and --since", file=sys.stderr)
        sys.exit(1)

    if args.period:
        days = PERIOD_DAYS[args.period]
        since_dt = datetime.now(timezone.utc) - timedelta(days=days)
        print(f"  Period: {args.period} (since {since_dt.strftime('%Y-%m-%d')})",
              file=sys.stderr)
    elif args.since:
        since_dt = resolve_since(args.since, output_dir)

    if args.until:
        until_dt = resolve_until(args.until)

    # --date is sugar for --since/--until on the same day
    if args.date:
        since_dt = datetime.fromisoformat(args.date + "T00:00:00+00:00")
        until_dt = datetime.fromisoformat(args.date + "T23:59:59+00:00")

    # ── Parse log ────────────────────────────────────────────────────────────
    print(f"Parsing {args.input}...", file=sys.stderr)
    messages = parse_log(args.input)
    if not messages:
        print(f"No parseable messages in {args.input}", file=sys.stderr)
        sys.exit(1)
    print(f"  {len(messages)} messages parsed", file=sys.stderr)

    calls = match_calls(messages)
    if not calls:
        print("No tool calls found.", file=sys.stderr)
        sys.exit(1)
    print(f"  {len(calls)} tool calls matched", file=sys.stderr)

    available_tools = extract_available_tools(messages)
    server_name = extract_server_name(messages)

    sessions = group_sessions(calls)
    print(f"  {len(sessions)} sessions total", file=sys.stderr)

    # Apply date filtering
    sessions = filter_sessions(sessions, since=since_dt, until=until_dt)
    if since_dt or until_dt:
        since_s = since_dt.strftime("%Y-%m-%d") if since_dt else "..."
        until_s = until_dt.strftime("%Y-%m-%d") if until_dt else "..."
        print(f"  {len(sessions)} sessions in range {since_s} to {until_s}",
              file=sys.stderr)

    if not sessions:
        print("No sessions match the filter criteria.", file=sys.stderr)
        sys.exit(1)

    # ── List mode ────────────────────────────────────────────────────────────
    if args.list:
        all_calls = [c for s in sessions for c in s]
        list_sessions(all_calls, include_polls=args.include_polls)
        return

    # ── Batch mode ───────────────────────────────────────────────────────────
    if args.batch:
        out_path = Path(output_dir)
        out_path.mkdir(parents=True, exist_ok=True)

        written = 0
        for i, session_calls in enumerate(sessions, 1):
            fname = batch_filename(session_calls, i)
            fpath = out_path / fname
            trace = generate_trace(session_calls, available_tools, server_name,
                                   include_polls=args.include_polls,
                                   full_results=args.full_results)
            fpath.write_text(trace, encoding="utf-8")
            non_poll = sum(1 for c in session_calls if c["tool"] != POLL_TOOL)
            cls = classify_session(session_calls)
            print(f"  [{i}/{len(sessions)}] {fname} "
                  f"({non_poll} calls, {cls})", file=sys.stderr)
            written += 1

        # Update watermark
        last_end = sessions[-1][-1]["ts"]
        save_watermark(output_dir, last_end)
        print(f"\n{written} trace(s) written to {output_dir}/",
              file=sys.stderr)
        print(f"Watermark updated to {last_end.strftime('%Y-%m-%d %H:%M')} UTC",
              file=sys.stderr)
        return

    # ── Single session mode ──────────────────────────────────────────────────
    if args.session:
        idx = args.session - 1
        if idx < 0 or idx >= len(sessions):
            print(f"Session {args.session} out of range (1-{len(sessions)})",
                  file=sys.stderr)
            sys.exit(1)
        selected = sessions[idx]
    elif len(sessions) == 1:
        selected = sessions[0]
    elif args.date or since_dt:
        # Multiple sessions in range — list them and ask
        print(f"\nMultiple sessions in range:", file=sys.stderr)
        all_calls = [c for s in sessions for c in s]
        list_sessions(all_calls, include_polls=args.include_polls)
        print(f"\nUse --session N to select one, or --batch to generate all.",
              file=sys.stderr)
        return
    else:
        # Default: most recent session
        selected = sessions[-1]
        print(f"  Using most recent session "
              f"({selected[0]['ts'].strftime('%Y-%m-%d %H:%M')})",
              file=sys.stderr)

    # Generate single trace
    trace = generate_trace(selected, available_tools, server_name,
                           include_polls=args.include_polls,
                           full_results=args.full_results)

    if args.output:
        Path(args.output).write_text(trace, encoding="utf-8")
        print(f"\nTrace written to {args.output}", file=sys.stderr)
    else:
        print(trace)


if __name__ == "__main__":
    main()
