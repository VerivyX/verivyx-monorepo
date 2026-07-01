# next-app-router

Minimal Next.js App Router route handler showing Verivyx paywall integration.

## Install

```
npm i @verivyx/paywall-next
```

## Usage

In `app/articles/[slug]/route.ts`:

```ts
import { verivyxNext } from "@verivyx/paywall-next";

const vx = verivyxNext();
export const GET = vx.protect(async (_req, ctx) => {
  const { slug } = (await ctx.params) ?? { slug: "" };
  return Response.json({ body: `full article ${slug}` });
});
```

## Run live

Set `VERIVYX_TOKEN` in your `.env.local` before starting (token-only config):

```
VERIVYX_TOKEN=<your-token>
```

`VERIVYX_DOMAIN` is optional (a legacy analytics label) and not required.

Then run `next dev` or `next build && next start`.
