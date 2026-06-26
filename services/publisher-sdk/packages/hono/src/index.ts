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
  rslLinkHeader,
  contentUsageHeader,
} from "@verivyx/paywall";
import type { VerivyxOptions, Verivyx, DiscoveryOptions } from "@verivyx/paywall";
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

  /**
   * When set, attach RSL `Link` and AIPREF `Content-Usage` headers to both
   * the denied (402) and allowed handler responses.
   * Default undefined = OFF (no headers added; existing behavior unchanged).
   */
  advertise?: DiscoveryOptions;
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
 * Return true when `pathname` matches any of the `patterns`.
 * Supports `*` (single-segment wildcard) and `**` (multi-segment wildcard).
 * Performs an anchored full-path match.
 */
function pathMatchesAny(pathname: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    // Escape regex metacharacters except * which we handle specially.
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    // Replace ** before * so the two-step substitution is order-safe.
    const regexStr = escaped
      .replace(/\*\*/g, "") // placeholder for **
      .replace(/\*/g, "[^/]*")   // single-segment wildcard
      .replace(//g, ".*"); // multi-segment wildcard
    return new RegExp("^" + regexStr + "$").test(pathname);
  });
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

/**
 * Attach RSL + AIPREF discovery headers to a Web Response by cloning it.
 * Appends to any existing `Link` (preserves prior values); sets `Content-Usage`.
 * Returns the same Response unchanged when `advertise` is undefined.
 */
function withAdvertiseHeaders(res: Response, advertise: DiscoveryOptions | undefined): Response {
  if (advertise === undefined) {
    return res;
  }
  const headers = new Headers(res.headers);
  headers.append("Link", rslLinkHeader(advertise));
  headers.set("Content-Usage", contentUsageHeader(advertise));
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

/**
 * Create a Verivyx Hono adapter.
 *
 * Returns an object with `protect(handler)` (per-route gate) and
 * `middleware()` (whole-app settling gate).
 *
 * ```ts
 * const vx = verivyxHono({ domain: "example.com", token: "..." });
 * // Per-route:
 * app.get("/articles/:slug", vx.protect(async (c) => c.json({ content: "..." })));
 * // Whole-app:
 * app.use("*", vx.middleware());
 * ```
 */
export function verivyxHono(opts?: HonoAdapterOptions): {
  protect(
    handler: (c: Context) => Response | Promise<Response>,
    o?: { seoPreview?: (c: { slug: string }) => { title: string; excerpt: string } },
  ): MiddlewareHandler;
  middleware(): MiddlewareHandler;
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

  /**
   * Build a core-compatible `Request` from a Hono context.
   * Resolves the trusted client IP (CF/proxy headers) and sets `x-real-ip`
   * on the cloned request, or strips forwarding headers when trustProxy:false.
   *
   * Security invariant: a client can never inject a fake IP into the core
   * classifier — either CF/proxy value wins, or no IP is seen at all.
   */
  function buildCoreRequest(c: Context): Request {
    const raw = c.req.raw;
    const ip = resolveIp(c, trustProxy);
    if (ip !== undefined) {
      const headers = new Headers(raw.headers);
      headers.set("x-real-ip", ip);
      return new Request(raw, { headers });
    } else {
      // trustProxy === false: strip forwarding headers so the client cannot
      // inject a spoofed IP into the core.
      const headers = new Headers(raw.headers);
      headers.delete("x-real-ip");
      headers.delete("x-forwarded-for");
      return new Request(raw, { headers });
    }
  }

  return {
    protect(
      handler: (c: Context) => Response | Promise<Response>,
      o?: { seoPreview?: (c: { slug: string }) => { title: string; excerpt: string } },
    ): MiddlewareHandler {
      return async function verivyxHonoGuard(c): Promise<Response> {
        // 1. Build a core-compatible request (IP resolution + header hygiene).
        const coreReq = buildCoreRequest(c);
        const raw = c.req.raw;

        // 2. Resolve slug.
        //    Priority: Hono named param "slug" > last URL path segment.
        const paramSlug: string | undefined = c.req.param("slug");
        const slug: string =
          (paramSlug !== undefined && paramSlug !== "")
            ? paramSlug
            : lastPathSegment(new URL(raw.url).pathname);

        // 3. Ask the core to evaluate the request (decision overload).
        const decision = await vx.protect(coreReq, { slug });

        // 4. Denied — check if this is a crawler/human-unverified that we can
        //    serve an SEO preview to instead of a bare 402. Handler NOT called.
        if (!decision.allowed) {
          const isPreviewCandidate =
            decision.reason === "crawler" || decision.reason === "human-unverified";
          if (isPreviewCandidate && o?.seoPreview !== undefined) {
            return withAdvertiseHeaders(
              buildSeoPreviewResponse(slug, raw.url, o.seoPreview),
              opts?.advertise,
            );
          }
          return withAdvertiseHeaders(decision.response(), opts?.advertise);
        }

        // 5. Allowed — call the original Hono handler.
        const res = await handler(c);

        // 6. Attach the settlement receipt header when a payment was processed,
        //    then attach discovery headers (single clone when both apply).
        return withAdvertiseHeaders(
          attachPaymentResponse(res, decision.paymentResponse),
          opts?.advertise,
        );
      };
    },

    middleware(): MiddlewareHandler {
      return async (c, next) => {
        // 1. Path-match filter: when match is set, skip non-matching paths.
        const pathname = c.req.path;
        if (opts?.match !== undefined && opts.match.length > 0 && !pathMatchesAny(pathname, opts.match)) {
          return next();
        }

        // 2. Build a core-compatible request (IP resolution + header hygiene).
        const coreReq = buildCoreRequest(c);

        // 3. Slug = last path segment (middleware has no named :slug param).
        const slug = pathname.split("/").filter(Boolean).pop() ?? "";

        // 4. Gate decision.
        const decision = await vx.protect(coreReq, { slug });

        if (decision.allowed) {
          // 5a. Allowed — run downstream handlers first.
          await next();
          // 5b. Attach settlement receipt on the outbound response.
          //     After next(), c.res holds the downstream Response.
          //     Reassign to a mutable clone so we can set the header.
          if (decision.paymentResponse !== undefined) {
            c.res = new Response(c.res.body, c.res);
            c.res.headers.set("PAYMENT-RESPONSE", decision.paymentResponse);
          }
          return;
        }

        // 5c. Blocked — short-circuit; next() is NOT called.
        return withAdvertiseHeaders(decision.response(), opts?.advertise);
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Top-level convenience export
// ---------------------------------------------------------------------------

/**
 * Whole-app Hono middleware that gates every matched route behind the
 * Verivyx settling paywall.
 *
 * ```ts
 * import { verivyxHonoMiddleware } from "@verivyx/paywall-hono";
 * app.use("*", verivyxHonoMiddleware({ domain: "example.com", token: "..." }));
 * ```
 */
export function verivyxHonoMiddleware(opts?: HonoAdapterOptions): MiddlewareHandler {
  return verivyxHono(opts).middleware();
}
