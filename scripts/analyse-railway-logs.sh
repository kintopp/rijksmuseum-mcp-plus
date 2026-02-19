#!/usr/bin/env bash
# analyse-railway-logs.sh — Fetch and summarise Railway deployment logs
#
# Fetches JSON logs from all recent deployments via `railway logs`, merges
# them, and prints summary statistics. Requires `railway` CLI and `jq`.
#
# Usage:
#   ./scripts/analyse-railway-logs.sh [--lines N] [--limit N] [--raw FILE]
#
# Options:
#   --lines N     Max log lines per deployment (default: 500)
#   --limit N     Max deployments to fetch (default: 20)
#   --raw FILE    Write all merged JSON log lines to FILE before summarising
#
# The script links to the rijksmuseum-mcp-plus service automatically.
# Output goes to stdout; redirect to a file as needed.

set -euo pipefail

LINES=500
DEPLOY_LIMIT=20
RAW_FILE=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --lines) LINES="$2"; shift 2 ;;
    --limit) DEPLOY_LIMIT="$2"; shift 2 ;;
    --raw)   RAW_FILE="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# Check prerequisites
for cmd in railway jq; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "Error: $cmd is required but not found." >&2
    exit 1
  fi
done

echo "Linking service..." >&2
railway link-service rijksmuseum-mcp-plus 2>/dev/null || true

echo "Fetching deployment list (limit $DEPLOY_LIMIT)..." >&2
DEPLOYMENTS=$(railway deployments --json 2>/dev/null | jq -r ".[0:$DEPLOY_LIMIT][] | .id")
DEPLOY_COUNT=$(echo "$DEPLOYMENTS" | wc -l | tr -d ' ')
echo "Found $DEPLOY_COUNT deployments." >&2

# Collect all log lines into temp files (cleaned up on exit)
ALL_LOGS=$(mktemp)
TOOL_LOGS=$(mktemp)
trap "rm -f $ALL_LOGS $TOOL_LOGS" EXIT

for id in $DEPLOYMENTS; do
  echo "  Fetching logs for $id..." >&2
  railway logs --deployment "$id" --json -n "$LINES" 2>/dev/null >> "$ALL_LOGS" || true
done

TOTAL_LINES=$(wc -l < "$ALL_LOGS" | tr -d ' ')
echo "Collected $TOTAL_LINES total log lines." >&2

if [[ -n "$RAW_FILE" ]]; then
  cp "$ALL_LOGS" "$RAW_FILE"
  echo "Raw logs written to $RAW_FILE" >&2
fi

# Filter to tool call lines only (have "tool" key)
jq -c 'select(.tool)' "$ALL_LOGS" > "$TOOL_LOGS" 2>/dev/null || true
TOOL_COUNT=$(wc -l < "$TOOL_LOGS" | tr -d ' ')

echo ""
echo "=== Railway Log Analysis ==="
echo ""

# Time range
FIRST_TS=$(jq -r '.timestamp' "$ALL_LOGS" 2>/dev/null | sort | head -1)
LAST_TS=$(jq -r '.timestamp' "$ALL_LOGS" 2>/dev/null | sort | tail -1)
echo "Time range: $FIRST_TS to $LAST_TS"
echo "Total log lines: $TOTAL_LINES"
echo "Tool call lines: $TOOL_COUNT"
echo ""

if [[ "$TOOL_COUNT" -eq 0 ]]; then
  echo "No tool calls found."
  exit 0
fi

# Tool call summary
echo "--- Tool Call Counts ---"
jq -r '.tool' "$TOOL_LOGS" | sort | uniq -c | sort -rn
echo ""

# Error summary
ERROR_COUNT=$(jq -r 'select(.ok == false)' "$TOOL_LOGS" | wc -l | tr -d ' ')
echo "--- Errors ---"
echo "Total errors: $ERROR_COUNT"
if [[ "$ERROR_COUNT" -gt 0 ]]; then
  echo ""
  jq -c 'select(.ok == false) | {tool, error, input}' "$TOOL_LOGS"
fi
echo ""

# Slow queries (>2000ms)
echo "--- Slow Queries (>2s) ---"
jq -c 'select(.ms > 2000) | {tool, ms, input}' "$TOOL_LOGS" | sort -t: -k2 -rn | head -20
echo ""

# Latency percentiles per tool
echo "--- Latency Summary (ms) ---"
echo "tool | min | p50 | p90 | p99 | max | count"
echo "-----|-----|-----|-----|-----|-----|------"
jq -r '.tool' "$TOOL_LOGS" | sort -u | while read -r tool; do
  VALS=$(jq -r "select(.tool == \"$tool\") | .ms" "$TOOL_LOGS" | sort -n)
  COUNT=$(echo "$VALS" | wc -l | tr -d ' ')
  MIN=$(echo "$VALS" | head -1)
  MAX=$(echo "$VALS" | tail -1)
  P50=$(echo "$VALS" | sed -n "$((COUNT / 2 + 1))p")
  P90=$(echo "$VALS" | sed -n "$((COUNT * 9 / 10 + 1))p")
  P99=$(echo "$VALS" | sed -n "$((COUNT * 99 / 100 + 1))p")
  printf "%-25s | %6s | %6s | %6s | %6s | %6s | %5s\n" "$tool" "$MIN" "$P50" "$P90" "$P99" "$MAX" "$COUNT"
done
echo ""

# Startup events
echo "--- Startup Events ---"
jq -r 'select(.message | test("Vocabulary DB|pre-warmed|listening|Downloading|Warning:")) | "\(.timestamp) \(.message)"' "$ALL_LOGS" 2>/dev/null | sort | uniq
echo ""

# Cache hit detection (same tool+input with ms drop >5x)
echo "--- Likely Cache Hits (same input, >5x faster on repeat) ---"
jq -c '{tool, input: (.input | tostring), ms}' "$TOOL_LOGS" 2>/dev/null | sort | \
  awk -F',' 'BEGIN{OFS=","} {
    key=$1","$2;
    if (key in first) {
      split(first[key], a, ":");
      split($3, b, ":");
      gsub(/[^0-9]/, "", a[2]);
      gsub(/[^0-9]/, "", b[2]);
      if (a[2]+0 > 0 && b[2]+0 > 0 && a[2]/b[2] > 5)
        print key, "first=" a[2] "ms", "repeat=" b[2] "ms", "speedup=" int(a[2]/b[2]) "x"
    } else {
      first[key] = $3
    }
  }' | head -15
