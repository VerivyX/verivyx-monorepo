# OZ Session-Key Delegated `adapter.pay` — On-Chain Spike Findings

**Date:** 2026-06-20
**Branch:** `refactor/strict-review`
**Status:** ✅ **DONE — a session-key-authorized `adapter.pay` SETTLED on testnet.**
**Network:** Stellar Testnet (`Test SDF Network ; September 2015`), RPC `https://soroban-testnet.stellar.org`

> This is the keystone proof for the non-custodial MCP payment system (Plan 2 Task 2 `sessionPayment.ts`).
> A **delegated ed25519 session key** authorized `verivyx_pay_adapter.pay(owner, domain, slug)` through an
> **OpenZeppelin Stellar smart account** (`owner` = the smart account), settling a real USDC split —
> **without the owner's master key signing at pay time.**

---

## TL;DR — the settled proof

| Item | Value |
|---|---|
| **Session-key `adapter.pay` settle tx** | `b4feca50f38c6e46b2dde834455240f1f27bf9f32af6901bdc9e04e5b2b20dac` |
| Adapter (live, unchanged) | `CADDPCS2CAP4O66GBHRNO6G4SUJ6S6PCLM25Q5WAZ4Q43MACYMUITUC5` |
| Smart account (owner) | `CBT7K2B7KRWTUSHSWTGWUIIDA4WO2URICF5JIN3CRWY32FV5UH3KSHEU` |
| Session key (signer only) | `GAVPYJLHXV6LANM5OREB65X22MXZO5PLBONIPXJGYF4QPJUGQUVDG4NG` |
| Owner master key (NOT used at pay time) | `GDZW4TFH57UFKT5VRIIQVWMVN52J6IXBUTGD5JPDLOKFE5C35WFBQYCC` |
| **On-chain deltas** | owner(SA) **−510000**, creator **+490000**, platform **+20000** |

The owner master key signed **only the one-time setup** (approve + add rule). The pay was authorized
purely by the session key, validated by the smart account's `__check_auth`.

### Delta interpretation (matches the adapter spec exactly)
- price `500000`, platform_fee `10000`, fee_atomic `10000` (inferred — see below).
- creator `+490000` = `price − platform_fee`.
- platform `+20000` = `platform_fee (10000) + fee_atomic (10000)`. **The live adapter's `fee_treasury` == the
  `PLATFORM_STELLAR_ADDRESS`**, so the flat Verivyx fee leg lands on the same wallet as the platform leg →
  platform shows `+20000`.
- owner `−510000` = `price (500000) + fee_atomic (10000)`. The extra `10000` debit beyond price is the
  flat Verivyx service fee read from adapter storage (confirms `fee_atomic = 10000` on the deployed adapter).

---

## Chosen approach: **MANUAL** (`@stellar/stellar-sdk`), not `smart-account-kit`

`smart-account-kit@0.2.10` was investigated thoroughly and is **unsuitable as the signing path** for a
Node + ed25519-session-key flow:

- **Passkey-first.** `createWallet`, `sign`, `signAndSubmit` are WebAuthn/passkey-centric. Deployment
  (`deploy-ops.js`) hard-codes an `External` (WebAuthn verifier) signer into the constructor. There is no
  high-level "create wallet whose signer is a Delegated G-address" path.
- **Requires external `accountWasmHash` + `webauthnVerifierAddress` config.** The kit does **NOT** bundle
  the OZ account WASM nor a canonical published testnet hash (checked `constants.js` — no hash). You must
  upload the account WASM yourself regardless.
- **No bundled WASM in `smart-account-kit-bindings@0.1.2` either** (just JS bindings).

**What the kit IS good for (reference):** `dist/kit/multi-signer-ops.js` contains the *exact* XDR recipe for
signing an OZ smart-account auth entry with a Delegated G-address signer. The manual `authlib.js` in this
spike is a distilled, single-delegated-signer port of that recipe. **`sessionPayment.ts` should follow the
manual recipe below** (it does not need the kit at all).

