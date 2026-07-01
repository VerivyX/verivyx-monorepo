# Verivyx MCP Server (`mcp.verivyx.com`)

Remote **x402 payment MCP server**. MCP clients (Claude, Cursor, custom agents)
connect over **Streamable HTTP** at `/mcp` and pay x402-protected resources.
Verivyx charges a flat **$0.001 USDC service fee** per successful payment.

> v1 targets testnet and is used internally for testing and the playground; the
> public UI is coming soon.

## Chains

- **Stellar is the only chain enabled by default**, and it is the **non-custodial**
  rail: OAuth callers pay from their **own** Stellar smart account.
- **Base (EVM)** and **Solana** rails are implemented but **disabled by default**.
  They activate only when their env keys are set (`MCP_EVM_PRIVATE_KEY` /
  `MCP_SOLANA_SECRET`, plus the matching `MCP_FEE_TREASURY_*`). When enabled they
  are **custodial** — a single MCP-owned key pays for every caller. They are NOT
  non-custodial. Do not treat multi-chain as a live, production feature.

Each active rail pays the resource **and** charges the 0.001 USDC service fee as a
separate on-chain transfer to that chain's fee treasury.

## Auth on `/mcp`

`requireMcpAuth` accepts EITHER:

1. A **Hydra-issued Bearer JWT** (`Authorization: Bearer <token>`), validated via JWKS.
2. A static **`X-Verivyx-MCP-Key`** header, validated against a SHA-256 allowlist.

On top of auth, `/mcp` is protected by:

- an **early-access gate** — OAuth callers must have the `mcpEarlyAccess` flag
  (static-key/internal callers bypass it);
- a **DNS-rebinding host guard** — the `Host` header must be in `MCP_ALLOWED_HOSTS`
  (set to `*` to disable).

## Non-custodial payment flow

OAuth callers pay from their **own** Stellar smart account via a **delegated session
key**. The server holds only the session signer secret (AES-encrypted at rest, never
returned by any endpoint) and never custodies the caller's funds. The session key is
budget- and expiry-capped on-chain by the owner's delegation.

If an OAuth caller has no linked wallet, `pay_for_resource` returns a structured
`no_wallet_linked` result instead of paying from any custodial wallet.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST/GET/DELETE | `/mcp` | Hydra JWT or `X-Verivyx-MCP-Key` | MCP Streamable HTTP |
| POST | `/wallet/session-signer` | `requireUserAuth` | issue/return the session signer pubkey |
| POST | `/wallet/binding` | `requireUserAuth` | confirm on-chain delegation (smartAccount/budget/expiry) |
| GET | `/wallet/status` | `requireUserAuth` | read current binding state |
| POST | `/wallet/revoke` | `requireUserAuth` | clear the server-side binding record |
| GET | `/.well-known/oauth-protected-resource` | none | RFC 9728 metadata (only when Hydra is configured) |
| GET | `/healthz` | none | liveness + chain list |
| GET | `/admin/overview` | `X-Internal-Token` | admin console data (proxied by auth-service) |

`requireUserAuth` accepts a Hydra OAuth JWT (agents) OR the dashboard auth-service
HS256 token (browser). Static API keys are rejected on `/wallet/*` (403).

The wallet-management lifecycle also covers deploy/delegate/revoke/topup/withdraw/status
from the dashboard **Agent Wallet** page — the on-chain owner-signed steps (deploy,
delegate, top-up, withdraw) run in the dashboard; these endpoints track the resulting
server-side binding.

## Tools

- `list_supported_chains` — chains/assets this MCP can pay on, plus the flat service fee.
- `wallet_info` — active paying wallet(s) and network config per chain.
- `quote_payment` — preview the cost (resource price + service fee) without paying.
- `pay_for_resource` — fetch an x402 URL and pay the required micropayment + service fee.

## Run (docker)

```bash
docker compose up -d --build mcp-server
```

Requires env (see `.env.example` + repo-root `.env`): `MCP_API_KEYS`,
`MCP_STELLAR_SECRET`, `PLATFORM_STELLAR_ADDRESS`, `INTERNAL_TOKEN`, `USDC_ISSUER`.
Optional: `HYDRA_ISSUER` (enables OAuth + RFC 9728 metadata), `JWT_SECRET` (enables the
dashboard token on `/wallet/*`), `MCP_WALLET_ENC_KEY` (non-custodial session-secret
encryption), `MCP_ALLOWED_HOSTS`/`MCP_ALLOWED_ORIGINS` (host/origin guard). The Base and
Solana rails activate only when `MCP_EVM_PRIVATE_KEY` / `MCP_SOLANA_SECRET` are set.
