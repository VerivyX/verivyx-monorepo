# OZ Stellar Smart-Account API — Spike Findings

**Date:** 2026-06-20  
**Branch:** refactor/strict-review  
**Status:** DONE — all 7 tests pass

---

## Crate / Version

| Crate | Version pinned in workspace | SDK requirement |
|---|---|---|
| `stellar-accounts` | `0.5.0` | `soroban-sdk ^23.0.2` |
| `soroban-sdk` (workspace) | `23.5.3` | — |

Compatibility: **confirmed**. `stellar-accounts 0.5.0` resolves cleanly against `soroban-sdk 23.5.3`.  
Latest on crates.io is `0.7.2` — the workspace pins `0.5.0` which is what was tested.

---

## API Surface — Confirmed vs Brief

### `add_context_rule` — CORRECTED

Brief assumed separate `add_signer` / `add_policy` calls after rule creation.  
Actual API: rules are created atomically with all signers and policies in one call:

```rust
pub fn add_context_rule(
    e: &Env,
    context_type: &ContextRuleType,
    name: &String,
    valid_until: Option<u32>,
    signers: &Vec<Signer>,
    policies: &Map<Address, Val>,  // addr → install_param
) -> ContextRule
```

`add_signer` and `add_policy` also exist as separate functions for post-creation mutation.  
The brief's assumed call order (create → add_signer → add_policy) is technically possible but the standard pattern is the atomic `add_context_rule` call.

### `Signer` enum — CONFIRMED

```rust
pub enum Signer {
    Delegated(Address),          // soroban Address; uses addr.require_auth_for_args(payload)
    External(Address, Bytes),    // verifier contract addr + raw public key bytes
}
```

`Signer::Delegated(session_addr)` is the correct type for a session key that is a Soroban address / ed25519 key pair. Authentication is handled by `addr.require_auth_for_args(signature_payload_hash)`.

### `ContextRuleType` — CONFIRMED

```rust
pub enum ContextRuleType {
    Default,
    CallContract(Address),
    CreateContract(BytesN<32>),
}
```

### `ContextRule` struct — CONFIRMED

```rust
pub struct ContextRule {
    pub id: u32,
    pub context_type: ContextRuleType,
    pub name: String,
    pub signers: Vec<Signer>,
    pub policies: Vec<Address>,
    pub valid_until: Option<u32>,  // ledger sequence; None = no expiry
}
```

### `do_check_auth` — CONFIRMED (signature slightly different from brief)

Brief assumed `AuthPayload { signers: Map<Signer,Bytes>, context_rule_ids: Vec<u32> }`.  
Actual:

```rust
pub fn do_check_auth(
    e: &Env,
    signature_payload: &Hash<32>,
    signatures: &Signatures,       // newtype: Signatures(Map<Signer, Bytes>)
    auth_contexts: &Vec<Context>,
) -> Result<(), SmartAccountError>
```

No `context_rule_ids` in the payload — rule matching is automatic (context type → rule lookup).  
`Signatures` is a newtype over `Map<Signer, Bytes>`. For `Delegated` signers the `Bytes` value is ignored (verification is done via `require_auth_for_args`); it exists for `External` signers only.

### Module visibility — FINDING

`storage` submodule in `stellar_accounts::smart_account` is **private**. All public types and functions are re-exported from `stellar_accounts::smart_account` directly:

```rust
use stellar_accounts::smart_account::{
    add_context_rule, add_policy, add_signer, do_check_auth,
    ContextRule, ContextRuleType, Signatures, Signer, ...
};
```

Do NOT use `stellar_accounts::smart_account::storage::*`.

---

## Destination-Lock Verification — CONFIRMED

**Decision: adapter-via-`CallContract`** is valid.