> If a future browser flow wants the kit, the in-memory storage adapter exists at
> `smart-account-kit/dist/storage/memory.js` (solves the IndexedDB-in-Node problem), but it does not solve
> the passkey-vs-Delegated mismatch — the manual recipe is still required for ed25519 session keys.

---

## The OZ account WASM — how it was obtained

`smart-account-kit` does **not** ship the account WASM. Built it from the OZ examples:

- Source: `OpenZeppelin/stellar-contracts` **tag `v0.5.0`**, `examples/multisig/account` (the deployable
  smart-account contract; `__constructor(signers: Vec<Signer>, policies: Map<Address, Val>)` creates a
  `Default` context rule with the initial signers).
- Built standalone with `soroban-sdk 23.5.3` + `stellar-accounts 0.5.0` (workspace pins), `stellar contract build`.

| | |
|---|---|
| **OZ account WASM hash (uploaded to testnet)** | `40276717b7227725be75ad66ec2214aa95a29b47b36679a90f165be3f8fe09cb` |
| Exported fns | `__check_auth`, `__constructor`, `add_context_rule`, `add_signer`, `add_policy`, `execute`, `get_context_rule(s)`, `remove_*`, `update_context_rule_name`, `update_context_rule_valid_until` |

The crate source is committed at `docs/superpowers/spikes/scratch/oz_account/` (Cargo.toml + src). The
`stellar contract upload` was idempotent (deterministic hash).

> ⚠️ **SDK-version gotcha:** `@stellar/stellar-sdk@13.x` throws `Bad union switch: 4` decoding protocol-23
> transaction meta from testnet. **Use `@stellar/stellar-sdk@16.x`** (the spike used 16.0.1). This bug bit
> the WASM-upload result decode; the upload itself succeeded on-chain.

---

## THE MECHANISM — exact auth-entry construction (what `sessionPayment.ts` must build)

This is the core deliverable. Verified against OZ `do_check_auth` source
(`packages/accounts/src/smart_account/storage.rs` @ v0.5.0):

```rust
// OZ authenticate(): for each (signer, sig_bytes) in the Signatures map:
Signer::Delegated(addr) => {
    let args = (signature_payload.clone(),).into_val(e);  // 1-tuple of the SA payload hash
    addr.require_auth_for_args(args)                       // NESTED auth for the delegated key
}
```

So a session-key `adapter.pay` produces a **two-entry auth tree** in the transaction:

### Entry A — the smart account (outer)
- `credentials = SorobanCredentials::Address` with:
  - `address` = the smart account `C...`
  - `nonce` = **the nonce the host assigned during simulation** (do NOT invent one — take it from the
    sim's auth entry)
  - `signatureExpirationLedger` = `latestLedger + N` (spike used +100; must be ≥ the ledger the tx lands on)
  - `signature` = the OZ **`Signatures(Map<Signer, Bytes>)`** value, encoded as:

    ```
    scvVec([                                   // Signatures is a 1-field tuple struct → vec of len 1
      scvMap([                                 // the inner Map<Signer, Bytes>, KEYS SORTED
        { key: scvVec([ scvSymbol("Delegated"),// Signer::Delegated(addr)
                        scvAddress(sessionG) ]),
          val: scvBytes(<empty>) }             // Bytes IGNORED for Delegated (verified via require_auth_for_args)
      ])
    ])
    ```
- `rootInvocation` = exactly the smart-account invocation the host produced in sim (for `adapter.pay`, the
  host puts the smart account's `__check_auth`/context under the adapter call — just reuse the sim entry's
  `rootInvocation()` unchanged).

### Entry B — the delegated session key (nested, appended as a SEPARATE auth entry)
- Compute the smart account's **signature payload hash**:
  ```
  payload = SHA256( HashIdPreimage::envelopeTypeSorobanAuthorization {
    networkId: SHA256(networkPassphrase),
    nonce: <Entry A nonce>,
    signatureExpirationLedger: <Entry A exp>,
    invocation: <Entry A rootInvocation>,
  } )
  ```
- Build the delegated invocation: `__check_auth(payload)` **on the smart-account contract**:
  ```
  SorobanAuthorizedInvocation {
    function: contractFn(contract = smartAccount, fn = "__check_auth", args = [ scvBytes(payload) ]),
    subInvocations: [],
  }
  ```
- Compute the delegated entry's OWN preimage hash (its own fresh `nonce`, same `exp`, the invocation above),
  and **the session keypair signs that hash** (ed25519).
- `credentials = SorobanCredentials::Address` with `address = sessionG`, the fresh `nonce`, same `exp`, and
  `signature` = Stellar default-account ed25519 signature ScVal:
  ```
  scvVec([ scvMap([
    { key: scvSymbol("public_key"), val: scvBytes(<32-byte ed25519 pubkey>) },
    { key: scvSymbol("signature"),  val: scvBytes(<64-byte sig>) },
  ]) ])
  ```
- `rootInvocation` = the same `__check_auth(payload)` invocation.

**Attach BOTH entries** to the `invokeHostFunction` op's `auth` array, then re-simulate (for accurate
resource fees), assemble, sign the tx envelope with a **fee-payer/source** account (any funded G-account;
in production = the relayer), and submit.

