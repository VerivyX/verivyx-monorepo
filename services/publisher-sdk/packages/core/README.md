# @verivyx/paywall

Zero-dependency x402 paywall SDK for publishers — gate content from AI bots and charge agents on-chain via the Stellar/x402 protocol.

## Install

```sh
npm i @verivyx/paywall
```

## Quickstart

```ts
import { verivyx } from "@verivyx/paywall";

// Create a paywall instance (reads VERIVYX_TOKEN + VERIVYX_DOMAIN from env)
const vx = verivyx();

// Wrap any Fetch-API handler
export const GET = vx.protect(async (req) => {
  return new Response(JSON.stringify({ content: "..." }), {
    headers: { "content-type": "application/json" },
  });
});
```

For framework adapters (Express, Next.js, Hono) use the dedicated packages below. The core package is installed automatically as a dependency of each adapter.

## Config

All options can be passed to `verivyx(opts)` or set via environment variables. Code-arg options always take precedence.

| Env var | Required | Description |
|---|---|---|
| `VERIVYX_TOKEN` | yes (server-only) | Domain provisioning token from the Verivyx dashboard |
| `VERIVYX_DOMAIN` | yes | Your site domain, e.g. `example.com` |
| `VERIVYX_MATCH` | no | Comma-separated glob patterns to gate (e.g. `/articles/**`). Empty = gate all routes. Also accepts `string[]` in code. |
| `VERIVYX_FAIL_MODE` | no | Behaviour when the Verivyx backend is unreachable: `teaser` (default) \| `open` \| `closed` |
| `VERIVYX_TIMEOUT_MS` | no | Backend request timeout in milliseconds (default `800`) |

## Docs

[https://docs.verivyx.com/docs/sdk](https://docs.verivyx.com/docs/sdk)
