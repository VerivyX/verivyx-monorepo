/**
 * @verivyx/paywall-next
 *
 * Next.js (App Router) adapter for the Verivyx paywall SDK.
 *
 * Thin layer — all gate logic lives in @verivyx/paywall core.
 * This module handles:
 *   1. IP resolution from Next.js / Vercel proxy headers.
 *   2. Awaiting the Next 15+ async `ctx.params` Promise.
 *   3. Calling core `protect()` (decision overload).
 *   4. Returning `decision.response()` when denied (handler NOT called).
 *   5. Attaching `PAYMENT-RESPONSE` header when a settlement receipt exists.
 *   6. SEO preview: when the caller supplies `seoPreview`, the adapter builds
 *      the preview HTML itself (using the core-exported `buildPreviewHtml` /
 *      `buildPaywallJsonLd`) and returns it for crawler/human-unverified
 *      decisions. This approach is used because the core's decision overload
 *      (`protect(req, {slug})`) does not forward previewBuilders — only the
 *      wrap overload (`protect(handler, {seoPreview})`) does. Using core
 *      exports directly keeps this adapter on the decision overload while still
 *      delivering the preview.
 *
 * @example
 * ```ts
 * import { verivyxNext } from "@verivyx/paywall-next";
 * const vx = verivyxNext({ domain: "example.com", token: process.env.VX_TOKEN });
 * export const GET = vx.protect(myHandler, {
 *   seoPreview: ({ slug }) => ({ title: "Article", excerpt: "Read more..." }),
 * });
 * ```
 */

import {
  verivyx,
  resolveConfig,
  createSearchCrawlerVerifier,
  buildSeoPreviewResponse,
  attachPaymentResponse,
  rslLinkHeader,
  contentUsageHeader,
} from "@verivyx/paywall";
import type { VerivyxOptions, Verivyx, GateDecision, DiscoveryOptions } from "@verivyx/paywall";
import { NextResponse } from "next/server";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Options for the Next.js adapter.
 * Extends core VerivyxOptions with Next-specific controls.
 */
export interface NextAdapterOptions extends VerivyxOptions {
  /**
   * When true (default), read the client IP from `X-Forwarded-For` /
   * `X-Real-IP` headers (set by Vercel / a trusted reverse proxy).
   * Set to false if running without a proxy, to ignore those headers.
   */
  trustProxy?: boolean;

  /**
   * Override the reverse-DNS search-crawler verifier injected into the core.
   * When omitted, `createSearchCrawlerVerifier()` is used (the Node.js impl).
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

/**
 * A Next.js App Router route handler signature (Next 15+).
 * `ctx.params` is a Promise in Next 15+ (async route segments).
 */
type RouteHandler = (
  req: Request,
  ctx: { params?: Promise<Record<string, string>> },
) => Promise<Response> | Response;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the first (client-most) hop from an `X-Forwarded-For` header.
 */
function firstHop(xff: string | null): string | undefined {
  if (xff === null || xff === "") {
    return undefined;
  }
  const first = xff.split(",")[0];
  return first !== undefined ? first.trim() || undefined : undefined;
}

/**
 * Extract the last non-empty path segment from a URL string.
 * Used as a fallback slug when `ctx.params.slug` is unavailable.
 */
function lastPathSegment(url: string): string {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url;
  }
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
 * Resolve the client IP from a Web Request.
 *
 * Precedence (when trustProxy !== false):
 *   1. `X-Forwarded-For` first hop (Vercel / nginx upstream).
 *   2. `X-Real-IP` header.
 * Returns undefined when trustProxy === false or no header is present.
 */
function resolveIp(
  req: Request,
  trustProxy: boolean,
): string | undefined {
  if (!trustProxy) {
    return undefined;
  }
  const xff = req.headers.get("x-forwarded-for");
  const hop = firstHop(xff);
  if (hop !== undefined) {
    return hop;
  }
  const xri = req.headers.get("x-real-ip");
  return (xri !== null && xri !== "") ? xri : undefined;
}

// (buildSeoPreviewResponse and attachPaymentResponse are imported from @verivyx/paywall)

/**
 * Convert a glob pattern (`/articles/*`, `/articles/**`) to a RegExp.
 * Rules:
 *   `**` matches any characters including `/`.
 *   `*`  matches any characters except `/`.
 *   All other regex metacharacters are escaped.
 */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  // Order matters: replace ** before *
  const pattern = escaped
    .replace(/\*\*/g, ".+")
    .replace(/\*/g, "[^/]+");
  return new RegExp(`^${pattern}$`);
}

/**
 * Return true when `pathname` matches at least one of the glob patterns.
 */
function pathMatchesAny(pathname: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(pathname));
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
 * Create a Verivyx Next.js adapter.
 *
 * Returns an object with:
 *   - `protect(handler, o)` — wrap a route handler behind the Verivyx gate.
 *   - `proxy()` — authoritative settling gate for `middleware.ts` / `proxy.ts`.
 *     Runs the full pipeline (classify → authorize → verify+settle → failMode).
 *     Use `verivyxProxy(opts)` as a one-line convenience instead of calling
 *     `verivyxNext(opts).proxy()` directly.
 *
 * ```ts
 * const vx = verivyxNext({ domain: "example.com", token: "..." });
 * export const GET = vx.protect(myHandler);
 * ```
 */
