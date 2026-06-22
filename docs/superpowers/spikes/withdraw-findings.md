# Withdraw from OZ Smart Account — On-Chain Spike Findings

**Date:** 2026-06-22
**Branch:** `refactor/strict-review`
**Status:** ✅ **DONE — proven on-chain.** The OWNER can withdraw leftover USDC from the
non-custodial OZ smart account back to their own Freighter wallet **WHILE the agent
(session-key) `CallContract(USDC)` rule is still live**, with NO need to revoke/re-add the
delegation. Withdraw and the agent delegation coexist.
**Network:** Stellar Testnet (`Test SDF Network ; September 2015`), RPC `https://soroban-testnet.stellar.org`

---

## TL;DR — the recommendation

**Withdraw = a plain `USDC.transfer(from = smartAccount, to = ownerGAddress, amount)` authorized
by the OWNER via the same two-entry delegated auth tree already used by `delegate()`/`revoke()`
(`submitWithOwnerAuth` in `web/src/lib/smartAccount.ts`).** It works with the session rule
present and untouched. No revoke required, no UX caveat about re-delegating.

| Question | Answer | Proof (settled tx, testnet) |
|---|---|---|
| **(1)** Owner withdraw via Default rule WHILE a live `CallContract(USDC)` session rule exists? | ✅ **SUCCEEDS** | `47b8e6cf5a146bb36a3e228c6263feaefaaebaac076b29652073747b0d10c428` (and `b917aee3…`, `ed0497ce…`) |
| **(2)** Does it require removing the session rule first? | ❌ **NO** — coexists. (But it also works after revoke — `d75502d3…`) | n/a (negated) |
| **(3)** Can the owner be a signer on a *separate* `CallContract(USDC)` rule and withdraw via that? | ✅ **Yes**, also works | add `178cba05…`, withdraw via it `e8df8fc5…` — but **not needed** (Default rule already authorizes; see below) |
| **(4)** Is the owner's Default-rule spend limited by the session's `spending_limit` policy? | ❌ **NO** — unmetered | 0.2 USDC withdraw (> the 1.5e6 session budget) settled: `0017ca56…` |
| Agent delegation still works after owner withdraw? | ✅ **Yes, untouched** | owner withdraw `ed0497ce…` then session-key pay `99204dc2…` on the **same live rule** |
| **TOP-UP** (owner G → SA) | ✅ plain SAC transfer, owner signs own key | `d66fae9f42808208038a314a35bb446d3fb6441d23187f1344acf7e88a5a23ec` |

---

## Why owner-withdraw coexists with the session rule (the core mechanic)

The original worry was that a `CallContract(USDC)` context rule might **capture** every USDC
invocation, so only the session key (bounded by its `spending_limit` + `valid_until`) could ever
move USDC. **On-chain this is false.**

OZ `stellar-accounts` `__check_auth` evaluates the context rules **disjunctively**: an invocation
is authorized if **any applicable rule** is satisfied by the signatures provided. The **Default**
rule applies to *every* context (including `CallContract` invocations); the `CallContract(USDC)`
rule is an *additional, narrower* rule, not an *exclusive* one. So a USDC `transfer` from the SA
can be authorized **either** by the session key (matching the `CallContract(USDC)` rule, subject
to its policy + expiry) **or** by the owner (matching the Default rule, unconstrained). They do
not exclude each other.

Decisive proof (`wd-05-coexist.mjs`): with a freshly-added LIVE `CallContract(USDC)` rule
(id 5) + `spending_limit` policy installed —
1. **Owner** withdraw via the Default rule settled: `ed0497ce326611fdfb224bb43aced1121f4fe7960cf7c8a4571cd6997a0919ef`
2. Immediately after, the **session key** paid on that very rule: `99204dc2a3258bc191cd4e3075f7aecde147a0d8f32d960eaf3e2705f9defd1b`

Both signers move USDC from the same SA on the same live ruleset. Owner-withdraw neither needs nor
disturbs the session delegation.

### (4) Policies are per-rule, so owner spend is unmetered
A `spending_limit` policy attaches to the **rule it is added to** (the `CallContract(USDC)` session
rule). It does **not** gate the Default rule. Proven: an owner withdraw of **0.2 USDC**
(`2_000_000` atomic) — larger than the session rule's `1_500_000`/period budget — settled with no
policy rejection: `0017ca56a036cb4c736418559cfd636d3bec89dbe83b3dda1fa15d603abe1eb8`. The owner can
sweep the **full** SA balance in one tx.

