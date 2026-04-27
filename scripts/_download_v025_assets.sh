#!/usr/bin/env bash
# Pre-harvest asset download for v0.25 geocoding bundle.
# See offline/drafts/v0.25-harvest-assets.md for the contract this script implements.
#
# Downloads:
#   - 11 WOF per-country Parquet files (~2.0 GB) into data/seed/wof/
#   - Pleiades places dump (~131 MB) into data/seed/pleiades-places.json.gz
#
# Side effects:
#   - Writes data/seed/wof/MANIFEST.tsv (filename, sha256, size_bytes, download_iso8601)
#   - Writes data/seed/pleiades-places.json.gz.sha256
#
# curl -C - resumes interrupted downloads. Re-run is safe.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SEED_DIR="${REPO_ROOT}/data/seed"
WOF_DIR="${SEED_DIR}/wof"
PLEIADES_PATH="${SEED_DIR}/pleiades-places.json.gz"
WOF_MANIFEST="${WOF_DIR}/MANIFEST.tsv"
LOG_PATH="${SEED_DIR}/_download.log"

WOF_BASE="https://data.geocode.earth/wof/dist/parquet"
PLEIADES_URL="https://atlantides.org/downloads/pleiades/json/pleiades-places-latest.json.gz"

WOF_COUNTRIES=(nl de at fr be it gb us id jp cn)

mkdir -p "${WOF_DIR}"

log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "${LOG_PATH}"; }

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

size_of() {
  if stat -f '%z' "$1" >/dev/null 2>&1; then
    stat -f '%z' "$1"
  else
    stat -c '%s' "$1"
  fi
}

download_one() {
  local url="$1"; local dest="$2"; local label="$3"
  log "↓ ${label} → ${dest}"
  curl -fL --retry 3 --retry-delay 5 -C - -o "${dest}" "${url}"
  log "✓ ${label} ($(size_of "${dest}") bytes)"
}

log "v0.25 asset download starting"
log "REPO_ROOT=${REPO_ROOT}"

# --- WOF Parquet (parallel download, then deterministic SHA + manifest pass) ---
# Geocode Earth's CDN is Cloudflare-fronted and supports concurrent downloads.
# 4-way parallelism saturates a typical residential link without thrashing the CDN.
# `xargs -P 4` is portable across macOS bash 3.2 (no `wait -n`).
log "downloading WOF parquet files (4-way parallel)…"
printf '%s\n' "${WOF_COUNTRIES[@]}" | xargs -P 4 -I{} bash -c '
  cc="$1"
  filename="whosonfirst-data-admin-${cc}-latest.parquet"
  url="'"${WOF_BASE}"'/${filename}"
  dest="'"${WOF_DIR}"'/${filename}"
  printf "[%s] ↓ WOF %s → %s\n" "$(date -u +%FT%TZ)" "${cc}" "${dest}" >> "'"${LOG_PATH}"'"
  curl -fsSL --retry 3 --retry-delay 5 -C - -o "${dest}" "${url}"
  printf "[%s] ✓ WOF %s\n" "$(date -u +%FT%TZ)" "${cc}" >> "'"${LOG_PATH}"'"
' _ {}

# Manifest is rewritten in WOF_COUNTRIES order to keep diffs stable across runs.
printf 'filename\tsha256\tsize_bytes\tdownload_iso8601\n' > "${WOF_MANIFEST}.tmp"
for cc in "${WOF_COUNTRIES[@]}"; do
  filename="whosonfirst-data-admin-${cc}-latest.parquet"
  dest="${WOF_DIR}/${filename}"
  sha="$(sha256_of "${dest}")"
  size="$(size_of "${dest}")"
  printf '%s\t%s\t%s\t%s\n' "${filename}" "${sha}" "${size}" "$(date -u +%FT%TZ)" >> "${WOF_MANIFEST}.tmp"
done
mv "${WOF_MANIFEST}.tmp" "${WOF_MANIFEST}"
log "✓ WOF manifest written: ${WOF_MANIFEST}"

# --- Pleiades dump ---
download_one "${PLEIADES_URL}" "${PLEIADES_PATH}" "Pleiades places"
sha="$(sha256_of "${PLEIADES_PATH}")"
size="$(size_of "${PLEIADES_PATH}")"
printf '%s  %s\n' "${sha}" "$(basename "${PLEIADES_PATH}")" > "${PLEIADES_PATH}.sha256"
log "✓ Pleiades sha256=${sha} size=${size}"

log "All v0.25 assets downloaded. Total bytes:"
du -sh "${WOF_DIR}" "${PLEIADES_PATH}" | tee -a "${LOG_PATH}"

log "Done."
