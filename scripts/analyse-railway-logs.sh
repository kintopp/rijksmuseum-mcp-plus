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
#   --since DATE   Only include calls on/after DATE (YYYY-MM-DD)
#   --until DATE   Only include calls on/before DATE (YYYY-MM-DD)
#   --period P     Sugar for --since: daily, weekly, monthly
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
PY_EXTRA_ARGS=()

while [[ $# -gt 0 ]]; do
  case $1 in
    --lines)      LINES="$2"; shift 2 ;;
    --limit)      DEPLOY_LIMIT="$2"; shift 2 ;;
    --output)     OUTPUT_DIR="$2"; shift 2 ;;
    --skip-fetch) SKIP_FETCH=true; shift ;;
    --raw)        OUTPUT_DIR="$(dirname "$2")"; shift 2 ;;  # backward compat
    --since)      PY_EXTRA_ARGS+=(--since "$2"); shift 2 ;;
    --until)      PY_EXTRA_ARGS+=(--until "$2"); shift 2 ;;
    --period)     PY_EXTRA_ARGS+=(--period "$2"); shift 2 ;;
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
  ERRTMP=$(mktemp)
  FETCH_OK=0; FETCH_EMPTY=0; FETCH_FAILED=0
  # railway logs is flaky/rate-limited; a transient "Failed to fetch" must not
  # be swallowed as if the deployment had no logs (silent under-collection).
  for id in $DEPLOYMENTS; do
    echo "  Fetching $id..." >&2
    BEFORE=$(wc -l < "$LOGFILE")
    if railway logs "$id" --json -n "$LINES" 2>"$ERRTMP" >> "$LOGFILE"; then RC=0; else RC=$?; fi
    AFTER=$(wc -l < "$LOGFILE")
    if [[ $RC -ne 0 ]] || grep -qiE 'failed to fetch|error sending request|error in limit|rate.?limit|unauthorized|too many' "$ERRTMP"; then
      FETCH_FAILED=$((FETCH_FAILED + 1))
      MSG=$(grep -iE 'failed to fetch|error sending request|error in limit|rate.?limit|unauthorized|too many' "$ERRTMP" | head -1)
      echo "    ⚠ fetch failed (rc=$RC)${MSG:+: ${MSG:0:90}}" >&2
    elif [[ "$AFTER" -eq "$BEFORE" ]]; then
      FETCH_EMPTY=$((FETCH_EMPTY + 1))
    else
      FETCH_OK=$((FETCH_OK + 1))
    fi
  done
  rm -f "$ERRTMP"

  TOTAL_LINES=$(wc -l < "$LOGFILE" | tr -d ' ')
  echo "Collected $TOTAL_LINES log lines from $FETCH_OK deployment(s) → $LOGFILE" >&2
  [[ "$FETCH_EMPTY" -gt 0 ]] && echo "  $FETCH_EMPTY deployment(s) returned no logs (short-lived/superseded — expected)." >&2
  if [[ "$FETCH_FAILED" -gt 0 ]]; then
    echo "  ⚠ $FETCH_FAILED deployment fetch(es) FAILED (transient/rate-limit/-n cap)." >&2
    echo "    Coverage may be incomplete — re-run to fill gaps, and keep --lines below ~5000 (Railway rejects large -n)." >&2
  fi
else
  if [[ ! -f "$LOGFILE" ]]; then
    echo "Error: --skip-fetch but $LOGFILE not found." >&2
    echo "Either fetch first or ensure the file exists." >&2
    exit 1
  fi
  echo "Skipping fetch, using existing $LOGFILE" >&2
fi

# ─── Analyse ─────────────────────────────────────────────────────────────────

python3 "$SCRIPT_DIR/analyse-railway-logs.py" "$LOGFILE" -o "$REPORT" "${PY_EXTRA_ARGS[@]}"

echo "" >&2
echo "Done." >&2
echo "  Raw logs: $LOGFILE" >&2
echo "  Report:   $REPORT" >&2
