/**
 * @verivyx/paywall-express
 *
 * Express adapter for the Verivyx paywall SDK.
 *
 * Thin layer — all gate logic lives in @verivyx/paywall core.
 * This module only handles:
 *   1. IP resolution from Express request.
 *   2. Converting Express IncomingMessage → Web Request.
 *   3. Calling core `protect()` (decision overload).
 *   4. Converting the Web Response back to Express response, OR calling the
 *      original Express handler when the request is allowed through.
 *
 * Mock-injection seam (for Tasks 18/19 to reuse):
 *   Pass `_core: verivyx.mock({...})` in options to bypass network.
 *   In production: omit `_core`; the adapter instantiates `verivyx(opts, deps)`.
 *
 * @example
 * ```ts
 * import { verivyxExpress } from "@verivyx/paywall-express";
 * const vx = verivyxExpress({ domain: "example.com", token: process.env.VX_TOKEN });
 * app.get("/articles/:slug", vx.protect(myHandler));
 * ```
 */

import type { Request as ExpressRequest, RequestHandler, Response as ExpressResponse, NextFunction } from "express";
import {
  verivyx,
  createSearchCrawlerVerifier,
  buildSeoPreviewResponse,
  rslLinkHeader,
  contentUsageHeader,
} from "@verivyx/paywall";
import type { VerivyxOptions, Verivyx, DiscoveryOptions } from "@verivyx/paywall";
import type { IncomingHttpHeaders } from "node:http";
import type { Socket } from "node:net";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Options for the Express adapter.
 * Extends core VerivyxOptions with Express-specific IP resolution controls.
 */
export interface ExpressAdapterOptions extends VerivyxOptions {
  /**
   * When true (default), read the client IP from `X-Forwarded-For` /
   * `X-Real-IP` headers (set by a trusted reverse proxy). Set to false if
   * the Express app is not behind a proxy, to use the raw socket address.
   */
  trustProxy?: boolean;

  /**
   * Custom IP extractor. When provided, this overrides the built-in
   * `trustProxy` / `X-Forwarded-For` logic entirely.
   *
   * @param req - The Express request object.
   * @returns The resolved client IP, or undefined to fall back to socket.
   */
  clientIp?: (req: ExpressRequest) => string | undefined;

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
   *
   * Pattern for Next.js / Hono adapters to reuse:
   *   `const vx = opts?._core ?? verivyx(opts, { verifyCrawlerDns });`
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
 * Extract the first (client-most) hop from an `X-Forwarded-For` header.
 * The header may contain a comma-separated list; the leftmost is the client.
 */
function firstHop(xff: string | string[] | undefined): string | undefined {
  if (xff === undefined) {
    return undefined;
  }
  const raw = Array.isArray(xff) ? xff[0] : xff;
  if (!raw) {
    return undefined;
  }
  const first = raw.split(",")[0];
  return first !== undefined ? first.trim() || undefined : undefined;
}

/**
 * Extract the last non-empty path segment from a URL path string.
 * Used as a fallback slug when `req.params.slug` is not available.
 */
function lastPathSegment(path: string): string {
  const segments = path.split("/").filter((s) => s.length > 0);
  const last = segments[segments.length - 1];
  return last !== undefined ? decodeURIComponent(last) : "";
}

/**
 * Build a `Headers` object from Node.js IncomingHttpHeaders, overriding
 * `x-real-ip` with the resolved (trusted) client IP so the core classifier
 * reads a reliable address.
 */
function toWebHeaders(
  nodeHeaders: IncomingHttpHeaders,
  ip: string | undefined,
): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(nodeHeaders)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const v of value) {
        headers.append(key, v);
      }
    } else {
      headers.set(key, value);
    }
  }
  if (ip !== undefined) {
    headers.set("x-real-ip", ip);
  }
  return headers;
}

/**
 * Resolve the client IP from an Express request.
 *
 * Precedence:
 *   1. `opts.clientIp(req)` — caller-supplied extractor (highest precedence).
 *   2. `X-Forwarded-For` first hop (when trustProxy !== false).
 *   3. `X-Real-IP` header (when trustProxy !== false).
 *   4. `req.socket.remoteAddress` — raw TCP peer (lowest precedence).
 */
