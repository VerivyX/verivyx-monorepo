# paywall_core Makefile
# Requires: stellar CLI (https://developers.stellar.org/docs/tools/cli)
# All amounts in atomic USDC (7 decimals). 1 USDC = 10_000_000.

NETWORK ?= testnet
WASM    := target/wasm32v1-none/release/paywall_core.wasm

.PHONY: build test deploy init invoke-register invoke-get clean

## Build optimized WASM for Soroban deployment
build:
	stellar contract build --optimize

## Run all unit tests
test:
	cargo test

## Deploy to Stellar Testnet (requires ADMIN_SECRET and PLATFORM_ADDRESS)
## Usage: ADMIN_SECRET=S... PLATFORM_ADDRESS=G... make deploy
deploy: build
	@[ -n "$$ADMIN_SECRET" ]     || (echo "ERROR: ADMIN_SECRET not set"     && exit 1)
	@[ -n "$$PLATFORM_ADDRESS" ] || (echo "ERROR: PLATFORM_ADDRESS not set" && exit 1)
	stellar contract deploy \
		--wasm $(WASM) \
		--source "$$ADMIN_SECRET" \
		--network $(NETWORK) \
		--fee 1000000 \
	| tee /tmp/contract_id.txt
	@echo ""
	@echo "Contract ID: $$(cat /tmp/contract_id.txt)"
	@echo "Set in .env: SOROBAN_PAYWALL_CONTRACT_ID=$$(cat /tmp/contract_id.txt)"

## Initialize deployed contract (run once after deploy)
## Signature: init(admin, platform_address, keeper, usdc)
## KEEPER_ADDRESS  = the facilitator/relayer account that calls distribute().
## USDC_CONTRACT_ID = the Soroban USDC token contract id; MUST equal the gateway/.env USDC_CONTRACT_ID.
## Usage: CONTRACT_ID=C... ADMIN_SECRET=S... PLATFORM_ADDRESS=G... KEEPER_ADDRESS=G... USDC_CONTRACT_ID=C... make init
init:
	@[ -n "$$CONTRACT_ID" ]      || (echo "ERROR: CONTRACT_ID not set"      && exit 1)
	@[ -n "$$ADMIN_SECRET" ]     || (echo "ERROR: ADMIN_SECRET not set"     && exit 1)
	@[ -n "$$PLATFORM_ADDRESS" ] || (echo "ERROR: PLATFORM_ADDRESS not set" && exit 1)
	@[ -n "$$KEEPER_ADDRESS" ]   || (echo "ERROR: KEEPER_ADDRESS not set"   && exit 1)
	@[ -n "$$USDC_CONTRACT_ID" ] || (echo "ERROR: USDC_CONTRACT_ID not set" && exit 1)
	stellar contract invoke \
		--id "$$CONTRACT_ID" \
		--source "$$ADMIN_SECRET" \
		--network $(NETWORK) \
		-- init \
		--admin "$$(stellar keys address "$$ADMIN_SECRET" 2>/dev/null || echo "$$ADMIN_SECRET")" \
		--platform_address "$$PLATFORM_ADDRESS" \
		--keeper "$$KEEPER_ADDRESS" \
		--usdc "$$USDC_CONTRACT_ID"

## Register a domain (testing)
## Usage: CONTRACT_ID=C... CREATOR_SECRET=S... DOMAIN=example.com PRICE=50000 FEE=500 make invoke-register
invoke-register:
	@[ -n "$$CONTRACT_ID" ]    || (echo "ERROR: CONTRACT_ID not set"    && exit 1)
	@[ -n "$$CREATOR_SECRET" ] || (echo "ERROR: CREATOR_SECRET not set" && exit 1)
	@[ -n "$$DOMAIN" ]         || (echo "ERROR: DOMAIN not set"         && exit 1)
	stellar contract invoke \
		--id "$$CONTRACT_ID" \
		--source "$$CREATOR_SECRET" \
		--network $(NETWORK) \
		-- register \
		--creator "$$(stellar keys address "$$CREATOR_SECRET" 2>/dev/null || echo "$$CREATOR_SECRET")" \
		--domain "$$DOMAIN" \
		--price $${PRICE:-50000} \
		--platform_fee $${FEE:-500}

## Look up a domain on-chain
## Usage: CONTRACT_ID=C... DOMAIN=example.com make invoke-get
invoke-get:
	@[ -n "$$CONTRACT_ID" ] || (echo "ERROR: CONTRACT_ID not set" && exit 1)
	@[ -n "$$DOMAIN" ]      || (echo "ERROR: DOMAIN not set"      && exit 1)
	stellar contract invoke \
		--id "$$CONTRACT_ID" \
		--network $(NETWORK) \
		-- get_creator \
		--domain "$$DOMAIN"

clean:
	cargo clean
