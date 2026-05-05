#!/usr/bin/env bash
# Bundle post-harvest artifacts for transfer back from a harvest machine.
# Closes #229 part B: the v0.24 harvest left orphan-vocab-ids-v0.24.csv on the
# harvest machine because the runbook only listed the DB and log as the things
# to copy back. This script makes the full set explicit and atomic.
#
# Usage:
#   scripts/package-harvest-artifacts.sh <version>
#   scripts/package-harvest-artifacts.sh <version> --dest <path>
#
# Example:
#   scripts/package-harvest-artifacts.sh v0.27
#   scripts/package-harvest-artifacts.sh v0.27 --dest /tmp/harvest-v0.27.tar
#
# Behaviour:
#   - Run from the repo root on the *harvest machine* after the harvest
#     completes. Bundles every file the workstation needs for post-harvest
#     diagnostics into a single tarball.
#   - The DB is NOT included by default: at ~1.1 GB it's faster to scp it
#     directly than to bury it inside a tarball. Pass --with-db to override.
#   - Missing optional artifacts (e.g. phase-failures-v*.csv if #226's CSV
#     export didn't land) are skipped with a notice, not a hard error.
#   - Prints an `scp` invocation at the end so the operator can copy the
#     bundle back without re-typing the path.

set -euo pipefail

usage() {
    cat <<EOF
Usage: $(basename "$0") <version> [--dest <path>] [--with-db]

  <version>      Harvest version label, e.g. v0.27. Used to find audit CSVs
                 like data/audit/orphan-vocab-ids-<version>.csv and to name
                 the output tarball.

  --dest <path>  Output tarball path. Default: data/harvest-artifacts-<version>.tar

  --with-db      Include data/vocabulary.db in the bundle. Default off — at
                 ~1.1 GB it's usually faster to scp the DB separately.

The script must be run from the repo root.
EOF
}

if [[ $# -lt 1 ]]; then
    usage
    exit 1
fi

VERSION=$1
shift

DEST=""
WITH_DB=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --dest)
            DEST=$2
            shift 2
            ;;
        --with-db)
            WITH_DB=1
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "Unknown argument: $1" >&2
            usage
            exit 1
            ;;
    esac
done

if [[ ! -f package.json ]] || [[ ! -d data ]]; then
    echo "Error: must run from repo root (no package.json + data/ here)." >&2
    exit 1
fi

DEST=${DEST:-data/harvest-artifacts-${VERSION}.tar}

# Candidate artifacts. The harvest plan documents the canonical names; this
# list is the source of truth for what 'a complete harvest output' looks like.
CANDIDATES=(
    "data/harvest-${VERSION}-report.md"
    "data/harvest-${VERSION}-full-log.txt"
    "data/audit/harvest-audit-${VERSION}.json"
    "data/audit/orphan-vocab-ids-${VERSION}.csv"
    "data/audit/phase-failures-${VERSION}.csv"
    "data/audit/schema-drift-${VERSION}.csv"
)

if [[ $WITH_DB -eq 1 ]]; then
    CANDIDATES+=("data/vocabulary.db")
fi

INCLUDED=()
MISSING=()
for f in "${CANDIDATES[@]}"; do
    if [[ -f "$f" ]]; then
        INCLUDED+=("$f")
    else
        MISSING+=("$f")
    fi
done

if [[ ${#INCLUDED[@]} -eq 0 ]]; then
    echo "Error: none of the expected harvest artifacts exist for ${VERSION}." >&2
    echo "Looked for:" >&2
    printf '  %s\n' "${CANDIDATES[@]}" >&2
    exit 1
fi

echo "Bundling ${#INCLUDED[@]} artifact(s) into ${DEST}:"
printf '  %s\n' "${INCLUDED[@]}"

if [[ ${#MISSING[@]} -gt 0 ]]; then
    echo
    echo "Skipped (not present — fine if the upstream step didn't run):"
    printf '  %s\n' "${MISSING[@]}"
fi

mkdir -p "$(dirname "$DEST")"
tar -cf "$DEST" "${INCLUDED[@]}"

SIZE=$(du -h "$DEST" | awk '{print $1}')
echo
echo "Done: ${DEST} (${SIZE})"
echo
echo "To transfer back to the workstation:"
if [[ "$DEST" = /* ]]; then
    BASENAME=$(basename "$DEST")
    echo "  scp ${DEST} <workstation>:<repo-path>/data/${BASENAME}"
    echo
    echo "Then on the workstation, from the repo root:"
    echo "  tar -xf data/${BASENAME}"
else
    echo "  scp ${DEST} <workstation>:<repo-path>/${DEST}"
    echo
    echo "Then on the workstation, from the repo root:"
    echo "  tar -xf ${DEST}"
fi
