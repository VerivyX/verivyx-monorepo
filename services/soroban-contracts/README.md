# Soroban On-chain Registry — Verivyx

A set of Soroban smart contracts (Rust/WASM) running on Stellar Testnet/Mainnet as a **trustless on-chain registry** for creator domains + on-chain payment settlement.

---

## Contracts

### `paywall_core` (Primary)

The main registry. Stores a `site → CreatorData` mapping in persistent on-chain storage and settles payments by splitting them between the creator and the platform.

**Functions:**

| Function | Auth | Description |
|---|---|---|
| `init(admin, platform_address, keeper, usdc)` | admin | One-time initialization after deploy |
| `register(creator, domain, price, platform_fee)` | creator | Creator registers their own site (trustless) |
| `register_by_keeper(domain, creator, price, platform_fee)` | keeper | Keeper mirrors the off-chain (dashboard) config onto the chain |
| `get_creator(domain)` | — | Look up a site's config (read-only) |
| `pay(payer, domain, usdc_token)` | payer | Direct atomic split: agent balance → creator + platform |
| `distribute(domain, usdc_token, amount)` | keeper | Split the contract's balance → creator + platform (x402 spec path) |
| `set_enabled(creator, domain, enabled)` | creator | Toggle paywall status on-chain |
| `upgrade(new_wasm_hash)` | admin | Upgrade the WASM without changing the contract ID |

> The registry key is a `String`: a site's domain when it has one, otherwise its `siteId` (`onchainKey = domain ?? siteId`). Existing domain-registered sites keep their domain as the on-chain key.

**Two settlement paths:**
- **`distribute`** (the live path) — used by the x402 gateway flow (SDK, WordPress, MCP). The agent sends `USDC.transfer(agent → contract, amount)` (one spec-compliant op), then the keeper calls `distribute()` to split the contract balance to creator + platform. The platform fee is guaranteed on-chain.
- **`pay`** — a single-TX atomic split directly from the agent's balance to creator + platform. The function exists in the contract but is **not** the live settlement path today.

**Storage:**
- Persistent storage with TTL extension (~120 days)
- Key: `DataKey::Creator(domain)` → `CreatorData { address, price, platform_fee, enabled }` (entries are updatable via `register`/`register_by_keeper`/`set_enabled`)

---

## Deployment Evidence

