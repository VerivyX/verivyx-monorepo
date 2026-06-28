# @verivyx/paywall-next

Next.js (App Router) adapter for the Verivyx paywall SDK — gate content from AI bots, charge agents on-chain via x402, let humans read free, and serve search crawlers an SEO preview. Vercel-aware IP resolution and `X-Forwarded-Host`/`-Proto` handling; async `ctx.params` (Next 15+).

Requires `@verivyx/paywall` (installed automatically) and `next` + `react` (peer dependencies).

## Install

```sh
npm i @verivyx/paywall-next
```

## Quickstart — one middleware file (recommended)

Add a `proxy.ts` at your project root. This single file gates every matched route: AI bots/agents get a `402` (and can pay via x402), verified humans read for free, and search crawlers get an SEO preview. Protected content is never reached by unauthorised callers.

```ts
// proxy.ts
import { verivyxProxy } from "@verivyx/paywall-next";

export const proxy = verivyxProxy({
  token: process.env.VERIVYX_TOKEN,                  // required — your site token (or set VERIVYX_TOKEN env)
  match: ["/articles/:path*"],                       // paths to gate
  seoPreview: ({ slug }) => ({                        // teaser for crawlers (+ humans without humanUnlock)
    title: titleFor(slug),
    excerpt: excerptFor(slug),
  }),
  humanUnlock: {},                                    // humans solve an in-page PoW → read full content free
});

export const config = { matcher: ["/((?!_next/|favicon.ico).*)"] };
```

The middleware is the authoritative gate — reads `VERIVYX_TOKEN` from env when not passed inline.

## Per-route alternative

Gate a single route handler instead of the whole app:

```ts
import { verivyxNext } from "@verivyx/paywall-next";

const vx = verivyxNext();
export const GET = vx.protect(handler, {
  seoPreview: ({ slug }) => ({ title: "Article title", excerpt: "Teaser for crawlers." }),
});
```

## Config

All options can be passed to `verivyxProxy(opts)` / `verivyxNext(opts)` or set via environment variables.

| Option / env var | Required | Description |
|---|---|---|
| `VERIVYX_TOKEN` | yes (server-only) | Your site token from the Verivyx dashboard — it alone identifies your site |
| `VERIVYX_DOMAIN` | no | Optional legacy/analytics label, e.g. `example.com`. Not required and not part of onboarding — the token identifies your site. |
| `match` / `VERIVYX_MATCH` | no | Glob patterns to gate (e.g. `/articles/**`). Empty = nothing gated. Env accepts a comma-separated list. |
| `seoPreview` | no | `({ slug }) => { title, excerpt }` — teaser for crawlers (+ unverified humans without `humanUnlock`), wrapped in anti-cloaking JSON-LD |
| `humanUnlock` | no | `{ authBase? }` — unverified human browsers get an in-page PoW unlock to read the full content free |
| `failMode` / `VERIVYX_FAIL_MODE` | no | When the backend is unreachable: `teaser` (default) \| `open` \| `closed` |
| `timeoutMs` / `VERIVYX_TIMEOUT_MS` | no | Timeout in ms for the quick classify/requirements call (default `800`). |
| `settleTimeoutMs` / `VERIVYX_SETTLE_TIMEOUT_MS` | no | Timeout in ms for the authorize/settle call that awaits on-chain confirmation (default `60000`, ~15s settle). No need to raise `timeoutMs` for agent payments — the settle path uses this. |

Also: `trustProxy` (default `true`), `advertise` (RSL/AIPREF discovery headers).

This adapter is **0.7.0** and depends on `@verivyx/paywall` **0.3.0** (token-only).

## Docs

[https://docs.verivyx.com/docs/sdk](https://docs.verivyx.com/docs/sdk)
