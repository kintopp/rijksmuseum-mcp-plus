#!/bin/bash
# Harvest v0.24 Dependencies Verification
# Run this on the harvest machine after setup to confirm everything is in place.

set -euo pipefail

echo "=== Harvest v0.24 Dependencies Check ==="
FAIL=0

# Node
NODE_V=$(node --version 2>/dev/null || echo "none")
if [[ "$NODE_V" == v24.* ]]; then
  echo "OK  Node $NODE_V"
else
  echo "FAIL  Node: got $NODE_V, need 24.x"
  FAIL=$((FAIL + 1))
fi

# Python (harvest uses the embeddings conda env)
CONDA_PY=~/miniconda3/envs/embeddings/bin/python
if [ -x "$CONDA_PY" ]; then
  echo "OK  embeddings conda env: $($CONDA_PY --version)"
else
  echo "FAIL  ~/miniconda3/envs/embeddings/bin/python not found"
  FAIL=$((FAIL + 1))
fi

# npm deps
if [ -d node_modules/better-sqlite3 ]; then
  echo "OK  npm dependencies installed"
else
  echo "FAIL  Run: npm install"
  FAIL=$((FAIL + 1))
fi

# Build (only needed for Step 7 LLM audit scripts, not for harvest itself)
if [ -f dist/provenance-peg.js ]; then
  echo "OK  TypeScript built (needed for Step 7 audit scripts)"
else
  echo "WARN  TypeScript not built — run 'npm run build' if using Step 7 audit scripts"
fi

# Data dumps
DUMP_COUNT=$(ls ~/Downloads/rijksmuseum-data-dumps/*.tar.gz 2>/dev/null | wc -l | tr -d ' ')
if [ "$DUMP_COUNT" -eq 13 ]; then
  echo "OK  $DUMP_COUNT data dumps"
else
  echo "FAIL  Got $DUMP_COUNT dumps, need 13"
  FAIL=$((FAIL + 1))
fi
if [ -f ~/Downloads/rijksmuseum-data-dumps/exhibition.tar.gz ]; then
  echo "OK  exhibition.tar.gz present"
else
  echo "FAIL  exhibition.tar.gz missing"
  FAIL=$((FAIL + 1))
fi

# Vocabulary DB
if [ -f data/vocabulary.db ]; then
  echo "OK  vocabulary.db present"
else
  echo "FAIL  data/vocabulary.db missing"
  FAIL=$((FAIL + 1))
fi

# Geocoded places
if [ -f data/backfills/geocoded-places.csv ]; then
  echo "OK  geocoded-places.csv present"
else
  echo "FAIL  data/backfills/geocoded-places.csv missing"
  FAIL=$((FAIL + 1))
fi

# Audit JSONs (Step 7)
for f in audit-field-correction-2026-03-25.json audit-event-reclassification-2026-03-25.json audit-event-splitting-2026-03-25.json; do
  if [ -f "data/audit/$f" ]; then
    echo "OK  $f"
  else
    echo "FAIL  data/audit/$f missing"
    FAIL=$((FAIL + 1))
  fi
done

# Audit JSONs (Steps 1-2)
for f in audit-position-enrichment-r1.json audit-position-enrichment-r2.json audit-party-disambiguation-r1.json audit-party-disambiguation-r2.json; do
  if [ -f "data/audit/$f" ]; then
    echo "OK  $f"
  else
    echo "FAIL  data/audit/$f missing"
    FAIL=$((FAIL + 1))
  fi
done

# .env
if [ -f .env ]; then
  echo "OK  .env present"
else
  echo "WARN  .env missing (needed for geocoding only)"
fi

# ANTHROPIC_API_KEY
if grep -q "ANTHROPIC_API_KEY" ~/.env 2>/dev/null; then
  echo "OK  ANTHROPIC_API_KEY in ~/.env"
else
  echo "WARN  ~/.env missing ANTHROPIC_API_KEY (needed for Step 7 LLM runs only)"
fi

echo ""
if [ $FAIL -eq 0 ]; then
  echo "All checks passed."
else
  echo "FAILED: $FAIL check(s) — fix before starting harvest."
  exit 1
fi
