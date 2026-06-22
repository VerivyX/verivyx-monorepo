# verivyx_pay_adapter Makefile
# Requires: stellar CLI (https://developers.stellar.org/docs/tools/cli)
# All amounts in atomic USDC (7 decimals). 1 USDC = 10_000_000.

NETWORK ?= testnet
WASM    := target/wasm32v1-none/release/verivyx_pay_adapter.wasm

.PHONY: build test deploy init clean

## Build optimized WASM for Soroban deployment
build:
	stellar contract build --optimize

## Run all unit tests
test:
	cargo test

## Deploy adapter to Stellar Testnet (requires ADMIN_SECRET)
## Usage: ADMIN_SECRET=S... make deploy
deploy: build
	@[ -n "$$ADMIN_SECRET" ] || (echo "ERROR: ADMIN_SECRET not set" && exit 1)
	stellar contract deploy \
		--wasm $(WASM) \
		--source "$$ADMIN_SECRET" \
		--network $(NETWORK) \
		--fee 1000000 \
	| tee /tmp/adapter_id.txt
	@echo ""
	@echo "Contract ID: $$(cat /tmp/adapter_id.txt)"
	@echo "Set in .env: VERIVYX_PAY_ADAPTER_ID=$$(cat /tmp/adapter_id.txt)"

## Initialize deployed adapter (run once after deploy)
## Signature: init(usdc, paywall, fee_treasury, fee_atomic, platform)
## The adapter does a DIRECT 3-way split (no caller amount; price read on-chain
## from paywall_core::get_creator). There is NO pooled distribute path.
## MCP_FEE_ATOMIC   = MCP_FEE_USDC × 10^7 (default 10000 = 0.001 USDC).
## USDC_CONTRACT_ID  MUST equal the gateway/.env USDC_CONTRACT_ID (same token).
## SOROBAN_PAYWALL_CONTRACT_ID = deployed paywall_core contract address.
## MCP_FEE_TREASURY_STELLAR    = Verivyx treasury Stellar address receiving the flat fee.
## PLATFORM_ADDRESS            = platform fee destination. MUST equal paywall_core's
##                               platform_address (same env source) — it receives the
##                               platform_fee leg of the split.
## Usage: CONTRACT_ID=C... ADMIN_SECRET=S... USDC_CONTRACT_ID=C... SOROBAN_PAYWALL_CONTRACT_ID=C... MCP_FEE_TREASURY_STELLAR=G... MCP_FEE_ATOMIC=10000 PLATFORM_ADDRESS=G... make init
init:
	@[ -n "$$CONTRACT_ID" ]                  || (echo "ERROR: CONTRACT_ID not set"                  && exit 1)
	@[ -n "$$ADMIN_SECRET" ]                 || (echo "ERROR: ADMIN_SECRET not set"                 && exit 1)
	@[ -n "$$USDC_CONTRACT_ID" ]             || (echo "ERROR: USDC_CONTRACT_ID not set"             && exit 1)
	@[ -n "$$SOROBAN_PAYWALL_CONTRACT_ID" ]  || (echo "ERROR: SOROBAN_PAYWALL_CONTRACT_ID not set"  && exit 1)
	@[ -n "$$MCP_FEE_TREASURY_STELLAR" ]     || (echo "ERROR: MCP_FEE_TREASURY_STELLAR not set"     && exit 1)
	@[ -n "$$MCP_FEE_ATOMIC" ]               || (echo "ERROR: MCP_FEE_ATOMIC not set"               && exit 1)
	@[ -n "$$PLATFORM_ADDRESS" ]             || (echo "ERROR: PLATFORM_ADDRESS not set"             && exit 1)
	stellar contract invoke \
		--id "$$CONTRACT_ID" \
		--source "$$ADMIN_SECRET" \
		--network $(NETWORK) \
		-- init \
		--usdc "$$USDC_CONTRACT_ID" \
		--paywall "$$SOROBAN_PAYWALL_CONTRACT_ID" \
		--fee_treasury "$$MCP_FEE_TREASURY_STELLAR" \
		--fee_atomic "$$MCP_FEE_ATOMIC" \
		--platform "$$PLATFORM_ADDRESS"

clean:
	cargo clean