function resolveIp(
  req: ExpressRequest,
  opts: ExpressAdapterOptions | undefined,
): string | undefined {
  if (opts?.clientIp) {
    return opts.clientIp(req);
  }
  if (opts?.trustProxy !== false) {
    const xff = req.headers["x-forwarded-for"];
    const hop = firstHop(xff);
    if (hop) {
      return hop;
    }
    const xri = req.headers["x-real-ip"];
    if (typeof xri === "string" && xri) {
      return xri;
    }
  }
  return (req.socket as Socket).remoteAddress;
}

/**
 * Collect the raw request body into a Uint8Array.
 * Returns undefined for requests with no body (GET / HEAD / OPTIONS).
 * Express may have already consumed the stream with a body parser — if
 * `req.body` is already populated as a Buffer we use that directly.
 */
async function readRawBody(
  req: ExpressRequest,
): Promise<Uint8Array | undefined> {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return undefined;
  }

  // Express body-parser may have already consumed and parsed the stream.
  // If `req.body` is a Buffer, use it directly.
  const body: unknown = (req as { body?: unknown }).body;
  if (Buffer.isBuffer(body)) {
    return new Uint8Array(body);
  }

  // Otherwise collect the raw stream.
  return new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    req.on("error", reject);
  });
}

/**
 * Check whether a pathname matches any of the given glob patterns.
 * Supports `*` (any segment chars except `/`) and `**` (any chars including `/`).
 */
function pathMatchesAny(pathname: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    // Build a regex from the glob pattern:
    // 1. Escape all regex metacharacters except * and ?.
    // 2. Replace ** with a placeholder, then * with [^/]*, then restore **.
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    const regexStr =
      "^" +
      escaped
        .replace(/\*\*/g, "\x00")
        .replace(/\*/g, "[^/]*")
        .replace(/\x00/g, ".*") +
      "$";
    if (new RegExp(regexStr).test(pathname)) {
      return true;
    }
  }
  return false;
}

/**
 * Build a Web API `Request` from an Express request.
 * Resolves the trusted client IP, builds absolute URL, and reads the raw body.
 */
async function buildWebRequest(
  req: ExpressRequest,
  opts: ExpressAdapterOptions | undefined,
): Promise<Request> {
  const ip = resolveIp(req, opts);
  const host =
    (typeof req.get === "function" ? req.get("host") : undefined) ??
    (typeof req.headers.host === "string" ? req.headers.host : undefined) ??
    "localhost";
  const protocol = req.protocol ?? "http";
  const absoluteUrl = `${protocol}://${host}${req.originalUrl}`;
  const webHeaders = toWebHeaders(req.headers, ip);

  let rawBody: Uint8Array | undefined;
  try {
    rawBody = await readRawBody(req);
  } catch {
    rawBody = undefined;
  }

  return new Request(absoluteUrl, {
    method: req.method,
    headers: webHeaders,
    body: rawBody !== undefined ? rawBody : undefined,
    ...(rawBody !== undefined ? { duplex: "half" } : {}),
  } as RequestInit);
}

/**
 * Attach RSL + AIPREF discovery headers to an Express response.
 * Appends to any existing `Link` (preserves prior values); sets `Content-Usage`.
 * No-op when `advertise` is undefined.
 */
function attachAdvertiseHeaders(
  res: ExpressResponse,
  advertise: DiscoveryOptions | undefined,
): void {
  if (advertise === undefined) {
    return;
  }
  res.append("Link", rslLinkHeader(advertise));
  res.setHeader("Content-Usage", contentUsageHeader(advertise));
}

/**
 * Convert a Web API `Response` to an Express response.
 * Copies status, all response headers, and the body.
 *
 * @internal Exported for unit-testing the Set-Cookie accumulation fix.
 * Production callers should use the `protect()` middleware instead.
 *
 * Set-Cookie is special: `Headers.forEach` emits each cookie as a separate
 * call with the same key, and `res.setHeader` REPLACES on repeated same-key
 * calls — so all but the last cookie would be silently dropped.
 * `res.append` accumulates values into an array, preserving every cookie.
 */
