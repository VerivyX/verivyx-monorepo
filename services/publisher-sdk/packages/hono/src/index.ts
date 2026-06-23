/**
 * @verivyx/paywall-hono
 *
 * Hono adapter for the Verivyx paywall SDK (Cloudflare Workers / Vercel Edge).
 *
 * Thin layer — all gate logic lives in @verivyx/paywall core.
 * This module handles:
 *   1. IP resolution from Cloudflare / proxy headers (CF-Connecting-IP first).
 *   2. Cloning the Web `Request` with the resolved IP in `x-real-ip`.
 *   3. Calling core `protect()` (decision overload).
 *   4. Returning `decision.response()` when denied (handler NOT called).
 *   5. Attaching `PAYMENT-RESPONSE` header when a settlement receipt exists.
 *
 * Edge-portable: NO `node:*` imports. Uses only Web Platform APIs and Hono types.
 *
 * @example
 * ```ts
 * import { verivyxHono } from "@verivyx/paywall-hono";
 * const vx = verivyxHono({ domain: "example.com", token: process.env.VX_TOKEN });
 * app.get("/articles/:slug", vx.protect(async (c) => c.json({ content: "..." })));
 * ```
 */

import {
  verivyx,
  createSearchCrawlerVerifier,
  buildSeoPreviewResponse,
  attachPaymentResponse,
} from "@verivyx/paywall";
import type { VerivyxOptions, Verivyx } from "@verivyx/paywall";
import type { Context, MiddlewareHandler } from "hono";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Options for the Hono adapter.
 * Extends core VerivyxOptions with edge-specific controls.
 */
export interface HonoAdapterOptions extends VerivyxOptions {
  /**
   * When true (default), read the client IP from Cloudflare / proxy headers:
   *   CF-Connecting-IP → X-Forwarded-For first hop → X-Real-IP.
   * Set to false if running without a trusted proxy.
   */
  trustProxy?: boolean;

  /**
   * Override the reverse-DNS search-crawler verifier injected into the core.
   * When omitted, `createSearchCrawlerVerifier()` is used.
   */
  verifyCrawlerDns?: (ip: string, ua: string) => Promise<boolean>;

  /**
   * Override the Web Bot Auth verifier injected into the core.
   * When omitted, the core's bundled RFC 9421 verifier is used.
   */
  verifyWebBotAuth?: (req: Request) => Promise<boolean>;

