// Public API surface for @verivyx/paywall

// Shared types
export type { Logger, Price, PaymentRequirement, PowChallenge } from "./types.js";

// x402 v2 wire helpers
export { buildPaymentRequired, readPaymentHeader } from "./x402.js";
export type { PaymentRequiredBody, ResourceInfo } from "./x402.js";

// Config
export { resolveConfig, ConfigError } from "./config.js";
export type { VerivyxOptions, ResolvedConfig } from "./config.js";

// Decision model (GateDecision and GateReason exported from here)
export { makeDecision, applyFailMode } from "./decision.js";
export type { GateDecision, GateReason, PreviewBuilders, Prebuilt402 } from "./decision.js";

// Error taxonomy
export { PaywallError, SettlementFailedError, HydrationFailedError, BackendUnreachableError } from "./errors.js";

// Visitor classifier
export { classify } from "./detect.js";
export type { Classification, ClassifyDeps, ClassifyResult } from "./detect.js";

// Web Bot Auth verifier (RFC 9421 Ed25519)
export { verifyWebBotAuth } from "./webbotauth.js";
export type { VerifyWebBotAuthDeps } from "./webbotauth.js";

// Search-crawler IP-range verifier (Google/Bing published lists)
export { createSearchCrawlerVerifier, ipInCidr } from "./crawlerverify.js";
export type { CrawlerVerifierDeps } from "./crawlerverify.js";

// SEO preview + anti-cloaking JSON-LD builders
export { buildPaywallJsonLd, buildPreviewHtml } from "./preview.js";

// Verivyx backend client (authorize / requirements)
export { VerivyxClient } from "./client.js";
export type { AuthorizeInput, AuthorizeResult, RequirementsResult, ClientDeps } from "./client.js";

// Post-response settlement helper
export { attachPaymentResponse } from "./settle.js";

// ===========================================================================
// verivyx() / protect() orchestration — Task 13 capstone
// ===========================================================================

import { resolveConfig } from "./config.js";
import type { VerivyxOptions, ResolvedConfig } from "./config.js";
import { classify } from "./detect.js";
import type { Classification, ClassifyDeps } from "./detect.js";
import { makeDecision, applyFailMode } from "./decision.js";
import type { GateDecision } from "./decision.js";
import { verifyWebBotAuth } from "./webbotauth.js";
import { VerivyxClient } from "./client.js";
import type { AuthorizeResult } from "./client.js";
import { BackendUnreachableError } from "./errors.js";
import { buildPaywallJsonLd, buildPreviewHtml } from "./preview.js";
import { attachPaymentResponse } from "./settle.js";
import { buildPaymentRequired } from "./x402.js";
import type { PaymentRequirement } from "./x402.js";

// ---------------------------------------------------------------------------
// Public surface types
// ---------------------------------------------------------------------------

/** A handler wrapped by `protect(handler)` — same Fetch-API call shape. */
export type WrappedHandler = (
  req: Request,
  ctx?: unknown,
) => Promise<Response>;

/** The application handler `protect()` wraps. */
export type AppHandler = (
  req: Request,
  ctx?: unknown,
) => Promise<Response> | Response;

/** Per-route options for the wrapping overload of `protect`. */
export interface ProtectOptions {
  /**
   * SEO preview builder. When provided, crawler / human visitors receive a
   * 200 preview (teaser HTML + anti-cloaking JSON-LD) instead of a 402.
   */
  seoPreview?: (ctx: unknown) => { title: string; excerpt: string };
}

/**
 * Dependencies injected into the core orchestrator. Environment-specific
 * verifiers (reverse-DNS crawler verification) live in the adapter layer
 * (Milestone 3) and are injected here. `verifyCrawlerDns` defaults to
 * undefined → unverified search-crawler UAs classify as `ai-bot` (spoof
 * defense), which is the correct secure default.
 */
export interface VerivyxDeps {
  /** Injected fetch (forwarded to the backend client). */
  fetch?: typeof globalThis.fetch;
  /** Override the Web Bot Auth verifier (defaults to the bundled impl). */
  verifyWebBotAuth?: (req: Request) => Promise<boolean>;
  /** Reverse-DNS crawler verifier — undefined by default (adapter injects). */
  verifyCrawlerDns?: (ip: string, ua: string) => Promise<boolean>;
}

/** The public SDK instance returned by `verivyx()`. */
export interface Verivyx {
  /** Overload A (primary): wrap a handler into a gated handler. */
  protect(handler: AppHandler, opts?: ProtectOptions): WrappedHandler;
  /** Overload B (advanced): evaluate a request into a GateDecision. */
  protect(req: Request, ctx?: { slug?: string }): Promise<GateDecision>;
}

