#!/usr/bin/env bash
# Release the Verivyx WordPress plugin: bump version, build zip, publish zip +
# update metadata to web/public. Commit/push is left to the maintainer.
# Usage: scripts/release-plugin.sh <patch|minor|major|X.Y.Z> [changelog text]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_PHP="$ROOT/services/wordpress-plugin/verivyx-paywall/verivyx-paywall.php"
BUILD_SH="$ROOT/services/wordpress-plugin/build.sh"
PUBLIC_DIR="$ROOT/web/public"
JSON_OUT="$PUBLIC_DIR/verivyx-paywall.json"

bump="${1:-}"
changelog="${2:-Maintenance release.}"
if [[ -z "$bump" ]]; then
  echo "Usage: $0 <patch|minor|major|X.Y.Z> [changelog text]" >&2
  exit 1
fi

cur="$(grep -oE 'Version:[[:space:]]*[0-9]+\.[0-9]+\.[0-9]+' "$PLUGIN_PHP" \
        | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
if [[ -z "$cur" ]]; then
  echo "ERROR: cannot read current version from $PLUGIN_PHP" >&2
  exit 1
fi

IFS='.' read -r MA MI PA <<< "$cur"
case "$bump" in
  patch) new="$MA.$MI.$((PA + 1))" ;;
  minor) new="$MA.$((MI + 1)).0" ;;
  major) new="$((MA + 1)).0.0" ;;
  [0-9]*.[0-9]*.[0-9]*) new="$bump" ;;
  *) echo "ERROR: invalid bump '$bump' (use patch|minor|major|X.Y.Z)" >&2; exit 1 ;;
esac

echo "==> Bumping $cur -> $new"
sed -i.bak -E "s/(Version:[[:space:]]*)[0-9]+\.[0-9]+\.[0-9]+/\1$new/" "$PLUGIN_PHP"
sed -i.bak -E "s/(VERIVYX_VERSION', ')[0-9]+\.[0-9]+\.[0-9]+/\1$new/" "$PLUGIN_PHP"
rm -f "$PLUGIN_PHP.bak"

echo "==> Building zip"
bash "$BUILD_SH"

echo "==> Writing update metadata $JSON_OUT"
mkdir -p "$PUBLIC_DIR"
today="$(date +%Y-%m-%d)"
cl_escaped="$(printf '%s' "$changelog" | sed 's/\\/\\\\/g; s/"/\\"/g')"
cat > "$JSON_OUT" <<EOF
{
  "name": "Verivyx Paywall",
  "slug": "verivyx-paywall",
  "version": "$new",
  "download_url": "https://verivyx.com/verivyx-paywall.zip",
  "requires": "5.8",
  "tested": "6.5",
  "requires_php": "8.0",
  "last_updated": "$today",
  "homepage": "https://verivyx.com",
  "sections": {
    "changelog": "<h4>$new</h4><ul><li>$cl_escaped</li></ul>"
  }
}
EOF

echo "==> Done (v$new). Review, then commit:"
echo "    git add $PLUGIN_PHP \\"
echo "            $ROOT/services/wordpress-plugin/verivyx-paywall.zip \\"
echo "            $JSON_OUT $PUBLIC_DIR/verivyx-paywall.zip"
echo "    git commit -m \"release(wordpress): v$new\""
