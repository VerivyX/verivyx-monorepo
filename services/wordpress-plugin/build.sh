#!/usr/bin/env bash
# Build verivyx-paywall.zip — ready to upload to WordPress
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="$SCRIPT_DIR/verivyx-paywall.zip"

cd "$SCRIPT_DIR"
rm -f "$OUT"
zip -r "$OUT" verivyx-paywall/ --exclude "*.DS_Store" --exclude "__MACOSX/*"

# Keep the dashboard download in sync so creators always get the latest plugin.
DASHBOARD_PUBLIC="$SCRIPT_DIR/../dashboard-ui/public/verivyx-paywall.zip"
if [ -d "$(dirname "$DASHBOARD_PUBLIC")" ]; then
  cp "$OUT" "$DASHBOARD_PUBLIC"
  echo "Synced to dashboard: $DASHBOARD_PUBLIC"
fi

echo "Built: $OUT"
echo "Install: WordPress Admin → Plugins → Upload Plugin → choose verivyx-paywall.zip"
