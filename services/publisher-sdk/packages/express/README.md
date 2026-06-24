# @verivyx/paywall-express

Express adapter for the Verivyx paywall SDK — gate content from AI bots and charge agents on-chain via x402, with zero-config reverse-DNS crawler verification for SEO safety.

Requires `@verivyx/paywall` (installed automatically as a dependency) and `express` (peer dependency).

## Install

```sh
npm i @verivyx/paywall-express
```

## Quickstart

```ts
import express from "express";
import { verivyxExpress } from "@verivyx/paywall-express";

const app = express();

// Create an adapter (reads VERIVYX_TOKEN + VERIVYX_DOMAIN from env)
const vx = verivyxExpress();

// Gate a route — verified/paid requests pass through; bots get a 402
app.get("/articles/:slug", vx.protect(async (req, res) => {
  res.json({ content: "..." });
}));

app.listen(3000);
```

### With SEO preview

```ts
app.get("/articles/:slug", vx.protect(myHandler, {
  seoPreview: ({ slug }) => ({
    title: "Article title",
    excerpt: "A short teaser visible to search crawlers.",
  }),
}));
```

## Config

All options can be passed to `verivyxExpress(opts)` or set via environment variables.

| Env var | Required | Description |
|---|---|---|
| `VERIVYX_TOKEN` | yes (server-only) | Domain provisioning token from the Verivyx dashboard |
| `VERIVYX_DOMAIN` | yes | Your site domain, e.g. `example.com` |
| `VERIVYX_MATCH` | no | Comma-separated glob patterns to gate (e.g. `/articles/**`). Empty = gate all routes. Also accepts `string[]` in code. |
| `VERIVYX_FAIL_MODE` | no | Behaviour when the Verivyx backend is unreachable: `teaser` (default) \| `open` \| `closed` |
| `VERIVYX_TIMEOUT_MS` | no | Backend request timeout in milliseconds (default `800`) |

Additional code-only options: `trustProxy` (default `true`), `clientIp`, `advertise` (RSL/AIPREF discovery headers).

## Docs

[https://docs.verivyx.com/docs/sdk](https://docs.verivyx.com/docs/sdk)
