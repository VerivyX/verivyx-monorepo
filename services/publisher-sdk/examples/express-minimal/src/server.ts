import express from "express";
import { verivyxExpress } from "@verivyx/paywall-express";
import type { ExpressAdapterOptions } from "@verivyx/paywall-express";

/**
 * Factory that creates a minimal Express app protected by Verivyx.
 *
 * In real use, omit `opts` — the adapter reads VERIVYX_TOKEN and
 * VERIVYX_DOMAIN from the environment automatically.
 *
 * Smoke tests inject `_core: verivyx.mock(...)` via `opts` so the tests
 * run without network access.
 */
export function createApp(opts?: ExpressAdapterOptions) {
  const vx = verivyxExpress(opts);
  const app = express();
  app.get(
    "/articles/:slug",
    vx.protect((req, res) =>
      res.json({ body: `full article ${req.params.slug}` }),
    ),
  );
  return app;
}

// Real app entry point — only initialised when this file is the main module
// so that test imports of `createApp` don't eagerly read env credentials.
//
// Run: VERIVYX_TOKEN=<token> VERIVYX_DOMAIN=<domain> node src/server.js
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const app = createApp();
  app.listen(3000, () => console.log("Listening on :3000"));
}
