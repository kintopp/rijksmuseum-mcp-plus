#!/usr/bin/env bash
# Auto-resume wrapper for the bibliography backfill.
#
# Re-runs `backfill-bibliography.py --subset all --resume` until it exits 0 (all
# artworks processed). The Python script self-detects a worker stall and exits 2
# (every artwork done so far is checkpointed); this loop then resumes it. Also
# recovers from a crash or an external kill.
#
# Monitor:  tail -f backfill-all.log
# Stop:     touch scripts/.stop-backfill && pkill -f backfill-bibliography.py
set -u
cd "$(dirname "$0")/.."
PY="$HOME/miniconda3/envs/embeddings/bin/python"
LOG="backfill-all.log"
STOP="scripts/.stop-backfill"
MAX_RETRIES=50

rm -f "$STOP"
n=0
while :; do
  "$PY" scripts/backfill-bibliography.py --subset all --resume >> "$LOG" 2>&1
  code=$?
  if [ "$code" -eq 0 ]; then
    echo "[wrapper] backfill completed (exit 0) @ $(date)" >> "$LOG"
    break
  fi
  if [ -f "$STOP" ]; then
    echo "[wrapper] stop sentinel found; exiting after exit $code @ $(date)" >> "$LOG"
    rm -f "$STOP"
    break
  fi
  n=$((n + 1))
  if [ "$n" -ge "$MAX_RETRIES" ]; then
    echo "[wrapper] max retries ($MAX_RETRIES) reached; giving up @ $(date)" >> "$LOG"
    break
  fi
  echo "[wrapper] backfill exited $code; resume #$n in 15s @ $(date)" >> "$LOG"
  sleep 15
done