Contract IDs and transaction hashes link to [stellar.expert](https://stellar.expert/explorer/testnet)
(Stellar **testnet**) so anyone can verify the deployment on-chain.

### v2 (current) — `distribute` + `upgrade` + `register_by_keeper`
- **Contract ID:** [`CAERLWHD47NXIAWNPXUF726BNHPFCYSFU3BVVMWQ2G4LBPWG7GXUTGXH`](https://stellar.expert/explorer/testnet/contract/CAERLWHD47NXIAWNPXUF726BNHPFCYSFU3BVVMWQ2G4LBPWG7GXUTGXH)
- Deploy TX: [`9080b37dc50576ace89051a593f0ec9bf983d462f625745233394ec649291f77`](https://stellar.expert/explorer/testnet/tx/9080b37dc50576ace89051a593f0ec9bf983d462f625745233394ec649291f77)
- Init TX (admin/platform/keeper/usdc): [`296780758a1beef17ee46eac7201cf987baade8a337c73df644dbcef69a57900`](https://stellar.expert/explorer/testnet/tx/296780758a1beef17ee46eac7201cf987baade8a337c73df644dbcef69a57900)
- Upgrade TX (v2.1 register_by_keeper): [`20c6e13aebee6ff501b3545ba30895db699277397597c0fafb51d7da219f47af`](https://stellar.expert/explorer/testnet/tx/20c6e13aebee6ff501b3545ba30895db699277397597c0fafb51d7da219f47af)
- WASM hash: `3aa0347e9c75f80964156c137caca893e0b9a0cafafe61a707dc6b8b77b8cbec`
- platform = `GDCPLKM7CKTQZVKJY4UXBNFLF6N3MT3ENKPTUG4FUGPIUTOQLXZISC6X`
- keeper = `GDZMUCHZNAHEK6Z5AU4OHE2AAGGZHNFDTJTDOYB4NCKLXVGBCQX2FYXL` (facilitator)

### v1 (historical)
- Contract ID: [`CD324WNNZA6BF5HYZLMPBEIBKXUJXX7HJSWEEBRGFJQ22FKBN3GJVRQF`](https://stellar.expert/explorer/testnet/contract/CD324WNNZA6BF5HYZLMPBEIBKXUJXX7HJSWEEBRGFJQ22FKBN3GJVRQF)
- Deploy TX: [`e1ab24491087f0f941c1c2d002076589137b10260cc19266f31f32272480b948`](https://stellar.expert/explorer/testnet/tx/e1ab24491087f0f941c1c2d002076589137b10260cc19266f31f32272480b948)
- Init TX: [`c6680c76d9756b21aa0e33a1e86cf8776cbca6daf7d93660a5bdd3e578b39a62`](https://stellar.expert/explorer/testnet/tx/c6680c76d9756b21aa0e33a1e86cf8776cbca6daf7d93660a5bdd3e578b39a62)

### `service_registry`

A simple registry for domain discovery. A subset of `paywall_core` — currently dormant.

### `verivyx_pay_adapter`

- **Contract ID:** [`CADDPCS2CAP4O66GBHRNO6G4SUJ6S6PCLM25Q5WAZ4Q43MACYMUITUC5`](https://stellar.expert/explorer/testnet/contract/CADDPCS2CAP4O66GBHRNO6G4SUJ6S6PCLM25Q5WAZ4Q43MACYMUITUC5)

A destination-locked settlement adapter for non-custodial MCP payments. It pulls the resource price + platform fee + flat fee **atomically in one TX** from the owner via SEP-41 `transfer_from` (a 3-way split: creator + platform + fee). It reads the price/fee via a cross-call to `paywall_core.get_creator`. There is **no** pooled deposit and **no** cross-call to `paywall_core.distribute`.

Status: deployed + tested on testnet, but **not yet the live settlement path** — the live path today is `paywall_core.distribute` (see v2 above).

---

## Build

Prerequisites: Docker (no local Rust/Stellar CLI install required)

```bash
# Build optimized WASM
docker run --rm \
  -v $(pwd):/workspace \
  -w /workspace \
  stellar/stellar-cli:latest \
  contract build --optimize --manifest-path paywall_core/Cargo.toml

# Output: paywall_core/target/wasm32v1-none/release/paywall_core.wasm
```

---

## Deploy to Testnet

```bash
# Fund the admin wallet (faucet)
stellar keys fund <ADMIN_PUBLIC_KEY> --network testnet

# Deploy
stellar contract deploy \
  --wasm paywall_core/target/wasm32v1-none/release/paywall_core.wasm \
  --source <ADMIN_SECRET_KEY> \
  --network testnet

# Record: CONTRACT_ID and TRANSACTION_HASH
```

---

## Test

```bash
cd paywall_core
cargo test
```

---

## Integration with the Gateway

The gateway (`x402-gateway`) currently uses PostgreSQL (via auth-service) as the primary domain/site lookup for lower latency (<3ms vs ~500ms for Soroban RPC).

Soroban serves as:
1. **Trustless proof** — anyone can verify the site → address mapping without trusting Verivyx
2. **Immutable audit trail** — every registration and settlement is recorded on-chain
3. **On-chain settlement** — the keeper settles payments via `distribute()`; the `verivyx_pay_adapter` provides a fully trustless single-TX split path (deployed + tested)

Env vars after deploy:
```
SOROBAN_PAYWALL_CONTRACT_ID=<contract_id>
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
SOROBAN_NETWORK=testnet
```

---

## Key Invariants

- All USDC amounts use **7-decimal** atomic units. `1 USDC = 10_000_000`.
- No `unwrap()` or `panic!()` — every error goes through the `ContractError` enum.
- TTL must be extended on every persistent write (data is archived if not).
- `pay()` must do 2 transfers: creator share + platform fee (not a single transfer to the creator only).