  /**
   * @internal
   * Inject a pre-built `Verivyx` core instance. Used in tests via
   * `verivyx.mock({...})` to avoid any network access. Production code
   * should never set this; omit it and the adapter constructs the real core.
   */
  _core?: Verivyx;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the first (client-most) hop from an `X-Forwarded-For` header value.
 * The header may contain a comma-separated list; the leftmost is the client.
 */
function firstHop(xff: string | null | undefined): string | undefined {
  if (xff === null || xff === undefined || xff === "") {
    return undefined;
  }
  const first = xff.split(",")[0];
  return first !== undefined ? first.trim() || undefined : undefined;
}

/**
 * Extract the last non-empty path segment from a URL pathname.
 * Used as a fallback slug when `c.req.param("slug")` is unavailable.
 */
function lastPathSegment(pathname: string): string {
  const segments = pathname.split("/").filter((s) => s.length > 0);
  const last = segments[segments.length - 1];
  if (last === undefined) {
    return "";
  }
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/**
 * Resolve the trusted client IP from Hono context headers.
 *
 * Precedence (Cloudflare Workers best-practice order):
 *   1. CF-Connecting-IP — set by Cloudflare edge (single trusted value).
 *   2. X-Forwarded-For first hop — set by other proxies / Vercel.
 *   3. X-Real-IP — generic proxy header.
 * Returns undefined when trustProxy === false or no header is present.
 */
function resolveIp(c: Context, trustProxy: boolean): string | undefined {
  if (!trustProxy) {
    return undefined;
  }
  const cfIp = c.req.header("cf-connecting-ip");
  if (cfIp !== undefined && cfIp !== "") {
    return cfIp;
  }
  const xff = c.req.header("x-forwarded-for");
  const hop = firstHop(xff);
  if (hop !== undefined) {
    return hop;
  }
  const xri = c.req.header("x-real-ip");
  return xri !== undefined && xri !== "" ? xri : undefined;
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

/**
 * Create a Verivyx Hono adapter.
 *
 * Returns an object with a single `protect(handler)` method that wraps a
 * Hono route handler behind the Verivyx paywall gate.
 *
 * ```ts
 * const vx = verivyxHono({ domain: "example.com", token: "..." });
 * app.get("/articles/:slug", vx.protect(async (c) => c.json({ content: "..." })));
 * ```
 */
export function verivyxHono(opts?: HonoAdapterOptions): {
  protect(
    handler: (c: Context) => Response | Promise<Response>,
    o?: { seoPreview?: (c: { slug: string }) => { title: string; excerpt: string } },
  ): MiddlewareHandler;
} {
  // Resolve the core: use the injected `_core` (tests) or build the real one.
  // Only pass `verifyWebBotAuth` to the core deps when the caller overrode it;
  // the core bundled default is correct otherwise.
  const vx: Verivyx =
    opts?._core ??
    verivyx(opts, {
      verifyCrawlerDns:
        opts?.verifyCrawlerDns ?? createSearchCrawlerVerifier(),
      ...(opts?.verifyWebBotAuth !== undefined
        ? { verifyWebBotAuth: opts.verifyWebBotAuth }
        : {}),
    });

  const trustProxy = opts?.trustProxy !== false; // default true

  return {
    protect(
      handler: (c: Context) => Response | Promise<Response>,
      o?: { seoPreview?: (c: { slug: string }) => { title: string; excerpt: string } },
    ): MiddlewareHandler {
      return async function verivyxHonoGuard(c): Promise<Response> {
        // 1. Get the raw Web Request from Hono context.
        const raw = c.req.raw;

        // 2. Resolve trusted client IP and inject into a cloned request so the
        //    core classifier reads a reliable address regardless of edge hop.
        //
        //    Security invariant:
        //      trustProxy !== false → resolve IP from CF/proxy headers and set
        //        x-real-ip on the cloned request (overrides any client value).
        //      trustProxy === false  → no socket IP is available in edge runtimes;
        //        strip both x-real-ip and x-forwarded-for so a client cannot
        //        spoof an IP into the core classifier (core sees no IP → safe).
        const ip = resolveIp(c, trustProxy);
        let coreReq: Request;
        if (ip !== undefined) {
          const headers = new Headers(raw.headers);
          headers.set("x-real-ip", ip);
          // Clone the Request with updated headers. For GET/HEAD this is safe;
          // the core classify path reads headers only — body stays with raw.
          coreReq = new Request(raw, { headers });
        } else {
          // trustProxy === false: strip forwarding headers so the client cannot
          // inject a spoofed IP into the core.
          const headers = new Headers(raw.headers);
          headers.delete("x-real-ip");
          headers.delete("x-forwarded-for");
          coreReq = new Request(raw, { headers });
        }

        // 3. Resolve slug.
        //    Priority: Hono named param "slug" > last URL path segment.
        const paramSlug: string | undefined = c.req.param("slug");
        const slug: string =
          (paramSlug !== undefined && paramSlug !== "")
            ? paramSlug
            : lastPathSegment(new URL(raw.url).pathname);

        // 4. Ask the core to evaluate the request (decision overload).
        const decision = await vx.protect(coreReq, { slug });

        // 5. Denied — check if this is a crawler/human-unverified that we can
        //    serve an SEO preview to instead of a bare 402. Handler NOT called.
        if (!decision.allowed) {
          const isPreviewCandidate =
            decision.reason === "crawler" || decision.reason === "human-unverified";
          if (isPreviewCandidate && o?.seoPreview !== undefined) {
            return buildSeoPreviewResponse(slug, raw.url, o.seoPreview);
          }
          return decision.response();
        }

        // 6. Allowed — call the original Hono handler.
        const res = await handler(c);

        // 7. Attach the settlement receipt header when a payment was processed.
        return attachPaymentResponse(res, decision.paymentResponse);
      };
    },
  };
}
