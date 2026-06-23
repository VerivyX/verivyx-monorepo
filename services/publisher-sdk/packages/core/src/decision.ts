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
import { buildPaymentRequired } from "./x402.js";

/**
 * A pre-built x402 v2 402 payload — the canonical `{ body, header }` produced
 * by `buildPaymentRequired`. The orchestrator (index.ts) builds this once (so
 * `resource` / `error` reflect the actual request) and hands it to the decision
 * verbatim; `response()` emits it without re-encoding.
 */
export interface Prebuilt402 {
  body: object;
  header: string;
}

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
   * Settlement receipt (base64 `PAYMENT-RESPONSE`) for paid callers — attached
   * to the handler's response by the wrapped-handler path after settlement.
   */
  paymentResponse?: string;
  /** Classifier signal tags that produced this decision (diagnostics). */
  signals?: string[];
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
  /**
   * Pre-built canonical x402 v2 402 payload. When present it is emitted
   * verbatim for the bot-unpaid / fallback-402 paths instead of re-encoding.
   * Built by the orchestrator via `buildPaymentRequired` so `resource`/`error`
   * reflect the real request.
   */
  prebuilt402?: Prebuilt402;
  /** Classifier signal tags — forwarded onto the decision for onDecision. */
  signals?: string[];
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/** Fallback resource used when the caller did not supply a prebuilt 402. */
const FALLBACK_RESOURCE: { url: string; mimeType: string } = {
  url: "",
  mimeType: "text/html",
};

/**
 * Build a 402 Payment Required `Response` from a prebuilt canonical payload, or
 * (fallback) by encoding `requirements` through `buildPaymentRequired`.
 *
 * The canonical x402 v2 body is `{ x402Version: 2, error, resource, accepts }`
 * and the `PAYMENT-REQUIRED` header is the base64 of that exact JSON. This is
 * now the SINGLE 402 encoder in the SDK — both the orchestrator's bot-unpaid
 * path (which supplies a `prebuilt402`) and internal fallbacks route through it.
 */
function build402(
  prebuilt: Prebuilt402 | undefined,
  requirements: PaymentRequirement[],
): Response {
  const { body, header } =
    prebuilt ??
    buildPaymentRequired(requirements, FALLBACK_RESOURCE, "payment_required");
  return new Response(JSON.stringify(body), {
    status: 402,
    headers: {
      "Content-Type": "application/json",
      "PAYMENT-REQUIRED": header,
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
 * Each call to `response()` constructs a fresh `Response` object from the
 * pre-resolved decision fields.  For teaser/preview paths the builder is
 * awaited once at decision-creation time (in `applyFailMode`) and the
 * resulting HTML is captured in `previewHtml`, so `response()` remains
 * fully synchronous.
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
        return build402(input.prebuilt402, input.paymentRequirements ?? []);

      case "crawler":
      case "human-unverified":
        // If a pre-built preview is available (injected by Task 10 / host),
        // serve it.  Otherwise fall back to a 402 so content is never leaked.
        if (input.previewHtml !== undefined) {
          return build200Preview(input.previewHtml);
        }
        return build402(input.prebuilt402, input.paymentRequirements ?? []);

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
      return build402(undefined, []);
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
  if (input.signals !== undefined) {
    decision.signals = input.signals;
  }

  return decision;
}

/**
 * Construct a `GateDecision` for the backend-unreachable path.
 *
 * Behaviour is governed by `cfg.failMode`:
 *   "closed"  → 503, not allowed
 *   "open"    → 200, allowed (host handler runs)
 *   "teaser"  → 200 preview (if builder provided and resolves), else 402; not allowed
 *
 * For "teaser" the preview builder is awaited up front so the resulting
 * `GateDecision.response()` can return a fully-buffered `Response` with no
 * `ReadableStream` involved.  If the builder rejects, the function falls back
 * to a 402 — never a silent 200 with an empty body.
 *
 * @param cfg      - Resolved SDK configuration.
 * @param builders - Optional preview builders (Task 10 integration point).
 */
export async function applyFailMode(
  cfg: ResolvedConfig,
  builders: PreviewBuilders,
): Promise<GateDecision> {
  const allowed = cfg.failMode === "open";

  // Backend unreachable — surface via the configured logger. Never log secrets
  // (no token, no raw headers): only the failMode being applied.
  cfg.logger.warn(
    `verivyx: backend unreachable, applying failMode="${cfg.failMode}"`,
  );

  if (cfg.failMode !== "teaser" || !builders.buildPreview) {
    return {
      allowed,
      reason: "error",
      response: () => buildErrorResponse(cfg, undefined),
    };
  }

  // Teaser mode with a builder: await it once so response() stays synchronous
  // and always returns a fully-buffered Response (no ReadableStream).
  // If the builder rejects, fall back to 402 — never leak content silently.
  let previewHtml: string | undefined;
  try {
    previewHtml = await builders.buildPreview();
  } catch {
    // Builder rejected — treat as "no preview available".
    previewHtml = undefined;
  }

  return {
    allowed: false,
    reason: "error",
    response: () => buildErrorResponse(cfg, previewHtml),
  };
}

