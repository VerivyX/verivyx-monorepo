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

Set `VERIVYX_TOKEN` and `VERIVYX_DOMAIN` as Cloudflare Workers secrets:

```
wrangler secret put VERIVYX_TOKEN
wrangler secret put VERIVYX_DOMAIN
```

Then deploy with `wrangler deploy`.
