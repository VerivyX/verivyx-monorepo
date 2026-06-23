/**
 * Gate decision model for @verivyx/paywall.
 *
 * `GateDecision` is the central value object produced by the SDK.  It carries
 * everything a host framework needs to respond to an HTTP request:
 *   - `allowed`  — whether the request may proceed to the handler
 *   - `reason`   — why that decision was made
 *   - metadata   — payment requirements, PoW challenge, or settled tx hash
 *   - `response()` — a ready-to-return `Response` (framework-agnostic)
 *
 * `makeDecision` constructs a decision from a classification result.
 * `applyFailMode` constructs a decision when the backend is unreachable,
 *   honouring cfg.failMode ("closed" | "open" | "teaser").
 */

import type { ResolvedConfig } from "./config.js";
import type { PaymentRequirement, PowChallenge } from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * All possible reasons for a gate decision.
 *
 *  paid             — caller presented a valid settled payment proof
 *  verified         — caller is a trusted / white-listed agent
 *  bot-unpaid       — detected as an AI agent without payment
 *  crawler          — detected as a search-engine crawler (SEO preview path)
 *  human-unverified — likely human but no PoW/session yet
 *  error            — backend unreachable; behaviour depends on failMode
 */
export type GateReason =
  | "paid"
  | "verified"
  | "bot-unpaid"
  | "crawler"
  | "human-unverified"
  | "error";

/**
 * Optional preview builder injected by the host (Task 10).
 * The SDK calls `buildPreview()` for crawler/human-unverified/teaser paths;
 * if absent the SDK falls back to a 402 response.
 */
export interface PreviewBuilders {
  /** Synchronous or async builder — returns HTML string. */
  buildPreview?: () => string | Promise<string>;
}

/** The central value type produced by every gate evaluation. */
export interface GateDecision {
  /** Whether the request may proceed to the application handler. */
  allowed: boolean;
  /** Canonical reason for this decision. */
  reason: GateReason;
  /** Payment requirements for bot-unpaid callers (expanded in Task 11). */
  paymentRequirements?: PaymentRequirement[];
  /** PoW challenge for human-unverified callers (expanded in later task). */
  challenge?: PowChallenge;
  /** On-chain transaction hash for paid callers. */
  transaction?: string;
  /**
   * Build a framework-agnostic `Response` suitable for returning directly
   * from a Fetch-API handler (Next.js Edge, Hono, Express, Cloudflare Workers).
   */
  response(): Response;
}

// ---------------------------------------------------------------------------
// Internal input shape for makeDecision
// ---------------------------------------------------------------------------

