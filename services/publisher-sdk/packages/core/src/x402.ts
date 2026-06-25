/**
 * x402 v2 wire-format helpers for @verivyx/paywall.
 *
 * `buildPaymentRequired` — wraps an already-computed `PaymentRequirement[]`
 * (provided by the backend/gateway; never recomputed here) into the x402 v2
 * response envelope and produces a base64 header string.
 *
 * `readPaymentHeader` — extracts a payment proof from an incoming `Request`,
 * supporting both the x402 v2 `PAYMENT-SIGNATURE` header and the legacy v1
 * `X-PAYMENT` header.
 *
 * Design note: The requirement emitter + platform-fee split live in the Go
 * x402-gateway (`buildRequirements` / `resolveRequirement`).  This module is
 * the *publisher-side payer SDK* — it only wraps and reads; it NEVER computes
 * amounts, payTo addresses, or creator/platform splits.
 *
 * Type shape ported from `services/agent-sdk/src/types.ts` lines 16-32 to
 * keep wire compatibility with the gateway and generic x402 clients.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single x402 v2 payment requirement.
 *
 * Field names mirror `services/agent-sdk/src/types.ts` `PaymentRequirement`
 * exactly so the SDK is wire-compatible with the gateway and agent-sdk payer.
 */
export interface PaymentRequirement {
  /** Must be "exact" for current x402 v2 Stellar requirements. */
  scheme: "exact";
  /** Network identifier, e.g. "stellar:testnet" or "stellar:pubnet". */
  network: string;
  /** Asset identifier, e.g. "USDC:<issuer>". */
  asset: string;
  /** Amount as a decimal string — set by the gateway, never recomputed here. */
  amount: string;
  /** Recipient address — set by the gateway, never recomputed here. */
  payTo: string;
  /** Maximum seconds the payer may wait before the payment expires. */
  maxTimeoutSeconds: number;
  /** Optional protocol extensions. */
  extra?: Record<string, unknown>;
}

/**
 * Resource descriptor included in the x402 v2 body.
 * Mirrors the `ResourceInfo` shape in agent-sdk/src/types.ts.
 */
export interface ResourceInfo {
  url: string;
  mimeType?: string;
}

/**
 * x402 v2 `Payment Required` response body.
 * Mirrors the `PaymentRequired` shape in agent-sdk/src/types.ts.
 */
export interface PaymentRequiredBody {
  x402Version: 2;
  error: string;
  resource: ResourceInfo;
  accepts: PaymentRequirement[];
  extensions?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// UTF-8-safe base64 helper
// ---------------------------------------------------------------------------

/**
 * Encode an arbitrary Unicode string to base64 safely.
 *
 * `btoa` only accepts Latin-1 (code points 0–255).  Any string containing
 * characters outside that range — e.g. Japanese, Arabic, emoji — throws
 * `InvalidCharacterError`.  This helper first UTF-8-encodes the string via
 * `TextEncoder`, then feeds the raw bytes to `btoa` as a binary string.
 *
 * The loop (`for...of`) is used instead of `String.fromCharCode(...bytes)`
 * spread to avoid call-stack overflow on large inputs.
 *
 * Both `TextEncoder` and `btoa` are available in the WebWorker lib
 * already declared in tsconfig.json.
 */
export function toBase64Utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// ---------------------------------------------------------------------------
// buildPaymentRequired
// ---------------------------------------------------------------------------

/**
 * Wrap a pre-built `PaymentRequirement[]` in the x402 v2 response envelope.
 *
 * The returned `body` object is the full JSON body for a 402 response.
 * The returned `header` is `toBase64Utf8(JSON.stringify(body))` and is emitted
 * verbatim as the `PAYMENT-REQUIRED` header by `decision.ts`'s `build402`
 * (this is the single 402 encoder in the SDK).
 *
 * @param reqs     - Requirements sourced from the backend/gateway; passed
 *                   through verbatim — amounts and addresses are NEVER
 *                   recomputed or modified.
 * @param resource - URL and MIME type of the protected resource.
 * @param error    - Human-readable error string included in the 402 body.
 */
export function buildPaymentRequired(
  reqs: PaymentRequirement[],
  resource: { url: string; mimeType: string },
  error: string,
): { body: PaymentRequiredBody; header: string } {
  const body: PaymentRequiredBody = {
    x402Version: 2,
    error,
    resource: {
      url: resource.url,
      mimeType: resource.mimeType,
    },
    accepts: reqs,
  };

  const header = toBase64Utf8(JSON.stringify(body));

  return { body, header };
}

// ---------------------------------------------------------------------------
// readPaymentHeader
// ---------------------------------------------------------------------------

/**
 * Extract a payment proof from an incoming `Request`.
 *
 * Returns:
 *   - `{ raw, version: 2 }` if the x402 v2 `PAYMENT-SIGNATURE` header is
 *     present (checked first — newer protocol takes precedence).
 *   - `{ raw, version: 1 }` if the legacy `X-PAYMENT` header is present.
 *   - `null` if neither header is present.
 *
 * Header lookups are case-insensitive (the Fetch API `Headers` object
 * normalises to lowercase internally).
 */
export function readPaymentHeader(
  req: Request,
): { raw: string; version: 1 | 2 } | null {
  // x402 v2 — check first so it takes precedence over v1
  const v2 = req.headers.get("payment-signature");
  if (v2 !== null) {
    return { raw: v2, version: 2 };
  }

  // x402 v1 legacy header
  const v1 = req.headers.get("x-payment");
  if (v1 !== null) {
    return { raw: v1, version: 1 };
  }

  return null;
}
