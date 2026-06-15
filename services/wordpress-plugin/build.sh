#!/usr/bin/env bash
# Build verivyx-paywall.zip — ready to upload to WordPress
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="$SCRIPT_DIR/verivyx-paywall.zip"

cd "$SCRIPT_DIR"
rm -f "$OUT"
zip -r "$OUT" verivyx-paywall/ \
  --exclude "*.DS_Store" \
  --exclude "__MACOSX/*" \
  --exclude "verivyx-paywall/tests/*"

# Keep the public download in sync so creators always get the latest plugin.
WEB_PUBLIC="$SCRIPT_DIR/../../web/public/verivyx-paywall.zip"
if [ -d "$(dirname "$WEB_PUBLIC")" ]; then
  cp "$OUT" "$WEB_PUBLIC"
  echo "Synced to web/public: $WEB_PUBLIC"
fi

echo "Built: $OUT"
echo "Install: WordPress Admin → Plugins → Upload Plugin → choose verivyx-paywall.zip"
