# Cross-Plan E2E — Non-Custodial `pay_for_resource` on Testnet (P3-T5)

**Date:** 2026-06-21
**Branch:** `refactor/strict-review`
**Status:** ✅ **DONE — a Hydra-OAuth'd MCP caller paid a LIVE x402 resource NON-CUSTODIALLY from the user's delegated OZ smart account; settled on testnet, paywall split verified on-chain.**
**Stack:** the live local Docker stack (`verivyx`), unmodified. Only a throwaway `McpWallet` row + two throwaway Hydra OAuth clients were created and then deleted.

---

## TL;DR — the proven loop

```
Hydra JWT (sub=e2e-test-sub-9001, aud=https://mcp.verivyx.com/mcp)
  → POST /mcp initialize (requireMcpAuth: JWKS verify ✓ → mcpUser.oauth.sub)
  → getBinding(sub) finds McpWallet → mode = "noncustodial"
  → tools/call pay_for_resource(https://web-test.verivyx.com/2026/05/31/hello-world/)
  → NonCustodialExactStellarScheme builds USDC.transfer(SA → payTo, 300000)
    authorized SOLELY by the delegated session key (two-entry OZ auth tree)
  → the resource's x402 facilitator settles it
  → paid; the paywall adapter splits creator/platform atomically on-chain
```

| Item | Value |
|---|---|
| **Settle tx (non-custodial resource payment)** | `37b875d5e8f9e1724c61aace0661e3a6a574d417795a95ef01aab78203b0d71f` (Horizon: successful, ledger 3212613) |
| Payer (`from`) = caller's OZ smart account | `CBT7K2B7KRWTUSHSWTGWUIIDA4WO2URICF5JIN3CRWY32FV5UH3KSHEU` |
| Session key (sole signer at pay time) | `GAVPYJLHXV6LANM5OREB65X22MXZO5PLBONIPXJGYF4QPJUGQUVDG4NG` |
| Resource | `https://web-test.verivyx.com/2026/05/31/hello-world/` (live paywall, 402) |
| MCP tool result | `paymentMade:true, status:200, ok:true, chain:stellar:testnet, amount:300000` |

### On-chain USDC (SAC `CBIELTK6…`) deltas — non-custodial settlement + split

| Party | Before | After | Delta |
|---|---|---|---|
| smartAccount (payer) | 5,000,000 | 4,700,000 | **−300,000** |
| creator `GBGZH3WU…` | 5,009,160,000 | 5,009,450,000 | **+290,000** |
| platform `GDCPLKM7…` | 4,152,762,979 | 4,152,772,979 | **+10,000** |
| paywall contract `CAERLWHD…` | 500,000 | 500,000 | 0 (pass-through) |

The user's smart account paid 300,000; creator +290,000 and platform +10,000 = the resource's advertised `distribution`. **Non-custodial: the MCP wallet was never the payer.** The split is enforced by the paywall adapter on settle.

---

## How the Hydra user token was minted (the GO-LIVE GATE)

Drove the OAuth2 `authorization_code` flow against the local Hydra, accepting login + consent **server-side via the Hydra ADMIN API** (`http://hydra:4445`) so no browser / no production redirect was needed:

1. `POST /admin/clients` create a confidential client (authorization_code + refresh_token).
2. `GET /oauth2/auth?…` → 302 carrying `login_challenge`.
3. `PUT /admin/oauth2/auth/requests/login/accept` with `subject = e2e-test-sub-9001`.
4. follow redirect → `consent_challenge`; `PUT …/consent/accept` granting `grant_access_token_audience = [https://mcp.verivyx.com/mcp]` (the same union the auth-service `/api/v1/oauth/consent` does).
5. follow redirect → `?code=…`; `POST /oauth2/token` → access token.

> Inside-container gotcha: Hydra's self-issuer is `http://localhost:4444`; redirects must be rewritten to the docker DNS name `http://hydra:4444` to be followed from another container.

### ⚠️ CRITICAL FINDING — Hydra issues OPAQUE tokens by default; the MCP only accepts JWT

The default Hydra access-token strategy is **opaque** (`ory_at_…`). The MCP resource server (`src/oauth.ts` `makeTokenVerifier`) verifies via **JWKS `jwtVerify`** — an opaque token gets **401** at `/mcp` (verified empirically).

To make the E2E pass, the test client was created with **`access_token_strategy: "jwt"`** (per-client, via the admin REST body — the `hydra create oauth2-client` CLI has no flag for it). That produced a proper JWT (`sub`, `aud=[…/mcp]`, `iss=http://localhost:4444`) which the MCP accepts.

