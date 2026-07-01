# Verivyx Publisher SDK

The `@verivyx/paywall` SDK — drop it into any Node app to gate content from AI bots and charge agents on-chain via [x402](https://x402.org) on Stellar, while humans read for free and search crawlers get an SEO preview. Content is withheld at the server: unauthorised callers never reach the route that renders it.

This is an npm-workspaces monorepo for the published packages.

## Packages

| Package | What it is |
|---|---|
| [`@verivyx/paywall`](packages/core) | Core SDK — classify · decide · authorize/settle (zero runtime deps) |
| [`@verivyx/paywall-next`](packages/next) | Next.js (App Router) adapter — `verivyxProxy` middleware + `vx.protect` route |
| [`@verivyx/paywall-express`](packages/express) | Express adapter — `verivyxMiddleware` (`app.use`) + `vx.protect` route |
| [`@verivyx/paywall-hono`](packages/hono) | Hono adapter (edge-portable) — `verivyxHonoMiddleware` + `vx.protect` route |

## How it works

The simplest integration is **one middleware file** that gates a whole app. Every matched request is classified and handled:

- **AI agents / machine clients** → `402` with x402 payment requirements → pay USDC on-chain → retry → content.
- **Verified humans (real browsers)** → an in-page proof-of-work unlock (`humanUnlock`) → read the full content free.
- **Verified search crawlers** (Googlebot/Bingbot, IP-range checked) → an SEO preview with anti-cloaking JSON-LD.
- **Everyone else unverified** → the preview teaser, or a `402` — the protected body is never served.

Setup is token-only: sign up, set your payout wallet and price, copy your site token, and add the middleware — there is no domain entry and no DNS verification step. The SDK only ever sends your site token, the route slug, and proof-of-payment/verification to the Verivyx API — the content body stays on your server (authorize-only model). The core SDK is **0.3.1** (token-only); the framework adapters are **0.7.0**.

See each package README for framework-specific quickstarts, and the full guide at
[docs.verivyx.com/docs/sdk](https://docs.verivyx.com/docs/sdk). Live demos:
[demo-sdk-next](https://demo-sdk-next.verivyx.com/seven-wonders) ·
[demo-sdk-express](https://demo-sdk-express.verivyx.com/seven-wonders).

## Development

No host toolchain assumed — build/test via Docker `node:20-alpine`:

```sh
# from this directory
npm install
npm -w packages/<pkg> run build      # tsup → ESM + CJS + d.ts
npm -w packages/<pkg> test           # vitest
```

Publishing is documented in [RELEASING.md](RELEASING.md) (core first, then the adapters).
