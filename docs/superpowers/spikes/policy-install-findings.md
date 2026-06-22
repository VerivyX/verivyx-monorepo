# Non-Custodial Pay Failure — Root Cause & Fix (spending_limit "Storage MissingValue")

**Date:** 2026-06-22
**Branch:** `refactor/strict-review`
**Status:** ✅ **FIXED — root-caused on-chain + validated on-chain that a dashboard-style delegation lets the session key transfer.**
**Network:** Stellar Testnet, RPC `https://soroban-testnet.stellar.org`

---

## TL;DR

The error was **misattributed to the spending_limit policy.** The policy params ARE installed
correctly by the dashboard's `add_policy` path (verified PRESENT on-chain for Rio's account). The
real cause is that **the MCP-issued session signer's classic Stellar G-account never exists on-ledger**.
At pay time the OZ smart account's `__check_auth` verifies the `Delegated` session signer via
`require_auth_for_args`, which forces the host to LOAD that signer's account entry — and a never-funded
account has no entry → `Error(Storage, MissingValue) "trying to get non-existing value for account"`
→ `require_auth_for_args` traps → `__check_auth` → `Error(Auth, InvalidAction)`.

The proven spike worked **only** because its bootstrap explicitly friendbot-funded the session key.
Production (`mcp-server` `POST /wallet/session-signer`) issues `Keypair.random()` and never funds it.

**Fix:** `web/src/lib/smartAccount.ts` `delegate()` now ensures the session signer G-account exists
on-ledger (owner-funded `createAccount`, idempotent) before adding the context rule.

---

## Step 1 — the policy's storage key (OZ stellar-accounts 0.5.0 `spending_limit`)

- Key: `SpendingLimitStorageKey::AccountContext(Address smart_account, u32 context_rule.id)` — **persistent** storage.
- `install(params, context_rule, smart_account)` calls `smart_account.require_auth()` then
  `persistent().set(AccountContext(sa, rule.id), SpendingLimitData{...})`.
- `can_enforce` / `enforce` read `AccountContext(sa, rule.id)` and `extend_ttl` (threshold ~26d, extend ~30d).
- `enforce` missing-data path panics with the **contract** error `SmartAccountNotInstalled` — NOT a host
  `Storage(MissingValue)`. So the bug's host-level `Storage(MissingValue)` is **not** this storage.
- Both `add_context_rule(policies)` and `add_policy(id, policy, param)` call
  `PolicyClient::install(param, rule, current_contract_address())` identically — the prior commit message
  (`109dbc4`) claiming the atomic `add_context_rule` map "attaches without storing params" is **incorrect**;
  both paths install. (The 2-step path is fine, just not for the reason stated.)

## Step 2 — on-chain inspection of Rio's account (`getLedgerEntries`)

`dbg-inspect-policy.mjs` built the contract-data ledger key
`AccountContext(CCL7DGCR…, rule_id)` (persistent) under policy `CBGLHQVG…`:

```
RIO (CCL7DGCR) AccountContext rule#3: PRESENT liveUntil=3342862
   val={spending_limit:10000000, period_ledgers:100, cached_total_spent:0, spending_history:[]}
```

The param entry **exists and is NOT archived** (current ledger ~3222128 ≪ liveUntil 3342862).
The dashboard delegation installed the spending limit correctly. The policy was a red herring.

## Step 3 — isolation reproduction (fresh account, dashboard's exact delegate path)

`dbg-repro-dashboard.mjs`: fresh owner+session+recipient; deploy OZ account
(wasm `40276717…`); run the dashboard delegate path byte-for-byte
(`add_context_rule[empty policies]` → query ruleId → `add_policy(ruleId, CBGLHQVG, spendingLimitParams)`),
signing the owner two-entry tree via the SDK `authorizeEntry` (= what the dashboard does with Freighter,
substituting a local ed25519 callback); then `signDelegated` a session-key `USDC.transfer` and simulate.

Observations:
- `add_context_rule` and `add_policy` each simulate to **exactly one** SA auth entry, `subs=[]` — the nested
  `install` `require_auth` is coalesced into the same entry; the owner two-entry tree authorizes it fine.