// ---------------------------------------------------------------------------
// slug derivation
// ---------------------------------------------------------------------------

/**
 * Derive a resource slug from a request.
 *
 * Precedence:
 *   1. `ctx.slug` when supplied by the caller (authoritative).
 *   2. Otherwise, the last non-empty, URL-decoded segment of the URL path.
 *      e.g. `https://host/blog/secret-post/` → `secret-post`.
 *   3. If the path has no segments (root `/`), the empty string is used.
 */
export function deriveSlug(req: Request, ctxSlug?: string): string {
  if (ctxSlug !== undefined && ctxSlug !== "") {
    return ctxSlug;
  }
  let pathname: string;
  try {
    pathname = new URL(req.url).pathname;
  } catch {
    return "";
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

// ---------------------------------------------------------------------------
// glob match (cfg.match) — minimal, dependency-free
// ---------------------------------------------------------------------------

/**
 * Compile a single glob pattern to a RegExp.
 *
 * Supported tokens:
 *   - `**` — matches across path separators (any number of chars incl. `/`).
 *   - `*`  — matches within a single path segment (any chars except `/`).
 *   - all other regex metacharacters are escaped literally.
 *
 * Matching is anchored (full-string) so `/blog/**` does not match `/x/blog/y`.
 */
function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*"; // ** → cross-segment
        i++;
      } else {
        out += "[^/]*"; // * → within-segment
      }
    } else {
      out += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * Decide whether a request path is gated.
 *
 * When `match` is empty, every route is gated (no opt-in list configured).
 * Otherwise the request's pathname must match at least one glob pattern.
 */
export function isMatched(req: Request, patterns: string[]): boolean {
  if (patterns.length === 0) {
    return true;
  }
  let pathname: string;
  try {
    pathname = new URL(req.url).pathname;
  } catch {
    return true;
  }
  return patterns.some((p) => globToRegExp(p).test(pathname));
}

// ---------------------------------------------------------------------------
// Engine — shared by verivyx() and verivyx.mock()
// ---------------------------------------------------------------------------

/** Minimal client surface the engine needs (real client or a mock). */
export interface EngineClient {
  authorize(input: {
    slug: string;
    paymentHeader?: string;
    bearer?: string;
  }): Promise<AuthorizeResult>;
  requirements(slug: string): Promise<{ body: object; header: string }>;
}

interface EngineInput {
  cfg: ResolvedConfig;
  client: EngineClient;
  classifyDeps: ClassifyDeps;
  /** Override classify (used by the mock to force a classification). */
  classifyFn?: (req: Request) => Promise<Classification>;
}

/** Pull the `accepts[]` requirements out of any x402 envelope body. */
function extractAccepts(body: object): PaymentRequirement[] {
  const accepts = (body as { accepts?: unknown }).accepts;
  return Array.isArray(accepts) ? (accepts as PaymentRequirement[]) : [];
}

/**
 * Best-effort MIME type for the protected resource's 402 envelope.
 *
 * The SDK does not see the eventual handler's `Content-Type`, so it picks a
 * pragmatic default of `text/html` (these gates front article/HTML pages),
 * unless the caller's `Accept` header clearly prefers JSON, in which case
 * `application/json` is reported. This only populates the descriptive
 * `resource.mimeType` field — it never changes the gate outcome.
 */
function resolveResourceMime(req: Request): string {
  const accept = (req.headers.get("accept") ?? "").toLowerCase();
  if (accept.includes("application/json") && !accept.includes("text/html")) {
    return "application/json";
  }
  return "text/html";
}

/**
 * Build the canonical x402 v2 402 payload (`{ body, header }`) for a request,
 * via `buildPaymentRequired` — the single 402 encoder. `error` defaults to
 * `"payment_required"` and `resource` is `{ url: req.url, mimeType }`.
 */
function buildCanonical402(
  req: Request,
  requirements: PaymentRequirement[],
): { body: object; header: string } {
  return buildPaymentRequired(
    requirements,
    { url: req.url, mimeType: resolveResourceMime(req) },
    "payment_required",
  );
}

/** Build the preview-builders object for the decision/error paths. */
function buildPreviewBuilders(
  req: Request,
  slug: string,
  opts?: ProtectOptions,
): { buildPreview?: () => string } {
  if (!opts?.seoPreview) {
    return {};
  }
  return {
    buildPreview: () => {
      const { title, excerpt } = opts.seoPreview!({ slug });
      const url = req.url;
      const jsonLd = buildPaywallJsonLd({ title, description: excerpt, url });
      return buildPreviewHtml({ title, excerpt, url, jsonLd });
    },
  };
}

/**
 * Evaluate a request into a `GateDecision`. This is the shared core both the
 * wrapped-handler path and the advanced decision overload run through. It
 * performs classification and (for paid / verified) the authorize round-trip,
 * but it does NOT run the application handler — the caller decides that based
 * on `decision.allowed`.
 *
 * `previewBuilders` is forwarded into crawler / human / error paths so the
 * decision's `response()` can serve a preview when the caller supplied one.
 */
async function evaluate(
  engine: EngineInput,
  req: Request,
  slug: string,
  previewBuilders: { buildPreview?: () => string | Promise<string> },
): Promise<GateDecision> {
  const { cfg, client } = engine;

  // Classify the caller.
  const { classification, signals }: { classification: Classification; signals?: string[] } =
    engine.classifyFn
      ? { classification: await engine.classifyFn(req) }
      : await classify(req, cfg, engine.classifyDeps);

  try {
    switch (classification) {
      case "paid": {
        const paymentHeader =
          req.headers.get("payment-signature") ??
          req.headers.get("x-payment") ??
          undefined;
        const result = await client.authorize({
          slug,
          ...(paymentHeader !== undefined ? { paymentHeader } : {}),
        });
        if ("status" in result && result.status === 402) {
          // Authorize returned a backend 402 — re-encode its requirements into
          // the canonical envelope so the caller always sees one 402 shape.
          return bot402(engine, req, slug, signals, extractAccepts(result.required));
        }
        if ("authorized" in result && result.authorized) {
          const d = makeDecision({ reason: "paid", ...(signals ? { signals } : {}) }, cfg);
          if (result.transaction !== undefined) {
            d.transaction = result.transaction;
          }
          // Stash the settlement receipt so the wrapped handler can attach it.
          if (result.paymentResponse !== undefined) {
            d.paymentResponse = result.paymentResponse;
          }
          return d;
        }
        // authorized=false → not paid → 402 with requirements (fetch them).
        return await bot402(engine, req, slug, signals);
      }

      case "verified": {
        const authHeader = req.headers.get("authorization") ?? "";
        const bearer = authHeader.toLowerCase().startsWith("bearer ")
          ? authHeader.slice(7).trim()
          : undefined;
        const result = await client.authorize({
          slug,
          ...(bearer !== undefined ? { bearer } : {}),
        });
        if ("authorized" in result && result.authorized) {
          const d = makeDecision({ reason: "verified", ...(signals ? { signals } : {}) }, cfg);
          if (result.transaction !== undefined) {
            d.transaction = result.transaction;
          }
          return d;
        }
        // Session not authorized → treat as unverified human (preview/402).
        return await human(engine, req, slug, classification, signals, previewBuilders);
      }

      case "signed-agent":
      case "ai-bot":
        return await bot402(engine, req, slug, signals);

      case "crawler":
      case "human":
      case "unknown":
      default:
        return await human(engine, req, slug, classification, signals, previewBuilders);
    }
  } catch (err) {
    if (err instanceof BackendUnreachableError) {
      return await applyFailMode(cfg, previewBuilders);
    }
    throw err;
  }
}

/**
 * Build a bot-unpaid 402 decision carrying a prebuilt canonical x402 envelope.
 * Requirements come from `accepts` when supplied (e.g. an authorize-402 body);
 * otherwise they are sourced from the backend `requirements()` endpoint.
 */
async function bot402(
  engine: EngineInput,
  req: Request,
  slug: string,
  signals?: string[],
  accepts?: PaymentRequirement[],
): Promise<GateDecision> {
  const requirements =
    accepts ?? extractAccepts((await engine.client.requirements(slug)).body);
  const prebuilt402 = buildCanonical402(req, requirements);
  return makeDecision(
    {
      reason: "bot-unpaid",
      paymentRequirements: requirements,
      prebuilt402,
      ...(signals ? { signals } : {}),
    },
    engine.cfg,
  );
}

/**
 * Build a crawler/human-unverified decision: preview when available, else 402.
 * The `reason` reflects the actual classification — `crawler` only for verified
 * search crawlers; `human-unverified` for humans / unknown / the unauthorized
 * verified fallthrough.
 */
async function human(
  engine: EngineInput,
  req: Request,
  slug: string,
  classification: Classification,
  signals: string[] | undefined,
  previewBuilders: { buildPreview?: () => string | Promise<string> },
): Promise<GateDecision> {
  const reason = classification === "crawler" ? "crawler" : "human-unverified";
  if (previewBuilders.buildPreview) {
    const previewHtml = await previewBuilders.buildPreview();
    return makeDecision(
      { reason, previewHtml, ...(signals ? { signals } : {}) },
      engine.cfg,
    );
  }
  // No preview → 402 (never leak content). Keep the human/crawler `reason`
  // (so onDecision can distinguish them) but emit the canonical 402 envelope by
  // sourcing requirements from the backend and prebuilding the payload.
  const requirements = extractAccepts((await engine.client.requirements(slug)).body);
  return makeDecision(
    {
      reason,
      paymentRequirements: requirements,
      prebuilt402: buildCanonical402(req, requirements),
      ...(signals ? { signals } : {}),
    },
    engine.cfg,
  );
}

// ---------------------------------------------------------------------------
// makeVerivyx — assemble the public Verivyx instance from an engine
// ---------------------------------------------------------------------------

/** Build a `Verivyx` instance over a configured engine. Used internally. */
export function makeVerivyx(engine: EngineInput): Verivyx {
  function protect(handler: AppHandler, opts?: ProtectOptions): WrappedHandler;
  function protect(req: Request, ctx?: { slug?: string }): Promise<GateDecision>;
  function protect(
    handlerOrReq: AppHandler | Request,
    optsOrCtx?: ProtectOptions | { slug?: string },
  ): WrappedHandler | Promise<GateDecision> {
    // Overload B: a Request was passed → return a GateDecision.
    if (handlerOrReq instanceof Request) {
      const req = handlerOrReq;
      const ctx = optsOrCtx as { slug?: string } | undefined;
      const slug = deriveSlug(req, ctx?.slug);
      return evaluate(engine, req, slug, {});
    }

    // Overload A: a function was passed → return a wrapped handler.
    const handler = handlerOrReq;
    const opts = optsOrCtx as ProtectOptions | undefined;

    return async (req: Request, ctx?: unknown): Promise<Response> => {
      // Passthrough non-matched routes — never gate them.
      if (!isMatched(req, engine.cfg.match)) {
        return await handler(req, ctx);
      }

      const slug = deriveSlug(req);
      const previewBuilders = buildPreviewBuilders(req, slug, opts);
      const decision = await evaluate(engine, req, slug, previewBuilders);

      engine.cfg.logger.debug(
        `verivyx: decision reason="${decision.reason}" allowed=${decision.allowed}`,
      );
      if (engine.cfg.onDecision) {
        engine.cfg.onDecision(decision);
      }

      if (!decision.allowed) {
        return decision.response();
      }

      // Allowed (paid / verified) → run the handler, attach settlement receipt.
      const res = await handler(req, ctx);
      return attachPaymentResponse(res, decision.paymentResponse);
    };
  }

  return { protect };
}

// ---------------------------------------------------------------------------
// verivyx() factory
// ---------------------------------------------------------------------------

/**
 * Create a Verivyx paywall instance.
 *
 * Configuration is resolved from `opts` (highest precedence) then the real
 * environment (`process.env` on Node/Vercel; `{}` on edge runtimes where
 * `process` is undefined). Code-arg options always override env.
 *
 * Classifier dependencies:
 *   - `verifyWebBotAuth` defaults to the bundled RFC 9421 verifier; override
 *     via `deps.verifyWebBotAuth`.
 *   - `verifyCrawlerDns` is undefined by default. Reverse-DNS crawler
 *     verification is environment-specific (node:dns vs Workers) and belongs
 *     in the adapter layer (Milestone 3), injected via `deps.verifyCrawlerDns`.
 *     With it undefined, an unverified search-crawler UA classifies as
 *     `ai-bot` → 402 (spoof-defense; the correct secure default).
 */
function verivyx(opts?: VerivyxOptions, deps?: VerivyxDeps): Verivyx {
  // Read the real environment ourselves (resolveConfig defaults env to {}).
  // `process` may be undefined on edge runtimes (Cloudflare Workers); guard it
  // via globalThis so this typechecks without @types/node.
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process;
  const env: Record<string, string | undefined> = proc?.env ?? {};
  const cfg = resolveConfig(opts, env);

  const client = new VerivyxClient(
    cfg,
    deps?.fetch ? { fetch: deps.fetch } : undefined,
  );

  const classifyDeps: ClassifyDeps = {
    verifyWebBotAuth: deps?.verifyWebBotAuth ?? verifyWebBotAuth,
    ...(deps?.verifyCrawlerDns ? { verifyCrawlerDns: deps.verifyCrawlerDns } : {}),
  };

  return makeVerivyx({ cfg, client, classifyDeps });
}

// Attach the mock() helper as a namespace member.
import { mock } from "./mock.js";

interface VerivyxFn {
  (opts?: VerivyxOptions, deps?: VerivyxDeps): Verivyx;
  mock: typeof mock;
}

(verivyx as VerivyxFn).mock = mock;

export { verivyx };
export type { EngineInput };