export async function sendWebResponse(
  res: ExpressResponse,
  webRes: Response,
): Promise<void> {
  res.status(webRes.status);
  webRes.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") {
      res.append(key, value);
    } else {
      res.setHeader(key, value);
    }
  });
  const buf = Buffer.from(await webRes.arrayBuffer());
  res.send(buf);
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

/**
 * Create a Verivyx Express adapter.
 *
 * Returns an object with a single `protect(handler)` method that wraps an
 * Express `RequestHandler` behind the Verivyx paywall gate.
 *
 * ```ts
 * const vx = verivyxExpress({ domain: "example.com", token: "..." });
 * app.get("/articles/:slug", vx.protect(myHandler));
 * ```
 */
export function verivyxExpress(opts?: ExpressAdapterOptions): {
  protect(
    handler: RequestHandler,
    o?: { seoPreview?: (c: { slug: string }) => { title: string; excerpt: string } },
  ): RequestHandler;
  middleware(): RequestHandler;
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

  return {
    protect(
      handler: RequestHandler,
      o?: { seoPreview?: (c: { slug: string }) => { title: string; excerpt: string } },
    ): RequestHandler {
      // Return an async Express handler (req, res, next).
      return async function verivyxGuard(
        req: ExpressRequest,
        res: ExpressResponse,
        next: NextFunction,
      ): Promise<void> {
        try {
          // 1+2. Build a Web Request (resolves IP, builds absolute URL, reads body).
          const webReq = await buildWebRequest(req, opts);

          // 3. Ask the core to evaluate the request (decision overload).
          const slug =
            (req.params as Record<string, string | undefined>).slug ??
            lastPathSegment(req.path);
          const decision = await vx.protect(webReq, { slug });

          // 4a. Denied — check if this is a crawler/human-unverified that we can
          //     serve an SEO preview to instead of a bare 402.
          if (!decision.allowed) {
            const isPreviewCandidate =
              decision.reason === "crawler" || decision.reason === "human-unverified";
            if (isPreviewCandidate && o?.seoPreview !== undefined) {
              attachAdvertiseHeaders(res, opts?.advertise);
              await sendWebResponse(res, buildSeoPreviewResponse(slug, webReq.url, o.seoPreview));
              return;
            }
            attachAdvertiseHeaders(res, opts?.advertise);
            await sendWebResponse(res, decision.response());
            return;
          }

          // 4b. Allowed — if a payment receipt was returned, attach it first.
          if (decision.paymentResponse !== undefined) {
            res.setHeader("PAYMENT-RESPONSE", decision.paymentResponse);
          }
          attachAdvertiseHeaders(res, opts?.advertise);

          // Delegate to the original Express handler.
          handler(req, res, next);
        } catch (err) {
          // Propagate to Express error-handling middleware.
          next(err);
        }
      };
    },

    middleware(): RequestHandler {
      return async (req, res, next) => {
        try {
          const rawPath = req.originalUrl ?? req.url ?? "/";
          const pathname = rawPath.split("?")[0]!;

          // If match patterns are configured and this path doesn't match, pass through.
          if (
            opts?.match !== undefined &&
            opts.match.length > 0 &&
            !pathMatchesAny(pathname, opts.match)
          ) {
            return next();
          }

          const webReq = await buildWebRequest(req, opts);
          const slug = pathname.split("/").filter(Boolean).pop() ?? "";
          const decision = await vx.protect(webReq, { slug });

          if (decision.allowed) {
            if (decision.paymentResponse !== undefined) {
              res.setHeader("PAYMENT-RESPONSE", decision.paymentResponse);
            }
            return next();
          }

          attachAdvertiseHeaders(res, opts?.advertise);
          await sendWebResponse(res, decision.response());
        } catch (err) {
          next(err as Error);
        }
      };
    },
  };
}

/**
 * Convenience export: create a Verivyx Express app-level middleware in one call.
 *
 * ```ts
 * import { verivyxMiddleware } from "@verivyx/paywall-express";
 * app.use(verivyxMiddleware({ domain: "example.com", token: process.env.VX_TOKEN }));
 * ```
 */
export function verivyxMiddleware(opts?: ExpressAdapterOptions): RequestHandler {
  return verivyxExpress(opts).middleware();
}
