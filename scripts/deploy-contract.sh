#!/bin/bash
set -e

# Configuration
NETWORK="${1:-testnet}"
SOURCE_ACCOUNT="${2:-admin}" # Needs to be configured in stellar-cli

echo "🚀 Deploying Paywall AI contracts to $NETWORK..."

# 1. Build & Optimize
cd services/soroban-contracts/paywall_core
stellar contract build --optimize

# 2. Deploy
echo "📦 Uploading WASM..."
# Path for optimized WASM in a workspace setup
WASM_PATH="../target/wasm32v1-none/release/paywall_core.wasm"

CONTRACT_ID=$(stellar contract deploy \
  --wasm "$WASM_PATH" \
  --source "$SOURCE_ACCOUNT" \
  --network "$NETWORK")

echo "✅ Contract deployed successfully!"
echo "CONTRACT_ID: $CONTRACT_ID"
echo ""
echo "Next steps:"
echo "1. Add this CONTRACT_ID to your .env file."
echo "2. Update STELLAR_NETWORK=$NETWORK in your .env file."
echo "3. Restart your services: docker compose up -d"