> The reference implementation lives in `docs/superpowers/spikes/scratch/spike/authlib.js`
> (`signDelegated(...)`) — it is the literal code `sessionPayment.ts` should be ported from.

### Critical operational gotchas (each cost a real iteration)
1. **The delegated G-address MUST be a funded, on-chain classic account.** ed25519 `require_auth_for_args`
   reads the account entry; an unfunded delegated key fails with `Error(Storage, MissingValue)` →
   `Error(Auth, InvalidAction)`. Fund the session key via friendbot before first pay.
2. **`assembleTransaction` can strip manually-attached auth** — re-inject the signed `auth[]` into the op
   after assembling if it came back empty (the spike guards for this).
3. **ScMap keys must be sorted** (both the `Signatures` map and the signature sub-map).
4. **Take the nonce from simulation**, don't fabricate it for Entry A.

---

## Delegation setup (one owner-signed flow) — the calls

Done in `04-setup-delegation.js`, each authorized by the **owner master key** as the `Delegated` signer on
the account's `Default` rule (same Entry-A/Entry-B nesting, signer = owner master instead of session):

1. **`USDC.approve(from = smartAccount, spender = adapter, amount = budget, expiration_ledger)`**
   - This allowance **IS the session budget** (Path B decision). Each `pay` debits `price + fee_atomic` from
     the allowance; when exhausted, `transfer_from` fails. No custom policy contract.
   - Spike budget = `1_020_000` (covers ~2× `price+fee`). approve tx
     `3151ad1802beb8784d221c0892921877c62d7669efb359c99f83c7c15963d577`.
2. **`smartAccount.add_context_rule(CallContract(adapter), valid_until, [Delegated(session)], {})`**
   - `ContextRuleType::CallContract(adapter)` = the **destination-lock** (session key can only authorize
     calls to the adapter).
   - `valid_until` (ledger seq) = the session **expiry**.
   - add-rule tx `adec01558ce6ee9951b4ad3f25d1bfd6fe0d6d2139480761b67ae52c00ca4180`, rule id `1`,
     `valid_until = 3194627`.

ScVal encodings used (see `lib.js`):
- `Signer::Delegated(addr)` → `scvVec([ scvSymbol("Delegated"), scvAddress(addr) ])`
- `ContextRuleType::CallContract(addr)` → `scvVec([ scvSymbol("CallContract"), scvAddress(addr) ])`
- `Option<u32>` valid_until → `scvU32(v)` or `scvVoid()`
- policies `Map<Address,Val>` → `scvMap([])` (empty — no policy, budget = allowance)

> Funding note: contract addresses (the smart account) hold SAC USDC balances **without a trustline** —
> confirmed (faucet `transfer` straight to the `C...` worked). Only the G-address **creator** needed a
> `changeTrust` to `USDC:<issuer>`.

---

## Guard verification (negative assertions — both proven on-chain)

