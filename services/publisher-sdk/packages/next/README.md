# @verivyx/paywall-next

Next.js (App Router) adapter for the Verivyx paywall SDK — gate content from AI bots and charge agents on-chain via x402, with Vercel-aware IP resolution and async `ctx.params` support (Next 15+).

Requires `@verivyx/paywall` (installed automatically as a dependency) and `next` + `react` (peer dependencies).

## Install

```sh
npm i @verivyx/paywall-next
```

## Quickstart

```ts
// app/articles/[slug]/route.ts
import { verivyxNext } from "@verivyx/paywall-next";

// Create an adapter (reads VERIVYX_TOKEN + VERIVYX_DOMAIN from env)
const vx = verivyxNext();

async function handler(req: Request, ctx: { params?: Promise<Record<string, string>> }) {
  return Response.json({ content: "..." });
}

// Export as a Next.js route handler — verified/paid requests pass through; bots get a 402
export const GET = vx.protect(handler);
```

### With SEO preview

```ts
export const GET = vx.protect(handler, {
  seoPreview: ({ slug }) => ({
    title: "Article title",
    excerpt: "A short teaser visible to search crawlers.",
  }),
});
```

### Middleware pre-filter (optional, defense-in-depth)

```ts
// middleware.ts
import { verivyxNext } from "@verivyx/paywall-next";
const vx = verivyxNext();
const preFilter = vx.proxy();

export async function middleware(req: Request) {
  const early = await preFilter(req);
  if (early) return early;
}
```

## Config

All options can be passed to `verivyxNext(opts)` or set via environment variables.

| Env var | Required | Description |
|---|---|---|
| `VERIVYX_TOKEN` | yes (server-only) | Domain provisioning token from the Verivyx dashboard |
| `VERIVYX_DOMAIN` | yes | Your site domain, e.g. `example.com` |
| `VERIVYX_MATCH` | no | Comma-separated glob patterns to gate (e.g. `/articles/**`). Empty = gate all routes. Also accepts `string[]` in code. |
| `VERIVYX_FAIL_MODE` | no | Behaviour when the Verivyx backend is unreachable: `teaser` (default) \| `open` \| `closed` |
| `VERIVYX_TIMEOUT_MS` | no | Backend request timeout in milliseconds (default `800`) |

Additional code-only options: `trustProxy` (default `true`), `advertise` (RSL/AIPREF discovery headers).

## Docs

[https://docs.verivyx.com/docs/sdk](https://docs.verivyx.com/docs/sdk)
