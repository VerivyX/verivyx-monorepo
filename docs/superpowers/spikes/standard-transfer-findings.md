# Standard x402 Transfer, Non-Custodial via OZ Session Key — On-Chain Spike Findings

**Date:** 2026-06-21
**Branch:** `refactor/strict-review`
**Status:** ✅ **DONE — a session-key-authorized STANDARD `USDC.transfer` settled on testnet; budget + expiry both proven on-chain.**
**Network:** Stellar Testnet (`Test SDF Network ; September 2015`), RPC `https://soroban-testnet.stellar.org`
**Validates:** `docs/superpowers/specs/2026-06-21-noncustodial-x402-standard.md` (the non-custodial MCP payment = standard x402 exact-scheme transfer, not the Verivyx adapter).

> This proves the **global-standard** x402 exact-scheme payment — `USDC.transfer(from, to, amount)` (SEP-41) —
> works **non-custodially** via an OpenZeppelin smart account + a delegated ed25519 session key, with a
> spending-limit **budget** and a `valid_until` **expiry** both enforced on-chain. The wire payment is the
> unmodified x402 transfer; any x402 facilitator settles it. Non-custodial-ness lives entirely in the payer
> wallet and is invisible to the protocol.

---

## TL;DR — the settled proofs

| Item | Value |
|---|---|
| **CORE: session-key standard `USDC.transfer` settle tx** | `10f4fe6ffd72710dff961f58b380a8c6077cd554c253da3e043440e0651513b7` |
| **BUDGET within-limit transfer (settled)** | `4c2de43b5fa8d5de4ab1bbb9075e57e3a0f6c4a4c8f3f05c15966178344c2e1e` |
| **BUDGET over-period-limit transfer (REJECTED)** | rejected at simulate, `Error(Auth, InvalidAction)` → policy `can_enforce → false` → `#3002` |
| **EXPIRY: shorten rule tx** | `82e88f45a3e832575c067af2c81dae4deae8cbb4ce707491b7e03bf15884f713` |
| **EXPIRY: post-expiry transfer (REJECTED)** | `Error(Auth, InvalidAction)` → rule skipped → `#3002` |
| Smart account (the x402 payer `from`) | `CBT7K2B7KRWTUSHSWTGWUIIDA4WO2URICF5JIN3CRWY32FV5UH3KSHEU` |
| Session key (signer only — no master at pay time) | `GAVPYJLHXV6LANM5OREB65X22MXZO5PLBONIPXJGYF4QPJUGQUVDG4NG` |
| Recipient (`payTo`, fresh trustlined G-account) | `GBJFBJYNVBKAH7X2ZC6WWVSVUUVZZMLOWE4F7OL22W6ENJABI7I2H2ML` |
| USDC SAC | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` |
| **CORE on-chain deltas** | SA **−1 000 000**, recipient **+1 000 000** (amount = 0.1 USDC) |

The session key alone authorized the transfer; the owner master key signed **only** the one-time delegation
setup (`add_context_rule`, `add_policy`).

---

## The six questions answered

### 1. Does `signDelegated` work UNCHANGED for a `transfer` invocation? — **YES.**
`docs/superpowers/spikes/scratch/spike/authlib.js::signDelegated` was used **byte-for-byte unchanged**. A
`transfer` is just another contract call: the host's simulation produced **exactly one** smart-account
auth entry (the SA is `from`, so `transfer` calls `from.require_auth`), and `signDelegated` re-signed it via
the two-entry delegated tree (outer SA `Signatures` map + nested `__check_auth(payload)` signed by the
session ed25519 key). No code change vs the adapter.pay spike. **The mechanism generalizes to any invocation.**

### 2. What `ContextRuleType` permits `USDC.transfer`? — **`CallContract(USDC_CONTRACT_ID)`.**
```
add_context_rule(
  ContextRuleType::CallContract(USDC_CONTRACT_ID),  // the called contract is the USDC SAC
  valid_until,
  [ Signer::Delegated(sessionPubkey) ],
  {} /* policies, added separately via add_policy */
)
```
`CallContract(USDC)` authorizes the session to call `USDC.transfer` to **any `to`** (the `payTo` is not part
of the rule predicate — only the called contract is). This is exactly what the standard transfer model needs:
`payTo` varies per resource; the **amount** is bounded by the spending-limit policy + the SA's USDC balance.
`Default` would also work but is broader than necessary; `CallContract(USDC)` is the tightest rule that still
permits arbitrary-`payTo` USDC payments. **Use `CallContract(USDC)`.**

### 3. Standard transfer settled non-custodially? — **YES** (tx `10f4fe6f…`, SA −1e6 / recipient +1e6).

### 4. Expiry guard? — **YES.** After `valid_until` passed, the session-authorized transfer was rejected
(`Error(Auth, InvalidAction)`, inner `Error(Contract, #3002)` UnvalidatedContext — the expired rule is
skipped so no rule validates the context).

