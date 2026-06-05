# Verivyx MCP Server (`mcp.verivyx.com`)

Remote **x402 payment MCP server**. Any MCP client (Claude, Cursor, custom agents)
connects over **Streamable HTTP** and can pay any x402-protected resource across
multiple chains. Verivyx charges a flat **$0.001 service fee** per successful
payment.

> v1 targets testnet and is used internally for testing and the playground; the
> public UI is coming soon.

## Overview
- Remote MCP over Streamable HTTP at `POST/GET/DELETE /mcp`, gated by
  `X-Verivyx-MCP-Key` (allowlist).
- Tools: `list_supported_chains`, `wallet_info`, `quote_payment`, `pay_for_resource`.
- Multi-chain rails — **Stellar**, **Base (EVM)**, and **Solana**. Each rail pays the
  resource **and** charges the 0.001 USDC service fee as a separate on-chain transfer
  to the platform treasury for that chain.
- Chain-agnostic registry — new chains plug in without touching the tool layer.

## Endpoints
| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST/GET/DELETE | `/mcp` | `X-Verivyx-MCP-Key` | MCP Streamable HTTP |
| GET | `/healthz` | none | liveness + chain list |
| GET | `/admin/overview` | `X-Internal-Token` | admin console data (proxied by auth-service) |

## Run (docker)
```bash
docker compose up -d --build mcp-server
```
Requires env (see `.env.example` + repo-root `.env`): `MCP_API_KEYS`,
`MCP_STELLAR_SECRET`, `PLATFORM_STELLAR_ADDRESS`, `INTERNAL_TOKEN`, `USDC_ISSUER`.
Base and Solana rails activate when their respective keys are set
(`MCP_EVM_PRIVATE_KEY`, `MCP_SOLANA_SECRET`).
