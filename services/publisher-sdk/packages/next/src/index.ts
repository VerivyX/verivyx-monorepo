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
  classify,
  verifyWebBotAuth as coreVerifyWebBotAuth,
  buildPreviewHtml,
  buildPaywallJsonLd,
} from "@verivyx/paywall";
import type { VerivyxOptions, Verivyx } from "@verivyx/paywall";

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

/**
 * Clone a Response and attach (or overwrite) a single header.
 * Preserves status, statusText, and all existing headers.
 */
function withHeader(res: Response, key: string, value: string): Response {
  const headers = new Headers(res.headers);
  headers.set(key, value);
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

/**
 * Build an SEO preview Response (200 HTML) with anti-cloaking JSON-LD.
 * Used when the caller supplied `seoPreview` and the visitor is a crawler or
 * unverified human — so we deliver a teaser rather than a bare 402.
 */
function buildSeoPreviewResponse(
  slug: string,
  url: string,
  seoPreview: (c: { slug: string }) => { title: string; excerpt: string },
): Response {
  const { title, excerpt } = seoPreview({ slug });
  // Mirrors core's preview construction (packages/core/src/index.ts buildPreviewBuilders) — keep in sync.
  const jsonLd = buildPaywallJsonLd({ title, description: excerpt, url });
  const html = buildPreviewHtml({ title, excerpt, url, jsonLd });
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

/**
 * Create a Verivyx Next.js adapter.
 *
 * Returns an object with:
 *   - `protect(handler, o)` — wrap a route handler behind the Verivyx gate.
 *   - `proxy()` — a coarse pre-filter for `proxy.ts` (defense-in-depth only).
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

  // Build a real resolved config once for use by proxy()'s classify call.
  // resolveConfig throws ConfigError when domain/token are absent — same
  // behaviour as verivyx() itself, so verivyxNext always requires them.
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  const env: Record<string, string | undefined> = proc?.env ?? {};
  const cfg = resolveConfig(opts, env);

  // The verifyWebBotAuth dep used by proxy() mirrors what the core uses:
  // caller override if supplied, otherwise the bundled RFC 9421 verifier.
  const proxyVerifyWebBotAuth = opts?.verifyWebBotAuth ?? coreVerifyWebBotAuth;

  return {
    protect(handler, o) {
      return async function verivyxNextGuard(
        req: Request,
        ctx: { params?: Promise<Record<string, string>> },
      ): Promise<Response> {
        // 1. Resolve trusted client IP and inject into a cloned request so the
        //    core classifier reads a reliable address regardless of edge hop.
        const ip = resolveIp(req, trustProxy);
        let coreReq: Request;
        if (ip !== undefined) {
          const headers = new Headers(req.headers);
          headers.set("x-real-ip", ip);
          // Clone the Request with updated headers. For GET/HEAD this is safe;
          // for bodies we do NOT re-attach a body here (the core classify path
          // reads headers only — body stays with the original `req`).
          coreReq = new Request(req.url, {
            method: req.method,
            headers,
            // Do not attach body to coreReq — core classify reads headers only.
          });
        } else {
          coreReq = req;
        }

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
            return buildSeoPreviewResponse(resolvedSlug, req.url, o.seoPreview);
          }
          // Handler is NOT called — return the gate response (402 or preview).
          return decision.response();
        }

        // 4b. Allowed — call the original handler.
        const res = await handler(req, ctx);

        // 5. Attach the settlement receipt header when a payment was processed.
        if (decision.paymentResponse !== undefined) {
          return withHeader(res, "PAYMENT-RESPONSE", decision.paymentResponse);
        }
        return res;
      };
    },

    proxy() {
      /**
       * Coarse pre-filter for `proxy.ts` — defense-in-depth ONLY.
       *
       * proxy() uses the real core classify() function directly (no mock).
       * It is a coarse, network-free pre-filter: shed obviously-unpaid bot
       * traffic early before it reaches the route handler. The route handler
       * (via protect()) remains the authoritative gate.
       *
       * Returns a 402 Response only when the request looks like a clear
       * unpaid bot (ai-bot / signed-agent UA with no payment header).
       * Returns `undefined` in all other cases — let the request continue to
       * the route handler which will make the authoritative decision.
       */
      return async function verivyxProxy(
        req: Request,
      ): Promise<Response | undefined> {
        // Quick check: if there is any payment signal, skip the pre-filter
        // and let the route handler handle authorization properly.
        const hasPaymentHeader =
          req.headers.has("payment-signature") || req.headers.has("x-payment");
        if (hasPaymentHeader) {
          return undefined;
        }

        // Use the core's exported classify with a real resolved config.
        // No crawler DNS verification at this layer (proxy does NOT need it —
        // crawler → preview is the route handler's job, not the proxy's).
        let classification: string;
        try {
          const result = await classify(req, cfg, {
            verifyWebBotAuth: proxyVerifyWebBotAuth,
          });
          classification = result.classification;
        } catch {
          // classify error → pass through to route handler.
          return undefined;
        }

        if (classification === "ai-bot" || classification === "signed-agent") {
          // Return a minimal 402 — the route handler's full 402 body (with
          // payment requirements) is not built here to keep this lightweight.
          return new Response(
            JSON.stringify({ error: "payment_required" }),
            {
              status: 402,
              headers: { "content-type": "application/json" },
            },
          );
        }

        // All other classifications → pass through.
        return undefined;
      };
    },
  };
}
