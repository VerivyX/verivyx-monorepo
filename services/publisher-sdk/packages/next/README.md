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

### Proxy pre-filter (optional, defense-in-depth)

```ts
// proxy.ts (Next 16; middleware.ts on Next <=15)
import { verivyxNext } from "@verivyx/paywall-next";
import type { NextRequest } from "next/server";

// reads VERIVYX_TOKEN + VERIVYX_DOMAIN from env (throws at startup if unset)
const vx = verivyxNext();
const preFilter = vx.proxy(); // coarse, network-free pre-filter — the route handler is the real gate

export async function proxy(req: NextRequest) {
  return (await preFilter(req)) ?? undefined; // 402 for clear unpaid bots, else continue
}

export const config = { matcher: ["/articles/:path*", "/api/:path*"] };
```

The proxy is defense-in-depth only — it sheds obviously-unpaid bot traffic early (no network call). The route handler (`vx.protect(handler)`) remains the authoritative gate and must always be present.

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