### 5. Spending-limit budget? — **YES, proven on-chain with a real deployed policy contract.**
Built + deployed an OZ `spending_limit` Policy contract (the `Policy`-trait wrapper around the OZ
`spending_limit` module free-fns; pattern from `verivyx_pay_adapter/src/test.rs`) and `add_policy`'d it.
- Budget = `SpendingLimitAccountParams { spending_limit: 1_500_000, period_ledgers: 100 }`.
- Within-budget transfer (800 000) **SETTLED**.
- A second transfer (900 000) → period total 1 700 000 > 1 500 000 → **REJECTED**; diagnostics show the policy
  contract's `can_enforce` returning `false`, escalating to `#3002`.

### 6. Is the payload what a facilitator would settle? — **YES.**
The transaction is a single `invokeHostFunction` op whose host function is `invokeContract` calling
`transfer(from = smartAccount, to = payTo, amount)` on the USDC SAC — i.e. the x402 exact-scheme shape the
facilitator's `verify` requires (`services/mcp-server/src/core/stellar/exact/`). The only non-default piece
is the op's `auth[]`, which carries the **two OZ delegated auth entries** (outer SA + nested session-key
`__check_auth`). This auth is part of the standard Soroban auth model and is validated on-chain at settle —
**transparent to the x402 protocol**. The signed envelope XDR (2956 bytes here) is the `{ transaction: <xdr> }`
payload. The only nuance for T3 (below) is *who builds it*.

---

## The policy contract (new this spike)

| | |
|---|---|
| Crate | `docs/superpowers/spikes/scratch/oz_policy/` (`soroban-sdk 23.5.3` + `stellar-accounts 0.5.0`) |
| **Policy WASM hash** | `2be7508a1be5968f369dab05e4c7890554a6ce4693c379791fef634a3ba917cd` |
| Exported fns | `can_enforce`, `enforce`, `install`, `uninstall` (the `Policy` trait) |
| Deployed instance (this spike) | `CBGLHQVGQEWBWW6JJXKLLMQZL3G4ENHFRBORLAUO2ZYVAJ2EZWYVMZC2` |
| upload tx / deploy tx / add_policy tx | `c1bc8d0f…` / `d00bac05…` / `3f2a89d0…` |

**`add_policy` install_param shape** (the `Val` passed to `add_policy(rule_id, policy_addr, install_param)`):
`SpendingLimitAccountParams { spending_limit: i128, period_ledgers: u32 }` serializes as an **ScMap with
sorted keys**:
```
scvMap([
  { key: scvSymbol("period_ledgers"), val: scvU32(period) },
  { key: scvSymbol("spending_limit"), val: scvI128(limit) },
])   // keys sorted ascending by XDR
```
(See `14-deploy-policy.js::spendingLimitParams`.) The policy is deployed **once** and the SAME instance can be
`add_policy`'d to many smart accounts' rules — `install` writes per-`(policy, rule, sa)` budget state keyed by
the smart account, so one deployed policy contract serves all users.

---

## Error mapping for production T5 (important nuance)

Both negative cases surface the **same outer** error: `Error(Auth, InvalidAction)` with inner
`Error(Contract, #3002)` (`UnvalidatedContext`). They are distinguishable by the diagnostic event log:

