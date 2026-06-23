/**
 * VerivyxClient — authorize-only hydration + x402 requirements.
 *
 * Calls the Verivyx backend on behalf of the protect() orchestrator to:
 *   1. `authorize()` — POST /api/v1/content/hydrate with X-Verivyx-Mode:
 *      authorize; returns an authorization decision without the content body.
 *   2. `requirements()` — GET /api/v1/payment/requirements; returns the x402
 *      payment requirement envelope for the publisher to forward to the caller.
 *
 * The protected content body never leaves the publisher: this client only sends
 * domain + slug + proof and receives a decision back.
 *
 * fetch is injected via the `deps` constructor argument so tests can supply a
 * mock without network access. Defaults to the global `fetch` available in
 * Node 18+, Deno, edge runtimes, and browser environments.
 */

import type { ResolvedConfig } from "./config.js";
import { BackendUnreachableError } from "./errors.js";
import { buildPaymentRequired } from "./x402.js";
import type { PaymentRequirement } from "./x402.js";
import type { PaymentRequiredBody } from "./x402.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AuthorizeInput {
  /** Slug that identifies the gated resource. */
  slug: string;
  /**
   * x402 v2 payment proof from the caller (canonical `PAYMENT-SIGNATURE`
   * header value). Forwarded as-is to the backend.
   */
  paymentHeader?: string;
  /**
   * Human session JWT extracted from `Authorization: Bearer <token>` on the
   * incoming request. Forwarded as-is to the backend hydration endpoint.
   */
  bearer?: string;
}

export type AuthorizeResult =
  | { authorized: boolean; transaction?: string; paymentResponse?: string }
  | { status: 402; required: object };

export interface RequirementsResult {
  body: object;
  header: string;
}

export interface ClientDeps {
  /** Injected fetch implementation. Defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
}

// ---------------------------------------------------------------------------
// VerivyxClient
// ---------------------------------------------------------------------------

export class VerivyxClient {
  private readonly cfg: ResolvedConfig;
  private readonly _fetch: typeof globalThis.fetch;

  constructor(cfg: ResolvedConfig, deps?: ClientDeps) {
    this.cfg = cfg;
    this._fetch = deps?.fetch ?? globalThis.fetch;
  }

  /**
   * POST /api/v1/content/hydrate (authorize-only mode).
   *
   * Request shape:
   *   - Headers: Content-Type, X-Verivyx-Mode: authorize
   *   - Optional: PAYMENT-SIGNATURE (x402 v2 proof) or Authorization: Bearer (human JWT)
   *   - Body: { domain, slug }
   *
   * Returns:
   *   - 200: { authorized, transaction?, paymentResponse? }
   *   - 402: { status: 402, required: <parsed body> }
   *   - network/timeout/other: throws BackendUnreachableError
   */
  async authorize(input: AuthorizeInput): Promise<AuthorizeResult> {
    const { slug, paymentHeader, bearer } = input;
    const url = `${this.cfg.apiBase}/api/v1/content/hydrate`;

    // Build headers — only include optional headers when values are present
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Verivyx-Mode": "authorize",
    };
    if (paymentHeader !== undefined) {
      headers["PAYMENT-SIGNATURE"] = paymentHeader;
    }
    if (bearer !== undefined) {
      headers["Authorization"] = `Bearer ${bearer}`;
    }

    // AbortController timeout — AbortSignal.timeout() is Node 17.3+ / modern
    // runtimes; use AbortController for broader ES2020 compat.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.cfg.timeoutMs);

    let response: Response;
    try {
      response = await this._fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ domain: this.cfg.domain, slug }),
        signal: ac.signal,
      });
    } catch (err) {
      throw new BackendUnreachableError(
        `Verivyx backend unreachable (POST hydrate): ${String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 200) {
      let body: { authorized?: boolean; transaction?: string };
      try {
        body = (await response.json()) as { authorized?: boolean; transaction?: string };
      } catch {
        throw new BackendUnreachableError(
          `Verivyx backend returned non-JSON body on 200 (POST hydrate: ${url})`,
        );
      }
      const paymentResponse =
        response.headers.get("PAYMENT-RESPONSE") ?? undefined;
      const result: { authorized: boolean; transaction?: string; paymentResponse?: string } = {
        authorized: body.authorized === true,
      };
      if (body.transaction !== undefined) {
        result.transaction = body.transaction;
      }
      if (paymentResponse !== undefined) {
        result.paymentResponse = paymentResponse;
      }
      return result;
    }

    if (response.status === 402) {
      let required: object;
      try {
        required = (await response.json()) as object;
      } catch {
        throw new BackendUnreachableError(
          `Verivyx backend returned non-JSON body on 402 (POST hydrate: ${url})`,
        );
      }
      return { status: 402, required };
    }

    throw new BackendUnreachableError(
      `Verivyx backend returned unexpected status ${response.status} (POST hydrate)`,
    );
  }

  /**
   * GET /api/v1/payment/requirements?domain=<d>&slug=<s>.
   *
   * The gateway returns the x402 `PaymentRequired` envelope on both 200 and
   * 402. This method wraps `accepts[]` through `buildPaymentRequired` to
   * produce a consistent `{ body, header }` result. Amounts and addresses from
   * the backend are passed through verbatim — never recomputed.
   *
   * Returns: { body: PaymentRequiredBody, header: base64 }
   * Throws: BackendUnreachableError on network failure.
   */
  async requirements(slug: string): Promise<RequirementsResult> {
    const url =
      `${this.cfg.apiBase}/api/v1/payment/requirements` +
      `?domain=${encodeURIComponent(this.cfg.domain)}&slug=${encodeURIComponent(slug)}`;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.cfg.timeoutMs);

    let response: Response;
    try {
      response = await this._fetch(url, { method: "GET", signal: ac.signal });
    } catch (err) {
      throw new BackendUnreachableError(
        `Verivyx backend unreachable (GET requirements): ${String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    // Accept both 200 and 402 — gateway may return either with the envelope
    if (response.status === 200 || response.status === 402) {
      let json: {
        x402Version?: number;
        accepts?: PaymentRequirement[];
        error?: string;
        resource?: { url: string; mimeType?: string };
      };
      try {
        json = (await response.json()) as typeof json;
      } catch {
        throw new BackendUnreachableError(
          `Verivyx backend returned non-JSON body on ${response.status} (GET requirements: ${url})`,
        );
      }

      const accepts: PaymentRequirement[] = Array.isArray(json.accepts)
        ? (json.accepts as PaymentRequirement[])
        : [];

      // If the backend returned a full envelope already, re-wrap via
      // buildPaymentRequired (pass accepts verbatim, produce header).
      const resource = {
        url: json.resource?.url ?? url,
        mimeType: json.resource?.mimeType ?? "application/json",
      };
      const error = json.error ?? "Payment required";

      const { body, header } = buildPaymentRequired(accepts, resource, error);
      return { body: body as PaymentRequiredBody, header };
    }

    throw new BackendUnreachableError(
      `Verivyx backend returned unexpected status ${response.status} (GET requirements)`,
    );
  }
}