export function verivyxNext(opts?: NextAdapterOptions): {
  protect(
    handler: RouteHandler,
    o?: {
      seoPreview?: (c: { slug: string }) => { title: string; excerpt: string };
      slug?: (req: Request) => string;
    },
  ): RouteHandler;
  proxy(): (req: Request) => Promise<Response | undefined>;
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

  // Build a real resolved config once for use by proxy()'s path-match filter.
  // resolveConfig throws ConfigError when domain/token are absent — same
  // behaviour as verivyx() itself, so verivyxNext always requires them.
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  const env: Record<string, string | undefined> = proc?.env ?? {};
  const cfg = resolveConfig(opts, env);

  /**
   * Build a header-sanitised core Request from an incoming Next.js Request.
   *
   * Security invariant:
   *   trustProxy !== false → resolve IP from proxy headers and set x-real-ip
   *     on the cloned request (overrides any client value).
   *   trustProxy === false  → strip x-real-ip and x-forwarded-for so the
   *     client cannot spoof an IP into the core classifier.
   *
   * The body is intentionally omitted — core classify/protect read headers
   * only and we must not consume the body here.
   */
  function buildCoreRequest(req: Request): Request {
    const ip = resolveIp(req, trustProxy);
    const headers = new Headers(req.headers);
    if (ip !== undefined) {
      headers.set("x-real-ip", ip);
    } else {
      headers.delete("x-real-ip");
      headers.delete("x-forwarded-for");
    }
    return new Request(req.url, { method: req.method, headers });
  }

  return {
    protect(handler, o) {
      return async function verivyxNextGuard(
        req: Request,
        ctx: { params?: Promise<Record<string, string>> },
      ): Promise<Response> {
        // 1. Resolve trusted client IP and inject into a cloned request so the
        //    core classifier reads a reliable address regardless of edge hop.
        //    (Logic extracted into buildCoreRequest above.)
        const coreReq = buildCoreRequest(req);

        // 2. Resolve slug.
        //    Priority: caller override > ctx.params.slug > last URL segment.
        //    ctx.params is a Promise in Next 15+ — always await it (guard undefined).
        const resolvedSlug: string =
          o?.slug?.(req) ??
          (ctx.params !== undefined ? (await ctx.params).slug : undefined) ??
          lastPathSegment(req.url);

        // 3. Ask the core to evaluate the request (decision overload).
        const decision = await vx.protect(coreReq, { slug: resolvedSlug });

        // 4a. Denied — check if this is a crawler/human-unverified that we can
        //     serve an SEO preview to instead of a bare 402.
        if (!decision.allowed) {
          const isPreviewCandidate =
            decision.reason === "crawler" || decision.reason === "human-unverified";
          if (isPreviewCandidate && o?.seoPreview !== undefined) {
            return withAdvertiseHeaders(
              buildSeoPreviewResponse(resolvedSlug, req.url, o.seoPreview),
              opts?.advertise,
            );
          }
          // Handler is NOT called — return the gate response (402 or preview).
          return withAdvertiseHeaders(decision.response(), opts?.advertise);
        }

        // 4b. Allowed — call the original handler.
        const res = await handler(req, ctx);

        // 5. Attach the settlement receipt header when a payment was processed,
        //    then attach discovery headers (single clone when both apply).
        return withAdvertiseHeaders(
          attachPaymentResponse(res, decision.paymentResponse),
          opts?.advertise,
        );
      };
    },

    proxy() {
      /**
       * Authoritative settling gate for `middleware.ts` / `proxy.ts`.
       *
       * Runs the full core pipeline (classify → authorize → verify+settle →
       * failMode). This is the single source of truth for the whole Next app;
       * there is no need for a second gate on each individual route handler.
       *
       * Behaviour:
       *   - Paths not in `cfg.match` (when match is set) → undefined (pass).
       *   - `decision.allowed` + `paymentResponse`       → NextResponse.next()
       *                                                     with PAYMENT-RESPONSE.
       *   - `decision.allowed` (no receipt)              → undefined (pass).
       *   - `!decision.allowed`                          → `decision.response()`
       *                                                     (402 or preview),
       *                                                     wrapped in advertise
       *                                                     headers when set.
       *   - Core throws                                  → undefined (don't
       *                                                     hard-break the site).
       *
       * Use `verivyxProxy(opts)` as a shorthand for `verivyxNext(opts).proxy()`.
       */
      return async function verivyxProxyHandler(
        req: Request,
      ): Promise<Response | undefined> {
        const url = new URL(req.url);
        // Match filter: when cfg.match is non-empty, skip paths that don't match.
        if (cfg.match && cfg.match.length > 0 && !pathMatchesAny(url.pathname, cfg.match)) {
          return undefined;
        }
        const coreReq = buildCoreRequest(req);
        const slug = url.pathname.split("/").filter(Boolean).pop() ?? "";
        let decision: GateDecision;
        try {
          decision = await vx.protect(coreReq, { slug });
        } catch {
          // Non-failMode error → don't hard-break the site.
          return undefined;
        }
        if (decision.allowed) {
          if (decision.paymentResponse) {
            // Pass through to the page while surfacing the settlement receipt.
            // NextResponse.next() is required here — a plain Response would
            // short-circuit the request and return an empty body to the agent.
            return NextResponse.next({
              headers: { "PAYMENT-RESPONSE": decision.paymentResponse },
            });
          }
          return undefined;
        }
        return withAdvertiseHeaders(decision.response(), opts?.advertise);
      };
    },
  };
}

/**
 * Convenience export: create a single proxy middleware function for a Next.js
 * `middleware.ts` that acts as the authoritative Verivyx settling gate.
 *
 * Equivalent to `verivyxNext(opts).proxy()`.
 *
 * @example
 * ```ts
 * // middleware.ts
 * import { verivyxProxy } from "@verivyx/paywall-next";
 * export const middleware = verivyxProxy({ domain: "example.com", token: process.env.VX_TOKEN });
 * export const config = { matcher: ["/articles/:path*"] };
 * ```
 */
export function verivyxProxy(opts?: NextAdapterOptions): (req: Request) => Promise<Response | undefined> {
  return verivyxNext(opts).proxy();
}
