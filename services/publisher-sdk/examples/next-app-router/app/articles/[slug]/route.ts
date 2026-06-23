import { verivyxNext } from "@verivyx/paywall-next";
import type { NextAdapterOptions } from "@verivyx/paywall-next";

/**
 * Factory that builds a Next.js App Router GET handler protected by Verivyx.
 *
 * In real use, omit `opts` — the adapter reads VERIVYX_TOKEN and
 * VERIVYX_DOMAIN from the environment automatically.
 *
 * Smoke tests inject `_core: verivyx.mock(...)` via `opts` so the tests
 * run without network access.
 */
export function makeGET(opts?: NextAdapterOptions) {
  const vx = verivyxNext(opts);
  return vx.protect(async (_req, ctx) => {
    const slug = (await ctx.params)?.slug ?? "";
    return Response.json({ body: `full article ${slug}` });
  });
}

// In Next.js, this file is loaded by the framework with env already set.
// Export the real handler for Next.js routing at /articles/[slug].
// Set VERIVYX_TOKEN and VERIVYX_DOMAIN in .env.local before running next dev.
//
// NOTE: The GET export below calls makeGET() at module init time — when running
// in Next.js the env is populated by the framework. Tests import makeGET()
// directly (not GET) to avoid the env requirement.
export const GET = /* @__PURE__ */ (() => {
  // Guard: only initialise when env credentials are present (Next.js runtime).
  const domain =
    (typeof process !== "undefined" && process.env["VERIVYX_DOMAIN"]) ||
    undefined;
  if (!domain) {
    // Return a placeholder handler so module load succeeds in test/build
    // environments where env is not set. Next.js will never reach this
    // branch in production.
    return async () => new Response("not configured", { status: 503 });
  }
  return makeGET();
})();
