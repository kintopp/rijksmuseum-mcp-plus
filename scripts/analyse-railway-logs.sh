#!/usr/bin/env bash
# analyse-railway-logs.sh — Fetch Railway logs and produce analysis report.
#
# Fetches JSON logs from recent deployments via `railway logs`, saves the
# raw JSONL, and runs analyse-railway-logs.py to produce a 7-section
# markdown report.
#
# Usage:
#   ./scripts/analyse-railway-logs.sh [OPTIONS]
#
# Options:
#   --lines N      Max log lines per deployment (default: 500)
#   --limit N      Max deployments to fetch (default: 20)
#   --output DIR   Output directory for logs + report (default: .)
#   --skip-fetch   Skip fetching; analyse existing logs from --output dir
#
# Output files (in --output dir):
#   railway-logs-YYYY-MM-DD.jsonl          Raw merged log lines
#   YYYY-MM-DD--railway-log-analysis.md    Markdown report
#
# The script links to the rijksmuseum-mcp-plus service automatically.

set -eu  # No pipefail — avoids SIGPIPE on jq | sort | head chains

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DATE=$(date +%Y-%m-%d)
LINES=500
DEPLOY_LIMIT=20
OUTPUT_DIR="."
SKIP_FETCH=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --lines)      LINES="$2"; shift 2 ;;
    --limit)      DEPLOY_LIMIT="$2"; shift 2 ;;
    --output)     OUTPUT_DIR="$2"; shift 2 ;;
    --skip-fetch) SKIP_FETCH=true; shift ;;
    --raw)        OUTPUT_DIR="$(dirname "$2")"; shift 2 ;;  # backward compat
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

LOGFILE="${OUTPUT_DIR}/railway-logs-${DATE}.jsonl"
REPORT="${OUTPUT_DIR}/${DATE}--railway-log-analysis.md"

# ─── Prerequisites ───────────────────────────────────────────────────────────

if [[ "$SKIP_FETCH" == false ]]; then
  for cmd in railway jq; do
    if ! command -v "$cmd" &>/dev/null; then
      echo "Error: $cmd is required but not found." >&2
      exit 1
    fi
  done
fi

if ! command -v python3 &>/dev/null; then
  echo "Error: python3 is required for report generation." >&2
  exit 1
fi

if [[ ! -f "$SCRIPT_DIR/analyse-railway-logs.py" ]]; then
  echo "Error: analyse-railway-logs.py not found in $SCRIPT_DIR" >&2
  exit 1
fi

# ─── Fetch logs ──────────────────────────────────────────────────────────────

if [[ "$SKIP_FETCH" == false ]]; then
  echo "Linking service..." >&2
  railway link -s rijksmuseum-mcp-plus 2>/dev/null || true

  echo "Fetching deployment list (limit $DEPLOY_LIMIT)..." >&2
  DEPLOYMENTS=$(railway deployment list --json --limit "$DEPLOY_LIMIT" 2>/dev/null \
    | jq -r '.[] | .id')
  DEPLOY_COUNT=$(echo "$DEPLOYMENTS" | wc -l | tr -d ' ')
  echo "Found $DEPLOY_COUNT deployments." >&2

  > "$LOGFILE"  # truncate
  for id in $DEPLOYMENTS; do
    echo "  Fetching $id..." >&2
    railway logs "$id" --json -n "$LINES" 2>/dev/null >> "$LOGFILE" || true
  done

  TOTAL_LINES=$(wc -l < "$LOGFILE" | tr -d ' ')
  echo "Collected $TOTAL_LINES log lines → $LOGFILE" >&2
else
  if [[ ! -f "$LOGFILE" ]]; then
    echo "Error: --skip-fetch but $LOGFILE not found." >&2
    echo "Either fetch first or ensure the file exists." >&2
    exit 1
  fi
  echo "Skipping fetch, using existing $LOGFILE" >&2
fi

# ─── Analyse ─────────────────────────────────────────────────────────────────

python3 "$SCRIPT_DIR/analyse-railway-logs.py" "$LOGFILE" -o "$REPORT"

echo "" >&2
echo "Done." >&2
echo "  Raw logs: $LOGFILE" >&2
echo "  Report:   $REPORT" >&2