- Policy param storage **PRESENT** after `add_policy` (same as Rio).
- Session-key `USDC.transfer` re-sim with the session account **MISSING**:
  ```
  Error(Auth, InvalidAction)
   #4 Error(Storage, MissingValue): "trying to get non-existing value for account"
   #3 failed account authentication … <session G-addr> … Error(Storage, MissingValue)
   #2 escalating … require_auth_for_args
   #1 VM call trapped … __check_auth, Error(Auth, InvalidAction)
  ```
  **Exact reproduction of Rio's failure.**
- Same flow, session account **funded via friendbot (exists on-ledger)**:
  ```
  === PAY RE-SIM RESULT: SUCCESS — session key authorized USDC.transfer, NO Storage(MissingValue) ===
  minResourceFee: 500086
  ```

The ONLY variable flipped between failure and success is whether the **session signer's classic
G-account exists**. Not the policy, not the add_policy path, not the ScVal encoding, not a ruleId
mismatch, not TTL/archival, not the Freighter vs OWNERMASTER auth structure.

## Step 4 — root cause

OZ `__check_auth` verifies a `Signer::Delegated(G)` by `require_auth_for_args(G, …)`. The host loads
G's account entry to do so; a never-funded G-address has no entry → `Storage(MissingValue)`. The MCP's
session key (`endpoints.ts` `POST /wallet/session-signer` → `Keypair.random()`) is never funded, so the
account does not exist. The spike's bootstrap (`03/10-…`) friendbot-funded the session key, hiding the bug.

The error's word "account" is the **classic Stellar account ledger entry** of the signer — not the
policy's per-account storage. That phrasing is why this was attributed to the spending_limit policy.

## Step 5 — the fix

`web/src/lib/smartAccount.ts`:
- New `SESSION_ACCOUNT_STARTING_BALANCE = '2'` (XLM; base reserve).
- New `ensureSessionAccountExists(server, sessionPubkey, ownerAddress)`: idempotent — `getAccount` check;
  if missing, owner-signed classic `createAccount(destination=session, startingBalance=2 XLM)` via Freighter.
- `delegate()` calls it as **Step 0a**, before any rule is added.

Owner already pays gas for the delegation and is connected via Freighter, so this is the natural layer.
The session key never sources a tx and never holds payment funds; the base reserve is sufficient.

Validated: `npx tsc --noEmit` clean; `eslint` 0 errors (1 pre-existing unrelated warning). On-chain
validation = the FUND_SESSION repro above (session account exists ⇒ identical dashboard delegation ⇒
session-key `USDC.transfer` simulates SUCCESS, no `Storage(MissingValue)`).

---

## What Rio must do to recover account `CCL7DGCR…`

His **on-chain delegation is already correct** — rule id 3 + policy params are installed and valid
(valid_until 3342854, params PRESENT). The only missing piece is his session signer G-account
(`GBWJA6IPRXQOSS3QW7PWH7VDVCNHDDGOX567H2FPT5K6VV7PAMWDTBD2`) existing on-ledger.

Two recovery options:
1. **Re-run the dashboard "Re-authorize" (delegate) once** after this fix is deployed: Step 0a creates
   the session account, Step 0 removes the stale rule, Steps 1–2 re-add rule+policy on a clean id, and
   pay works. (Recommended — fully self-service.)
2. **Or just create the session account** (no re-delegation needed, since rule 3 + params are intact):
   one `createAccount`/payment to `GBWJA6IP…` with ≥1 XLM (e.g. friendbot on testnet, or any wallet).
   Once that account exists on-ledger, the existing rule 3 lets the session key transfer immediately.

No change to his smart account contract or policy is required.

---

## Reproduction scripts (gitignored under scratch)

`docs/superpowers/spikes/scratch/spike/` (run via `node:20-alpine`, `--network host`, `--env-file chain.env`):
- `dbg-inspect-policy.mjs` — getLedgerEntries probe of `AccountContext(SA, ruleId)` for Rio + spike accounts.
- `dbg-repro-dashboard.mjs` — fresh-account dashboard delegate path + session-key transfer sim.
  `FUND_SESSION=1` funds the session via friendbot (success path); default leaves it missing (repro).
