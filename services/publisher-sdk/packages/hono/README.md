# @verivyx/paywall-hono

Hono adapter for the Verivyx paywall SDK — gate content from AI bots, charge agents on-chain via x402, let humans read free, and serve search crawlers an SEO preview. Edge-portable: Cloudflare Workers, Vercel Edge Functions, and any Web Platform runtime (no `node:*` imports).

Requires `@verivyx/paywall` (installed automatically) and `hono` (peer dependency).

## Install

```sh
npm i @verivyx/paywall-hono
```

## Quickstart — one middleware (recommended)

`app.use("*", verivyxHonoMiddleware(...))` gates every matched route: AI bots/agents get a `402` (and can pay via x402), verified humans read for free, crawlers get an SEO preview.

```ts
import { Hono } from "hono";
import { verivyxHonoMiddleware } from "@verivyx/paywall-hono";

const app = new Hono();

app.use("*", verivyxHonoMiddleware({
  token: process.env.VERIVYX_TOKEN,   // required — your site token (or set VERIVYX_TOKEN env)
  match: ["/articles/*"],
  seoPreview: ({ slug }) => ({ title: titleFor(slug), excerpt: excerptFor(slug) }),
  humanUnlock: {},   // humans solve an in-page PoW → read full content free
}));

app.get("/articles/:slug", (c) => c.html(renderArticle(c.req.param("slug"))));
export default app;
```

Reads `VERIVYX_TOKEN` from env when not passed inline (on Workers, set it with `wrangler secret put VERIVYX_TOKEN`).

## Per-route alternative

```ts
import { verivyxHono } from "@verivyx/paywall-hono";
const vx = verivyxHono();
app.get("/articles/:slug", vx.protect(async (c) => c.json({ content: "..." })));
```

## Config

All options can be passed to `verivyxHonoMiddleware(opts)` / `verivyxHono(opts)` or set via env.

| Option / env var | Required | Description |
|---|---|---|
| `VERIVYX_TOKEN` | yes (server-only) | Your site token from the Verivyx dashboard — it alone identifies your site |
| `VERIVYX_DOMAIN` | no | Optional legacy/analytics label, e.g. `example.com`. Not required and not part of onboarding — the token identifies your site. |
| `match` / `VERIVYX_MATCH` | no | Glob patterns to gate. Empty = nothing gated. Env accepts a comma-separated list. |
| `seoPreview` | no | `({ slug }) => { title, excerpt }` — teaser for crawlers, with anti-cloaking JSON-LD |
| `humanUnlock` | no | `{ authBase? }` — unverified human browsers get an in-page PoW unlock to read full content free |
| `failMode` / `VERIVYX_FAIL_MODE` | no | Backend unreachable: `teaser` (default) \| `open` \| `closed` |
| `timeoutMs` / `VERIVYX_TIMEOUT_MS` | no | Timeout in ms for the quick classify/requirements call (default `800`). |
| `settleTimeoutMs` / `VERIVYX_SETTLE_TIMEOUT_MS` | no | Timeout in ms for the authorize/settle call that awaits on-chain confirmation (default `60000`, ~15s settle). No need to raise `timeoutMs` for agent payments — the settle path uses this. |

Also: `trustProxy` (default `true`, prefers `CF-Connecting-IP`), `advertise` (RSL/AIPREF discovery headers).

This adapter is **0.7.1** and depends on `@verivyx/paywall` **0.3.2** (token-only).

## Docs

[https://docs.verivyx.com/docs/sdk](https://docs.verivyx.com/docs/sdk)
