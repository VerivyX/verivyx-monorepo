# Soroban On-chain Registry — Verivyx

Kumpulan Soroban smart contracts (Rust/WASM) yang berjalan di Stellar Testnet/Mainnet sebagai **trustless on-chain registry** untuk domain creator.

---

## Contracts

### `paywall_core` (Primary)

Registry utama. Menyimpan mapping `domain → CreatorData` secara immutable on-chain.

**Functions:**

| Function | Auth | Description |
|---|---|---|
| `init(admin, platform_address, keeper)` | admin | Inisialisasi sekali setelah deploy |
| `register(creator, domain, price, platform_fee)` | creator | Creator daftarkan domain sendiri (trustless) |
| `register_by_keeper(domain, creator, price, platform_fee)` | keeper | Keeper mirror config DB off-chain ke on-chain |
| `get_creator(domain)` | — | Lookup config domain (read-only) |
| `pay(payer, domain, usdc_token)` | payer | Split langsung: agent → creator + platform (path SDK) |
| `distribute(domain, usdc_token, amount)` | keeper | Split saldo contract → creator + platform (path x402 spec) |
| `set_enabled(creator, domain, enabled)` | creator | Toggle paywall status on-chain |
| `upgrade(new_wasm_hash)` | admin | Upgrade WASM tanpa ganti contract ID |

**Dua path settlement:**
- **`pay`** — dipakai Verivyx agent-sdk. Agent panggil `pay()`, contract tarik dari saldo agent, split atomik ke creator+platform dalam 1 TX.
- **`distribute`** — dipakai AI/MCP eksternal (x402 spec). Agent kirim `USDC.transfer(agent, contract, amount)` (1 op spec-compliant), lalu keeper panggil `distribute()` untuk split saldo contract ke creator+platform. Fee platform terjamin on-chain.

**Storage:**
- Persistent storage dengan TTL extension (~120 hari)
- Key: `DataKey::Creator(domain)` → `CreatorData { address, price, platform_fee, enabled }`

---

## Deployment Evidence

Contract IDs and transaction hashes link to [stellar.expert](https://stellar.expert/explorer/testnet)
(Stellar **testnet**) so anyone can verify the deployment on-chain.

### v2 (current) — `distribute` + `upgrade` + `register_by_keeper`
- **Contract ID:** [`CAERLWHD47NXIAWNPXUF726BNHPFCYSFU3BVVMWQ2G4LBPWG7GXUTGXH`](https://stellar.expert/explorer/testnet/contract/CAERLWHD47NXIAWNPXUF726BNHPFCYSFU3BVVMWQ2G4LBPWG7GXUTGXH)
- Deploy TX: [`9080b37dc50576ace89051a593f0ec9bf983d462f625745233394ec649291f77`](https://stellar.expert/explorer/testnet/tx/9080b37dc50576ace89051a593f0ec9bf983d462f625745233394ec649291f77)
- Init TX (admin/platform/keeper): [`296780758a1beef17ee46eac7201cf987baade8a337c73df644dbcef69a57900`](https://stellar.expert/explorer/testnet/tx/296780758a1beef17ee46eac7201cf987baade8a337c73df644dbcef69a57900)
- Upgrade TX (v2.1 register_by_keeper): [`20c6e13aebee6ff501b3545ba30895db699277397597c0fafb51d7da219f47af`](https://stellar.expert/explorer/testnet/tx/20c6e13aebee6ff501b3545ba30895db699277397597c0fafb51d7da219f47af)
- WASM hash: `3aa0347e9c75f80964156c137caca893e0b9a0cafafe61a707dc6b8b77b8cbec`
- platform = `GDCPLKM7CKTQZVKJY4UXBNFLF6N3MT3ENKPTUG4FUGPIUTOQLXZISC6X`
- keeper = `GDZMUCHZNAHEK6Z5AU4OHE2AAGGZHNFDTJTDOYB4NCKLXVGBCQX2FYXL` (facilitator)

### v1 (historical)
- Contract ID: [`CD324WNNZA6BF5HYZLMPBEIBKXUJXX7HJSWEEBRGFJQ22FKBN3GJVRQF`](https://stellar.expert/explorer/testnet/contract/CD324WNNZA6BF5HYZLMPBEIBKXUJXX7HJSWEEBRGFJQ22FKBN3GJVRQF)
- Deploy TX: [`e1ab24491087f0f941c1c2d002076589137b10260cc19266f31f32272480b948`](https://stellar.expert/explorer/testnet/tx/e1ab24491087f0f941c1c2d002076589137b10260cc19266f31f32272480b948)
- Init TX: [`c6680c76d9756b21aa0e33a1e86cf8776cbca6daf7d93660a5bdd3e578b39a62`](https://stellar.expert/explorer/testnet/tx/c6680c76d9756b21aa0e33a1e86cf8776cbca6daf7d93660a5bdd3e578b39a62)

### `service_registry`

Registry sederhana untuk discovery domain. Subset dari `paywall_core`.

### `smart_account`

Account abstraction untuk agent wallet (future use).

---

## Build

Prerequisites: Docker (tidak perlu install Rust/Stellar CLI lokal)

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

## Deploy ke Testnet

```bash
# Fund admin wallet (faucet)
stellar keys fund <ADMIN_PUBLIC_KEY> --network testnet

# Deploy
stellar contract deploy \
  --wasm paywall_core/target/wasm32v1-none/release/paywall_core.wasm \
  --source <ADMIN_SECRET_KEY> \
  --network testnet

# Catat: CONTRACT_ID dan TRANSACTION_HASH
```

---

## Test

```bash
cd paywall_core
cargo test
```

---

## Integrasi dengan Gateway

Gateway (`x402-gateway`) saat ini menggunakan PostgreSQL (via auth-service) sebagai primary domain lookup karena latency lebih rendah (<3ms vs ~500ms Soroban RPC).

Soroban berfungsi sebagai:
1. **Bukti trustless** — siapapun bisa verify domain → address mapping tanpa percaya Verivyx
2. **Immutable audit trail** — semua registration tercatat on-chain
3. **Future: trustless payment** — AI agent bayar langsung via `pay()` tanpa facilitator

Env vars setelah deploy:
```
SOROBAN_PAYWALL_CONTRACT_ID=<contract_id>
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
SOROBAN_NETWORK=testnet
```

---

## Invariants Penting

- Semua USDC amounts pakai **7 desimal** atomic units. `1 USDC = 10_000_000`.
- Tidak ada `unwrap()` atau `panic!()` — semua error via `ContractError` enum.
- TTL wajib di-extend setiap persistent write (data expired jika tidak).
- `pay()` wajib 2 transfer: creator share + platform fee (bukan 1 ke creator saja).
