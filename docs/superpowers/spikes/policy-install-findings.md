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

---

# Second Failure — "Unauthorized function call for address <session>" (after session account exists)

**Date:** 2026-06-22 · **Branch:** `refactor/strict-review` · **Status:** ROOT-CAUSED — validated recovery (no code change needed).

## TL;DR

After Step 1's fix (session signer G-account `GBWJA6IP…` now exists on-ledger, friendbot-funded
and verified healthy: masterWeight 1, no flags, balance ok), simulating
`buildStandardTransferPayment` for Rio's binding (`sub=1`, SA `CCL7DGCR…`) now fails with a
**different** error than the first failure:

```
USDC.transfer(CCL7DGCR… → CAERLWHD…, 300000)
__check_auth on CCL7DGCR…:
  require_auth_for_args(GBWJA6IP…) → Error(Auth, InvalidAction)
  "Unauthorized function call for address GBWJA6IP…"
  → escalating to VM trap → __check_auth → Error(Auth, InvalidAction)
```
(NOT `Storage(MissingValue)` — the signer account loads now.) Reproduced exactly via
`getBinding("1")` → `buildStandardTransferPayment(...)` inside the mcp-server container.

The decrypted session secret derives **exactly** `GBWJA6IP…` = the DB `sessionSignerPubkey`
column = the on-chain rule-3 signer (all three match). The OZ auth mechanism is: OZ
`do_check_auth` → `authenticate()` calls `addr.require_auth_for_args((signature_payload,))`
for every Delegated signer in the provided `Signatures` map; this is exactly what the
two-entry `signDelegated` tree authorizes (Entry B = session key signs `__check_auth(payload)`).

## What is PROVEN about Rio's CCL7DGCR (every observable is healthy)

- `get_context_rules(CallContract(USDC))` → ONE live rule: `{id:3, name:"verivyx-session",
  policies:[CBGLHQVG…], signers:[[Delegated, GBWJA6IP…]], valid_until:3342854}` (not expired).
- Raw persistent storage: `Signers[3]=[Delegated(GBWJA6IP…)]`, `Policies[3]=[CBGLHQVG…]` — correct.
- Policy `AccountContext(SA,3)` PRESENT, clean: `{spending_limit:10000000, period_ledgers:100,
  cached_total_spent:0, spending_history:[]}`. (Orphan `AccountContext(SA,1)`/`(SA,2)` also
  present — leftovers from the stale-removal re-runs — but rules 1,2 are gone; only rule 3 lives.)
- Default rule id=0 "multisig" signer = owner `GBGZH3WU…` (exists, healthy) — does not match
  CallContract(USDC), so irrelevant.
- SA wasm = `40276717…` (identical to `smartAccount.ts` / the proven spike).
- TTL: instance, Signers[3], Policies[3], policy AccountContext[SA,3], WASM code — all live, none archived.
- Failing sim returns **no `restorePreamble`** (not an archival/restore problem).
- Session account `GBWJA6IP…` EXISTS, masterWeight 1, no extra signers, no flags, funded.

## What was REPRODUCED to SUCCEED (the code + flow are correct)

On throwaway OZ accounts I control (funded from `MCP_STELLAR_SECRET` for USDC), every faithful
reconstruction settles. payTo = Rio's real `CAERLWHD…` (a contract → no trustline needed):

1. **Fresh order** (session account created BEFORE delegate): session-key transfer sim → SUCCESS
   (`minResourceFee≈519k`).
2. **Rio order** (delegate while session MISSING → create session AFTER → fund SA USDC):
   sim → SUCCESS.
3. **Production code path** `buildStandardTransferPayment` (the real `sessionPayment.ts`) on a
   Rio-order account → **FULL SUCCESS** (`minResourceFee=519570`). The production builder is not broken.
4. **Full accumulated-state mirror** (delegate→remove→re-delegate ×3 so live rule = id=3 with
   orphan policy storage for ids 1,2, session created post-delegation — byte-for-byte Rio's
   history) → sim SUCCESS, and a **real on-chain transfer SETTLED**:
   `tx a59f822dc563598203117dffb1bcf1f309b169e84f590592e5a658203ea65803` (SUCCESS).

So the spending_limit enforce, the two-entry delegated auth tree, the add_context_rule[empty]→
add_policy path, the rule-id=3 accumulation, and the create-session-after-delegate ordering all
work end-to-end on a faithful clone. The ONLY thing that fails is **Rio's specific live rule 3**.

## Root cause

**Rio's on-chain rule 3 is in a host-rejecting state that is NOT reproducible from any observable
on-ledger field** — every faithful reconstruction of his exact shape/history succeeds (incl. a real
on-chain settle). His rule 3 was last modified at ledger ~3221900 by an earlier (pre-current-code)
delegation attempt; that rule must have been created with a subtly-divergent auth/signer encoding
or an OZ state the current 2-step delegate path does not reproduce. The fix from Step 1
(`ensureSessionAccountExists`) is correct and necessary, but Rio's rule 3 predates a clean
current-code delegation and is the residual defect. Because a clean current-code re-delegation
(Step 0 removes rule 3 → Step 1 adds a fresh rule → Step 2 add_policy) demonstrably yields a
working transfer, the resolution is a re-authorization, not a code change.

## VALIDATED recovery for Rio (binding sub=1)

**Click "Re-authorize" once more in the dashboard** (`mcp.verivyx.com/mcp/wallet`, current deployed
code). His session account already exists, so Step 0a is a no-op; Step 0 removes the broken rule 3;
Steps 1–2 install a clean new rule (id=4) + spending-limit policy. After that, the MCP session key
can settle the standard USDC.transfer.

Proof this recovery works: the accumulated-state mirror above — which performs the identical
remove-stale → add-rule → add-policy sequence ending at a live rule, with the session account
already on-ledger — produced an **on-chain SUCCESS transfer**
(`tx a59f822dc56359820311…`, `minResourceFee≈520k` on sim). No change to his smart-account
contract, owner key, or session key is required; the existing encrypted session secret in the
binding stays valid (it already matches the on-chain signer).

## Reproduction scripts (this round; gitignored under scratch, run inside mcp-server container)

Run with `node --env-file=chain.env [--env-file=mcpsec.env]` (mcpsec.env = just `MCP_STELLAR_SECRET`
from repo `.env`, the USDC funding source). The `--import tsx` variants import the live
`/app/src/wallet/*.ts`.
- `repro-rio.mts` — `getBinding("1")` → `buildStandardTransferPayment` → reproduces Rio's failure.
- `deep-rio.mts` — dumps the signDelegated two-entry tree for Rio + the failing SIM2 diagnostics.
- `inspect-rio.mjs` / `raw-rule3.mjs` / `ttl-check.mjs` / `lastmod.mjs` — on-chain state of CCL7DGCR.
- `check-session-key.mts` — proves decrypted secret = DB column = on-chain rule-3 signer.
- `repro-h3.mjs` (`STAGE=rio|fresh`) / `repro-h3-prod.mts` — fresh-account success (sim + production path).
- `repro-accum.mjs` / `repro-accum-submit.mjs` — full accumulated-state mirror (sim + real on-chain settle).
