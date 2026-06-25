import { Hono } from "hono";
import { verivyxHono } from "@verivyx/paywall-hono";
import type { HonoAdapterOptions } from "@verivyx/paywall-hono";

/**
 * Factory that creates a Hono app protected by Verivyx.
 *
 * In real use, omit `opts` — the adapter reads VERIVYX_TOKEN and
 * VERIVYX_DOMAIN from the environment automatically.
 *
 * Smoke tests inject `_core: verivyx.mock(...)` via `opts` so the tests
 * run without network access.
 */
export function makeApp(opts?: HonoAdapterOptions) {
  const vx = verivyxHono(opts);
  const app = new Hono();
  app.get(
    "/articles/:slug",
    vx.protect((c) => c.json({ body: `full article ${c.req.param("slug")}` })),
  );
  return app;
}

// Default export for Cloudflare Workers runtime.
// Workers set env via wrangler secrets — VERIVYX_TOKEN and VERIVYX_DOMAIN
// must be configured before deploying.
//
// Guard: only call makeApp() when env credentials are present so that
// importing makeApp in tests does not trigger a ConfigError.
const _domain =
  (typeof process !== "undefined" && process.env["VERIVYX_DOMAIN"]) ||
  undefined;

export default _domain ? makeApp() : new Hono();