**Production decision required (the real go-live gate):** either
- set Hydra to JWT access tokens globally (`OAUTH2_STRATEGIES_ACCESS_TOKEN=jwt` / `strategies.access_token: jwt`), or per-client `access_token_strategy=jwt` at DCR time; **or**
- add an **opaque-token introspection** path to the MCP (`POST /admin/oauth2/introspect`) so `requireMcpAuth` accepts Hydra's default opaque tokens.

Today the MCP is **JWT-only**, so the public OAuth flow will not work until one of the above is shipped.

---

## Resource scheme note (why the existing `CallContract(USDC)` rule sufficed)

`web-test`'s primary 402 `accepts[0]` advertises `asset = USDC SAC (CBIELTK6…)`, `payTo = the paywall CONTRACT (CAERLWHD…)`, with an `extra.distribution`. `NonCustodialExactStellarScheme` builds a **standard `USDC.transfer(SA → payTo=contract, amount)`** for it. The on-chain delegation rule is `CallContract(USDC) + Delegated(session)`, which permits `USDC.transfer` to **any** `to` (including a contract) — so it authorizes this payment unchanged. The paywall contract receives the transfer and performs the creator/platform split. No adapter-specific delegation was needed for the standard transfer path.

---

## Secondary finding (non-blocking) — the non-custodial SERVICE-FEE charge fails with `txInsufficientFee`

After the resource settled, the optional Verivyx service-fee charge (`fee/stellarNonCustodial.ts`, a delegated `USDC.transfer(SA → feeTreasury, 1000)` gas-sponsored by `MCP_STELLAR_SECRET`) returned:

```
feeError: "fee tx send ERROR: AAAAAAAAsKD////3AAAAAA=="  →  txInsufficientFee (feeCharged 45216)
```

The sponsor MCP wallet (`GCDNJFCP…`) has ~10000 XLM — **not a funding problem**. The bug is in `defaultSubmit`: it re-grafts the placeholder op into a fresh envelope, sets a fixed tx `fee:"12000000"`, then `assembleTransaction(rebuilt, sim)` — and the resulting tx's offered fee ends up **below** the required inclusion+resource fee for the footprint (the grafted-envelope assemble path doesn't merge the resource fee onto the 12000000 base the way a normally-built tx does). By design `feeError` does **not** fail the pay (resource already served), so the E2E still passes — but the **service fee is silently uncollected**. T-followup: fix the fee tx assembly so the offered fee = inclusion + simulated resource fee (e.g. build the re-sourced tx from the simulated `sim.minResourceFee`, or use `assembleTransaction` on a tx built the same way the resource-payment path builds it). The resource-payment path (via the x402 facilitator) sets fees correctly — only this MCP-submitted fee tx is affected.

---

## Reproduction (all via Docker; host has no toolchain)

Scripts under `docs/superpowers/spikes/scratch/e2e/` (gitignored: `node_modules`, `token.txt`, `*.env`, `pay-result.json`). Reuses the standard-transfer spike's `SPIKE_OZ_*` account + the spike scratch dir (`…/scratch/spike/`) for on-chain setup.

```
mint-token.mjs     drive Hydra authorization_code flow (admin-accept login+consent) → JWT in token.txt
insert-binding.mts imports the PRODUCTION registry upsertBinding (run in mcp-server container) → encrypted McpWallet row
call-pay.mjs       minimal Streamable-HTTP MCP client: initialize → tools/call pay_for_resource
balances.mjs       read USDC SAC balances for SA / creator / platform / paywall (before & after)
```

On-chain prep before the call (delegation had expired — current ledger > prior valid_until):
```
# in …/scratch/spike/ with chain.env + node_modules
node 10-bootstrap-transfer.js        # top up SA USDC to 5_000_000
node 11-setup-transfer-delegation.js # fresh add_context_rule(CallContract(USDC), valid_until, [Delegated(SESSION)])
                                     # → ruleId 3, validUntil 3213083
```

The McpWallet binding used: `oauthSub=e2e-test-sub-9001`, `smartAccount=CBT7K2B7…`, `sessionSignerPubkey=GAVPYJLH…`, `sessionSignerSecretEnc=encryptSecret(SPIKE_OZ_SESSION_SEC)`, `budgetAtomic=5000000`, `expiryLedger=3213083`.

Cleanup performed: `DELETE FROM "McpWallet" WHERE "oauthSub"='e2e-test-sub-9001'` (verified count 0); both throwaway Hydra clients deleted; tmp script removed from the container. The live stack was not otherwise modified.
