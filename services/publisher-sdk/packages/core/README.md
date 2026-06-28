# @verivyx/paywall

Zero-dependency x402 paywall SDK core for publishers — gate content from AI bots, charge agents on-chain via the Stellar/x402 protocol, let humans read free, and serve search crawlers an SEO preview.

**Most apps should use a framework adapter** (one middleware file), not the core directly:
[`@verivyx/paywall-next`](https://www.npmjs.com/package/@verivyx/paywall-next) ·
[`@verivyx/paywall-express`](https://www.npmjs.com/package/@verivyx/paywall-express) ·
[`@verivyx/paywall-hono`](https://www.npmjs.com/package/@verivyx/paywall-hono). The core is installed automatically as their dependency.

## Install

```sh
npm i @verivyx/paywall
```

## Quickstart (low-level, Fetch API)

```ts
import { verivyx } from "@verivyx/paywall";

const vx = verivyx();   // reads VERIVYX_TOKEN + VERIVYX_DOMAIN from env

// Wrap any Fetch-API handler — verified/paid requests pass through; bots get a 402.
export const GET = vx.protect(async (req) =>
  Response.json({ content: "..." }),
);

// Or get a decision and act on it yourself:
const decision = await vx.protect(req, { slug: "my-article" });
if (!decision.allowed) return decision.response();
```

Also exported: `buildUnlockHtml` / `buildSeoPreviewResponse` (preview + in-page PoW unlock pages used by the adapters), `getCookie`, `classify`, `createSearchCrawlerVerifier`.

## Config

All options can be passed to `verivyx(opts)` or set via environment variables (code args win).

| Option / env var | Required | Description |
|---|---|---|
| `VERIVYX_TOKEN` | yes (server-only) | Domain token from the Verivyx dashboard |
| `VERIVYX_DOMAIN` | yes | Your site domain, e.g. `example.com` |
| `match` / `VERIVYX_MATCH` | no | Glob patterns to gate. Empty = nothing gated. Env accepts a comma-separated list. |
| `failMode` / `VERIVYX_FAIL_MODE` | no | Backend unreachable: `teaser` (default) \| `open` \| `closed` |
| `timeoutMs` / `VERIVYX_TIMEOUT_MS` | no | Timeout in ms for the quick classify/requirements call (default `800`). |
| `settleTimeoutMs` / `VERIVYX_SETTLE_TIMEOUT_MS` | no | Timeout in ms for the authorize/settle call that awaits the on-chain payment (default `60000`). Kept separate so a paying agent is never aborted mid-settle. |

## Docs

[https://docs.verivyx.com/docs/sdk](https://docs.verivyx.com/docs/sdk)