interface DecisionInput {
  reason: GateReason;
  paymentRequirements?: PaymentRequirement[];
  challenge?: PowChallenge;
  transaction?: string;
  /** Pre-built preview HTML — supplied by callers that already ran Task 10. */
  previewHtml?: string;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Build a 402 Payment Required response per x402 v2 wire format.
 *
 * Body:  { x402Version: 2, accepts: PaymentRequirement[] }
 * Header: PAYMENT-REQUIRED — base64 of the same JSON.
 *
 * NOTE: Task 11 introduces the canonical `buildPaymentRequired` wire builder.
 * Task 13 may refactor `response()` to delegate to it.  This helper is kept
 * small and self-contained so that refactor is a one-liner swap.
 */
function build402(requirements: PaymentRequirement[]): Response {
  const body = JSON.stringify({ x402Version: 2, accepts: requirements });
  const encoded = btoa(body);
  return new Response(body, {
    status: 402,
    headers: {
      "Content-Type": "application/json",
      "PAYMENT-REQUIRED": encoded,
    },
  });
}

/** Build a minimal 503 Service Unavailable response. */
function build503(): Response {
  return new Response(
    JSON.stringify({ error: "service_unavailable" }),
    {
      status: 503,
      headers: { "Content-Type": "application/json" },
    },
  );
}

/** Build a 200 OK with preview HTML. */
function build200Preview(html: string): Response {
  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/** Build a passthrough 200 (open/paid/verified — handler runs). */
function build200Empty(): Response {
  return new Response(null, { status: 200 });
}

/**
 * Build the `response()` function for a given decision.
 *
 * The response is computed lazily on first call and then memoised.  This
 * avoids running async preview builders multiple times while still keeping
 * the `response()` signature synchronous for the common (non-preview) cases.
 *
 * For teaser/preview paths the builder is called eagerly at decision-creation
 * time (in `applyFailMode`) and the resulting HTML is stored in `previewHtml`,
 * so `response()` remains synchronous.
 */
function buildResponseFn(
  input: DecisionInput,
  cfg: ResolvedConfig,
): () => Response {
  return () => {
    switch (input.reason) {
      case "paid":
      case "verified":
        return build200Empty();

      case "bot-unpaid":
        return build402(input.paymentRequirements ?? []);

      case "crawler":
      case "human-unverified":
        // If a pre-built preview is available (injected by Task 10 / host),
        // serve it.  Otherwise fall back to a 402 so content is never leaked.
        if (input.previewHtml !== undefined) {
          return build200Preview(input.previewHtml);
        }
        return build402(input.paymentRequirements ?? []);

      case "error":
        return buildErrorResponse(cfg, input.previewHtml);
    }
  };
}

/**
 * Produce the error-path response according to `cfg.failMode`.
 *
 *   closed  → 503 (default-safe; never leak content)
 *   open    → 200 (caller's handler runs; use only on non-sensitive content)
 *   teaser  → 200 preview if `previewHtml` supplied, else 402
 */
function buildErrorResponse(
  cfg: ResolvedConfig,
  previewHtml?: string,
): Response {
  switch (cfg.failMode) {
    case "closed":
      return build503();
    case "open":
      return build200Empty();
    case "teaser":
      if (previewHtml !== undefined) {
        return build200Preview(previewHtml);
      }
      // No preview builder available — never leak; serve 402 instead.
      return build402([]);
  }
}

// ---------------------------------------------------------------------------
// Public factory functions
// ---------------------------------------------------------------------------

/**
 * Construct a `GateDecision` from a caller-classification result.
 *
 * @param input - Classification output (reason + optional metadata).
 * @param cfg   - Resolved SDK configuration (needed for failMode on error).
 */
export function makeDecision(
  input: DecisionInput,
  cfg: ResolvedConfig,
): GateDecision {
  const allowed =
    input.reason === "paid" || input.reason === "verified";

  const decision: GateDecision = {
    allowed,
    reason: input.reason,
    response: buildResponseFn(input, cfg),
  };

  // Only attach optional fields when they carry a value — respects
  // exactOptionalPropertyTypes strictness.
  if (input.paymentRequirements !== undefined) {
    decision.paymentRequirements = input.paymentRequirements;
  }
  if (input.challenge !== undefined) {
    decision.challenge = input.challenge;
  }
  if (input.transaction !== undefined) {
    decision.transaction = input.transaction;
  }

  return decision;
}

/**
 * Construct a `GateDecision` for the backend-unreachable path.
 *
 * Behaviour is governed by `cfg.failMode`:
 *   "closed"  → 503, not allowed
 *   "open"    → 200, allowed (host handler runs)
 *   "teaser"  → 200 preview (if builder provided), else 402; not allowed
 *
 * For "teaser" the preview is built synchronously by calling `builders.buildPreview()`
 * if provided.  Because preview building may be async in Task 10, callers that
 * need async teaser previews should `await` the builder before calling
 * `applyFailMode`, then pass `previewHtml` directly — or Task 13 (`protect()`)
 * will handle this orchestration.
 *
 * @param cfg      - Resolved SDK configuration.
 * @param builders - Optional preview builders (Task 10 integration point).
 */
export function applyFailMode(
  cfg: ResolvedConfig,
  builders: PreviewBuilders,
): GateDecision {
  const allowed = cfg.failMode === "open";

  if (cfg.failMode !== "teaser" || !builders.buildPreview) {
    return {
      allowed,
      reason: "error",
      response: () => buildErrorResponse(cfg, undefined),
    };
  }

  // Teaser mode with a builder: call it eagerly to capture result (sync or
  // async).  Storing the raw result (string or Promise<string>) lets response()
  // build correctly in both cases.
  //
  // Sync builder  → previewResult is a string, response() is fully synchronous.
  // Async builder → previewResult is a Promise<string>; response() returns a
  //   Response whose body is a ReadableStream that resolves the promise and
  //   streams the HTML — callers can still `await res.text()` normally.
  const previewResult = builders.buildPreview();

  return {
    allowed: false,
    reason: "error",
    response: () => buildTeaserResponse(previewResult),
  };
}

/**
 * Build a 200 preview Response that handles both sync and async preview HTML.
 *
 * - string        → synchronous body, no streaming overhead.
 * - Promise<string> → body is a ReadableStream that resolves and enqueues the
 *   HTML before closing.  Callers use `await res.text()` as normal.
 */
function buildTeaserResponse(previewResult: string | Promise<string>): Response {
  if (typeof previewResult === "string") {
    return build200Preview(previewResult);
  }

  // Async path: wrap the promise in a ReadableStream so Response can be
  // constructed synchronously while the body resolves on the microtask queue.
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      void previewResult.then(
        (html) => {
          controller.enqueue(encoder.encode(html));
          controller.close();
        },
        (_err) => {
          // If the builder rejects, close without content — never leak.
          controller.close();
        },
      );
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
