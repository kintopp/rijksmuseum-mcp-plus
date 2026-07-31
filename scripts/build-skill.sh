#!/usr/bin/env bash
#
# build-skill.sh — rebuild the distributable skill bundles from the source folder.
#
# A ".skill" bundle is a zip with SKILL.md and references/ at its root. We ship
# two bundles next to the source folder: the bare ".skill" and a ".skill.zip"
# that wraps it (some clients/browsers only accept a .zip extension) — both
# generated from the one canonical source (docs/skills/rijksmuseum-mcp-plus/).
# Run this whenever SKILL.md or references/ change so the bundles can never
# drift from the source. The failure mode this guards against is the ICONCLASS
# stale-bundle incident (its git 98d2931): SKILL.md bumped, packaged bundle
# shipped stale. Uses `zip` (not Finder/ditto, which inject __MACOSX forks) and
# removes old archives first, since `zip` appends to an existing file.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$ROOT/docs/skills/rijksmuseum-mcp-plus"
OUT_SKILL="$ROOT/docs/skills/rijksmuseum-mcp-plus.skill"
OUT_ZIP="$ROOT/docs/skills/rijksmuseum-mcp-plus.skill.zip"

[ -f "$SRC_DIR/SKILL.md" ] || { echo "error: source not found: $SRC_DIR/SKILL.md" >&2; exit 1; }
[ -d "$SRC_DIR/references" ] || { echo "error: source not found: $SRC_DIR/references/" >&2; exit 1; }

rm -f "$OUT_SKILL" "$OUT_ZIP"
# Build from inside the source folder so the archive root is SKILL.md/references
# (not rijksmuseum-mcp-plus/…). -X strips uid/gid and Finder/resource-fork
# attributes so the archive carries no __MACOSX / AppleDouble junk.
(cd "$SRC_DIR" && zip -X -r "$OUT_SKILL" SKILL.md references -x '*.DS_Store' >/dev/null)
(cd "$(dirname "$OUT_ZIP")" && zip -X "$OUT_ZIP" "$(basename "$OUT_SKILL")" >/dev/null)

# Sanity check 1: the .skill must contain SKILL.md at root, plus only
# references/ entries — no __MACOSX, no .DS_Store, no stray paths.
entries="$(unzip -Z1 "$OUT_SKILL")"
echo "$entries" | grep -qx 'SKILL.md' || { echo "error: $(basename "$OUT_SKILL") is missing root SKILL.md" >&2; exit 1; }
bad="$(echo "$entries" | grep -vE '^(SKILL\.md|references(/[^/]+)*/?)$' || true)"
if [ -n "$bad" ]; then
  echo "error: $(basename "$OUT_SKILL") contains unexpected entries:" >&2
  printf '%s\n' "$bad" >&2
  exit 1
fi
if echo "$entries" | grep -qE '__MACOSX|\.DS_Store'; then
  echo "error: $(basename "$OUT_SKILL") contains macOS junk entries" >&2
  exit 1
fi

# Sanity check 2: the .skill.zip must contain exactly one entry — the .skill.
wrap="$(unzip -Z1 "$OUT_ZIP")"
if [ "$wrap" != "$(basename "$OUT_SKILL")" ]; then
  echo "error: $(basename "$OUT_ZIP") should contain only '$(basename "$OUT_SKILL")', got:" >&2
  printf '%s\n' "$wrap" >&2
  exit 1
fi

echo "Built $(basename "$OUT_SKILL") + $(basename "$OUT_ZIP") from docs/skills/rijksmuseum-mcp-plus/:"
unzip -l "$OUT_SKILL"