`get_validated_context` in `storage.rs` extracts the called contract address from `Context::Contract { contract, .. }` and looks up rules matching `ContextRuleType::CallContract(contract)`. If no matching rule exists and no `Default` rule covers it, it panics with `SmartAccountError::UnvalidatedContext` (#3002).

**Test results:**
- `test_destination_lock_correct_target_succeeds` — PASS: session signer authorized for `target_addr` → `do_check_auth` returns Ok
- `test_destination_lock_wrong_target_rejected` — PASS: call to `other_addr` with rule locked to `target_addr` → panics #3002

**Implication for production adapter:** A thin adapter contract that only ever calls `paywall_core::pay(...)` will lock the session key to that single contract. No custom policy needed for destination restriction. The `CallContract(adapter_addr)` rule in the smart account is the lock.

---

## `spending_limit` Policy — FINDINGS

### Architecture — CORRECTED from brief

The brief stated policies are "separate deployed contracts referenced by Address". This is **partially true**: the Policy trait defines the interface for deployed contracts. However, the `stellar-accounts` crate ships the spending_limit logic as **module-level free functions**, not a self-contained deployable WASM.

To use spending_limit via `add_policy(addr)`, you must deploy a contract that wraps the free functions by implementing the `Policy` trait. This is what the spike's `SpendingLimitPolicyContract` demonstrates.

### `SpendingLimitAccountParams` — install_param shape

```rust
pub struct SpendingLimitAccountParams {
    pub spending_limit: i128,   // max stroops per period
    pub period_ledgers: u32,    // rolling window in ledgers (~17280 = 1 day)
}
```

This is the `install_param` value passed to `add_policy` (serialized as `Val`).

### Policy logic

- Inspects `Context::Contract { fn_name: symbol_short!("transfer"), args, .. }` only
- Extracts `amount = args.get(2)` (third arg = amount in token transfer)
- Maintains rolling history of spending entries with `ledger_sequence`
- Returns `SpendingLimitError::SpendingLimitExceeded` (#3221) from `enforce` when over budget
- Returns `false` from `can_enforce` when over budget (pre-check, no state change)

### Test design note — `require_auth` in test env

`sl_install` and `sl_enforce` each call `smart_account.require_auth()`. In the Soroban unit test environment, calling `require_auth` on the same address twice within a single `e.as_contract(...)` frame triggers `Error(Auth, ExistingValue)` — "frame is already authorized". The fix is to separate install and enforce into distinct `e.as_contract(...)` invocations (state persists across frames within the same `Env`). This is a **test-only constraint**; in production, the host's auth framework handles multiple require_auth calls across separate auth invocations correctly.

---

## `valid_until` — CONFIRMED

Rules with `valid_until = Some(ledger_seq)` are skipped when `e.ledger().sequence() > valid_until`. Confirmed by `test_expired_rule_rejected` — advancing the ledger past the expiry causes `do_check_auth` to fail with #3002 (no valid rule).

---

## Soroban SDK Constraints

- `#![no_std]` required in contracts that use `soroban-sdk`
- `soroban-sdk` testutils feature required for `Address::generate`, `Ledger::set_sequence_number`, `Env::mock_all_auths`
- Build target `x86_64-unknown-linux-musl` (native in `rust:1-alpine`) drops `cdylib` with a warning — normal; for WASM production build add `--target wasm32-unknown-unknown`
- Network available in Docker for `cargo fetch` from crates.io

---

## Decisions for Plan 1 Task 2

1. **Use `add_context_rule(CallContract(adapter_addr), ...)` — destination lock confirmed**
2. **Spending limit contract**: must be a separate deployed contract wrapping OZ's free functions (or a standalone implementation of the `Policy` trait) — NOT the library functions called directly
3. **`Signer::Delegated(session_addr)`** is the correct type for the Verivyx agent session key
4. **`valid_until`** is a ledger sequence number — compute as `current_ledger + session_ttl_ledgers`
5. **`add_context_rule` install** takes `Map<Address, Val>` where Val is the serialized `SpendingLimitAccountParams`