---

## The exact on-chain WITHDRAW operation (for the dashboard "Withdraw" button)

```
op = USDC.transfer(
  from   = smartAccount (C-address),
  to     = ownerGAddress (the Freighter wallet),
  amount = i128 (atomic USDC; e.g. full SA balance for "withdraw all"),
)
auth   = OWNER two-entry delegated tree (submitWithOwnerAuth)
source = ownerGAddress (owner pays gas, signs envelope via Freighter signTransaction)
```

**Auth path = identical to the proven `delegate()`/`revoke()` flow.** `web/src/lib/smartAccount.ts`
already has the exact machinery: `submitWithOwnerAuth({ server, networkPassphrase, sourceAddress:
ownerAddress, smartAccount, ownerAddress, op, label })`. The owner is the Default-rule
`Delegated(owner)` signer; `submitWithOwnerAuth` builds the outer SA `Signatures` entry + the nested
`__check_auth` entry signed by Freighter (`signAuthEntry`). For withdraw, **pass the
`USDC.transfer(SA → owner, amount)` op** to that same helper. Nothing new is required.

> Implementation note: this spike signed the owner's nested entry with the owner's raw secret
> (Node). In the dashboard the owner secret lives in Freighter, so withdraw reuses
> `submitWithOwnerAuth` verbatim (same two-entry tree, signed via `signEntryWithFreighter` →
> Freighter `signAuthEntry`). The auth tree shape is byte-identical; only the signer transport
> differs. This is the SAME path already pending `[BV-2]` browser validation for delegate/revoke —
> withdraw adds no new unvalidated surface.

### Recommended dashboard UX
- "Withdraw" reads the SA USDC balance, lets the user pick an amount (default = full balance),
  then runs the single owner-authorized `USDC.transfer(SA → owner)`.
- **No "this revokes your agent" warning** — withdraw does NOT touch the session delegation.
- Prerequisite (host the user must satisfy once): the **owner G-account needs a USDC trustline**
  to receive SAC USDC. If absent, prompt a one-click `changeTrust` (owner-signed, classic op).
  (In this spike the owner needed a trustline before the first withdraw; tx
  `2deb04546d029c2f92c472b926d74fc6851717f19f17931d6d2310b825d23137`.)
- The SA itself (C-address) does **not** need a trustline to hold SAC USDC — only G-accounts do.

### Do NOT use the "extra owner rule" approach (option 3)
Adding a second `CallContract(USDC)` rule with `Delegated(owner)` (no policy, no expiry) also lets
the owner withdraw (`add 178cba05…`, withdraw `e8df8fc5…`), but it is **unnecessary** — the Default
rule already authorizes the owner. It would only add an extra always-valid, unmetered USDC rule for
no benefit, slightly enlarging the rule set. **Skip it; withdraw via the Default rule.**

---

## TOP-UP (the simple inverse) — confirmed

