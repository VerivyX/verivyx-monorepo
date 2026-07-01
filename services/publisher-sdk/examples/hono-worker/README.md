# hono-worker

Minimal Hono app showing Verivyx paywall integration (Cloudflare Workers / Vercel Edge).

## Install

```
npm i @verivyx/paywall-hono
```

## Usage

```ts
import { Hono } from "hono";
import { verivyxHono } from "@verivyx/paywall-hono";

const vx = verivyxHono();
const app = new Hono();
app.get("/articles/:slug", vx.protect((c) =>
  c.json({ body: `full article ${c.req.param("slug")}` })
));
export default app;
```

## Run live

Set `VERIVYX_TOKEN` as a Cloudflare Workers secret (token-only config):

```
wrangler secret put VERIVYX_TOKEN
```

`VERIVYX_DOMAIN` is optional (a legacy analytics label) and not required.

Then deploy with `wrangler deploy`.