| Reject reason | Distinguishing diagnostic | Suggested T5 code |
|---|---|---|
| **Budget exceeded** | a `fn_call … <policy> … can_enforce` event whose `fn_return` is `false`, THEN `#3002` | `delegation_budget_exhausted` |
| **Rule expired** | **no** policy `can_enforce` call (rule skipped before policy eval), straight to `#3002` | `delegation_expired` |
| Non-session signer / no rule | `#3002`, no matching rule | `unauthorized` |
| SEP-41 balance/allowance | SAC error, not `#3002` | `insufficient_balance` |

> **Caveat:** the spec (line 62) anticipated `valid_until` → `__check_auth #3002` and budget → "spending-limit
> reject" as distinct error *codes*. On-chain they share `#3002`; **T5 must inspect the diagnostic event log
> (presence + `false` return of the policy `can_enforce` call) to separate budget vs expiry**, not rely on the
> contract error code alone. Both also fail at **simulation** (`resim`), so the MCP can map them pre-broadcast.

---

## Most important finding for building production T3

**The standard x402 transfer payload and `signDelegated` are fully compatible — but the standard
`signer.signAuthEntry` (SEP-43) path does NOT emit the nested Delegated entry, so T3 must build the payload
manually.** The x402 facilitator `verify` only cares that the op is `transfer(from=SA, to=payTo, amount)`; it
does not care how `auth[]` was produced. So the cleanest T3 is **NOT** to shoehorn a `ClientStellarSigner`
into the generic `signAuthEntries` flow (it would emit a single SA-credential entry without the required
nested session-key entry). Instead, T3 should be a **dedicated builder** that:
1. builds the `transfer(from=SA, to=payTo, amount)` op,
2. simulates to get the host's SA auth entry (nonce + rootInvocation),
3. runs `signDelegated` (ported from `authlib.js`) to produce BOTH entries,
4. attaches both to the op, re-simulates, assembles, and emits the envelope XDR as the standard
   `{ transaction: <xdr> }` x402 payload.

This is the SAME flow already proven for `adapter.pay` — only the op changes (USDC.transfer vs adapter.pay)
and the rule type (`CallContract(USDC)` vs `CallContract(adapter)`). `sessionPayment.ts`'s
`buildSessionPayment` generalizes by taking the op as a parameter; the auth machinery is identical.

---

## Reproduction (all via Docker; host has no toolchain)

Scripts under `docs/superpowers/spikes/scratch/spike/` (run with `node:20-alpine`, `--network host`,
`--env-file chain.env`). `chain.env`/`state.json`/`node_modules`/`*.wasm` are gitignored (under `/docs/`).
Throwaway recipient secret persisted in `state.json` (gitignored); reuses the prior spike's `SPIKE_OZ_*`.

```
make-chain-env.js          extract the whitelisted env keys from repo-root .env into chain.env
10-bootstrap-transfer.js   reuse SPIKE_OZ_* account+session; fund DEPLOYER/SESSION/RECIPIENT; recipient
                           trustline; top up SA USDC from faucet
11-setup-transfer-delegation.js  owner-signed add_context_rule(CallContract(USDC), valid_until, [Delegated(SESSION)], {})
12-session-transfer.js     THE CRUX: USDC.transfer(SA → recipient) signed by SESSION key only → settle + verify deltas
14-deploy-policy.js        upload+deploy spending_limit Policy WASM; add_policy(rule, policy, SpendingLimitAccountParams)
15-guard-budget.js         within-budget transfer SETTLES; over-period-budget transfer REJECTED
13-guard-transfer-expiry.js  shorten valid_until, wait past it, session transfer REJECTED
authlib.js                 signDelegated — UNCHANGED from the adapter spike (the deliverable mechanism)
oz_policy/                 the OZ spending_limit Policy crate (built → wasm hash above)
```

Build the policy WASM:
```
docker run --rm -v <repo>/docs/superpowers/spikes/scratch/oz_policy:/work -w /work \
  --entrypoint sh stellar-cli-fixed -c "stellar contract build"
# → target/wasm32v1-none/release/oz_spending_limit_policy.wasm, hash 2be7508a...
```