TOP-UP is a **plain SEP-41 SAC transfer from the owner's own G-account**, signed by the owner's
own key — **no smart-account auth, no context rule, no delegated tree** (the SA is the `to`, not the
`from`, so the SA's `require_auth` is never invoked):

```
op     = USDC.transfer(from = ownerGAddress, to = smartAccount, amount)
source = ownerGAddress, signed by owner (Freighter signTransaction) — ordinary tx
```

Settled: `d66fae9f42808208038a314a35bb446d3fb6441d23187f1344acf7e88a5a23ec` (owner → SA, 20 000
atomic). This is just a normal Freighter "send USDC to <SA C-address>".

---

## Mirror of Rio's production setup (what was tested)

Throwaway OZ smart account fully owned via `SPIKE_OZ_*` secrets (gitignored), identical structure
to Rio's live account:

| | |
|---|---|
| Smart account (SA) | `CBT7K2B7KRWTUSHSWTGWUIIDA4WO2URICF5JIN3CRWY32FV5UH3KSHEU` (held 4.7 USDC) |
| OZ account WASM hash | `40276717b7227725be75ad66ec2214aa95a29b47b36679a90f165be3f8fe09cb` (= production) |
| Owner (Default-rule `Delegated` signer) | `GDZW4TFH57UFKT5VRIIQVWMVN52J6IXBUTGD5JPDLOKFE5C35WFBQYCC` |
| Session key (`CallContract(USDC)` rule signer) | `GAVPYJLHXV6LANM5OREB65X22MXZO5PLBONIPXJGYF4QPJUGQUVDG4NG` |
| `spending_limit` policy (on the session rule) | `CBGLHQVGQEWBWW6JJXKLLMQZL3G4ENHFRBORLAUO2ZYVAJ2EZWYVMZC2` (= production) |
| USDC SAC | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` (= production) |

Rule layout confirmed (`get_context_rules`):
- **Default** rule id 0 `"multisig"`: signer `Delegated(owner)`, no policy, no expiry.
- **CallContract(USDC)** rule: signer `Delegated(session)` + `spending_limit` policy + `valid_until`.

The faucet (`PLAYGROUND_FAUCET_SECRET`) held **0 USDC** (the prior ~0.009 is gone) and cannot mint
Circle testnet USDC — so the spike used the existing SA's 4.7 USDC balance, which was sufficient.

---

## Reproduction (Docker; host has no toolchain)

Scripts under `docs/superpowers/spikes/scratch/spike/` (gitignored), run with `node:20-alpine`,
`--network host`, `--env-file chain.env`, `@stellar/stellar-sdk@16.0.1`:

```
docker run --rm --network host --env-file chain.env -v <spike>:/work -w /work node:20-alpine node <script>
```

| Script | Purpose |
|---|---|
| `wd-01-inventory.mjs` | balances + which accounts exist (found SA holds 4.7 USDC) |
| `wd-02-rules.mjs` | dump Default + CallContract(USDC) context rules (confirm setup mirrors Rio) |
| `wd-03-withdraw-tests.mjs` | TEST 1 (owner withdraw, live session rule), TEST 4 (unmetered), TEST 3 (extra owner rule) |
| `wd-04-confirm.mjs` | TEST 2 (withdraw after revoke), TOP-UP, session-still-works (recipient-trustline caveat) |
| `wd-05-coexist.mjs` | **decisive**: live session rule + policy → owner withdraw THEN session-key pay both settle |

`signDelegated` (the two-entry delegated auth tree) is byte-identical to
`docs/superpowers/spikes/scratch/spike/authlib.js` and to `submitWithOwnerAuth` in
`web/src/lib/smartAccount.ts`; the only spike difference is signing the owner's nested entry with a
raw secret instead of Freighter, which does not change the on-chain auth shape.

### Settled tx hashes (testnet)
| What | Tx |
|---|---|
| Owner USDC trustline (prereq) | `2deb04546d029c2f92c472b926d74fc6851717f19f17931d6d2310b825d23137` |
| TEST 1 — owner withdraw, live session rule (run A) | `b917aee3183c73b8e7a74e10a9adf1bd10ed73c5768f92ca1267ff9b3e8a269d` |
| TEST 1 — owner withdraw, live session rule (run B) | `47b8e6cf5a146bb36a3e228c6263feaefaaebaac076b29652073747b0d10c428` |
| TEST 4 — owner withdraw 0.2 USDC (> session budget), unmetered | `0017ca56a036cb4c736418559cfd636d3bec89dbe83b3dda1fa15d603abe1eb8` |
| TEST 3 — add owner-only CallContract(USDC) rule | `178cba05cae7004bc1ba90d51368763419c77a2b728242ed047c1b13a6f17dbf` |
| TEST 3 — owner withdraw via that rule | `e8df8fc5f3cdb6ce71439c1b90f8baaca13bac0769481e6e465000b7625eb8cc` |
| TOP-UP — owner G → SA plain SAC transfer | `d66fae9f42808208038a314a35bb446d3fb6441d23187f1344acf7e88a5a23ec` |
| TEST 2 — owner withdraw AFTER removing all USDC rules | `d75502d38755db0e905367a4aff44ab580638b73c330703dac028e4e38de12ed` |
| COEXIST — owner withdraw with live session rule + policy | `ed0497ce326611fdfb224bb43aced1121f4fe7960cf7c8a4571cd6997a0919ef` |
| COEXIST — session-key pay immediately after (delegation intact) | `99204dc2a3258bc191cd4e3075f7aecde147a0d8f32d960eaf3e2705f9defd1b` |