| Guard | Test | Result |
|---|---|---|
| **G1 — non-session signer rejected** | Sign `adapter.pay` with `ATTACKER` (not on any rule) | ❌ `Error(Auth, InvalidAction)` (no rule matches → `UnvalidatedContext #3002`). **PASS** — attacker cannot pay. |
| **G2 — expired rule rejected** | `update_context_rule_valid_until(rule, latest+3)`, wait until ledger passes it, then session-pay | ❌ `Error(Auth, InvalidAction)` (rule skipped, no valid context). **PASS** — session key rejected after expiry. shorten tx `1daac1a56023000137dad7730a2912ebaa7866e2096cb3666a66e2e6abbf9aee`. |

**Bonus finding:** OZ `update_context_rule_valid_until` **rejects setting `valid_until` to a past ledger**
with `Error(Contract, #3005)` ("ValidUntilInThePast"). Can't insta-expire; must shorten to near-future and
let the ledger advance. Useful built-in safety.

Destination-lock (G3) is enforced by the `CallContract(adapter)` rule type and was confirmed structurally
in the earlier unit-test spike (`oz-smart-account-findings.md`, `#3002` on wrong target); the on-chain G1
above also exercises the same `get_validated_context` rejection path.

---

## Implications for `sessionPayment.ts` (Plan 2 Task 2)

1. **Go manual with `@stellar/stellar-sdk` ≥ 16.** Port `authlib.js::signDelegated`. Do not depend on
   `smart-account-kit` for signing.
2. **The single most important thing:** the session key signs a **nested `__check_auth(payload)` auth entry**
   where `payload` is the smart account's own Soroban-auth preimage hash, and the smart-account (outer)
   entry carries `Signatures = scvVec([ scvMap([ {Delegated(session): empty} ]) ])`. Build BOTH entries and
   attach BOTH to the op. (Full XDR shape above.)
3. **Flow:** simulate `adapter.pay` (no auth) → read the host's smart-account auth entry (keep its nonce +
   rootInvocation) → set exp + Signatures on it → derive payload → build + sign the delegated entry →
   attach both → re-simulate → assemble → fee-payer (relayer) signs envelope → submit → poll.
4. **Budget = the USDC allowance** to the adapter; **expiry = the rule `valid_until`**; **destination-lock =
   `CallContract(adapter)`**. All audited OZ/SEP-41 primitives, zero custom security code.
5. **Pre-req invariant:** the session G-address must be a funded on-chain account before its first pay.
6. **fee_atomic is real and storage-fixed** — the deployed adapter debits an extra `10000` beyond price.
   `sessionPayment.ts` budget math must be `price + platform_fee` is inside price already, so total owner
   debit = `price + fee_atomic`; size the allowance accordingly (`Σ pays × (price + fee_atomic)`).

---

## Reproduction (all via Docker; host has no toolchain)

Scripts under `docs/superpowers/spikes/scratch/spike/` (run with `node:20-alpine`, `--network host`,
`--env-file chain.env`). State + secrets are gitignored (`state.json`, `secrets.env`, `chain.env`,
`node_modules`). Throwaway secrets persisted to `.env` as `SPIKE_OZ_*` (gitignored).

```
01-keys.js            generate + friendbot-fund the 5 keypairs
02-deploy-account.js  upload OZ account WASM + deploy instance (signer = Delegated(ownerMaster))
03-setup-chain.js     register test domain via keeper, CREATOR trustline, fund SA with USDC
04-setup-delegation.js  owner-signed: USDC.approve(adapter,budget) + add_context_rule(CallContract(adapter),...)
05-session-pay.js     THE CRUX: adapter.pay signed by SESSION key only → settle + verify deltas
06-guards.js          G1: non-session signer rejected
07-guard-expiry.js    G2: shorten valid_until, wait, session-pay rejected
lib.js / authlib.js   shared helpers; authlib.signDelegated = the deliverable mechanism
oz_account/           the OZ multisig account crate (built → wasm hash above)
```

Build the OZ account WASM:
```
docker run --rm -v <repo>/docs/superpowers/spikes/scratch/oz_account:/work -w /work \
  --entrypoint sh stellar-cli-fixed -c "stellar contract build"
# → target/wasm32v1-none/release/oz_smart_account.wasm, hash 40276717...
```
